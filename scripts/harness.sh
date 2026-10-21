#!/usr/bin/env bash
# Unattended end-to-end harness: a browser the harness owns, the real extension, the real
# native host, a local fixture page, and scripted model calls. No human click,
# no OpenRouter, no public internet, and nothing of the user's Chrome.
#
#   pnpm harness                      # or: bash scripts/harness.sh
#   bash scripts/harness.sh [--skip-build] [--keep] [--headed] [--seed N]
#                           [--run-timeout S] [--live | --live-only | --scripted-only]
#                           [--live-tasks a,b,c] [--live-timeout S]
#
#   --skip-build     reuse .output/chrome-mv3 as it stands
#   --keep           keep the /tmp dir (profiles, wrappers, sockets) for inspection
#   --headed         show the harness's browser windows
#   --seed N         fixture seed (env HB_HARNESS_SEED; default random, printed)
#   --run-timeout S  per-run cap on hb-run (env HB_HARNESS_RUN_TIMEOUT; default 180)
#   --live           retired. The fixture tasks do not prove a requirement; the flag exits 2.
#   --live-only      retired. Same refusal as --live.
#   --scripted-only  run only the scripted tier (the default)
#   --live-tasks csv ignored; --live exits before any task runs
#   --live-timeout S ignored; --live exits before any task runs
#
# What one invocation does:
#
#   1. pnpm build -> .output/chrome-mv3 (unless --skip-build).
#   2. Starts a local HTTP fixture (scripts/harness/fixture-server.mjs). Its three
#      inventory rows come from the seed and only reach the DOM after a click on
#      "Reveal inventory"; the expected answer is written to expected.json.
#   3. One scripted phase, a new isolated browser process:
#        - agent-browser launches its own Chrome for Testing (~/.agent-browser/browsers,
#          through a wrapper passed as the executable path) with a temp --user-data-dir
#          (--profile <tmpdir>) and the unpacked extension (--extension ->
#          --load-extension/--disable-extensions-except), so the extension is loaded at
#          process start and there is no Allow or Load-unpacked click.
#        - That wrapper sets XDG_CONFIG_HOME to a temp dir. The native-messaging manifest
#          com.handyboy.host.json is written into <profile>/NativeMessagingHosts (where
#          Chrome on Linux looks when --user-data-dir is set) and into the temp XDG dirs,
#          allowed_origins chrome-extension://dnicmmdhogcepeiooangkhhmdgphmonb/ (the id
#          pinned by the key in wxt.config.ts). ~/.config/google-chrome and
#          ~/.config/chromium are never read or written, and port 9222 is never used:
#          the browser's CDP endpoint is its own --remote-debugging-port=0.
#        - The manifest points at a wrapper in the temp dir that runs THIS repo's
#          host/src/main.ts with HB_HOME and HANDYBOY_SOCK inside the run's own
#          directories, a `doppler` shim first on PATH (the real Doppler is never
#          called), and `node --import scripts/harness/scripted-upstream.mjs`.
#      The phase is `scripted`: a fresh profile against the main fixture, expected to
#      pass. Model calls are answered by the scripted Leader/Follower in
#      scripted-upstream.mjs (a policy that reads what the extension sent it, not a
#      transcript).
#   4. The phase asserts, and the harness exits non-zero if any fails:
#        - the browser process is agent-browser's Chrome for Testing binary with the temp
#          --user-data-dir and --load-extension, and its crashpad database is under the
#          temp XDG_CONFIG_HOME
#        - the extension's service worker is running (CDP to the harness's own browser:
#          Target.getTargets, then Runtime.evaluate chrome.runtime.id inside the worker)
#        - the native host was spawned by that browser, is this repo's host/src/main.ts,
#          and reports extensionConnected
#        - hb-run over the host socket (inputFidelity=in-page, observe=dom) completes, and
#          the stream it prints equals the run log the host persisted, event for event
#        - scripts/harness/verdict.mjs over that persisted run JSONL: run.started first;
#          run.ended and the host's run.end both `done`; a Leader->Follower handoff and a
#          Follower->Leader replan; an ok Follower click and an ok Follower extract_text
#          whose result names a fixture SKU; an ok leader_snapshot; a Follower `done`
#          whose summary is exactly
#          {"inventory":[{"sku":"AA-0000","name":"...","stock":N} x3],"count":3}, equal
#          to expected.json in page order; the fixture saw GET / and the click handler's
#          GET /api/inventory; ext.log has no error lines
#        - the page shows the 3 revealed rows afterwards (agent-browser eval)
#   5. Verdict self-test: the scripted phase's run log, which passes untampered, is
#      tampered 10 ways (wrong stock, wrong SKU, [], {}, prose, reordered rows, handoffs
#      removed, status error, click failed, page read removed); every tampered copy must
#      FAIL the verdict.
#   6. The user's own host socket ($XDG_RUNTIME_DIR/handyboy.sock) is unchanged.
#
# Everything lands in runs/harness-<UTC stamp>/: harness.log, and under scripted/
# run.jsonl (stream), runlog.jsonl (persisted), verdict.txt, host.log, ext.log,
# upstream.jsonl, chrome-cmdline.txt, service-worker.json,
# page-after.txt; plus the fixture dir. Profiles and sockets live in a /tmp dir
# removed on exit unless --keep.
#
# Needs: node (>= 22, host runs .ts directly), jq, agent-browser with its Chrome for Testing
# (`agent-browser install`). Exit 0 = every asserted check passed; 1 = anything else;
# 2 = bad usage or missing prerequisite.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

EXT_ID=dnicmmdhogcepeiooangkhhmdgphmonb
EXT_DIR="$ROOT/.output/chrome-mv3"
HOST_NAME=com.handyboy.host
HARNESS="$ROOT/scripts/harness"

SKIP_BUILD=0
HEADED=0
KEEP=0
SEED="${HB_HARNESS_SEED:-$(( (RANDOM << 15 | RANDOM) % 1000000 + 1 ))}"
RUN_TIMEOUT="${HB_HARNESS_RUN_TIMEOUT:-180}"
LIVE=0
SCRIPTED_ONLY=0

usage() { awk 'NR == 1 { next } /^[^#]/ { exit } { print }' "$0" | sed 's/^# \{0,1\}//'; }

while [ $# -gt 0 ]; do
  case "$1" in
    --skip-build) SKIP_BUILD=1; shift ;;
    --headed) HEADED=1; shift ;;
    --keep) KEEP=1; shift ;;
    --seed) SEED="$2"; shift 2 ;;
    --run-timeout) RUN_TIMEOUT="$2"; shift 2 ;;
    --live) LIVE=1; shift ;;
    --live-only) LIVE=1; shift ;;
    --scripted-only) SCRIPTED_ONLY=1; shift ;;
    --live-tasks) [ -n "${2:-}" ] || { echo "harness: --live-tasks needs a value" >&2; exit 2; }; shift 2 ;;
    --live-timeout) [ -n "${2:-}" ] || { echo "harness: --live-timeout needs a value" >&2; exit 2; }; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "harness: unknown option $1" >&2; exit 2 ;;
  esac
done

[ "$LIVE" = "1" ] && [ "$SCRIPTED_ONLY" = "1" ] && { echo "harness: --live/--live-only and --scripted-only contradict" >&2; exit 2; }
# The live tier runs the same fixture tasks as scripts/live.sh test: localhost pages,
# a prompt that dictates the steps, and a score of the model's JSON. That is not a
# requirement happening.
if [ "$LIVE" = "1" ]; then
  echo "harness: the live fixture tasks are not tests. They do not prove a requirement. Run: just check" >&2
  exit 2
fi

for bin in node jq agent-browser timeout; do
  command -v "$bin" >/dev/null || { echo "harness: $bin is required" >&2; exit 2; }
done
NODE_BIN="$(mise which node 2>/dev/null || command -v node)"
# agent-browser's own Chrome for Testing download, never a system or branded Chrome.
CFT_BIN="$(ls -d "$HOME"/.agent-browser/browsers/chrome-*/chrome 2>/dev/null | sort -V | tail -n1)"
[ -x "$CFT_BIN" ] || { echo "harness: no Chrome for Testing under ~/.agent-browser/browsers; run: agent-browser install" >&2; exit 2; }

# Nothing inherited may point agent-browser at another browser or profile.
unset AGENT_BROWSER_CDP AGENT_BROWSER_AUTO_CONNECT AGENT_BROWSER_PROFILE AGENT_BROWSER_EXTENSIONS \
      AGENT_BROWSER_EXECUTABLE_PATH AGENT_BROWSER_ARGS AGENT_BROWSER_SESSION AGENT_BROWSER_RESTORE \
      AGENT_BROWSER_STATE AGENT_BROWSER_HEADED AGENT_BROWSER_PROVIDER

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
WORK="$ROOT/runs/harness-$STAMP"
mkdir -p "$WORK"
# Short path: unix socket paths are capped at 108 bytes.
TMP="$(mktemp -d /tmp/nb-harness.XXXXXX)"
exec > >(tee -a "$WORK/harness.log") 2>&1

SESSIONS=()
FIXTURE_PIDS=()
FAILURES=()
cleanup() {
  local s
  for s in "${SESSIONS[@]}"; do agent-browser --session "$s" close >/dev/null 2>&1 || true; done
  local p
  for p in "${FIXTURE_PIDS[@]}"; do kill "$p" 2>/dev/null || true; done
  if [ "$KEEP" = "1" ]; then echo "kept temp dir: $TMP"; else rm -rf "$TMP"; fi
}
trap cleanup EXIT

step() { printf '\n=== %s\n' "$*"; }
ok() { printf '  PASS  %s\n' "$*"; }
bad() { printf '  FAIL  %s\n' "$*"; FAILURES+=("$CURRENT_PHASE: $*"); }
CURRENT_PHASE=setup

echo "harness run:  $WORK"
echo "temp dir:     $TMP"
echo "seed:         $SEED"
echo "node:         $NODE_BIN ($("$NODE_BIN" --version))"
echo "agent-browser $(agent-browser --version 2>/dev/null | awk '{print $2}'), browser: $CFT_BIN"

# The user's own host socket, if any. The harness must leave it exactly as it found it.
REAL_SOCK="${XDG_RUNTIME_DIR:-$HOME/.local/share/handyboy/run}/handyboy.sock"
real_sock_id() { stat -c '%i %Y' "$REAL_SOCK" 2>/dev/null || echo absent; }
REAL_SOCK_BEFORE="$(real_sock_id)"

# ------------------------------------------------------------------------- 1. build
if [ "$SKIP_BUILD" = "1" ]; then
  step "build (skipped)"
  [ -f "$EXT_DIR/manifest.json" ] || { echo "harness: --skip-build but $EXT_DIR/manifest.json is missing" >&2; exit 2; }
else
  step "build"
  pnpm build >"$WORK/build.log" 2>&1 || { tail -20 "$WORK/build.log"; echo "harness: pnpm build failed" >&2; exit 1; }
  echo "built $EXT_DIR"
fi
MANIFEST_KEY_ID="$(jq -r '.key' "$EXT_DIR/manifest.json" | base64 -d | sha256sum | head -c 32 | tr '0-9a-f' 'a-p')"
[ "$MANIFEST_KEY_ID" = "$EXT_ID" ] || { echo "harness: built manifest key gives id $MANIFEST_KEY_ID, expected $EXT_ID" >&2; exit 1; }
echo "manifest key -> extension id $MANIFEST_KEY_ID"

# ---------------------------------------------------------------------- 2. fixtures
start_fixture() { # <name> <seed>
  local dir="$WORK/fixture-$1"
  node "$HARNESS/fixture-server.mjs" --seed "$2" --out "$dir" >"$dir.log" 2>&1 &
  FIXTURE_PIDS+=($!)
  local i
  for i in $(seq 1 50); do [ -f "$dir/ready.json" ] && break; sleep 0.1; done
  [ -f "$dir/ready.json" ] || { cat "$dir.log"; echo "harness: fixture $1 did not start" >&2; exit 1; }
}
step "fixture pages"
start_fixture main "$SEED"
FIXTURE_URL="$(jq -r .url "$WORK/fixture-main/ready.json")"
echo "main fixture:     $FIXTURE_URL  expected rows: $(jq -c . "$WORK/fixture-main/expected.json")"

# The host's SecretStore shells out to `doppler`. This shim answers instead, so the real
# Doppler (and the user's real key) is never touched; the fake key only ever reaches the
# scripted fetch.
mkdir -p "$TMP/bin"
cat >"$TMP/bin/doppler" <<'SHIM'
#!/bin/sh
case "$*" in
  *OPENROUTER_API_KEY*) echo "nb-harness-not-a-real-key" ;;
  *) exit 1 ;;
esac
SHIM
chmod 0755 "$TMP/bin/doppler"

PROMPT='Reveal the inventory on this page and report every item. Call done with a summary that is only a JSON object {"inventory":[{"sku":"<sku>","name":"<name>","stock":<number>}],"count":<number of items>}, rows in page order, and no other text.'

# ------------------------------------------------------------------------ 3. phases
run_phase() { # <name> <fixture url> <fixture dir>
  local name="$1" url="$2" fixdir="$3"
  CURRENT_PHASE="$name"
  local D="$TMP/$name" OUT="$WORK/$name"
  mkdir -p "$D" "$OUT"
  mkdir -p "$D/profile/NativeMessagingHosts" "$D/home"
  local xdgdir
  for xdgdir in chromium google-chrome google-chrome-for-testing; do mkdir -p "$D/xdg/$xdgdir/NativeMessagingHosts"; done

  step "phase $name: fixture=$url"

  cat >"$D/handyboy-host" <<WRAP
#!/bin/sh
# Written by scripts/harness.sh for one phase. Spawned by the harness's own browser only.
HANDYBOY_DEV=1
HANDYBOY_SOCK=$D/nb.sock
HB_HOME=$D/home
HB_HARNESS_UPSTREAM_LOG=$OUT/upstream.jsonl
PATH=$TMP/bin:\$PATH
export HANDYBOY_DEV HANDYBOY_SOCK HB_HOME HB_HARNESS_UPSTREAM_LOG PATH
exec "$NODE_BIN" --import "$HARNESS/scripted-upstream.mjs" "$ROOT/host/src/main.ts" "\$@"
WRAP
  chmod 0755 "$D/handyboy-host"
  local manifest
  manifest="$(jq -n --arg path "$D/handyboy-host" --arg origin "chrome-extension://$EXT_ID/" \
    '{name: "com.handyboy.host", description: "Handyboy harness host", path: $path, type: "stdio", allowed_origins: [$origin]}')"
  local mdir
  for mdir in "$D/profile/NativeMessagingHosts" "$D"/xdg/*/NativeMessagingHosts; do
    printf '%s\n' "$manifest" >"$mdir/$HOST_NAME.json"
  done

  # agent-browser's daemon does not hand its caller's environment to Chrome, so the
  # isolation env rides on an executable wrapper that execs agent-browser's own binary.
  cat >"$D/chrome" <<CHROME
#!/bin/sh
XDG_CONFIG_HOME=$D/xdg; export XDG_CONFIG_HOME
exec "$CFT_BIN" "\$@"
CHROME
  chmod 0755 "$D/chrome"

  local S
  S="$(agent-browser session id --scope worktree --prefix nbharness 2>/dev/null || echo nbharness)-$name-$$"
  SESSIONS+=("$S")
  # Every agent-browser call carries the same launch config, so none of them relaunches
  # the browser with different options.
  local headed=()
  [ "$HEADED" = "1" ] && headed=(--headed)
  ab() {
    XDG_CONFIG_HOME="$D/xdg" AGENT_BROWSER_PROFILE="$D/profile" AGENT_BROWSER_EXTENSIONS="$EXT_DIR" \
      AGENT_BROWSER_EXECUTABLE_PATH="$D/chrome" \
      agent-browser --session "$S" "${headed[@]}" "$@"
  }

  local hits_before
  hits_before="$(wc -l <"$fixdir/hits.jsonl" 2>/dev/null || echo 0)"

  # --- browser with the extension loaded at process start
  if ! ab open "$url" >"$OUT/agent-browser-open.log" 2>&1; then
    cat "$OUT/agent-browser-open.log"; bad "agent-browser could not launch the isolated browser"; return
  fi
  ok "agent-browser launched session $S on $url"

  # --- isolation: which Chrome is this, really
  local pid cmd
  pid="$(pgrep -f -- "--user-data-dir=$D/profile" | while read -r p; do
           [[ "$(tr '\0' ' ' </proc/"$p"/cmdline 2>/dev/null)" != *"--type="* ]] && echo "$p"; done | head -n1)"
  if [ -z "$pid" ]; then
    bad "no browser process with --user-data-dir=$D/profile"; return
  fi
  cmd="$(tr '\0' ' ' </proc/"$pid"/cmdline)"
  printf '%s\n' "$cmd" >"$OUT/chrome-cmdline.txt"
  local exe
  exe="$(readlink -f /proc/"$pid"/exe)"
  if [[ "$exe" == "$HOME/.agent-browser/browsers/"* && "$cmd" == *"--load-extension=$EXT_DIR"* \
        && "$cmd" == *"--disable-extensions-except=$EXT_DIR"* && "$cmd" != *".config/google-chrome"* ]]; then
    ok "browser pid $pid is $exe with --user-data-dir=$D/profile --load-extension=$EXT_DIR"
  else
    bad "browser pid $pid is not the isolated Chrome for Testing launch: exe=$exe (cmdline in $OUT/chrome-cmdline.txt)"
  fi
  # /proc/<pid>/environ is useless here (Chrome overwrites it when it sets its process
  # title); what Chrome derived from XDG_CONFIG_HOME is visible in its crashpad database.
  local crashpad
  crashpad="$(pgrep -a -f -- "chrome_crashpad_handler.*--database=$D/xdg/" | head -n1)"
  if [ -n "$crashpad" ]; then
    ok "browser config root is the temp XDG_CONFIG_HOME: $(grep -o -- "--database=[^ ]*" <<<"$crashpad" | head -n1)"
  else
    bad "browser did not take its config root from XDG_CONFIG_HOME=$D/xdg (no crashpad database under it)"
  fi

  # --- service worker
  local ws probe
  ws="$(ab get cdp-url 2>/dev/null | grep -Eo 'ws://[^[:space:]]+' | head -n1)"
  if [ -z "$ws" ]; then bad "agent-browser gave no CDP url for its browser"; return; fi
  probe="$(node "$HARNESS/cdp-probe.mjs" --ws "$ws" --id "$EXT_ID" --timeout 30)"
  printf '%s\n' "$probe" >"$OUT/service-worker.json"
  if jq -e '.ok' <<<"$probe" >/dev/null 2>&1; then
    ok "service worker up: $(jq -r '"\(.worker) in \(.browser), chrome.runtime.id=\(.runtime.id) v\(.runtime.version)"' <<<"$probe")"
  else
    bad "service worker probe: $(jq -r '.error // .' <<<"$probe" 2>/dev/null || echo "$probe")"; return
  fi

  # --- native host spawned by this browser
  local status="" i
  for i in $(seq 1 60); do
    if [ -S "$D/nb.sock" ]; then
      status="$(HANDYBOY_SOCK="$D/nb.sock" host/bin/hb-status 2>/dev/null)"
      jq -e '.extensionConnected == true' <<<"$status" >/dev/null 2>&1 && break
    fi
    sleep 0.5
  done
  printf '%s\n' "$status" >"$OUT/hb-status.json"
  if jq -e '.extensionConnected == true' <<<"$status" >/dev/null 2>&1; then
    local host_pid; host_pid="$(jq -r .pid <<<"$status")"
    local host_cmd; host_cmd="$(tr '\0' ' ' </proc/"$host_pid"/cmdline 2>/dev/null)"
    local host_parent; host_parent="$(ps -o ppid= -p "$host_pid" 2>/dev/null | tr -d ' ')"
    ok "native host pid $host_pid connected (parent pid $host_parent; key: $(jq -c .key <<<"$status"))"
    printf '%s\n' "$host_cmd" >"$OUT/host-cmdline.txt"
    [[ "$host_cmd" == *"$ROOT/host/src/main.ts"* && "$host_cmd" == *"chrome-extension://$EXT_ID/"* ]] \
      && ok "host is this repo's host/src/main.ts, launched for chrome-extension://$EXT_ID/" \
      || bad "host command line is unexpected: $host_cmd"
  else
    bad "native host never reported extensionConnected at $D/nb.sock (last status: ${status:-none})"; return
  fi

  # --- the run
  # A dev run acts on the active tab; make sure it is the fixture, not a new-tab page.
  ab open "$url" >/dev/null 2>&1 || true
  local stream="$OUT/run.jsonl"
  echo "  run: hb-run (timeout ${RUN_TIMEOUT}s) -> $stream"
  HANDYBOY_SOCK="$D/nb.sock" timeout "$RUN_TIMEOUT" host/bin/hb-run "$PROMPT" \
    --url "$url" \
    --option leaderModel=harness/scripted-leader \
    --option followerModel=harness/scripted-follower \
    --option observe=dom \
    --option inputFidelity=in-page \
    --option planningInterval=5 \
    --option maxSteps=12 \
    >"$stream" 2>"$OUT/hb-run.stderr"
  local rc=$?
  echo "  hb-run exit $rc, $(wc -l <"$stream") events, $(tr '\n' ' ' <"$OUT/hb-run.stderr")"

  # The product's own run log, persisted by the host. The verdict judges this file; the
  # hb-run stream must carry exactly the same events in the same order.
  local run_id runlog="$OUT/runlog.jsonl"
  run_id="$(grep -o 'runId=[A-Za-z0-9_-]*' "$OUT/hb-run.stderr" | head -n1 | cut -d= -f2)"
  if [ -n "$run_id" ] && cp "$D/home/.local/share/handyboy/runs/$run_id.jsonl" "$runlog" 2>/dev/null; then
    ok "host persisted run log $run_id.jsonl ($(wc -l <"$runlog") events)"
  else
    bad "no persisted run log for runId=${run_id:-<none>}"; : >"$runlog"
  fi
  jq -rc '[.kind // .type, (.from // empty) + (if .to then "->" + .to else "" end), .role // empty, .call.name // .result.name // empty,
           (if .result then "ok=\(.result.ok)" else empty end), .status // empty] | map(select(. != "")) | join(" ")' "$runlog" \
    | sed 's/^/    /'
  if [ -s "$runlog" ] && [ "$(jq -c . "$stream")" = "$(jq -c . "$runlog")" ]; then
    ok "the hb-run stream delivered every run-log event, in order"
  else
    bad "the hb-run stream ($(wc -l <"$stream") events) differs from the persisted run log ($(wc -l <"$runlog") events)"
  fi

  # --- page state after the run, straight from the browser
  local rows_on_page
  rows_on_page="$(ab eval "document.querySelectorAll('#inventory li').length" 2>/dev/null | tr -dc '0-9')"
  ab snapshot >"$OUT/page-after.txt" 2>&1 || true
  tail -n +"$((hits_before + 1))" "$fixdir/hits.jsonl" >"$OUT/fixture-hits.jsonl" 2>/dev/null || true

  cp "$D/home/.local/share/handyboy/host.log" "$OUT/host.log" 2>/dev/null || true
  cp "$D/home/.local/share/handyboy/ext.log" "$OUT/ext.log" 2>/dev/null || : >"$OUT/ext.log"

  # --- verdict
  echo "  verdict:"
  node "$HARNESS/verdict.mjs" --stream "$runlog" --expected "$fixdir/expected.json" \
    --hits "$OUT/fixture-hits.jsonl" --ext-log "$OUT/ext.log" | tee "$OUT/verdict.txt"
  local verdict=${PIPESTATUS[0]}

  [ "$verdict" -eq 0 ] && ok "verdict passed" || bad "verdict failed (see $OUT/verdict.txt)"
  [ "$rows_on_page" = "3" ] && ok "the page now shows 3 revealed inventory rows" \
    || bad "the page shows ${rows_on_page:-?} inventory rows after the run, want 3"

  ab close >/dev/null 2>&1 || true
}

run_phase scripted "$FIXTURE_URL" "$WORK/fixture-main"

# ------------------------------------------------------------ 5. verdict self-test
CURRENT_PHASE=selftest
step "verdict self-test: a wrong or empty result must fail"
SELFTEST_STREAM="$WORK/scripted/runlog.jsonl"
if node "$HARNESS/verdict.mjs" --stream "$SELFTEST_STREAM" --expected "$WORK/fixture-main/expected.json" >/dev/null 2>&1; then
  ok "untampered $(basename "$(dirname "$SELFTEST_STREAM")") stream passes the verdict; tampering it:"
  for t in wrong-stock wrong-sku empty-array empty-object prose reordered no-handoff status-error click-failed no-page-read; do
    if node "$HARNESS/verdict.mjs" --stream "$SELFTEST_STREAM" --expected "$WORK/fixture-main/expected.json" \
         --tamper "$t" >"$WORK/selftest-$t.txt" 2>&1; then
      bad "tamper $t still passed the verdict"
    else
      ok "tamper $t fails: $(grep -m1 FAIL "$WORK/selftest-$t.txt" | sed 's/^ *FAIL  //' | cut -c1-160)"
    fi
  done
else
  bad "the scripted stream does not pass untampered; nothing meaningful to self-test"
fi
# ---------------------------------------------------------------------- summary
CURRENT_PHASE=teardown
REAL_SOCK_AFTER="$(real_sock_id)"
[ "$REAL_SOCK_BEFORE" = "$REAL_SOCK_AFTER" ] && ok "the user's own host socket ($REAL_SOCK) is untouched: $REAL_SOCK_AFTER" \
  || bad "the user's host socket changed: $REAL_SOCK_BEFORE -> $REAL_SOCK_AFTER"

step "result"
echo "logs: $WORK"
if [ "${#FAILURES[@]}" -eq 0 ]; then
  echo "HARNESS PASS"
  exit 0
fi
printf '  %s\n' "${FAILURES[@]}"
echo "HARNESS FAIL (${#FAILURES[@]})"
exit 1
