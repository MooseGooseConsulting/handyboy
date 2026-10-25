#!/usr/bin/env bash
# Drive Handyboy in the user's real Chrome.
#
#   scripts/live.sh setup              build, register the host, get the extension connected
#   scripts/live.sh run "<prompt>" [--url <url>]   one ad-hoc run with the free pair
#   scripts/live.sh status | logs
#
# `setup` is safe to re-run at any time and needs no click once the extension has been
# loaded unpacked one time ever. It wakes the extension by opening one of its own pages,
# which starts the service worker, which spawns the host. Only a profile that has never
# loaded the extension falls back to chrome://extensions, which Chrome reserves for a human.
#
# `test` is retired. The fixture tasks opened localhost pages, dictated the steps, and
# scored a JSON blob. That is not a requirement happening. Proof is `just check`.
#
# Environment: HB_LIVE_CHROME, HB_LIVE_CHROME_DIR (browser and its config dir),
# HB_LIVE_LEADER, HB_LIVE_FOLLOWER (model ids), HB_LIVE_CONNECT_WAIT, and
# HB_LIVE_REINSTALL_HOST=1 to point the registered dev host at this checkout when
# setup reports it runs from another one.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
EXT_DIR="$ROOT/.output/chrome-mv3"
CHROME="${HB_LIVE_CHROME:-$(command -v google-chrome-stable || command -v google-chrome || true)}"
CHROME_DIR="${HB_LIVE_CHROME_DIR:-$HOME/.config/google-chrome}"
LEADER="${HB_LIVE_LEADER:-nvidia/nemotron-3-ultra-550b-a55b:free}"
FOLLOWER="${HB_LIVE_FOLLOWER:-nvidia/nemotron-3.5-lightning:free}"
CONNECT_WAIT="${HB_LIVE_CONNECT_WAIT:-300}"

step() { printf '\n== %s\n' "$*"; }
die() { echo "live: $*" >&2; exit 1; }

usage() { sed -n '2,21p' "$0" | sed 's/^# \{0,1\}//'; }

# ext_id, registrations
source "$ROOT/scripts/registrations.sh"

# True once the extension's service worker has spawned the dev host and it answers.
# hb-status exits 1 both for "key not ready" and "no host", so read what it printed instead.
# Captured rather than piped: `grep -q` exits early, and under pipefail the SIGPIPE it
# leaves on hb-status would read as "no host".
host_up() { local out; out="$(timeout 30 host/bin/hb-status 2>/dev/null)"; [[ "$out" == *'"op"'* ]]; }

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
  [ -n "$CHROME" ] || die "no google-chrome-stable on PATH (set HB_LIVE_CHROME)"
  pgrep -x 'chrome|chromium|chromium-browser' >/dev/null || die "Chrome is not running; start it normally, then re-run"
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
  local reg profile path us live_reg=0
  # A failed enumeration may have printed a partial list; never copy on that basis.
  reg="$(registrations)" || die "a Chrome registration exists but could not be read completely (see the NOTE above)"
  while IFS=$'\x1f' read -r profile path us; do
    [ -n "$profile" ] || continue
    [ -d "$path" ] && live_reg=1
    echo "registered in Chrome profile \"$profile\" from $path"
    if [ -z "$path" ]; then
      # A packaged install (crx or Web Store) loads from Chrome's own storage,
      # and its worker answers the socket with that copy; setup's contract is
      # that every registration runs this build, which only the human can
      # restore here.
      die "\"$profile\" runs Handyboy packaged, not from an unpacked directory; remove it in chrome://extensions, then Load unpacked from $EXT_DIR"
    fi
    case "$path" in
      /*) ;;
      # Same guard as unsynced_registrations: only an absolute directory is an
      # unpacked registration. A relative path is Chrome's own bookkeeping for
      # a packaged install and must not be treated as a dead build here.
      *) die "\"$profile\" runs Handyboy from \"$path\", which is not an unpacked absolute directory; a reload would run that copy, not this build. Remove it in chrome://extensions, then Load unpacked from $EXT_DIR" ;;
    esac
    if [ "$path" != "$EXT_DIR" ]; then
      # rsync --delete empties whatever is there, so only overwrite a directory that still
      # holds a Handyboy build. A stale registration may now point at something else.
      if [ "$(jq -r .key "$path/manifest.json" 2>/dev/null)" != "$(jq -r .key "$EXT_DIR/manifest.json")" ]; then
        echo "   NOTE: $path no longer holds a Handyboy build; not touching it. Load unpacked again from $EXT_DIR"
        continue
      fi
      rsync -a --delete "$EXT_DIR/" "$path/" || die "could not copy the build to $path"
      echo "copied this build there"
    fi
    [ "$us" = "True" ] || echo "   NOTE: \"Allow User Scripts\" is off in \"$profile\"; userscript tasks fail until you turn it on in the extension's Details"
  done <<<"$reg"

  step "native host"
  # The wrapper bakes in an absolute path, so only install when it is missing or is not the
  # dev build: reinstalling from a worktree would point Chrome at a tree that may vanish.
  local manifest="$CHROME_DIR/NativeMessagingHosts/com.handyboy.host.json" wrapper
  wrapper="$(jq -r .path "$manifest" 2>/dev/null || true)"
  if [ -z "${HB_LIVE_REINSTALL_HOST:-}" ] && [ -x "$wrapper" ] && grep -q HANDYBOY_DEV=1 "$wrapper"; then
    echo "already registered: $wrapper"
    # Host changes in this tree are not live until the wrapper points here; say so rather
    # than let a run silently exercise another checkout's host.
    grep -qF "\"$ROOT/host/src/main.ts\"" "$wrapper" \
      || echo "   NOTE: the host runs from another checkout ($(grep -o '"[^"]*main.ts"' "$wrapper")). HB_LIVE_REINSTALL_HOST=1 points it at this one."
  else
    bash host/install.sh --dev | sed 's/^/   /' || die "host/install.sh failed"
    # install.sh writes only under ${HB_HOME:-$HOME}'s default Chrome and Chromium config
    # dirs; a Chrome with another config dir would otherwise keep a stale registration.
    local installed="${HB_HOME:-$HOME}/.config/google-chrome/NativeMessagingHosts/com.handyboy.host.json"
    if [ "$installed" != "$manifest" ]; then
      mkdir -p "$(dirname "$manifest")" && cp "$installed" "$manifest" \
        || die "could not register the host under $CHROME_DIR"
      echo "   installed: $manifest"
    fi
  fi

  step "extension"
  # A registered path can be a checkout that has since moved. Reloading then kills the
  # working worker with nothing behind it to load, so stop before hb-reload instead.
  if [ -n "$reg" ] && [ "$live_reg" = 0 ]; then
    die "the registered build directory is gone; Load unpacked again from $EXT_DIR"
  fi
  if host_up; then
    host/bin/hb-reload --timeout 30 >/dev/null 2>&1 || die "hb-reload failed (host/bin/hb-logs)"
    echo "reloaded in place"
  elif [ -n "$reg" ]; then
    # An idle MV3 worker does not run until something wakes it; one of its own pages does.
    "$CHROME" "chrome-extension://$(ext_id)/sidepanel.html" >/dev/null 2>&1 &
    # The host binds the socket only after its Doppler lookups, which may take their full
    # 20 s timeout, so wait past that before calling the extension broken.
    if wait_for_extension 45; then
      host/bin/hb-reload --timeout 30 >/dev/null 2>&1 || die "woke the extension but hb-reload failed, so it may still run the old build (host/bin/hb-logs)"
      echo "woke the extension through its own page and reloaded it"
    else
      die "the extension is registered but did not start; it may be disabled or in an error state at chrome://extensions"
    fi
  else
    local copied=""
    printf '%s' "$EXT_DIR" | wl-copy 2>/dev/null && copied=" (also on your clipboard)"
    "$CHROME" chrome://extensions >/dev/null 2>&1 &
    cat <<MSG
   This Chrome profile has never loaded Handyboy, and Chrome only allows that by hand:
     1. In the chrome://extensions tab that just opened, turn Developer mode ON.
     2. Click "Load unpacked" and choose this folder${copied}:
          $EXT_DIR
     3. Open Handyboy's Details and turn on "Allow User Scripts".
   This is needed once per profile, ever.
MSG
    wait_for_extension "$CONNECT_WAIT" || die "the extension never connected after ${CONNECT_WAIT}s"
    echo "extension connected"
  fi

  step "readiness"
  local status reason
  status="$(host/bin/hb-status 2>&1)"; echo "$status"
  if jq -e '.key.ready' <<<"$status" >/dev/null 2>&1; then
    echo; echo "ready."
  else
    reason="$(jq -r '.key.reason // empty' <<<"$status" 2>/dev/null)"
    case "$reason" in
      *401*) die "OpenRouter rejected the key (401). Rotate OPENROUTER_API_KEY in Doppler ai-automation/dev, then re-run setup" ;;
      *) die "the extension is connected but the key is not ready: ${reason:-see the status above}" ;;
    esac
  fi
}

cmd_test() {
  die "fixture tasks are not tests. They do not prove a requirement. Run: just check"
}

case "${1:-}" in
  setup) cmd_setup ;;
  test) shift; cmd_test "${1:-}" ;;
  run) shift
       exec scripts/e2e.sh --skip-build --leader "$LEADER" --follower "$FOLLOWER" \
         --leader-source openrouter --follower-source openrouter --prompt "$@" ;;
  status) exec host/bin/hb-status ;;
  logs) exec host/bin/hb-logs ;;
  -h|--help|"") usage ;;
  *) usage; exit 2 ;;
esac
