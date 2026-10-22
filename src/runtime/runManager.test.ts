import { describe, expect, it } from 'vitest';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { RunEndedEvent, RunHandle } from '@/src/agent/run';
import { DebuggerInputTier, type DebuggerApi } from '@/src/input';
import type { Config } from '@/src/storage';
import { chromeTabsPort, RunManager, type RunLogSink, type TabsPort } from './runManager';
import type { RuntimeDriver } from './pageTools';
import { getUserscript, saveUserscript } from '@/src/userscripts/catalog';
import type { PageTools } from '@/src/agent/tools';

const CLOCK = 1_700_000_000_000;

const quietHost: RunLogSink = { appendRunLog() {} };

function model(): BaseChatModel {
  return {} as BaseChatModel;
}

function pageDriver(textFor: (tabId: number) => string | undefined): RuntimeDriver {
  const ok = async () => ({ ok: true as const });
  return {
    async snapshot(tabId) {
      const text = textFor(tabId);
      if (text === undefined) return { ok: false, error: 'unknown tab' };
      return { ok: true, text };
    },
    screenshot: async () => ({ ok: true, dataUrl: 'data:image/png;base64,xx' }),
    extractText: async () => ({ ok: true, text: '' }),
    click: ok,
    type: ok,
    press: ok,
    select: ok,
    scroll: ok,
    hover: ok,
    ping_: async () => ({ ok: true, width: 1280, height: 720 }),
    getBox: async () => ({ ok: true, box: { x: 0, y: 0, width: 8, height: 8, centerX: 4, centerY: 4 } }),
    navigate: async () => ({ ok: true }),
    download: ok,
    saveFile: ok,
  };
}

/**
 * Last focused window overall is a popup. The normal window is returned only
 * when the caller restricts the query to normal windows and asks for its tabs.
 * `tabs.query` always answers with the popup, so a fallthrough is visible.
 */
function installChrome(normalTabs: Array<{ id?: number; active?: boolean; url?: string }>): void {
  const popup = { id: 99, active: true, url: 'https://mail.example/inbox', windowId: 2 };
  chrome.windows.getLastFocused = (async (info?: { populate?: boolean; windowTypes?: string[] }) => {
    const types = info?.windowTypes ?? [];
    const normalOnly = types.length > 0 && types.every((type) => type === 'normal');
    const tabs = normalOnly ? normalTabs : [popup];
    return {
      id: normalOnly ? 1 : 2,
      type: normalOnly ? 'normal' : 'popup',
      tabs: info?.populate ? tabs.map((tab) => ({ ...tab })) : undefined,
    };
  }) as typeof chrome.windows.getLastFocused;
  chrome.tabs.query = (async () => [{ ...popup }]) as unknown as typeof chrome.tabs.query;
  chrome.tabs.get = (async (tabId: number) => {
    const tab = [...normalTabs, popup].find((candidate) => candidate.id === tabId);
    if (!tab || tab.id === undefined) throw new Error(`no tab ${tabId}`);
    return { id: tab.id, url: tab.url ?? '' };
  }) as typeof chrome.tabs.get;
}

function controllableRun(runId: string): {
  handle: RunHandle;
  finish(): void;
  fail(error: unknown): void;
} {
  let finish!: (event: RunEndedEvent) => void;
  let fail!: (error: unknown) => void;
  const done = new Promise<RunEndedEvent>((resolve, reject) => {
    finish = resolve;
    fail = reject;
  });
  return {
    handle: {
      runId,
      pause() {},
      resume() {},
      abort() {
        finish({
          kind: 'run.ended',
          status: 'aborted',
          message: 'aborted by the user',
          steps: 2,
          at: CLOCK,
        });
      },
      done,
    },
    finish() {
      finish({
        kind: 'run.ended',
        status: 'done',
        message: 'objective complete',
        steps: 4,
        at: CLOCK,
      });
    },
    fail,
  };
}

describe('RunManager', () => {
  it('wires agent cleanup to the real catalog and preserves a script taken over by the user', async () => {
    const draft = { name: 'cleanup fixture', matches: ['https://notes.example/*'], code: 'return 1;' };
    const obsolete = await saveUserscript({ ...draft, author: 'agent' });
    const edited = await saveUserscript({ ...draft, author: 'agent' });
    await saveUserscript({ ...draft, id: edited.id, code: 'return "user edit";' });
    installChrome([{ id: 41, active: true, url: 'https://notes.example/today' }]);
    let bound!: PageTools;
    const manager = new RunManager({
      driver: pageDriver(() => 'Notes'),
      tabs: chromeTabsPort(),
      host: quietHost,
      createModel: () => model(),
      runUserscript: async () => ({ scriptId: 'unused', ok: true, console: [], durationMs: 0 }),
      listAvailableUserscripts: async () => [],
      start: (options) => {
        bound = options.tools;
        const run = controllableRun(options.runId!);
        run.finish();
        return run.handle;
      },
    });
    const started = await manager.start({
      prompt: 'remove my obsolete script',
      config: {
        leaderModel: 'nvidia/nemotron-3-ultra-550b-a55b:free',
        followerModel: 'nvidia/nemotron-3.5-lightning:free',
        observe: 'dom', planningInterval: 5, maxSteps: 50, inputFidelity: 'in-page',
      },
    });
    expect(started.ok).toBe(true);
    await started.done;
    await expect(bound.deleteUserscript(obsolete.id)).resolves.toContain(obsolete.id);
    expect(await getUserscript(obsolete.id)).toBeUndefined();
    await expect(bound.deleteUserscript(edited.id)).rejects.toThrow('written by the user');
    expect((await getUserscript(edited.id))?.code).toBe('return "user edit";');
  });

  it("chromeTabsPort uses the last focused normal window's active tab, and an empty result refuses the run instead of another tab", async () => {
    const textFor = (tabId: number): string | undefined => {
      if (tabId === 40) return 'Old note';
      if (tabId === 41) return 'Tuesday notes';
      if (tabId === 99) return 'Inbox — mail.example';
      return undefined;
    };
    const config: Config = {
      leaderModel: 'nvidia/nemotron-3-ultra-550b-a55b:free',
      followerModel: 'nvidia/nemotron-3.5-lightning:free',
      observe: 'dom',
      planningInterval: 5,
      maxSteps: 50,
      inputFidelity: 'in-page',
    };

    installChrome([
      { id: 40, active: false, url: 'https://notes.example/old' },
      { id: 41, active: true, url: 'https://notes.example/today' },
    ]);
    let read: Promise<string> | undefined;
    const focused = new RunManager({
      driver: pageDriver(textFor),
      tabs: chromeTabsPort(),
      host: quietHost,
      createModel: () => model(),
      runUserscript: async () => ({ scriptId: 'unused', ok: true, console: [], durationMs: 0 }),
      listAvailableUserscripts: async () => [],
      now: () => CLOCK,
      // `start` is synchronous in production. The snapshot promise is the page the bound tab returned.
      start: (options) => {
        read = options.tools.snapshot().then((shot) => shot.text);
        const run = controllableRun(options.runId ?? 'missing-run');
        run.finish();
        return run.handle;
      },
    });
    const started = await focused.start({ prompt: 'read the note', config });
    expect(started.ok).toBe(true);
    expect(await read).toBe('Tuesday notes');
    await started.done;

    installChrome([]);
    read = undefined;
    const empty = new RunManager({
      driver: pageDriver(textFor),
      tabs: chromeTabsPort(),
      host: quietHost,
      createModel: () => model(),
      runUserscript: async () => ({ scriptId: 'unused', ok: true, console: [], durationMs: 0 }),
      listAvailableUserscripts: async () => [],
      now: () => CLOCK,
      start: (options) => {
        read = options.tools.snapshot().then((shot) => shot.text);
        const run = controllableRun(options.runId ?? 'missing-run');
        run.finish();
        return run.handle;
      },
    });
    const refused = await empty.start({ prompt: 'read the note', config });
    expect(refused.ok).toBe(false);
    expect(read).toBeUndefined();

    chrome.windows.getLastFocused = (async () => {
      throw new Error('no window');
    }) as typeof chrome.windows.getLastFocused;
    const thrown = new RunManager({
      driver: pageDriver(textFor),
      tabs: chromeTabsPort(),
      host: quietHost,
      createModel: () => model(),
      runUserscript: async () => ({ scriptId: 'unused', ok: true, console: [], durationMs: 0 }),
      listAvailableUserscripts: async () => [],
      now: () => CLOCK,
      start: (options) => {
        read = options.tools.snapshot().then((shot) => shot.text);
        const run = controllableRun(options.runId ?? 'missing-run');
        run.finish();
        return run.handle;
      },
    });
    const lookupFailed = await thrown.start({ prompt: 'read the note', config });
    expect(lookupFailed.ok).toBe(false);
    expect(read).toBeUndefined();
    const ended = await refused.done;
    expect(ended.status).toBe('error');
    expect(ended.steps).toBe(0);
  });

  it('when a run ends, aborts, or the handle rejects, the debugger detaches', async () => {
    const api: DebuggerApi = {
      async attach() {},
      async detach() {},
      async sendCommand() {
        return undefined;
      },
      onDetach: {
        addListener() {},
        removeListener() {},
      },
    };
    let tier: DebuggerInputTier | undefined;
    const tabs: TabsPort = {
      async activeTab() {
        return { id: 11, url: 'https://shop.example/item' };
      },
      async get(tabId) {
        return tabId === 11 ? { id: 11, url: 'https://shop.example/item' } : undefined;
      },
    };
    const config: Config = {
      leaderModel: 'nvidia/nemotron-3-ultra-550b-a55b:free',
      followerModel: 'nvidia/nemotron-3.5-lightning:free',
      observe: 'dom',
      planningInterval: 5,
      maxSteps: 50,
      inputFidelity: 'escalated',
    };
    const runs: Array<ReturnType<typeof controllableRun>> = [];
    const manager = new RunManager({
      driver: pageDriver(() => undefined),
      tabs,
      host: quietHost,
      createModel: () => model(),
      makeDebuggerTier: (onDetach) => {
        tier = new DebuggerInputTier(api, { onDetach, sleep: async () => {}, rng: () => 0 });
        return tier;
      },
      runUserscript: async () => ({ scriptId: 'unused', ok: true, console: [], durationMs: 0 }),
      listAvailableUserscripts: async () => [],
      now: () => CLOCK,
      start: (options) => {
        const run = controllableRun(options.runId ?? 'missing-run');
        runs.push(run);
        return run.handle;
      },
    });

    const endedRun = await manager.start({ prompt: 'end the run', config });
    expect(tier?.isAttached()).toBe(true);
    const ended = runs.at(-1);
    if (!ended) throw new Error('the run did not start');
    ended.finish();
    await endedRun.done;
    expect(tier?.isAttached()).toBe(false);
    await expect(tier?.click(12, 8)).rejects.toBeInstanceOf(Error);

    const abortedRun = await manager.start({ prompt: 'abort the run', config });
    expect(tier?.isAttached()).toBe(true);
    expect(manager.abort(abortedRun.runId)).toBe(true);
    await abortedRun.done;
    expect(tier?.isAttached()).toBe(false);
    await expect(tier?.click(12, 8)).rejects.toBeInstanceOf(Error);

    const rejectedRun = await manager.start({ prompt: 'reject the run', config });
    expect(tier?.isAttached()).toBe(true);
    const rejectedHandle = runs.at(-1);
    if (!rejectedHandle) throw new Error('the run did not start');
    rejectedHandle.fail(new Error('the model socket closed'));
    const rejected = await rejectedRun.done;
    expect(rejected).toMatchObject({ status: 'error', message: 'the model socket closed', steps: 0 });
    expect(tier?.isAttached()).toBe(false);
    await expect(tier?.click(12, 8)).rejects.toBeInstanceOf(Error);
  });
});
