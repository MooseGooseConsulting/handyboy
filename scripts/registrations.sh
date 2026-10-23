# Where Chrome loads Handyboy from. Sourced by live.sh and e2e.sh, which both run from
# the repo root and set CHROME_DIR (the browser's config dir) before calling these.

# Same derivation as host/install.sh: the manifest key pins the id across rebuilds.
ext_id() {
  grep -oE "'MII[A-Za-z0-9+/=]+'" wxt.config.ts | head -n1 | tr -d "'" \
    | base64 -d | sha256sum | head -c 32 | tr '0-9a-f' 'a-p'
}

# "<profile>\t<path>\t<user_scripts_enabled>" for every profile that has the extension.
# Chrome rewrites Preferences lazily, so this can lag a click in chrome://extensions.
# A profile whose Preferences cannot be read or parsed is not in the list at all; it is
# unknown rather than unregistered, so it gets a NOTE on stderr instead (see below).
registrations() {
  python3 -I - "$CHROME_DIR" "$(ext_id)" <<'PY'
import glob, json, os, sys
root, ext = sys.argv[1], sys.argv[2]
for prefs in sorted(glob.glob(os.path.join(root, '*', 'Preferences'))):
    try:
        data = json.load(open(prefs))
    except Exception:
        # Unreadable or malformed on disk is unknown, not unregistered: this
        # profile may still load a build the sync check cannot vouch for, so
        # dropping it silently would weaken e2e's "every profile loads this
        # build" gate. Chrome resets a malformed Preferences on its next start,
        # so this is rare; note it, as unsynced_registrations notes dead dirs.
        print(f"NOTE: {prefs} is unreadable or malformed; that profile's build was not checked", file=sys.stderr)
        continue
    try:
        s = data['extensions']['settings'][ext]
    except Exception:
        continue  # parses fine without this extension: genuinely unregistered
    print(f"{os.path.basename(os.path.dirname(prefs))}\t{s.get('path', '')}\t{s.get('user_scripts_enabled', False)}")
PY
}

# "<profile>\t<path>" for every registration whose directory holds a build other than $1.
# chrome.runtime.reload() re-reads the directory "Load unpacked" pointed at, so such a
# profile would come back running that directory's code, not this build. A directory with
# no manifest (a deleted worktree) loads nothing at all, so it is only noted on stderr.
# _metadata is Chrome's own bookkeeping inside an extension directory; wxt never writes it.
unsynced_registrations() {
  local build="$1" profile path us
  while IFS=$'\t' read -r profile path us; do
    [ -n "$profile" ] || continue
    [ "$path" = "$build" ] && continue
    if [ ! -f "$path/manifest.json" ]; then
      echo "NOTE: Chrome profile \"$profile\" registers Handyboy from $path, which holds no build; it cannot load" >&2
      continue
    fi
    diff -rq --exclude=_metadata "$build" "$path" >/dev/null 2>&1 || printf '%s\t%s\n' "$profile" "$path"
  done <<<"$(registrations)"
}
