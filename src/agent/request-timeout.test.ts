import { createServer, type ServerResponse } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemorySaver } from '@langchain/langgraph/web';
import { createChatModel, retryRateLimited, withRequestTimeout } from './models';
import { startRun } from './run';
import { FakePageTools } from './tools';
import type { RunEvent } from '@/src/messaging';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const close of cleanup.splice(0)) await close();
});

async function serverFor(handle: (response: ServerResponse, attempt: number) => void) {
  let attempts = 0;
  const server = createServer((_req, res) => handle(res, ++attempts));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(() => new Promise<void>((resolve, reject) => {
    server.closeAllConnections();
    server.close((error) => error ? reject(error) : resolve());
  }));
  const address = server.address() as { port: number };
  const fetch: typeof globalThis.fetch = (_input, init) => globalThis.fetch(`http://127.0.0.1:${address.port}`, init);
  return { fetch, attempts: () => attempts };
}

describe('model request deadlines', () => {
  it('allows a slow 289-second response under the default deadline and clears its timer on success', async () => {
    vi.useFakeTimers();
    let finish!: (response: Response) => void;
    let signal!: AbortSignal;
    const fetch: typeof globalThis.fetch = async (_input, init) => {
      signal = init!.signal!;
      return new Promise((resolve) => { finish = resolve; });
    };
    const request = withRequestTimeout(fetch, 300_000)('https://example.com');
    await vi.advanceTimersByTimeAsync(289_000);
    expect(signal.aborted).toBe(false);
    finish(new Response('slow success'));
    expect(await (await request).text()).toBe('slow success');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retries a connection that never responds, with a fresh deadline for the successful attempt', async () => {
    const fixture = await serverFor((res, attempt) => {
      if (attempt === 1) return;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ id: 'fixture', choices: [{ index: 0, message: { role: 'assistant', content: 'recovered' }, finish_reason: 'stop' }] }));
    });
    const model = createChatModel({ model: 'fixture:free', fetch: fixture.fetch, requestTimeoutMs: 200 });
    expect((await model.invoke('hello')).content).toBe('recovered');
    expect(fixture.attempts()).toBe(2);
  });

  it('records exactly one terminal run error after the retries of a server that never finishes its body', async () => {
    const fixture = await serverFor((res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{"choices":');
    });
    const model = createChatModel({ model: 'fixture:free', fetch: fixture.fetch, requestTimeoutMs: 200 });
    const events: RunEvent[] = [];
    const run = startRun({
      prompt: 'read the page', tools: new FakePageTools(), models: { leader: model, follower: model },
      config: { leaderModel: 'fixture:free', followerModel: 'fixture:free', observe: 'dom', inputFidelity: 'in-page', planningInterval: 5, maxSteps: 10 },
      onEvent: (event) => events.push(event), checkpointer: new MemorySaver(),
    });
    const ended = await run.done;
    expect(ended.status).toBe('error');
    expect(ended.message).toMatch(/timed? ?out/i);
    expect(fixture.attempts()).toBe(3);
    expect(events.filter((event) => event.kind === 'run.ended')).toEqual([ended]);
  });

  it('honors user cancellation without another attempt', async () => {
    const caller = new AbortController();
    let attempts = 0;
    const fetch: typeof globalThis.fetch = async (_input, init) => {
      attempts++;
      return new Promise((_resolve, reject) => {
        init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true });
        caller.abort(new DOMException('stopped by user', 'AbortError'));
      });
    };
    const request = retryRateLimited(withRequestTimeout(fetch, 300_000))('https://example.com', { signal: caller.signal });
    await expect(request).rejects.toThrow('stopped by user');
    expect(attempts).toBe(1);
  });
});
