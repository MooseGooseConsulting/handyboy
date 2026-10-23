import { afterEach, describe, expect, it } from 'vitest';
import { Dispatcher } from '../src/dispatcher.ts';
import { LlmProxy } from '../src/llm.ts';
import { resetLogForTests } from '../src/log.ts';
import type { OutboundMsg } from '../src/protocol.ts';
import { SecretStore, type SecretLookup, type SecretProvider } from '../src/secrets.ts';
import { FakeFetch } from './harness.ts';

/** Fails each name a set number of times, as a Doppler outage would, then serves it. */
class FlakyProvider implements SecretProvider {
  readonly name = 'flaky';
  readonly calls: string[] = [];
  readonly #failuresLeft: Record<string, number>;
  readonly #values: Record<string, string | null>;

  constructor(values: Record<string, string | null>, failures: Record<string, number>) {
    this.#values = values;
    this.#failuresLeft = { ...failures };
  }

  async get(name: string): Promise<SecretLookup> {
    this.calls.push(name);
    if ((this.#failuresLeft[name] ?? 0) > 0) {
      this.#failuresLeft[name]! -= 1;
      return { value: null, reason: `${name} from flaky failed: doppler exited with code 1` };
    }
    return { value: this.#values[name] ?? null };
  }
}

const OR_KEY = 'sk-or-v1-retry0000aaaa1111';
const KILO_KEY = 'kilo-retry-0123456789abcdef';

afterEach(() => resetLogForTests());

describe('secret loading after a transient failure', () => {
  it('key.status re-attempts a failed load, so a Doppler blip at host start does not last the session', async () => {
    const provider = new FlakyProvider({ OPENROUTER_API_KEY: OR_KEY, KILO_CODE_API_KEY: null }, { OPENROUTER_API_KEY: 1 });
    const secrets = new SecretStore(provider);
    await secrets.load();
    expect(secrets.status('openrouter').ready).toBe(false);

    const fetch = new FakeFetch();
    fetch.enqueueJson(200, { data: {} });
    const sent: OutboundMsg[] = [];
    const llm = new LlmProxy({ fetch: fetch.fetch, secrets, send: (m) => sent.push(m) });
    const dispatcher = new Dispatcher({ send: (m) => sent.push(m), llm, runsDir: '/tmp/unused-runs' });

    await dispatcher.handle({ type: 'key.status', id: 'k1' });
    expect(sent[0]).toMatchObject({ type: 'key.status.result', id: 'k1', ready: true });
    expect(fetch.calls[0]?.headers.authorization).toBe(`Bearer ${OR_KEY}`);
  });

  it('background retry backs off, stops once every source is loaded, and never re-fetches a loaded key', async () => {
    const provider = new FlakyProvider(
      { OPENROUTER_API_KEY: OR_KEY, KILO_CODE_API_KEY: KILO_KEY },
      { OPENROUTER_API_KEY: 1, KILO_CODE_API_KEY: 3 },
    );
    const secrets = new SecretStore(provider);
    await secrets.load();
    const slept: number[] = [];
    await secrets.retryMissing({
      attempts: 10,
      initialDelayMs: 100,
      maxDelayMs: 250,
      sleep: async (ms) => {
        slept.push(ms);
      },
    });
    expect(slept).toEqual([100, 200, 250]);
    expect(secrets.key('openrouter')).toBe(OR_KEY);
    expect(secrets.key('kilo')).toBe(KILO_KEY);
    // load + 1 retry for OpenRouter; load + 3 retries for Kilo. Nothing after both loaded.
    expect(provider.calls.filter((n) => n === 'OPENROUTER_API_KEY')).toHaveLength(2);
    expect(provider.calls.filter((n) => n === 'KILO_CODE_API_KEY')).toHaveLength(4);
  });

  it('background retry gives up after its attempts, and concurrent re-attempts share one lookup per source', async () => {
    const provider = new FlakyProvider({ OPENROUTER_API_KEY: OR_KEY, KILO_CODE_API_KEY: null }, {});
    // No cooldown: this test exercises concurrency sharing, not rate limiting.
    const secrets = new SecretStore(provider, { reloadCooldownMs: 0 });
    await secrets.load();
    const slept: number[] = [];
    await secrets.retryMissing({ attempts: 2, initialDelayMs: 10, maxDelayMs: 10, sleep: async (ms) => void slept.push(ms) });
    expect(slept).toEqual([10, 10]);

    provider.calls.length = 0;
    await Promise.all([secrets.reloadMissing(), secrets.reloadMissing(), secrets.reloadMissing()]);
    expect(provider.calls).toEqual(['KILO_CODE_API_KEY']);
  });

  it('on-demand reloads inside the cooldown window reuse the last result instead of re-spawning lookups', async () => {
    let now = 10_000;
    const provider = new FlakyProvider({ OPENROUTER_API_KEY: OR_KEY, KILO_CODE_API_KEY: null }, {});
    const secrets = new SecretStore(provider, { now: () => now, reloadCooldownMs: 5_000 });
    await secrets.load();
    provider.calls.length = 0;

    await secrets.reloadMissing();
    expect(provider.calls).toEqual(['KILO_CODE_API_KEY']);

    now = 14_999;
    await secrets.reloadMissing();
    expect(provider.calls).toEqual(['KILO_CODE_API_KEY']); // window still open

    now = 15_000;
    await secrets.reloadMissing();
    expect(provider.calls).toEqual(['KILO_CODE_API_KEY', 'KILO_CODE_API_KEY']);
  });

  it('a reload that loads one key resets the cooldown so a still-missing source recovers immediately', async () => {
    let now = 10_000;
    const provider = new FlakyProvider({ OPENROUTER_API_KEY: OR_KEY, KILO_CODE_API_KEY: null }, { OPENROUTER_API_KEY: 1 });
    const secrets = new SecretStore(provider, { now: () => now, reloadCooldownMs: 5_000 });
    await secrets.load();
    expect(secrets.status('openrouter').ready).toBe(false);
    provider.calls.length = 0;

    await secrets.reloadMissing(); // OpenRouter loads here -> cooldown resets; Kilo still missing
    expect(secrets.key('openrouter')).toBe(OR_KEY);
    expect(provider.calls).toEqual(['OPENROUTER_API_KEY', 'KILO_CODE_API_KEY']);

    now = 10_500; // well inside the window the reload started
    await secrets.reloadMissing();
    expect(provider.calls).toEqual(['OPENROUTER_API_KEY', 'KILO_CODE_API_KEY', 'KILO_CODE_API_KEY']);
  });
});
