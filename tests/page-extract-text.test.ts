// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { extractText } from '@/src/page/extractText';

describe('extractText', () => {
  it('skips a script and a hidden node, and turns a link into text plus its href', () => {
    document.body.innerHTML =
      '<script>secret()</script><p hidden>nope</p><p>Wool socks</p><a href="/cart">Cart</a>';
    const result = extractText({ root: document });
    expect(result.text).toBe('Wool socks Cart (/cart)');
    expect(result.truncated).toBe(false);
    expect(result.text.includes('secret')).toBe(false);
    expect(result.text.includes('nope')).toBe(false);
  });

  it('cuts at maxChars, marks the slice truncated, and says where the next slice starts', () => {
    document.body.innerHTML = '<p>abcdefghij</p>';
    const result = extractText({ root: document, maxChars: 4 });
    expect(result).toEqual({
      text: 'abcd [truncated]',
      truncated: true,
      totalChars: 10,
      nextStart: 4,
    });
    expect(extractText({ root: document, maxChars: 4, startChar: 4 }).text).toBe('efgh [truncated]');
  });
});
