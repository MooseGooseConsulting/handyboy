# How browser-agent extensions test themselves end to end

Researched 2026-10-11 by reading source through `gh api` (no clones), plus Exa only for finding repos.
Every claim says where it comes from. **[code]** means I read the source file. **[docs]** means
README/markdown only. "Pre-removal ref" means a commit before the code was deleted.

Context: nanobrowser-v2's live tests today are 8 small local fixture pages, one tab each,
scored by hand-written checks.

---

## 1. BrowserOS (browseros-ai/BrowserOS): the most serious harness found, and it was **unshipped**

BrowserOS is a Chromium fork. The agent runs in a local Bun server (`packages/browseros-agent/apps/server`)
that the browser and extension talk to over MCP and CDP.

### 1a. The eval app, `packages/browseros-agent/apps/eval` (deleted 2026-07-13)

- [code] It was deleted in commit `a28fe086a1` "chore: unship eval app (#1796)". I read it at the parent
  `86c31d799b`. The weekly CI job had been removed four days earlier (`242f1a2679` "chore: disable weekly
  eval workflow"). The workflow is readable at `3b5027ea11`.
- **Browser** [code] `src/runner/browseros-app-manager.ts` launches the BrowserOS binary directly with
  `--user-data-dir=${mkdtempSync('/tmp/browseros-eval-')}`, `--remote-debugging-port`, `--window-size=1440,900`,
  optional `--headless=new`, and optional `--load-extension` (used only for the NopeCHA captcha extension). Each
  worker gets its own Chrome and its own port block (`base + workerIndex`). `killApp()` sends SIGTERM, then
  SIGKILL, then runs `lsof -ti:port | xargs kill -9`, then `rmSync(tempDir)`. It never uses the user's real profile.
- **Isolation** [code] `configs/suites/agisdk-daily-10.json` sets `"restartBrowserPerTask": true`, and the weekly config sets
  `restart_server_per_task: true`, so every task gets a fresh browser and a fresh profile.
- **Tabs** [code] `src/runs/task-run-pipeline.ts`: `resolveInitialPageId()` assumes "fresh browser has exactly one
  page". It resizes the viewport, navigates that page to `start_url`, runs the agent, then in `finally`
  navigates to `about:blank`. There is no multi-tab bookkeeping, because the whole browser is thrown away.
- **Tasks / datasets** [docs, README table; files present in tree] `agisdk-daily-10` (10), `agisdk-real` (36,
  action-only), `webvoyager` (643), `mind2web` (300, Online-Mind2Web), `webbench-*-50`,
  `webarena-infinity-hard-50`, `browsecomp-*-50`. [code] `data/agisdk-daily-10.jsonl`: these tasks run against
  **clone sites** (`https://evals-dashdish.vercel.app`, `evals-fly-unified`, `evals-udriver`), REAL-Bench copies of
  DoorDash, United and Uber. Each row carries `graders`, `start_url`, and metadata `difficulty`/`challenge_type`.
- **Scoring: three graders** (`src/graders/registry.ts`):
  1. `agisdk_state_diff` [code] `src/graders/benchmark/agisdk-state-diff.ts`: deterministic. It navigates the
     browser to `${origin}/finish`, polls for a `<pre>` holding JSON, and feeds `{task_id, env_state,
     model_response}` to `src/graders/python/agisdk-evaluate.py`, which returns `reward`, `pass` and `per_criterion`.
     The site itself reports what changed in its backend state, and the grader compares that with what the task asked for.
     Every input and output is saved as a grader artifact (`finish-state.json`, `evaluator-input.json`,
     `evaluator-output.json`, `stderr.txt`).
  2. `infinity_state`: a WebArena-Infinity verifier script. Per [code] `task-run-pipeline.ts`, a fresh app server
     is started per task (`InfinityAppManager.startApp`).
  3. `performance_grader` [code] `src/graders/performance/performance-grader.ts` + `axes.ts`: an **agentic
     LLM judge**. It is the Claude Agent SDK `query()` with `allowedTools: ['Read','Glob','Grep']`, `cwd` set to the
     task output dir, and a JSON-schema output. Defaults: `DEFAULT_MODEL='claude-opus-4-5-20251101'`, pass
     threshold 75, max turns 100. Six weighted axes: task_completion 0.3, reasoning_quality 0.2, efficiency 0.2,
     speed 0.1, error_recovery 0.1, autonomy 0.1. The prompt tells the judge to grep `messages.jsonl` for
     `tool-input-available` (the action sequence) and `tool-output-error`. It should check claimed values against
     DOM text in `tool-output-available` lines, and view only 3–5 screenshots (the first, the last, and key decision points).
     The composite score is computed in code from the axis scores.
- **Trace / artifacts** [docs, README "Output"; code `src/capture/*`]: per task, `messages.jsonl`
  (`MessageLogger.logStreamEvent` appends every UI stream event with an ISO timestamp and the matching
  screenshot number), `screenshots/NNN.png` (`ScreenshotCapture.capture` runs after each tool, over CDP or MCP),
  `metadata.json`, `attempt.json`, `grades.json`, `grader-artifacts/`, plus a run-level `summary.json`.
  [code] `src/reporting/task-metrics.ts` aggregates steps, tool calls and tool errors per tool, token usage,
  criteria passed/"softened", and termination reason. Runs are published to Cloudflare R2 with a static
  `viewer.html?run=<id>` and a versioned `manifest.json` (schemaVersion 2). There is no OpenTelemetry,
  LangSmith or Laminar. [code] The eval `package.json` lists no tracing deps, and the server has `@sentry/bun`
  and `posthog-node` only.
- **Resume** [code] `hasExistingGraderResults()` skips tasks that already have grades.
- **Repeated trials: none.** [code] The suite schema (`src/suites/schema.ts`) has `workers`,
  `restartBrowserPerTask` and `timeoutMs`, but no trials or repeats. Each task runs once, with a 30-minute default timeout.
- **CI** [code] `.github/workflows/eval-weekly.yml` @ `3b5027ea11`: cron `0 6 * * 6` (Saturdays), plus on push to
  `apps/server/src/agent/**` or `src/tools/**`. It installs the BrowserOS .deb, pins `agisdk==0.3.5` ("so silent upstream
  releases can't shift task definitions or grader behavior"), runs `xvfb-run … suite --config
  configs/legacy/browseros-agent-weekly.json` (Kimi K2.5 via OpenRouter, 3 workers, 36 agisdk-real tasks),
  generates a Claude-written `report.html`, publishes to R2, and builds a trend report (`scripts/weekly-report.ts`).
- Agent variants under test [docs]: `single`, `orchestrator-executor` (orchestrator LLM plus an executor that is
  another LLM or the "Clado" visual action model), and `claude-code` (an external `claude -p` given the BrowserOS MCP).
  The same suite can run against many "variants" (`EVAL_VARIANT`).

### 1b. What BrowserOS tests today (current HEAD)

- [code] **Tool contract suite** `packages/browseros-agent/contracts/claw-mcp/`: 21 local fixture pages
  (`fixtures/pages/{form,iframe,overlay,injection,dialog,upload,scroll,snapshot-frame-*,…}.html`), served by
  `fixtures/server.ts` as a **primary + secondary origin pair** (`ctx.fixture` / `ctx.fixture2`, used for cross-origin cases).
  Cases are named sentences (`cases-tabs.ts`: "tabs: active reports the user tab, never an agent-opened page").
  **Tab ownership** [code] `tests/rust-conformance.test.ts`: `ctx.openPage()` pushes every page it opens onto
  `run.openedPages`. `cleanupCase()` closes exactly those after each case ("Close pages a case opened so the
  next case starts from a clean browser"). `teardownRun()` kills the browser and `rm`s the scratch dir. `run.ts`
  exits 0 when `BROWSEROS_BINARY` is unset, and supports `--smoke` (cases flagged `smoke: true`) and JUnit output.
- [code] **Server tests** `apps/server/tests/__helpers__/with-browser.ts` / `browser.ts`: one cached real
  BrowserOS process per test run behind a mutex, `--user-data-dir` from a test runtime plan, and
  `rmSync(userDataDir)` on teardown. `apps/server/tests/agent/compaction-e2e.test.ts` exists, but there is no
  agent-quality eval.
- [code] **CI** `.github/workflows/test.yml`: computes the affected suites (`ci/affected-suites.ts`), downloads the BrowserOS
  AppImage, wraps it in `xvfb-run`, runs each suite with `BROWSEROS_BINARY` set, uploads JUnit, gates on "every suite
  passes or is skipped", and posts a sticky PR comment with the counts.
- [docs] **Dogfood with a copy of the real profile** `tools/dogfood/README.md`: "It imports your normal
  BrowserOS profile into a target-specific dogfood profile", keeping it separate from the normal app state. Code is in
  `tools/dogfood/profile/import.go` and `cmd/refresh_profile.go` (not read in detail). This is their answer to
  "real sessions without touching the real profile".

## 2. Taxy AI (TaxyAI/browser-extension, 1.3k stars, last push 2025-01-15)

**No e2e, no evals.** [code] There are two Jest unit tests (`src/helpers/parseResponse.test.ts`,
`src/helpers/shrinkHTML/templatize.test.ts`). `.github/workflows/main.yml` only builds, packages, signs and releases.
[docs] The README calls it a "research preview. Many workflows fail or confuse the agent."

## 3. alibaba/page-agent (29k stars, active)

**No automated agent e2e. It uses a manual "agentic testing" checklist against real public sites.**

- [docs] `docs/agentic-testing/README.md`: "Interactive browser test checklists for a harness with **computer use
  and vision**, such as Codex." Results are reported as revision, browser, case ID, target, `PASS/FAIL/BLOCKED/NOT RUN`
  and evidence, compared against the previous revision.
- [docs] `docs/agentic-testing/actions.md`: 11 cases on **real live pages**: Bing suggest/submit, AntD Select/Tree,
  Element Plus Select/Menu/DatePicker/Scrollbar, Quill, MUI Autocomplete, Radix Select. Each targets the widget
  regression behind a specific PR/issue (#378, #336, #179, #390). It calls the built action functions on DOM
  elements, without the LLM.
- [code] `packages/llms/src/models.live.test.ts`: a `*.live.test.ts` convention excluded from `npm test` (run with
  `npm run test:live`). It checks that every listed model, on every provider, accepts the request shape, with a forced trivial tool
  call. "Not a correctness/quality eval". Tests the raw client "so no retry can mask it". Skips when `TESTING_*_KEY`
  is missing. Rule: "A model a provider serves but rejects is not supported there … Never skip it."
- [code] `packages/extension/src/agent/TabsController.test.ts`: white-box unit test with a stubbed `syncTabs`.
  Runtime tab ownership [code] `TabsController.ts`: agent tabs go into a tab group (`createTabGroup`,
  `add_tab_to_group`), and `closeTab` refuses the initial user tab ("Cannot close the initial tab").
- CI [code] `.github/workflows/ci.yml` runs `node scripts/ci.js` (lint/unit).

## 4. Browser Use

- There is **no official open-source Chrome extension**. [docs] browser-use is a Python library plus CLI. Third-party wrappers
  exist (e.g. `AgenticA5/A5-Browser-Use`).
- [code] `browser-use/browser-use` `tests/ci/conftest.py`: `create_mock_llm(actions)` (an `AsyncMock` that returns
  scripted actions) plus `pytest_httpserver` local pages. About 65 CI tests cover browser/DOM/interactions/security.
- [code] `tests/agent_tasks/*.yaml` (e.g. `amazon_laptop.yaml`): `task`, `judge_context` (a list of success
  criteria), and `max_steps`. They are judged by an LLM (`tests/agent_tasks/README.md`, `tests/ci/evaluate_tasks.py`). Only 2 tasks, on real sites.
- [code] `.github/workflows/eval-on-pr.yml`: on PRs from members it POSTs the commit SHA to a **private** eval
  platform (`secrets.EVAL_PLATFORM_URL … /api/triggerInteractionTasksV6`, test case `InteractionTasks_v8`). The real
  eval is closed.
- [code] **`browser-use/benchmark`** (public): BU Bench V2.1 is 200 real-web tasks shipped **encrypted**
  (`BU_Bench_V2.enc`) "to keep their text out of web crawlers and model training data". It is scored by a
  **findings judge** against weighted per-task rubrics (`evaluation.py`: "Judge once against the full rubric;
  calculate weighted scores in code"). `_validate_findings_coverage` "Fail[s] closed if the structured judge omits or repeats
  a rubric item". `judge_config()` records the judge model and the **sha256 of the judge source and the screenshot-evidence
  source**. `judge_input.json` / `judge_response.json` are saved per task. A separate
  `BU_Bench_V2_review_cases.enc` holds "Judge review scenarios" used to validate the judge itself. `RUBRIC_REVISION.md`
  versions every task change and says historical scores are not comparable across revisions. Browsers are pluggable
  (`browsers/local_headful.py`, `browserbase.py`, `steel.py`, …).

## 5. Closed source (skipped)

HARPA, MultiOn, Jace, Fellou (the product), Perplexity Comet, OpenAI Atlas, and Claude in Chrome publish no extension
source. Fellou's open framework **FellouAI/eko** [code] has `packages/eko-core/test/**`. The "tests" are
demo scripts that call a real LLM and `console.log` the result, with no assertions (e.g.
`test/core/eko.test.ts`, `run()` → `eko.run("Read the desktop file list")`).

## 6. Other open-source agentic extensions with real e2e or evals

### 6a. microsoft/playwright: the Playwright MCP Chrome extension (the closest analogue for tab ownership)
- [code] `tests/extension/extension-fixtures.ts`: `chromium.launchPersistentContext(testInfo.outputPath(
  'extension-user-data-dir'), { channel, headless: false, … })` loads the built extension. It skips when the
  channel is official Chrome: "--load-extension is not supported for official builds of Chromium". It also pre-creates
  `Default/Extensions/<id>`.
- [code] `tests/extension/tab-grouping.spec.ts`: **a tab group is the ownership boundary**. Test names:
  "connected tab is in green Playwright group, connect page is closed", "tab added to group gets auto-attached",
  "tab removed from group gets auto-detached", "connected tab is removed from group on disconnect",
  "tab is re-added to Playwright group after reconnecting". `tab-management.spec.ts`: "window.open from tracked tab
  auto-attaches new tab", "pending attach is released when the connection closes".
- Pages come from a local test server (`server.HELLO_WORLD`, `server.setContent`). There is no LLM: these are protocol and tool tests.

### 6b. web-infra-dev/midscene (15k stars): Chrome extension plus SDK, with **real-model e2e on every PR**
- [code] `.github/workflows/ai.yml` "AI - Playwright e2e": on push and PR, with `MIDSCENE_MODEL_*` secrets and
  `MIDSCENE_MODEL_RETRY_COUNT: "2"`, it runs `playwright test --config=tests/playwright.config.ts`.
- [code] `packages/web-integration/tests/playwright.config.ts`: `retries: CI ? 1 : 0`, `workers: 3` ("limited by API
  rate"), `trace: 'on-first-retry'`, 900 s timeout. Specs in `tests/ai/web/playwright/*.spec.ts` mix local
  `__fixtures__/*/index.html` with **saucedemo.com**, a public demo store built for testing (`ai-shop.spec.ts`).
- Scoring [code]: natural-language `aiAssert('the page title is "Swag Labs"')` (a vision-LLM judge on each step),
  plus `aiQuery` returning typed JSON that is checked with `expect(...)`. `sauce-demo.test.ts`: `expect(pw).toBe('secret_sauce')`.
- **Plan caching** [code]: `cacheId` per agent, with `MIDSCENE_CACHE=true` scripts (`e2e:cache`). Recorded plans
  replay without model calls.
- **Bridge mode in the user's real Chrome** [code] `tests/ai/bridge/agent.test.ts`: `describe.skipIf(!!process.env.CI)`.
  `AgentOverChromeBridge` drives the installed extension in the developer's own Chrome:
  `connectNewTabWithUrl('https://www.bing.com')`, `connectCurrentTab()`, then `agent.destroy()`. It is manual-only.
- Reports: Midscene's own HTML replay report (`MIDSCENE_REPORT`, `apps/report/e2e`).

### 6c. uiuing/browser-agent (48 stars, 2026-07): small but has the cleanest layered design
- [code] `packages/e2e/src/ext-launch.ts`: `buildTestExtension()` builds with `VITE_USE_MOCK=1`, so the
  planner resolves a **deterministic MockProvider** and the full chat and tool loop runs with no key.
  `buildProdExtension()` exists because "a leftover test build silently routes to the MockProvider … and the real
  model never gets called". It prefers Playwright's full Chromium "to avoid the system-Chrome singleton hand-off
  (which closes the automation context)".
- [code] `packages/e2e/src/real-llm.ts`: production build plus a real endpoint. The provider is seeded by
  `chrome.storage.local.set` from the `options.html` page, "in a throwaway profile — never written to disk". It also
  "proves cross-window smart targeting — the page under automation lives in a SECOND, unfocused Chrome window".
- [code] `packages/e2e/src/real-sites.ts`: 3 real sites (Bing, httpbin `/html`, httpbin `/forms/post`). Each
  `Scenario` has `urls` (fallback candidates "survives regional blocking"), a **Playwright-side `truth(page)`** that
  reads the DOM after the run, and an optional `answerCheck` regex on the final answer. Sites are "public,
  login-free and side-effect-free". Each scenario has a 330 s budget.
- [docs] `docs/benchmark.md` (from `packages/bench/src/run-bench.ts`): **6 repetitions per scenario** on fixtures,
  compared with a deliberately weak in-repo baseline (`baseline.ts`). Scenarios include a **fake-success** page ("page pops a
  success toast but persists nothing"), injected flakiness, a below-the-fold field, and batch "reported == actually
  persisted". Ground truth is the DOM, not the agent's report.

### 6d. softpudding/OpenBrowser (189 stars): instrumented mock sites, scored by events, with cost and time budgets
- [docs] `eval/README.md`: 11+ hand-built mock sites (Amazon, Booking, Airbnb "StayBnB", Trello "TaskFlow", Google Maps
  "MapQuest", an Aliyun-style console with **timed spam popups**, a Finviz screener, a Xiaohongshu feed, and others). Every site loads a
  shared `tracker.js` that POSTs semantic events (`filter_modal_open`, `price_slider_change{handle:"min"}`, …) to
  `/api/track`. Sites emit synthetic `*_select` events for pre-selected defaults "so criteria don't require a redundant click".
- [code] `eval/dataset/staybnb_book.yaml`: `instruction`, `start_url` on localhost, `time_limit: 600`,
  `cost_limit: 2.0`, and `criteria[]`, each with `points` and an `expected` event shape. Partial credit comes from points.
- [code] `eval/evaluate_browser_agent.py`: it drives the **real Chrome extension** through a capability token
  (`--chrome-uuid`). `total_score = score + efficiency_score + usage_score`, where efficiency is time against the limit and usage
  is cost against the limit (`_calculate_efficiency_score`, `_calculate_usage_score`). **Managed-tab cleanup**:
  `get_managed_tabs(conversation_id)` and `cleanup_managed_tabs()` close every tab the agent's conversation opened.
  **API-stall detection**: after a timeout, if any observation→action gap is over 60 s, the test is re-queued up
  to 3 times (`detect_api_stalls`, `API_STALL_MAX_RETRIES`), so provider stalls don't count as agent failures.
  The server boots on `--port=0`. Comparison runs across `--model-alias` values.

### 6e. browserbase/stagehand (library, not an extension; included because it is the reference eval harness)
- [code] `packages/evals/evals.config.json`: `"trials": 3` by default, concurrency 10, and benchmark limits of 25 tasks each for
  webvoyager, onlineMind2Web, webtailbench and odysseysbench. `-t, --trials <n>` [docs README].
- [code] `scoring.ts`: `exactMatch` / `passRate` for deterministic tasks. `framework/verifierAdapter.ts`: a rubric-based
  `V3Evaluator` judge with **verdict gates** (`applyVerdictGates`, `resolveRequireGrounding`). It persists both the gated
  verdict and the raw `judge` verdict, plus `processScoreStrict` / `processScoreLenient`.
- [docs] Traces stream to **Braintrust** when `BRAINTRUST_API_KEY` is set. `evals experiments` diffs runs.

### 6f. Checked and found nothing agent-level
- hangwin/mcp-chrome (12k stars) [code]: `app/chrome-extension/tests/record-replay-v3/*.test.ts`. Its
  "e2e.integration" test is service-level with `fake-indexeddb` (file header), with no browser and no LLM.
- AIPexStudio/AIPex [code]: `packages/browser-runtime/src/automation/__tests__/puppeteer-test-utils.ts` is a
  **`chrome.debugger` shim over Puppeteer** ("testing CDP-based automation code without requiring a real Chrome
  extension environment"). It runs the extension's CDP code against plain Puppeteer pages, which is a useful trick but not an agent eval.

---

## Cross-cutting answers

| | Real sites or fixtures | Browser | Tabs | Scoring | Trials | Traces | CI? |
|---|---|---|---|---|---|---|---|
| BrowserOS eval (dead) | clone sites (REAL/agisdk), WebArena-Infinity local apps, live WebVoyager/Mind2Web | own binary, fresh tmp profile per task | fresh browser, single page, `about:blank` after | site `/finish` state diff + Python checker; agentic Claude judge over JSONL + screenshots | 1 | messages.jsonl + per-step PNG + metadata → R2 viewer | weekly cron, then removed |
| BrowserOS contracts | 21 fixture pages, 2 origins | real binary, tmp profile, xvfb | track opened pages, close per case | assertions | 1 | JUnit | every PR |
| page-agent | real public widget sites | whatever a computer-use agent has | n/a | human/vision checklist | 1 | manual report | manual |
| Playwright MCP ext | local test server | persistent context + extension (not Chrome stable) | tab group = owned | assertions | 1 | Playwright | yes |
| midscene | fixtures + saucedemo + manual bridge to real Chrome | Playwright/Puppeteer; bridge in real Chrome | per-test page | `aiAssert` vision judge + typed `aiQuery` + expect | CI retry 1 | HTML report, PW trace on retry | every PR, real model |
| uiuing/browser-agent | fixtures + 3 safe real sites | PW full Chromium + extension, throwaway profile | 2nd unfocused window | Playwright DOM truth + answer regex | bench ×6 | reporter | local |
| OpenBrowser | 11+ instrumented mock sites | real Chrome extension | per-conversation managed tabs, closed after | event criteria with points + time/cost scores | stall re-queue ≤3 | SSE events, cost | local |
| browser-use bench | 200 real-web tasks (encrypted) | pluggable (local/cloud) | — | weighted rubric findings judge, fail-closed, hashed judge | not verified | judge in/out JSON | GH Actions |
| Stagehand | public benchmarks | local or Browserbase | — | exact match / rubric judge + gates | 3 default | Braintrust | yes |

## What nobody does (from the code read)

1. **Nobody runs evals in the user's real, logged-in profile.** BrowserOS's eval uses `mkdtemp` profiles, and its dogfood tool
   *copies* the profile. Midscene's bridge-to-real-Chrome tests are `skipIf(CI)` smoke checks with no scoring. OpenBrowser
   drives the real extension, but only against localhost mock sites.
2. **Nobody scores repeated trials as pass^k or a variance figure.** Stagehand runs 3 trials and uiuing runs 6 repetitions.
   BrowserOS, midscene and OpenBrowser run once (with retries for flakiness). No code I read reports pass^k or a confidence interval.
3. **No OpenTelemetry / Laminar / LangSmith** in any extension. Traces are custom JSONL plus screenshots (BrowserOS), SSE
   logs (OpenBrowser), Braintrust (Stagehand, a library), or HTML replay reports (midscene).
4. **No one tests the user-sharing case of the agent's tabs among the user's own tabs with a scored LLM run.** BrowserOS's contract
   case "tabs: active reports the user tab, never an agent-opened page" and Playwright's tab-group specs test it at the
   tool level only, without a model.
5. **No one validates their LLM judge against human labels in CI**, except browser-use/benchmark's encrypted
   "judge review cases". BrowserOS's judge was opus-4-5 with a threshold of 75 and no calibration set in the tree.
