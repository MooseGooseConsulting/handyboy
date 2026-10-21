// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { click, resetPointerForTests, type as typeInto } from '@/src/page/actions';
import { snapshot } from '@/src/page/snapshot';

function box(): DOMRect {
  return {
    x: 10,
    y: 20,
    width: 80,
    height: 30,
    top: 20,
    left: 10,
    bottom: 50,
    right: 90,
    toJSON() {
      return {};
    },
  } as DOMRect;
}

describe('in-page actions', () => {
  beforeEach(() => {
    resetPointerForTests();
    Object.defineProperty(window, 'innerWidth', { value: 800, configurable: true });
    Object.defineProperty(window, 'innerHeight', { value: 600, configurable: true });
  });

  it('clicking a stale ref does nothing, and a live button receives an untrusted click', () => {
    document.body.innerHTML = '<button id="buy">Buy now</button>';
    const button = document.getElementById('buy') as HTMLButtonElement;
    button.getBoundingClientRect = () => box();
    document.elementFromPoint = () => button;

    expect(click('e1')).toEqual({ ok: false, error: 'unknown or stale ref: e1' });

    snapshot({ root: document });
    const seen: Array<{ type: string; trusted: boolean }> = [];
    button.addEventListener('click', (event) => {
      seen.push({ type: event.type, trusted: event.isTrusted });
    });
    expect(click('e1')).toEqual({ ok: true });
    expect(seen).toEqual([{ type: 'click', trusted: false }]);
  });

  it('typing replaces the field value and fires input, instead of appending to the old text', () => {
    document.body.innerHTML = '<input id="q" value="old">';
    const input = document.getElementById('q') as HTMLInputElement;
    input.getBoundingClientRect = () => box();
    snapshot({ root: document });
    const kinds: string[] = [];
    input.addEventListener('input', () => kinds.push('input'));
    input.addEventListener('change', () => kinds.push('change'));

    expect(typeInto('e1', 'wool')).toEqual({ ok: true });
    expect(input.value).toBe('wool');
    expect(kinds).toEqual(['input', 'change']);
  });
});
