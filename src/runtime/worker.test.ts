import { describe, expect, it, vi } from 'vitest';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { RunEndedEvent, RunHandle, StartRunOptions } from '@/src/agent/run';
import { createChannel, createFakePortPair, type Envelope, type RunEvent } from '@/src/messaging';
import type { Config } from '@/src/storage';
import { FakeNativePort, HostClient } from '@/src/host/native';
import { RunManager, type HostRunEndEvent, type RunLogSink, type TabsPort } from './runManager';
import type { RuntimeDriver } from './pageTools';
import { createWorker, type DevRunStart, type HostPort } from './worker';
import { createChatModel } from '@/src/agent/models';
import { MemorySaver } from '@langchain/langgraph/web';

const CLOCK = 1_700_000_000_000;

const panelConfig = (): Config => ({
  leaderModel: 'nvidia/nemotron-3-ultra-550b-a55b:free',
  followerModel: 'nvidia/nemotron-3.5-lightning:free',
  observe: 'dom',
  planningInterval: 5,
  maxSteps: 50,
  inputFidelity: 'in-page',
});

function hostPort(): HostPort {
  return {
    async keyStatus() {
      return { hostConnected: true, keyReady: true };
    },
    async listModels() {
      return [];
    },
    appendRunLog() {},
    onRunStart() {
      return () => {};
    },
    onRunAbort() {
      return () => {};
    },
    appendLog() {},
    onExtReload() {
      return () => {};
    },
  };
}

function model(): BaseChatModel {
  return {} as BaseChatModel;
}

function idleHandle(runId: string): RunHandle {
  return {
    runId,
    pause() {},
    resume() {},
    abort() {},
    done: new Promise<RunEndedEvent>(() => {}),
  };
}

function pageDriver(
  pages: Map<number, string>,
  navigate: (tabId: number, url: string) => void,
): RuntimeDriver {
  const ok = async () => ({ ok: true as const });
  return {
    async snapshot(tabId) {
      const text = pages.get(tabId);
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
    async navigate(tabId, url) {
      navigate(tabId, url);
      return { ok: true };
    },
    download: ok,
    saveFile: ok,
  };
}

function runEventsOf(port: { onMessage(handler: (message: Envelope) => void): () => void }): Array<{
  runId: string;
  event: RunEvent;
}> {
  const events: Array<{ runId: string; event: RunEvent }> = [];
  port.onMessage((envelope) => {
    if (envelope?.type !== 'run.event') return;
    const payload = envelope.payload as { runId?: unknown; event?: RunEvent };
    if (typeof payload?.runId !== 'string' || !payload.event) return;
    events.push({ runId: payload.runId, event: payload.event });
  });
  return events;
}

describe('worker', () => {
  it('sends the CLI run.end terminator after model timeouts exhaust retries', async () => {
    let attempts = 0;
    const hangingFetch: typeof fetch = async (_url, init) => {
      attempts++;
      return new Promise((_resolve, reject) => {
        init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true });
      });
    };
    const timedModel = createChatModel({ model: 'fixture:free', fetch: hangingFetch, requestTimeoutMs: 10 });
    const host = hostPort();
    let begin!: Parameters<HostPort['onRunStart']>[0];
    host.onRunStart = (listener) => { begin = listener; return () => {}; };
    let finish!: (event: HostRunEndEvent) => void;
    const terminal = new Promise<HostRunEndEvent>((resolve) => { finish = resolve; });
    host.appendRunLog = (_id, event) => {
      if ('type' in event && event.type === 'run.end') finish(event);
    };
    const tab = { id: 11, url: 'https://example.com' };
    const manager = new RunManager({
      driver: pageDriver(new Map([[11, 'fixture page']]), () => {}),
      tabs: { activeTab: async () => tab, get: async () => tab },
      host, createModel: () => timedModel, checkpointer: new MemorySaver(),
      runUserscript: async () => ({ scriptId: 'unused', ok: true, console: [], durationMs: 0 }),
      listAvailableUserscripts: async () => [],
    });
    const worker = createWorker({ host, runManager: manager, getConfig: async () => panelConfig() });
    try {
      begin({ runId: 'timeout-cli', prompt: 'read the page' });
      const ended = await terminal;
      expect(ended).toMatchObject({ type: 'run.end', runId: 'timeout-cli', status: 'error' });
      expect(ended.message).toMatch(/timed? ?out/i);
      expect(attempts).toBe(3);
      expect(manager.activeRunId).toBeUndefined();
    } finally {
      worker.dispose();
    }
  });

  it('a panel run binds the tab that was active when it started and does not navigate it, and a later focused tab does not replace it', async () => {
    const tabs = new Map<number, { id: number; url: string }>([
      [11, { id: 11, url: 'https://shop.example/item' }],
      [22, { id: 22, url: 'https://other.example/home' }],
    ]);
    const pages = new Map<number, string>([
      [11, 'Wool socks'],
      [22, 'Garden rakes'],
    ]);
    let activeId = 11;
    const tabPort: TabsPort = {
      async activeTab() {
        const tab = tabs.get(activeId);
        return tab ? { ...tab } : undefined;
      },
      async get(tabId) {
        const tab = tabs.get(tabId);
        return tab ? { ...tab } : undefined;
      },
    };
    let first = '';
    let readAgain: () => Promise<string> = async () => '';
    let refresh: () => Promise<Array<{ id: string; name: string }>> = async () => [];
    let opened!: () => void;
    const open = new Promise<void>((resolve) => {
      opened = resolve;
    });
    const manager = new RunManager({
      driver: pageDriver(pages, (tabId, url) => {
        const tab = tabs.get(tabId);
        if (tab) tab.url = url;
        pages.set(tabId, `navigated to ${url}`);
      }),
      tabs: tabPort,
      host: { appendRunLog() {} } satisfies RunLogSink,
      createModel: () => model(),
      runUserscript: async () => ({ scriptId: 'unused', ok: true, console: [], durationMs: 0 }),
      listAvailableUserscripts: async (url) => {
        if (url === 'https://shop.example/item') return [{ id: 'wool', name: 'Wool extract' }];
        return [{ id: 'rakes', name: 'Rake extract' }];
      },
      now: () => CLOCK,
      start: (options: StartRunOptions) => {
        void options.tools.snapshot().then(
          (shot) => {
            first = shot.text;
            readAgain = () => options.tools.snapshot().then((next) => next.text);
            const refreshUserscripts = options.refreshUserscripts;
            refresh = () => refreshUserscripts?.() ?? Promise.resolve([]);
            opened();
          },
          (error: unknown) => {
            first = error instanceof Error ? error.message : String(error);
            opened();
          },
        );
        return idleHandle(options.runId ?? 'panel-run');
      },
    });
    const worker = createWorker({
      host: hostPort(),
      runManager: manager,
      getConfig: async () => ({
        leaderModel: 'stored-model-not-for-this-run',
        followerModel: 'stored-follower-not-for-this-run',
        observe: 'pixels',
        planningInterval: 9,
        maxSteps: 3,
        inputFidelity: 'escalated',
      }),
    });
    const [panelPort, extensionPort] = createFakePortPair();
    const panel = createChannel(panelPort);
    const failures: string[] = [];
    panelPort.onMessage((envelope) => {
      if (envelope?.type === 'error') failures.push(JSON.stringify(envelope.payload));
    });
    worker.connect(extensionPort);
    panel.send('run.start', { prompt: 'find wool socks', config: panelConfig() });
    await open;

    expect(failures).toEqual([]);
    expect(first).toBe('Wool socks');
    expect(tabs.get(11)).toEqual({ id: 11, url: 'https://shop.example/item' });
    activeId = 22;
    expect(await readAgain()).toBe('Wool socks');
    expect(await refresh()).toEqual([{ id: 'wool', name: 'Wool extract' }]);
    expect(tabs.get(11)).toEqual({ id: 11, url: 'https://shop.example/item' });
  });

  it('a second panel receives the same run events', async () => {
    let published!: () => void;
    const publishedRun = new Promise<void>((resolve) => {
      published = resolve;
    });
    const manager = new RunManager({
      driver: pageDriver(new Map([[11, 'Wool socks']]), () => {}),
      tabs: {
        async activeTab() {
          return { id: 11, url: 'https://shop.example/item' };
        },
        async get(tabId) {
          return tabId === 11 ? { id: 11, url: 'https://shop.example/item' } : undefined;
        },
      },
      host: { appendRunLog() {} },
      createModel: () => model(),
      runUserscript: async () => ({ scriptId: 'unused', ok: true, console: [], durationMs: 0 }),
      listAvailableUserscripts: async () => [],
      now: () => CLOCK,
      newRunId: () => 'run-wool-1',
      start: (options) => {
        options.onEvent({
          kind: 'run.started',
          runId: options.runId ?? '',
          prompt: options.prompt,
          config: options.config,
          tabId: options.tabId ?? -1,
          url: options.url ?? '',
          at: CLOCK,
        });
        published();
        return idleHandle(options.runId ?? 'panel-run');
      },
    });
    const worker = createWorker({
      host: hostPort(),
      runManager: manager,
      getConfig: async () => ({
        leaderModel: 'stored-model-not-for-this-run',
        followerModel: 'stored-follower-not-for-this-run',
        observe: 'pixels',
        planningInterval: 9,
        maxSteps: 3,
        inputFidelity: 'escalated',
      }),
    });
    const [firstPort, firstExtension] = createFakePortPair();
    const [secondPort, secondExtension] = createFakePortPair();
    const firstEvents = runEventsOf(firstPort);
    const secondEvents = runEventsOf(secondPort);
    worker.connect(firstExtension);
    worker.connect(secondExtension);
    createChannel(firstPort).send('run.start', { prompt: 'find wool socks', config: panelConfig() });
    await publishedRun;

    const expected = [
      {
        runId: 'run-wool-1',
        event: {
          kind: 'run.started',
          runId: 'run-wool-1',
          prompt: 'find wool socks',
          config: {
            leaderModel: 'nvidia/nemotron-3-ultra-550b-a55b:free',
            followerModel: 'nvidia/nemotron-3.5-lightning:free',
            observe: 'dom',
            planningInterval: 5,
            maxSteps: 50,
            inputFidelity: 'in-page',
          },
          tabId: 11,
          url: 'https://shop.example/item',
          at: 1_700_000_000_000,
        },
      },
      {
        runId: 'run-wool-1',
        event: {
          kind: 'input.fidelity',
          fidelity: 'in-page',
          attached: false,
          at: 1_700_000_000_000,
        },
      },
    ];
    expect(firstEvents).toEqual(expected);
    expect(secondEvents).toEqual(expected);
  });

  it('a null or non-object envelope does not throw, and a later run.start still acts on the tab', async () => {
    const pages = new Map<number, string>([
      [11, 'Wool socks'],
      [22, 'Garden rakes'],
    ]);
    let read = '';
    let opened!: () => void;
    const open = new Promise<void>((resolve) => {
      opened = resolve;
    });
    const manager = new RunManager({
      driver: pageDriver(pages, () => {}),
      tabs: {
        async activeTab() {
          return { id: 11, url: 'https://shop.example/item' };
        },
        async get(tabId) {
          return tabId === 11 ? { id: 11, url: 'https://shop.example/item' } : undefined;
        },
      },
      host: { appendRunLog() {} },
      createModel: () => model(),
      runUserscript: async () => ({ scriptId: 'unused', ok: true, console: [], durationMs: 0 }),
      listAvailableUserscripts: async () => [],
      now: () => CLOCK,
      start: (options) => {
        void options.tools.snapshot().then(
          (shot) => {
            read = shot.text;
            opened();
          },
          (error: unknown) => {
            read = error instanceof Error ? error.message : String(error);
            opened();
          },
        );
        return idleHandle(options.runId ?? 'panel-run');
      },
    });
    const worker = createWorker({
      host: hostPort(),
      runManager: manager,
      getConfig: async () => panelConfig(),
    });
    const [panelPort, extensionPort] = createFakePortPair();
    const panel = createChannel(panelPort);
    worker.connect(extensionPort);

    expect(() => panelPort.postMessage(null as never)).not.toThrow();
    expect(() => panelPort.postMessage(0 as never)).not.toThrow();
    panel.send('run.start', { prompt: 'find wool socks', config: panelConfig() });
    await open;
    expect(read).toBe('Wool socks');
  });

  it('a dev trigger with a url while a panel run is in progress is refused without navigating the running tab', async () => {
    const pages = new Map<number, string>([[11, 'Wool socks']]);
    const navigations: Array<{ tabId: number; url: string }> = [];
    let begun!: () => void;
    const panelRunBegun = new Promise<void>((resolve) => {
      begun = resolve;
    });
    const manager = new RunManager({
      driver: pageDriver(pages, (tabId, url) => navigations.push({ tabId, url })),
      tabs: {
        async activeTab() {
          return { id: 11, url: 'https://shop.example/item' };
        },
        async get(tabId) {
          return tabId === 11 ? { id: 11, url: 'https://shop.example/item' } : undefined;
        },
      },
      host: { appendRunLog() {} },
      createModel: () => model(),
      runUserscript: async () => ({ scriptId: 'unused', ok: true, console: [], durationMs: 0 }),
      listAvailableUserscripts: async () => [],
      now: () => CLOCK,
      newRunId: () => 'panel-run',
      start: (options) => {
        begun();
        return idleHandle(options.runId ?? 'panel-run');
      },
    });
    const dev = devHost();
    const worker = createWorker({ host: dev.host, runManager: manager, getConfig: async () => panelConfig() });
    const [panelPort, extensionPort] = createFakePortPair();
    worker.connect(extensionPort);
    createChannel(panelPort).send('run.start', { prompt: 'find wool socks', config: panelConfig() });
    await panelRunBegun;

    dev.trigger({ runId: 'dev-run', prompt: 'find garden rakes', url: 'https://garden.example/rakes' });
    const end = await dev.ended('dev-run');

    expect(navigations).toEqual([]);
    expect(end).toMatchObject({
      status: 'error',
      message: 'a run is already in progress (panel-run); abort it first',
      steps: 0,
    });
    expect(manager.activeRunId).toBe('panel-run');
  });

  it("a dev trigger's url is opened in the tab the run then binds, even when focus moves during the navigation", async () => {
    const tabs = new Map<number, { id: number; url: string }>([
      [11, { id: 11, url: 'https://shop.example/item' }],
      [22, { id: 22, url: 'https://mail.example/inbox' }],
    ]);
    const pages = new Map<number, string>([
      [11, 'Wool socks'],
      [22, 'Inbox'],
    ]);
    let activeId = 11;
    let bound: { tabId?: number; url?: string; page?: string } = {};
    let opened!: () => void;
    const open = new Promise<void>((resolve) => {
      opened = resolve;
    });
    const manager = new RunManager({
      driver: pageDriver(pages, (tabId, url) => {
        const tab = tabs.get(tabId);
        if (tab) tab.url = url;
        pages.set(tabId, `navigated to ${url}`);
        // The user switches tabs while the page loads.
        activeId = 22;
      }),
      tabs: {
        async activeTab() {
          const tab = tabs.get(activeId);
          return tab ? { ...tab } : undefined;
        },
        async get(tabId) {
          const tab = tabs.get(tabId);
          return tab ? { ...tab } : undefined;
        },
      },
      host: { appendRunLog() {} },
      createModel: () => model(),
      runUserscript: async () => ({ scriptId: 'unused', ok: true, console: [], durationMs: 0 }),
      listAvailableUserscripts: async () => [],
      now: () => CLOCK,
      start: (options) => {
        void options.tools.snapshot().then((shot) => {
          bound = { tabId: options.tabId, url: options.url, page: shot.text };
          opened();
        });
        return idleHandle(options.runId ?? 'dev-run');
      },
    });
    const dev = devHost();
    createWorker({ host: dev.host, runManager: manager, getConfig: async () => panelConfig() });

    dev.trigger({ runId: 'dev-run', prompt: 'find garden rakes', url: 'https://garden.example/rakes' });
    await open;

    expect(bound).toEqual({
      tabId: 11,
      url: 'https://garden.example/rakes',
      page: 'navigated to https://garden.example/rakes',
    });
    expect(pages.get(22)).toBe('Inbox');
  });
});

/** Real worker/manager/native-client wiring; only the host and browser effects are fake. */
function readinessFixture(stored = panelConfig()) {
  const native = new FakeNativePort();
  const host = new HostClient(() => native);
  const createModel = vi.fn(() => model());
  const saveLastRunId = vi.fn(async () => {});
  const navigate = vi.fn();
  const start = vi.fn((options: StartRunOptions) => idleHandle(options.runId!));
  const manager = new RunManager({
    driver: pageDriver(new Map([[11, 'fixture page']]), navigate),
    tabs: {
      activeTab: async () => ({ id: 11, url: 'https://example.test/' }),
      get: async () => ({ id: 11, url: 'https://example.test/' }),
    },
    host,
    createModel,
    saveLastRunId,
    runUserscript: async () => ({ scriptId: 'unused', ok: true, console: [], durationMs: 0 }),
    listAvailableUserscripts: async () => [],
    start,
  });
  const managerStart = vi.spyOn(manager, 'start');
  const worker = createWorker({ host, runManager: manager, getConfig: async () => stored });
  const [panelPort, workerPort] = createFakePortPair();
  const messages: Envelope[] = [];
  panelPort.onMessage((message) => messages.push(message));
  worker.connect(workerPort);
  const panel = createChannel(panelPort);
  host.connect();
  const queries = () => native.sent.filter((m) => m.type === 'key.status');
  const answer = (missing?: string) => {
    for (const query of queries()) {
      native.emit({ type: 'key.status.result', id: query.id, ready: query.source !== missing,
        ...(query.source === missing ? { reason: 'key not configured' } : {}) });
    }
  };
  const expectNotStarted = () => {
    expect(managerStart).not.toHaveBeenCalled();
    expect(createModel).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
    expect(saveLastRunId).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
    expect(manager.activeRunId).toBeUndefined();
    expect(native.sent.some((m) => m.type === 'llm.request')).toBe(false);
  };
  return { host, native, panel, messages, manager, managerStart, createModel, start,
    queries, answer, expectNotStarted, close: () => { worker.dispose(); panel.close(); host.close(); } };
}

describe('selected-source readiness at the worker boundary', () => {
  it.each([
    ['openrouter', 'leader'], ['kilo', 'leader'], ['openrouter', 'follower'], ['kilo', 'follower'],
  ] as const)('a missing %s key for the %s blocks both readiness and a direct start despite the other ready key', async (missing, role) => {
    const f = readinessFixture();
    try {
      const other = missing === 'openrouter' ? 'kilo' : 'openrouter';
      const config: Config = { ...panelConfig(), leaderModelSource: role === 'leader' ? missing : other,
        followerModelSource: role === 'follower' ? missing : other };
      f.panel.send('readiness.get', { ...config, requestId: 'selection-1' });
      expect(f.queries().map((q) => q.source)).toEqual([config.leaderModelSource, config.followerModelSource]);
      f.answer(missing);
      await vi.waitFor(() => expect(f.messages).toContainEqual(expect.objectContaining({
        type: 'readiness', payload: { hostConnected: true, keyReady: false,
          reason: `${missing}: key not configured`, requestId: 'selection-1' },
      })));
      f.panel.send('run.start', { prompt: 'fixture', config });
      expect(f.queries()).toHaveLength(4); // Start revalidates, independent of any panel answer.
      f.answer(missing);
      await vi.waitFor(() => expect(f.messages).toContainEqual(expect.objectContaining({
        type: 'error', payload: { inReplyTo: 'run.start', message: `${missing}: key not configured` },
      })));
      f.expectNotStarted();
    } finally { f.close(); }
  });

  it.each([
    { name: 'mixed sources', selection: { leaderModelSource: 'kilo', followerModelSource: 'openrouter' }, sources: ['kilo', 'openrouter'] },
    { name: 'shared Kilo source checked once', selection: { leaderModelSource: 'kilo', followerModelSource: 'kilo' }, sources: ['kilo'] },
    { name: 'legacy omitted sources use OpenRouter once', selection: {}, sources: ['openrouter'] },
    { name: 'only the omitted role defaults to OpenRouter', selection: { leaderModelSource: 'kilo' }, sources: ['kilo', 'openrouter'] },
  ] as const)('$name starts only after all selected keys are ready', async ({ selection, sources }) => {
    const f = readinessFixture();
    try {
      // Arbitrary model ids remain allowed, regardless of pricing or catalog membership.
      const config = { ...panelConfig(), leaderModel: 'any-model', ...selection };
      f.panel.send('run.start', { prompt: 'fixture', config });
      expect(f.queries().map((q) => q.source)).toEqual(sources);
      f.expectNotStarted();
      if (sources.length > 1) {
        f.native.emit({ type: 'key.status.result', id: f.queries()[0]!.id, ready: true });
        await new Promise((resolve) => setTimeout(resolve, 0));
        f.expectNotStarted(); // One ready source cannot release a mixed-source run.
      }
      f.answer();
      await vi.waitFor(() => expect(f.start).toHaveBeenCalledOnce());
      expect(f.managerStart).toHaveBeenCalledWith({ prompt: 'fixture', config, followerVision: undefined });
      expect(f.createModel.mock.calls).toHaveLength(2);
    } finally { f.close(); }
  });

  it.each(['disconnect', 'host error', 'thrown error'] as const)('%s fails closed with connection diagnostics before starting', async (failure) => {
    const f = readinessFixture();
    try {
      if (failure === 'thrown error') vi.spyOn(f.host, 'keyStatus').mockRejectedValue(new Error('fixture transport failure'));
      f.panel.send('readiness.get', { requestId: 'connection-check' });
      f.panel.send('run.start', { prompt: 'fixture', config: panelConfig() });
      if (failure === 'disconnect') f.native.disconnect();
      if (failure === 'host error') {
        for (const q of f.queries()) f.native.emit({ type: 'error', id: q.id, code: 'io', message: 'fixture transport failure' });
      }
      await vi.waitFor(() => expect(f.messages).toContainEqual(expect.objectContaining({ type: 'error', payload: {
        inReplyTo: 'run.start', message: expect.stringContaining('native host not reachable'),
      } })));
      expect(f.messages).toContainEqual(expect.objectContaining({ type: 'readiness', payload: {
        requestId: 'connection-check', hostConnected: false, keyReady: false,
        reason: expect.stringContaining('native host not reachable'),
      } }));
      f.expectNotStarted();
    } finally { f.close(); }
  });

  it.each([false, true])('host-trigger startup checks the effective stored config with overrides=%s before navigation', async (override) => {
    const f = readinessFixture({ ...panelConfig(), leaderModelSource: 'kilo', followerModelSource: 'kilo' });
    try {
      f.native.emit({ type: 'run.start', runId: 'cli-fixture', prompt: 'fixture', url: 'https://example.test/next',
        ...(override ? { options: { leaderModelSource: 'openrouter' } } : {}) });
      await vi.waitFor(() => expect(f.queries()).toHaveLength(override ? 2 : 1));
      expect(f.queries().map((q) => q.source)).toEqual(override ? ['openrouter', 'kilo'] : ['kilo']);
      f.answer(override ? 'openrouter' : 'kilo');
      await vi.waitFor(() => expect(f.native.sent).toContainEqual(expect.objectContaining({
        type: 'runlog.append', runId: 'cli-fixture', event: expect.objectContaining({
          type: 'run.end', status: 'error', steps: 0,
          message: `${override ? 'openrouter' : 'kilo'}: key not configured`,
        }),
      })));
      f.expectNotStarted();
    } finally { f.close(); }
  });

  it('a host-trigger cancel while readiness is pending ends the run aborted without starting it', async () => {
    const f = readinessFixture();
    try {
      f.native.emit({ type: 'run.start', runId: 'cli-fixture', prompt: 'fixture', url: 'https://example.test/next' });
      await vi.waitFor(() => expect(f.queries()).toHaveLength(1));
      // No run-manager slot exists yet; the cancel must still stop the run once readiness resolves.
      f.native.emit({ type: 'run.abort', runId: 'cli-fixture' });
      f.answer();
      await vi.waitFor(() => expect(f.native.sent).toContainEqual(expect.objectContaining({
        type: 'runlog.append', runId: 'cli-fixture', event: expect.objectContaining({
          type: 'run.end', status: 'aborted', steps: 0,
        }),
      })));
      f.expectNotStarted();
    } finally { f.close(); }
  });

  it('a host-trigger override to a ready source starts even if the stored source has no key', async () => {
    const f = readinessFixture();
    try {
      f.native.emit({ type: 'run.start', runId: 'cli-fixture', prompt: 'fixture',
        options: { leaderModelSource: 'kilo', followerModelSource: 'kilo', observe: 'both' } });
      await vi.waitFor(() => expect(f.queries().map((q) => q.source)).toEqual(['kilo']));
      f.answer('openrouter');
      await vi.waitFor(() => expect(f.start).toHaveBeenCalledOnce());
      expect(f.managerStart).toHaveBeenCalledWith(expect.objectContaining({
        config: { ...panelConfig(), leaderModelSource: 'kilo', followerModelSource: 'kilo', observe: 'both' },
      }));
    } finally { f.close(); }
  });

  it.each(['dom', 'pixels', 'both'] as const)('selected-source checking preserves %s behavior for a known text-only follower', async (observe) => {
    const f = readinessFixture();
    try {
      f.panel.send('run.start', { prompt: 'fixture', config: { ...panelConfig(), observe }, followerVision: false });
      f.answer();
      await vi.waitFor(() => expect(f.managerStart).toHaveBeenCalledOnce());
      const result = await f.managerStart.mock.results[0]!.value;
      expect(result.ok).toBe(observe === 'dom');
      if (observe === 'dom') expect(f.start).toHaveBeenCalledOnce();
      else {
        expect(f.createModel).not.toHaveBeenCalled();
        expect(f.start).not.toHaveBeenCalled();
        expect((await result.done).message).toContain('vision');
      }
    } finally { f.close(); }
  });
});

/** A host whose dev trigger the test fires, and whose `run.end` frames it can await. */
function devHost(): {
  host: HostPort;
  trigger(msg: DevRunStart): void;
  ended(runId: string): Promise<HostRunEndEvent>;
} {
  let onRunStart: ((msg: DevRunStart) => void) | undefined;
  const ends = new Map<string, (event: HostRunEndEvent) => void>();
  const host: HostPort = {
    ...hostPort(),
    appendRunLog(runId, event) {
      if ('type' in event && event.type === 'run.end') ends.get(runId)?.(event);
    },
    onRunStart(handler) {
      onRunStart = handler;
      return () => {};
    },
  };
  return {
    host,
    trigger(msg) {
      onRunStart?.(msg);
    },
    ended(runId) {
      return new Promise((resolve) => ends.set(runId, resolve));
    },
  };
}
