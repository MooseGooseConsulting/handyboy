#!/usr/bin/env node
/**
 * hb-run "<prompt>" [--url <url>] [--run-id <id>] [--option k=v]...
 *
 * Sends a run to the extension through the host's dev unix socket and streams the
 * run-log events back until run.end.
 */
import { parseRunOptions } from './options.ts';
import { connect, onResponses, send } from './socket-client.ts';

const argv = process.argv.slice(2);
const prompt = argv.find((a) => !a.startsWith('--'));
if (!prompt) {
  process.stderr.write('usage: hb-run "<prompt>" [--url <url>] [--run-id <id>] [--option k=v]...\n');
  process.exit(2);
}

function flag(name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

const options = parseRunOptions(argv);

const sock = await connect();
onResponses(sock, (msg) => {
  if (msg.op === 'accepted') {
    process.stderr.write(`runId=${msg.runId}\n`);
    return;
  }
  if (msg.op === 'event') {
    process.stdout.write(JSON.stringify(msg.event) + '\n');
    return;
  }
  if (msg.op === 'end') {
    sock.end();
    process.exit(0);
  }
  if (msg.op === 'error') {
    process.stderr.write(`error: ${msg.message}\n`);
    sock.end();
    process.exit(1);
  }
});
sock.on('close', () => process.exit(1));

send(sock, {
  op: 'run',
  prompt,
  ...(flag('url') ? { url: flag('url')! } : {}),
  ...(flag('run-id') ? { runId: flag('run-id')! } : {}),
  ...(Object.keys(options).length ? { options } : {}),
});
