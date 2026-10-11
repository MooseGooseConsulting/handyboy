#!/usr/bin/env bash
# Live testing in the user's real Chrome, in one command.
#
#   scripts/live.sh setup              build, register the host, get the extension connected
#   scripts/live.sh test [task,...]    run fixture tasks in real Chrome and score each one
#   scripts/live.sh run "<prompt>" [--url <url>]   one ad-hoc run with the free pair
#   scripts/live.sh status | logs
#
# `setup` is safe to re-run at any time and needs no click once the extension has been
# loaded unpacked one time ever. It wakes the extension by opening one of its own pages,
# which starts the service worker, which spawns the host. Only a profile that has never
# loaded the extension falls back to chrome://extensions, which Chrome reserves for a human.
#
# `test` reuses the harness's fixture server, prompts and scorers (scripts/harness/), but
# against this Chrome instead of a harness-owned one. Fixture pages are served on
# 127.0.0.1, so no third-party site is touched unless you name the `ebay` task.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
HARNESS="$ROOT/scripts/harness"
# Same rule as host/src/paths.ts dataDir(), so the verdict reads the logs the host wrote.
if [ -n "${NB_HOME:-}" ]; then DATA="$NB_HOME/.local/share/nanobrowser"
else DATA="${XDG_DATA_HOME:-$HOME/.local/share}/nanobrowser"; fi
EXT_DIR="$ROOT/.output/chrome-mv3"
CHROME="${NB_LIVE_CHROME:-$(command -v google-chrome-stable || command -v google-chrome || true)}"
CHROME_DIR="${NB_LIVE_CHROME_DIR:-$HOME/.config/google-chrome}"
LEADER="${NB_LIVE_LEADER:-nvidia/nemotron-3-ultra-550b-a55b:free}"
FOLLOWER="${NB_LIVE_FOLLOWER:-nvidia/nemotron-3.5-lightning:free}"
RUN_TIMEOUT="${NB_LIVE_TIMEOUT:-600}"
CONNECT_WAIT="${NB_LIVE_CONNECT_WAIT:-300}"
# Tasks that need nothing beyond a local page. ebay hits a real site, so it is opt-in.
DEFAULT_TASKS="inventory,userscript_debug,escalation,readonly,login,redaction,stall,download"

step() { printf '\n== %s\n' "$*"; }
die() { echo "live: $*" >&2; exit 1; }

usage() { sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'; }

# Same derivation as host/install.sh: the manifest key pins the id across rebuilds.
ext_id() {
  grep -oE "'MII[A-Za-z0-9+/=]+'" wxt.config.ts | head -n1 | tr -d "'" \
    | base64 -d | sha256sum | head -c 32 | tr '0-9a-f' 'a-p'
}

# "<profile>\t<path>\t<user_scripts_enabled>" for every profile that has the extension.
# Chrome rewrites Preferences lazily, so this can lag a click in chrome://extensions.
registrations() {
  python3 -I - "$CHROME_DIR" "$(ext_id)" <<'PY'
import glob, json, os, sys
root, ext = sys.argv[1], sys.argv[2]
for prefs in sorted(glob.glob(os.path.join(root, '*', 'Preferences'))):
    try:
        s = json.load(open(prefs))['extensions']['settings'][ext]
    except Exception:
        continue
    print(f"{os.path.basename(os.path.dirname(prefs))}\t{s.get('path', '')}\t{s.get('user_scripts_enabled', False)}")
PY
}

# True once the extension's service worker has spawned the dev host and it answers.
# nb-status exits 1 both for "key not ready" and "no host", so read what it printed instead.
# Captured rather than piped: `grep -q` exits early, and under pipefail the SIGPIPE it
# leaves on nb-status would read as "no host".
host_up() { local out; out="$(timeout 30 host/bin/nb-status 2>/dev/null)"; [[ "$out" == *'"op"'* ]]; }

wait_for_extension() {
  local limit="$1" waited=0
  while ! host_up; do
    [ "$waited" -ge "$limit" ] && return 1
    [ "$waited" -gt 0 ] && [ $((waited % 30)) -eq 0 ] && echo "   waiting for the extension to connect... (${waited}s)"
    sleep 2; waited=$((waited + 2))
  done
}

cmd_setup() {
  step "prerequisites"
  for bin in node jq doppler python3 rsync; do
    command -v "$bin" >/dev/null || die "$bin is not on PATH"
  done
  [ -n "$CHROME" ] || die "no google-chrome-stable on PATH (set NB_LIVE_CHROME)"
  pgrep -x chrome >/dev/null || die "Chrome is not running; start it normally, then re-run"
  echo "node $(node --version), chrome $("$CHROME" --version | awk '{print $NF}')"

  step "dependencies"
  # pnpm 10, as CI uses: pnpm 11+ ignores package.json's "pnpm.overrides" and would
  # rewrite the lockfile without the security overrides.
  [ -d node_modules ] || npx -y pnpm@10 install --frozen-lockfile || die "pnpm install failed"
  [ -d host/node_modules ] || (cd host && npx -y pnpm@10 install --frozen-lockfile) || die "host pnpm install failed"
  echo "ok"

  step "build"
  node_modules/.bin/wxt build >/dev/null || die "wxt build failed"
  echo "built $EXT_DIR"

  # Chrome loads from wherever "Load unpacked" pointed, which may be another checkout
  # (a worktree builds into its own .output). Copy this build there so a reload sees it.
  # Every profile that has it gets the build: the CLI cannot tell which profile's worker
  # answers the socket, and a reload of an unsynced profile would test stale code.
  local reg profile path us
  reg="$(registrations)"
  while IFS=$'\t' read -r profile path us; do
    [ -n "$profile" ] || continue
    echo "registered in Chrome profile \"$profile\" from $path"
    if [ "$path" != "$EXT_DIR" ]; then
      mkdir -p "$path" && rsync -a --delete "$EXT_DIR/" "$path/" || die "could not copy the build to $path"
      echo "copied this build there"
    fi
    [ "$us" = "True" ] || echo "   NOTE: \"Allow User Scripts\" is off in \"$profile\"; userscript tasks fail until you turn it on in the extension's Details"
  done <<<"$reg"

  step "native host"
  # The wrapper bakes in an absolute path, so only install when it is missing or is not the
  # dev build: reinstalling from a worktree would point Chrome at a tree that may vanish.
  local manifest="$CHROME_DIR/NativeMessagingHosts/com.nanobrowser.host.json" wrapper
  wrapper="$(jq -r .path "$manifest" 2>/dev/null || true)"
  if [ -x "$wrapper" ] && grep -q NANOBROWSER_DEV=1 "$wrapper"; then
    echo "already registered: $wrapper"
  else
    bash host/install.sh --dev | sed 's/^/   /' || die "host/install.sh failed"
    # install.sh writes only under the default Chrome and Chromium config dirs.
    if [ ! -f "$manifest" ]; then
      mkdir -p "$(dirname "$manifest")" \
        && cp "$HOME/.config/google-chrome/NativeMessagingHosts/com.nanobrowser.host.json" "$manifest" \
        || die "could not register the host under $CHROME_DIR"
      echo "   installed: $manifest"
    fi
  fi

  step "extension"
  if host_up; then
    host/bin/nb-reload --timeout 30 >/dev/null 2>&1 || die "nb-reload failed (host/bin/nb-logs)"
    echo "reloaded in place"
  elif [ -n "$reg" ]; then
    # An idle MV3 worker does not run until something wakes it; one of its own pages does.
    "$CHROME" "chrome-extension://$(ext_id)/sidepanel.html" >/dev/null 2>&1 &
    if wait_for_extension 20; then
      host/bin/nb-reload --timeout 30 >/dev/null 2>&1 || die "woke the extension but nb-reload failed, so it may still run the old build (host/bin/nb-logs)"
      echo "woke the extension through its own page and reloaded it"
    else
      die "the extension is registered but did not start; it may be disabled or in an error state at chrome://extensions"
    fi
  else
    local copied=""
    printf '%s' "$EXT_DIR" | wl-copy 2>/dev/null && copied=" (also on your clipboard)"
    "$CHROME" chrome://extensions >/dev/null 2>&1 &
    cat <<MSG
   This Chrome profile has never loaded nanobrowser, and Chrome only allows that by hand:
     1. In the chrome://extensions tab that just opened, turn Developer mode ON.
     2. Click "Load unpacked" and choose this folder${copied}:
          $EXT_DIR
     3. Open nanobrowser's Details and turn on "Allow User Scripts".
   This is needed once per profile, ever.
MSG
    wait_for_extension "$CONNECT_WAIT" || die "the extension never connected after ${CONNECT_WAIT}s"
    echo "extension connected"
  fi

  step "readiness"
  local status reason
  status="$(host/bin/nb-status 2>&1)"; echo "$status"
  if jq -e '.key.ready' <<<"$status" >/dev/null 2>&1; then
    echo; echo "ready. Next: scripts/live.sh test"
  else
    reason="$(jq -r '.key.reason // empty' <<<"$status" 2>/dev/null)"
    case "$reason" in
      *401*) die "OpenRouter rejected the key (401). Rotate OPENROUTER_API_KEY in Doppler ai-automation/dev, then re-run setup" ;;
      *) die "the extension is connected but the key is not ready: ${reason:-see the status above}" ;;
    esac
  fi
}

FIXTURE_PID=""
ACTIVE_STDERR=""

run_id_in() { grep -o 'runId=[A-Za-z0-9_-]*' "$1" 2>/dev/null | head -n1 | cut -d= -f2; }

cleanup_test() {
  local id
  if [ -n "$ACTIVE_STDERR" ]; then
    id="$(run_id_in "$ACTIVE_STDERR")"
    [ -n "$id" ] && { echo "cancelling in-flight run $id"; host/bin/nb-cancel "$id" >/dev/null 2>&1 || true; }
  fi
  [ -n "$FIXTURE_PID" ] && kill "$FIXTURE_PID" 2>/dev/null
  return 0
}

cmd_test() {
  local tasks="${1:-$DEFAULT_TASKS}"
  # The eBay verdict compares against listings scraped independently of the agent, which
  # needs a second reader of the page. The harness-owned Chrome has one (CDP); this one
  # deliberately does not, so the task could only ever fail here.
  [[ ",$tasks," == *,ebay,* ]] && die "ebay needs independent page ground truth; run it with: just harness --live-only --live-tasks ebay"
  host_up || die "the extension is not connected; run scripts/live.sh setup first"
  host/bin/nb-status >/dev/null || die "the OpenRouter key is not ready (host/bin/nb-status)"

  mkdir -p "$ROOT/runs"
  local out; out="$(mktemp -d "$ROOT/runs/live-$(date -u +%Y%m%dT%H%M%SZ)-XXXX")" || die "could not create a results dir"
  mkdir -p "$out/fixture"
  step "fixture server"
  node "$HARNESS/live-fixture-server.mjs" --seed "$RANDOM" --out "$out/fixture" >"$out/fixture.log" 2>&1 &
  FIXTURE_PID=$!
  # Closing nb-run does not stop the run in the extension, so an interrupted test would
  # leave the agent acting in your browser. Cancel whatever run is in flight on the way out.
  trap cleanup_test EXIT
  trap 'exit 130' INT TERM
  for _ in $(seq 50); do [ -f "$out/fixture/ready.json" ] && break; sleep 0.1; done
  [ -f "$out/fixture/ready.json" ] || die "fixture server did not start (see $out/fixture.log)"
  local base; base="$(jq -r .baseUrl "$out/fixture/ready.json")"
  echo "$base   results -> $out"
  echo "models: leader=$LEADER follower=$FOLLOWER"
  echo "Each task opens its own tab. Leave it frontmost until the task finishes:"
  echo "a run acts on whichever tab is active."

  : >"$out/summary.txt"
  local task pass=0 fail=0
  for task in ${tasks//,/ }; do
    step "task $task"
    local tj="$out/$task-task.json"
    node "$HARNESS/live-tasks.mjs" --task "$task" --expected "$out/fixture/expected.json" \
      --base-url "$base" --leader "$LEADER" --follower "$FOLLOWER" >"$tj" || { echo "unknown task $task"; fail=$((fail + 1)); continue; }
    local url prompt; url="$(jq -r .url "$tj")"; prompt="$(jq -r .prompt "$tj")"
    echo "$(jq -r .title "$tj")  ($url)"

    # Pin everything the panel also stores, or its last choice leaks in: a Kilo source
    # would route the Nemotron ids to the wrong gateway, a read-only toggle would block
    # the writes a task's verdict requires.
    local opt_args=(--option leaderModelSource=openrouter --option followerModelSource=openrouter)
    while IFS= read -r kv; do opt_args+=(--option "$kv"); done \
      < <(jq -r '.options | {readOnly: false} + . | to_entries[] | "\(.key)=\(.value)"' "$tj")

    local hits0 host0 ext0
    hits0="$(wc -l <"$out/fixture/hits.jsonl" 2>/dev/null || echo 0)"
    host0="$(wc -l <"$DATA/host.log" 2>/dev/null || echo 0)"
    ext0="$(wc -l <"$DATA/ext.log" 2>/dev/null || echo 0)"

    # A fresh tab, so the run never takes over the page you were reading.
    # With Chrome running, this hands the URL to it and exits; a failure here means the
    # run would take over whatever tab is active instead, so the task is not started.
    if ! timeout 15 "$CHROME" "$url" >/dev/null 2>&1; then
      echo "could not open a fresh tab for $task; not starting it"
      fail=$((fail + 1)); echo "FAIL  $task  (no fresh tab)" >>"$out/summary.txt"; continue
    fi
    sleep 2

    ACTIVE_STDERR="$out/$task-nb-run.stderr"
    timeout "$RUN_TIMEOUT" host/bin/nb-run "$prompt" --url "$url" "${opt_args[@]}" \
      >"$out/$task-stream.jsonl" 2>"$ACTIVE_STDERR"
    local rc=$? run_id
    ACTIVE_STDERR=""
    run_id="$(run_id_in "$out/$task-nb-run.stderr")"
    if [ "$rc" -eq 124 ] && [ -n "$run_id" ]; then
      echo "timed out after ${RUN_TIMEOUT}s; cancelling $run_id"
      host/bin/nb-cancel "$run_id" >/dev/null 2>&1 || true
    fi
    local runlog="$out/$task-runlog.jsonl"
    cp "$DATA/runs/$run_id.jsonl" "$runlog" 2>/dev/null || cp "$out/$task-stream.jsonl" "$runlog"

    tail -n +"$((hits0 + 1))" "$out/fixture/hits.jsonl" >"$out/$task-hits.jsonl" 2>/dev/null || : >"$out/$task-hits.jsonl"
    tail -n +"$((host0 + 1))" "$DATA/host.log" >"$out/$task-host.log" 2>/dev/null || : >"$out/$task-host.log"
    tail -n +"$((ext0 + 1))" "$DATA/ext.log" >"$out/$task-ext.log" 2>/dev/null || : >"$out/$task-ext.log"

    if node "$HARNESS/live-verdict.mjs" --task "$task" --stream "$runlog" \
         --expected "$out/fixture/expected.json" \
         --host-log "$out/$task-host.log" --ext-log "$out/$task-ext.log" \
         --download-dirs "$HOME/Downloads:$DATA/artifacts" --hits "$out/$task-hits.jsonl" \
         --json "$out/$task-verdict.json" | tee "$out/$task-verdict.txt"; then
      pass=$((pass + 1)); echo "PASS  $task  run=$run_id" >>"$out/summary.txt"
    else
      fail=$((fail + 1)); echo "FAIL  $task  run=$run_id  ($out/$task-verdict.txt)" >>"$out/summary.txt"
    fi
  done

  step "summary"
  cat "$out/summary.txt"
  echo "$pass passed, $fail failed"
  [ "$fail" -eq 0 ]
}

case "${1:-}" in
  setup) cmd_setup ;;
  test) shift; cmd_test "${1:-}" ;;
  run) shift
       exec scripts/e2e.sh --skip-build --leader "$LEADER" --follower "$FOLLOWER" --prompt "$@" ;;
  status) exec host/bin/nb-status ;;
  logs) exec host/bin/nb-logs ;;
  -h|--help|"") usage ;;
  *) usage; exit 2 ;;
esac
