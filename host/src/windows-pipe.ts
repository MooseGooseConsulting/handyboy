import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { Duplex } from 'node:stream';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { log } from './log.ts';
import { windowsPowerShell, windowsPowerShellEnv } from './permissions.ts';

/** Private-at-creation Windows pipes, presented as ordinary streams to the trigger. */
export class WindowsPipeServer {
  #child?: ChildProcessWithoutNullStreams;
  #clients = new Map<string, Duplex>();
  #exit?: Promise<void>;
  #closing = false;

  async listen(endpoint: string, onConnection: (socket: Duplex) => void): Promise<void> {
    const prefix = '\\\\.\\pipe\\';
    if (!endpoint.startsWith(prefix)) throw new Error('HANDYBOY_SOCK must be a Windows named pipe path');
    const child = spawn(windowsPowerShell(), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
      fileURLToPath(new URL('../windows/pipe-server.ps1', import.meta.url)), '-PipeName', endpoint.slice(prefix.length)],
    { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: windowsPowerShellEnv() });
    this.#child = child;
    let ready = false;
    this.#exit = new Promise((resolve) => child.once('close', (code) => {
      // After ready the startup promise is settled, so an unexpected exit would
      // otherwise leave the trigger pipe dead with nothing in the log.
      if (ready && !this.#closing) log('error', 'Windows pipe helper exited; trigger pipe unavailable', { code });
      for (const socket of this.#clients.values()) socket.destroy();
      this.#clients.clear();
      resolve();
    }));
    child.stdin.on('error', () => {});
    await new Promise<void>((resolve, reject) => {
      let diagnostics = '';
      const timer = setTimeout(() => { child.kill(); reject(new Error('Windows pipe startup timed out')); }, 15_000);
      const fail = () => { clearTimeout(timer); reject(new Error(`Windows pipe helper failed to start: ${diagnostics}`)); };
      child.once('error', fail);
      child.once('exit', fail);
      // Diagnostics must never contaminate the native-messaging stdout channel.
      child.stderr.on('data', (chunk) => { diagnostics = (diagnostics + String(chunk)).slice(-2000); });
      createInterface({ input: child.stdout }).on('line', (line) => {
        const [kind, id, data] = line.split(' ', 3);
        if (kind === 'ready') { ready = true; clearTimeout(timer); resolve(); return; }
        if (kind === 'error') {
          // After ready this is one client's fault; keep the pipe up for the rest.
          if (ready) { log('warn', 'Windows pipe helper reported an error', { detail: line.slice(6) }); return; }
          fail(); child.kill(); return;
        }
        if (!id) return;
        if (kind === 'open') {
          const socket = new Duplex({
            read() {},
            write(chunk, _encoding, callback) {
              child.stdin.write(`write ${id} ${Buffer.from(chunk).toString('base64')}\n`, callback);
            },
            final(callback) { child.stdin.write(`close ${id}\n`, callback); },
            destroy(error, callback) { child.stdin.write(`close ${id}\n`); callback(error); },
          });
          this.#clients.set(id, socket);
          onConnection(socket);
        } else if (kind === 'data' && data) {
          this.#clients.get(id)?.push(Buffer.from(data, 'base64'));
        } else if (kind === 'close') {
          const socket = this.#clients.get(id);
          this.#clients.delete(id);
          socket?.push(null);
          socket?.destroy();
        }
      });
    });
  }

  async close(): Promise<void> {
    this.#closing = true;
    this.#child?.stdin.end();
    await this.#exit;
    this.#child = undefined;
  }
}
