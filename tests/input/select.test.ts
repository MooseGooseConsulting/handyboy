import { describe, expect, it, vi } from 'vitest';
import { RunInput, selectTier } from '@/src/input/select';
import type { InputTier } from '@/src/input/types';
import type { RefInputTier } from '@/src/input/inpage';

function refTier(): RefInputTier {
  return {
    name: 'in-page',
    attach: vi.fn(async () => {}),
    detach: vi.fn(async () => {}),
    isAttached: () => true,
    click: vi.fn(async () => {}),
    moveTo: vi.fn(async () => {}),
    typeText: vi.fn(async () => {}),
    press: vi.fn(async () => {}),
    scroll: vi.fn(async () => {}),
  };
}

function pointTier(): InputTier & { clicks: Array<{ x: number; y: number }> } {
  const clicks: Array<{ x: number; y: number }> = [];
  return {
    name: 'debugger',
    clicks,
    attach: vi.fn(async () => {}),
    detach: vi.fn(async () => {}),
    isAttached: () => true,
    moveTo: vi.fn(async () => {}),
    click: vi.fn(async (x: number, y: number) => {
      clicks.push({ x, y });
    }),
    typeText: vi.fn(async () => {}),
    press: vi.fn(async () => {}),
    scroll: vi.fn(async () => {}),
  };
}

describe('input tier selection', () => {
  it('in-page is the default tier, and escalated selects the debugger tier', () => {
    const page = refTier();
    const trusted = pointTier();
    expect(selectTier('in-page', { inPageTier: page, debuggerTier: trusted })).toBe(page);
    expect(selectTier('escalated', { inPageTier: page, debuggerTier: trusted })).toBe(trusted);
  });

  it('an escalated click uses the box centre plus jitter, not the element ref', async () => {
    const trusted = pointTier();
    const input = new RunInput({
      tier: trusted,
      getBox: async () => ({ x: 100, y: 200, width: 40, height: 20 }),
      rng: () => 0,
    });
    await input.click('e12');
    expect(trusted.clicks).toEqual([{ x: 113, y: 206.5 }]);
    expect(trusted.click).toHaveBeenCalledWith(113, 206.5, undefined);
  });
});
