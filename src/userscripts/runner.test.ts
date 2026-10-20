import vm from 'node:vm';
import { expect, test } from 'vitest';
import type { Userscript } from '@/src/messaging';
import { runUserscript, type UserScriptsApi } from './runner';

// Chrome's execute() is the seam. Running the source it receives is what makes a
// break in the wrapper, or in reading the value back, fail these tests.
function executingApi(): UserScriptsApi {
  return {
    async execute<T>(injection: chrome.userScripts.UserScriptInjection) {
      const entry = injection.js[0];
      const source = typeof entry === 'string' ? entry : entry?.code;
      if (source === undefined) throw new Error('userscript injection had no source');
      const value = (await vm.runInThisContext(source)) as T;
      return [{ documentId: 'doc', frameId: 0, result: value }] as chrome.userScripts.InjectionResult<T>[];
    },
  };
}

const page = 'https://shop.example/cart';

test('forgetting the injection result drops the value a successful userscript returned', async () => {
  const script: Userscript = {
    id: 'shelf-count',
    name: 'Shelf count',
    matches: ['https://shop.example/*'],
    code: "return { sku: 'BX-19', qty: 4, open: true };",
    updatedAt: 0,
  };

  const result = await runUserscript({
    tabId: 7,
    script,
    url: page,
    api: executingApi(),
  });

  expect(result.scriptId).toBe('shelf-count');
  expect(result.ok).toBe(true);
  expect(result.value).toEqual({ sku: 'BX-19', qty: 4, open: true });
  expect(result.error).toBeUndefined();
  expect(result.console).toEqual([]);
});

test('dropping the caught error or the console buffer returns a failing script with neither', async () => {
  const script: Userscript = {
    id: 'bin-total',
    name: 'Bin total',
    matches: ['https://shop.example/*'],
    code: `console.log('counted bins');
console.warn('bin 3 was empty');
throw new Error('cannot total an empty bin');`,
    updatedAt: 0,
  };

  const result = await runUserscript({
    tabId: 7,
    script,
    url: page,
    api: executingApi(),
  });

  expect(result.scriptId).toBe('bin-total');
  expect(result.ok).toBe(false);
  expect(result.error).toContain('cannot total an empty bin');
  expect(result.console.map((line) => [line.level, line.text])).toEqual([
    ['log', 'counted bins'],
    ['warn', 'bin 3 was empty'],
  ]);
});
