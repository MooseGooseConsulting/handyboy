// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { click, press, resetPointerForTests, type as typeInto } from '@/src/page/actions';
import { resolveRef, snapshot } from '@/src/page/snapshot';

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

  it('does not write a control disabled by a parent fieldset, and still clicks the first legend', () => {
    document.body.innerHTML =
      '<fieldset disabled><legend><button id="legend">In legend</button></legend><input id="in" value="keep"><button id="barred">Barred</button></fieldset>';
    const input = document.getElementById('in') as HTMLInputElement;
    const legend = document.getElementById('legend') as HTMLButtonElement;
    const barred = document.getElementById('barred') as HTMLButtonElement;
    expect(input.disabled).toBe(false);
    expect(input.matches(':disabled')).toBe(true);

    snapshot({ root: document });
    const inputRef = refFor(input);
    const legendRef = refFor(legend);
    const barredRef = refFor(barred);

    expect(typeInto(inputRef, 'changed')).toEqual({ ok: false, error: 'element is not editable' });
    expect(input.value).toBe('keep');

    let legendClicks = 0;
    let barredClicks = 0;
    legend.addEventListener('click', () => {
      legendClicks += 1;
    });
    barred.addEventListener('click', () => {
      barredClicks += 1;
    });
    document.elementFromPoint = () => legend;
    expect(click(legendRef)).toEqual({ ok: true });
    document.elementFromPoint = () => barred;
    expect(click(barredRef)).toEqual({ ok: false, error: 'element is disabled' });
    expect(legendClicks).toBe(1);
    expect(barredClicks).toBe(0);
  });

  it('sends Enter to the focused input inside a closed shadow root when the document focus is the host', () => {
    document.body.innerHTML = '<div id="host"></div>';
    const host = document.getElementById('host') as HTMLElement;
    const shadow = host.attachShadow({ mode: 'closed' });
    shadow.innerHTML =
      '<form><input id="live" type="search" name="q" value="DDR4"><button type="submit">Search</button></form>';
    const form = shadow.querySelector('form') as HTMLFormElement;
    const live = shadow.querySelector('#live') as HTMLInputElement;
    const previous = (globalThis as { chrome?: unknown }).chrome;
    (globalThis as { chrome?: unknown }).chrome = {
      dom: { openOrClosedShadowRoot: (el: Element) => (el === host ? shadow : el.shadowRoot) },
    };
    try {
      snapshot({ root: document });
      expect(typeInto(refFor(live), 'DDR4')).toEqual({ ok: true });
      live.focus();
      expect(document.activeElement).toBe(host);
      expect(shadow.activeElement).toBe(live);
      (globalThis as { chrome?: unknown }).chrome = undefined;

      const delivered: EventTarget[] = [];
      live.addEventListener('keydown', (event) => delivered.push(event.currentTarget!));
      let submits = 0;
      form.addEventListener('submit', (event) => {
        submits += 1;
        event.preventDefault();
      });
      expect(press('Enter')).toEqual({ ok: true });
      expect(delivered[0]).toBe(live);
      expect(submits).toBe(1);
    } finally {
      (globalThis as { chrome?: unknown }).chrome = previous;
    }
  });
});

function refFor(target: Element): string {
  const text = snapshot({ root: document }).text;
  for (const match of text.matchAll(/\[ref=(e\d+)\]/g)) {
    const ref = match[1] ?? '';
    if (ref && resolveRef(ref) === target) return ref;
  }
  throw new Error('no ref for element');
}
