// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { resolveRef, snapshot } from '@/src/page/snapshot';

describe('page snapshot', () => {
  it('names a button with a stable ref, and a second snapshot does not keep the old ref', () => {
    document.body.innerHTML = '<button>Buy now</button><a href="/cart">Cart</a>';
    const first = snapshot({ root: document });
    expect(first.text).toContain('button "Buy now" [ref=e1]');
    expect(first.text).toContain('link "Cart" [ref=e2]');
    expect(resolveRef('e1')?.textContent).toBe('Buy now');

    document.body.innerHTML = '<a href="/next">Next</a>';
    const second = snapshot({ root: document });
    expect(second.text).toContain('link "Next" [ref=e1]');
    expect(resolveRef('e1')?.textContent).toBe('Next');
    expect(first.nodes).toBe(2);
  });

  it('a hidden control and a script do not appear, so the follower cannot act on them', () => {
    document.body.innerHTML = '<button hidden>Secret</button><script>secret()</script><button>Shown</button>';
    const result = snapshot({ root: document });
    expect(result.text).not.toContain('Secret');
    expect(result.text).not.toContain('secret()');
    expect(result.text).toContain('button "Shown"');
    expect(result.nodes).toBe(1);
  });

  it('stops at maxNodes and marks the snapshot truncated', () => {
    document.body.innerHTML = '<button>One</button><button>Two</button><button>Three</button>';
    const result = snapshot({ root: document, maxNodes: 2 });
    expect(result.nodes).toBe(2);
    expect(result.truncated).toBe(true);
    expect(result.text).toContain('One');
    expect(result.text).toContain('Two');
    expect(result.text).not.toContain('Three');
  });
});
