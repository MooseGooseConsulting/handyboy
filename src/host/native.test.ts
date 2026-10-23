import { describe, expect, it } from 'vitest';
import { HostClient, FakeNativePort, mapKiloModel, mapOpenRouterModel } from './native';

describe('catalog mapping', () => {
  it('drops an entry with no id, treats a zero price or a :free id as free, and tags the source', () => {
    expect(mapOpenRouterModel(null)).toBeNull();
    expect(mapOpenRouterModel({})).toBeNull();

    const free = mapOpenRouterModel({
      id: 'nvidia/nemotron:free',
      pricing: { prompt: '0', completion: '0' },
      architecture: { input_modalities: ['text', 'image'] },
      supported_parameters: ['tools'],
      context_length: 1000,
    });
    expect(free).toMatchObject({ id: 'nvidia/nemotron:free', free: true, vision: true, tools: true, source: 'openrouter' });

    const paid = mapKiloModel({ id: 'paid/one:free', isFree: false, context_length: 8 });
    expect(paid).toMatchObject({ free: false, source: 'kilo', vision: false, tools: false });
  });
});

describe('HostClient log forwarding', () => {
  it('a dotted key is redacted before the message is posted, and a disconnected port posts nothing', () => {
    const port = new FakeNativePort();
    const client = new HostClient(() => port);
    const key = 'sk-or-v1.aaaabbbbccccdddd.eeeeffff00001111';
    client.appendLog({ level: 'error', source: 'worker', message: `boom ${key}`, at: 1 });
    expect(port.sent).toHaveLength(1);
    const posted = port.sent[0];
    expect(posted?.type).toBe('log.append');
    if (posted?.type !== 'log.append') return;
    expect(posted.message.includes(key)).toBe(false);
    expect(posted.message).toContain('[redacted]');

    port.disconnect();
    client.appendLog({ level: 'warn', source: 'panel', message: 'later', at: 2 });
    expect(port.sent).toHaveLength(1);
  });
});

describe('HostClient readiness', () => {
  it('asking about one source sends that source and reports the host answer for it', async () => {
    const port = new FakeNativePort();
    const client = new HostClient(() => port);
    const pending = client.keyStatus('kilo');
    const sent = port.sent[0];
    expect(sent).toMatchObject({ type: 'key.status', source: 'kilo' });
    if (sent?.type !== 'key.status') return;
    port.emit({ type: 'key.status.result', id: sent.id, ready: false, reason: 'KILO_CODE_API_KEY not available' });
    await expect(pending).resolves.toEqual({
      hostConnected: true,
      keyReady: false,
      reason: 'KILO_CODE_API_KEY not available',
    });
  });
});

describe('HostClient settling', () => {
  it('a generic host error for an llm request id settles that stream instead of leaving it pending', () => {
    const port = new FakeNativePort();
    const client = new HostClient(() => port);
    const errors: Array<[string, string]> = [];
    const id = client.sendLlmRequest(
      { url: '' },
      { onChunk: () => {}, onEnd: () => {}, onError: (code, message) => errors.push([code, message]) },
    );
    port.emit({ type: 'error', id, code: 'bad_request', message: 'llm.request requires a string "url"' });
    expect(errors).toEqual([['bad_request', 'llm.request requires a string "url"']]);

    // Settled means forgotten: a late duplicate must not fire the handler twice.
    port.emit({ type: 'llm.error', id, code: 'upstream', message: 'late' });
    expect(errors).toHaveLength(1);
  });
});
