import { describe, expect, it } from 'vitest';
import { createChannel, createFakePortPair } from '@/src/messaging/port';

describe('panel port', () => {
  it('a message reaches the other end, and nothing arrives after the channel closes', () => {
    const [worker, panel] = createFakePortPair();
    const received: unknown[] = [];
    let closed = 0;
    const channel = createChannel(panel);
    channel.onMessage((message) => received.push(message.payload));
    channel.onClose(() => {
      closed += 1;
    });

    worker.postMessage({ type: 'run.event', id: '1', payload: { n: 1 } });
    expect(received).toEqual([{ n: 1 }]);

    channel.close();
    worker.postMessage({ type: 'run.event', id: '2', payload: { n: 2 } });
    expect(received).toEqual([{ n: 1 }]);
    expect(closed).toBe(1);
    expect(channel.closed).toBe(true);
  });
});
