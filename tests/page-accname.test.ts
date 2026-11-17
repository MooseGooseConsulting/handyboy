// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { computeAccessibleName, headingLevel, implicitRole } from '@/src/page/accname';

function el(html: string): Element {
  document.body.innerHTML = html;
  const node = document.body.firstElementChild;
  if (!node) throw new Error('fixture produced no element');
  return node;
}

describe('accessible names', () => {
  it('an aria-label names a button even when its text says something else', () => {
    const button = el('<button aria-label="Buy now">nope</button>');
    expect(computeAccessibleName(button)).toBe('Buy now');
    expect(implicitRole(button)).toBe('button');
  });

  it('a link without href is not a link, and an image with alt="" is decorative', () => {
    expect(implicitRole(el('<a>read more</a>'))).toBe('generic');
    expect(implicitRole(el('<a href="/cart">cart</a>'))).toBe('link');
    expect(implicitRole(el('<img alt="" src="x.png">'))).toBe('none');
    expect(computeAccessibleName(el('<img alt="wool socks" src="x.png">'))).toBe('wool socks');
  });

  it('aria-level overrides the h2 tag, and a paragraph is not a heading', () => {
    expect(headingLevel(el('<h2>Cart</h2>'))).toBe(2);
    expect(headingLevel(el('<h2 aria-level="4">Cart</h2>'))).toBe(4);
    expect(headingLevel(el('<p>Cart</p>'))).toBe(0);
  });
});
