// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { handle, installPageListener, resetPageListenerForTests } from '@/src/page/handler';
import { beforeEach } from 'vitest';

describe('page handler', () => {
  beforeEach(() => {
    resetPageListenerForTests();
    document.body.innerHTML = '<button>Buy now</button>';
  });

  it('a malformed message is refused, and a snapshot names the button', () => {
    expect(handle(null)).toEqual({ ok: false, error: 'malformed page request' });
    expect(handle({ op: 'nope' })).toEqual({ ok: false, error: 'unknown op: nope' });
    const shot = handle({ op: 'snapshot' });
    expect(shot.ok).toBe(true);
    expect('text' in shot && shot.text).toContain('button "Buy now"');
  });

  it('a second install does not add a second listener', () => {
    const listeners: Array<(message: unknown, sender: unknown, send: (response: unknown) => void) => boolean | undefined> = [];
    const api = {
      runtime: {
        onMessage: {
          addListener(fn: (typeof listeners)[number]) {
            listeners.push(fn);
          },
        },
      },
    };
    expect(installPageListener(api)).toBe(true);
    expect(installPageListener(api)).toBe(false);
    expect(listeners).toHaveLength(1);
  });
});
