import { afterEach, describe, expect, it } from 'vitest';
import { makeHarness, type Harness } from './harness.ts';

let h: Harness | undefined;

afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

describe('key.status per source', () => {
  it('a Kilo-only setup is ready, with no OpenRouter round trip, and says which source is missing', async () => {
    h = await makeHarness({ key: null, kiloKey: 'kilo-only-key-0123456789' });
    await h.dispatcher.handle({ type: 'key.status', id: 'k1' });
    expect(h.fetch.calls).toHaveLength(0);
    expect(h.sent).toEqual([
      {
        type: 'key.status.result',
        id: 'k1',
        ready: true,
        sources: {
          openrouter: { ready: false, reason: 'OPENROUTER_API_KEY not available from fake' },
          kilo: { ready: true },
        },
      },
    ]);
  });

  it('asking about Kilo specifically is not ready when only an OpenRouter key is loaded', async () => {
    h = await makeHarness({ key: 'sk-or-v1-0000aaaa1111bbbb', kiloKey: null });
    h.fetch.enqueueJson(200, { data: {} });
    await h.dispatcher.handle({ type: 'key.status', id: 'k2', source: 'kilo' });
    expect(h.sent[0]).toMatchObject({
      type: 'key.status.result',
      id: 'k2',
      ready: false,
      reason: 'KILO_CODE_API_KEY not available from fake',
      sources: { openrouter: { ready: true }, kilo: { ready: false } },
    });
  });

  it('with neither source loaded the reason names both, and an unknown source is a bad request', async () => {
    h = await makeHarness({ key: null, kiloKey: null });
    await h.dispatcher.handle({ type: 'key.status', id: 'k3' });
    await h.dispatcher.handle({ type: 'key.status', id: 'k4', source: 'anthropic' });
    expect(h.sent[0]).toMatchObject({
      type: 'key.status.result',
      id: 'k3',
      ready: false,
      reason:
        'openrouter: OPENROUTER_API_KEY not available from fake; kilo: KILO_CODE_API_KEY not available from fake',
    });
    expect(h.sent[1]).toMatchObject({ type: 'error', id: 'k4', code: 'bad_request' });
  });

  it('an OpenRouter key that GET /key rejects is not ready even though it loaded', async () => {
    h = await makeHarness({ key: 'sk-or-v1-0000aaaa1111bbbb', kiloKey: null });
    h.fetch.enqueueJson(401, {});
    await h.dispatcher.handle({ type: 'key.status', id: 'k5', source: 'openrouter' });
    expect(h.sent[0]).toMatchObject({ ready: false, reason: 'GET /key returned 401' });
  });
});
