# Refactoring action plan — handyboy

Five targets, seven files, all measured at `cc78bf957ce19c08a03a1741ea605a0f7cdc41ae` (`origin/main`)
with the Layer 1 rules in this same directory applied. Every change below is behaviour-preserving,
lands as a pull request a coding agent can review on its own, and is verified by the repository's
existing gates.

**This is not a score campaign.** No goal below is written as "raise file X to 10", because a number
can be raised by moving code into a second file that is just as hard to read. Each goal states the
capability the next coding agent should have — a smaller unit to edit, one place to add a case, a
boundary that cannot be skipped — and the code-health movement is the measurement that the capability
arrived. Two of the seven files in this plan share a layer with `src/runtime/worker.ts` (8.07), which
is not a target at all.

**No dependency tree is installed in the evidence checkout.** `pnpm typecheck`, `pnpm test`,
`cd host && pnpm test`, `bash scripts/check-invariants.sh` and `bash scripts/e2e.sh` are the gates to
run for each target; they were not executed when this plan was written. Every number quoted here came
from a `cs` command that was run at the SHA above.

## Target 1 — `src/agent/graph.ts`: a graph whose nodes read as policy

Files: `src/agent/graph.ts` (1284 physical / 827 lines of code, score **3.77** — the repository's
lowest).

### What We Hope to Achieve

An agent adding one Follower behaviour — a new end-of-run condition, a new tool-result rewrite, a new
reply shape — should name the function that owns it, change that function, and be certain it did not
move the Leader's re-plan cadence. Today it cannot: `follower` is 286 lines at cc 62 with 14 bumps and
`leader` is 239 lines at cc 37 with 5 bumps. One edit to the repeat-failure counter is an edit inside
the same body that decides vision retries, `set_plan` validation, observation compaction and routing.
The outcome is that the review surface of "the Follower gives up after three identical failures"
shrinks from 371 lines to one named predicate.

### Evidence

At `cc78bf9`, with `.codescene/code-health-rules.json` applied: `Bumpy Road Ahead` ×3
(`follower` 14 bumps, `leader` 5, `promptChars` 3), `Deep, Nested Complexity` ×4 (depth 4 at 351–373,
380–395, 603–896, 898–1268), `Complex Method` ×6, `Complex Conditional` ×5 (102, 214, 677, 1188, 1220),
`Large Method` ×2, `Excess Number of Function Arguments` ×2 (417, 451), and `Lines of Code in a Single
File`.

| Anchor | Lines | What it is |
| --- | --- | --- |
| `const leader: GraphNode<…>` | 603–896 | plans; cc 37, 5 bumps, depth 4, 239 lines |
| `const follower: GraphNode<…>` | 898–1268 | acts; cc 62, 14 bumps, depth 4, 286 lines |
| `followerFeedback` | 351–373 | the handoff note; depth 4, cc 10 |
| `promptChars` | 380–395 | prompt size; 3 bumps, depth 4 |
| `compactObservations` | 171–202 | stubs stale tool output; cc 14 |
| `compactStoredRead` / `withReadEvidence` / `compactStoredFeedback` | 213 / 98 / 582 | one question per tool message |
| `emitUsage` / `answerExtraCalls` | 417–434 / 451–475 | 5 arguments each |
| `decideNext(state, ctx)` | 503–523 | pure routing; cc 9 — not the problem |
| `LEADER_SYSTEM` / `FOLLOWER_SYSTEM` | 284 / 298 | the two prompts |
| `MAX_IDLE_FOLLOWER_TURNS` / `MAX_REPEAT_FAILURE_TURNS` / `MAX_REPEAT_FAILURE_TURNS_TO_END` | 225 / 233 / 236 | consumed at 1209 / 1220 / 1225 |
| `buildAgentGraph` / `AgentGraph` | 1274–1281 / 1284 | the single entry point |

Coupling: `src/agent/run.ts:19` imports `buildAgentGraph`, calls it at `src/agent/run.ts:100`.
Behaviour is pinned by `src/agent/graph.test.ts` (518 lines): `describe('follower signal and replan
cadence')` at 199 (8 cases), `describe('leader set_plan validation')` at 405,
`describe('follower observation failures')` at 477.

### Steps

1. Extract `leaderSituation(state, ctx)` (from the block at 614) and `followerTurn(state, ctx, signal)`.
   String interpolations move byte for byte.
2. Extract `followerOutcome(state, turn): { status, endNote }` from 1188–1250, so the three give-up
   constants appear in one place. `decideNext` (503) does not change.
3. Extract `recoverFromVisionRejection(error, messages, barred)` from 660–700. It must still rethrow the
   original error when the rejection is not a vision rejection.
4. Extract `retryAfterPlanRejection(config, role, extras, state, messages, lap)` from the handling
   around 697. The three correction-lap cases under `describe('leader set_plan validation')` are the
   acceptance test.
5. Route `withReadEvidence` (98), `compactStoredRead` (213) and `compactStoredFeedback` (582) through
   one `rewriteToolResult(message, step)` dispatcher, one named helper per predicate.
6. Only then split the file: compaction helpers to `src/agent/observation.ts`, prompts and give-up
   constants to `src/agent/prompts.ts`, leaving `graph.ts` with the two nodes, `decideNext` and
   `buildAgentGraph`. Update the import sites in the same commit.

One pull request per step. Steps 1–5 and step 6 are never combined.

### Do Not Refactor / Protected Code & Contracts

- `buildAgentGraph(checkpointer?)` (1274) and `AgentGraph` (1284): the entry point `src/agent/run.ts:100`
  calls. Node names `'leader'`/`'follower'`, the edge set at 1278–1280 and `compile({ checkpointer })`
  are the contract `src/agent/graph.test.ts` drives.
- `decideNext` (503) and its export: pure, tested, cc 9. It must not be folded into the node bodies.
- `LEADER_SYSTEM` (284) and `FOLLOWER_SYSTEM` (298): prompt text is behaviour. R-03 fixes the signal
  vocabulary (`CONTINUE | SUBGOAL_COMPLETE | RETURN_TO_LEADER | BLOCKED`).
- `MAX_IDLE_FOLLOWER_TURNS = 4`, `MAX_REPEAT_FAILURE_TURNS = 2`, `MAX_REPEAT_FAILURE_TURNS_TO_END = 4`
  (225, 233, 236): exported, consumed by the cadence tests. Move the use, never the value.
- `actionKey` (251), `hash32` (275), `normalizeError` (270): they decide when two failures are "the
  same". A contract with the repeat-failure counter.
- `trimFollowerHistory` and `FOLLOWER_HISTORY_TURNS = 3` (66, 54): the history window is exported and
  tested.
- `compactObservations` (171): tested through `src/runtime/pageTools.test.ts`; its "stub, do not drop"
  behaviour is the point.
- `REQUIREMENTS.md`: canonical, in the user's own words; `CLAUDE.md` forbids editing or reinterpreting
  it. No step touches it.

### Verification

```bash
pnpm typecheck
node_modules/.bin/vitest run src/agent/graph.test.ts
node_modules/.bin/vitest run
bash scripts/check-invariants.sh
cs review src/agent/graph.ts src/agent/observation.ts src/agent/prompts.ts --output-format json
cs check-rules src/agent/graph.ts        # must print src/agent/**/*.ts
```

`src/agent/graph.test.ts` must pass **unmodified**; a step that requires editing a test changed
behaviour and must be reverted. After step 6, `graph.ts` must be under 400 lines of code and no new
finding category may appear.

## Target 2 — `src/page/actions.ts`: one decision per page action

Files: `src/page/actions.ts` (1108 / 612, score **5.44**).

### What We Hope to Achieve

An agent asked to make `type` work on one more kind of editable element should change one function and
know it did not alter how a click is aimed. Today `type` (757–801) holds two input paths — native value
for `<input>`/`<textarea>`, `execCommand` for a contenteditable — in one cc-13 body, while
`pressTarget` (878–898), `barredByDisabledFieldset` (639–657) and `describeOccluder` (396–424) each
carry a different slice of "which element does this gesture actually land on".

The outcome is two named decisions instead of one tangle. An **aim** decision, shared by `click` (668)
and `hover` (709), because both place a pointer at a coordinate and `click` re-verifies it before
pressing. And a **focus** decision, used only by `press` (905), because it dispatches a key event at
whatever currently has focus. `select` (1035) is neither — it resolves the element, matches an option
by value or label and assigns `sel.value` — and stays as it is. Naming the two decisions separately is
the goal; collapsing them into one would change behaviour, not readability.

### Evidence

`Bumpy Road Ahead` (757–801, 2 bumps), `Deep, Nested Complexity` (639–657, depth 4), `Complex Method`
×8 (`pressTarget` cc 14, `type` cc 13, `barredByDisabledFieldset` cc 12, `describeOccluder` cc 12,
`scroll` cc 11, `actionPoint` cc 11, `defaultSubmitButton` cc 10, `implicitSubmit` cc 9),
`Complex Conditional` ×6 (891, 649, 781, 872, 889, 922), `Excess Number of Function Arguments` ×4
(`pointerAt` 7, `mouseAt` 7, `pointerInit` 5, `mouseInit` 5), `Primitive Obsession`, and
`Lines of Code in a Single File`.

| Anchor | Lines |
| --- | --- |
| exported surface: `click` 668, `hover` 709, `type` 757, `press` 905, `select` 1035, `scroll` 1059, `getBox` 1091 | — |
| `type` | 757–801 (contenteditable branch at 782) |
| `pressTarget` / `descendFrame` / `deepActive` / `noteFocus` | 878–898 / 858 / 844 / 840 |
| `barredByDisabledFieldset` / `matchesDisabled` / `isDisabledControl` | 639–657 / 624 / 659 |
| `actionPoint` / `tryHit` / `hitConfirms` / `verifyAim` / `hitTarget` | 357 / 435 / 461 / 475 / 483 |
| `describeOccluder` | 396–424 |
| `pointerInit` / `mouseInit` / `pointerAt` / `mouseAt` | 197 / 227 / 268 / 294 |
| `movementFor` / `frameOffset` / `screenOf` / `dispatchHover` | 131 / 155 / 176 / 327 |
| `isInViewport` / `scrollElementIntoView` / `ensureVisible` | 68 / 80 / 93 |
| `resetPointerForTests` | 123 |

Coupling: `src/page/handler.ts:10-11` imports seven actions plus their types; `src/page/index.ts`
re-exports the module; `src/runtime/pageTools.ts:33` imports `ActionResult` and `ScrollOptions`;
`tests/page-actions.test.ts:3` and `tests/input/inpage.test.ts:5` import from it directly.

### Steps

1. Replace the 5-to-7-positional-argument signatures of `pointerInit` / `mouseInit` / `pointerAt` /
   `mouseAt` with frozen `PointerSpec` / `MouseSpec` objects. All call sites are in this file.
2. Extract `aim(el, doc): { point } | { error }` from `actionPoint`, `tryHit`, `hitConfirms`,
   `verifyAim` and `hitTarget`. `click` (668) and `hover` (709) are its only callers; `press` and
   `select` do not use it. `describeOccluder`'s wording must survive verbatim — no test asserts it
   today, which is exactly why it must stay a pure string builder.
3. Flatten the `<legend>` exemption (646–652) into `legendExempts(el, fieldset)` so
   `barredByDisabledFieldset` reads as three guards.
4. Combine `deepActive`, `descendFrame`, `noteFocus` and `pressTarget` into
   `focusedTarget(doc): { target, source }`, with the closed-shadow-root fallback (883–895) as one
   named branch. This is `press`'s decision only.
5. Split `type` into `typeNative` and `typeContentEditable`, with `type` keeping the element
   resolution, the `ensureVisible` + `focus` preamble and the final `fail(...)` for a non-text element.
   Do **not** add an "escalated" path: the debugger/CDP tier lives in `EscalatableInput`
   (`src/runtime/pageTools.ts:304`) over `InputPagePort` (`:275`), and `type` never touches it. The
   `execCommand` rationale at 783–786 travels with `typeContentEditable`.
6. Move the humanised pointer path (`movementFor`, `frameOffset`, `screenOf`, the four event
   constructors, `dispatchHover`) into `src/page/pointer.ts`. No new exports; `src/page/index.ts` and
   `src/page/handler.ts` are untouched.
7. Split the gesture verbs only if step 6 leaves `actions.ts` above 400 lines of code, and never in the
   same pull request as step 5.

### Do Not Refactor / Protected Code & Contracts

- The exported surface and types: `click`, `hover`, `type`, `press`, `select`, `scroll`, `getBox`,
  `ActionResult`, `BoxResult`, `TypeOptions`, `ScrollOptions` (25–48, 668, 709, 757, 905, 1035, 1059,
  1091). `src/page/handler.ts:10-11`, `src/page/index.ts` and `src/runtime/pageTools.ts:33` depend on
  them; renaming one is a cross-layer change.
- `resetPointerForTests()` (123): the only supported way to reset the module-level pointer state
  between cases; two suites call it.
- The exact `fail(...)` message text: `tests/page-actions.test.ts` asserts on behaviour tied to it, and
  the model reads the same strings.
- The `execCommand` contenteditable path (782–800) and its comment: deprecated on purpose — it is the
  only way to mutate a contenteditable with a correct `inputType` and a working undo stack without
  OS-level keys.
- The humanisation constants in `movementFor` (131–153) and the `screenOf` mapping (176–195): R-02 (low
  observability) is a requirement and these numbers are the mechanism.
- `isInViewport` / `scrollElementIntoView` / `ensureVisible` (68–121): the scroll-then-measure ordering
  the aim verification depends on. Reordering silently reintroduces off-screen clicks.
- The input-tier boundary: `EscalatableInput` (`src/runtime/pageTools.ts:304`), `InputPagePort`
  (`:275`), `createInputPagePort` (`:951`), `src/input/select.ts`. Debugger/CDP escalation and per-run
  tier selection live in the runtime, not in `src/page/`; `actions.ts` must not grow an escalation path.
- `src/page/driver.ts` and `src/page/tabReplacement.ts`: out of scope. `tests/page-driver.test.ts` and
  `tests/tab-replacement.test.ts` pin them.

### Verification

```bash
pnpm typecheck
node_modules/.bin/vitest run tests/page-actions.test.ts tests/input/inpage.test.ts tests/input/select.test.ts
node_modules/.bin/vitest run
bash scripts/check-invariants.sh
cs review src/page/actions.ts src/page/pointer.ts --output-format json
```

`tests/page-actions.test.ts` must pass **unmodified** — its four cases are the assertion that aim,
fieldset and closed-shadow-root behaviour did not move.

## Target 3 — `src/runtime/runManager.ts` and its suite: one run slot, one scenario per case

Files: `src/runtime/runManager.ts` (748 / 390, score **6.56**) and
`src/runtime/runManager.test.ts` (710 / 649, score **7.82**).

### What We Hope to Achieve

An agent changing what happens when an abort arrives during assembly should see, in one function, that
the slot is taken before the first await and released on every exit. Today `#launch` is 192 lines at
cc 45 with tab resolution, catalog lookup, input attach, dev-trigger navigation, graph start, replay
seeding and the persistence chain in one body, so that invariant is a property of statement order
rather than of the code. The suite has the mirror problem: three abort cases (319–357, 359–411,
458–512) each build their own fakes and assertions and `cs` reports `Code Duplication`, so a fourth
timing is written by copying the third.

### Evidence

`runManager.ts`: `Bumpy Road Ahead` (349–595, 656–702), `Deep, Nested Complexity` (656–702, depth 4),
`Complex Method` (349 cc 45, 656 cc 15, 277 cc 14), `Large Method` (349–595, 192 lines), and
`Lines of Code in a Single File`. `runManager.test.ts`: `Complex Method` (197–271 cc 15, 47–65 cc 11),
`Code Duplication` ×3, `Large Method` (108–195 84 lines, 197–271 72 lines), and
`Lines of Code in a Single File`.

| Anchor | Lines |
| --- | --- |
| `start` (takes the slot before the first await; comment at 330–333) | 322–347 |
| `#launch` | 349–595 |
| `#remember` / `restoreReplay` | 656–702 / 277–320 |
| `ActiveRun` (`runId`, `handle?`, `abortRequested` at 224) | 220–225 |
| `REFUSED_SCHEMES` / `refuseReason` | 195 / 206–213 |
| `DEFAULT_RING_SIZE = 2000` / `DEFAULT_RING_RUNS = 5` | 191 / 192 |
| public API: `onEvent` 251, `replay` 261, `pause` 597, `resume` 604, `abort` 611, `resolveTabId` 620 | — |
| `chromeTabsPort()` | 714 |
| suite: `describe('RunManager')` (11 cases) | 107 |
| suite: the three abort cases | 319–357, 359–411, 458–512 |

Coupling: `src/runtime/index.ts` re-exports `./runManager`; `entrypoints/background.ts:18` imports
`RunManager, chromeTabsPort` from `@/src/runtime`; `src/runtime/runManager.ts:20` imports
`WriteUserscriptRequest` from `@/src/agent/tools`.

### Steps

1. Replace the three abort cases with one `describe` and a `CASES` table driven by `it.each`, keeping
   each existing case name verbatim as the table's `name`. **This lands first, before any production
   change.**
2. Extract `markAborted(slot)` / `honourAbort(slot)` for the `abortRequested` flag (224) and its three
   check sites.
3. Split `#launch` into `resolvePhase`, `navigatePhase`, `startPhase` and `persistPhase`, composing
   them in order. **Do not add a `try`/`finally` around them.** `#launch` has none today and must not
   grow one: it returns `{ runId, ok: true, done }` at 594 while the run is still executing, so a
   `finally` would clear `#active` the moment assembly finished and let a second run start while the
   first is still running. The two cleanup paths are distinct and both must survive:
   - *failure during assembly* — `#launch` refuses at 545–547 after `await detachInput()`, and `start`
     (322–347) releases the slot in its own `catch` and when `result.ok` is false.
   - *success* — `this.#release(slot)` at 590, inside the `.then` on `handle.done` (559–592) and only
     after `detachInput`, the persistence tail and the optional tab removal. The comment at 581–588
     records why that ordering exists.
   The phases return values to a `#launch` that keeps the 549–594 success chain verbatim, including the
   `abortRequested` forward at 554.
4. Flatten `#remember` into `ringAppend(runId, event)` and `enqueuePersist(runId, event)`.
5. Split `restoreReplay` into `replayRing(runId)` and `rearPersist(runId)`.
6. Split the suite by subject (after the production code stops moving): tab-resolution cases to
   `src/runtime/runManager.tabs.test.ts`, replay/persistence cases to
   `src/runtime/runManager.replay.test.ts`, every `describe`/`it` name unchanged.

### Do Not Refactor / Protected Code & Contracts

- The slot invariant in `start` (322–347) and its comment (330–333): taking the slot after an await
  reintroduces the race where two starts both passed the guard and the second overwrote the slot,
  losing the first run's abort.
- The second cleanup path: `this.#release(slot)` at 590, inside the `.then` on `handle.done` (559–592),
  after `detachInput`, the persistence tail and the optional tab removal. Releasing when `#launch`
  returns would let a second run start while the first is still running.
- `RunManager`'s public methods (`start`, `pause`, `resume`, `abort`, `replay`, `onEvent`,
  `restoreReplay`, `resolveTabId`): `entrypoints/background.ts` and `src/runtime/worker.ts` drive them,
  and pause/resume/abort are the user's control (R-05).
- The exported types `ActiveRun` (220–225), `StartOptions` (162), `StartResult` (184),
  `RunManagerDeps` (112), `TabsPort` (79), `TargetTab` (73), `RunLogSink` (102), `HostRunEndEvent` (92):
  adding a field is allowed; renaming or reshaping is a cross-layer change.
- `refuseReason` (206–213) and `REFUSED_SCHEMES` (195): the refusal text is what the user sees, and the
  suite asserts on it.
- `DEFAULT_RING_SIZE` / `DEFAULT_RING_RUNS`: how much run history survives a panel reopen.
- The persistence-chain ordering. `host/src/dispatcher.ts:40-45` exists for the same reason: two
  awaited appends can land in either order and `run.end` can overtake `run.ended`.
- `chromeTabsPort()` (714) and the `chrome.*` shapes it wraps: the suites substitute a fake `TabsPort`
  against the same interface.

### Verification

```bash
pnpm typecheck
node_modules/.bin/vitest run src/runtime/runManager.test.ts
node_modules/.bin/vitest run
cs review src/runtime/runManager.ts src/runtime/runManager.tabs.test.ts src/runtime/runManager.replay.test.ts --output-format json
```

Every existing case name must still exist and pass; `Code Duplication` must be gone from the suite and
`runManager.ts` must be under 350 lines of code.

## Target 4 — `src/runtime/pageTools.ts` and `src/agent/tools.ts`: one tool surface

Files: `src/runtime/pageTools.ts` (974 / 526, score **6.89**) and `src/agent/tools.ts` (777 / 424,
score **7.44**).

### What We Hope to Achieve

An agent adding one Follower tool currently edits two files with no mechanical link between them:
`src/agent/tools.ts` declares the name, schema and description the model sees; `src/runtime/pageTools.ts`
implements it. `src/agent/tools.ts:242` says the shapes live in `pageTools.ts` "in case the shapes ever
drift apart" — a comment that acknowledges the risk instead of removing it. The outcome: the tool list
becomes one table of `ToolSpec { name, schema, describe, invoke }`, so a new tool is a single entry, and
the implementation file becomes small typed operations rather than a 313-line closure factory.

### Evidence

`pageTools.ts`: `Bumpy Road Ahead` (184–272), `Complex Method` (184–272 cc 28, 857–933 cc 24, 653–674
cc 9), `Complex Conditional` (576, 596), `Large Method` (184–272, 78 lines), `Lines of Code in a Single
File`. `tools.ts`: `Large Method` (244–508, 259 lines), `Complex Method` (244–508 cc 10, 135–143 cc 9),
`Primitive Obsession`, `String Heavy Function Arguments`, `Lines of Code in a Single File`.

| Anchor | Lines |
| --- | --- |
| `createPageToolset` (20 tool entries at 252–495) | 244–508, read-only filter at 506–508 |
| `planTool` (`name: 'set_plan'`) | 516, name at 519 |
| `createLeaderReadTools` (`leader_snapshot` / `leader_screenshot` / `leader_extract_text`) | 573, names at 582 / 598 / 610 |
| `validateSaveFilename` | 135–143 |
| `rebindMissingTabDriver` / tab-op list | 184–272 / 265–273 |
| `createPageTools` | 636–948 |
| `saveFile` | 857–933 |
| `assertReadOnlyScript` | 653–674 |
| `MAX_SAVE_BYTES = 8 * 1024 * 1024` (enforced at 576 and 884) | 571 |
| `userscriptArtifactBody` / `formatUserscriptValue` / `formatUserscriptConsole` / `formatUserscriptList` | 574 / 594 / 535 / 610 |
| `EscalatableInput` / `InputPagePort` / `EscalatableInputOptions` / `DEFAULT_SCROLL_AMOUNT` / `snapshotBudget` | 304 / 275 / 283 / 460 / 469 |

Coupling: `src/runtime/pageTools.ts:28`, `src/runtime/runManager.ts:20` and
`src/runtime/pageTools.test.ts:6` import `src/agent/tools.ts`.

### Steps

1. Add a drift test to `src/agent/tools.test.ts` asserting the 20 `name` values of
   `createPageToolset` equal a literal list and that each has a non-empty description. **This lands
   first.**
2. Extract `const TOOL_SPECS: readonly ToolSpec[]` from `createPageToolset` (244–508); the function
   becomes a map over the table plus the read-only filter at 506–508. `planTool` (516) and
   `createLeaderReadTools` (573) stay outside — the Leader's toolset is different by design (R-03).
   Schemas move verbatim.
3. Split `rebindMissingTabDriver` into `rebasedTabId(rebound, tabId)`, `runTabOp(tabId, op)` and
   `retryWithFreshTab(...)`. The pass-through comment at 267 stays beside the list it explains.
4. Split `saveFile` into `resolveArtifactBody(fromLastUserscript)`, `assertWithinSaveCap(bytes)` and
   `saveViaDriver(dataUrl, filename)`. The 8 MiB cap and the "rows exceeded 8 MiB and were left out"
   note (933) are contract text.
5. Move the four pure string builders (`formatUserscriptConsole`, `userscriptArtifactBody`,
   `formatUserscriptValue`, `formatUserscriptList`) to `src/runtime/toolFormat.ts`.
6. Only then group the remaining implementations by subject: `pageReads`, `pageInput`,
   `userscriptTools`, `artifactTools`, `runTools`, each taking the options object and returning its
   slice, merged in `createPageTools`.

### Do Not Refactor / Protected Code & Contracts

- Every tool `name` string (252–495, plus `set_plan` at 519 and the three leader tools at 582/598/610):
  the model selects tools by name. The step-1 drift test pins them.
- Every zod schema and every `description` string: model-visible behaviour. They move verbatim or not
  at all.
- `MAX_SAVE_BYTES` (571) and the truncation note (933): what the model and the user read when an
  artifact is trimmed.
- `assertReadOnlyScript` (653–674) and the comment at 654–659: the read-only gate resolves from the
  whole catalog on purpose, because a read-only run may navigate and then run a script matching its
  destination. Using the run's filtered list would open a scope hole.
- The bundled-seed byte comparison inside `assertReadOnlyScript` (669–672): only a seed whose code is
  exactly as shipped skips the scan. Loosening it to "same id" is a security regression, because an
  edited seed keeps its id.
- `EscalatableInput` (304), `InputPagePort` (275), `EscalatableInputOptions` (283), `snapshotBudget`
  (469), `DEFAULT_SCROLL_AMOUNT = 600` (460): the input-tier and observation-budget seams named by
  R-13 and R-08.
- `TAB_MISSING_ERROR` / `TIMEOUT_ERROR` (139, 142) and `isTimeoutFailure` (144): regexes matched against
  Chrome's own error strings — the only signal that a tab was replaced.
- `planTool` (516) and `createLeaderReadTools` (573): the Leader's toolset must not be folded into the
  Follower table.

### Verification

```bash
pnpm typecheck
node_modules/.bin/vitest run src/agent/tools.test.ts src/runtime/pageTools.test.ts
node_modules/.bin/vitest run
cs review src/agent/tools.ts src/runtime/pageTools.ts src/runtime/toolFormat.ts --output-format json
cs check-rules src/runtime/toolFormat.ts   # must print src/runtime/**/*.ts
bash scripts/harness.sh                    # end-to-end, needs a browser; not a per-PR gate
```

The drift test passes before and after every step; `pageTools.test.ts` passes unmodified; both files end
under their caps (350 and 400).

## Target 5 — `host/src/dispatcher.ts`: a route table instead of a switch

Files: `host/src/dispatcher.ts` (231 / 162, score **8.52**).

### What We Hope to Achieve

An agent adding one host message should add one row to a table and one handler function, and should not
be able to forget the two rules the current `switch` enforces by accident of position: every message
with an `id` gets a terminal reply, and `runlog.append` / `log.append` are the only messages whose `id`
is optional. Today both live in `#handle` (73–201), a 116-line cc-38 body where the `OPTIONAL_ID_TYPES`
check at 79 sits above the `switch` that would explain it. The outcome: the wire contract in
`docs/host-protocol.md` and the code become comparable by reading one table, and a missing handler
becomes a `default` branch rather than a case an agent forgot.

This target is about shape, not size: at 162 lines of code the file is well under its 300 cap, and the
Layer 1 rules report it at full weight for `Complex Method` (cc 38, wrapper plus private method),
`Large Method` (116 lines) and `Complex Conditional` (74, 86, 156).

### Evidence

| Anchor | Lines |
| --- | --- |
| `class Dispatcher` | 38 |
| `#runLogTails` and its comment | 40–45 |
| `constructor` | 47 |
| `#fail(id, code, message)` | 51 |
| `handle` (outer `try`; guarantees a terminal reply) | 60–71 |
| `#handle` | 73–201; compound conditionals at 74, 86, 156 |
| `switch` cases | 84 `key.status`, 99 `models.list`, 110 `llm.request`, 118 `llm.abort`, 122 `runlog.append`, 154 `artifact.save`, 178 `log.append` |
| `default` (routes `InputMsg`, else `unknown_type`) | 195–199 |
| `INPUT_TYPES` / `OPTIONAL_ID_TYPES` (used at 196 / 79) | 33 / 36 |
| `#handleInput` (four `input.*` cases at 207, 210, 213, 216; `input.result` at 220 and 222–228) | 203–230 |
| `DispatcherDeps` | 20–31 |

`InboundMsg` (`host/src/protocol.ts:97–105`) has eight members: the seven single-type messages the
switch names, plus `InputMsg` (86–95), whose `type` is itself a union of `input.moveTo | input.click |
input.typeText | input.key`. `docs/host-protocol.md` has one `###` heading per family (70, 82, 110,
159, 168, 189, 210, 237).

Coupling: `host/src/main.ts:9` constructs the `Dispatcher`; `host/test/dispatcher.test.ts`,
`host/test/secrets-retry.test.ts` and `host/test/harness.ts:4` import it and drive it through
`handle(raw)`.

### Steps

1. Add a union-coverage case to `host/test/dispatcher.test.ts`: every `InboundMsg['type']` is either
   routed to a handler or answered `unknown_type`. **This lands first.**
2. Introduce a **per-key mapped** route type so a handler cannot be attached to the wrong key:
   `type Route<K extends InboundMsg['type']> = (d: Dispatcher, msg: Extract<InboundMsg, { type: K }>) => Promise<void>`
   and `type Routes = { [K in InboundMsg['type']]: Route<K> }`. A single
   `(d, msg: InboundMsg) => Promise<void>` would let a handler keyed under `'artifact.save'` compile
   while reading `llm.request` fields. Cover the eleven inbound `type` strings. `#handle` becomes the
   two shape guards (74–82), the lookup, and the `default`.
3. Move each case body into its own method: `keyStatus`, `modelsList`, `llmRequest`, `llmAbort`,
   `runLogAppend`, `artifactSave`, `logAppend`, `input` — eight methods under 20 lines each. Bodies move
   verbatim, including every validation message and every `ErrorCode`.
4. Move the `OPTIONAL_ID_TYPES` guard (79–82) into `requireId(msg)` called from the lookup step, so no
   handler can forget it. Do not move the `runlog.append` ordering chain out of `#runLogTails`.
5. Split the four `input.*` cases into their own methods and keep the single `input.result` shape (`ok:
   true` at 220, `ok: false` at 222–228) as one helper.
6. Update `docs/host-protocol.md` only if a heading changes. It should not.

### Do Not Refactor / Protected Code & Contracts

- Every message `type` and reply `type` string: `docs/host-protocol.md` is normative, `host/src/protocol.ts`
  is the typed mirror, and `src/host/native.ts` switches on the same strings. The wire is JSON, so a
  rename breaks at runtime rather than at compile time.
- The terminal-reply guarantee in `handle` (60–71): every request with an `id` gets a reply even when a
  handler throws. It must stay the outer `try`.
- `#runLogTails` (40–45) and the append ordering: two awaited `appendFile` calls can land in either
  order, and `run.end` overtaking `run.ended` closed `hb-run`'s stream before the run's own terminal
  event.
- The exact validation messages and `ErrorCode` values (`bad_request`, `upstream`, `io`,
  `unknown_type`): `host/test/dispatcher.test.ts` asserts on them and the panel renders them.
- The `ArtifactError` / `RunLogError` → `bad_request` mapping (156–172): a filename or run-id rejection
  is the caller's mistake; anything else is `io`.
- `failureReply` (`host/src/outbound.ts`) and `DispatcherDeps.send`: the only way a message leaves the
  process.
- `host/src/framing.ts` (4-byte little-endian length prefix) and `host/src/origins.ts`
  (`allowed_origins`): outside this target; they are the security boundary `docs/host-protocol.md`
  § Framing describes.
- `getInjector` / `InputInjector` (203–230): R-13's escalation slot. The refactor must not change which
  injector is selected.

### Verification

```bash
pnpm --dir host typecheck
node_modules/.bin/vitest run --root host test/dispatcher.test.ts test/secrets-retry.test.ts test/readiness.test.ts
pnpm --dir host test
cs review host/src/dispatcher.ts --output-format json
cs check-rules host/src/dispatcher.ts   # must still print host/src/**/*.ts
bash scripts/e2e.sh                     # end-to-end, needs the user's Chrome; not a per-PR gate
```

`host/test/dispatcher.test.ts` passes with only the new union-coverage case added; `Large Method` is gone
and `Complex Method` is under cc 10.

## Sequencing

1. **Target 3, step 1** — the abort-case table. No production code moves; cheapest possible first PR.
2. **Target 4, step 1** — the tool-name drift test. Again no production code; it creates the only
   mechanical link between the two halves of the tool surface.
3. **Target 3, steps 2–5** — the run slot. Smallest production surface with the largest test coverage
   per line, and the highest-churn module in the repository (5 of 21 commits).
4. **Target 5** — the host dispatcher. Small, self-contained, different process, own test run; it can
   proceed in parallel with step 3 without touching the same files.
5. **Target 4, steps 2–6** — the tool surface. Largest change by line count; depends on step 2 and on a
   stable `runManager.ts`, because `pageTools.ts` and `runManager.ts` are both joined by `worker.ts`.
6. **Target 1, steps 1–5** — the graph nodes. The largest review surface and the most behaviour pinned
   by tests; it goes after the runtime is stable because the graph is driven through it.
7. **Target 2** — the page actions. 1108 lines and the least-covered by named cases (four), so it goes
   after everything else that shares its test run.
8. **Target 3, step 6** — the suite split, only after `runManager.ts` has stopped moving.
9. **Target 1, step 6** — the file split, only after the node bodies are readable.

Two pull requests in flight is the ceiling, and no pull request mixes a mechanical move with a behaviour
change.

## Retirement

A target leaves this plan by being **deleted from it**, not by being marked done.

- **Done:** every finding the target set out to remove is gone (`Lines of Code in a Single File` under
  its cap, `Complex Method` under cc 10, `Large Method` under 70 lines, `Bumpy Road Ahead` at zero
  bumps) and the verification block has been run with its output in the pull request. Delete the
  target's section from this file and from `03-row2-refactor-dossier.md` in the same change that lands
  the last step. A finished target left in the plan is a lie about the work remaining.
- **Superseded:** if a change elsewhere moves the code out from under a target, delete the target and
  say in the pull request what replaced it. Do not repoint it at a different file; a rewritten target
  has never been reviewed and reads as if it had.
- **Blocked:** if the behaviour a step would change has no test, write the test, land it, keep the
  target. A target that sits across two cycles with no merged step is a candidate for deletion, because
  its evidence anchors will no longer resolve.
- **Re-evidence:** every `Evidence` block is anchored to a commit. Re-run the anchors (`grep -n`,
  `cs review`) at the current `origin/main` before starting a step; fix or delete on mismatch.

## What This Plan Does Not Do

- **It does not touch `REQUIREMENTS.md`.** Canonical, written in the user's own words, never edited by
  an agent.
- **It does not add, remove or rename a tool, a message type, a CLI flag, an environment variable or a
  file format.** Every target is a shape change inside an existing contract; the contracts are listed
  under "Do Not Refactor" in each target.
- **It does not change the model prompts, the JSON schemas the model sees, or any `fail(...)` message
  text.** Those are behaviour.
- **It does not change the four structural stealth invariants.** They live in
  `scripts/check-invariants.sh` and every target's verification runs that script.
- **It does not modify the two generated agent plugins.** `.opencode/plugins/entire.ts` and
  `.pi/extensions/entire/index.ts` are installer output, excluded at weight `0.0` in
  `.codescene/code-health-rules.json`; regenerate them with `entire enable`, never edit them.
- **It does not target `scripts/`.** The 5 Bash drivers are unsupported by `cs` and the 6 `.mjs`
  harness scorers land on the catch-all; `scripts/harness/ui-inspect.mjs` (7.60, 282 lines of code) is
  the next candidate if the harness becomes a product surface, and a harness is validated by running it
  (`pnpm harness`).
- **It does not target `src/ui/**`.** `cs` counts 24 lines of code in a 343-physical-line `.tsx`
  component, so a file-size finding there would measure markup, not logic. The UI's structural findings
  (`SetupSection.tsx` 8.68, `runlog.ts` 8.51, `usePanel.ts` 8.72) stay reported by the catch-all and are
  handled when they are worked on, not as a plan of their own.
- **It does not target `src/userscripts/runner.ts`** (668 / 294, score 7.87) or
  `src/host/native.ts` (675 / 290, score 8.35) in this round. Both are named next-round candidates: the
  runner because restructuring the module that executes agent-written code should wait until the
  harness's scripted tier pins its stop-flag and timeout behaviour, `native.ts` because it is four lines
  of code under its cap and its shape is not yet the problem. Both keep every rule at full weight.
- **It does not claim any score will rise.** Two of the seven files share a layer with
  `src/runtime/worker.ts` (8.07), which is not a target, and `scripts/harness/ui-inspect.mjs` (7.60) is
  not one either.
- **It does not claim its verification commands were run.** No dependency tree is installed in the
  evidence checkout, so `pnpm typecheck`, `pnpm test`, `cd host && pnpm test`,
  `bash scripts/check-invariants.sh` and `bash scripts/e2e.sh` are the gates to run per target, not
  gates that were executed when this plan was written.
