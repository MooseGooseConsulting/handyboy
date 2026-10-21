// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import { InPageInputTier, type PageDriverLike } from '@/src/input/inpage';
import { resetPointerForTests } from '@/src/page/actions';
import { handle } from '@/src/page/handler';
import { snapshot } from '@/src/page/snapshot';

/**
 * The ref the snapshot just assigned to the control whose accessible name is
 * `label`. Read off the snapshot the click will use, not off a private table.
 */
function refFor(snapshotText: string, label: string): string {
  const line = snapshotText.split('\n').find((entry) => entry.includes(`"${label}"`));
  const ref = line?.match(/\[ref=(e\d+)\]/)?.[1];
  if (!ref) throw new Error(`snapshot did not address ${label}`);
  return ref;
}

function countClicks(el: HTMLElement): { any: number; trusted: number } {
  const counts = { any: 0, trusted: 0 };
  el.addEventListener('click', (event) => {
    counts.any += 1;
    if (event.isTrusted) counts.trusted += 1;
  });
  return counts;
}

describe('in-page click trust (R-13, I-01)', () => {
  it('marking the in-page click trusted would let a handler that accepts only trusted input run', async () => {
    document.body.replaceChildren();
    const purchase = document.createElement('button');
    purchase.textContent = 'Purchase';
    const cancel = document.createElement('button');
    cancel.textContent = 'Cancel';
    document.body.append(purchase, cancel);

    const purchaseClicks = countClicks(purchase);
    const cancelClicks = countClicks(cancel);
    const purchaseRef = refFor(snapshot().text, 'Purchase');

    resetPointerForTests();
    const driver: PageDriverLike = {
      async click(_tabId, ref) {
        const result = handle({ op: 'click', ref });
        if (!result.ok) throw new Error(result.error ?? 'click failed');
      },
      async type() {},
      async press() {},
      async scroll() {},
    };
    const input = new InPageInputTier(driver);
    await input.attach(6);
    await input.click(purchaseRef);

    expect(purchaseClicks.any).toBe(1);
    expect(purchaseClicks.trusted).toBe(0);
    expect(cancelClicks.any).toBe(0);
    expect(cancelClicks.trusted).toBe(0);
  });
});
