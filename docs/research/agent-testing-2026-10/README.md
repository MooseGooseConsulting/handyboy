# How others test agentic browsers (October 2026)

Five research passes, 2026-10-11. Each one read the projects' actual test, eval and CI code through
the GitHub API, plus papers and docs found with Exa. Every claim in the reports cites a repo and a
file path, and says whether it comes from code or from docs.

| Report | Covers |
|---|---|
| [extensions.md](extensions.md) | Agent Chrome extensions: BrowserOS, Taxy, page-agent, OpenBrowser, Midscene, uiuing, Eko |
| [frameworks.md](frameworks.md) | Framework evals: browser-use, Stagehand, Skyvern, Agent-E, LaVague, Notte, Magnitude, Steel |
| [benchmarks.md](benchmarks.md) | Live-web benchmarks and judges: WebVoyager, Online-Mind2Web/WebJudge, BrowserGym/AgentLab, WebArena(-Verified), WebCanvas, REAL, tau-bench |
| [mechanics.md](mechanics.md) | Tab ownership, storage reset, loading extensions in Chrome 137+, attaching to a real Chrome, telemetry out of a service worker |
| [ci-model.md](ci-model.md) | A CI to copy, from repos created since 2026-06-01 only: agent-labs-dev/fastbrowse (evals), Tencent/BrowserSkill (extension in real Chrome) |

## What the field does

1. **Tiers.**
   - Deterministic fixture tests are a useful PR gate, but coverage varies: some surveyed projects have no CI, while others run builds or unit tests without browser end-to-end coverage. Some keep model-backed evals off pull requests.
   - Keep live-site trials separate from ordinary PR checks and schedule or dispatch them when cost, credentials, and site risk make that appropriate.
   - Treat single-skill fixtures as one tier in a broader evaluation plan (frameworks.md §1).
2. **Tasks are data.** A proposed task-schema superset can include a start URL, prompt, output schema, weighted checks, and budgets. Actual formats vary: the cited browser-use task files do not supply all those fields, and surveyed systems also use code-defined tasks and unweighted graders (frameworks.md §1; browser-use `tests/agent_tasks/*.yaml`; webbrain `ci/catalog/scenarios.json`).
3. **Score evidence, not the agent's claim.**
   - Use checks on URLs, text, and site state wherever possible. Some checkpoint types drift less than others: URL substrings may be more resilient than selectors or element values, but checkpoints still need review as sites change (WebCanvas; benchmarks.md §5).
   - An LLM judge over the trajectory is the backstop. It is calibrated against hand labels, returns per-criterion findings, and code computes the score (benchmarks.md, frameworks.md §3–4).
   - A "pass" with no browser tool calls is a fail (Stagehand `verifier-gates.md`).
4. **Repeat trials.** Stagehand runs 3 trials, Notte 8 and uiuing 6. tau-bench's pass^k is the only metric that measures consistency, and no browser project reports it. Retry only infrastructure faults, never wrong answers.
5. **Telemetry per run.**
   - Steps, tokens (including cached), latency, action errors, URLs visited, stop reason and provider retries.
   - Where the run got stuck (webbrain `inferStuckAt`).
   - Unknown cost is recorded as unknown, never $0.
   - The usual format is JSONL plus screenshots. No extension uses OpenTelemetry or LangSmith.
6. **The harness owns its tabs and cleans up.** It opens tabs inactive, puts them in a tab group, tracks their ids, and closes exactly those (agent-tab-bridge, Playwright MCP, BrowserOS `cleanupCase`).
7. **Nobody evaluates in the user's real logged-in profile.** BrowserOS used a fresh temp profile per task, and Midscene's real-Chrome bridge tests are unscored.

The design built on this is #47.
