import { randomUUID } from 'node:crypto';
import net from 'node:net';
import { describe, expect, it } from 'vitest';
import { TriggerServer } from '../src/trigger.ts';
import { readWindowsAcl } from './windows-acl.ts';
import { resetLogForTests } from '../src/log.ts';
import { WindowsPipeServer } from '../src/windows-pipe.ts';

describe.skipIf(process.platform !== 'win32')('Windows named-pipe control', () => {
  it('refuses an endpoint that another server already owns', async () => {
    const endpoint = `\\\\.\\pipe\\handyboy-test-${randomUUID()}`;
    const owner = new WindowsPipeServer();
    const contender = new WindowsPipeServer();
    try {
      await owner.listen(endpoint, (socket) => socket.end());
      await expect(contender.listen(endpoint, (socket) => socket.end())).rejects.toThrow('failed to start');
    } finally {
      await contender.close();
      await owner.close();
    }
  });

  it('answers another client and shuts down while a client stops reading a large reply', async () => {
    const endpoint = `\\\\.\\pipe\\handyboy-test-${randomUUID()}`;
    const server = new WindowsPipeServer();
    let stalled: net.Socket | undefined;
    let healthy: net.Socket | undefined;
    let started!: () => void;
    const writing = new Promise<void>((resolve) => { started = resolve; });
    await server.listen(endpoint, (socket) => {
      socket.on('data', (data) => {
        if (data.toString().trim() === 'stall') {
          socket.write(Buffer.alloc(4 * 1024 * 1024, 'x'), () => started());
        } else socket.end('ready\n');
      });
    });
    try {
      stalled = net.connect(endpoint);
      stalled.on('error', () => {});
      stalled.pause();
      stalled.write('stall\n');
      await writing;
      const reply = await new Promise<string>((resolve, reject) => {
        healthy = net.connect(endpoint);
        let text = '';
        healthy.setTimeout(3000, () => healthy?.destroy(new Error('another client blocked status')));
        healthy.on('error', reject);
        healthy.on('data', (data) => { text += data; });
        healthy.on('end', () => resolve(text));
        healthy.write('status\n');
      });
      expect(reply).toBe('ready\n');
      await server.close();
    } finally {
      stalled?.destroy();
      healthy?.destroy();
      await server.close();
    }
  }, 15_000);

  it('restricts every pipe instance to the user and SYSTEM and carries status and run termination', async () => {
    const endpoint = `\\\\.\\pipe\\handyboy-test-${randomUUID()}`;
    const server = new TriggerServer({
      socketPath: endpoint, keyStatus: async () => ({ ready: false }), extensionConnected: () => true,
      hostVersion: 'fixture', send: (message) => {
        if (message.type === 'run.start') {
          server.publish(message.runId, { type: 'run.end', status: 'error', message: 'fixture timeout' });
        }
      },
    });
    try {
      await server.start();
      for (let i = 0; i < 3; i++) {
        const acl = await readWindowsAcl(endpoint, true);
        expect(acl.rules.filter((rule) => rule.allow).map((rule) => rule.sid).sort()).toEqual([acl.user, 'S-1-5-18'].sort());
      }
      const messages = await new Promise<string>((resolve, reject) => {
        const socket = net.connect(endpoint);
        let text = '';
        socket.setTimeout(5000, () => socket.destroy(new Error('run did not terminate')));
        socket.on('error', reject);
        socket.on('data', (data) => { text += data; });
        socket.on('end', () => resolve(text));
        socket.on('connect', () => socket.write(JSON.stringify({ op: 'run', prompt: 'fixture', runId: 'windows-fixture' }) + '\n'));
      });
      const records = messages.trim().split('\n').map((line) => JSON.parse(line));
      expect(records.map((record) => record.op)).toEqual(['accepted', 'event', 'end']);
      expect(records[1].event.message).toBe('fixture timeout');
    } finally {
      await server.close();
      resetLogForTests();
    }
    await expect(new Promise((resolve, reject) => {
      const socket = net.connect(endpoint);
      socket.once('error', reject);
      socket.once('connect', () => { socket.destroy(); resolve(true); });
    })).rejects.toThrow();
  });
});
