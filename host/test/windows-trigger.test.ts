import { randomUUID } from 'node:crypto';
import net from 'node:net';
import { describe, expect, it } from 'vitest';
import { TriggerServer } from '../src/trigger.ts';
import { readWindowsAcl } from './windows-acl.ts';
import { resetLogForTests } from '../src/log.ts';

describe.skipIf(process.platform !== 'win32')('Windows named-pipe control', () => {
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
