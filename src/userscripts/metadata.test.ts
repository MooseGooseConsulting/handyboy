import { describe, expect, it } from 'vitest';
import { applyUserscriptHeader, parseUserscriptMetadata } from './metadata';

const SOURCE = ['// ==UserScript==', '// @name Wool prices', '// @match https://shop.example/*', '// ==/UserScript==', 'return 1;'].join(
  '\r\n',
);

describe('userscript metadata', () => {
  it('a CRLF header yields the name, the match, and the body without the block', () => {
    expect(parseUserscriptMetadata(SOURCE)).toEqual({
      name: 'Wool prices',
      matches: ['https://shop.example/*'],
      body: 'return 1;',
    });
    expect(parseUserscriptMetadata('return 1;')).toBeNull();
  });

  it('an unset name and a wildcard match take the header, and a chosen name is kept', () => {
    const applied = applyUserscriptHeader({
      name: 'new script',
      matches: ['*://*/*'],
      code: SOURCE,
    });
    expect(applied.name).toBe('Wool prices');
    expect(applied.matches).toEqual(['https://shop.example/*']);
    expect(applied.code).toBe('return 1;');

    const kept = applyUserscriptHeader({
      name: 'Mine',
      matches: ['https://other.example/*'],
      code: SOURCE,
    });
    expect(kept.name).toBe('Mine');
    expect(kept.matches).toEqual(['https://other.example/*']);
    expect(kept.code).toBe('return 1;');
  });
});
