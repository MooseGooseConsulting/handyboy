import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ExtLogError, appendExtLog, filterExtLog, readExtLog, toEntry } from '../src/extlog.ts';

let dir: string | undefined;

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

describe('extension log', () => {
  it('rejects a bad level, and a dotted key in the message is not what gets written', async () => {
    expect(() =>
      toEntry({ type: 'log.append', level: 'debug', source: 'worker', message: 'x' } as never),
    ).toThrow(ExtLogError);

    dir = await mkdtemp(path.join(tmpdir(), 'hb-ext-'));
    const file = path.join(dir, 'ext.log');
    const key = 'sk-or-v1.aaaabbbbccccdddd.eeeeffff00001111';
    const entry = toEntry({
      type: 'log.append',
      level: 'error',
      source: 'panel',
      message: `failed with ${key}`,
      at: 1_720_000_000_000,
    });
    await appendExtLog(entry, file);
    const text = (await readExtLog({}, file)).map((row) => row.message).join('\n');
    expect(text.includes(key)).toBe(false);
    expect(text).toContain('[redacted]');
  });

  it('a truncated final line is dropped, and --since keeps only later entries', () => {
    const lines = [
      '{"level":"info","source":"worker","message":"early","at":1000}',
      'not-json',
      '{"level":"error","source":"panel","message":"later","at":5000}',
    ];
    expect(filterExtLog(lines, { since: '1970-01-01T00:00:02.000Z' })).toEqual([
      { level: 'error', source: 'panel', message: 'later', at: 5000 },
    ]);
    expect(() => filterExtLog([], { since: 'yesterday' })).toThrow(ExtLogError);
  });
});
