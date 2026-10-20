import { describe, expect, it } from 'vitest';
import { parseRunOptions } from '../src/cli/options.ts';

describe('hb-run --option parsing', () => {
  it('turns true and false into booleans so readOnly can override the stored toggle', () => {
    expect(parseRunOptions(['go', '--option', 'readOnly=false', '--option', 'x=true'])).toEqual({
      readOnly: false,
      x: true,
    });
  });

  it('keeps every other value a string, including numbers and model ids with colons', () => {
    expect(
      parseRunOptions(['--option', 'maxSteps=15', '--option', 'leaderModel=nvidia/nemotron-3-ultra-550b-a55b:free']),
    ).toEqual({ maxSteps: '15', leaderModel: 'nvidia/nemotron-3-ultra-550b-a55b:free' });
  });

  it('ignores a pair with no key or no equals sign', () => {
    expect(parseRunOptions(['--option', '=v', '--option', 'novalue', '--option'])).toEqual({});
  });
});
