# Exhaustive Stylebot inventory → Handyboy: every area, verdict, placement, and the case against it

Date: 2026-10-23. Investigation only. `REQUIREMENTS.md` unchanged. Verdicts:
**Borrow** = copy the logic (MIT, attribution, keep tests). **Adapt** = take the
idea, re-implement on Handyboy rails. **Skip** = deliberately not taking it, with
the reason. Every recommendation carries its own counter-case, because the user
asked for critiques against the recommendations too, not just for them.

Sources: `/tmp/stylebot` checkout (depth-1 clone, 723 files under `src/`).
Handyboy seams cited as `path` (extension root `/workspace/app`).

Groundwork already landed: `src/styles/widen.ts` + `widen.test.ts` (pure preset,
validator, fragile detector), `docs/research/stylebot-widen.md`,
`docs/research/restyle-proposal.md`, `docs/research/restyle-critique.md`.
Suite at last run: `pnpm vitest run` → 46 files / 137 tests passing; targeted
`src/styles/widen.test.ts` → 6 passing; `pnpm typecheck` clean; invariants 7/7.

## A. Styling engine (`src/core/css/*`) — the most borrowable part of the repo

A1. `compile.ts` (postcss parse, strip `@import`, optional force-important).
Verdict: **Borrow**. Placement: new `src/styles/prepare.ts`; page never parses
CSS, background/host prepares on save, caches beside raw. Case against: adds
postcss weight to the extension and a C-04 adoption read is owed before adding
any dependency; a hand-rolled `!important` inserter would be smaller but would
mis-handle nested rules, `@media`/`@supports`/`@container`, and `!important`-
invalid descriptors (`@font-face`, `@keyframes`) — which is exactly why borrowing
beats rewriting here.

A2. `declaration.ts` + `import.ts` + `force-important.ts` (saved-styles).
Verdict: **Borrow**. Same placement. Case against: per-style force-important
opt-out adds a setting the panel must explain; default-on changes user CSS
semantics silently. Keep the opt-out from day one.

A3. `hashed-class.ts` + `selector.ts` + `specificity.ts` + `shorthands.ts` +
`get-subject-compound.ts` + `filter.ts` + `rule.ts`. Verdict: **Borrow**
(hashed-class already seeded in `widen.ts` as `isFragileSelector`; graduate it to
`src/styles/fragile.ts` with the full partly-hashed/minified taxonomy from
`docs/selectors.md`). Placement: `src/styles/*` pure. Case against: the full
taxonomy (Emotion, StyleX, CSS Modules, Turbopack, NYT, Tailwind carve-outs) is
a living list that rots; a smaller detector has fewer false negatives to
maintain but more false "fragile" flags that annoy. Keep the table, keep it
tested, accept the maintenance.

A4. `font-family.ts` + `webfont.ts` + `to-hex-colors.ts` + `already-used-colors.ts`.
Verdict: **Borrow** the font-import helpers, **adapt** the rest. Placement:
font helpers in `src/styles/fonts.ts`; color-history UI has no Handyboy home
yet. Case against: fonts pull Google Fonts fetches into the loop — each new
family is a background fetch + cache entry + CSP edge. For the widen-first goal,
fonts are scope creep; take the import machinery, defer the picker.

A5. `docs/selectors.md` 11-step strategy (authored class → test-id → name →
authored part → ancestor scope → id → href/aria-label → hashed → ancestor class
→ tag chain → nth-of-type; "too broad" = bare div/span matching ≥50 and >half
the tag). Verdict: **Borrow the strategy, adapt the code** into the future
inspector (`finishCheck` + selector-alternatives pattern, below). Case against:
the "too broad" thresholds are tuned for styling; an acting agent may genuinely
want a broad container. Keep thresholds in the styling path only, never in the
acting snapshot path.

## B. Saved styles, profiles, history (`src/core/saved-styles/*`, `src/features/history/*`)

B1. `storage.ts` + `style-map.ts` + `url.ts` + `page.ts` (map keyed by URL/host,
`getStylesForPage`, default style). Verdict: **Adapt** (shape) — new
`local:styles` item in `src/styles/catalog.ts` mirroring
`src/userscripts/catalog.ts` (validation, `resolveStyle`, seed/updatedAt
discipline). Case against: URL-keyed map vs host-keyed records is a real
choice; URL keys fragment one site into many entries, host keys over-apply to
dissimilar pages. Start host-keyed (matches the widen goal), keep the matcher
on the shared `match-pattern.ts` grammar so the decision can be revisited.

B2. `profiles.ts` + `docs/profiles.md` (active profile CSS lives in `css`,
others in `profiles{}`, `activeProfile` names it; pre-profile clients still see
a working style; edits name their profile; switch is device-local, reaches all
tabs, resets undo; options can edit without applying; delete only when all
profiles blank). Verdict: **Borrow semantics, adapt storage**. Placement:
`src/styles/catalog.ts` + `contract.ts` types. Case against: profiles multiply
every later decision (history entries snapshot whole styles, sync merges per
profile, UI must pick a profile per save). The cheaper alternative — one
stylesheet per site, agent writes go to a `Claude: <look>` copy of the whole
style — is nearly as safe and far simpler. If profiles feel heavy, do named
whole-style copies first and add in-style profiles only when two profiles per
site is a real user request.

B3. `equivalence.ts` + `backup.ts`. Verdict: **Borrow** (whitespace/timestamp-
insensitive equality so reformats are not edits; backup export/import with
repair-before-use). Case against: import repair (drop nameless entries, discard
applied-profile CSS in favor of `css`) is code that only pays off once import
exists. Take equivalence now, defer backup format until export exists.

B4. `features/history/{api,store,profile-action}.ts` (undo = in-memory per
gesture, dropped on close; history = durable, one entry per editing session;
undo never writes history; switch resets undo; restore brings whole style).
Verdict: **Borrow the distinction, adapt the backend** (`src/styles/history.ts`
over local-durable storage, not session — unlike the runlog ring in
`src/runtime/durability.ts`, cap 5, session-scoped, which is correct for runs
and wrong for styles). Case against: session-collapsing hides intermediate
steps the user may want back; per-gesture undo history is already gone at close
by design. That is the documented trade-off; keep it, and say it in the UI
("restore brings back the whole style as of Tuesday").

## C. Page application (`src/apps/content/*`, `src/core/stylesheets/*`)

C1. `content-script.ts` (inject compiled CSS at document start; localStorage
cache applied synchronously before `chrome.storage` resolves; `hide-page.ts`
`visibility:hidden` + 150ms reveal-timeout race; `page-state.ts`
get/apply/save; `reapplySavedStyles` on change). Verdict: **Adapt heavily**.
Handyboy cannot take the vehicle (standing content script, DOM `<style>`,
page-side localStorage) — invariants #1–3, #6 forbid it. Take the *timing
pattern*: synchronously-available cache first (else hide-then-reveal flash),
async fresh state second, idempotent reapply that also removes what is no
longer enabled. Placement: `src/styles/apply.ts` over the `runner.ts`
`USER_SCRIPT` rail + a re-apply hook where `driver.ts` invalidates after
navigation. Case against: `USER_SCRIPT`-world CSS injection has no proven
first-paint story equivalent to a document-start content script; FOUC
(skinny-then-wide flash) may be worse, and hiding the page to avoid it is
itself a visible tell on every load. Measure first paint with and without the
preset before promising "instant".

C2. `shadow-roots.ts` (mirror every stylesheet into every open shadow root via
adoptedStyleSheets/constructable fallback; observe later-attached, late-defined,
nested roots; skip own host IDs; closed roots unreachable). Verdict: **Adapt**
the traversal, **inherit the limitation**. Case against: fan-out multiplies
injection cost per root and still misses closed roots — the widen check must
report "N shadow hosts unreachable" rather than letting screenshots confuse.
Also note Handyboy already has `shadowRootOf` + `openOrClosedShadowRoot`
feature-detection in `snapshot.ts`; the two traversals should share one
helper, not grow two.

C3. `cache.ts` + `import-cache.ts` + `font-cache.ts` + `blocked-fonts.ts`
(version-stamped caches; import bytes fetched by background so page CSP never
blocks; blocked Google-Font files fetched by background and registered from
bytes; per-file only-what-was-blocked handling; drop files no import loads).
Verdict: **Adapt** (background/host fetch + version-stamped cache beside the
raw). Placement: fetch via `src/host/fetch.ts`, never the injected tier
(invariant #7). Case against: three caches + version stamps is real state to
corrupt; a corrupt cache shows the wrong page with no error. Keep the version
stamp and a one-click "rebuild style caches" path from day one, or the first
corruption report will be undebuggable.

C4. `stylesheet.ts` + `inject-style.ts` (one constructed sheet shared per root,
fallback `<style>`; prepare-then-inject so slow import fetch never blocks the
rest). Verdict: **Adapt** the ordering guarantee. Case against: constructable
sheets in `USER_SCRIPT` world need proving; if they are unavailable, every root
gets a `<style>` element and the "no DOM writes" posture needs re-examination
for the styling path specifically (a style element *is* the feature, but it is
page-observable — record that as an accepted, user-visible consequence, not a
stealth regression discovered later).

## D. Editor UI (`src/apps/editor/*`, `src/ui/*`, `src/apps/popup/*`, `src/apps/options/*`)

D1. Basic editor (property cards: text/colors/layout/effects/more), code editor
(Monaco in iframe, autocomplete, swatches), eyedropper, presets (grayscale,
readability), undo/redo per gesture with collapse of rapid changes, header with
profile switch, resizer, shortcuts, dock positions (page / window / side panel).
Verdict: **Do not port the app. Take three ideas**: (a) grouped property cards
map cleanly onto a future `StylesSection` (text/colors/layout/effects/more);
(b) Monaco-iframe isolation for the code editor is the right answer if the
panel editor grows; (c) presets as bundled one-click stylesheets. Everything
else (Vue app, loaders, window management, dock positions) has no Handyboy home
— the panel is React (`src/ui/sections/*`) and the picker is Follower tools,
not a second runtime. Case against even the three ideas: each one is a project
(a11y of the cards, iframe plumbing, preset curation). For the widen goal only
(c) is load-bearing; (a) and (b) wait until free-form CSS editing is requested.

D2. `features/highlighter/*` (inspector overlay, keyboard climb/descend/pick,
whole-page guard, composed-path retargeting across shadow hosts). Verdict:
**Adapt as a Follower tool, not a UI overlay** — `inspect` returns the picked
selector + alternatives with match counts; no overlay is drawn (screenshots
stay clean, snapshot's zero-DOM-write rule holds). Case against: without a
visible highlight the user cannot see what the agent picked; the screenshot +
outline verify loop is the substitute, and it is weaker for "that box, there".
Accept, and keep a human picker (click-to-pick in the panel, highlight only
while picking) as the explicitly deferred alternative.

D3. Popup (per-site toggle, profile list, readability, sync state, rating
prompts) + options tabs (basics/history/navigation/site/styles/sync) + side
panel hosting (`features/side-panel`, permission dance, Vivaldi/Arc exclusions,
Chrome crash-on-grant reload ordering). Verdict: **Adapt the information
architecture, skip the machinery**. Placement: one `StylesSection` (list,
editor, toggle, width control, profiles, history restore) + setup additions
(default width, force-important default) + runlog `style.applied` card + filter.
Case against: stuffing everything into the existing side panel crowds the
primary surface (R-05); an options-tab split is the eventual answer but doubles
the UI to maintain. Start in-panel, split when it hurts.

D4. `features/monaco-editor/*` + `apps/monaco-iframe/*` (themes, model history
preservation when panel pushes CSS down as undoable edit). Verdict: **Skip
until the panel edits CSS**. Case against skipping: a textarea editor
(`UserscriptsSection.tsx` today) is a poor CSS surface and will generate
support load the moment styles ship. Mitigation: ship the widen preset +
profiles + history *before* free-form CSS editing, so the first version needs
no code editor at all.

## E. Reads and diagnostics (`src/features/page-bridge/*`, `src/apps/cli-inspector/*`)

E1. `page-reading/{page-outline,css-variables,page-css,page-signals,
count-matches,state-pseudos}` + `applied-declarations` + `effective-
declarations` + `computed-styles` + `page-colors` + `selector-alternatives` +
`style-check/*`. Verdict: **Borrow semantics, re-implement as page-tier ops**.
Placement: `src/page/widthAudit.ts` (new, pure read, snapshot-grade stealth) →
`handler.ts` switch → `driver.ts` → `pageTools.ts` → Follower tools in
`src/agent/tools.ts`; read-only-allowed in `policy.ts`. Case against: each new
op is new page code under the invariants microscope (no writes, no globals, no
listeners, no fetch) plus new token budget (the snapshot budget lesson:
`DEFAULT_MAX_NODES = 900`, eBay 553 nodes, history trim at 3 turns after 285k
tokens hit a 262k model — aggregate reads to per-rule rows, never per-node
dumps). Also `hover` stays out of the read set (it moves the pointer; `policy.ts`
already blocks it read-only) — hover-gated menus are diagnosed from CSS, not
by hovering.

E2. `inspect-page.ts` (`finishCheck`: reapply, then match counts + style
problems + fragile selectors) + `pointer.ts` (synthetic hover, x/y inspect,
prefer-site-rules + alternatives with counts, no clicks, no drawing).
Verdict: **Borrow the flow**. Case against: the reapply-then-check race
(background reapply may not have landed) is handled by awaiting reapply in
Stylebot; Handyboy's equivalent must await its own apply path or the check
lies. Write the test for that race before the feature.

E3. Outline line format (tag/id/classes/`[bgcolor]`/text snippet + `[bg/bg-
image/color/font/family]` deltas + spacing for repeated items + `(page)` root
line; `suggestions` = two fitting + one creative). Verdict: **Borrow the format
for styling reads only**, not for the acting snapshot. Case against: two
outline formats (acting snapshot vs styling outline) confuse the model and
double maintenance. Keep them separate but documented: snapshot answers "what
can I click", outline answers "what constrains layout".

## F. CLI (`tools/cli/*`: pages, inspect, pointer, styles, profiles, install, host, protocol, diagnose, style)

F1. Commands (`open` in its own unfocused window reusing the tab; `tabs`;
`outline`; `screenshot` with hidden-tab capture + restore; `css get/set`
(refuse unparseable with line number, Google-Font imports, stable-part saving,
per-selector page check, deletion on empty); `profile create/use/rename/
delete`; `--profile` always; `--json`; per-command help; `done` closes the
CLI window). Verdict: **Adapt the command *meanings* onto Handyboy's existing
surface** (`host/bin/hb-*` + panel), not the CLI itself — no second host, no
`~/.stylebot/` socket. Case against: `hb-*` today drives one run on the
user's tab; a Stylebot-style read loop wants tab/site/profile naming and a
background window precisely to avoid stealing focus (defect #4 in the
critique). Bolting that onto `hb-run` without a background-window story
repeats the focus-stealing problem. Decide the tab story first (R-01 is
canonical — this needs user direction, not a quiet change).

F2. `install.mjs` + `register.mjs` + `paths.mjs` (per-browser host manifests,
dev-profile registration, `STYLEBOT_SOCKET` second-browser isolation,
checklist output, timestamp-based "setting is off" diagnosis, version pinning,
Windows named pipes). Verdict: **Skip the machinery; borrow the diagnostics
UX** (one fix named per failure; `install` prints a checklist). Case against:
Handyboy's host registration already works (`host/install.sh`, pinned key);
duplicating per-browser registration invites drift. Take only the error-copy
discipline.

F3. `protocol.mjs` (CLI/extension protocol numbers must match; refusal names
which side to update; host copy re-copied on CLI change; repin on node change).
Verdict: **Borrow the discipline** for the future `style.*` contract growth
(never break the wire silently; `contract.ts` is extended, not forked).
Case against: version negotiation is machinery for a shipped two-sided
protocol; Handyboy's panel/worker/host ship together, so a protocol number
today is ceremony. Keep the *habit* (additive changes, explicit refusal
messages) without the version-number apparatus until the sides can actually
drift.

F4. `diagnose.mjs` + `style.mjs` (page-check implementation: match counts,
unreadable text, missed theme surfaces, generated-class flags) + `style.test`.
Verdict: **Borrow**. Placement: `src/styles/check.ts` pure + `pageTools.ts`
result string. Case against: contrast/readability thresholds encode taste
(4.5 contrast, `75ch` prose); a widen that the check flags as "unreadable"
will be reverted by a literal-minded Follower even when the user likes it.
Make thresholds constants with names, surface them in the report, and let the
run continue with a warning rather than a refusal where judgment is involved.

## G. Agent plugin (`tools/claude-plugin/skills/stylebot/SKILL.md`)

G1. The workflow (open → suggestions-or-ask → profiles (`profiles` list,
`--profile` always, `Claude: <look>` new vs update-in-place rules) → read
(outline, variables, `css get`, hover-then-reread, inspect-at-x/y) → write file
under `~/.stylebot/work/`, `css set --file` whole-stylesheet replace →
fix-the-report → screenshot + outline → `done` → two-sentence report, no pasted
CSS; one `stylebot` per Bash call; empty CSS deletes after confirm; never style
from another tool's screenshot). Verdict: **Borrow the workflow text
structure, rewrite for Handyboy tools** (future agent skill doc). Case against:
the skill is long because the CLI is stateless per call; Handyboy's Follower
holds context across turns, so a verbatim port would over-instruct and burn
tokens on the weak Follower. Distill to tool descriptions + a short skill,
and prove the wording against `nemotron-3.5-lightning` (the repo's own rule:
fix tooling first, paid models only after asking).

G2. Safety rails inside the skill (never rely on active tab; pre-approved
`stylebot` + workdir only; work files always whole stylesheets; confirm before
deleting user styles; `use` switches only with consent when the user switched
mid-run). Verdict: **Borrow all of it** — it maps directly onto the start-URL-
filtered catalog discipline (`runManager.ts` deliberately shows less) and the
agent/user authorship split (`authoring.ts`, `catalog.ts` `requireAuthor`).
Case against: none material; this is the cheapest safety in the whole
inventory. The only risk is skill-rot (docs drifting from tools), mitigated by
testing the skill text in evals (below), not by reviewing it.

## H. Readability (`src/features/readability/*`, `src/apps/reader/*`)

H1. Eligibility (URL pre-check: http(s) only, not home, not section stubs, app-
site denylist; post-load MediaWiki-main check; content score: paragraphs/pre/
article/br-divs, furniture exclusion, 140-char blocks, sqrt scoring, threshold
20; per-shape learning in page localStorage: fail-once, known-shape loader,
unknown-shape silent try; retry 300/600/1200ms for client-rendered pages).
Verdict: **Borrow eligibility + retry schedule, adapt the vehicle** (reader
bundle + shadow-DOM swap + document cache + loader cannot transfer as-is;
page-localStorage learning violates invariant #6 — keep learning in extension
storage or drop it). Case against: readability is a second feature wearing a
widen coat; the widen goal needs none of the reader, and eligibility tuning
(Firefox-reader-derived thresholds) is a rabbit hole. Take only the article-
detection score for "should this host default to a prose cap", and only if the
widen preset needs it.

H2. `theme-colors.ts` + reader themes + loading screen (loader themed to reader,
covers until extraction, no flash). Verdict: **Skip the reader; borrow the
no-flash lesson** (themed cover before first paint — same sentence as C1's
timing pattern). Case against: any page-cover is user-visible on every load;
for widening it is probably unjustified. Default to no cover; add it only if
FOUC measures badly.

## I. Sync, backup, i18n, settings (`src/features/sync/*`, `apps/background/sync*.ts`, `core/settings/*`, `core/i18n/*`, `apps/options/backup.ts`)

I1. Drive sync (single-file backup, base-copy merge, per-URL union with
newest-wins fallback, line diff3 with conflict-as-comment never markers,
revision-equality skip, re-read-before-upload, record-base-last, `chrome.alarms`
schedule, silent-refresh-token auth, per-profile applied-profile stays local,
older-client repair). Verdict: **Skip the backend; borrow two rules**: (a) never
emit conflict markers into injected CSS (comment, list for review); (b) applied-
profile/switch state stays local. Case against sync at all: it is the largest
correctness surface in Stylebot (base discipline, clock-free equality, upload
races) and Handyboy's posture is local-first (R-12/C-06). Sync is explicitly
deferred until styles exist and users ask for browsers to agree.

I2. Settings schema + defaults (mode, layout/width/dock, fonts list,
color-history, CLI-access toggle, command shortcuts) + `_locales` (14+ locales,
validate-locales script). Verdict: **Adapt the shape** (`Config` additions:
default width, force-important default; `useConfig` + setup UI), **defer
locales**. Case against: every setting is UI + docs + migration; the setup
panel is already the most careful surface (paid-model warnings, training-risk
flags). Add exactly two settings (default width, force-important), nothing else.

## J. Infra worth envying (`e2e/*`, `evals/styling/*`, `.storybook/*`, `scripts/*`)

J1. Playwright e2e (real unpacked extension via CDP, per-engine shims,
fixtures, headed/headless/ui/debug, `--no-build`). Verdict: **Adapt the
pattern** — Handyboy has `scripts/e2e.sh` + harness already; add styling e2e
(real page + widen CSS + screenshot + readability assertions) when the apply
path exists. Case against: e2e is slow and flakes; keep it to the styling
proof path, not the whole matrix.

J2. `evals/styling` (recorded pages replayed, base-vs-head Claude sessions,
reference stylesheets, page-measured checks, cost/turn accounting, no model
judge after it proved coin-flip). Verdict: **Adapt when the agent loop
exists** — reference widen CSS per recorded page + checks (width used,
contrast, zero-match selectors). Case against: each case costs minutes and
real money on the user's key; run `--references` (seconds, no agent) in CI
and full evals before PRs only.

J3. Storybook interaction tests + jest unit tests + tier-import lint + side-
effects discipline + capture scripts. Verdict: **Borrow habits selectively**:
interaction stories for the future `StylesSection`, keep the tier-import idea
in mind (Handyboy's equivalent is the invariants script — extend its scanned
paths instead of adding a new lint system). Case against: Storybook is a stack
Handyboy does not have (React vs Vue 2, WXT vs webpack); do not import the
stack to get the habit.

## K. What is explicitly not coming over (with reasons)

K1. Standing content scripts, `web_accessible_resources`,
`externally_connectable` — invariant bans, enumerable surfaces (R-02).
K2. `MAIN`-world execution, `postMessage`/CustomEvent bridges, page-side
storage writes, injected-tier `fetch` — invariant bans #4–7, each a named
detection family in the repo's own research.
K3. Vue editor app, pop-out window management, dock positions, side-panel
permission dance — wrong stack, and the panel + Follower tools cover it.
K4. Second native host / socket / Windows pipes — Handyboy's host already
exists; one daemon, one channel.
K5. Browser-sync backend, Google Drive OAuth, `unlimitedStorage` base copies —
deferred by posture, not by difficulty.
K6. The reader bundle, document swap, loader themes — a second feature.
K7. `debugger`-attached anything for styling — styling needs no trusted input,
which is why this whole project dodges I-01 instead of relitigating it.

## L. Recommendations (each with the case against — as requested)

R1. Land reads first (width audit + css-variables/computed/page-rules/match-
count). For: diagnosis before mutation; all read-only-allowed; no storage
decisions. Against: reads without writes demo poorly and invite scope creep
into a full inspector; time-box to the five reads the widen check needs.
R2. Then store + apply/remove + re-apply-on-navigation. For: persistence is
the feature. Against: re-apply timing (first paint, FOUC, ordering vs
userscripts) is the hardest unknown — spike it behind a flag before promising.
R3. Then prepare + fragile + page check. For: deterministic quality gate the
weak Follower can actually use. Against: postcss dependency + threshold taste;
keep thresholds named constants and warnings-not-refusals where judgment lives.
R4. Then panel section + profiles + history. For: the boss needs the controls.
Against: profiles multiply everything; start with named whole-style copies
(`Claude: <look>`) and add in-style profiles only on request.
R5. Then agent widen loop + screenshot verify + host artifact. For: the actual
pet peeve at scale. Against: single-tab model (R-01) means the sweep disturbs
the user; resolve the tab story (background window? one-at-a-time with consent?)
before automating dozens of sites.
R6. Throughout: no new behavior without the sentence-named test, no page-tier
change without the invariants green, no eval claim without the screenshot.
Against: this slows the demo. It is also the repo's own rule (evidence before
synthesis, CLAUDE.md), so the slowness is the point.

## M. Open — ask, do not decide (consolidated)

Width only or width+type? Global width or per-site? Autonomous sweep or
propose-per-site? Closed-shadow gap accept or investigate? Styles-vs-userscripts
precedence? Sync ever? `.css` in `save_file` or separate path? Tab story for
sweeps (R-01)? Reader ever, or never? Postcss adoption (C-04) now or later?
