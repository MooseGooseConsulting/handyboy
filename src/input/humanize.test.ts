import { describe, expect, it } from 'vitest';
import { jitterInBox } from './humanize';

describe('click jitter', () => {
  it('a click point stays inside the box and is not the exact centre for either extreme of the rng', () => {
    const box = { x: 100, y: 200, width: 40, height: 20 };
    const low = jitterInBox(box, () => 0);
    const high = jitterInBox(box, () => 0.999);
    const centre = { x: 120, y: 210 };

    for (const point of [low, high]) {
      expect(point.x).toBeGreaterThanOrEqual(box.x);
      expect(point.x).toBeLessThanOrEqual(box.x + box.width);
      expect(point.y).toBeGreaterThanOrEqual(box.y);
      expect(point.y).toBeLessThanOrEqual(box.y + box.height);
      expect(point).not.toEqual(centre);
    }
    expect(low.x).toBeCloseTo(centre.x - 7, 5);
    expect(low.y).toBeCloseTo(centre.y - 3.5, 5);
  });
});
