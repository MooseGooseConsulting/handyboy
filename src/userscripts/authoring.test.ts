import { describe, expect, it, vi } from 'vitest';
import { checkAgentMatches, writeAgentUserscript } from './authoring';

describe('agent userscript rails', () => {
  it('a wildcard host and a file scheme are rejected, and a single https host is not', () => {
    const errors = checkAgentMatches(['*://*/*', 'file:///tmp/x.js', 'https://shop.example/item/*']);
    expect(errors.some((error) => error.includes('*://*/*'))).toBe(true);
    expect(errors.some((error) => error.includes('file'))).toBe(true);
    expect(errors.some((error) => error.includes('shop.example'))).toBe(false);
  });

  it('a rejected write is not stored, and a user-authored script is not overwritten', async () => {
    const write = vi.fn();
    const wildcard = await writeAgentUserscript(
      { name: 'wide', matches: ['*://*/*'], code: 'return 1;' },
      { write, list: async () => [], read: async () => undefined },
    );
    expect(wildcard.ok).toBe(false);
    expect(write).not.toHaveBeenCalled();

    const stolen = await writeAgentUserscript(
      { scriptId: 'user-1', name: 'mine', matches: ['https://shop.example/*'], code: 'return 2;' },
      {
        write,
        list: async () => [],
        read: async () => ({
          id: 'user-1',
          name: 'mine',
          matches: ['https://shop.example/*'],
          code: 'return 0;',
          updatedAt: 1,
        }),
      },
    );
    expect(stolen.ok).toBe(false);
    if (stolen.ok) return;
    expect(stolen.errors.join(' ')).toContain('written by the user');
    expect(write).not.toHaveBeenCalled();
  });
});
