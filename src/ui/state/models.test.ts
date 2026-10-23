import { describe, expect, it } from 'vitest';
import type { ModelInfo } from '@/src/messaging';
import { filterFree, findModel, rankModels, sourceOf, trainingRisk } from './models';

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

describe('training risk', () => {
  const muse = (source: 'openrouter' | 'kilo', flag?: boolean): ModelInfo => ({
    id: 'meta/muse-spark-1.3-contributor',
    name: 'Muse Spark Contributor',
    free: false,
    vision: false,
    tools: true,
    contextLength: 1000,
    source,
    ...(flag === undefined ? {} : { mayTrainOnYourPrompts: flag }),
  });

  it('an OpenRouter entry with no flag of its own borrows the Kilo flag for the same id', () => {
    const catalog = [muse('openrouter'), muse('kilo', true)];
    expect(trainingRisk(catalog[0]!, catalog)).toBe('trains');
    expect(trainingRisk(muse('openrouter'), [muse('openrouter'), muse('kilo', false)])).toBe('no');
  });

  it('a paid OpenRouter model reads as unknown, not safe, when the Kilo catalog did not load', () => {
    expect(trainingRisk(muse('openrouter'), [muse('openrouter')])).toBe('unknown');
  });

  it('a free OpenRouter id trains, since those endpoints exist only under the training policy', () => {
    const free: ModelInfo = { ...muse('openrouter'), id: 'nvidia/nemotron-3.5-lightning:free' };
    expect(trainingRisk(free, [free])).toBe('trains');
  });

  it("a model's own explicit flag wins over anything borrowed", () => {
    expect(trainingRisk(muse('kilo', false), [muse('kilo', false), muse('kilo', true)])).toBe('no');
  });
});
