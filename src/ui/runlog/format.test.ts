import { describe, expect, it } from 'vitest';
import { formatDuration, formatElapsed, prettyJson, summarizeArgs, usageParts } from './format';

describe('run log formatting', () => {
  it('duration switches at 1000ms and again at 10000ms, so a 999ms call is not shown as seconds', () => {
    expect(formatDuration(999)).toBe('999ms');
    expect(formatDuration(1000)).toBe('1.00s');
    expect(formatDuration(9999)).toBe('10.00s');
    expect(formatDuration(10000)).toBe('10.0s');
  });

  it('elapsed time stays in seconds under a minute and switches to minutes at 60000ms', () => {
    expect(formatElapsed(12_400)).toBe('+12.4s');
    expect(formatElapsed(59_999)).toBe('+60.0s');
    expect(formatElapsed(60_000)).toBe('+1m00s');
    expect(formatElapsed(64_000)).toBe('+1m04s');
    expect(formatElapsed(-1500)).toBe('-1.5s');
  });

  it('a missing provider token count is not shown as zero, and a cyclic value does not throw', () => {
    expect(usageParts({ promptChars: 1200 })).toEqual(['no provider token count', '1,200 prompt chars']);
    expect(usageParts({ inputTokens: 0, promptChars: 1 })).toEqual(['0 in', '1 prompt chars']);

    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(prettyJson(cyclic)).toBe('[object Object]');
    expect(summarizeArgs({ selector: '#buy', nested: { n: 1 } })).toBe('selector=#buy nested={"n":1}');
  });
});
