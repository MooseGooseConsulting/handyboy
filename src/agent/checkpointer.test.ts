import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { IndexedDBSaver } from './checkpointer';

describe('checkpoint store', () => {
  it('a checkpoint written for one thread is what that thread reads back, and another thread does not see it', async () => {
    const saver = new IndexedDBSaver({ dbName: `hb-cp-${Date.now()}` });
    const config = { configurable: { thread_id: 'thread-a', checkpoint_ns: '' } };
    const other = { configurable: { thread_id: 'thread-b', checkpoint_ns: '' } };
    const checkpoint = {
      v: 1,
      id: '1',
      ts: '2026-10-20T00:00:00.000Z',
      channel_values: {},
      channel_versions: {},
      versions_seen: {},
    };

    await saver.put(config, checkpoint, { source: 'input', step: 0, parents: {} }, {});
    const loaded = await saver.getTuple(config);
    expect(loaded?.checkpoint.id).toBe('1');
    expect(await saver.getTuple(other)).toBeUndefined();
  });
});
