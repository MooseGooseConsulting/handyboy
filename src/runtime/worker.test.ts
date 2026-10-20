import { describe, expect, it } from 'vitest';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { RunEndedEvent, RunHandle, StartRunOptions } from '@/src/agent/run';
import { createChannel, createFakePortPair, type Envelope, type RunEvent } from '@/src/messaging';
import type { Config } from '@/src/storage';
import { RunManager, type RunLogSink, type TabsPort } from './runManager';
import type { RuntimeDriver } from './pageTools';
import { createWorker, type HostPort } from './worker';

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
});
