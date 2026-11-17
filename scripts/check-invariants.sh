#!/usr/bin/env bash
# Stealth invariants (R-02). Each one is a grep, each closes a whole family of
# extension-detection signals. See docs/research/bot-detection-research.md § Recommendation.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

MANIFEST=".output/chrome-mv3/manifest.json"
FAILED=0

fail() {
  echo "INVARIANT FAILED: $1"
  FAILED=1
}

pass() {
  echo "ok: $1"
}

# Build every time. The manifest invariants are about what ships, and a .output left by
# an older branch or checkout would let new code pass on an old manifest. The project's
# own wxt rather than `pnpm exec`, which fails where pnpm is a shim with no version set.
[ -x node_modules/.bin/wxt ] || { echo "node_modules/.bin/wxt is missing; install dependencies first"; exit 1; }
echo "building .output/chrome-mv3..."
BUILD_LOG="$(node_modules/.bin/wxt build 2>&1)" || { echo "$BUILD_LOG"; echo "build failed"; exit 1; }
[ -f "$MANIFEST" ] || { echo "the build wrote no $MANIFEST"; exit 1; }

# scan <grep options...> -- <paths...>: sets HITS to the matching source lines. A path that
# no longer exists greps as "no match", which would read as a pass for code that merely
# moved, so a missing path fails instead; point the scan at the new location.
scan() {
  local opts=() p missing=0
  while [ "$1" != "--" ]; do opts+=("$1"); shift; done
  shift
  for p in "$@"; do
    [ -e "$p" ] || { fail "scanned path $p does not exist (moved or renamed?)"; missing=1; }
  done
  [ "$missing" -eq 0 ] || return 1
  HITS="$(grep -rn --include='*.ts' --include='*.tsx' --include='*.js' --include='*.jsx' "${opts[@]}" "$@")"
  [ $? -le 1 ] || { fail "grep could not scan $*"; return 1; }
}

# 1. No web_accessible_resources: any listed resource is fetchable by the page and
#    turns the extension into an enumerable, fingerprintable surface.
if grep -q '"web_accessible_resources"' "$MANIFEST"; then
  fail 'manifest declares web_accessible_resources'
else
  pass 'manifest has no web_accessible_resources'
fi

# 2. No externally_connectable: it advertises the extension ID to every allowed origin.
if grep -q '"externally_connectable"' "$MANIFEST"; then
  fail 'manifest declares externally_connectable'
else
  pass 'manifest has no externally_connectable'
fi

# 3. No declared content_scripts: page code is injected on demand with
#    chrome.scripting.executeScript into the ISOLATED world, never standing.
if grep -q '"content_scripts"' "$MANIFEST"; then
  fail 'manifest declares content_scripts'
else
  pass 'manifest has no content_scripts'
fi

# 4. No MAIN-world execution anywhere in source. Userscripts go through
#    chrome.userScripts, a separate API with its own isolation story.
if scan -e 'world: *"MAIN"' -e "world: *'MAIN'" -- entrypoints src scripts; then
  if [ -n "$HITS" ]; then
    fail 'source uses world: "MAIN"'
    echo "$HITS"
  else
    pass 'no world: "MAIN" in source'
  fi
fi

# 5. No window.postMessage bridge in page-context code. A postMessage channel
#    between the page and the extension is enumerable page-side and turns the
#    extension into a detectable surface; the injected tier talks over
#    chrome.runtime messaging only (see src/page/handler.ts). Word-boundary match
#    so the bare window-scope call is caught alongside window.postMessage.
PAGE_CONTEXT=(src/page entrypoints/injected-content.ts src/userscripts)
if scan -e '\<postMessage[[:space:]]*(' -- "${PAGE_CONTEXT[@]}"; then
  if [ -n "$HITS" ]; then
    fail 'page-context code uses window.postMessage'
    echo "$HITS"
  else
    pass 'no postMessage in page-context code'
  fi
fi

# 6. No storage writes in page-context code. localStorage/sessionStorage/IndexedDB
#    writes and cookie assignments from injected code are observable page-side
#    (storage events) and persist extension fingerprints past the run. Test files
#    never ship to pages, so they are excluded from this scan.
if scan --exclude='*.test.ts' -e 'localStorage' -e 'sessionStorage' -e 'indexedDB' -e 'document\.cookie[[:space:]]*=' \
  -- "${PAGE_CONTEXT[@]}"; then
  if [ -n "$HITS" ]; then
    fail 'page-context code touches web storage'
    echo "$HITS"
  else
    pass 'no web storage in page-context code'
  fi
fi

# 7. No fetch in the extension's own injected tier (src/page, injected-content).
#    src/userscripts is exempt: agent/user-authored scripts are governed by the
#    authoring rails (src/userscripts/authoring.ts), and the bundled i03 probe
#    reads its own page over GET by design. Word-boundary match so window.fetch
#    is caught too; prefetch/fetchData and bare mentions without a call are not.
if scan -e '\<fetch[[:space:]]*(' -- src/page entrypoints/injected-content.ts; then
  if [ -n "$HITS" ]; then
    fail 'injected tier uses fetch'
    echo "$HITS"
  else
    pass 'no fetch in the injected tier'
  fi
fi

if [ "$FAILED" -ne 0 ]; then
  echo "stealth invariants: FAILED"
  exit 1
fi
echo "stealth invariants: all clear"
