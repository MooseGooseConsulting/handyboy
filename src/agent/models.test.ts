import { describe, expect, it } from 'vitest';
import { dataCollectionFor } from './models';

describe('model data collection', () => {
  it('a free model allows provider data collection, and a paid model denies it', () => {
    expect(dataCollectionFor('nvidia/nemotron-3.5-lightning:free')).toBe('allow');
    expect(dataCollectionFor('nvidia/nemotron-3-ultra-550b-a55b')).toBe('deny');
    expect(dataCollectionFor('meta/llama:free-extra')).toBe('deny');
  });
});
