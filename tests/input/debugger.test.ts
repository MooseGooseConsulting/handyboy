import { describe, expect, it } from 'vitest';
import { DebuggerInputTier, type DebuggerApi, type DebuggerTarget } from '@/src/input/debugger';

const TAB = 4;

function debuggerPort() {
  const attached: DebuggerTarget[] = [];
  const commands: Array<{ method: string; params?: Record<string, unknown> }> = [];
  const api: DebuggerApi = {
    async attach(target) {
      attached.push({ tabId: target.tabId });
    },
    async detach() {},
    async sendCommand(_target, method, params) {
      commands.push(params === undefined ? { method } : { method, params });
    },
    onDetach: {
      addListener() {},
      removeListener() {},
    },
  };
  return { api, attached, commands };
}

function tier(port: ReturnType<typeof debuggerPort>) {
  return new DebuggerInputTier(port.api, {
    rng: () => 0.4,
    sleep: async () => {},
  });
}

describe('debugger tier CDP surface (R-13, I-01)', () => {
  it('a Runtime, Page, DOM, or Emulation command would widen the debugger tier past Input when it clicks, types, and scrolls', async () => {
    const port = debuggerPort();
    const input = tier(port);
    await input.attach(TAB);
    await input.click(30, 80);
    await input.typeText('Z');
    await input.press('Enter');
    await input.scroll(30, 80, 0, 48);

    const methods = port.commands.map((command) => command.method);
    expect(methods.length).toBeGreaterThan(0);
    expect(methods.some((method) => method === 'Input.dispatchMouseEvent')).toBe(true);
    expect(methods.some((method) => method === 'Input.dispatchKeyEvent')).toBe(true);
    expect(methods.every((method) => method.startsWith('Input.'))).toBe(true);
    expect(methods.some((method) => /^(Runtime|Page|DOM|Emulation)\./.test(method))).toBe(false);
  });

  it('raising the debugging banner from the click, or sending a CDP command from attach, would move the banner off the attach step', async () => {
    const port = debuggerPort();
    const input = tier(port);

    await expect(input.click(30, 80)).rejects.toThrow();
    expect(port.attached).toEqual([]);
    expect(port.commands).toEqual([]);

    await input.attach(TAB);
    expect(port.attached).toEqual([{ tabId: TAB }]);
    expect(port.commands).toEqual([]);
  });
});
