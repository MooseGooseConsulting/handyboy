import { describe, expect, it } from 'vitest';
import { buildWidenCss, isFragileSelector, validateStyleCss } from './widen';

describe('buildWidenCss', () => {
  it('builds a widen stylesheet that pins named containers to the chosen width and keeps centering, so the skinny column goes wide', () => {
    const css = buildWidenCss({ maxWidthPx: 1300 });
    expect(css).toContain('max-width: 1300px !important');
    expect(css).toContain('margin-left: auto !important');
    expect(css).toContain('main');
    expect(css).toContain('article');
    expect(css).not.toMatch(/^\s*\*\s*\{/m);
  });

  it('caps prose line length inside the wider container, so articles stay readable when the page goes wide', () => {
    expect(buildWidenCss()).toContain('max-width: 75ch !important');
    expect(buildWidenCss({ proseCap: false })).not.toContain('75ch');
  });

  it('clamps absurd widths back into 800–2000px, so a weak model cannot file a 1px or 99999px page', () => {
    expect(buildWidenCss({ maxWidthPx: 1 })).toContain('max-width: 800px');
    expect(buildWidenCss({ maxWidthPx: 99999 })).toContain('max-width: 2000px');
  });
});

describe('validateStyleCss', () => {
  it('rejects empty, oversized, and structurally broken CSS, so nothing unrunnable is stored', () => {
    expect(validateStyleCss('   ')).toEqual({ ok: false, errors: ['css must not be empty'] });
    expect(validateStyleCss('main { max-width: 1200px;')).toEqual({
      ok: false,
      errors: ['css has unbalanced braces'],
    });
    expect(validateStyleCss('main { color: red; } /* open')).toEqual({
      ok: false,
      errors: ['css has an unclosed comment'],
    });
    expect(validateStyleCss('main { color: red; }</style>')).toEqual({
      ok: false,
      errors: ['css must not contain HTML tags'],
    });
    const big = `a{color:red}${'x'.repeat(64 * 1024)}`;
    const over = validateStyleCss(big);
    expect(over.ok).toBe(false);
  });

  it('accepts the preset it builds, so the validator and the generator cannot drift apart', () => {
    expect(validateStyleCss(buildWidenCss())).toEqual({ ok: true });
  });
});

describe('isFragileSelector', () => {
  it('flags generated-class selectors as fragile while accepting stable names, so agent CSS survives redeploys', () => {
    expect(isFragileSelector('.Header_nav__a1B2c')).toBe(true);
    expect(isFragileSelector('.prc-TopicTag-LS-jX')).toBe(true);
    expect(isFragileSelector('.nav')).toBe(false);
    expect(isFragileSelector('main')).toBe(false);
    expect(isFragileSelector('td[bgcolor="#ff6600"]')).toBe(false);
    expect(isFragileSelector('article .post')).toBe(false);
  });
});
