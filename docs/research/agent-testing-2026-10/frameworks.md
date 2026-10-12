# How browser-agent frameworks evaluate their agents on live sites

Research date: 2026-10-11. Source: GitHub repos read through `gh api .../contents` (no clones), plus a few
first-party blog posts found with Exa. Every claim is tagged:

- **[code]**: I read it in a source file (repo + path given).
- **[repo-doc]**: README or doc file inside the repo.
- **[blog]**: a first-party post or conference talk, read through Exa. Its numbers are as the vendor reported them and I have not reproduced them.

Sources were read through the GitHub API on 2026-10-11 (default branch unless a commit is named); local copies were not kept.

---

## 1. browser-use (browser-use/*)

browser-use runs four separate eval systems at different levels.

### 1a. PR-level CI smoke: `browser-use/browser-use` `tests/ci/evaluate_tasks.py` [code]
- **Task format.** One YAML file per task in `tests/agent_tasks/*.yaml`, with fields `name`, `task`, `judge_context` (a list of success criteria) and `max_steps` (10–15). Example from `tests/agent_tasks/amazon_laptop.yaml`: "Go to amazon.com, search for 'laptop', and return the first result". Its criteria are "must navigate to amazon.com", "must search for 'laptop'" and "must return name of the first laptop".
- **Sites.** Real sites (amazon.com).
- **Judging.** A text-only LLM judge, `gemini-3.1-flash-lite`. It sees the task, the final output, a debug line ("Steps: N, Final result length…") and the criteria. Its prompt is "You are a evaluator of a browser agent task inside a ci/cd pipeline… Reply in JSON with keys: success, explanation". The judge sees no screenshots.
- **Isolation.** Each task runs in its own Python subprocess with `BrowserProfile(headless=True, user_data_dir=None)`, meaning a fresh temporary profile. `session.kill()` runs in both the success and the error path.
- **Concurrency.** `MAX_PARALLEL = 10`. The run exits 1 only if 0% of tasks pass, so this is a smoke gate, not a quality gate.
- **Missing keys.** Without API keys the tasks are marked `success: True` ("Skipped – API key not available"), so fork PRs don't fail.
- `.github/workflows/eval-on-pr.yml` [code] also POSTs every PR's commit SHA to a private eval platform (`/api/triggerInteractionTasksV6`, test case `InteractionTasks_v8`). The workflow runs only for PRs from the OWNER, MEMBER or COLLABORATOR association.

### 1b. Fixture "interaction tasks": `browser-use/stress-tests` [code]
- `InteractionTasks_v8.json` defines the PR suite. Each task has `task_id`, `name`, `confirmed_task` (instruction plus URL), `category` (e.g. `CORE_INTERACTION`) and `ground_truth: "successfully"`.
- The pages are static challenges on GitHub Pages under `challenges/*.html`: radio buttons, checkboxes, sliders, date pickers, shadow DOM, nested iframes, contenteditable, canvas CAPTCHA, a flight-booking flow, and React, Angular, Ember and Material UI forms.
- The README [repo-doc] says: "All forms will display `the secret is: dumbledore` upon successful submission to make evals easy to validate". The forms also include red-herring modal buttons and honeypot fields.
- **Takeaway.** Even browser-use keeps a deterministic fixture tier for widget coverage and puts it in the PR gate. The real-site tasks are a separate tier.

### 1c. Public benchmark: `browser-use/benchmark` [code]
- **Tasks.** BU Bench V1 has 100 tasks, encrypted (`BU_Bench_V1.enc`): 20 custom, 20 WebBench, 20 Mind2Web-2, 20 GAIA and 20 BrowseComp. The task fields are `task_id`, `confirmed_task`, `category` and `answer`. The README [repo-doc] says they were "hand-selected for difficulty and verified to be achievable". V2.1 has 200 tasks, each carrying an inline `rubric` and `weights` (item ids whose weights sum to 100) and a `canary` token. The tasks are encrypted "to keep their text out of web crawlers and model training data".
- **Judge V1** (`judge.py`) [code] is a binary verdict. It takes the task, an optional `ground_truth`, the trajectory text (truncated to 40k), the final result, and the **last 10 deduplicated screenshots**. It returns JSON `{reasoning, verdict, failure_reason, impossible_task, reached_captcha}`. Key rubric lines:
  - "be initially doubtful of the agent's self reported success"
  - "If the task asks to complete an action on the page, and the agent reports that the action is completed but the screenshot or page shows the action is not actually complete: false"
  - "The agent made up content that is not in the screenshot or the page state" leads to false.
  - "Blocked by captcha or missing authentication" leads to false.
  - `impossible_task` should be set only for "Website genuinely broken… (be conservative – temporary issues don't count)".

  The same prompt ships inside the library: `browser_use/agent/judge.py`, with `Agent(use_judge=True)` as the default. `browser_use/agent/service.py` lines 185–256 show that `judge_llm` defaults to the agent's own LLM [code].
- **Judge V2** (`findings_judge.py`, "findings judge") [code]. The judge emits **one finding per rubric item**: `met`, `violated` or `not_assessable` (with reason `missing_evidence` or `absent_scope`), each with its evidence written first. The **code** then computes the score as met weight divided by total weight, so "the LLM never sees weights and never scores". Other parts of the design:
  - The structured-output enum is pinned to the task's own item ids, so the judge cannot invent or rename an item.
  - When the judge returns duplicate findings for one item, the worst status wins.
  - **Canary tripwire.** If the agent's output contains the rubric's canary token, which only appears in the answer key, the score is zeroed. This check is deterministic.
  - Flags: `infra_error`, `pii_present` and `reward_hacking_suspected`.

  Prompt rules worth copying:
  - `<evidence_rule>`: "An item is `met` only when the deliverable content is corroborated by trace evidence… Correct-looking data with no extraction evidence is not met. Models can recite public data from memory. Never credit it."
  - `<rubric_rule>`: "Exception: if the run's own evidence shows the site changed after the rubric's date, grade against the run's evidence and state this in the finding". This is how they handle drift.
  - `<completion_rule>`: "An unresolved CAPTCHA, bot block or login wall earns no credit for the work left undone… inability to inspect a source is not evidence of absence."
  - Screenshots are "captured by the harness after browser actions… The agent does not choose or control these images. If a step's claim and its screenshot disagree, trust the screenshot."
  - Agent `thinking:` and `reasoning:` text is removed from the judge's input but kept in saved traces.
- **Runner** (`run_eval.py`) [code]:
  - Each task gets a fresh browser, either a cloud session or a fresh local profile that is closed afterwards.
  - The budget is `asyncio.wait_for(agent.run(max_steps=100), timeout)`. On a timeout the runner **judges the partial history** rather than discarding it.
  - The record is saved as `awaiting_judge` *before* judging, so a run can be re-judged later.
  - A judge or config failure becomes `status=judge_error` and is never scored as zero ("A broken judge/configuration is not an agent score of zero").
  - Per-task metrics are `steps`, `duration` and `cost`. The summary adds `judge_errors`, `execution_errors`, `tasks_with_clipped_evidence` and `rh_zeroed`.
  - Evidence goes into a directory per task: `events.jsonl`, `trace.json`, `judge_input.json`, `judge_response.json`, `screenshots/` plus `screenshot_manifest.json` (mapping screenshots to steps), and `config.json`. That layout is from the README [repo-doc].
- **Concurrency and limits.** The default is 100 concurrent tasks on cloud browsers with 3600 s per task. The README [repo-doc] advises "use a smaller value such as `--parallel 5` to fit your browser capacity or API limits".
- **Drift handling** (`RUBRIC_REVISION.md`) [repo-doc]. Every task revision is dated (e.g. `2026-09-25-reuters-playback`) and the validator pins weight hashes, so "undeclared edits still fail". Historical scores are never regraded, and "Historical task 185 scores are not comparable to the revised task". The guidance is: record the release tag, commit and dataset checksum with your results.
- **Telemetry.** Laminar is optional (`LMNR_PROJECT_API_KEY`) and stores scores and text/tool traces [repo-doc]. JSON results are always written.

### 1d. Variance evidence: `browser-use/browser-use-pi` [repo-doc + code]
- `docs/benchmarks.md` [repo-doc]: "The 91 result was an unstable peak: later original-code repeats scored 79, 85 and 84." It continues: "For a performance claim, freeze SDK SHA, task IDs, model, reasoning, budgets, judge, environment and retries. Run matched arms… A tiny model smoke proves integration, not benchmark parity."
- `eval/run.mjs` [code] does three things:
  - It opens a **separate CDP observer connection** that takes a screenshot after every tool execution (`Page.captureScreenshot` on the active target), so the judge's evidence does not depend on the agent.
  - It appends `events.jsonl` for model messages and tool start/end.
  - It sends **Laminar spans**: a root span, a `pi.model` span per turn with provider, model, input/output tokens and input/output/total cost attributes plus an error status, and a `tool.<name>` span per tool call.
- The result envelope sets `self_reported_success: null` ("A schema-valid finish is not a claim of factual correctness"). Its metrics are steps, duration, input/output/cached tokens and total cost. Its metadata includes `stop_reason`, `compactions`, `provider_retries` and `warnings`.
- Evidence is clipped by keeping the head and tail with an explicit marker: tool input 2,000 chars, tool output 20,000, assistant text 4,000.
- `src/telemetry.ts` [code] sends allowlist-only product telemetry to PostHog: status, steps, duration_ms, tokens and estimated cost, with the comment "Never spread config/results: they contain tasks, paths and credentials". The fetch is best-effort with a 1 s timeout.

### 1e. Older WebVoyager fork: `browser-use/eval` [code + repo-doc]
- `evaluation/auto_eval_browser_use.py` [code] is the WebVoyager judge prompt applied to the **last 4 screenshots** plus the final answer. Its verdicts are SUCCESS, NOT SUCCESS or UNKNOWN ("If you are not sure… choose unknown"). On a rate-limit error it sleeps 10 s and retries.
- README [repo-doc]: "The eval model is not good… We manually reviewed the evaluations for the tasks that are either 'unknown' or 'failed' and corrected them." They also kept a list of impossible (outdated) tasks, moved dates in tasks into the future, ran 15 concurrent tasks, and spent about $250 per full run on GPT-4o. Their verdict on the dataset: "WebVoyager is a terrible dataset… many prompts are VERY ambiguous."

### 1f. Online-Mind2Web runner: `browser-use/online-mind2web` [repo-doc]
- 300 tasks on 136 real sites, run at concurrency 25 by default. The run is **resumable**: tasks that already have a `result.json` are skipped. `--limit 10` gives a smoke test.
- Judging is a binary 0/100 by Claude. Its principles: "Trust extractions only when supported… 'Not found' is a valid answer… No output = fail".

### 1g. Internal platform: `browser-use/mix-eval-go` [repo-doc]
- `analysis/reports/EXECUTIVE_SUMMARY.md` says the eval dataset was the **"PostHog Cleaned Feb 2026" set of 333 tasks drawn from real usage**. It is 60% direct web scraping, and "only 9–11% of tasks genuinely require login credentials".
- `docs/JUDGE.md` says that runner's Claude judge sees only text (task, tool-call count, final response), and lists that as a limitation.

### 1h. Blog posts [blog]
- "How we built scalable evaluation infrastructure" (browser-use.com/posts/our-browser-agent-evaluation-system, 2026-02-23):
  - Tasks are "sourced from millions of LLM-labeled user spans".
  - "Single-run deterministic tests are useless here." They run the same task multiple times and aggregate with statistical bootstrapping.
  - Their judge is gemini-2.5-flash, aligned against **200 hand-labeled traces** for 87% agreement.
  - "simple prompts and absolute True/False verdicts work best. Complex rubrics lead to indecisive judging."
  - The judge is built into the agent and runs after `done`.
  - They have Claude cluster `failure_reason` strings into error buckets every day.
  - Traces go to Laminar and ClickHouse.
- "The Benchmark Behind the Benchmark" (2026-08-05) partly reverses that post. The six findings below are as browser-use reported them:
  - They ran GPT-5.5 five times on 106 tasks. Each run solved about 89, "Never the same 89": 64 tasks passed every time, 2 never passed, and 40 flipped. 104 of 106 passed at least once in five tries.
  - Swapping only the judge moved the same runs from 62.5% to 83.7%.
  - The binary judge amplifies borderline coin flips. They now ask for a percentage score, run the judge 3 times and take the **median** (not the mean, and not an arbitrator, which proved unstable).
  - A/B comparisons are **paired per task**, with a ±5-point tie band.
  - They give the judge a catalog of known failure modes (5,692 entries).
  - "Get the evidence contract right before you touch the prompt": a truncated true claim looks exactly like a hallucinated one.

---

## 2. Browserbase Stagehand: `browserbase/stagehand` `packages/evals/`

- **Tiers** [repo-doc + code] (`packages/evals/README.md`):
  - (a) `bench` tasks. Code files in `tasks/bench/{act,extract,observe}/` (41/26/13 files) are auto-discovered. Each is written with `defineBenchTask({name, tags}, async ({stagehand, page, logger}) => {... return {_success, ...}})`.
  - (b) Dataset suites: WebVoyager, OnlineMind2Web, WebTailBench, Odysseys and HardBench.
- **Sites: mostly clones.** `tasks/bench/act/amazon_add_to_cart.ts` [code] drives `https://stagehand-eval-sites.vercel.app/sites/amazon/`, clicks "Add to Cart" and then "Proceed to checkout", and asserts `currentUrl === ".../sign-in.html"`. `google_flights.ts` uses the same pattern against a cloned Google Flights page. These are **deterministic exact checks on static clones of real sites**.
- **Observation recorder** (`tasks/README.md`) [repo-doc]. It captures a rendered page into a standalone `index.html` with scripts removed, remote assets stripped and a restrictive CSP, so that "passive replay cannot silently depend on the original site". It is for static `extract()`/`observe()` regressions. Their limit, in their words: it "does not… replay click handlers, fetches, navigation".
- **Dataset suites** (`suites/webvoyager.ts`) [code]. Each JSONL row becomes a testcase with metadata (`dataset`, `task_id`, `website`). The default limit is **25 tasks** (`EVAL_MAX_K`), with `EVAL_*_SAMPLE` for random sampling.
- **Defaults** (`evals.config.json`) [code]: **`trials: 3`**, concurrency 10, env `local`, a 25-task limit per benchmark. `--preview` "Print[s] the resolved plan and exit — no browser, no LLM calls".
- **Scoring** (`scoring.ts`) [code]. Braintrust scorers `exactMatch`, `passRate` and `errorMatch` read `_success`.
- **Agent judge** [code]. `V3Evaluator` lives in `packages/core/lib/v3Evaluator.ts` at tag `stagehand-server-v3/v3.7.1` (consumed as npm `stagehand-v3`). Its legacy backend asks a YES/NO question: "You are an expert evaluator that confidently returns YES or NO based on if the original goal was achieved… Today's date is …". It is given screenshots, the agent's reasoning and the answer, and when it has neither screenshots nor an answer it returns an "insufficient evidence" result.
- **Verifier gates** (`docs/verifier-gates.md`) [repo-doc]:
  - A judge pass is rejected when the final answer is empty, or when the trajectory has **no browser tool calls**.
  - The optional `EVAL_REQUIRE_GROUNDING=1` rejects answers whose numeric findings appear on no observed page.
  - Verifier errors or uncertainty **fail closed** ("ungraded, must not be presented as verified").
  - The record keeps `agentReportedSuccess` separately.
  - `processScoreStrict` makes evidence-insufficient criteria score zero.
- **Harness contract** (`docs/harness-contract.md`) [repo-doc]:
  - Budget units differ by harness (tool calls, model steps or turns). "These are execution limits, not comparable measures of model efficiency."
  - "Observed zero is distinct from missing telemetry; missing usage… do[es] not become zero-dollar runs."
  - Costs carry a `cost_source: computed` tag with a dated price map (`pricing/pricing.json`).
- **Date drift** (`framework/taskDates.ts`) [code]: "A hardcoded date in an instruction silently rots… failing as if the agent were at fault." Instructions therefore get computed relative dates such as `previousMonthFirstDayLabel()`.
- **Telemetry** [code]. `package.json` depends on Braintrust, `@braintrust/otel`, OpenTelemetry (OTLP proto exporter) and LangSmith. Supporting files are `framework/otel.ts`, `framework/braintrust.ts` and `framework/costEstimate.ts`. `framework/metrics.ts` records latency timers with min/max/avg/p50/p99.
- **Browser lifecycle** (`framework/benchHarness.ts`) [code]. Each task is wrapped in try/finally with `toolAdapter.cleanup()` and `carrierV3.close()`. Each run logs a Browserbase session URL and debugger URL for replay.
- **Talk** [blog] (AI Engineer, "Your LLM Judge Is a Confident Liar", Browserbase with Microsoft Research):
  - Fara-7B scored 74% under the official WebVoyager GPT-4o judge and 38% under their "Universal Verifier".
  - That verifier generates a rubric of about 10 criteria per task, ranks screenshots **per criterion**, takes the top-K as evidence for each criterion, and outputs both a process score and an outcome boolean.
  - It was validated on held-out human labels: about 50 labels were used for development and 100 held out, each double-annotated, for κ = 0.58, which they report as equal to human–human agreement.
  - The talk also covers why they moved away from deterministic environments: "constant patching, generated static sites, and additional checkpoints".

---

## 3. Skyvern: `Skyvern-AI/skyvern` `evaluation/`

- **Tasks** [code]: `evaluation/datasets/webvoyager_tasks.jsonl`, `webvoyager_reference_answer.json`, `webvoyager_outdated_tasks.jsonl` (7 rows) and `odysseys_tasks.json`. Odysseys is 200 long-horizon multi-site tasks averaging about 6.1 rubric checkpoints each, per `ODYSSEYS_ATTRIBUTION.md` [repo-doc].
- **Drift** [code]. `create_webvoyager_task_v2.py` runs an LLM prompt, `skyvern/forge/prompts/skyvern/check-evaluation-goal.j2`: "If is_booking is True and is_including_date is True, repick a date within the next two months". If the goal changed, it sets `is_updated=True`. The judge prompt `evaluate-prompt.j2` then says: "the correct answer is out of date… as long as the screenshots and the current answer are fulfilled all the task instruction, consider task has been successfully accomplished."
- **Judging** [code] (`evaluation/core/__init__.py`, `_execute_eval`). The inputs are the **final screenshot only** plus extracted info, against a reference answer. The output is JSON `{evaluation_criteria, thoughts, verdict: SUCCESS|NOT SUCCESS}`. A run that is not `completed` is an automatic fail with `failure_reason` recorded. The prompt, screenshot and LLM response are each saved as timestamped artifacts per task.
- **Throughput** [code]. `eval_webvoyager_task_v2.py` has `BATCH_SIZE = 5`, using asyncio.gather over 5 records at a time, and writes a CSV.
- **Results** [repo-doc]. `evaluation/results/webvoyager-<Site>.md` holds one Markdown table per site with a link to every run (id, status, question, Skyvern link, summary, output), so humans can audit them.
- **Telemetry** [code]. Laminar via `skyvern/forge/sdk/trace/lmnr.py`, with a Laminar observability doc.

---

## 4. Magnitude: `magnitudedev/browser-agent` `evals/`

- **Local fixtures** [code]. `evals/basic/site/{scroll,shadow}/index.html` is served on localhost:8080. Tests are written as `test.group('scroll arena', {url}, …) test(\`can find target ${n}\`, ({ai}) => ai.step(...))` (`evals/basic/tests/scroll/scroll.mag.ts`). Magnitude-test is itself a natural-language test runner.
- **WebVoyager on live sites** [code]:
  - `wv-runner.ts` creates a **fresh `chromium.launchPersistentContext("")`** per task at a fixed 1024×768 viewport. The prompt gets "Consider that today is <date>". The task timeout is 20 minutes.
  - Token and cost totals are rewritten to `results/<id>.json` after every action, so a crash leaves a record.
  - Up to **3 retries for infrastructure crashes only** (`net::ERR_ABORTED`, context closed, ECONNREFUSED…). Other failures are not retried.
  - Each task runs in its own process with a 25-minute SIGKILL.
- **Judge** [code] (`wv.ts` `evalTask`). The agent's saved memory, which holds its last 3 screenshots (`screenshotMemoryLimit: 3`), is reloaded into a fresh agent. It is queried with the original WebVoyager prompt and returns `{reasoning, result: SUCCESS|NOT SUCCESS}`.
- **pass@N** [code]. The CLI options `--failed` ("Include failed tasks… useful for pass@N"), `--failed-only` and `--replace` re-run failed tasks into the same results directory. Workers default to 1.
- **Drift** [code]. `data/patches.json` holds 121 entries: **68 rewrites and 53 removals**. Each records `reason`, `prev` and `new`, for example "M3 Max… superseded… updated to M4 Max". `patch_tasks.py` applies them to produce `patchedTasks.jsonl`.

---

## 5. Notte: `nottelabs/open-operator-evals` [repo-doc + code]

- WebVoyager30 is 30 tasks across 15 sites, **each run 8 times** (240 runs per provider) "to account for the high variance". Limits were 6 minutes or 20 steps, in headless mode.
- **Metrics** [repo-doc]:
  - Agent Self-Report.
  - LLM Evaluation (GPT-4 with the WebVoyager prompt).
  - Time per Task.
  - **Task Reliability** (pass@8: "successfully completed at least once across multiple attempts").
  - **Alignment**: the ratio of self-report to judge. browser-use 0.1.40 measured 1.2–1.53, meaning it over-claims success.
  - **Mismatch**: how often the agent claimed success and the judge disagreed.
- **Per-run record** [code] (`WebVoyager30/BrowserUse/<ts>/<task>/<run>/results_no_screenshot.json`): `success`, `run_id`, `eval{eval, reason}`, `duration_in_s`, `agent_answer`, `task{question, id, answer, url, website_name}`, `steps[{url, llm_calls, duration_in_s}]`, `total_input_tokens`, `total_output_tokens` and `last_message`.
- In the main `nottelabs/notte` repo, `evaluation_result.py` is about `evaluate_js` result limits, not agent evals [code]. The only WebVoyager reference there is `tests/integration/test_webvoyager_scripts.py`.

---

## 6. Agent-E (EmergenceAI): `test/` [code]

- **Task format** (`test/tasks/test.json`) is WebArena-style: `task_id`, `start_url`, `intent_template` with `instantiation_dict`, `intent`, `require_login`, `storage_state`, `require_reset`, and `eval{eval_types, reference_answers, reference_url, program_html, url_note}`.
- **Evaluators** (`test/evaluators.py`), combined multiplicatively by `EvaluatorComb`:
  - `StringEvaluator`: `exact_match`, `must_include`, and a fuzzy phrase match.
  - `URLEvaluator`: compares base path and query params of the final URL against reference URLs using "GOLD in PRED" matching. The reference can list alternatives separated by `|OR|`.
  - `HTMLContentEvaluator`: `program_html` runs a locator on the page and checks the required contents.
  - `ManualContentEvaluator`: "Pauses Execution to get manual evaluation score from user".
- **Browser lifecycle** (`test/tests_processor.py`). There is **one long-lived browser**. Each task does `page.goto(start_url)`, then takes a final screenshot, then `close_except_specified_tab(page)`. When not headless it sleeps 5 s between tasks "in case there is a human observer". This is the closest match to running in a single real Chrome.
- **Telemetry**: per task `tct` (task completion time), prompt/completion/total tokens and cost from autogen's `ChatResult.cost`. Results are printed as a table and saved as JSON, with snapshots in a folder per task.

---

## 7. LaVague: `lavague-core/lavague/core/evaluator.py` [code + repo-doc]
- This is a **component-level, offline replay** evaluation, not end-to-end. The `RetrieverEvaluator` and LLM evaluator replay recorded HTML (the BigAction "the-meta-wave-raw" dataset of 250 rows: instruction, page HTML, gold node/XPath) into a driver.
- It measures retriever recall/precision, LLM XPath recall/precision, `retrieval_time` and `code_generation_time` (`docs/docs/module-guides/evaluation.md`).

## 8. Laminar `lmnr-ai/index` `evals/` [code]
- Unit evals of sub-functions (JSON repair, output-model generation) use `lmnr.evaluate` with `data`, `target`, an executor and an evaluator (exact match). They are small inline datasets, and results go to the Laminar dashboard.

## 9. Steel: `steel-dev/steel-browser` `api/src/utils/scrape/__tests__/eval/` [code]
- A corpus of saved real pages (`corpus.ts`) runs through the actual HTML-to-markdown pipeline. `runEval.ts` applies **invariants instead of golden outputs**: per-invariant pass rates, a latency distribution, empty-output rate, and thin or oversized outliers. It writes `eval-report.json` "for trend tracking" and exits non-zero on error-level invariant violations. It runs on demand and is not part of the unit tests.

## 10. Others with real harnesses

- **OSU Online-Mind2Web WebJudge** (`OSU-NLP-Group/Online-Mind2Web` `src/methods/webjudge_online_mind2web.py`) [code]. It works in three stages:
  1. An LLM extracts **key points** from the task. Superlatives such as "cheapest" or "highest" must be satisfied through the site's sort or filter function.
  2. **Each screenshot is scored 1–5** for relevance to those key points, in parallel.
  3. Only screenshots at or above the threshold (at most 50), plus the action history, go to the final judge, which outputs `Status: "success"|"failure"`.

  Its rules include: "If the requirement is less than $50, but the applied filter is less than $25, it is a failure" and "If the retrieved information is invalid or empty… but the agent has correctly performed the required action, it should still be considered successful."

  README [repo-doc]: WebJudge with o4-mini has 85.7% agreement with humans and a 3.8% gap in success rate. They regularly replace outdated tasks or tasks on CAPTCHA sites, "on the same websites… with a similar reference length", and publish dated update logs. They also offer outsourced human evaluation for submissions.
- **REAL bench / agisdk** (`agi-inc/agisdk` `src/agisdk/REAL/browsergym/webclones/`) [code]:
  - It provides deterministic **clones**: omnizon (Amazon-like), staynb, gomail, gocalendar, zilloft, udriver, topwork, networkin, dashdish and opendining, with about 20 tasks each. Clones are hosted at `evals-*.vercel.app`.
  - Task JSON (`v1/tasks/fly-unified-1.json`) holds `goal`, `website{url, similarTo}`, `difficulty`, `challengeType` and `evals[]`. The eval types are `llm_boolean` (a rubric question about the answer), `jmespath` (a query over environment state), or a Python `eval_script`.
  - `base.py` `setup()` opens a hidden **background page** that hits `<site>/config` to reset state and then `/finish`. After the run, `get_finish_json()` reads `/finish`, which returns state including `initialfinaldiff`, the **server-side diff of what the agent changed**. `evaluate.py` scores that diff.
  - `teardown()` closes both pages.
- **AgentLab/BrowserGym** (ServiceNow) [code]:
  - `experiments/loop.py` `StepInfo.make_stats()` records per-step `n_token_*`, `step_elapsed`, `agent_elapsed`, and terminated/truncated status. `save_summary_info` writes `err_msg` and `stack_trace` per episode.
  - `experiments/study.py` `run(n_relaunch=3, relaunch_errors=True)` re-runs only incomplete or errored experiments.
  - `reproducibility_util` with `strict_reproducibility` records the code and package state.
  - `reproducibility_agent.py` **replays a recorded trace's answers** to diff behaviour.
  - `llm/tracking.py` `get_pricing_openrouter()` pulls live prices from `openrouter.ai/api/v1/models`.
- **Hyde.ai** [blog]. A run succeeds if at least 2 of 3 judges agree, and a task succeeds if at least 1 of 5 runs succeeds. Only environment failures are retried, never "completed but incorrect" ones.
- **Asteroid** [blog]. Bias toward failing safely: a false positive is worse than a false negative. Use multiple judges rather than self-evaluation. Add **code-level guardrails** (selector and URL blocks on the final Submit) so that evals can run on production workflows.

---

## Cross-cutting answers

| Question | What serious teams do (source) |
|---|---|
| Task format | YAML/JSON with an instruction, start URL, criteria or rubric, max_steps, and optionally reference answer, ground truth or canary (browser-use `tests/agent_tasks`, BU Bench). WebArena-style typed `eval` blocks (Agent-E, REAL). Code tasks returning `_success` (Stagehand). |
| Real vs fixture vs replay | Every team has **tiers**. Deterministic fixtures for widgets go in the PR gate (stress-tests, Stagehand clones, Magnitude localhost). Live real-site suites sampled at about 25–30 tasks go in nightly or manual runs (Stagehand limit 25, Notte 30). Frozen-page replay is for perception/extraction components (Stagehand recorder, LaVague, Steel). Clones with a server-state diff serve write actions (REAL). |
| Success judging | Deterministic where possible: URL, string, DOM, state diff (Agent-E, REAL, Stagehand bench). Otherwise an LLM judge with screenshots plus trajectory plus final answer, skeptical of self-report (browser-use `judge.py`). Better: per-criterion findings, with the score computed in code (browser-use `findings_judge.py`; Stagehand/Microsoft Universal Verifier). Humans review the "unknown" and failed cases (browser-use/eval README), and judges are calibrated on 100–200 human labels (browser-use blog; Browserbase talk). |
| Site drift | Dated, versioned task patches with reasons (Magnitude `patches.json`, BU `RUBRIC_REVISION.md`). Relative-date generators (Stagehand `taskDates.ts`, Skyvern date-tweak prompt). An "answer is out of date" judge mode (Skyvern `is_updated`). A judge rule to trust run evidence when the site changed (BU findings). Remove impossible tasks (browser-use/eval, Skyvern outdated list). |
| Flakiness / pass@k | trials 3 by default (Stagehand). 8 runs per task with pass@8 "task reliability" (Notte). 5 runs plus best-of-N plus paired per-task comparison (browser-use blog). `--failed` re-runs for pass@N (Magnitude). Retry **infra crashes only** (Magnitude, AgentLab `n_relaunch`, Hyde). |
| Telemetry | Steps, tokens (input, output, cached), cost with provenance, duration, stop reason, provider retries, errors and stack traces, URLs visited, action errors (browser-use `AgentTelemetryEvent`, bu-pi `resultEnvelope`, AgentLab `StepInfo`). Tools: Laminar (browser-use, Skyvern, bu-pi), Braintrust plus OTel plus LangSmith (Stagehand), PostHog allowlist (bu-pi), plain JSON or CSV (Agent-E, Skyvern, Magnitude, Notte). |
| Clean browser | A fresh profile or context per task, closed in `finally` (browser-use CI, BU runner, Magnitude, Stagehand). Single browser with tabs closed except the task tab plus a sleep between tasks (Agent-E). A background page resets the clone's state (REAL). |
| Count / selection | CI: 2 live plus about 50 fixture tasks (browser-use). 25-task sample per dataset (Stagehand). 30 representative tasks × 8 runs (Notte). 100–200 hand-selected tasks "verified achievable" (BU Bench). Production-derived tasks: PostHog 333 (mix-eval-go), "millions of user spans" (blog). |
| Rate limits | Bounded concurrency: 5 (Skyvern batch), 1 by default (Magnitude workers), 10 (Stagehand, browser-use CI), 15 (browser-use/eval), 25–100 on cloud. Sleep-and-retry on RateLimitError (browser-use/eval). Resumable runs that skip completed tasks (online-mind2web, Magnitude). `--preview` and `--check` dry runs before spending (Stagehand, BU). |
