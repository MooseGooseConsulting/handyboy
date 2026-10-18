import { describe, expect, it } from 'vitest';
import { HumanMessage } from '@langchain/core/messages';
import { createChatModel, retryRateLimited } from '@/src/agent/models';

const completion = () =>
  new Response(
    JSON.stringify({
      id: 'gen-1',
      object: 'chat.completion',
      created: 0,
      model: 'x/y:free',
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

/** A gateway that rate-limits the first `n` requests, the way OpenRouter's free tier does. */
function limitedFor(n: number, as: 'status' | 'body') {
  let calls = 0;
  const fetch: typeof globalThis.fetch = async () => {
    calls += 1;
    if (calls > n) return completion();
    return as === 'status'
      ? new Response(JSON.stringify({ error: { message: 'Provider returned error', code: 429 } }), {
          status: 429,
          headers: { 'content-type': 'application/json', 'retry-after': '0' },
        })
      : new Response(JSON.stringify({ error: { message: 'Provider returned error', code: 429 } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
  };
  return { fetch, calls: () => calls };
}

describe('free-tier rate limits', () => {
  it.each(['status', 'body'] as const)('a 429 (as %s) is retried until the provider answers, not returned as the result', async (as) => {
    const gw = limitedFor(2, as);
    const model = createChatModel({ model: 'x/y:free', fetch: gw.fetch, rateLimitDelaysMs: [1, 1, 1] });
    const reply = await model.invoke([new HumanMessage('hi')]);
    expect(reply.content).toBe('ok');
    expect(gw.calls()).toBe(3);
  }, 30_000);

  it('gives up after the last wait and reports the 429, rather than retrying forever', async () => {
    // ChatOpenAI maxRetries is 0, so a 429 the wrapper finally returns is not
    // scheduled again. The exact 3 is the pin: two waits, then the last 429.
    const gw = limitedFor(99, 'body');
    const model = createChatModel({ model: 'x/y:free', fetch: gw.fetch, rateLimitDelaysMs: [1, 1] });
    await expect(model.invoke([new HumanMessage('hi')])).rejects.toThrow(/429/);
    expect(gw.calls()).toBe(3);
  });

  it('still makes an immediate retry after the wait budget is already spent', async () => {
    let calls = 0;
    const fetch: typeof globalThis.fetch = async () => {
      calls += 1;
      if (calls < 3) return new Response('no', { status: 429, headers: { 'retry-after': '0' } });
      return new Response('ok', { status: 200 });
    };
    const res = await retryRateLimited(fetch, [0, 0])('https://example.test/v1/chat/completions');
    expect(res.status).toBe(200);
    expect(calls).toBe(3);
  });

  it('retries an overloaded 529 on the short transient schedule and does not retry 408, 409, or 501', async () => {
    let gateway = 0;
    const fetch: typeof globalThis.fetch = async () => {
      gateway += 1;
      if (gateway === 1) return new Response('overloaded', { status: 529 });
      return new Response('ok', { status: 200 });
    };
    const recovered = await retryRateLimited(fetch, [0], [0])('https://example.test/v1/chat/completions');
    expect(recovered.status).toBe(200);
    expect(gateway).toBe(2);

    for (const status of [408, 409, 501]) {
      let calls = 0;
      const once: typeof globalThis.fetch = async () => {
        calls += 1;
        return new Response('no', { status });
      };
      const rejected = await retryRateLimited(once, [0], [0])('https://example.test/v1/chat/completions');
      expect(rejected.status).toBe(status);
      expect(calls).toBe(1);
    }
  });

  it('retries a transient 502 on its own schedule and does not retry a 400', async () => {
    let gateway = 0;
    const fetch: typeof globalThis.fetch = async () => {
      gateway += 1;
      if (gateway === 1) return new Response('bad gateway', { status: 502 });
      return new Response('ok', { status: 200 });
    };
    const recovered = await retryRateLimited(fetch, [0], [0])('https://example.test/v1/chat/completions');
    expect(recovered.status).toBe(200);
    expect(gateway).toBe(2);

    let denied = 0;
    const permanent: typeof globalThis.fetch = async () => {
      denied += 1;
      return new Response('no', { status: 400 });
    };
    const rejected = await retryRateLimited(permanent, [0], [0])('https://example.test/v1/chat/completions');
    expect(rejected.status).toBe(400);
    expect(denied).toBe(1);
  });

  it('retries one dropped connection, then surfaces the error', async () => {
    let calls = 0;
    const fetch: typeof globalThis.fetch = async () => {
      calls += 1;
      if (calls === 1) throw new Error('socket hang up');
      return new Response('ok', { status: 200 });
    };
    const res = await retryRateLimited(fetch, [0], [0])('https://example.test/v1/chat/completions');
    expect(res.status).toBe(200);
    expect(calls).toBe(2);

    let blows = 0;
    const dying: typeof globalThis.fetch = async () => {
      blows += 1;
      throw new Error('socket hang up');
    };
    await expect(retryRateLimited(dying, [0], [0])('https://example.test/v1/chat/completions')).rejects.toThrow(/socket hang up/);
    expect(blows).toBe(2);
  });

  it('does not run the rate-limit schedule once per SDK retry', async () => {
    const gw = limitedFor(99, 'status');
    const model = createChatModel({ model: 'x/y:free', fetch: gw.fetch, rateLimitDelaysMs: [1, 1] });
    await expect(model.invoke([new HumanMessage('hi')])).rejects.toThrow(/429/);
    expect(gw.calls()).toBe(3);
  });
});
