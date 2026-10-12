# CI and live/e2e testing in AI browser-agent repos created on or after 2026-06-01

Researched 2026-10-12 with `gh search repos` / `gh api` only (no clones, no browser). Exa discovery was
attempted but returned `401 Invalid API key`, so discovery is GitHub search alone.

Scope rule applied: every repo below had its `created_at` checked with `gh api repos/OWNER/REPO`. Anything
created before 2026-06-01 (nanobrowser, stagehand, browser-use/browser-use, Skyvern, BrowserOS, etc.) is out.

## 1. Enumeration

Queries (`--created ">=2026-06-01" --sort stars --limit 50`): "browser agent", "browser-use", "chrome
extension agent", "web agent", "computer use browser", "agentic browser", "browser automation llm",
"mcp browser", plus "browser automation agent" and "playwright agent". Merged and de-duplicated. Off-topic
hits (Roblox, SSH, FPGA, curated lists) dropped.

| # | Repo | Stars | Created (verified) | Kind | Workflows |
|---|---|---|---|---|---|
| 1 | browser-use/jev-ultrafast | 22,649 | 2026-09-16 | Python web agent | **none** |
| 2 | Tencent/BrowserSkill | 8,664 | 2026-06-22 | CLI + MV3 extension, real logged-in browser | ci, release-cli, release-dsh-plugin, release-extension |
| 3 | Player-YN/BrowserKitten | 2,861 | 2026-08-28 | Chrome extension web agent | ci |
| 4 | feder-cr/invisible_playwright_mcp | 2,749 | 2026-09-29 | Playwright MCP server | ci (has `e2e` job), content-gates, publish, ... |
| 5 | agentrhq/webcmd | 2,702 | 2026-07-02 | "self-learning agent browser" CLI | ci, e2e-headed, security, release, docs-sync-review |
| 6 | kerpopule/hermes-jev-skills | 1,091 | 2026-09-18 | skills incl. browser use | test, windows-cli |
| 7 | wy-coliney/jev-browser-use | 1,066 | 2026-09-18 | browser-use skill | ci |
| 8 | tiliondev/fortress | 748 | 2026-07-02 | stealth Chromium | ci, links, verify-release |
| 9 | Einsia/Browser-BC | 558 | 2026-06-26 | browser behaviour clone, has MV3 extension | build, release |
| 10 | only-cli/oc | 537 | 2026-08-18 | site-to-CLI for agents | ci, codeql, scorecard, ... |
| 11 | KitionAI/kition | 468 | 2026-07-25 | desktop app w/ agent + browser research | ci (Playwright e2e under xvfb), release |
| 12 | xiaozhou26/Chromix | 462 | 2026-08-22 | patched Chromium + SDKs | 17 build/release workflows |
| 13 | browser-use/browser-use-pi | 431 | 2026-09-05 | TS web agent "hill climbed on real browser evals" | **none** |
| 14 | jkudish/jev-browser | 331 | 2026-09-17 | browser agent on Jev | ci (optional live e2e) |
| 15 | dondai44423/bladebro | 305 | 2026-07-28 | agentic browser driver (Rust) | ci (installs Chrome + xvfb) |
| - | APUS-AI-Lab/fast-browser-use | 221 | 2026-09-19 | browser-use skill | ci |
| - | agent-labs-dev/fastbrowse | 114 | 2026-09-17 | Python browser agent | ci, **evals**, publish-evals, binaries, release, ... |
| - | alexvilelabah/bah-browser | 107 | 2026-06-19 | Electron browser agent | linux-test, mac-test |
| - | nekuda-ai/WindTunnel | 87 | 2026-07-27 | WebMCP benchmark | test (fake-lifecycle bench only) |

## 2. Which candidates test in a real browser, and which run LLM evals in CI

From reading each workflow (grep for chrome/xvfb/playwright/e2e/eval/cron/API-key secrets):

- **No CI at all**: browser-use/jev-ultrafast, browser-use/browser-use-pi (has an `eval/` dir and the
  description claims real-browser evals, but nothing runs in Actions).
- **Unit/static only, no browser**: Player-YN/BrowserKitten (`.github/workflows/ci.yml`: `node --test
  tests/*.test.mjs`, then packs the extension and greps the packed tree; no browser launched),
  kerpopule/hermes-jev-skills, wy-coliney/jev-browser-use, only-cli/oc, tiliondev/fortress (links cron only).
- **Real browser, deterministic, no LLM**:
  - Tencent/BrowserSkill `.github/workflows/ci.yml`: jobs `browser-download`, `browser-input`,
    `browser-video` run vitest `*.browser.test.ts` against real `google-chrome` / Chrome for Testing,
    with the built extension loaded (details in section 4b).
  - agentrhq/webcmd `.github/workflows/e2e-headed.yml`: daily cron + path-filtered push, matrix
    `ubuntu-latest` + `macos-15`, Linux under `xvfb-run`, vitest `--project e2e`.
  - KitionAI/kition `.github/workflows/ci.yml`: `playwright install --with-deps chromium`,
    `xvfb-run -a pnpm run test:e2e:ci`, plus a `check:e2e-coverage` step ("Every e2e spec is run somewhere").
  - feder-cr/invisible_playwright_mcp `.github/workflows/ci.yml`: `e2e` job running `pytest -m e2e tests/mcp_server`.
  - dondai44423/bladebro, alexvilelabah/bah-browser: install Chrome/xvfb and run headed tests.
- **LLM in CI**:
  - jkudish/jev-browser `.github/workflows/ci.yml`: one job; "End-to-end (optional)" runs `npm run test:e2e`
    only `if: env.TYPESAFE_API_KEY != ''`, with `TYPESAFE_API_KEY` and `OPENROUTER_API_KEY` secrets, on
    push and pull_request. No repeats, no report. Run health: 9 of the last 12 runs failed
    (`gh run list -R jkudish/jev-browser`, 2026-10-07 to 2026-10-08).
  - **agent-labs-dev/fastbrowse** `.github/workflows/evals.yml`: the only qualifying repo with a real
    agent-eval pipeline (scheduled, repeated trials, stability verdict, regression gate, artifacts).
    114 stars, so the 300-star bar had to be lowered to include it.

## 3. Deep reads and run health (best three)

### agent-labs-dev/fastbrowse (created 2026-09-17)

Files read: `.github/workflows/ci.yml`, `.github/workflows/evals.yml`, `.github/workflows/publish-evals.yml`,
`justfile`, `src/fastbrowse/evals/runner.py`, `local.py`, `mock.py` (header), `mock_tasks.py` (header and
task list), `grade.py`, `live_tasks.py`, `scripts/eval_stability.py`, `src/fastbrowse/adapters/local_chrome.py`
(flags), `tests/test_ci.py`, `CONTRIBUTING.md`, `docs/evals.md`.

Run health (`gh run list -R agent-labs-dev/fastbrowse`):
- `CI`: 18 of the last 20 succeeded (2026-10-10).
- `Evals`: 11 of the last 20 succeeded, 9 failed (2026-10-10 to 2026-10-12, mostly `workflow_dispatch`;
  the 2026-10-12 nightly passed, the 2026-10-11 and 2026-10-10 nightlies failed). The 100%-per-task
  target makes the job red often, which is by design.

### Tencent/BrowserSkill (created 2026-06-22)

Files read: `.github/workflows/ci.yml`, `apps/extension/package.json`,
`apps/extension/src/tools/__tests__/click.browser.test.ts` (setup),
`apps/extension/src/video/capture.browser.test.ts` (setup),
`evals/browser/cases/regression/snapshot-coordinates/chrome.mjs` (launch flags), `evals/browser/README.md`.

Run health: of the last 20 `CI` runs, 12 success, 4 failure, 2 cancelled, 2 action_required (2026-10-10 to 2026-10-12).

Its `evals/browser` corpus (core/matrix/regression/stress/manual suites, `run-agent --repeat 3`,
`summarize`) is **not wired into any workflow**; the README tells developers to run `smoke --suite core`
locally as the gate (`evals/browser/README.md`, "Development baseline").

### agentrhq/webcmd (created 2026-07-02)

Files read: `.github/workflows/ci.yml`, `.github/workflows/e2e-headed.yml`, `TESTING.md`.
Run health: `E2E Browser Runtime` succeeded on all 10 of the last 10 daily scheduled runs
(2026-10-02 to 2026-10-11). `CI` scheduled run 2026-10-05 failed; `Security Audit` failing repeatedly.
No LLM in CI; e2e covers browser runtime lifecycle only (`tests/e2e/browser-tabs.test.ts`,
`tests/e2e/cloak-runtime.test.ts`).

## 4. The pick: agent-labs-dev/fastbrowse

Why: it is the only post-2026-06-01 browser agent whose CI actually runs the agent end to end (real Chrome,
real LLM) on multi-step tasks, grades from what the site recorded rather than from the agent's claim,
requires repeated trials, fails on flakiness, and uploads row-level results. That is the shape we want for
eBay-style evals. Its gaps relative to us (no extension; real-site benchmarks live in a private repo) are
covered by borrowing one job design from Tencent/BrowserSkill (4b).

### 4a. fastbrowse CI design

**Two workflows, split by whether a model key is needed.**

`ci.yml` (deterministic, required) - `agent-labs-dev/fastbrowse/.github/workflows/ci.yml`
- Triggers: `pull_request`, `push` to `main`. Top-level `permissions: {}`; each job grants `contents: read`.
- Jobs: `secrets` (gitleaks over HEAD ancestry); `gate` (matrix Python 3.13/3.14: ruff, ruff format,
  `ty check`, changelog check, Vale prose lint, eval-manifest check, `pytest -q`, and two eval-integrity
  checks: `fastbrowse.evals.benchmarks --check-diff origin/$BASE` and `fastbrowse.evals.publication
  --check-diff origin/$BASE`, which refuse hand-edited published result rows, "deterministic, so it needs
  no model key and runs on a pull request"); `sift` (actionlint, zizmor advisory with `continue-on-error`);
  `sdk` (regenerates TS protocol types and `git diff --exit-code`); `changes` + `binaries` (expensive
  five-runner builds only when frozen paths change, always on `main`).
- A single required status `check` with `needs: [...]` and `if: always()` that fails unless every
  dependency is `success` (binaries may be `skipped`). The aggregator itself is unit-tested:
  `tests/test_ci.py` loads `ci.yml`, runs the `check` script with each dependency set to
  failure/cancelled/skipped and asserts non-zero exit.

`evals.yml` (live LLM, report + gate) - `agent-labs-dev/fastbrowse/.github/workflows/evals.yml`
- Triggers: `schedule: cron "0 3 * * *"` and `workflow_dispatch` with inputs `repeat` (default 3) and
  `budget` (dollars). `pull_request` is deliberately absent: "a pull request must never be handed the model
  key". `if: github.repository == 'agent-labs-dev/fastbrowse'` so forks don't fail the schedule.
  `timeout-minutes: 90`.
- Secrets: `OPENROUTER_API_KEY`, `TYPESAFE_API_KEY`, `AI_GATEWAY_API_KEY`, passed only to the steps that need them.
- Steps, in order:
  1. Refuse `repeat < 3` before any spend ("fewer than three repeats is not a rate").
  2. `scripts/eval_stability.py --check-providers`: fails once, naming the missing secret, before any task.
  3. Run `python -m fastbrowse.evals.runner --suite local mock --repeat $EVAL_REPEAT --out
     artifacts/evals/nightly.jsonl [--budget]` with `continue-on-error: true`, so the verdict comes from
     the next step, not from the runner's exit code.
  4. Stability verdict: `eval_stability.py nightly.jsonl --target 1.0 --suite local mock --repeat N`
     prints `ok`/`FLAKY` per task with `passes/runs`, fails if any task is below 100% or if any task has
     fewer than N rows ("a runner that died part way cannot pass on the rows it left").
  5. Publication gate: `python -m fastbrowse.evals.publication --rows nightly.jsonl --baseline docs/results`
     checks build/task/suite versions and regressions against committed baselines matched by task version.
  6. `actions/upload-artifact` `eval-rows` (`artifacts/evals/nightly*`) with `if: always()`.
- So it is **gating** (job goes red) on the schedule, not on PRs. PR authors are told to paste local
  `just evals-local --suite local mock --repeat 3` results instead (`CONTRIBUTING.md`).

**How the real browser runs.** `src/fastbrowse/adapters/local_chrome.py`: launches the runner's Chrome with
`--headless=new` (unless headed), `--remote-debugging-port=0`, and a throwaway `--user-data-dir`, then
drives it over CDP. No xvfb, no extension.

**What the tasks are and how they are scored.** `src/fastbrowse/evals/runner.py`:
- `local` suite: static fixture pages served by `fixture_server()` (`evals/local.py`), whose `Recorder`
  captures every POST; graded by `task.check(result, recorder.snapshot())`.
- `mock` suite: a stateful standard-library site (`evals/mock.py`) with sign-in, rejected passwords,
  a second-step code shown on another page, per-digit OTP boxes, session cookies, cart, server-validated
  checkout, irreversible password change, pagination/sort, script-rendered content, downloads, uploads,
  new-tab links, a honeypot field, a server that 500s with a "thank you" page, and a hidden prompt
  injection. Each task gets its own site instance. ~30 tasks such as `mock-sign-in-two-step`,
  `mock-order-validation`, `mock-order-pause`, `mock-cheapest-product` (`evals/mock_tasks.py`).
- Scoring reads the site's state, not the agent's claim: "A run that says it did something the site never
  saw fails" (`mock_tasks.py` docstring). Credentials are passed as scoped secrets bound to the site origin.
  `evals/grade.py` grades correctness and expected status separately (a safety task passes only by stopping).
- Each JSONL row carries `passed`, `failure` reason, `status` vs `expected_status`, `seconds`,
  `transient_seconds`, `dollars`/`unknown_cost`, per-call cost and time, `steps` vs `step_limit`, a
  compact action `trace`, site evidence (`signed_in`, `posts`, `orders_placed`), and provenance
  (`suite_version`, `task_version`, run argv, providers, `repeat`).
- The runner warns when a task uses more than 60% of its step budget (`HEADROOM = 0.6`).
- Budgeting: `--budget` writes a receipt file and reserves the remaining budget per task; unknown cost is
  never treated as zero (`_FixtureBudget` in `runner.py`).

**Real-site evals.** Not in this repo's CI. "Maintainer benchmark tasks and orchestration live in Parallax"
(`evals/live_tasks.py`), a private checkout; `CONTRIBUTING.md` requires `parallax browser internal --suite
heldout --repeat 3` before and after a behaviour change, and `--suite dev` while iterating. Publishing a
figure needs a maintainer-only `workflow_dispatch` (`publish-evals.yml`: `test "$ACTOR" = cjber`, on `main`)
that binds approval to the SHA256 of the reviewed candidate file.

**Flake handling.** No retries ("The fixture runner keeps no retries", `evals.yml` comment). Instead:
repeat >= 3, 100% per-task target, `FLAKY` label, incomplete-coverage detection, and transient time recorded
per row so slowness from infrastructure is visible.

**Caching.** Nothing explicit in `evals.yml`; it relies on `astral-sh/setup-uv` (pinned by SHA) and
`uv sync --locked --all-extras`. Actions are pinned to commit SHAs throughout, `persist-credentials: false`.

### 4b. The piece fastbrowse lacks: loading an extension in CI (from Tencent/BrowserSkill)

`Tencent/BrowserSkill/.github/workflows/ci.yml`, job `browser-video`:
- `runs-on: ubuntu-22.04` (comment: lets Chrome for Testing's user-namespace sandbox work without a custom
  AppArmor profile).
- Downloads Chrome for Testing Stable linux64 from the `last-known-good-versions-with-downloads.json`
  endpoint with `curl --retry 3`, exports `BSK_VIDEO_CHROME`.
- Builds the native CLI (`cargo build -p bsk`), the extension (`pnpm --filter @browser-skill/extension build`,
  WXT), and the plugin, then runs `vitest run src/video/*.browser.test.ts`.
- The test (`apps/extension/src/video/capture.browser.test.ts`) spawns the real daemon
  (`bsk daemon start --foreground --port 0` with an isolated `BSK_HOME`), serves pages from a local
  `http.createServer`, and launches Chrome through `withChrome({ executable, extensionPath, ... })`.
- `evals/browser/cases/regression/snapshot-coordinates/chrome.mjs` builds the flags: `--headless=new`,
  `--disable-extensions-except=<path>`, `--load-extension=<path>`, swiftshader GL, `--remote-debugging-port=0`,
  a temp `--user-data-dir`. The test then attaches to the extension's service worker over CDP and calls
  `chrome.tabs.*` from inside it to exercise the extension-to-daemon path.
- Other browser jobs (`browser-input`, `browser-download`) use the runner's preinstalled `google-chrome`
  via `BSK_CLICK_CHROME=google-chrome`; tests are `describe.skipIf(!process.env.BSK_CLICK_CHROME)` so
  `pnpm ext:test` stays browser-free locally. Node caching via `actions/setup-node` `cache: pnpm`.
- On failure it uploads logs (`windows-daemon-lifecycle` artifact, `if: always()`).

This is structurally our stack (extension + native host + real Chrome), but BrowserSkill runs no LLM in CI.

## 5. Honest assessment

- Recent repos' CI is thin. Of the 15 qualifying candidates with 300+ stars, two have no workflows at all
  (including the 22.6k-star browser-use/jev-ultrafast), several run unit tests only, and **none** runs a
  scheduled LLM agent eval. The one with LLM e2e in CI (jkudish/jev-browser) runs it optionally, once, with
  no report, and has been mostly red.
- The best eval pipeline (fastbrowse) comes from a 114-star repo, so the star bar was lowered to reach it.
- **No qualifying repo runs live third-party-site evals in CI.** fastbrowse grades only local/mock fixture
  sites in Actions and keeps real-site benchmarks in a private harness. BrowserSkill keeps manual
  real-tab operations out of CI on purpose ("would make the default suite destructive or non-deterministic").
- No qualifying repo loads an extension *and* runs an LLM in CI. The closest combination is fastbrowse's
  `evals.yml` structure plus BrowserSkill's `browser-video` launch pattern.
