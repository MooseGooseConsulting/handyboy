# A CI model for nanobrowser-v2, taken from recent browser-agent repos

Researched 2026-10-11. Sources: `gh search repos`, the GitHub contents/trees/runs API, and Exa.
Nothing was cloned and no browser tool was used. Every claim below names `owner/repo:path`.
Every quoted file was read through the GitHub API on 2026-10-11 (default branch unless a commit is named).

## 1. Candidates

Searches run: `gh search repos "<q>" --sort stars --created ">2026-04-01"` for "browser agent",
"chrome extension agent", "browser use", "computer use browser", "web agent" and "extension AI agent",
plus Exa ("open-source AI browser agent Chrome extension 2026 with e2e tests and evals in CI").
Stars and dates come from `gh api repos/<r>`.

### New in the last ~6 months

| Repo | Stars | Created | Last push | What it is | CI (`.github/workflows/`) |
|---|---|---|---|---|---|
| vercel-labs/agent-browser | 43,833 | 2026-01-11 | 2026-10-11 | Rust browser CLI for agents, not an agent | `ci.yml`: Rust/docs/unit on PR. Native e2e and Windows run only off-PR. |
| browser-use/jev-ultrafast | 22,648 | 2026-09-16 | 2026-09-30 | Python web agent | none |
| Player-YN/BrowserKitten | 2,861 | 2026-08-28 | 2026-09-18 | Chrome extension agent | `ci.yml`: `node --test` plus checks on the pack's shape. No browser. |
| webbrain-one/webbrain | 1,366 | 2026-04-06 | 2026-10-12 | **Chrome + Firefox MV3 agent extension** | `webmcp.yml` (PR), `main.yml`, `cloud-e2e.yml`, `webbrain-cloud-smoke.yml` (all dispatch) |
| browser-use/desktop | 700 | 2026-04-17 | 2026-10-03 | Electron agent app | `ci.yml`: lint, tsc, vitest, Windows/Linux spawn smoke tests |
| browser-use/browser-use-pi | 431 | 2026-09-05 | 2026-10-07 | TS agent "hill climbed on real browser evals" | none |
| iFurySt/open-browser-use | 365 | 2026-04-24 | 2026-10-09 | Chrome automation CLI + extension | `ci.yml` → `scripts/ci.sh` |
| Endokelp/Endoplexity | 210 | 2026-08-14 | — | Chrome side-panel agent + local bridge | (156 node:test unit tests, per its README) |
| softpudding/OpenBrowser | 189 | 2026-02-18 | 2026-05-13 | Chrome-extension visual agent | `ci.yml`. Evals are checked-in reports (`eval/evaluation_report.json`). |
| uiuing/browser-agent | 48 | 2026-07-09 | 2026-07-09 | MV3 side-panel agent, mock-provider e2e | none |

### Older repos that are very active (counted only because the new ones fell short)

| Repo | Stars | Created | Last push | Relevant CI |
|---|---|---|---|---|
| browser-use/browser-use | 117,670 | 2024-10-31 | 2026-10-09 | `test.yaml` (per-file matrix + agent-task eval + PR comment), `eval-on-pr.yml` |
| lightpanda-io/browser | 36,298 | 2023-02-07 | 2026-10-12 | `agent-regression.yml` (nightly cron, live LLM, Slack) |
| alibaba/page-agent | 29,392 | 2025-09-23 | 2026-10-05 | `ci.yml` (PR, hosted runner), `main-ci.yml` (push to main, self-hosted `page-agent-trusted`) |
| **browserbase/stagehand** | 25,631 | 2024-03-24 (**v4 rewrite with an MV3 extension runtime: 2026-08-10**) | 2026-10-10 | `ci.yml` (722 lines): path filters, real Chrome, extension, integration matrix, gated regression evals |
| browseros-ai/BrowserOS | 13,875 | 2025-05-18 | 2026-10-11 | `test.yml` (affected-suite matrix, retry once, JUnit, sticky PR comment) |

Why most of the new repos are out:
- Five of them have thin CI or none (unit tests or pack checks only).
- **webbrain** is the one strong new candidate. It is the closest product match and has the richest
  live-scenario design (section 4), but its CI should not be copied wholesale:
  - Only `webmcp.yml` runs on PRs. The full test shards run only inside the manually dispatched
    release workflow (`webbrain-one/webbrain:.github/workflows/main.yml`, `on: workflow_dispatch`).
  - The live packs are dispatch-only (`cloud-e2e.yml`, `webbrain-cloud-smoke.yml`).
  - The last 40 runs from `gh run list -R webbrain-one/webbrain` were all `failure`: 13 CodeQL,
    12 WebMCP E2E push, 7 WebMCP E2E pull_request, and 2 Build and Package.

## 2. Pick: browserbase/stagehand (v4)

Reasons:

1. **It has the same shape as our product.** v4 (`Stagehand v4 (#2671)`, 2026-08-10, the first commit
   of `packages/extension/manifest.json`) runs its agent runtime inside an MV3 extension service worker.
   A host process drives it over CDP:
   - `browserbase/stagehand:packages/extension/README.md` says "Chrome extension service-worker runtime".
   - `packages/extension/manifest.json` and `service-worker.ts` hold the runtime.
   - `packages/sdk-ts/src/cdpClient.ts` loads the extension with `loadUnpackedExtension` →
     `Extensions.loadUnpacked`, then `waitForServiceWorker` and `Target.attachToTarget`.
   That matches our Node host + MV3 extension split more closely than any other repo here.
2. **One workflow covers every tier we want:** unit tests, real-Chrome integration tests, extension
   build drift, and LLM regression evals with trials, a score gate, trace links and reports.
3. **The CI works.** In run 38006108569 (branch `fix/bind-fetch-llm-providers`), the job
   `evals/regression` logged:
   ```
   $ tsx scripts/test-evals.ts --cli packages/evals/dist/cli/cli.js -- regression --env browserbase --trials 3 --concurrency 25
     Plan: 15 tasks × 3 models × 3 trials = 135 runs
   Experiment: regression-f568687e
   Passed: 135
   Failed: 0
   Regression Braintrust score: 100.00%
   View results at https://www.braintrust.dev/app/Browserbase/p/stagehand/experiments/regression-f568687e
   ```
   Out of the last 100 `ci.yml` runs, 29 succeeded, 11 failed, 9 were cancelled, and 51 are
   `action_required`. The last group is fork PRs waiting for maintainer approval, which is the
   fork gate working as designed.
4. **The eval framework is honest about evidence**, which matches our CLAUDE.md "a claim is not
   evidence" rule:
   - A verifier error fails closed.
   - The agent's own report is stored apart from the grade.
   - Missing usage or cost data is recorded as unknown, never as zero.

   Source: `packages/evals/docs/verifier-gates.md` and `packages/evals/docs/harness-contract.md`.

Caveat: the repository dates from 2024. The v4 extension architecture and its CI are about two months
old, which is why it still meets the "seriously active" bar.

## 3. How stagehand's CI works

### 3.1 Workflow files and triggers

- **`.github/workflows/ci.yml`** runs on these events:
  - `pull_request` of type `opened, reopened, synchronize, labeled, unlabeled`.
  - `workflow_dispatch` with a `pull_request_number` input, so a maintainer can run a mirrored
    internal PR.

  Other settings:
  - `concurrency: ${{ github.workflow }}-${{ github.ref }}` with `cancel-in-progress: true`.
  - Workflow-wide `permissions` of `contents: read, pull-requests: read`. Only the cancel job gets
    `actions: write`.
  - Label events re-run CI only when the label is `skip-evals` or `skip-regression-evals`. This is
    set in the `if:` of `determine-changes` and `load-pr-context`.
- **`release.yml`** runs on push to main and on dispatch. **`preview.yml`** runs on a PR when it is
  labeled or reopened. **`external-contributor-pr.yml`** uses `pull_request_target` to hand fork PRs
  to maintainers.
- **There is no nightly cron.** No stagehand workflow has a `schedule:` trigger (checked with
  `grep -n -A4 '^on:'` across the fetched workflows). For a scheduled live tier, see
  `lightpanda-io/browser:.github/workflows/agent-regression.yml` (`cron: "37 3 * * *"` plus
  dispatch with a `model` input) in section 4.

### 3.2 Jobs and matrices (all in `ci.yml`)

| Job | What it does | Gate |
|---|---|---|
| `determine-changes` | `dorny/paths-filter` outputs `evals`, `extension`, `sdk-ts`, `sdk-python`, `sdk-go`, `docs-only`, `is_internal_head` | runs on every PR |
| `load-pr-context` | `actions/github-script` reads the PR labels and outputs `skip-evals`, `skip-regression-evals`, `is-internal-head` | — |
| `docs`, `check` | `pnpm build`; `git diff --exit-code` on the generated protocol schema; `pnpm check` (fmt, lint, typecheck through turbo); `pnpm test:unit` | always |
| `cancel-after-check-failure` | if `check` fails, cancels the whole run through the REST API | saves runner minutes on the ~60-job fan-out |
| `build` | `turbo run build`; saves the `.turbo` cache; uploads `build-artifacts`, including `packages/extension/dist/**`, with `retention-days: 1` | — |
| `unit-ts`, `browser-ts` | download the build artifact; `setup-chrome-verified`; `turbo run test:unit` / `test:browser` with `CHROME_PATH`; a Browserbase smoke test only for internal heads | `sdk-ts` changed |
| `extension-drift` | rebuilds the extension and checks that the committed zip the Go SDK embeds still matches it (`go run ./internal/extensionpack --check`) | `sdk-go` changed, and the PR is internal or labeled `safe-to-test` |
| `discover-integration` → `integration` | `pnpm run test:integration -- --list` emits a JSON matrix. `strategy.matrix.test: fromJson(...)`, `fail-fast: false`, `max-parallel: 20`. Each test uploads a CTRF report and V8 coverage. | `extension` changed |
| `regression-evals` | section 3.4 | internal head, no skip label, not docs-only |
| `go-windows` | Windows process-management tests | internal head |

The integration matrix comes from a fixed group map. `browserbase/stagehand:scripts/test-integration.ts`
says: "Every integration test file must appear in exactly one semantic group. Discovery throws when this
map and packages/sdk-ts/tests/integration fall out of sync." Examples are `local/browser-lifecycle` and
`local/locators-write`. Run 38006108569 shows one job per test (`integration/fileUpload`,
`integration/cookies`, …), each taking 0–1 minute.

### 3.3 How a real browser runs in CI

- **`.github/actions/setup-chrome-verified/action.yml`:**
  1. `browser-actions/setup-chrome@v2.1.2` with `chrome-version: stable` and
     `install-dependencies: true`.
  2. Exports `CHROME_PATH`.
  3. **Smoke-launches the browser** with
     `timeout 30s "$chrome_path" --headless=new --no-sandbox --disable-gpu --dump-dom about:blank`.
     A broken browser install therefore fails setup, not a test.
- **Launch flags:** `browserbase/stagehand:tests/fixtures/local-browser-default-flags.json` and
  `packages/sdk-ts/src/browser/localBrowser.ts`. They include:
  - `--remote-debugging-port`, `--user-data-dir=<tmp>`, and `--headless` when headless.
  - `--enable-unsafe-extension-debugging` and `--remote-allow-origins=*`.
  - `--disable-component-extensions-with-background-pages`, `--disable-background-timer-throttling`,
    `--disable-renderer-backgrounding`, `--password-store=basic`, `--use-mock-keychain`, and others.
- **Loading the extension:**
  - Stagehand does **not** use `--load-extension`. It calls CDP `Extensions.loadUnpacked { path }`
    (`packages/sdk-ts/src/cdpClient.ts`, `loadUnpackedExtension`). That only works because of
    `--enable-unsafe-extension-debugging`.
  - It then finds the service-worker target and attaches with `flatten: true`.
  - `Extensions.getExtensions` resolves an extension that is already installed, matched by name.
  - Why this matters to us: it works on branded Chrome stable, where `--load-extension` is no longer
    honoured.
- **No xvfb:** stagehand runs headless only. BrowserOS shows the xvfb fallback
  (`browseros-ai/BrowserOS:.github/workflows/test.yml`, the "Prepare BrowserOS wrapper" step:
  `exec xvfb-run --auto-servernum ...` when `BROWSEROS_TEST_HEADLESS=false`).

### 3.4 Live and LLM evals

The `regression-evals` job in `browserbase/stagehand:.github/workflows/ci.yml`:

- **When it runs:** the PR is internal (`is-internal-head == 'true'`, so fork PRs never get secrets),
  it has no `skip-evals` or `skip-regression-evals` label, and the change is not docs-only.
  `timeout-minutes: 90`.
- **Secrets:** `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`,
  `BRAINTRUST_API_KEY`, `BROWSERBASE_API_KEY`, `BROWSERBASE_PROJECT_ID`.
- **Cost controls:**
  - The model list comes from a repo variable (`EVAL_MODELS: ${{ vars.EVAL_MODELS }}`), so it can
    change without a code change.
  - Other settings: `EVAL_TRIAL_COUNT: "3"`, `EVAL_MAX_CONCURRENCY: "25"`, and
    `EVAL_BROWSERBASE_PROXIES: "0"` (commit "[chore]: disable proxies in CI (#3143)", 2026-10-08).
- **Command:**
  `pnpm --filter @browserbasehq/stagehand-evals run test:evals -- regression --env browserbase --trials 3 --concurrency 25`.
- **The gate:**
  - The job reads `eval-summary.json`, takes `scores["Exact match"]` (or `scores["Pass"]`), and
    **fails if it is below 0.8**: `jq -en ... '$score | tonumber >= 0.8'`.
  - A missing summary or missing score also fails the job.
  - So this is a gating check with a tolerance, not a report-only one.
- **Live sites are mirrored:** the regression tasks run against owned static copies, for example
  `packages/evals/tasks/bench/act/amazon_add_to_cart.ts` uses
  `page.goto("https://stagehand-eval-sites.vercel.app/sites/amazon/")` and asserts the resulting URL.
  The public benchmarks (WebVoyager, OnlineMind2Web, WebTailBench, Odysseys, HardBench in
  `packages/evals/suites/`) run on demand through the `evals` CLI, not on PRs
  (`packages/evals/README.md`).
- **Tasks:** 77 files are auto-discovered under `packages/evals/tasks/bench/<category>/`, defined with
  `defineBenchTask({ name, tags: ["regression"], run })` (`packages/evals/README.md`).
  `--preview` prints the plan with "no browser, no LLM calls", so you can check it before paying for
  a run.
- **Defaults:** `packages/evals/evals.config.json` sets `trials: 3`, `concurrency: 10`, and a
  per-benchmark `limit: 25`.
- **Budgets:** `packages/evals/framework/stepBudget.ts` resolves the step budget in this order: the
  harness's env key, then `AGENT_EVAL_MAX_STEPS`, then the dataset default (HardBench 100), then the
  harness default. Hitting the budget records `step_budget`, and the verifier still grades the evidence.
- **Cost accounting:** `packages/evals/framework/costEstimate.ts` tags cost as `reported`, `computed`
  (tokens × the dated price list in `pricing/pricing.json`) or `unavailable`. `harness-contract.md`
  says: "missing usage and unknown subscription bills do not become zero-dollar runs."
- **Scoring from evidence** (`packages/evals/docs/verifier-gates.md`):
  - A judge pass is rejected if the final answer is empty or if the trajectory has **no browser tool
    calls**.
  - `EVAL_REQUIRE_GROUNDING=1` rejects numeric answers that no captured accessibility tree supports.
  - `harnessStatus` and `terminationReason` (budget, abort, SDK error, browser loss) are kept separate
    from the outcome.
  - `processScoreStrict` counts `evidenceInsufficient` criteria as zero.
  - `VERIFIER_PERSIST_TRAJECTORIES=1` keeps the trajectories so a human can review them.

### 3.5 Reports

- **Step summary:** the job writes the experiment name, passed and failed counts, Braintrust scores,
  category percentages and a **Braintrust experiment link** to `$GITHUB_STEP_SUMMARY`
  (`ci.yml`, "Log eval score - regression").
- **Test reports:** `packages/evals/scripts/test-evals.ts` turns `eval-summary.json` into
  **JUnit XML** (`ctrf/evals/<target>.xml`) and **CTRF JSON** (`ctrf/evals/<target>.json`), one test
  case per `evals/<task> [<model>]`. If the summary is missing, it writes a failing case named
  `summary missing` rather than nothing.
- **Artifacts:** `.github/actions/upload-ctrf-report/action.yml` uploads each report. It passes inputs
  through `env:` instead of `${{ }}` interpolation, because "a crafted value would run as code", and it
  rejects CR/LF. `upload-v8-coverage` uploads coverage per matrix cell.
- **Trajectories:** stored locally at
  `<root>/<experiment>[__<model>]__<runToken>/<task.id>/<run-timestamp>/`, with a run token so re-runs
  do not overwrite each other (`packages/evals/framework/trajectoryGroup.ts`). Traces also go to
  Braintrust, with LangSmith and OTel adapters available (`framework/braintrust.ts`, `langsmith.ts`,
  `otel.ts`).
- **No PR comment:** stagehand does not post one. Two other repos show the pattern:
  - `browser-use/browser-use:.github/workflows/test.yaml` (job `evaluate-tasks`) upserts an
    "Agent Task Evaluation Results: X/Y" comment with a per-task table of pass/fail and reason. It
    fails only at 0%.
  - `browseros-ai/BrowserOS:.github/workflows/test.yml` (job `comment`) merges the JUnit artifacts into
    a sticky comment marked `<!-- browseros-agent-tests-summary -->`. It skips the post when the PR
    head has moved.

### 3.6 Flakes

- **Trials, not retries:** stagehand runs `--trials 3` and gates on the *mean* score at 0.8, so one
  flaky trial in 15 tasks × 3 models × 3 trials does not fail the PR.
- **No pass^k:** `packages/evals/summary.ts` counts each run as its own pass or fail and turns category
  scores into success/total percentages. Nothing requires all k trials of a task to pass.
- **No retry wrapper** in stagehand CI, and the integration matrix uses `fail-fast: false`.
- **Other repos' approaches:**
  - `browseros-ai/BrowserOS:.github/workflows/test.yml` retries a suite once, with a `::warning::`
    annotation and a fresh JUnit file per attempt. Two failures in a row still fail the job.
  - `browser-use/browser-use:.github/workflows/test.yaml` wraps tests in `nick-fields/retry@v3` with
    `max_attempts: 1` (effectively no retry) and a hard `timeout-minutes: 4`.
- **No quarantine list** in any repo examined.

### 3.7 Caching

- `.github/actions/setup-node-pnpm/action.yml` caches pnpm through `actions/setup-node`
  (`cache: pnpm`) and installs with `pnpm install --frozen-lockfile --prefer-offline`.
- It restores `.turbo` keyed on hashes of the lockfile, workspace, package and turbo files plus
  `github.sha`, with a prefix restore key. The `build` job saves that cache.
- **Build once, reuse everywhere:** later jobs download `build-artifacts` (`use-prebuilt-artifacts: true`).
- Every third-party action is pinned to a full commit SHA.
- Two cache patterns elsewhere:
  - browser-use keys the Playwright Chromium cache **by week**
    (`browser-use/browser-use:.github/workflows/test.yaml`, `date +%Y-W%U`).
  - BrowserOS keys its browser download on the remote ETag (`test.yml`, "Resolve BrowserOS cache key").

## 4. What to take from other repos

**webbrain** (`webbrain-one/webbrain`) is a new MV3 agent extension with a live-scenario design worth
copying:

- **Extension e2e with a scripted LLM**
  (`test/quality/integration-mv3.mjs`, run by `test:shard:browser-b1` in `package.json`):
  - `chromium.launchPersistentContext(tmpProfile, { headless: true, channel: 'chromium', args: ['--disable-extensions-except=<ext>', '--load-extension=<ext>'] })`.
  - Waits for the `serviceworker` event and reads the extension id from the worker URL.
  - Opens `chrome-extension://<id>/src/ui/settings.html` as a harness page and sets
    `chrome.storage.local`.
  - A **loopback `http.createServer` implements `/v1/chat/completions`** and returns scripted tool
    calls, while the browser actions stay real.
  - It asserts on the requests the page under test actually received (`/submit`).
- **Scenario catalog** (`ci/catalog/scenarios.json`): each scenario has `id`, `pack`, `start_url`, a
  templated `task`, a JSON `output_schema`, weighted `verify.result` checks
  (`equals` / `contains` / `matches` with a `weight`), `finalUrlHost` and `timeout_ms`.
- **Packs** (`ci/README.md`): public-site coverage is limited to read-only tasks. State-changing tasks
  run only against an owned, resettable lab, and the lab's server-side events
  (`login_succeeded`, `post_created`) are a third grading signal.
- **Grading from the trace** (`ci/lib/grader.mjs`):
  - `toolCalls()` pairs `tool_call` and `tool_result` updates.
  - `inferStuckAt()` classifies a failure as `setup`, `planning`, `navigation`, `execution`,
    `user_handoff`, `verification`, `artifact_capture` or `cleanup`. That answers "where did it stop?"
    as well as "did it pass?".
- **Workflow mechanics** (`.github/workflows/cloud-e2e.yml`):
  - Dispatch inputs: `pack` (choice), `concurrency` and `scenario`.
  - `timeout-minutes` is sized to the worst-case pack, because a job killed mid-run leaks the browser
    session.
  - `upload-artifact` with `if: always()` keeps traces, recordings and rubrics for 14 days.
  - `webbrain-cloud-smoke.yml` appends `summary.md` to `$GITHUB_STEP_SUMMARY`.
  - Trace exporters: `scripts/trace-to-otlp.mjs` and `scripts/trace-to-atif.mjs`.

**lightpanda** (`lightpanda-io/browser:.github/workflows/agent-regression.yml`) is the scheduled live
tier:
- A nightly `cron: "37 3 * * *"` deliberately "offset from wpt's 02:21 nightly".
- `workflow_dispatch` takes a `model` input.
- It reuses the exact build artifact that gates PRs.
- Its step comment notes that "news.ycombinator.com often blocks datacenter IPs", so an optional
  residential proxy secret is used.
- It strips ANSI codes from the log and posts it to Slack with an `if: !cancelled()` summary line.

**page-agent** (`alibaba/page-agent:.github/workflows/main-ci.yml`) shows the trusted-runner split.
PR CI stays on GitHub-hosted runners (`ci.yml`), and code already on main runs on the **self-hosted**
runner `runs-on: page-agent-trusted`. That is how anything needing real sessions or secrets can run on
the user's machine without running untrusted PR code there.

## 5. The design adapted for nanobrowser-v2

These are proposals, not decisions. The open questions are in section 6.

```
.github/workflows/ci.yml            on: pull_request (+labeled), push: main, workflow_dispatch
  changes        dorny/paths-filter → extension / host / agent / evals / docs-only      [stagehand ci.yml]
  check          pnpm install --frozen-lockfile; fmt+lint+typecheck; vitest unit (agent graph, host
                 protocol framing); cancel-after-check-failure                           [stagehand]
  build          build extension dist + native host once; upload artifact (retention 1d)  [stagehand]
  e2e-extension  setup-chrome-verified (smoke-launch --headless=new);                    [stagehand action]
                 load dist with EITHER Playwright launchPersistentContext(channel:'chromium',
                 --load-extension) [webbrain] OR Chrome stable + --enable-unsafe-extension-debugging
                 + CDP Extensions.loadUnpacked [stagehand cdpClient.ts];
                 register the native-messaging host manifest in the temp profile;
                 loopback /v1/chat/completions scripted Leader/Follower replies [webbrain];
                 fixture pages served locally; matrix from a checked group map with
                 fail-fast:false [stagehand scripts/test-integration.ts]; JUnit/CTRF upload
  regression-evals  internal PRs only; skip label `skip-evals`; free models from
                 vars.EVAL_MODELS (default the nemotron pair); --trials 3; concurrency 1–2
                 (free-tier rate limits); owned mirrored eBay pages (static snapshot like
                 stagehand-eval-sites); score from run telemetry; gate on mean ≥ threshold +
                 "no browser tool calls ⇒ fail" [stagehand verifier-gates.md]; step summary +
                 sticky PR comment [BrowserOS/browser-use]

.github/workflows/live.yml          on: schedule (nightly, off-peak) + workflow_dispatch(pack, trials, scenario)
  runs-on: self-hosted trusted runner on the user's machine, main only     [page-agent main-ci.yml]
  read-only eBay pack (search, filter, read listing, compare) from a scenarios.json catalog with
  weighted checks + stuck_at classification [webbrain ci/]; k trials per task and report BOTH
  mean pass rate and pass^k (all k passed) — neither repo reports pass^k, so we compute it;
  cost/usage recorded as reported|computed|unavailable, never 0 when unknown [stagehand costEstimate.ts];
  report-only (no gate) at first; upload traces/run-logs/summary.md (if: always(), 14d);
  timeout sized to the worst-case pack; concurrency group with cancel-in-progress:false
```

Caching: pnpm through setup-node, a turbo/vite cache keyed on the lockfile, and the Chrome for Testing
or Playwright Chromium download keyed by week, as browser-use does.

## 6. Questions to investigate (not decided here)

1. **The native host in CI.** None of these repos has a native-messaging host. Our host attaches the
   OpenRouter key, so CI needs either a real host process with the key as a runner secret, or a stub
   host for the mock-LLM tier. Which tier gets which?
2. **Branded Chrome or Chromium for e2e.** Stagehand's CDP `Extensions.loadUnpacked` route works on
   Chrome stable. webbrain's `--load-extension` route uses `channel: 'chromium'`. Does our side panel
   behave the same in both, and under `--headless=new`, or do we need xvfb (BrowserOS pattern)?
3. **Logged-in live tasks.** GitHub-hosted runners have none of the user's sessions. Should the live
   pack run on a self-hosted runner with the user's real profile (CLAUDE.md: "every run as acting as
   them"), or on a dedicated test profile?
4. **Free-model limits.** Do the free nemotron models' rate limits fit 3 trials × N tasks on every PR,
   or should the PR tier use a smaller trial count than the nightly tier?
5. **Threshold.** Stagehand gates at 0.8 mean over 3 trials. What threshold, and which
   metric (mean or pass^k), should gate our regression tier?
