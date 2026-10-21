import { describe, expect, it } from 'vitest';
import type { ModelInfo } from '@/src/messaging';
import { filterFree, findModel, rankModels, sourceOf } from './models';

const models: ModelInfo[] = [
  { id: 'paid/first', name: 'Paid', free: false, vision: true, tools: true, contextLength: 8000 },
  { id: 'nvidia/nemotron:free', name: 'Nemotron', free: true, vision: true, tools: true, contextLength: 1_000_000 },
  { id: 'meta/llama:free', name: 'Llama', free: true, vision: false, tools: true, contextLength: 128_000 },
  { id: 'same', name: 'OpenRouter copy', free: true, vision: false, tools: true, contextLength: 1000, source: 'openrouter' },
  { id: 'same', name: 'Kilo copy', free: false, vision: true, tools: true, contextLength: 1000, source: 'kilo' },
];

describe('model list', () => {
  it('pins Nemotron, then free models, and a search drops the ones that do not match every term', () => {
    expect(rankModels(models).map((model) => model.name)).toEqual([
      'Nemotron',
      'Llama',
      'OpenRouter copy',
      'Paid',
      'Kilo copy',
    ]);
    expect(rankModels(models, 'llama free').map((model) => model.name)).toEqual(['Llama']);
  });

  it('the same id on two sources resolves to the named source, and a model with no source is OpenRouter', () => {
    expect(findModel(models, 'same', 'kilo')?.name).toBe('Kilo copy');
    expect(findModel(models, 'same')?.name).toBe('OpenRouter copy');
    expect(sourceOf(models[0]!)).toBe('openrouter');
    expect(filterFree(models, true).every((model) => model.free)).toBe(true);
    expect(filterFree(models, false)).toHaveLength(models.length);
  });
});
