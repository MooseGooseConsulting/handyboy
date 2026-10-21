import vm from 'node:vm';
import { expect, test } from 'vitest';
import type { Userscript } from '@/src/messaging';
import { DebugSession } from './debug';
import type { UserScriptsApi } from './runner';

// Chrome's execute() is the seam. The session's own run is left in place, so a
// result can land on the wrong script only if rerun commits it there.
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

test('committing a finished rerun onto whichever script is current attributes that result to the wrong script', async () => {
  let releaseAlpha = (): void => {};
  const alphaStillRunning = new Promise<void>((resolve) => {
    releaseAlpha = resolve;
  });
  Object.assign(globalThis, { __handyboyTestAlphaGate: alphaStillRunning });

  const alpha: Userscript = {
    id: 'alpha-shelf',
    name: 'Alpha',
    matches: ['https://shop.example/*'],
    code: `await globalThis.__handyboyTestAlphaGate;
return { tag: 'alpha', qty: 11 };`,
    updatedAt: 0,
  };
  const beta: Userscript = {
    id: 'beta-shelf',
    name: 'Beta',
    matches: ['https://shop.example/*'],
    code: "return { tag: 'beta', qty: 29 };",
    updatedAt: 0,
  };

  const session = new DebugSession({
    script: alpha,
    tabId: 7,
    url: 'https://shop.example/cart',
    api: executingApi(),
  });

  try {
    const alphaRun = session.rerun();
    session.select(beta);
    const betaRun = session.rerun();

    const betaResult = await betaRun;
    releaseAlpha();
    const alphaResult = await alphaRun;

    expect(alphaResult.scriptId).toBe('alpha-shelf');
    expect(alphaResult.ok).toBe(true);
    expect(alphaResult.value).toEqual({ tag: 'alpha', qty: 11 });
    expect(betaResult.scriptId).toBe('beta-shelf');
    expect(betaResult.ok).toBe(true);
    expect(betaResult.value).toEqual({ tag: 'beta', qty: 29 });

    expect(session.last('alpha-shelf')?.scriptId).toBe('alpha-shelf');
    expect(session.last('alpha-shelf')?.value).toEqual({ tag: 'alpha', qty: 11 });
    expect(session.last('beta-shelf')?.scriptId).toBe('beta-shelf');
    expect(session.last('beta-shelf')?.value).toEqual({ tag: 'beta', qty: 29 });
  } finally {
    releaseAlpha();
    delete (globalThis as { __handyboyTestAlphaGate?: Promise<void> }).__handyboyTestAlphaGate;
  }
});
