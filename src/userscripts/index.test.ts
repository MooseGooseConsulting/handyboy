import { beforeEach, describe, expect, it } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { handleUserscriptMessage } from './index';

beforeEach(() => {
  fakeBrowser.reset();
});

describe('userscript messages', () => {
  it('a non-userscript message is ignored, and a run with no such script names the missing id', async () => {
    expect(await handleUserscriptMessage({ type: 'models.list', payload: {} })).toBeUndefined();
    expect(
      await handleUserscriptMessage({ type: 'userscript.run', payload: { scriptId: 'missing', code: 'return 1;' } }, { tabId: 3 }),
    ).toEqual({
      type: 'error',
      payload: { message: 'unknown userscript: missing', inReplyTo: 'userscript.run' },
    });
  });
});
