import { describe, expect, it } from 'vitest';
import { installErrorForwarding } from './errorLog';

describe('error forwarding', () => {
  it('console.error still prints, the forwarded message has no key, and a throwing sink does not loop', () => {
    const printed: unknown[][] = [];
    const sent: string[] = [];
    let sinkThrows = false;
    const con: { error: (...args: unknown[]) => void; warn: () => void } = {
      error: (...args) => {
        printed.push(args);
      },
      warn: () => {},
    };
    const restore = installErrorForwarding({
      source: 'worker',
      now: () => 10,
      send: (entry) => {
        sent.push(entry.message);
        if (sinkThrows) throw new Error('sink down');
      },
      console: con,
    });

    const key = 'sk-or-v1.aaaabbbbccccdddd.eeeeffff00001111';
    con.error(`failed ${key}`);
    expect(printed).toEqual([[`failed ${key}`]]);
    expect(sent).toEqual(['failed [redacted]']);
    expect(sent[0]?.includes(key)).toBe(false);

    sinkThrows = true;
    con.error('again');
    expect(printed).toHaveLength(2);
    expect(sent).toHaveLength(2);
    restore();
  });
});
