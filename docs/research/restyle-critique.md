# Handyboy critique: defects and risks, with the rescale goal in mind

Date: 2026-10-23. Investigation only. Nothing here changes `REQUIREMENTS.md`.
Each section names the file, the defect, and why it matters for durable
rescaling (or for the bot generally). Suite state at write time: `pnpm vitest
run` → 46 files / 137 tests passing; `scripts/check-invariants.sh` is the
stealth gate (7 rules, all relevant below). Extended in
`restyle-exhaustive.md` (§L pairs every recommendation with the case against
it, §K lists what is explicitly not coming over and why).

## 1. Missing capability (the gap Stylebot exposes)

1. **No durable styles.** `src/userscripts/catalog.ts` persists JS; nothing
   persists CSS. Every widen dies on reload. There is no `local:styles`, no
   re-apply after `navigate`, no prepared-cache, no profiles, no history.
2. **No layout reads.** `src/page/snapshot.ts` emits an a11y tree with refs —
   what to click, not what constrains width. No computed `max-width`, no
   palette tokens, no owning-rule lookup, no match counts. A widen agent today
   is blind to the exact thing it must change.
3. **No verify loop for restyling.** `save_file` writes json/txt/csv
   (`validateSaveFilename` in `src/agent/tools.ts` rejects `.css`), and there
   is no save-time page check (match counts, readability, missed surfaces,
   fragile selectors) and no before/after compare. Stylebot's `css set` report
   + screenshot is the missing proof step.
4. **Single active tab only** (`src/runtime/runManager.ts`, R-01). Widening
   dozens of sites hijacks the tab the user is watching; screenshots and
   navigation disturb the user. Stylebot's CLI uses its own background window
   for exactly this reason. At minimum the panel must say "this will drive
   your tab" before a widen run, or runs need a background-window option (open
   question — tab model is R-01, so this needs user direction, not a quiet
   change).
5. **One run at a time** (`runManager.ts`). No queue, no background widen
   sweep. Fine today; a "rescale all my sites" goal will hit it immediately.

## 2. Correctness risks in the existing path

6. **Refs are single-snapshot** (`snapshot.ts`: table rebuilt per call, `eNN`
   restarts, stale refs resolve to null). Anything that snapshots, then reads
   layout, then acts across two observations must re-snapshot or fail with
   "unknown or stale ref". The width-audit reads must therefore be atomic with
   the snapshot they describe, or carry their own selectors — not refs.
7. **Snapshot budget is interaction-shaped** (`DEFAULT_MAX_NODES = 900`,
   tuned against an eBay fixture). A 60-listing page is ~553 nodes and ~17k
   tokens (`graph.ts` comment); `FOLLOWER_HISTORY_TURNS = 3` exists because
   history otherwise hit 285k tokens against a 262k model. Layout reads that
   dump computed styles per node will blow the same budget unless they are
   aggregated (one row per constraining rule, not per node).
8. **`approxTokens` is chars/4** (`snapshot.ts`). Good enough for budgeting,
   wrong for billing or for tight contexts. Do not build cost UI on it.
9. **Closed shadow roots are opaque** (`shadowRootOf` falls back to open
   roots). Widen CSS will silently not reach web-component internals — same
   gap Stylebot documents. Must be surfaced in the page check ("N shadow hosts
   unreachable"), not discovered by confused screenshot diffs.
10. **FOUC / ordering unspecified.** Nothing re-applies anything after
    `driver.invalidate` on navigation. When styles land, they must inject
    early enough that the user does not see skinny-then-wide on every load,
    and ordering vs page CSS + userscript DOM writes must be defined (this is
    the styles-vs-userscripts precedence question in the proposal).
11. **`isReadOnlyScript` is regex-advisory** (`policy.ts` says so itself).
    Fine for its purpose, but a style-write gate must not copy that shape and
    call it a guarantee. Styles are lower-risk than JS (no `fetch-POST` by
    construction if `url()` is restricted), which is an argument for gating on
    syntax (parsed CSS, no external URLs except background-fetched fonts),
    not on regexes.

## 3. Stealth posture: strong, but the new work must not crack it

12. The seven invariants are the right shape and they pass. The risk is
    novelty: every new page op is a chance to add a DOM write, a global, a
    listener, a `fetch` in the injected tier, or a `MAIN`-world shortcut.
    Width audit and CSS apply must live under the same rules as `snapshot.ts`
    (zero writes, no globals, no timers) and reuse the `USER_SCRIPT` rail, or
    R-02 regresses silently. CI already enforces it — keep it that way and
    add the new files to the scanned paths if they are not covered.
13. Font handling is the known trap: page-fetched font bytes hit page CSP
    (Firefox blocks under `default-src 'self'`; Stylebot docs note this).
    Fonts must travel via background/host fetch (`src/host/fetch.ts`), never
    from the injected tier (invariant #7 bans it anyway).

## 4. Agent and tooling gaps

14. **Follower tools describe actions, not page CSS.** No `computed-styles`,
    no `page-rules`, no `match-count`, no width audit. The free Follower
    (`nemotron-3.5-lightning`) will do better with deterministic narrow tools
    than with a bigger model — the repo's own rule ("fix the tooling first",
    `CLAUDE.md`) applies directly here.
15. **`hover` is blocked in read-only runs** (`policy.ts`) because it moves the
    pointer. A width audit must not need hover — keep it a pure read so
    diagnosis stays available in the safest mode.
16. **`list_userscripts` is start-URL-filtered** (`runManager.ts`: agent's own
    + user's matching the starting tab, deliberately not the whole catalog, to
    avoid "go run that bank script" via `navigate`). Styles need the same
    treatment from day one: the agent sees the current host's styles, not the
    vault.
17. **Authoring rails assume JS** (`authoring.ts`: named host, no wildcard,
    http/https, never overwrite user's, cap 20). CSS needs the parallel rails
    (host-scoped, no `<all_urls>`, never overwrite the user's active profile,
    parsed-CSS-only, no remote URLs) rather than squeezing CSS through the JS
    rails.
18. **Console/error capture is JS-shaped** (`runner.ts` wrapper patches console,
    collects `InjectionResult`). CSS apply has no console — its "error" is the
    page check + screenshot. Do not force CSS results through the console
    formatter; give them their own result shape and run event.

## 5. Storage, durability, and protocol gaps

19. **Runlog durability is session-scoped, cap 5** (`durability.ts`). Right for
    run logs (tabs do not outlive the session). Wrong for styles — styles must
    be local-durable with their own history, or every browser restart is a
    widen wipe.
20. **No `style.*` contract surface** (`contract.ts` has `userscript.*` +
    `file.saved`, no style equivalents). When it arrives it must follow the
    existing envelope (`{ type, payload }`, `RunEvent` union extension), plus
    a `style.applied` event for R-07 parity — not a forked protocol.
21. **`save_file` cannot save CSS** (extension allow-list). Either extend the
    contract deliberately (and say why `.css` is safe) or keep style saves on
    their own path — but do not leave the agent writing CSS it cannot persist.
22. **Host protocol has no style validation** (`docs/host-protocol.md`,
    `host/`). If the host ever prepares CSS (postcss) or fetches fonts, that
    is new attack surface on the daemon that holds the key. Keep preparation
    in the extension until there is a reason it cannot live there, and keep
    the key path (`C-07`: host never chooses the model) untouched.

## 6. UI gaps

23. **Script editor is a textarea** (`UserscriptsSection.tsx`: no autocomplete,
    no color swatches, no live preview). Acceptable for JS; poor for CSS.
    Stylebot's code editor (autocomplete + swatches + instant apply) is the
    bar, but instant-apply must wait for the real apply path — a preview that
    does not match the injected result is worse than none.
24. **No profiles, no history restore, no width control** in setup. The panel
    already owns models/observe/input-fidelity well (`SetupSection.tsx`); a
    widen width + force-important default belongs there when the backend
    exists, not before.
25. **Run log has no style rendering.** `RunLog.tsx` filters cover plans,
    handoffs, tools, signals, observations, input, userscripts, steps. A style
    apply with no card is invisible work — add the filter + card with the
    event, not after.

## 7. Testing gaps

26. **No live-browser styling tests, no visual regression.** 137 unit tests
    passing is real (fixtures, fakes, policy, driver, handler), but nothing
    proves "this CSS widened this page and text stayed readable". Stylebot
    carries e2e + styling evals for exactly this. The page check + screenshot
    verify loop is the harness to build toward; until then, every widen claim
    is unverified.
27. **Token/wording brittleness.** Tool descriptions already carry scar tissue
    from live runs ("call again with startChar N", "the ref exactly as it
    appears"). New tool text for styling must be tested against the weak
    Follower, not just reviewed — the free tier is the constraint.

## 8. What is actually good (keep it)

- The invariant script + isolated-world + `USER_SCRIPT` rails are a genuine
  stealth posture, not theater. Restyling via CSS strengthens it: CSS needs
  no trusted input, dodging the entire I-01 banner problem.
- Start-URL-filtered script listing, agent/user authorship split, and the
  `requireAuthor` TOCTOU guard are careful work — mirror them for styles.
- Restart policy (no silent continuation, terminal event naming the restart)
  is correct; styles must not inherit it (they persist) while run logs must
  keep it.
- Key posture (host holds key, panel chooses models, validated readiness) is
  clean and must not be touched by any of this.
