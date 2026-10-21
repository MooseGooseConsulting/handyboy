import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { LlmProxy, type FetchLike } from '../src/llm.ts';
import { log, resetLogForTests } from '../src/log.ts';
import { hostLogPath } from '../src/paths.ts';
import { FakeSecretProvider, SecretStore } from '../src/secrets.ts';

/** What the desktop secret store returns. Not the process environment. */
const STORE_KEY = 'sk-or-v1.1111222233334444.5555666677778888';
/** A different key sitting in the environment, as if a shell had exported it. */
const ENV_KEY = 'sk-or-v1.9999aaaabbbbcccc.ddddeeeeffff0000';
/** A different key the extension puts on Authorization, which the host must ignore. */
const EXTENSION_KEY = 'sk-or-v1.aaaabbbbccccdddd.eeeeffff00001111';

const OPENROUTER_CHAT = 'https://openrouter.ai/api/v1/chat/completions';

function restoreEnv(name: string, had: boolean, previous: string | undefined): void {
  if (!had) delete process.env[name];
  else process.env[name] = previous;
}

it('a dotted OpenRouter key sk-or-v1.<hex>.<hex> does not survive host log redaction', async () => {
  const key = 'sk-or-v1.0a1b2c3d4e5f6789.9f8e7d6c5b4a3210';
  const head = '0a1b2c3d4e5f6789';
  const tail = '9f8e7d6c5b4a3210';
  const hadHome = Object.prototype.hasOwnProperty.call(process.env, 'HB_HOME');
  const previousHome = process.env.HB_HOME;
  const hadStderr = Object.prototype.hasOwnProperty.call(process.env, 'HANDYBOY_LOG_STDERR');
  const previousStderr = process.env.HANDYBOY_LOG_STDERR;
  const dir = await mkdtemp(path.join(tmpdir(), 'handyboy-host-log-'));
  try {
    resetLogForTests();
    process.env.HB_HOME = dir;
    process.env.HANDYBOY_LOG_STDERR = '0';
    log('error', `upstream said ${key} was rejected`, { detail: 'keep-this-token' });
    const file = hostLogPath();
    // log() writes through a stream. end() flushes it; the bytes are not on disk yet.
    resetLogForTests();
    const written = await readFlushedLog(file);
    expect(written.includes(key), 'dotted OpenRouter key survived host log redaction').toBe(false);
    expect(written.includes(head), 'left half of a dotted OpenRouter key survived host log redaction').toBe(false);
    expect(written.includes(tail), 'right half of a dotted OpenRouter key survived host log redaction').toBe(false);
    const parsed = JSON.parse(written.trim()) as { level: string; message: string; detail: string };
    expect(parsed.level).toBe('error');
    expect(parsed.message).toBe('upstream said [redacted] was rejected');
    expect(parsed.detail).toBe('keep-this-token');
  } finally {
    resetLogForTests();
    restoreEnv('HB_HOME', hadHome, previousHome);
    restoreEnv('HANDYBOY_LOG_STDERR', hadStderr, previousStderr);
    await rm(dir, { recursive: true, force: true });
  }
});

it('the extension does not hold the API key; the host reads it from the secret store', async () => {
  const hadOpenRouter = Object.prototype.hasOwnProperty.call(process.env, 'OPENROUTER_API_KEY');
  const previousOpenRouter = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = ENV_KEY;
  try {
    const store = new SecretStore(new FakeSecretProvider({ OPENROUTER_API_KEY: STORE_KEY }));
    await store.load();

    let requestedUrl = '';
    let authorization: string | null = null;
    const fetchImpl: FetchLike = async (input, init) => {
      requestedUrl = input;
      authorization = new Headers(init?.headers).get('authorization');
      return new Response('{"id":"cmpl"}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    const outbound: unknown[] = [];
    const proxy = new LlmProxy({
      fetch: fetchImpl,
      secrets: store,
      send: (msg) => {
        outbound.push(msg);
      },
    });
    await proxy.request({
      type: 'llm.request',
      id: 'req-1',
      url: 'chat/completions',
      headers: { Authorization: `Bearer ${EXTENSION_KEY}` },
      body: { model: 'nvidia/nemotron-3.5-lightning:free' },
    });

    expect(requestedUrl).toBe(OPENROUTER_CHAT);
    // The header is written inside the fetch callback, so control-flow keeps the
    // outer binding narrowed to its initial null. Read it back as the full type.
    const sentAuthorization = authorization as string | null;
    expect(sentAuthorization === `Bearer ${STORE_KEY}`, 'host did not attach the secret-store key').toBe(true);
    expect(sentAuthorization?.includes(EXTENSION_KEY) ?? false, 'host forwarded the extension Authorization key').toBe(
      false,
    );
    expect(sentAuthorization?.includes(ENV_KEY) ?? false, 'host read OPENROUTER_API_KEY from the environment').toBe(
      false,
    );
    const wire = JSON.stringify(outbound);
    expect(wire.includes(STORE_KEY), 'host sent the secret-store key back to the extension').toBe(false);
    expect(wire.includes(EXTENSION_KEY), 'host echoed the extension key').toBe(false);
    expect(wire.includes(ENV_KEY), 'host echoed the environment key').toBe(false);
  } finally {
    restoreEnv('OPENROUTER_API_KEY', hadOpenRouter, previousOpenRouter);
    resetLogForTests();
  }
});

/** Poll until the flushed host log line is readable. Never throws the line itself. */
async function readFlushedLog(file: string): Promise<string> {
  const deadline = Date.now() + 2_000;
  let latest = '';
  while (Date.now() < deadline) {
    try {
      latest = await readFile(file, 'utf8');
      if (latest.includes('keep-this-token')) return latest;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('host log was not written to the temp dir');
}
