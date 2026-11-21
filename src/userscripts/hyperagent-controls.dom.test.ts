// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HYPERAGENT_CONTROLS } from './examples';

const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor as new (
  ...args: string[]
) => () => Promise<Record<string, unknown>>;

interface Call {
  path: string;
  method: string;
  body?: unknown;
}

/** A stand-in for Hyperagent's REST routes. `hold` parks a thread's GET until released. */
function fakeHyperagent() {
  const calls: Call[] = [];
  const held = new Map<string, () => void>();
  const thread = (id: string) => ({
    id,
    name: `thread ${id}`,
    modelId: 'sol-latest',
    effort: 'medium',
    defaultSubagentModel: null,
    toolSettings: JSON.stringify({ autoCompactThresholdPercent: '50' }),
  });
  const json = (data: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(data) });
  const fetchImpl = vi.fn(async (path: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? 'GET';
    calls.push({ path, method, body: init?.body ? JSON.parse(init.body) : undefined });
    const id = path.match(/^\/api\/threads\/([a-z0-9]+)$/)?.[1];
    if (id && method === 'GET' && held.has(id)) {
      await new Promise<void>((release) => held.set(id, release));
    }
    if (id) return json({ ...thread(id), ...(init?.body ? JSON.parse(init.body) : {}) });
    if (path === '/api/threads') return json({ items: [] });
    if (path === '/api/agents') return json([]);
    return json({});
  });
  return {
    calls,
    fetchImpl,
    hold: (id: string) => held.set(id, () => {}),
    release: (id: string) => held.get(id)?.(),
    writes: () => calls.filter((call) => call.method === 'PATCH'),
  };
}

const rail = () => document.getElementById('hb-hyperagent-controls') as HTMLElement & { __hbStop?: () => void };
/** Third select on the rail: model, provider, then reasoning effort. */
const effort = () => rail().querySelectorAll('select')[2] as HTMLSelectElement;
const choose = (select: HTMLSelectElement, value: string) => {
  select.value = value;
  select.dispatchEvent(new Event('change'));
};

describe('the hyperagent-controls rail on the page', () => {
  let api: ReturnType<typeof fakeHyperagent>;

  beforeEach(async () => {
    vi.useFakeTimers();
    api = fakeHyperagent();
    vi.stubGlobal('fetch', api.fetchImpl);
    // jsdom serves localhost; the script's own host check is the thing under test elsewhere.
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { hostname: 'hyperagent.com', pathname: '/thread/aaa111' },
    });
    await new AsyncFunction(HYPERAGENT_CONTROLS.code)();
  });

  afterEach(() => {
    rail()?.__hbStop?.();
    rail()?.remove();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('writes a changed reasoning effort to the thread in the address bar', async () => {
    choose(effort(), 'xhigh');
    await vi.advanceTimersByTimeAsync(0);
    expect(api.writes()).toEqual([{ path: '/api/threads/aaa111', method: 'PATCH', body: { effort: 'xhigh' } }]);
  });

  it('writes nothing when a control is changed after navigating to another thread whose settings have not loaded yet', async () => {
    api.hold('bbb222');
    (window.location as { pathname: string }).pathname = '/thread/bbb222';
    // Before the 1 s path poll has even noticed the navigation.
    choose(effort(), 'max');
    await vi.advanceTimersByTimeAsync(0);
    // After it has noticed, while the new thread's read is still in flight.
    await vi.advanceTimersByTimeAsync(1000);
    choose(effort(), 'low');
    await vi.advanceTimersByTimeAsync(0);
    expect(api.writes()).toEqual([]);

    api.release('bbb222');
    await vi.advanceTimersByTimeAsync(0);
    choose(effort(), 'high');
    await vi.advanceTimersByTimeAsync(0);
    expect(api.writes()).toEqual([{ path: '/api/threads/bbb222', method: 'PATCH', body: { effort: 'high' } }]);
  });

  it('does not offer "Not set" as a choice, because nothing would be sent and the old effort would stay on the server', () => {
    const notSet = effort().options[0] as HTMLOptionElement;
    expect(notSet.textContent).toBe('Not set');
    expect(notSet.disabled).toBe(true);
  });

  it('does not start a second read of a thread while the first poll is still waiting on the server', async () => {
    api.hold('aaa111');
    await vi.advanceTimersByTimeAsync(15_000);
    await vi.advanceTimersByTimeAsync(30_000);
    const reads = api.calls.filter((call) => call.path === '/api/threads/aaa111' && call.method === 'GET');
    // One from mounting, one from the first poll; the later polls found it still in flight.
    expect(reads).toHaveLength(2);
  });
});
