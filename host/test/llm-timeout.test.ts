import { createServer } from 'node:http';
import { describe, expect, it } from 'vitest';
import { LlmProxy, requestTimeoutMs } from '../src/llm.ts';
import { FakeSecretProvider, SecretStore } from '../src/secrets.ts';
import type { OutboundMsg } from '../src/protocol.ts';

describe('host request deadlines', () => {
  it.each([false, true])('terminates a real upstream connection that hangs (headers sent: %s)', async (headers) => {
    const server = createServer((_req, res) => {
      if (headers) { res.writeHead(200); res.write('partial'); }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address() as { port: number };
      const secrets = new SecretStore(new FakeSecretProvider({ OPENROUTER_API_KEY: 'fixture-only-key' }));
      await secrets.load();
      const sent: OutboundMsg[] = [];
      const proxy = new LlmProxy({
        secrets, send: (msg) => sent.push(msg), requestTimeoutMs: 100,
        fetch: (_url, init) => fetch(`http://127.0.0.1:${address.port}`, init),
      });
      await proxy.request({ type: 'llm.request', id: 'hung', url: 'chat/completions', body: {} });
      expect(sent.filter((msg) => msg.type !== 'llm.chunk')).toEqual([
        { type: 'llm.error', id: 'hung', code: 'timeout', message: 'Model request timed out after 100ms' },
      ]);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('uses five minutes by default, accepts longer deadlines, and rejects invalid timer values', () => {
    expect(requestTimeoutMs(undefined)).toBe(300_000);
    expect(requestTimeoutMs('600000')).toBe(600_000);
    for (const value of ['', 'nope', 0, -1, 1.5, Infinity, 86_400_001]) {
      expect(requestTimeoutMs(value)).toBe(300_000);
    }
  });
});
