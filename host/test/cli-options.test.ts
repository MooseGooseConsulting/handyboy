import { describe, expect, it } from 'vitest';
import { parseRunOptions } from '../src/cli/options.ts';

describe('hb-run options', () => {
  it('true and false become booleans, and every other value stays a string', () => {
    expect(
      parseRunOptions(['--option', 'readOnly=true', '--option', 'readOnly=false', '--option', 'observe=pixels', '--option', 'nope']),
    ).toEqual({
      readOnly: false,
      observe: 'pixels',
    });
    expect(parseRunOptions(['--option', 'readOnly=true']).readOnly).toBe(true);
  });
});
