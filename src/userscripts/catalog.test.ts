import { describe, expect, it } from 'vitest';
import { MAX_CODE_BYTES, validateUserscript } from './catalog';

const now = () => 1_720_000_000_000;

describe('validateUserscript', () => {
  it('rejects a draft with an empty name, no patterns, or blank code, so nothing unrunnable is stored', () => {
    const result = validateUserscript({ name: '  ', matches: [], code: '   ' }, now);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toEqual([
      'name must not be empty',
      'matches must list at least one match pattern',
      'code must not be empty',
    ]);
  });

  it('rejects a match pattern the grammar does not accept, naming the pattern', () => {
    const result = validateUserscript(
      { name: 'prices', matches: ['example.com/*'], code: 'return 1;' },
      now,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toEqual(['invalid match pattern: "example.com/*"']);
  });

  it('rejects code past 256 KiB and accepts a script of exactly that size', () => {
    const over = validateUserscript(
      { name: 'big', matches: ['https://shop.example/*'], code: 'x'.repeat(MAX_CODE_BYTES + 1) },
      now,
    );
    expect(over.ok).toBe(false);

    const exact = validateUserscript(
      { name: 'fit', matches: ['https://shop.example/*'], code: 'x'.repeat(MAX_CODE_BYTES) },
      now,
    );
    expect(exact.ok).toBe(true);
    if (!exact.ok) return;
    expect(exact.script.code.length).toBe(MAX_CODE_BYTES);
    expect(exact.script.updatedAt).toBe(1_720_000_000_000);
  });
});
