import { describe, expect, it } from 'vitest';
import { FrameParser, MAX_OUTBOUND_BYTES } from '../src/framing.ts';
import { makeSend } from '../src/outbound.ts';

function capture() {
  const frames: unknown[] = [];
  const parser = new FrameParser();
  const send = makeSend((buf) => {
    frames.push(...parser.push(buf));
  });
  return { frames, send };
}

const huge = 'x'.repeat(MAX_OUTBOUND_BYTES + 1);

describe('outbound send', () => {
  it('a reply too large for Chrome becomes a small error under the same id, so the request still settles', () => {
    const { frames, send } = capture();
    send({ type: 'models.list.result', id: 'm1', status: 200, body: { blob: huge } });
    send({ type: 'llm.end', id: 'r1', status: 200, headers: { big: huge } });
    expect(frames).toEqual([
      { type: 'error', id: 'm1', code: 'internal', message: expect.stringContaining('models.list.result') },
      { type: 'llm.error', id: 'r1', code: 'internal', message: expect.stringContaining('llm.end') },
    ]);
    // The fallback names the failure, never the payload it could not send.
    expect(JSON.stringify(frames).includes('xxxx')).toBe(false);
  });

  it('an oversized message with no id to answer is dropped without throwing', () => {
    const { frames, send } = capture();
    expect(() => send({ type: 'run.start', runId: 'run-1', prompt: huge })).not.toThrow();
    expect(frames).toEqual([]);
  });
});
