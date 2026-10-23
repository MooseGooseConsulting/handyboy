import fs from 'node:fs/promises';
import path from 'node:path';
import { redact } from './log.ts';
import { runsDir } from './paths.ts';
import { RUN_ID_RE } from './protocol.ts';

export class RunLogError extends Error {}

export function assertRunId(runId: unknown): asserts runId is string {
  if (typeof runId !== 'string' || !RUN_ID_RE.test(runId)) {
    throw new RunLogError('runId must match [A-Za-z0-9_-]{1,64}');
  }
}

export function runLogPath(runId: string, dir: string = runsDir()): string {
  assertRunId(runId);
  return path.join(dir, `${runId}.jsonl`);
}

/**
 * Bearer tokens are not in `KEY_SHAPES` because host.log redacts whole serialized
 * lines, where `\S+` would run on through the rest of the JSON. Here it is applied
 * to one string value at a time, so it stops at that value's end.
 */
const BEARER_RE = /Bearer\s+\S+/gi;

function redactValue(value: unknown): unknown {
  if (typeof value === 'string') return redact(value).replace(BEARER_RE, '[redacted]');
  if (Array.isArray(value)) return value.map(redactValue);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    // A credential can sit in a property name, not only a value; redact keys with
    // the same policy. Distinct keys that redact to the same name collapse.
    for (const [key, v] of Object.entries(value)) out[redact(key).replace(BEARER_RE, '[redacted]')] = redactValue(v);
    return out;
  }
  return value;
}

/**
 * The extension redacts before sending (R-12), but the host does not trust that
 * alone: `redact()` also knows the literal keys this process loaded, which the
 * extension never sees -- a Kilo key has no shape a regex could catch.
 * Walks values rather than redacting the serialized line so the JSON stays valid.
 */
export function redactRunEvent(event: unknown): unknown {
  return redactValue(event);
}

/**
 * Append one redacted JSON line. The runId is validated before it ever touches a
 * path. Returns the event as written, so the dev-socket mirror publishes exactly
 * what reached disk rather than the unredacted original.
 */
export async function appendRunLog(runId: string, event: unknown, dir: string = runsDir()): Promise<unknown> {
  const file = runLogPath(runId, dir);
  const redacted = redactRunEvent(event);
  await fs.mkdir(dir, { recursive: true });
  await fs.appendFile(file, JSON.stringify(redacted) + '\n', 'utf8');
  return redacted;
}
