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
