import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

// Every other host test imports modules through vitest's transform. Chrome runs
// `node src/main.ts` with nothing in between, so only a real process proves the host the
// extension spawns can start: an import Node cannot resolve or a syntax Node will not
// strip passes the unit suite and still leaves the extension with no host.

const MAIN = fileURLToPath(new URL('../src/main.ts', import.meta.url));

function firstFrame(stdout: NodeJS.ReadableStream): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    stdout.on('data', (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length < 4) return;
      const len = buf.readUInt32LE(0);
      if (buf.length >= 4 + len) resolve(JSON.parse(buf.subarray(4, 4 + len).toString('utf8')));
    });
    stdout.on('end', () => reject(new Error('host closed stdout before sending a frame')));
  });
}

function askStatus(socketPath: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(socketPath);
    let text = '';
    sock.on('connect', () => sock.write('{"op":"status"}\n'));
    sock.on('data', (d) => {
      text += d.toString('utf8');
      const nl = text.indexOf('\n');
      if (nl < 0) return;
      sock.destroy();
      resolve(JSON.parse(text.slice(0, nl)) as Record<string, unknown>);
    });
    sock.on('error', reject);
  });
}

it('the host boots under plain node, says hello over native messaging, answers status, and exits when stdin closes', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'hb-boot-'));
  const socketPath = path.join(home, 'boot.sock');
  // An empty PATH keeps doppler out of reach: the host must boot without a key, and the
  // test must never read the developer's real one.
  const child = spawn(process.execPath, [MAIN, '--dev'], {
    env: { HB_HOME: home, HANDYBOY_SOCK: socketPath, PATH: path.join(home, 'no-bin') },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
  const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));

  try {
    const hello = await Promise.race([
      firstFrame(child.stdout),
      exited.then((code) => Promise.reject(new Error(`host exited ${code} before hello:\n${stderr}`))),
    ]);
    expect(hello).toMatchObject({ type: 'hello', dev: true });

    const status = await askStatus(socketPath);
    expect(status).toMatchObject({ op: 'status', ok: true, extensionConnected: true, pid: child.pid });

    child.stdin.end();
    expect(await exited).toBe(0);
  } finally {
    child.kill();
    await rm(home, { recursive: true, force: true });
  }
});
