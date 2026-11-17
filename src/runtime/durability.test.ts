import { describe, expect, it } from 'vitest';
import type { RunEvent } from '@/src/messaging';
import { sessionReplayStore, sessionUserscriptValueStore } from './durability';

function installSession(): Map<string, unknown> {
  const store = new Map<string, unknown>();
  const area = {
    async get(key: string) {
      return { [key]: store.get(key) };
    },
    async set(items: Record<string, unknown>) {
      for (const [key, value] of Object.entries(items)) store.set(key, value);
    },
    async remove(keys: string | string[]) {
      for (const key of Array.isArray(keys) ? keys : [keys]) store.delete(key);
    },
  };
  (globalThis as { chrome?: unknown }).chrome = { storage: { session: area } };
  return store;
}

const ended = (n: number): RunEvent => ({
  kind: 'run.ended',
  status: 'done',
  message: `end ${n}`,
  steps: n,
  at: n,
});

describe('session durability', () => {
  it('a saved run loads back, a script that returned undefined is still found, and a sixth run evicts the oldest unprotected one', async () => {
    const store = installSession();
    const replay = sessionReplayStore();
    expect(replay, 'session store was not visible to the durability module').toBeDefined();
    const values = sessionUserscriptValueStore('run-1');
    expect(values).toBeDefined();

    await values!.save(undefined);
    expect(await values!.load()).toEqual({ found: true, value: undefined });

    for (let n = 1; n <= 6; n += 1) {
      await replay!.save(`run-${n}`, [ended(n)], { protect: ['run-6'] });
    }
    expect(store.size, `session map has ${store.size} keys`).toBeGreaterThan(0);
    expect(await replay!.load('run-1')).toBeUndefined();
    expect((await replay!.load('run-2'))?.[0]).toMatchObject({ message: 'end 2' });
    expect((await replay!.load('run-6'))?.[0]).toMatchObject({ message: 'end 6' });
  });
});
