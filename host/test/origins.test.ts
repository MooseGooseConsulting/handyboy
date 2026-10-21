import { describe, expect, it } from 'vitest';
import { OffOriginError, normalizeRequest } from '../src/origins.ts';

describe('proxy origins', () => {
  it('strips the OpenRouter and Kilo prefixes and refuses any other absolute origin', () => {
    expect(normalizeRequest('https://openrouter.ai/api/v1/chat/completions')).toEqual({
      path: 'chat/completions',
      origin: 'openrouter',
    });
    expect(normalizeRequest('https://api.kilo.ai/api/gateway/chat/completions?x=1')).toEqual({
      path: 'chat/completions?x=1',
      origin: 'kilo',
    });
    expect(normalizeRequest('/chat/completions')).toEqual({ path: 'chat/completions', origin: null });
    expect(() => normalizeRequest('https://evil.example/api/v1/chat/completions')).toThrow(OffOriginError);
    expect(() => normalizeRequest('//evil.example/steal')).toThrow(OffOriginError);
  });
});
