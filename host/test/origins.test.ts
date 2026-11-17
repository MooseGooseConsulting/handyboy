import { afterEach, describe, expect, it } from 'vitest';
import { resolveUrl } from '../src/llm.ts';
import { OffOriginError, normalizeRequest } from '../src/origins.ts';
import { makeHarness, type Harness } from './harness.ts';

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

  // Each of these used to resolve to a URL on another host while still picking a
  // credentialed source, so the key went out in its Authorization header. The URL
  // parser treats `\` as `/`, strips tabs/newlines/leading C0 bytes, and reads
  // `http:host` as absolute -- none of which the old string checks saw.
  const escapes: Array<[string, string]> = [
    ['a backslash pair, read as a protocol-relative url', '\\\\evil.example/x'],
    ['a backslash then a slash', '\\/evil.example/x'],
    ['a scheme with no slashes', 'http:evil.example/x'],
    ['a scheme followed by backslashes', 'http:\\\\evil.example'],
    ['a leading C0 control byte before //', '\x01//evil.example/x'],
    ['a tab inside the scheme separator', 'https:\t//evil.example'],
    ['another special scheme with no slashes', 'wss:evil.example'],
    ['an OpenRouter url whose path re-parses as http:', 'https://openrouter.ai/api/v1/http:evil.example'],
    ['a Kilo url whose path re-parses as http:', 'https://api.kilo.ai/api/gateway/http:evil.example/x'],
  ];

  it.each(escapes)('a request target with %s never resolves to another host', (_label, target) => {
    let resolved: { url: string; source: string } | undefined;
    try {
      resolved = resolveUrl(target);
    } catch (err) {
      expect(err).toBeInstanceOf(OffOriginError);
      return;
    }
    const base = resolved.source === 'kilo' ? 'https://api.kilo.ai' : 'https://openrouter.ai';
    expect(new URL(resolved.url).origin).toBe(base);
  });

  it('refuses userinfo, backslashes, control bytes and paths that climb out of the api prefix', () => {
    expect(() => resolveUrl('https://user:pass@openrouter.ai/api/v1/chat/completions')).toThrow(OffOriginError);
    expect(() => resolveUrl('chat\\completions')).toThrow(OffOriginError);
    expect(() => resolveUrl('chat/\ncompletions')).toThrow(OffOriginError);
    expect(() => resolveUrl('../../auth/keys')).toThrow(OffOriginError);
    expect(() => resolveUrl('%2e%2e/%2e%2e/auth/keys')).toThrow(OffOriginError);
    expect(() => resolveUrl('https://openrouter.ai/other/path')).toThrow(OffOriginError);
  });

  it('still accepts the ordinary relative and absolute forms the extension sends', () => {
    expect(resolveUrl('/chat/completions').url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(resolveUrl('https://openrouter.ai/api/v1/chat/completions/').url).toBe(
      'https://openrouter.ai/api/v1/chat/completions',
    );
    expect(resolveUrl('https://api.kilo.ai/api/gateway/chat/completions?x=1')).toEqual({
      url: 'https://api.kilo.ai/api/gateway/chat/completions?x=1',
      source: 'kilo',
    });
    // Percent-encoded slashes stay a literal path segment on the known host.
    expect(new URL(resolveUrl('%2F%2Fevil.example').url).origin).toBe('https://openrouter.ai');
  });
});

describe('llm.request off-origin refusal', () => {
  let h: Harness;
  afterEach(async () => h?.cleanup());

  it('an escaping llm.request target is answered with bad_request and never reaches fetch', async () => {
    h = await makeHarness({ key: 'sk-or-v1-thisisnotreal', kiloKey: 'kilo-not-real-key' });
    await h.dispatcher.handle({ type: 'llm.request', id: 'r1', url: '\\\\evil.example/steal', body: {} });
    await h.dispatcher.handle({
      type: 'llm.request',
      id: 'r2',
      url: 'https://api.kilo.ai/api/gateway/http:evil.example/x',
      body: {},
    });
    expect(h.fetch.calls).toHaveLength(0);
    expect(h.sent).toEqual([
      expect.objectContaining({ type: 'llm.error', id: 'r1', code: 'bad_request' }),
      expect.objectContaining({ type: 'llm.error', id: 'r2', code: 'bad_request' }),
    ]);
  });
});
