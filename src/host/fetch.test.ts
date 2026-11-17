import { describe, expect, it, vi } from 'vitest';
import { createHostFetch, type LlmClient } from './fetch';

describe('host fetch', () => {
  it('drops an Authorization header and refuses a url that is not OpenRouter or Kilo', async () => {
    const sent: Array<{ url: string; headers?: Record<string, string> }> = [];
    const client: LlmClient = {
      sendLlmRequest(req) {
        sent.push(req);
        return 'id-1';
      },
      abortLlm: vi.fn(),
    };
    const hostFetch = createHostFetch(client);

    await expect(hostFetch('https://evil.example/v1/chat')).rejects.toThrow(/off-origin/);

    void hostFetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: 'Bearer secret', 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.headers?.authorization).toBeUndefined();
    expect(sent[0]?.headers?.Authorization).toBeUndefined();
    expect(sent[0]?.headers?.['content-type']).toBe('application/json');
  });
});
