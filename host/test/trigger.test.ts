import fs from 'node:fs';
import net from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { resetLogForTests } from '../src/log.ts';
import { TriggerServer } from '../src/trigger.ts';

/** Group and other permission bits. Any of these makes the socket connectable past the owner. */
const GROUP_OR_OTHER = 0o177;

function restoreEnv(name: string, had: boolean, previous: string | undefined): void {
  if (!had) delete process.env[name];
  else process.env[name] = previous;
}

function connectSocket(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect(socketPath);
    const timer = setTimeout(() => {
      sock.destroy();
      resolve(false);
    }, 200);
    sock.once('connect', () => {
      clearTimeout(timer);
      sock.destroy();
      resolve(true);
    });
    sock.once('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

it.skipIf(process.platform === 'win32')('the host socket is not connectable under a mode wider than 0600 before start() returns', async () => {
  const hadHome = Object.prototype.hasOwnProperty.call(process.env, 'HB_HOME');
  const previousHome = process.env.HB_HOME;
  const hadStderr = Object.prototype.hasOwnProperty.call(process.env, 'HANDYBOY_LOG_STDERR');
  const previousStderr = process.env.HANDYBOY_LOG_STDERR;
  const ambientUmask = process.umask(0);
  const dir = await mkdtemp(path.join(tmpdir(), 'handyboy-trigger-'));
  const socketPath = path.join(dir, 'trigger.sock');
  const realChmod = fs.promises.chmod.bind(fs.promises);
  let releaseHold = (): void => {};
  const hold = new Promise<void>((resolve) => {
    releaseHold = resolve;
  });
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    releaseHold();
  };
  const modesBeforeReturn: number[] = [];
  let connectedWhileWide = false;

  // Hold chmod open so the mode listen() created is visible. An ambient umask of
  // 0077 would hide a listen-then-chmod window (the inode would already be 0700),
  // so this test forces umask 0, which creates a socket at 0777 unless start()
  // installs its own restrictive umask first.
  fs.promises.chmod = async (target, mode) => {
    if (target === socketPath) {
      const bits = fs.statSync(socketPath).mode & 0o777;
      modesBeforeReturn.push(bits);
      if ((bits & GROUP_OR_OTHER) !== 0 && (await connectSocket(socketPath))) connectedWhileWide = true;
      await hold;
    }
    return realChmod(target, mode);
  };

  process.env.HB_HOME = dir;
  process.env.HANDYBOY_LOG_STDERR = '0';
  resetLogForTests();

  const server = new TriggerServer({
    socketPath,
    send: () => {},
    keyStatus: async () => ({ ready: false }),
    extensionConnected: () => false,
    hostVersion: '0.0.0-test',
  });

  try {
    const pending = server.start();
    const deadline = Date.now() + 3_000;
    while (modesBeforeReturn.length === 0 && Date.now() < deadline) {
      try {
        const bits = fs.statSync(socketPath).mode & 0o777;
        modesBeforeReturn.push(bits);
        if ((bits & GROUP_OR_OTHER) !== 0 && (await connectSocket(socketPath))) connectedWhileWide = true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const observedBeforeReturn = [...modesBeforeReturn];
    release();
    await pending;

    expect(observedBeforeReturn.length, 'socket was never observed before start() returned').toBeGreaterThan(0);
    for (const bits of observedBeforeReturn) {
      expect(bits & GROUP_OR_OTHER, `socket mode ${bits.toString(8)} is wider than 0600 before start() returned`).toBe(
        0,
      );
    }
    expect(connectedWhileWide, 'socket accepted a connection while its mode was wider than 0600').toBe(false);

    const umaskAfter = process.umask(0);
    process.umask(0);
    expect(umaskAfter, 'start() left a changed process umask behind').toBe(0);

    const finalBits = fs.statSync(socketPath).mode & 0o777;
    expect(finalBits & GROUP_OR_OTHER, `socket mode ${finalBits.toString(8)} is wider than 0600`).toBe(0);
    expect(await connectSocket(socketPath), 'owner could not connect after start() returned').toBe(true);
  } finally {
    release();
    fs.promises.chmod = realChmod;
    process.umask(ambientUmask);
    await server.close();
    resetLogForTests();
    restoreEnv('HB_HOME', hadHome, previousHome);
    restoreEnv('HANDYBOY_LOG_STDERR', hadStderr, previousStderr);
    await rm(dir, { recursive: true, force: true });
  }
});
