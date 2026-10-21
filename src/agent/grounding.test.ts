import { describe, expect, it } from 'vitest';
import { displayScale, displaySize, toNaturalPoint, validateObserveForVision } from './grounding';

describe('screenshot grounding', () => {
  it('never upscales a small capture, and a 2000px edge is sent at 1280', () => {
    expect(displayScale({ width: 800, height: 600 }, 1280)).toBe(1);
    expect(displaySize({ width: 2000, height: 1000 }, 1280)).toEqual({ width: 1280, height: 640 });
  });

  it('a point the model reports in the sent image maps back to the captured pixel', () => {
    const natural = { width: 2000, height: 1000 };
    const sent = displaySize(natural, 1280);
    expect(toNaturalPoint(sent, natural, { x: 640, y: 320 })).toEqual({ x: 1000, y: 500 });
  });

  it('pixels with a known text-only follower is refused, and an unknown vision flag is not', () => {
    expect(validateObserveForVision('pixels', false)).toContain('cannot see images');
    expect(validateObserveForVision('both', false)).toContain('both');
    expect(validateObserveForVision('dom', false)).toBeUndefined();
    expect(validateObserveForVision('pixels', undefined)).toBeUndefined();
  });
});
