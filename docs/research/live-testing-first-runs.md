# First live runs in the real Chrome, and what to change (2026-10-11)

Three rounds of `scripts/live.sh test` on 2026-10-11, in the user's real Chrome 154 (profile
`Default`), free pair only (Leader `nvidia/nemotron-3-ultra-550b-a55b:free`, Follower
`nvidia/nemotron-3.5-lightning:free`), local fixtures on 127.0.0.1. Then three research passes
via Exa. "Verified" means read at the source; "inferred" means reasoning or a single
third-party report. Open work is in GitHub issues, not here.

## What ran

| Round | Build | Result |
|---|---|---|
| 1 | `live-testing-tooling` (main + tooling) | 5 passed, 3 failed |
| 2 "before" | #36 slice 1 only (usage logging, up to 4 snapshots per Follower call) + tooling | 4 passed, 4 failed |
| 3 "after" | #36 head (one snapshot, none when unchanged) + tooling | 4 passed, 4 failed |

`userscript_debug`, `login`, `redaction` and `download` passed in every round. The trusted
click (`escalation`) landed every round: the fixture's `isTrusted` beacon fired.

## What the failures were

- **Scorer stricter than the result.** `inventory` returned exactly the fixture rows but read
  them from the post-click observation, and the verdict demands an `extract_text` call.
  `escalation` answered `{"status": "clicked (trusted)"}`; the verdict wants the full status
  line `Status: clicked (trusted).`.
- **Fixture weaker than its intent.** `stall` (occluded button, must end `error`) was solved
  by a userscript calling `btn.click()`; the handler does not check `isTrusted`.
- **State leaking between tests.** Agent-written userscripts persist in the real profile
  (`local:userscripts`, listed regardless of URL). Round 2's `stall` reran round 1's
  `approve-loop` script and finished in 3 steps. Round 3's `readonly` read six leftover
  scripts, never wrote its own, and hit `max-steps`. The A/B is contaminated by this, not by
  #36: that Follower called `snapshot` itself twice.
- **A tool reporting failure after acting.** `run_userscript` answered
  `failed ... this script returns nothing` twice for an async IIFE that had already clicked
  (the Leader's next snapshot read `Status: finished.`).
- **Unexplained once.** Round 3 `stall`: `navigation to http://127.0.0.1:39547/stall did not
  complete in 30000ms`.
- **Tabs pile up.** Each task opens a tab with `google-chrome <url>`; nothing closes it (~25
  after three rounds). `--new-window <url>` produced a `view-source:` tab and no window, so it
  was reverted. Nothing documents that behaviour.

## Token cost, live

Follower prompt chars per call, same tasks, before -> after: download 2,881 -> 2,807,
inventory 2,953 -> 2,924, userscript_debug 6,160 -> 5,843. Fixture snapshots are 1-3k chars,
so #36 has nothing to remove here; its offline -73% is on a 24.7k-char eBay snapshot.

Across rounds 2 and 3 (from `model.usage`):

| Role | Calls | Input tokens | Cached tokens |
|---|---|---|---|
| Follower | 52 | 382,343 | 303,920 (79%) |
| Leader | 34 | 46,397 | 0 |

- ~7k input tokens per Follower call against ~2.9k prompt chars: the rest is fixed. Verified
  offline: the 20 Follower tool definitions are 18,958 chars of OpenAI-format JSON, 8,680 of
  them the `signal`/`note` envelope (`controlEnvelope`, `src/agent/tools.ts`) repeated in
  every tool; `FOLLOWER_SYSTEM` is 1,568 chars.
- The free Lightning endpoint already prefix-caches; the Leader got no hits. Only system plus
  tools is a stable prefix, because the Follower history is a 3-turn sliding window
  (`FOLLOWER_HISTORY_TURNS`) rewritten by `compactObservations` every turn.
- Each call runs one action by design (`EXTRA_CALL_REFUSAL`, `src/agent/graph.ts`).
- Free models are limited by requests: 20/min, and 50/day under 10 purchased credits or
  1000/day at or above ([limits](https://openrouter.ai/docs/api/reference/limits), verified).
  ~130 calls on 2026-10-11 drew no 429, so this account is past the 50/day tier (inferred).
  Calls per task are the binding cost; chars per call matter on big pages.

## What practice says (ranked for this project)

1. **Repeat each task K times; report pass@1 and pass^K.** τ-bench defines pass^k
   ([2406.12045](https://arxiv.org/abs/2406.12045)); Stagehand's runner defaults to 3 trials
   ([runner.ts](https://github.com/browserbase/stagehand/blob/2785d0d1/packages/evals/framework/runner.ts));
   browser-use runs 5 ([post](https://browser-use.com/posts/benchmark-behind-the-benchmark)).
   5/5 only shows reliability >= 57% (inferred arithmetic). Classify 429/5xx as infra, not
   agent failure ([judge.py](https://github.com/browser-use/browser-use/blob/85ddbfed/browser_use/agent/judge.py)).
2. **A/B in the harness tier, paired.** Same task and seed per trial across arms, interleaved,
   per-task differences ([2411.00640](https://arxiv.org/html/2411.00640v1)). Pin the provider
   with `provider.order` + `allow_fallbacks:false`
   ([routing](https://openrouter.ai/docs/guides/routing/provider-selection)). For a prompt
   change, replaying recorded model answers through old and new code is deterministic and
   free; that is how the offline eBay number was made. Heavy pages from saved copies on
   localhost: eBay, a long Wikipedia article, Hacker News.
3. **Isolate every trial.** Anthropic starts each trial clean; shared state correlates failures
   ([post](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)).
   Playwright's extension fixtures use a fresh user-data-dir per test
   ([fixtures](https://github.com/microsoft/playwright/blob/5790370e/tests/extension/extension-fixtures.ts)).
   In the real profile that means a test-only snapshot/restore of agent-writable storage
   (`storage.local`, since `storage.session` is cleared on reload,
   [storage](https://developer.chrome.com/docs/extensions/reference/api/storage)). All
   127.0.0.1 fixtures share cookies: cookies are not port-scoped (RFC 6265 §8.5; per-trial
   `*.localhost` origins fix that, inferred).
4. **Let the extension own the test tab.** `chrome.tabs.create({active:false})` plus
   `chrome.tabs.group`, run on that `tabId` (`StartOptions.tabId` already exists), then
   `tabs.ungroup` and `tabs.remove` at run end
   ([tabs](https://developer.chrome.com/docs/extensions/reference/api/tabs),
   [tabGroups](https://developer.chrome.com/docs/extensions/reference/api/tabGroups)).
   Ungroup first: `remove()` alone left a saved-group chip on Chrome 151
   ([agent-browser-mcp](https://github.com/cmsflash/agent-browser-mcp), third-party).
   Background tabs stop `requestAnimationFrame` and stall CDP input acks; after a debugger
   attach, `Emulation.setFocusEmulationEnabled` and `Page.setWebLifecycleState {active}`
   ([edfl.dev](https://www.edfl.dev/blog/five-things-chrome-does-to-a-background-tab/),
   [agent-browser #1427](https://github.com/vercel-labs/agent-browser/pull/1427)).
5. **One load path outside every checkout.** Chrome loads unpacked from
   `~/projects/nanobrowser-v2/.output/chrome-mv3`, and every worktree's `setup` rsyncs into it,
   so the last one wins. A symlink does not help: Load unpacked resolves the path with
   `MakeAbsoluteFilePath` / `realpath()`
   ([unpacked_installer.cc](https://chromium.googlesource.com/chromium/src/+/refs/tags/146.0.7638.0/extensions/browser/unpacked_installer.cc)).
   Deploy under a lock, stamp `version_name` with worktree@sha, and report it in `nb-status`.
6. **Keep deterministic scorers.** WebArena-Verified dropped its LLM judge for typed exact
   matching ([docs](https://servicenow.github.io/webarena-verified/evaluation/removing_llm_based_evaluation/)).
7. **Fewer calls before shorter prompts.** Batched actions are the common answer: Playwright
   MCP `browser_fill_form`, Agent-E `enter_text_and_click`
   ([README](https://github.com/EmergenceAI/Agent-E/)). Tool search is not worth it under ~10k
   tokens of definitions ([Anthropic](https://www.anthropic.com/engineering/advanced-tool-use)).
   Chrome DevTools MCP ships a 3-tool `--slim` mode
   ([PR #958](https://github.com/ChromeDevTools/chrome-devtools-mcp/pull/958)).

Not found: whether the `:free` Nemotron Ultra endpoint caches at all; Wayland behaviour of
unfocused new windows; why `--new-window` opened `view-source:`.
