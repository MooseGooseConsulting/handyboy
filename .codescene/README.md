# CodeScene configuration for handyboy

This directory holds the repository's code-health rules and its PR quality gates, and it is the
place the refactoring action plan the rules are meant to feed will live. **That plan is not in this
change.** It ships in the stacked pull request `docs/codescene-refactor-plan`, which adds
`.codescene/refactor-action-plan.md` on top of this branch; every reference to it below is a
forward reference to that stacked PR, and nothing in this configuration file depends on the plan
existing. This directory's rules and gates work exactly as written with no plan present. It exists
because every file here is written by coding agents, and the harness those agents run inside is
checked in beside the code:
`.claude/settings.json`, `.codex/hooks.json`, `.cursor/hooks.json`, `.agents/hooks.json`,
`.factory/settings.json`, the `.entire/` session config, `.github/hooks/entire.json`, and the two
hook plugins those installers generate — `.opencode/plugins/entire.ts` and
`.pi/extensions/entire/index.ts`. `CLAUDE.md` is the working agreement all of them read, and it
addresses agents directly. Every rule set below therefore describes an agent failure mode, keys
off nothing but a file path, and `tag_codeowners_for_critical_code` is `false` in all twelve
boolean gate maps (the `**/*` catch-all names the `pay_down_tech_debt` profile instead), so no
gate can depend on anything except the code in front of it.

The CLI is `cs` (CodeScene CLI 1.0.55). Everything below is reproducible from the repository root:

```bash
export CS_ACCESS_TOKEN=$(cat ~/.codescene/token)
cs rules-config validate --config-path .codescene/code-health-rules.json --format json
cs rules-config validate --config-path .codescene/custom-quality-gates.json --format json
cs check-rules src/agent/graph.ts
cs review --file-list <(git ls-files | grep -E '\.(ts|tsx|js|mjs)$') --output-format json
```

## What the repository actually is

`handyboy` is a browser agent with four processes and one job: a React side panel configures a run,
a service worker owns it, a Node native-messaging host proxies the model stream, and a script
injected into the user's tab performs the actions. `REQUIREMENTS.md` is canonical and is never
edited by an agent.

| Path | Files | What it is | Who consumes it |
| --- | --- | --- | --- |
| `src/ui/` | 49 | Side panel, run log, state reducers, shared fields — 35 of the repository's 37 `.tsx` files (the other two are `entrypoints/sidepanel/App.tsx` and `main.tsx`) | `entrypoints/sidepanel/` |
| `src/runtime/` | 11 | The single run slot (`runManager.ts`), the tool implementations (`pageTools.ts`), the panel message hub (`worker.ts`), durability and error log | the service worker and the graph |
| `src/agent/` | 14 | The LangGraph Leader/Follower graph, the toolset the model sees, model handles, IndexedDB checkpointer, policy and state | `src/runtime/` |
| `src/page/` | 8 | The injected page world: accessibility snapshot, accessible names, humanised actions, tab driver | `entrypoints/injected-content.ts` |
| `src/userscripts/` | 19 | Runner, catalog, match-pattern, metadata, the agent's authoring path, debugger, bundled examples | `src/runtime/pageTools.ts` |
| `src/input/` | 8 | The three input tiers: in-page events, debugger/CDP trusted input, humanisation | `src/page/`, harness |
| `src/host/` | 7 | The extension's half of the native-messaging channel (`connectNative` client, fetch, redaction) | service worker |
| `src/messaging/` | 4 | The typed panel/worker message contract and its port | panel, worker, graph |
| `src/storage/`, `src/stealth/` | 2 + 2 | Persisted settings; the stealth probe | panel, tests |
| `host/src/` | 22 | The native host: LLM proxy, secrets, dispatcher, protocol, framing, origins, run log, artifacts, dev trigger, `cli/nb-*.ts` | `host/bin/hb-*` |
| `host/test/` | 18 | 16 `*.test.ts` suites plus `harness.ts` (fake channel) and `setup.ts` | `pnpm --dir host test` |
| `host/bin/` | 5 | `hb-run`, `hb-status`, `hb-reload`, `hb-logs`, `hb-cancel` | `scripts/e2e.sh`, the `just` recipes |
| `tests/` | 19 | 14 cross-cutting suites, 4 HTML fixtures, 2 support modules | `vitest run` (root config) |
| `scripts/` | 12 | `live.sh`, `e2e.sh`, `harness.sh`, `registrations.sh`, `check-invariants.sh`, and `scripts/harness/` scorers | `just`, CI |
| `entrypoints/` | 7 | WXT background, injected content script, and the side panel's `App.tsx` / `main.tsx` / `usePanel.ts` / `index.html` / `style.css` | wxt build |
| `docs/` | 22 | `host-protocol.md` (normative) and 21 research notes | agents and reviewers |
| `.opencode/plugins/`, `.pi/extensions/` | 1 + 1 | **Generated** by `entire enable --agent …` | the agent harnesses |
| `.claude/`, `.codex/`, `.cursor/`, `.agents/`, `.factory/`, `.entire/`, `.github/hooks/` | 1 each | The agent harness itself | every coding agent |

261 files are tracked and `cs` supports 196 of them (152 `.ts`, 37 `.tsx`, 6 `.mjs`, 1 `.js`).
The rest are out of its scope by file type: `cs review scripts/harness.sh` answers
`Unsupported file-type ".sh"!`, and `.html`, `.css`, `.md`, `.json` and `.yaml` behave the same way.
Those surfaces are covered elsewhere — `scripts/check-invariants.sh` for the four structural
stealth rules and the built manifest, `pnpm typecheck` for the type graph, review for the docs.

Only the last two rows are not first-party code, and only the `.opencode` / `.pi` pair is
generated. Nothing in this repository is vendored: the only other `generated by` marker in the
tree is `host/install.sh:64`, which writes `host/bin/handyboy-host`, and `host/.gitignore`
excludes that file from the repository.

## Rule set order (first match wins, narrowest glob first)

`cs` evaluates `rule_sets` top to bottom and stops at the first `matching_content_path` that
matches, so the order is part of the design.

| # | `matching_content_path` | Treatment | Why this position |
| --- | --- | --- | --- |
| 1 | `.opencode/plugins/**` | all 23 rules `0.0` | generated; overwritten on install |
| 2 | `.pi/extensions/**` | all 23 rules `0.0` | generated; overwritten on install |
| 3 | `host/test/**` | test profile, file cap 500 | narrower than any source glob below it |
| 4 | `tests/**` | test profile, file cap 500 | the other test directory |
| 5 | `**/*.test.ts` | test profile, file cap 500 | filename glob; must beat the source sets |
| 6 | `**/*.test.tsx` | test profile, file cap 500 | separate glob because the parser differs |
| 7 | `host/src/**/*.ts` | 9 structural rules `1.0`, file cap 300 | the Node daemon — a different process |
| 8 | `src/host/**/*.ts` | 9 structural rules `1.0`, file cap 300 | the extension's half of the same channel |
| 9 | `src/page/**/*.ts` | 9 structural rules `1.0`, file cap 400 | the only code that runs inside the user's page |
| 10 | `src/agent/**/*.ts` | 9 structural rules `1.0`, file cap 400 | the graph and the toolset |
| 11 | `src/runtime/**/*.ts` | 9 structural rules `1.0`, file cap 350 | the run slot and the tool implementations |
| 12 | `src/userscripts/**/*.ts` | 9 structural rules `1.0`, file cap 300 | executes agent-written code in the page |
| 13 | `**/*` | all 23 rules `1.0`, framework thresholds | catch-all; a new directory starts strict |

## Per-rule-set rationale

### 1–2. Generated harness plugins

`entire enable --agent opencode` writes `.opencode/plugins/entire.ts`; header line 2 reads
`// Auto-generated by \`entire enable --agent opencode\`` and line 3
`// Do not edit manually — changes will be overwritten on next install.` The file is 585 physical
lines / 378 lines of code by `cs`'s own measurement, and with the framework profile it scores
**5.83**: `EntirePlugin:Plugin.event` (lines 400–583) is a 143-code-line OpenCode hook dispatcher
at cc 84 with five bumps, and the file also reports `Primitive Obsession` and
`String Heavy Function Arguments`. `.pi/extensions/entire/index.ts` carries the same two header
lines with `--agent pi`, substitutes `ENTIRE_CMD` at install time, is 147 physical lines / 94 lines
of code, and scores 10.0.

All 23 rules are `0.0` on both paths. None of that architecture belongs to this repository: an
agent that "improves" the event handler produces a diff the next `entire enable` discards. A 10.0
here means *out of scope*, not *healthy*.

### 3–6. The test suites

The test surface is two vitest runs, not one. The root `vitest.config.ts` includes
`tests/**/*.test.{ts,tsx}`, `src/**/*.test.{ts,tsx}` and `entrypoints/**/*.test.{ts,tsx}`;
`host/vitest.config.ts` includes `test/**/*.test.ts` with `setupFiles: ['test/setup.ts']`.
Together: **66 suites** — 50 in the extension tree, 16 under `host/test/`. `.github/workflows/tests.yml`
runs both, and `package.json`'s `test` script also runs `bash scripts/check-invariants.sh`.

Tests are first-class citizens here, not a lower tier. The profile applied to all four test globs
keeps the seven structural smells at `1.0` and zeroes exactly three:

| Rule | Weight | Why |
| --- | --- | --- |
| `Bumpy Road Ahead` | `1.0` | a fake that grew a branch per reply shape is how a test stops proving one case |
| `Deep, Nested Complexity` | `1.0` | nested `with`/`for`/`if` chains hide which case a test really covers |
| `Complex Method` | `1.0` | the failure mode is a 15-cc test body that asserts three things |
| `Code Duplication` | `1.0` | already fires on `src/runtime/runManager.test.ts` and `tests/page-driver.test.ts` |
| `Large Assertion Blocks` | `1.0` | a wall of consecutive asserts hides which one matters |
| `Duplicated Assertion Blocks` | `1.0` | the copy-paste drift this repository is trying to stop |
| `Lines of Code in a Single File` | `1.0` | fires on `src/runtime/runManager.test.ts` at 649 lines of code |
| `Low Cohesion` | `0.0` | a class-field metric; these suites are class-per-behaviour with module-level fakes |
| `Primitive Obsession` | `0.0` | a fake channel taking `(method, path)` strings is the correct test double |
| `String Heavy Function Arguments` | `0.0` | signature metric, meaningless for a fake that speaks a wire format |

The file cap is `500` on every test set — the one cap in the test profile that fires, on
`src/runtime/runManager.test.ts` (710 physical lines / 649 lines of code), whose three abort
scenarios at lines 319–357, 359–411 and 458–512 are the same arrangement of awaits written three
times. The two assertion-block thresholds (`unit_test_consecutive_asserts_for_large_block`,
`unit_test_suite_number_of_large_assertion_blocks`) were left at the framework default on purpose;
see "Deliberate non-actions".

### 7–8. The native-messaging channel, both halves

`host/src/**/*.ts` is the Node daemon — `docs/host-protocol.md` opens with "the native-messaging
host **is** the daemon". It holds the OpenRouter/Kilo key, streams responses in 64 KiB chunks,
writes run logs and artifacts under `~/.local/share/handyboy/`, and serves the dev trigger socket.
`src/host/**/*.ts` is the extension's half of the same channel. They are two rule sets, not one,
because they are two processes; they carry the same numbers because a change that widens one end
of the protocol has to answer to the same guardrail as the other.

Nine structural rules at `1.0` and nothing relaxed. `Dispatcher.handle` — the public wrapper at
60–71 plus its private `#handle` at 73–201, which `cs` reports as one function at cc 38 and 116
lines — covers seven single-type messages plus the four-variant `input.*` union (`InboundMsg` in
`host/src/protocol.ts:97-105` has eight members; the eighth is `InputMsg`, whose `type` is itself
that union). `HostClient.onMessage` (`src/host/native.ts` 569–644) is cc 26 and
`HostClient.listModels` (441–474) is cc 17 with three bumps. Both files are measured, not
exempted: `host/src/llm.ts` sits at 8.54, `src/host/native.ts` at 8.35, and they stay there.

File cap `300` for both. Measured: `host/src/llm.ts` 202 lines of code / 315 physical,
`host/src/dispatcher.ts` 162 / 231, `host/src/trigger.ts` 154 / 213, `host/src/secrets.ts` 131 /
299, `src/host/native.ts` 290 / 675. `host/src/protocol.ts` is types only and `cs` returns
`score: null` for it. Nothing is near the cap except `native.ts`, which is one growth step away —
which is the point of arming it.

### 9–12. The four first-party extension layers

| Rule set | Largest file (physical / lines of code) | Cap | What the cap fires on |
| --- | --- | --- | --- |
| `src/page/**/*.ts` | `actions.ts` 1108 / 612 | 400 | `actions.ts` |
| `src/agent/**/*.ts` | `graph.ts` 1284 / 827 | 400 | `graph.ts`, `tools.ts` |
| `src/runtime/**/*.ts` | `pageTools.ts` 974 / 526 | 350 | `pageTools.ts`, `runManager.ts` |
| `src/userscripts/**/*.ts` | `runner.ts` 668 / 294 | 300 | nothing today |

Every structural weight is `1.0` and nothing is muted in any of the four. The findings are
concrete: `type` (`actions.ts` 757–801) is cc 13 with two bumps and `barredByDisabledFieldset`
(639–657) nests four conditionals deep; `leader` (`graph.ts` 603–896) is cc 37 / 239 lines and
`follower` (898–1268) is cc 62 / 286 lines with 14 bumps; `RunManager.launch` (`runManager.ts`
349–595) is cc 45 in 192 lines and `rebindMissingTabDriver` (`pageTools.ts` 184–272) is cc 28 in
78; `runUserscript` (`runner.ts` 434–584) is cc 35 with three bumps in 119 lines. Those are real
seams, and the refactoring plan measures itself against this exact report.

The cap numbers come from the measurements, not from a round number: `350` in `src/runtime` is the
one value that makes both files that own the run slot report, where `400` would have let
`runManager.ts` pass at 390; `300` in `src/userscripts` is *one step above* `runner.ts` on purpose
— tightening to 250 only to make it report would have measured the wrong thing, because
`runner.ts`'s debt is one 119-line function, which `Large Method`, `Complex Method` and `Bumpy
Road Ahead` already report at full weight.

### 13. Catch-all

All 23 rules at `1.0` with framework thresholds for the detected language. Everything not named
above lands here: `src/ui/**` (49 files, 35 of them `.tsx`), `src/input/**`, `src/messaging/**`,
`src/storage/**`, `src/stealth/**`, `entrypoints/**`, `scripts/**`, `docs/`, `.github/`, and any
directory a future change introduces. A new directory starts under the full guardrail and has to
earn a rule set of its own with measurements rather than inheriting a relaxed one.

## Deliberate non-actions

- **`src/ui/**` gets no rule set of its own**, despite being 49 of 261 files. `cs` counts **24
  lines of code in `src/ui/sections/UserscriptsSection.tsx`, a 343-physical-line `.tsx`
  component**, because JSX markup is neither code nor declarations to it. A file cap there would
  measure nothing, and `SetupSection.tsx` (249 lines of code / 305 physical) already scores 8.68
  with `Complex Method` and `Large Method` armed at `1.0` by the catch-all. Adding a rule set
  would have been decoration.
- **No threshold was widened to make a file pass.** Every cap above either fires on a file the
  refactoring plan targets or is one growth step above the largest file in its directory. The
  repository mean barely moved (9.580 → 9.591 on the full sweep; the 36-file sample went
  8.434 → 8.487), and every negative per-file delta in that sample is one of the six scores that
  dropped because a real `Lines of Code in a Single File` finding appeared where the framework
  profile was silent.
- **`unit_test_consecutive_asserts_for_large_block` and
  `unit_test_suite_number_of_large_assertion_blocks` were left at the framework default.** Lowering
  them would have been a number nobody could justify from an observed defect, and the duplication
  an agent actually produces in this repository is already caught by `Code Duplication` and
  `Duplicated Assertion Blocks`, both of which report today.
- **`Primitive Obsession` and `String Heavy Function Arguments` are zeroed only on test globs.**
  They fire on `src/agent/tools.ts`, `src/page/actions.ts`, `src/page/driver.ts`,
  `src/input/debugger.ts` and the generated plugin, and every one of those remains a full finding
  in application code. A `[ref=eNN]` handle really is a string identifier being passed around;
  zeroing the rule everywhere would have hidden the one place where it is a design question.
- **`scripts/**` is not given its own rule set.** The 6 `.sh` drivers are unsupported by `cs` and
  the 6 `.mjs` scorers land on the catch-all; the largest, `scripts/harness/ui-inspect.mjs`, is 282
  lines of code and scores 7.60 with `Bumpy Road Ahead`, `Complex Method`, `Complex Conditional`,
  `Large Method` and `Excess Number of Function Arguments` all at `1.0`. The harness is validated
  by running it (`pnpm harness`), not by a file cap.
- **No rule was added for a smell `cs` does not measure.** The four structural stealth invariants
  live in `scripts/check-invariants.sh`, which greps the built manifest and the source; they are
  not code-health metrics and were not forced into this file.

## Verification

`cs rules-config validate` (schema, not opinion):

```
$ cs rules-config validate --config-path .codescene/code-health-rules.json --format json
{"status":"ok","summary":"Code health config is valid: 13 rule set(s), 215 rule override(s), 10 threshold override(s)."}

$ cs rules-config validate --config-path .codescene/custom-quality-gates.json --format json
{"status":"ok","summary":"Code health config is valid: 13 rule set(s), 0 rule override(s), 0 threshold override(s)."}
```

`cs check-rules` proves the first-match-wins intent, file by file (each invocation run in the
repository root with `CS_ACCESS_TOKEN` set):

```
$ cs check-rules .opencode/plugins/entire.ts        Matching code health rule path: .opencode/plugins/**
$ cs check-rules .pi/extensions/entire/index.ts     Matching code health rule path: .pi/extensions/**
$ cs check-rules host/test/dispatcher.test.ts       Matching code health rule path: host/test/**
$ cs check-rules host/test/harness.ts               Matching code health rule path: host/test/**
$ cs check-rules tests/page-driver.test.ts          Matching code health rule path: tests/**
$ cs check-rules src/agent/graph.test.ts            Matching code health rule path: **/*.test.ts
$ cs check-rules src/ui/sections/SetupSection.test.tsx  Matching code health rule path: **/*.test.tsx
$ cs check-rules host/src/dispatcher.ts             Matching code health rule path: host/src/**/*.ts
$ cs check-rules host/src/llm.ts                    Matching code health rule path: host/src/**/*.ts
$ cs check-rules src/host/native.ts                 Matching code health rule path: src/host/**/*.ts
$ cs check-rules src/page/actions.ts                Matching code health rule path: src/page/**/*.ts
$ cs check-rules src/page/accname.ts                Matching code health rule path: src/page/**/*.ts
$ cs check-rules src/agent/graph.ts                 Matching code health rule path: src/agent/**/*.ts
$ cs check-rules src/agent/tools.ts                 Matching code health rule path: src/agent/**/*.ts
$ cs check-rules src/runtime/runManager.ts          Matching code health rule path: src/runtime/**/*.ts
$ cs check-rules src/runtime/pageTools.ts           Matching code health rule path: src/runtime/**/*.ts
$ cs check-rules src/userscripts/runner.ts          Matching code health rule path: src/userscripts/**/*.ts
$ cs check-rules src/ui/sections/UserscriptsSection.tsx  Matching code health rule path: **/*
$ cs check-rules src/messaging/protocol.ts          Matching code health rule path: **/*
$ cs check-rules scripts/harness/ui-inspect.mjs     Matching code health rule path: **/*
$ cs check-rules README.md                          Matching code health rule path: **/*
```

## Calibration ledger

Every number in this table was produced by running `cs review <path> --output-format json` twice,
once with `.codescene/` absent (framework defaults) and once with this rules file present. The
line-of-code figures were measured by bisecting `cs check` under a one-rule config until
`Lines of Code in a Single File` stopped reporting.

| Change | Where | Direction | Measured effect |
| --- | --- | --- | --- |
| 23 rules `0.0` | `.opencode/plugins/**` | exclude generated | `entire.ts` 5.83 → 10.0; removed `Bumpy Road Ahead`, `Complex Conditional`, `Complex Method`, `Large Method`, `Overall Code Complexity`, `Primitive Obsession`, `String Heavy Function Arguments` |
| 23 rules `0.0` | `.pi/extensions/**` | exclude generated | no change: the file already scored 10.0, and the set is there so it stays out of scope if that changes |
| cap `500` + test profile | `host/test/**`, `tests/**`, `**/*.test.ts`, `**/*.test.tsx` | arm | `src/runtime/runManager.test.ts` 8.32 → 7.82, adding `Lines of Code in a Single File` at 649 lines of code |
| cap `400` | `src/agent/**/*.ts` | tighten | `graph.ts` 3.97 → 3.77 and `tools.ts` 7.91 → 7.44, each adding `Lines of Code in a Single File` |
| cap `400` | `src/page/**/*.ts` | tighten | `actions.ts` 5.76 → 5.44, adding `Lines of Code in a Single File` |
| cap `350` | `src/runtime/**/*.ts` | tighten | `pageTools.ts` 7.32 → 6.89 and `runManager.ts` 6.96 → 6.56, each adding `Lines of Code in a Single File` |
| cap `300` | `src/userscripts/**/*.ts` | arm | none: `runner.ts` is 294 lines of code and stays at 7.87 |
| cap `300` | `host/src/**/*.ts`, `src/host/**/*.ts` | arm | none: the largest is `src/host/native.ts` at 290 lines of code, and the rest are under 210 |
| no change | `src/ui/**`, `src/input/**`, `src/messaging/**`, `scripts/**` | deliberate | every file keeps exactly the score the framework profile gave it |

**Full sweep, all 196 files `cs` recognises**, run once with `.codescene/` absent and once with it
present:

| | files recognised | scorable | `score: null` | mean score | files below 10.0 | lowest |
| --- | --- | --- | --- | --- | --- | --- |
| framework defaults | 196 | 177 | 19 | 9.580 | 57 | 3.97 |
| this rules file | 196 | 177 | 19 | 9.591 | 56 | 3.77 |

Seven of the 36 files in the bounded review sample moved at all: one exclusion (up 4.17), and six
that gained a real file-size finding (down 0.20 to 0.50). Nothing else changed, which is the
point — a calibration that moved files it was not aimed at would have been a score campaign.

## PR quality gates

`.codescene/custom-quality-gates.json` uses the same first-match-wins ordering and the same 13
paths, and validates with the same command. The two generated plugins turn every gate off. The
four test globs, `host/src/**`, `src/host/**`, `src/page/**`, `src/agent/**`, `src/runtime/**` and
`src/userscripts/**` turn every gate on. The `**/*` remainder names the `pay_down_tech_debt`
profile so a change may pay debt down instead of being blocked by the pre-existing state of a file
that no refactoring target names.

Six gates per set — `hotspot_decline`, `new_code_health`, `supervise_goals`,
`advisory_health_rules`, `critical_health_rules`, `refactoring_goals` — plus
`tag_codeowners_for_critical_code`, which is `false` on all twelve boolean maps. A gate therefore
reads the code in the pull request and nothing else: not a person, not a team, not a review route.

## Maintenance protocol

1. A new first-party directory starts under `**/*` (all rules on, framework thresholds). Promote it
   to its own rule set only with a measurement in this file: `cs review` before and after on every
   file in it, and a line-of-code count for the largest.
2. Never widen a threshold to make a file pass. If a file is too big or too branchy, the answer is
   the refactoring plan (`.codescene/refactor-action-plan.md`, added by the stacked
   `docs/codescene-refactor-plan` PR), not a number.
3. Never edit `.opencode/plugins/**` or `.pi/extensions/**`. Regenerate them with
   `entire enable --agent <agent>`.
4. A 10.0 score on an excluded path means "not scored", not "clean". Say so when quoting it.
5. Whenever a rule set changes, re-run both `cs rules-config validate` commands and re-run
   `cs check-rules` on one file per set, so the ordering proof stays current.
