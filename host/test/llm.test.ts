import { describe, expect, it } from 'vitest';
import { resolveUrl } from '../src/llm.ts';

describe('llm url resolution', () => {
  it('a relative path uses OpenRouter, and an absolute Kilo url does not borrow the OpenRouter key', () => {
    expect(resolveUrl('chat/completions')).toEqual({
      url: 'https://openrouter.ai/api/v1/chat/completions',
      source: 'openrouter',
    });
    expect(resolveUrl('https://api.kilo.ai/api/gateway/chat/completions')).toEqual({
      url: 'https://api.kilo.ai/api/gateway/chat/completions',
      source: 'kilo',
    });
  });
});
