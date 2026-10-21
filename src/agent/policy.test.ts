import { describe, expect, it } from 'vitest';
import { allowedInReadOnly, decisionFor, isReadOnlyScript } from './policy';

describe('read-only policy', () => {
  it('blocks click, type, and write_userscript, and still allows snapshot and save_file', () => {
    expect(allowedInReadOnly('click')).toBe(false);
    expect(allowedInReadOnly('type')).toBe(false);
    expect(allowedInReadOnly('hover')).toBe(false);
    expect(allowedInReadOnly('write_userscript')).toBe(false);
    expect(allowedInReadOnly('snapshot')).toBe(true);
    expect(allowedInReadOnly('save_file')).toBe(true);
    expect(allowedInReadOnly('navigate')).toBe(true);
  });

  it('an unconfigured sensitive category allows the action, and an explicit deny does not', () => {
    expect(decisionFor('commerce')).toBe('allow');
    expect(decisionFor('destructive', { destructive: 'deny' })).toBe('deny');
    expect(decisionFor('submit', { commerce: 'deny' })).toBe('allow');
  });

  it('a script that assigns innerHTML or posts is not read-only, and a comparison or a GET is', () => {
    expect(isReadOnlyScript('el.innerHTML = "<b>x</b>";').ok).toBe(false);
    expect(isReadOnlyScript('fetch(url, { method: "POST" })').ok).toBe(false);
    expect(isReadOnlyScript('return el.innerHTML === "x";').ok).toBe(true);
    expect(isReadOnlyScript('return document.body.textContent;').ok).toBe(true);
  });
});
