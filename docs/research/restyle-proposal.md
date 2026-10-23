# Restyle proposal: what goes into Handyboy and why

Date: 2026-10-23. Investigation only. `REQUIREMENTS.md` is not changed by this
file. Sequencing is proposed, not promised. Open questions are at the bottom —
they are asked, not decided.

Evidence: Stylebot checkout at `/tmp/stylebot` (`docs/cli.md`, `docs/css.md`,
`docs/editor.md`, `tools/claude-plugin/skills/stylebot/SKILL.md`,
`src/core/css/*`, `src/core/saved-styles/*`, `src/features/history/*`).
Handyboy seams: `src/userscripts/catalog.ts` + `runner.ts`, `src/page/
handler.ts` + `driver.ts` + `snapshot.ts`, `src/agent/tools.ts` + `policy.ts`,
`src/runtime/pageTools.ts` + `runManager.ts` + `durability.ts`,
`src/messaging/contract.ts`, `src/ui/sections/*`, `host/` + `docs/
host-protocol.md`. Suite state: `pnpm vitest run` → 46 files, 137 tests, all
passing (run 2026-10-23).

## 0. The job to be done

Skinny phone-first layouts on a wide monitor. The fix is durable per-site CSS
(widen the constraining `max-width`, keep centering, touch up prose
line-length), applied on every load, verified by screenshot, reversible in one
click. The agent's role is to do that across dozens of sites, not to hand-edit
one.

## 1. What to build (each item: what, why, where)

### 1a. `local:styles` store + profiles (Stylebot `saved-styles`, adapted)

What: per-host CSS records `{ host, css, updatedAt, enabled, profile }` with
named profiles per site (active profile + `Claude: <look>` agent profiles),
equivalence checks, host matching on the existing match-pattern grammar.

Why: Handyboy persists JS (`local:userscripts`) but has no durable CSS. Without
this every widen dies on reload. Profiles are what let agent experiments never
overwrite the user's own style — Stylebot's cheapest safety idea.

Where: new `src/styles/catalog.ts` mirroring `src/userscripts/catalog.ts`
(storage item, validation, `resolveStyle`); types in `src/messaging/contract.ts`
next to `Userscript`; no contract fork.

### 1b. Prepared-CSS split (Stylebot `compile` + `force-important`, ported)

What: store raw CSS, inject prepared CSS. Preparation strips `@import`s for
background fetch, optionally forces `!important` per style (opt-out preserved).

Why: raw is what the user edits and history restores; prepared is what wins
specificity wars without the user hand-writing `!important` everywhere.
Stylebot's split is the reason its editor preview matches what loads.

Where: pure `src/styles/prepare.ts` (postcss is already the natural tool —
Stylebot uses it; adding it here is a new dependency and needs a C-04
adoption read before commit). Page never parses CSS; background/host prepares
on save and caches alongside the raw.

### 1c. Fragile-selector detector (Stylebot `hashed-class`, ported)

What: pure `isFragileSelector()` flagging generated classes (hash segments,
digit-among-letters, dashed hashes, leading hashes), with stable-part saving
(`Header_nav__a1B2c` → `Header_nav__`).

Why: agent-written selectors built on build hashes break on the next deploy.
This is the save-time warning that catches it, same as Stylebot's page check.

Where: `src/styles/fragile.ts` (groundwork version lands in `widen.ts` now,
moves here when the module grows). No Chrome APIs.

### 1d. Width-audit + CSS reads (Stylebot CLI reads, re-implemented read-only)

What: `css-variables`, `computed-styles`, `page-rules`, `match-count`, plus a
width audit (viewport width, `body`/`main`/`article`/largest container widths,
the computed `max-width` pinning each, which rule set it).

Why: the snapshot tells the Follower what to click, not what constrains width.
These are the reads that turn "this looks skinny" into "rule X on selector Y
pins `main` to 640px". All are synchronous DOM reads — same stealth posture as
`snapshot.ts` (no writes, no globals, no listeners).

Where: `src/page/widthAudit.ts` (new, pure read) → `handler.ts` switch →
`driver.ts` → `pageTools.ts` → Follower tools in `src/agent/tools.ts`. Allowed
in read-only runs (`policy.ts`): reads stay, writes join the blocked set.

### 1e. `USER_SCRIPT`-world CSS apply/remove (Stylebot injection, re-pathed)

What: apply prepared CSS for the host's active profile after every navigation
and on toggle; remove on disable. No standing content scripts, no `<style>` in
`MAIN`, no `postMessage` bridge, no page-side storage.

Why: Stylebot's standing content-script + shadow-root fan-out violates
`scripts/check-invariants.sh` #1–3 and the no-DOM-write posture. `USER_SCRIPT`
execution is CSP-exempt and invisible to the page — the existing
`src/userscripts/runner.ts` path — so CSS rides the same rail JS already uses.

Where: `src/styles/apply.ts` + runner reuse; re-apply hook where the driver
invalidates after navigation (`pageTools.ts` / `runManager.ts` navigation
path). Closed shadow roots stay unreachable (Stylebot limitation, inherited).

### 1f. Save-time page check + agent verify loop (Stylebot `css set` + SKILL.md)

What: on save, report per-selector match counts, unreadable-text hits, missed
theme surfaces, fragile selectors — then screenshot + outline to confirm the
widen took and text still reads. Empty CSS deletes the style (confirm first for
user-made styles, per Stylebot).

Why: this is what makes agent-written CSS trustworthy without a human
eyeballing every site. The check is deterministic; the screenshot is the proof.

Where: check logic in `src/styles/check.ts` (pure, over audit results);
`apply_style` result string in `pageTools.ts`; workflow text adapted from
`SKILL.md` into Follower tool descriptions + a future agent skill doc. Always
pass tab/site/profile explicitly — never rely on "active".

### 1g. Panel: `StylesSection` + widen control (Stylebot editor, not ported)

What: style list per host, CSS editor, enable toggle, width slider/preset
button, profile switcher, history restore, before/after screenshot compare.

Why: the side panel is the boss (R-05). Userscripts already have this shape
(`UserscriptsSection.tsx`); styles get the sibling, not a second Vue app.
No live-typing preview until the apply path exists — preview without the real
path lies.

Where: `src/ui/sections/StylesSection.tsx` + setup widen defaults in
`SetupSection.tsx` + `useConfig` + `contract.ts` `style.*` messages +
`style.applied` run event (R-07) next to `file.saved`.

### 1h. History (Stylebot `features/history`, semantics only)

What: undo = in-memory, per-gesture, dropped on close. History = durable,
one entry per editing session, restorable. Undo never writes history entries.

Why: widening is destructive-looking until verified. Session-collapsed history
is what lets a user recover from last Tuesday without scrolling an undo stack.

Where: `src/styles/history.ts` over the styles store; panel restore button.
Durable (local), not session — unlike the runlog ring (`durability.ts`, cap 5,
session scope), styles must survive restarts.

## 2. What NOT to take

- Standing content scripts, `web_accessible_resources`,
  `externally_connectable` — banned by invariants #1–3.
- `MAIN`-world execution, `postMessage` bridges, page-side storage — banned by
  invariants #4–6.
- Second native host / `~/.stylebot/` socket — extend `host/` + `hb-*` CLIs.
- Browser-sync backend — keep local-first (R-12/C-06 posture).
- The Vue editor app — Follower tools + React section instead.
- `debugger`-attached inspection for styling — styling needs no trusted input,
  which is precisely why it dodges the whole I-01 banner problem.

## 3. Sequencing

1. Pure groundwork (this doc + critique + `src/styles/widen.ts` + tests). No
   behavior change. Evidence: `pnpm typecheck`, targeted `vitest`, invariants.
2. Read ops (1d). Agent can diagnose width but changes nothing.
3. Store + apply/remove + contract + read-only gating (1a, 1e).
4. Prepare + fragile + page check (1b, 1c, 1f-check half).
5. Panel section + profiles + history (1g, 1h).
6. Agent widen loop + screenshot verify + host artifact for saved CSS (1f-loop).

Each step keeps invariants green and the suite passing; any step that cannot
holds the line stops and is reported as blocked with the reason.

## 4. Open — ask, do not decide

- Width only, or width + font/line-length (`70ch` prose cap)?
- One global width with per-site exceptions, or per-site widths?
- Agent widens autonomously everywhere vs proposes per-site CSS to keep?
- Closed-shadow-root gap: accept or investigate?
- Styles-vs-userscripts precedence on the same host?
- Sync styles across browsers, or local-only?
- `.css` in `save_file`'s filename contract (today json/txt/csv only)?
