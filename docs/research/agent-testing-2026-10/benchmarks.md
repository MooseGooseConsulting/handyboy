# Live-web agent benchmarks: how they score, what they record, what is cheap

Researched 2026-10-11 by reading harness code through `gh api` (no clones) plus papers via Exa. Everything read is treated as data.
Citation format: `owner/repo : path` for code, `paper section/table` for papers. Items marked (INFERENCE) are my conclusions, not source claims.

---------------------------------------------------------------------------------------------------

## 1. WebVoyager (MinorJerry/WebVoyager)

**Task format.** `data/WebVoyager_data.jsonl`, one JSON per line: `{web_name, id, ques, web}`, e.g. `Allrecipes--0`, a question string and a start URL. 643 tasks over 15 sites (README "Data / Overview"). Time-sensitive tasks (Booking, Google Flights) must be re-dated by hand before each run (README: "we need to manually update the time before running").

**Ground truth on a drifting web.** `data/reference_answer.json` holds a short answer per task with a `type` of `golden` (143 entries) or `possible` (500 entries) (counted with grep). A per-site `notice` says things like "note that review information is real-time". The reference answers are for *humans/judge context*, and the auto-eval script does not read them at all (see below). So WebVoyager's answer to drift is: do not hard-check the answer, let a judge look at screenshots.

**Auto-eval code** (`evaluation/auto_eval.py`):
- Inputs to the judge: task text (regex-extracted from message 1 of `interact_messages.json`), the agent's final `ANSWER` text, and the last `--max_attached_imgs` screenshots (README example uses 15; default 1).
- One GPT-4V call, `temperature=0, seed=42, max_tokens=1000`. System prompt tells the judge that on conflict between answer text and screenshot, the screenshot wins.
- Verdict parsed by substring: `'NOT SUCCESS' in text` -> 0, `'SUCCESS'` -> 1, neither -> `None`.
- Cost is printed per call at hard-coded GPT-4-turbo prices ($0.01/1k in, $0.03/1k out).
- Agent max steps: `--max_iter 15`; exceeding it counts as failure (README flags).

**Trace per task** (`results/examples/task*/`): `interact_messages.json` (the whole chat: prompts, model thoughts/actions) plus `screenshot{N}.png` for each step. That is all; no structured per-step record, no timings, no token counts.

**Agreement with humans** (paper arXiv 2401.13919, Table 2): GPT-4V judge vs consolidated human label on 300 tasks: k=1 screenshot 75.3% agreement / kappa 0.51; k=2 79.7% / 0.59; k=3 81.3% / 0.62; full trajectory 85.3% / 0.70. Human-human Fleiss kappa before discussion was 0.7 (footnote 7), so the judge was "on par" with a second human at full trajectory. Judge was run 3 times to report mean and std (Table 1 caption).

**Statistics.** Single run per task, mean over tasks, std only over the 3 judge repeats. No pass@k, no CI on agent stochasticity.

---------------------------------------------------------------------------------------------------

## 2. Online-Mind2Web and WebJudge (OSU-NLP-Group/Online-Mind2Web)

**Tasks.** 300 tasks, 136 sites (README "Tasks"). Difficulty by human reference length: easy <=5 steps (83), medium 6-10 (143), hard >=11 (74) (paper Sec. 2). They *replace* tasks as sites change: 36 tasks swapped 2025-11-03 for being invalid or CAPTCHA-blocked, plus smaller swaps in Nov/Dec 2025, Jan 2026 and 2026-05-15 (README "Update History"). So the drift answer is partly "maintain the task list by hand".

**Submission/trace schema v2** (`data/schema_v2/README.md`, `schema_v2.json`). Per task a directory with `result.json` and `trajectory/NNNN.png`. `result.json` fields: `schema_version`, `task`, `task_id`, `agent_final_answer`, `reference_length`, `action_history[]`. Each step object has `step`, `screenshot`, `url`, `action`, `action_status` (SUCCESS/FAILED/null), `thought` (required, may be null). The reason for v2: in v1 actions, thoughts and screenshots were three parallel arrays that silently desynced ("the dominant source of labeling errors"). Lesson: one self-contained record per step.

**WebJudge algorithm** (`src/methods/webjudge_online_mind2web.py`). Three stages:
1. `identify_key_points(task)`: one text-only LLM call that lists the *explicitly stated* requirements. Special rule: superlatives ("cheapest", "latest", "highest-rated") must become "filter/sort by X" key points.
2. `judge_image` for *every* screenshot, run concurrently: LLM sees task + key points + one image, returns reasoning and a 1-5 relevance score. Images scoring >= `--score_threshold` (3 in `script/eval.sh`) are kept (max 50), and their one-paragraph "reasoning" is kept as text.
3. Final call: task + key points + the *action history* + kept screenshots + their reasons -> `Thoughts: ... Status: "success" or "failure"`. The system prompt has 7 explicit rules (filters must actually be applied via the site's filter UI; numeric ranges must match exactly; empty results are OK if the agent acted correctly; etc.).
So calls per trajectory = 1 + N_screenshots + 1. The README tells submitters to *exclude the agent's final answer text from the action history* because it "may contain hallucinated content and result in a high rate of false positives".

**Measured agreement** (paper Tables 2/3; README results table): human labels on 6 agents x 300 tasks, each labeled by >=2 annotators with a 3rd breaking ties.
- WebJudge (GPT-4o): avg agreement 83.6%, mean success-rate gap vs human 7.8 pts.
- WebJudge (o4-mini): **85.7%**, gap **3.8 pts** (the README tells users to use o4-mini).
- WebJudge-7B (fine-tuned Qwen2.5-VL-7B, `osunlp/WebJudge-7B`): **87.0%**, gap 3.9, and only **2 API calls per trajectory** (paper).
- Older judges: Autonomous Eval (final screenshot only) 79.5%-ish avg on o4-mini, WebVoyager-style judge 78.7% on o4-mini, AgentTrek Eval 66.9% (README table).
- Judge noise: 3 repeats of the pipeline gave avg std of success rate 1.1%, max 1.8% (paper Sec. 4 / Fig. B.1). Agreement of WebVoyager and Autonomous judges drops as trajectories lengthen; WebJudge holds up to ~80 steps (paper).
- Cost caveat stated by the authors: "number of API calls scales proportionally with the number of screenshots", which is why they built the 7B model.
- Human eval is now outsourced at $3,500 for all 300 trajectories, $10/trajectory after (`data/schema_v2/HUMAN_EVALUATION_PRICING.md`).

**Out-of-domain check** (README "AgentRewardBench" table, 1302 trajectories): precision WebJudge(o4-mini) 82.0, WebJudge-7B 75.7, WebJudge(GPT-4o) 73.7, Autonomous Eval 67.6, rule-based 83.8 (rule-based precision is high but recall is low, see Sec. 9).

---------------------------------------------------------------------------------------------------

## 3. BrowserGym / AgentLab (ServiceNow)

**Task API** (`ServiceNow/BrowserGym : browsergym/core/src/browsergym/core/task.py`). `AbstractBrowserTask(seed)` with: `setup(page) -> (goal, info)`, `validate(page, chat_messages) -> (reward, done, message, info)`, optional `cheat(page, chat)` (a scripted solution, which is how they test the validator) and `teardown()`. Defaults: viewport 1280x720, `slow_mo=1000 ms`, `timeout=5000 ms`. `OpenEndedTask` has *no* validator: reward is always 0 and it ends when the user types "exit" (this is what a live-web task gets unless you write `validate`).

**Per-step record** (`ServiceNow/AgentLab : src/agentlab/experiments/loop.py`, mirrored in BrowserGym `browsergym/experiments/.../loop.py`, `class StepInfo`):
`step, obs, reward, raw_reward, terminated, truncated, action, agent_info, stats, profiling, task_info`.
- `profiling: StepTimestamps` = `env_start, action_exec_start, action_exec_stop, action_exect_after_timeout, env_stop, agent_start, agent_stop` (wall-clock floats).
- `stats` = `n_token_<field>` for each string observation field (axtree, dom, ...) plus agent stats plus `step_elapsed`, `agent_elapsed`; generic agent adds LLM `get_stats()`, `n_retry`, `busted_retry` (`generic_agent.py`). `llm/tracking.py` `LLMTracker` accumulates `input_tokens, output_tokens, cost` (litellm / OpenRouter price tables).
- `agent_info` = `think`, full `chat_messages` (the exact prompt), `extra_info` (chat model args), and on failure `err_msg` + `stack_trace`.
- On disk per episode dir: `step_{n}.pkl.gz` (full StepInfo, screenshot popped out), `screenshot_step_{n}.png` (+ `_som_`), `goal_object.pkl.gz` once, `exp_args.pkl`, `experiment.log`, `package_versions.txt`, optional videos, and **`summary_info.json`**.
- `summary_info.json` = `n_steps, cum_reward, cum_raw_reward, err_msg, stack_trace, terminated, truncated` plus `stats.cum_<k>` (sum) and `stats.max_<k>` for every per-step stat, and `stats.cum_steps` (`loop.py` `save_summary_info`, `_aggregate_episode_stats`). This is the "score from telemetry" pattern: aggregates computed from per-step stats, no judge needed for cost/latency/steps/errors.

**AgentXray** (`AgentLab README "AgentXray"`, `src/agentlab/analyze/agent_xray.py`). Gradio app launched with `agentlab-xray`; pick experiment -> agent -> task -> seed, then click on the profiling timeline image to select a step and see screenshot, prompt, thought, action. The `ReproducibilityAgent` re-runs a study's recorded actions on the same seeds and shows a prompt diff in the same UI (README "Reproducibility Features").

**Reproducibility stance** (README "Reproducibility"): lists the sources of nondeterminism candidly: package versions, silently-updated API LLMs, live sites ("experience may change depending on which country or region"), stochastic agents (temp 0 reduces most), nondeterministic tasks. `Study` records benchmark version, package versions, commit hash and can append to `reproducibility_journal.csv`.

**Statistics.** `inspect_results.py : get_std_err`: for 0/1 outcomes standard error = sqrt(p(1-p)/n); otherwise sample std /sqrt(n) (ddof=1). No bootstrap, no pass^k. Multiple seeds per task are first-class (AgentXray selects "the seed"; README: "multiple seeds can generate more than 10,000 jobs").

---------------------------------------------------------------------------------------------------

## 4. WebArena, VisualWebArena, WebArena-Verified

**WebArena** (`web-arena-x/webarena : evaluation_harness/evaluators.py`). Evaluators multiplied together (`EvaluatorComb`: score = product, so all must pass):
- `StringEvaluator` on the agent's final `answer`: `exact_match`, `must_include` (substring list; tokenized if single), `fuzzy_match` (LLM call `llm_fuzzy_match(pred, ref, intent)`), and `ua_match` for unachievable ("N/A") tasks which first tries exact "N/A" then an LLM check of the stated reason.
- `URLEvaluator`: parses URL + query, `reference_url` split on ` |OR| `, rule `url_note` default "GOLD in PRED".
- `HTMLContentEvaluator` ("program_html"): navigate to a URL (or `last`), run a JS locator or Python helper (`func:`) to pull an element or backend value, then `exact_match`/`must_include` against it. Contains a hard-coded `time.sleep(3)`.
Counts over `config_files/test.raw.json` (812 tasks, my count): string_match only 325, program_html only 282, url_match+program_html 129, url_match only 66, string_match+url_match 10.
Key property: these are *state* checks against a **self-hosted, resettable** copy of the sites, so ground truth does not drift. That is what makes them deterministic; it does not transfer to eBay.

**VisualWebArena** has the same harness with extra image/VQA evaluators (file seen at `web-arena-x/visualwebarena : evaluation_harness/evaluators.py`; I did not read its body).

**WebArena-Verified** (`ServiceNow/webarena-verified : docs/evaluation/*`). Answers the brittleness of the above:
- Every task has exactly one `AgentResponseEvaluator` (agent must return a *structured* response: operation, status, retrieved data) plus 0..n `NetworkEventEvaluator`s.
- Network-event evaluation runs on **HAR traces** (URL, Referer, status codes), "resilient to UI changes", "re-evaluate captured traces offline" (`network_event_based_evaluation.md`, `index.md` comparison table).
- LLM-as-judge removed; replaced by "data type-aware exact match" and by rewriting intents to demand a machine-checkable format (`removing_llm_based_evaluation.md`, e.g. Task 107 "Return a list of objects ... month ... count").
- Unachievable tasks use explicit statuses instead of free-text "N/A" (`handling_of_unachievable_tasks.md`).
- A cheaper 258-task "Hard" subset (of 812) exists "to evaluate cost-effectively while preserving discriminative power" (`getting_started/hard_subset.md`).

---------------------------------------------------------------------------------------------------

## 5. WebCanvas / Mind2Web-Live (iMeanAI/WebCanvas): key-node evaluation

This is the only benchmark here that is built for *live* sites with *intermediate checkpoints*.
- Dataset: 542 tasks, 2,439 key-node "evaluation states" (README). A task file entry (`data/example/example_130.json`) is `{index, task, reference_task_length, evaluation:[...]}`; each element is a key node with `match_function_name` and content:
  - `url_included_match` / `url_exactly_match` / `url_semantic_match` (substring/exact/LLM on the URL, optionally on one query param `key`),
  - `element_path_exactly_match` (CSS selector or XPath must point at the *same element* as the reference, with up to 3 parent levels tolerated for tags in `MapTagNameList`),
  - `element_value_exactly_match` / `element_value_included_match` (text/value of an element),
  (`evaluate/step_score.py`, `evaluate/evaluate_utils.py`).
- Metrics: **Completion rate** = fraction of key nodes hit (partial credit), **Task success rate** = all key nodes hit (`FinishTaskEvaluator`: reference step score == achieved score), plus a **length score** (`TaskLengthEvaluator`: full credit if steps < 1.2 x reference, else ref/actual) and **USD efficiency score** = dollars per key-node completion, from tiktoken counts and prices in `configs/setting.toml` (README "Token Consumption Calculation", saved to `token_results/` as JSON).
- Environment sensitivity measured by the authors (README table, gpt-3.5-turbo): same agent, completion/success = US-Windows-Chrome 40.2/16.5, US-Linux-Chrome 36.5/15.4, **UK-Windows-Chrome 23.6/8.65**, Singapore 42.3/21.2. So IP region and OS moved results by up to ~2x.
- Limitation, stated by Online-Mind2Web's authors: Mind2Web-Live's "key node-based evaluation is still prone to changes in websites over time, making it less reliable" (Online-Mind2Web paper, Related Work). Selector-based nodes rot; URL-substring nodes rot less.
- Also: a JS event-listener evaluation mode that decouples evaluation from the action space (README news), and Browserbase cloud browsers with CAPTCHA solving.

---------------------------------------------------------------------------------------------------

## 6. REAL bench (agi-inc/agisdk)

Not live: **deterministic clones** of Amazon/Airbnb/LinkedIn/etc. hosted on Vercel (`omnizon`, `staynb`, `networkin`, `dashdish`, ...), e.g. `dashdish-1/task.json` has `"url": "https://evals-dashdish.vercel.app"`.
- Task JSON (`docs/Task.md`): `id, goal, website, difficulty, challengeType (retrieval|generation|navigation), possible, evals[], points`.
- Evals are `jmespath` queries over the **site's own env-state JSON** (e.g. `length(feedPostsDiff.modified) == 1`), `llm_boolean` rubrics for retrieval answers, and Python eval scripts run in a subprocess (`src/agisdk/REAL/browsergym/webclones/evaluate.py`).
- State comes from the site itself: at the end the harness opens a background tab to `<site>/finish` and parses the JSON in a `<pre>` (`webclones/base.py : get_finish_json`); it contains `initialfinaldiff` and `differences`.
- The `llm_boolean` path is a 0-1 similarity grade with threshold 0.8 and "Don't be too strict" in the prompt (`evaluate.py : evaluate_with_llm`).
Takeaway: state-diff checks against resettable clones can be repeatable and avoid live-site drift, but the
`llm_boolean` retrieval grader is model-based and may vary between calls or model revisions. Determinism
applies to the state-based checks, not to every grading path; the clones also require hosting.

## 7. Halluminate Westworld

Simulators, not live. 100 tasks, 5 simulated sites (Noodle Flights, Travelpedia, GoodBuy, Azora, Megamart) (blog "Westworld v1", 2025-11-23; repo `Halluminate/westworld`, evaluators have `update()` per step and `compute()` at the end; note: "most evaluators rely on site state ... run the verifier before closing the browser").
- Three verifier styles: state-based unit test on the simulator backend DB; component-level (read the search component's state); real-time-calculated ground truth (query the sim for the cheapest flight at verification time, compare to the agent's answer).
- Their stated reason for leaving live sites: their earlier live benchmark WebBench "exposed how fragile real-site evaluation is": CAPTCHAs, DOM drift, randomized search results, data decay.
- Follow-up (blog "Simulated-to-Real Transfer", 2026-07-27): real-site tasks are still scored without an LLM judge, by "deterministic JavaScript inspection of the final page state"; stats via Wilson 95% CIs, McNemar's exact test for paired comparisons on the same tasks, Holm-Bonferroni across 6 comparisons, pass@1 over 320 tasks per site.

## 8. BrowseComp and AssistantBench (answer-only scoring on the open web)

- **BrowseComp** (`openai/simple-evals : browsecomp_eval.py`; arXiv 2504.12516). 1,266 questions with short, single, time-invariant answers ("would not change over time"). Grading: one LLM call with `GRADER_TEMPLATE` (extract final answer, compare to `[correct_answer]`, reply `correct: yes|no`, also extract a confidence). Parse failure defaults to "no". Supports `n_repeats` and a seeded `num_examples` subsample (`random.Random(0)`). OpenAI's own analysis ran **64 trials per question** to show the pass-rate distribution across tasks (OpenAI blog: some tasks 100% pass, 14% 0%). Strategy for drift: only ask questions whose answer cannot change.
- **AssistantBench** (arXiv 2407.15711; repo `oriyor/assistantbench` has only the agent code, scorer is on the HF leaderboard). 214 tasks. Drift handled by dropping tasks "whose answers are likely to change in the near future", each manually verified by two authors. Metric per answer type: string = token F1; list = alignment F1 (Dua et al. 2019); number = `max(0, 1 - log(max/min))` order-of-magnitude closeness (partial credit); JSON = key-wise F1 over matching keys. Also reports answer rate, precision-when-answering, and exact match. Best system under 26 points accuracy.
- Online-Mind2Web's critique of this family: closed-form-only tasks "preclude evaluation of time-sensitive tasks ... or procedural tasks that do not expect an answer string" (Online-Mind2Web paper Sec. 1/2).

## 9. tau-bench pass^k (sierra-research/tau-bench)

- Reward is purely deterministic state comparison: replay the ground-truth actions on a fresh DB, hash the DB, and compare to the agent's final DB hash; additionally every required output string must appear (case-insensitive, commas stripped) in some agent reply (`tau_bench/envs/base.py : calculate_reward`). Reward is 0/1; no LLM judge for outcome (the *user* is an LLM simulator).
- `RunConfig` defaults: `num_trials=1`, `temperature=0.0`, `seed=10`, `max_concurrency=1`; the README tables report Pass^1..Pass^4 so they ran 4 trials (`tau_bench/types.py`, `run.py`, README).
- **pass^k** (`run.py : display_metrics`): for each task, c = number of successful trials out of n; pass^k_task = C(c,k)/C(n,k); report the mean over tasks for k = 1..n. This is the unbiased estimate of "probability all k fresh attempts succeed". It differs from pass@k = 1 - C(n-c,k)/C(n,k) ("at least one of k"). Note pass^1 equals the plain mean success rate.
- Headline (secondary sources, arXiv 2406.12045 abstract as relayed): gpt-4o <50% overall and pass^8 <25% in retail.
- Relevance (INFERENCE): the estimator is cheap and needs only n >= k repeats per task. For an agent that will run many times a day on a user's real account, "succeeds every time" is the product-relevant number.

## 10. What judging approach agreed best with humans, and at what cost

| Judge | Evidence | Agreement / quality | Cost shape |
|---|---|---|---|
| GPT-4V, last k screenshots + answer (WebVoyager) | WebVoyager Table 2, 300 tasks | 75.3% (k=1) to 85.3% (full), kappa 0.51 to 0.70 | 1 call; tokens grow with images |
| Final-screenshot judge ("Autonomous Eval") | Online-Mind2Web Table 3 | ~79.5% avg (o4-mini), drops on long trajectories | 1 call |
| **WebJudge o4-mini** | Online-Mind2Web Table 2/3, 6 agents x 300 | **85.7%**, gap 3.8 pts; AgentRewardBench precision 82.0 | 1 + N + 1 calls |
| **WebJudge-7B** (fine-tuned Qwen2.5-VL-7B) | same | **87.0%**, gap 3.9 pts; AgentRewardBench precision 75.7 | **2 calls**, self-hostable |
| Simplified LLM judge (AgentRewardBench), Claude 3.7 Sonnet on final AXTree/screenshot | arXiv 2504.08942 Table 1/7 | precision ~69, recall 76-82 | 1 call |
| Rule-based (WebArena etc.) | AgentRewardBench Table 1 | precision 83.8 but **recall 55.9**: rejects valid answers (e.g. "Portland ... is Acadia National Park" fails exact match "Acadia National Park"), underreports success by 16.7 pts (WA) and 18.5 pts (VWA) for GPT-4o | free |
| Human, outsourced | Online-Mind2Web pricing | gold | $3,500 / 300 trajectories, $10 after |

Caveats: (a) LLM judges *overestimate* success for most agents while rule-based *underestimate* (AgentRewardBench Sec. 5); (b) "no single LLM excels across all benchmarks" (AgentRewardBench abstract); (c) every number above is for frontier or paid judges, none were measured with free OpenRouter models. (INFERENCE) Judge agreement on a free model is therefore unmeasured and should be validated on a handful of our own hand-labeled runs.

## 11. How the benchmarks handle drifting ground truth (taxonomy)

1. **Don't use the live web**: self-hosted/resettable (WebArena, VWA, WebArena-Verified), clones (REAL), simulators (Westworld). Deterministic state checks. Cost: not real sites.
2. **Pick time-invariant questions**: BrowseComp, AssistantBench (manually vetted), partly WebVoyager `golden` answers. Cost: excludes procedural/time-sensitive work.
3. **Key-node checkpoints**: WebCanvas (URL substring, element path/value). Partial credit and cheap, but selector nodes rot and results moved ~2x with IP region/OS.
4. **LLM judge over the trajectory**: WebVoyager, Online-Mind2Web/WebJudge. Handles any task, tolerant to drift; costs LLM calls and has measured disagreement (~15%).
5. **Maintain the task set**: Online-Mind2Web replaces dead tasks; WebVoyager hand-edits dates.
6. **Network-trace checks**: WebArena-Verified (HAR: URL, referer, status), offline re-scorable.
7. **Deterministic JS inspection of the final page** on real sites, no judge (Halluminate sim-to-real follow-up, real Best Buy).

## 12. Trials and statistics actually used

- WebVoyager: 1 run/task; judge repeated 3x for std.
- Online-Mind2Web: 1 run/task; WebJudge repeated 3x (std 1.1%, max 1.8%); HAL leaderboard shows min-max across runs where multiple exist ("Confidence intervals show the min-max values across runs", hal.cs.princeton.edu/online_mind2web) and a per-task heatmap of "fraction of times a task was solved across reruns".
- AgentLab: multiple seeds, binomial standard error sqrt(p(1-p)/n).
- tau-bench: n trials (README shows 4), pass^k for k=1..n via C(c,k)/C(n,k), temperature 0 by default.
- BrowseComp: 64 trials per question in OpenAI's difficulty analysis.
- Halluminate: Wilson 95% CI, McNemar exact test for paired same-task comparisons, Holm-Bonferroni.
- WebCanvas: reports a USD-per-key-node efficiency metric alongside success.

---------------------------------------------------------------------------------------------------

## 13. Implications for nanobrowser-v2 (INFERENCE, not source claims)

Constraints: about 4 realistic multi-step eBay-style activities, several runs a day, free models at 20 req/min, the user's real logged-in Chrome.

1. **Primary score from telemetry, not a judge.** Copy the BrowserGym shape: a per-step record `{step, url, action, status, thought, screenshot_ref, tokens_in/out, llm_ms, env_ms, error}` and a `summary` with sums and maxes (`n_steps`, `cum_tokens`, `max_step_ms`, `n_errors`, `n_retries`, `stopped_reason`). Make it one object per step (Online-Mind2Web v2 lesson) so fields cannot desync.
2. **Outcome = a small list of key-node checkpoints per activity** (WebCanvas pattern, but only URL-path/query and *page-text/JS-extracted values*, not CSS paths): e.g. "reached a search results URL containing the query", "a price filter is reflected in the URL params (`_udlo`/`_udhi`) or in the filter UI text", "item page opened", "final answer contains a price". Score = completion fraction (partial credit) and success = all nodes. Use WebArena-Verified's idea of checking network and URL evidence, but capture it explicitly before relying on it: the current `RunEvent` contract stores the initial `run.started` URL and capped tool-result summaries, not a structured navigation, redirect, popup, or network-event history (`src/messaging/contract.ts`). A tool call may record a requested URL, but that does not establish where the browser navigated or what network events occurred. Offline rescoring of that history requires adding and persisting event capture; the existing trace does not provide it.
3. **Relative, not absolute, answer checks.** Because eBay inventory drifts, check *internal consistency* instead of a golden string: the item the agent names must appear on the page it visited, the price it quotes must match the page text it extracted, and sort/filter requirements must be satisfied by the visited results (Halluminate's "real-time ground truth" idea, using the page itself as the oracle). Also apply WebJudge's superlative rule: "cheapest" must come from the sort control, not from reading a list.
4. **Optional LLM judge only on the final outcome and only as a second opinion.** WebJudge-style key points + a few key screenshots is the best-measured design, but its measured numbers are for o4-mini/GPT-4o and 7B vision models; with free text models and the 20 req/min cap, N per-screenshot calls are expensive in requests. Cheaper variant: one key-point call per activity (cacheable, written once into the activity definition), then one final judge call over action history + 2-3 key screenshots. Do not put the agent's own final answer text in the judged action history (Online-Mind2Web README warning on false positives). Validate it against hand labels on ~20 of our own runs.
5. **Trials.** Run each activity n=3 to 5 times across the day, report per-activity success rate with Wilson interval (not the normal approximation, because n is tiny) and pass^k = C(c,k)/C(n,k) (tau-bench formula). With 4 activities x 4 runs = 16 trials/day the CIs are wide, so the useful signals are (a) pass^k trending, (b) paired comparisons across versions on identical activities (McNemar, as Halluminate does), and (c) deterministic telemetry like steps and tokens which has far lower variance than success.
6. **Drift control.** Record, per run: date, locale/region, logged-in state, eBay site (ebay.com), viewport, extension version, model ids, and a hash of the activity definition (AgentLab `Study` metadata + WebCanvas's IP-region finding). Keep a "task invalid" status distinct from "agent failed", but require evidence independent of the candidate run before excluding a task. A CAPTCHA or layout failure seen only on one agent revision is a failure for that run; reserve invalidation for a task shown to be unusable because of an external or persistent task defect, and record the evidence. Online-Mind2Web replaces invalid tasks and WebVoyager has a `None` verdict. Rotate tasks if a checkpoint stops being reachable.
7. **Pacing.** Sequential runs are this project's proposed pacing choice for its 20 requests/minute limit, with a cap of about 15-25 steps per activity. Do not infer that policy from the surveyed benchmarks: Online-Mind2Web's runner defaults to concurrency 25 (frameworks.md §7), while other projects use different concurrency limits.
8. **Cheap viewing.** AgentXray (timeline + per-step screenshot + prompt) is the model for a debugging view; the extension panel could show the same per-step record without a separate Gradio app.

## 14. Open questions and gaps

- I did not read VisualWebArena's evaluator body, the Westworld evaluator code (only README/blog), or AssistantBench's actual scorer (hosted on HF). The AssistantBench metric details come from the paper.
- tau-bench's headline numbers (gpt-4o <50%, pass^8 <25% retail) come from secondary summaries of the paper abstract, not read directly in the PDF; the pass^k formula and reward logic are from code.
- The WebVoyager "golden vs possible" semantics (what exactly the types guarantee) is not defined in the README; I only counted them (143 / 500).
- No source measured judge agreement with a *free* model; whether a free Nemotron judge reaches ~85% on eBay trajectories is unknown and needs a small labeled calibration set.
- Whether eBay specifically exposes stable URL parameters for each filter we would want as key nodes needs checking against live pages (not done; no browser use allowed in this task).
