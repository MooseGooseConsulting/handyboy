import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { deleteUserscript, getUserscript, listUserscripts, saveUserscript, seedDefaults, userscriptsItem } from './catalog';
import { MAX_AGENT_SCRIPTS, writeAgentUserscript } from './authoring';

const draft = { name: 'extract', matches: ['https://example.com/*'], code: 'return 1;' };

describe('agent userscript cleanup', () => {
  beforeEach(() => fakeBrowser.reset());

  it('deleting an obsolete agent script frees a slot and preserves the other scripts', async () => {
    for (let i = 0; i < MAX_AGENT_SCRIPTS; i++) {
      await saveUserscript({ ...draft, id: `agent-${i}`, author: 'agent' });
    }
    expect((await writeAgentUserscript(draft)).ok).toBe(false);
    await expect(deleteUserscript('agent-0', { requireAuthor: 'agent' })).resolves.toBe(true);
    expect(await getUserscript('agent-0')).toBeUndefined();
    expect(await getUserscript('agent-1')).toBeDefined();
    expect((await writeAgentUserscript(draft)).ok).toBe(true);
    expect(await listUserscripts()).toHaveLength(MAX_AGENT_SCRIPTS);
  });

  it('rejects user and bundled scripts without changing the catalog, while panel deletion still works', async () => {
    const bundled = await seedDefaults();
    const user = await saveUserscript(draft);
    const before = await listUserscripts();
    for (const script of [user, ...bundled]) {
      await expect(deleteUserscript(script.id, { requireAuthor: 'agent' })).rejects.toThrow('cannot be deleted');
    }
    expect(await listUserscripts()).toEqual(before);
    await expect(deleteUserscript(user.id)).resolves.toBe(true);
  });

  it('rechecks current ownership when the user saves a formerly agent-owned script', async () => {
    const script = await saveUserscript({ ...draft, author: 'agent' });
    expect((await getUserscript(script.id))?.author).toBe('agent');
    await saveUserscript({ ...draft, id: script.id, code: 'return "my edit";' });
    const write = vi.spyOn(userscriptsItem, 'setValue');
    await expect(deleteUserscript(script.id, { requireAuthor: 'agent' })).rejects.toThrow('written by the user');
    expect(write).not.toHaveBeenCalled();
    expect((await getUserscript(script.id))?.code).toBe('return "my edit";');
  });

  it('reports a missing id without writing storage', async () => {
    const write = vi.spyOn(userscriptsItem, 'setValue');
    await expect(deleteUserscript('missing', { requireAuthor: 'agent' })).resolves.toBe(false);
    expect(write).not.toHaveBeenCalled();
  });
});
