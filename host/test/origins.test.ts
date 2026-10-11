import { describe, expect, it } from 'vitest';
import { normalizeRequest, OffOriginError } from '../src/origins.ts';

describe('normalizeRequest: origin tagging (the credential-selection seam)', () => {
  it('tags an OpenRouter absolute url and strips its /api/v1 prefix', () => {
    expect(normalizeRequest('https://openrouter.ai/api/v1/chat/completions')).toEqual({
      path: 'chat/completions',
      origin: 'openrouter',
    });
    expect(normalizeRequest('https://openrouter.ai/api/v1/key')).toEqual({
      path: 'key',
      origin: 'openrouter',
    });
  });

  it('preserves the query string after stripping the known-origin prefix', () => {
    expect(normalizeRequest('https://openrouter.ai/api/v1/chat/completions?x=1')).toEqual({
      path: 'chat/completions?x=1',
      origin: 'openrouter',
    });
  });

  it('tags a Kilo absolute url and strips its /api/gateway prefix', () => {
    expect(normalizeRequest('https://api.kilo.ai/api/gateway/chat/completions')).toEqual({
      path: 'chat/completions',
      origin: 'kilo',
    });
    expect(normalizeRequest('https://api.kilo.ai/api/gateway/models')).toEqual({
      path: 'models',
      origin: 'kilo',
    });
  });

  it('leaves a relative path with no origin at all, for the caller to default', () => {
    expect(normalizeRequest('/chat/completions')).toEqual({ path: 'chat/completions', origin: null });
    expect(normalizeRequest('chat/completions')).toEqual({ path: 'chat/completions', origin: null });
  });

  it('strips trailing slashes from a relative path', () => {
    expect(normalizeRequest('/chat/completions//')).toEqual({ path: 'chat/completions', origin: null });
    expect(normalizeRequest('/chat/completions/')).toEqual({ path: 'chat/completions', origin: null });
  });

  it('still refuses a foreign origin, same as before Kilo existed', () => {
    expect(() => normalizeRequest('https://evil.example.com/steal')).toThrow(OffOriginError);
  });

  it('refuses a protocol-relative url that names a foreign origin', () => {
    expect(() => normalizeRequest('//evil.example.com/steal')).toThrow(OffOriginError);
  });
});
