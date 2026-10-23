import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Dispatcher } from '../src/dispatcher.ts';
import type { LlmProxy } from '../src/llm.ts';
import type { OutboundMsg } from '../src/protocol.ts';

let dir: string | undefined;

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

function harness() {
  const sent: OutboundMsg[] = [];
  const llm = {
    keyStatus: async () => ({ ready: false, reason: 'no key in the store' }),
    abort: () => {},
    request: () => {},
  } as unknown as LlmProxy;
  const dispatcher = new Dispatcher({
    send: (msg) => sent.push(msg),
    llm,
    runsDir: dir ?? '/tmp/unused-runs',
    artifactsDir: dir,
  });
  return { dispatcher, sent };
}

describe('dispatcher', () => {
  it('a message without a type is a bad request, and an unknown type is not treated as success', async () => {
    const { dispatcher, sent } = harness();
    await dispatcher.handle(null);
    await dispatcher.handle({ type: 'not.a.thing', id: 'm1' });
    expect(sent).toEqual([
      { type: 'error', id: undefined, code: 'bad_request', message: 'message must be an object with a string "type"' },
      { type: 'error', id: 'm1', code: 'unknown_type', message: 'unknown type not.a.thing' },
    ]);
  });

  it('key.status reports the host key check, and artifact.save refuses a filename that escapes the run directory', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'hb-disp-'));
    const { dispatcher, sent } = harness();
    await dispatcher.handle({ type: 'key.status', id: 'k1' });
    await dispatcher.handle({
      type: 'artifact.save',
      id: 'a1',
      runId: 'run-1',
      filename: '../escape.json',
      content: 'nope',
    });
    await dispatcher.handle({
      type: 'artifact.save',
      id: 'a2',
      runId: 'run-1',
      filename: '..escape.json',
      content: 'nope',
    });
    expect(sent[0]).toEqual({
      type: 'key.status.result',
      id: 'k1',
      ready: false,
      reason: 'no key in the store',
    });
    expect(sent[1]).toMatchObject({
      type: 'error',
      id: 'a1',
      code: 'bad_request',
      message: 'filename must not contain a path separator',
    });
    expect(sent[2]).toMatchObject({
      type: 'error',
      id: 'a2',
      code: 'bad_request',
      message: 'filename must not contain ".."',
    });
  });
});

describe('dispatcher failures', () => {
  it('a handler that throws still answers the request id, so the extension does not wait forever', async () => {
    const sent: OutboundMsg[] = [];
    const llm = {
      keyStatus: async () => {
        throw new Error('secret store exploded');
      },
      request: async () => {
        throw new Error('proxy exploded');
      },
    } as unknown as LlmProxy;
    const dispatcher = new Dispatcher({ send: (msg) => sent.push(msg), llm, runsDir: '/tmp/unused-runs' });
    await dispatcher.handle({ type: 'key.status', id: 'k1' });
    await dispatcher.handle({ type: 'llm.request', id: 'r1', url: 'chat/completions' });
    expect(sent).toEqual([
      { type: 'error', id: 'k1', code: 'internal', message: 'secret store exploded' },
      { type: 'llm.error', id: 'r1', code: 'internal', message: 'proxy exploded' },
    ]);
  });
});
