import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { log } from './log.ts';
import { WindowsPipeServer } from './windows-pipe.ts';
import type { Duplex } from 'node:stream';
import type { OutboundMsg, SocketRequest, SocketResponse } from './protocol.ts';

/**
 * Dev-only trigger. Chrome spawns the host, so an outside runner needs a side door
 * into a process it did not start. Unix uses a 0600 socket; Windows uses a named
 * pipe created with a user/SYSTEM DACL. Neither exposes a loopback HTTP endpoint
 * that a page could call.
 *
 * Gated on HANDYBOY_DEV=1 (or --dev in the manifest wrapper); never bound otherwise.
 */

export interface TriggerDeps {
  socketPath: string;
  /** Push a message to the extension over the native port. */
  send: (msg: OutboundMsg) => void;
  keyStatus: () => Promise<Extract<SocketResponse, { op: 'status' }>['key']>;
  extensionConnected: () => boolean;
  hostVersion: string;
  /** Test seam over `process.pid`. hb-reload watches it change to prove a new host came up. */
  pid?: () => number;
}

export function newRunId(): string {
  return `run-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`;
}

export class TriggerServer {
  #server: net.Server | null = null;
  #windows?: WindowsPipeServer;
  /** runId -> sockets streaming that run. */
  readonly #subs = new Map<string, Set<Duplex>>();
  readonly #deps: TriggerDeps;

  constructor(deps: TriggerDeps) {
    this.#deps = deps;
  }

  async start(): Promise<void> {
    const p = this.#deps.socketPath;
    if (process.platform === 'win32') {
      this.#windows = new WindowsPipeServer();
      await this.#windows.listen(p, (socket) => this.#onConnection(socket));
      log('info', 'dev trigger pipe listening', { path: p });
      return;
    }
    await fs.promises.mkdir(path.dirname(p), { recursive: true });
    // A stale socket from a crashed host would make bind fail with EADDRINUSE.
    try {
      await fs.promises.unlink(p);
    } catch {
      /* not there: fine */
    }
    const server = net.createServer((sock) => this.#onConnection(sock));
    this.#server = server;
    // listen() creates the socket inode under the process umask, and only then
    // can chmod run. A 0022 umask leaves that inode at 0755, and connectable,
    // for the whole gap. Bind it 0600, and put the previous umask back even
    // when listen fails.
    const previousUmask = process.umask(0o177);
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(p, () => {
          server.removeListener('error', reject);
          resolve();
        });
      });
      try {
        await fs.promises.chmod(p, 0o600);
      } catch (error) {
        // listen() already succeeded. Leave the socket closed if we cannot
        // confirm its mode, or main.ts drops the server and the listener stays up.
        server.close();
        this.#server = null;
        await fs.promises.unlink(p).catch(() => {});
        throw error;
      }
    } finally {
      process.umask(previousUmask);
    }
    log('info', 'dev trigger socket listening', { path: p });
  }

  #onConnection(sock: Duplex): void {
    let buf = '';
    sock.on('error', () => sock.destroy());
    sock.on('close', () => {
      for (const set of this.#subs.values()) set.delete(sock);
    });
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) void this.#onLine(sock, line);
      }
    });
  }

  async #onLine(sock: Duplex, line: string): Promise<void> {
    let req: SocketRequest;
    try {
      req = JSON.parse(line) as SocketRequest;
    } catch {
      return write(sock, { op: 'error', message: 'invalid JSON' });
    }

    if (req.op === 'status') {
      const key = await this.#deps.keyStatus();
      write(sock, {
        op: 'status',
        ok: true,
        extensionConnected: this.#deps.extensionConnected(),
        hostVersion: this.#deps.hostVersion,
        pid: this.#pid(),
        key,
      });
      sock.end();
      return;
    }

    if (req.op === 'reload') {
      if (!this.#deps.extensionConnected()) {
        write(sock, { op: 'error', message: 'no extension connected to the host' });
        sock.end();
        return;
      }
      // `chrome.runtime.reload()` tears down the service worker, which drops the native
      // port, which kills THIS process. So answer first -- there is no later.
      write(sock, { op: 'reloading', pid: this.#pid() });
      this.#deps.send({ type: 'ext.reload' });
      sock.end();
      return;
    }

    if (req.op === 'cancel') {
      if (typeof req.runId !== 'string' || req.runId.length === 0) {
        return write(sock, { op: 'error', message: 'cancel requires a non-empty "runId"' });
      }
      if (!this.#deps.extensionConnected()) {
        write(sock, { op: 'error', message: 'no extension connected to the host' });
        sock.end();
        return;
      }
      this.#deps.send({ type: 'run.abort', runId: req.runId });
      write(sock, { op: 'cancelled', runId: req.runId });
      sock.end();
      return;
    }

    if (req.op === 'run') {
      if (typeof req.prompt !== 'string' || req.prompt.length === 0) {
        return write(sock, { op: 'error', message: 'run requires a non-empty "prompt"' });
      }
      if (!this.#deps.extensionConnected()) {
        write(sock, { op: 'error', message: 'no extension connected to the host' });
        sock.end();
        return;
      }
      const runId = req.runId ?? newRunId();
      let set = this.#subs.get(runId);
      if (!set) this.#subs.set(runId, (set = new Set()));
      set.add(sock);
      write(sock, { op: 'accepted', runId });
      this.#deps.send({
        type: 'run.start',
        runId,
        prompt: req.prompt,
        ...(req.url ? { url: req.url } : {}),
        ...(req.options ? { options: req.options } : {}),
      });
      return;
    }

    write(sock, { op: 'error', message: `unknown op ${String((req as { op: string }).op)}` });
  }

  #pid(): number {
    return (this.#deps.pid ?? (() => process.pid))();
  }

  /** Mirror a run-log event to whoever is streaming that run; close them on run.end. */
  publish(runId: string, event: unknown): void {
    const set = this.#subs.get(runId);
    if (!set || set.size === 0) return;
    for (const sock of set) write(sock, { op: 'event', runId, event });
    const type = (event as { type?: unknown } | null)?.type;
    if (type === 'run.end') {
      for (const sock of set) {
        write(sock, { op: 'end', runId });
        sock.end();
      }
      this.#subs.delete(runId);
    }
  }

  async close(): Promise<void> {
    await this.#windows?.close();
    this.#windows = undefined;
    for (const set of this.#subs.values()) for (const s of set) s.destroy();
    this.#subs.clear();
    const server = this.#server;
    this.#server = null;
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (process.platform === 'win32') return;
    try {
      await fs.promises.unlink(this.#deps.socketPath);
    } catch {
      /* already gone */
    }
  }
}

function write(sock: Duplex, msg: SocketResponse): void {
  if (!sock.destroyed) sock.write(JSON.stringify(msg) + '\n');
}
