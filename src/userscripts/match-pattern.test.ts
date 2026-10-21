import { describe, expect, it } from 'vitest';
import { isValidMatchPattern, matchesAny, matchesPattern } from './match-pattern';

describe('match patterns', () => {
  it('rejects a pattern with no scheme, so a script cannot be stored against a host fragment', () => {
    expect(isValidMatchPattern('example.com/*')).toBe(false);
    expect(isValidMatchPattern('*foo.com/*')).toBe(false);
    expect(isValidMatchPattern('')).toBe(false);
    expect(matchesPattern('example.com/*', 'https://example.com/')).toBe(false);
  });

  it('a star scheme matches http and https only, so a file URL does not slip through *://*/*', () => {
    expect(matchesPattern('*://*/*', 'https://shop.example/cart')).toBe(true);
    expect(matchesPattern('*://*/*', 'http://shop.example/cart')).toBe(true);
    expect(matchesPattern('*://*/*', 'file:///tmp/cart.html')).toBe(false);
    expect(matchesPattern('<all_urls>', 'file:///tmp/cart.html')).toBe(true);
  });

  it('*.example.com matches the bare host and a subdomain, and not a lookalike or the wrong path', () => {
    const pattern = 'https://*.example.com/item/*';
    expect(matchesPattern(pattern, 'https://shop.example.com/item/7')).toBe(true);
    expect(matchesPattern(pattern, 'https://example.com/item/7')).toBe(true);
    expect(matchesPattern(pattern, 'https://example.com.evil/item/7')).toBe(false);
    expect(matchesPattern(pattern, 'https://notexample.com/item/7')).toBe(false);
    expect(matchesPattern(pattern, 'https://shop.example.com/other')).toBe(false);
  });

  it('an empty allow-list matches nothing, so a script with no patterns does not run everywhere', () => {
    expect(matchesAny([], 'https://shop.example/')).toBe(false);
    expect(matchesAny(['https://shop.example/*'], 'https://shop.example/cart')).toBe(true);
  });
});
