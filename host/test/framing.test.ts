import { describe, expect, it } from 'vitest';
import { FrameError, FrameParser, MAX_OUTBOUND_BYTES, encodeFrame } from '../src/framing.ts';

describe('native-messaging frames', () => {
  it('a split header and body still parse as one message, and two frames in one chunk stay in order', () => {
    const frame = encodeFrame({ op: 'ping', n: 1 });
    const parser = new FrameParser();
    expect(parser.push(frame.subarray(0, 2))).toEqual([]);
    expect(parser.pending).toBe(2);
    expect(parser.push(frame.subarray(2))).toEqual([{ op: 'ping', n: 1 }]);

    const both = Buffer.concat([encodeFrame({ n: 1 }), encodeFrame({ n: 2 })]);
    expect(new FrameParser().push(both)).toEqual([{ n: 1 }, { n: 2 }]);
  });

  it('a declared length over the inbound limit throws, and an outbound body over 1 MiB throws', () => {
    const parser = new FrameParser(8);
    const header = Buffer.alloc(4);
    header.writeUInt32LE(9, 0);
    expect(() => parser.push(header)).toThrow(FrameError);

    const huge = 'x'.repeat(MAX_OUTBOUND_BYTES + 1);
    expect(() => encodeFrame(huge)).toThrow(FrameError);
  });

  it('a frame whose body is not JSON throws instead of yielding a partial object', () => {
    const body = Buffer.from('not-json', 'utf8');
    const header = Buffer.alloc(4);
    header.writeUInt32LE(body.byteLength, 0);
    expect(() => new FrameParser().push(Buffer.concat([header, body]))).toThrow(/not valid JSON/);
  });
});
