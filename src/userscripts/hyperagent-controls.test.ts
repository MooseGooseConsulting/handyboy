import { describe, expect, it } from 'vitest';
import { isReadOnlyScript } from '@/src/agent/policy';
import { validateUserscript } from './catalog';
import { BUNDLED_USERSCRIPTS, HYPERAGENT_CONTROLS, WRITING_SEED_IDS } from './examples';
import { wrapUserscript } from './runner';

const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor as new (
  ...args: string[]
) => unknown;

describe('the bundled hyperagent-controls script', () => {
  it('is offered to every profile alongside the other bundled scripts', () => {
    expect(BUNDLED_USERSCRIPTS).toContain(HYPERAGENT_CONTROLS);
  });

  it('is a valid catalog entry allow-listed to Hyperagent only', () => {
    const result = validateUserscript(HYPERAGENT_CONTROLS);
    expect(result.ok).toBe(true);
    expect(HYPERAGENT_CONTROLS.matches).toEqual(['*://hyperagent.com/*', '*://www.hyperagent.com/*']);
  });

  it('parses as the body of an async function once the runner has wrapped it', () => {
    expect(() => new AsyncFunction(HYPERAGENT_CONTROLS.code)).not.toThrow();
    expect(() => new AsyncFunction(wrapUserscript(HYPERAGENT_CONTROLS.code))).not.toThrow();
  });

  it('is refused by the read-only scan, because it PATCHes thread settings', () => {
    expect(WRITING_SEED_IDS.has(HYPERAGENT_CONTROLS.id)).toBe(true);
    expect(isReadOnlyScript(HYPERAGENT_CONTROLS.code).ok).toBe(false);
  });

  it('sends only the effort ids the app itself sends, since the server stores any string', () => {
    const efforts = HYPERAGENT_CONTROLS.code.match(/const EFFORTS = (.*);/)?.[1] ?? '';
    expect(efforts).toContain("'xhigh'");
    expect([...efforts.matchAll(/\['([a-z]+)',/g)].map((m) => m[1])).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
  });
});
