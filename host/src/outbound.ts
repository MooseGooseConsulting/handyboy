import { encodeFrame } from './framing.ts';
import { log } from './log.ts';
import type { ErrorCode, OutboundMsg } from './protocol.ts';

/** llm.* replies settle the extension's stream handlers; everything else settles a pending call. */
const LLM_STREAM_TYPES = new Set(['llm.request', 'llm.chunk', 'llm.end', 'llm.error']);

/**
 * The terminal reply for a request the host could not answer normally. Keyed by
 * the request's own id, because the extension correlates on nothing else and an
 * unanswered id stays pending for the life of the service worker.
 */
export function failureReply(type: string, id: string, code: ErrorCode, message: string): OutboundMsg {
  return LLM_STREAM_TYPES.has(type) ? { type: 'llm.error', id, code, message } : { type: 'error', id, code, message };
}

/**
 * Wraps the stdout writer. A message Chrome would refuse (over the 1 MB
 * host->extension cap, e.g. a large catalog) used to be logged and dropped, so
 * whoever asked for it waited forever. Now that id gets a small error instead.
 * The fallback carries only the type and the frame error, never the payload,
 * and is not retried if it too fails to encode.
 */
export function makeSend(write: (frame: Buffer) => void): (msg: OutboundMsg) => void {
  return (msg) => {
    let frame: Buffer;
    try {
      frame = encodeFrame(msg);
    } catch (err) {
      const error = (err as Error).message;
      log('error', 'failed to encode outbound message', { type: msg.type, error });
      const id = (msg as { id?: unknown }).id;
      if (typeof id !== 'string') return;
      try {
        frame = encodeFrame(failureReply(msg.type, id, 'internal', `host could not send ${msg.type}: ${error}`));
      } catch {
        return;
      }
    }
    write(frame);
  };
}
