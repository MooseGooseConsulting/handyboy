# Restyling / rescaling groundwork (Stylebot × Handyboy)

Date: 2026-10-23. Status: investigation, not a requirement change.
`REQUIREMENTS.md` is untouched. Open items at the bottom are questions, not decisions.

## 1. Goal in the user's words

Almost every site is designed for the phone: a skinny centered column on a wide
monitor. The user wants almost all of them rescaled wider, durably, without
hand-editing each one.

Stylebot (`ankit/stylebot`, MIT) already proves that loop: per-site CSS that
re-applies on every load, a visual picker + code editor, a page check on save
(match counts, readability, missed theme surfaces, fragile generated-class
selectors), version history, profiles, and an agent CLI + Claude plugin
(`open -> outline -> css-variables -> css get/set -> fix report -> screenshot
-> done`). That agent workflow is `tools/claude-plugin/skills/stylebot/
SKILL.md` and `docs/cli.md` in the Stylebot checkout at `/tmp/stylebot`.

## 2. What Handyboy already has (seams, no new plumbing yet)

| Need | Seam today |
|---|---|
| Where a style would be stored | `src/userscripts/catalog.ts` pattern (`local:userscripts` via `storage.defineItem`); styles have no equivalent yet — proposed `local:styles` in `src/styles/` (new) |
| How code reaches the page | `chrome.userScripts.execute()` in `USER_SCRIPT` world (`src/userscripts/runner.ts`), CSP-exempt, no `MAIN` world (invariant #4). CSS persistence must reuse this, not a new content-script surface |
| Read path (what constrains width) | `entrypoints/injected-content.ts` + `src/page/handler.ts` switch + `src/page/driver.ts` + `src/page/snapshot.ts` (zero DOM writes, no globals, no listeners). New read ops (`css-variables`, `page-rules`, `computed-styles`, `match-count`, width audit) extend this switch |
| Agent surface | `src/agent/tools.ts` (`PageTools` port, LangChain `tool()` wrappers) + `src/runtime/pageTools.ts` (real impl over driver/input). New Follower reads + `apply_style` go here |
| Read-only policy | `src/agent/policy.ts` (`allowedInReadOnly`, `isReadOnlyScript`). Style reads stay allowed; style writes join the blocked set alongside `write_userscript` |
| UI | `src/ui/sections/UserscriptsSection.tsx` + `SetupSection.tsx` + `src/ui/state/*`. Proposed `StylesSection.tsx` + a widen toggle/width control in setup |
| Wire protocol | `src/messaging/contract.ts` (`PanelToWorker` / `WorkerToPanel`, `RunEvent`). New `style.*` messages + `style.applied` event go here, never forked |
| Artifacts/logs | `host/` (`artifact.save`, run logs). Style saves reuse the artifact path the way `save_file` does |

## 3. Borrow wholesale (pure, tested, MIT — copy with attribution, keep tests)

Source paths are in the `/tmp/stylebot` checkout:

- `src/core/css/hashed-class.ts` — stable-part detection for generated classes
  (`Header_nav__a1B2c` → `Header_nav__`). Flags fragile selectors in the
  save-time page check. Port as a pure function; no Chrome APIs.
- `src/core/css/compile.ts` + `src/core/css/{declaration,import}.ts` + `src/core/
  saved-styles/force-important.ts` — store raw CSS, inject prepared CSS
  (strip `@import`s, optionally force `!important`). The store-vs-prepared split
  is the thing to keep; the background prepares on save, the page only injects.
- `src/core/css/{specificity,selector,get-subject-compound,shorthands}.ts` —
  selector helpers for the inspector's "prefer a selector the site already has
  rules for, list alternatives with match counts".
- `src/core/saved-styles/{profiles,equivalence,url}.ts` — named profiles per
  site (`Claude: Dark` pattern so agent work never overwrites the user's style),
  equivalence checks, per-host URL matching.
- `src/features/history/{api,store,profile-action}.ts` — undo (in-memory,
  per-gesture, dropped on close) vs version history (durable, one entry per
  editing session, restorable). Copy the distinction, not the storage backend.
- Agent loop text from `SKILL.md` + `docs/cli.md` + `docs/css.md` + `docs/editor.md`:
  always name tab/site/profile explicitly, build on `css get`, save whole file,
  fix the page-check report (match counts, unreadable text, missed theme
  surface), then `screenshot` + `outline` to verify. `hover` stays synthetic
  (page handlers run, `:hover` CSS does not — same caveat Handyboy's I-01 work
  already records).
- Readout semantics: `outline` line format (tag, id/classes, own `bg`, text
  snippet, `[color/font/family/bg]` deltas, spacing for repeated items),
  `css-variables` (palette tokens under `:root`/`body`), `page-rules` (site's
  own rules for a selector, first five, cross-origin counted not read).

## 4. Adapt to Handyboy style (idea yes, code no — stealth and architecture)

- Injection: Stylebot runs a standing content script + `<style>` in DOM +
  fan-out to open/late/nested shadow roots. Handyboy invariants
  (`scripts/check-invariants.sh` #1–3: no `web_accessible_resources`, no
  `externally_connectable`, no declared `content_scripts`) forbid that shape.
  CSS must ship through `src/userscripts/runner.ts`-style `USER_SCRIPT`
  execution (CSP-exempt by design, `messaging: true`, page cannot see the
  harness), never `MAIN` (#4), never `window.postMessage` (#5), never page-side
  storage writes (#6), no `fetch` in the injected tier (#7 — font/icon bytes
  travel via `src/host/fetch.ts` + background fetch like Stylebot's font
  workaround, not from the page).
- Editor: no second Vue app. The picker is Follower tools (`inspect`, `hover`,
  width audit) + a small React section. Stylebot's local/remote page-bridge
  split collapses into the existing driver/handler round trip.
- Host/CLI: no second `~/.stylebot/` socket host. Extend `src/messaging/
  contract.ts` + `host/bin/hb-*` CLIs and the existing native-messaging +
  artifact path.
- Sync: keep local-first per R-12/C-06. Stylebot's browser-sync backend is not
  the answer here.
- Readability presets: treat as bundled widen/readability presets under the
  existing bundled-script rails (`src/userscripts/examples.ts`, authoring
  rails for agent-written code), not as a second extension feature.

## 5. Rescale-specific slice (the pet peeve, smallest useful cut)

1. Reads (all pure DOM reads in the ISOLATED world, same stealth posture as
   `snapshot.ts`): viewport width, document/client widths of `body`/`main`/
   `article`/first large container, the `max-width` computed value that pins
   each, and which stylesheet rule set it (`page-rules` equivalent).
2. Widen preset (pure CSS generator, implemented now in `src/styles/widen.ts`):
   override the constraining `max-width` with a user-chosen page width
   (default ~1100–1400px), widen `body`/`main`/`article`/common container
   classes, keep `margin: 0 auto` centering, recolor nothing. Narrow selectors
   only — never bare `div`/`*` backgrounds (Stylebot rule, same reason).
3. Verify loop (agent, later): `apply_style` dry-run reports per-selector match
   counts + fragile-selector flags (hashed-class port) + contrast check; then
   screenshot + outline confirms the widen took and text is still readable.
4. Persist per host with profiles + history (later): `local:styles` keyed by
   host, one active profile per site, session-collapsed history entries.

## 6. Sequencing (proposed, not promised)

1. Pure groundwork (this doc + `src/styles/widen.ts` + `widen.test.ts`). No
   behavior change, no new permissions, invariants untouched.
2. Read ops: `css-variables`, `computed-styles`, `match-count`, width audit
   through `handler.ts` → `driver.ts` → `pageTools.ts` → Follower tools.
3. `local:styles` store + `USER_SCRIPT`-world CSS apply/remove + `style.*`
   contract messages + `style.applied` run event + read-only gating.
4. Panel `StylesSection` + widen preset UI + per-site profiles + history restore.
5. Agent widen loop + screenshot verify + host artifact for saved CSS.

## 7. Open — ask, do not decide

- O-a: does "rescale" also mean font-size/line-length growth, or width only?
  (Readability line-length caps argue for pairing width with `max-width: 70ch`
  on prose — Stylebot's readability feature does this.)
- O-b: per-site widths vs one global width with per-site exceptions?
- O-c: should the agent be allowed to widen autonomously across all sites, or
  only propose per-site widen CSS for the user to keep?
- O-d: closed shadow roots are unreachable to extensions (Stylebot docs) —
  accept the gap or investigate further?
- O-e: where do styles rank against userscripts when both target the same
  host (ordering, precedence, conflict display)?
- O-f: sync across browsers — wanted for styles, or local-only like the key
  posture (R-12/C-06)?

## 8. Groundwork implemented in this pass

- `src/styles/widen.ts`: pure widen-CSS builder + `validateStyleCss` (non-empty,
  64 KiB cap, balanced braces) + `isFragileSelector` (heuristic port of
  Stylebot's `hashed-class.ts` idea: hash-like segments, digit-among-letters,
  dashed hashes — credited in-file, MIT).
- `src/styles/widen.test.ts`: sentence-named proofs for the preset shape,
  the validator, and the fragile-selector detector.
- Nothing wired: no store, no contract change, no page-tier change, no UI.
  `pnpm typecheck` + targeted `vitest` are the evidence (see test names).
