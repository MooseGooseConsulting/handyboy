#!/usr/bin/env node
/**
 * hb-cancel <runId>
 *
 * Stops a run started via `hb-run`. Without this there was no way to cancel a
 * CLI-triggered run short of `hb-reload`, which tears down the whole extension/host
 * and kills every in-flight run, not just the one you want to stop -- and killing the
 * `hb-run` client itself (Ctrl+C, a dead terminal) did nothing at all: the run kept
 * executing against the real browser, unattended, for as long as its step budget allowed.
 */
import { connect, onResponses, send } from './socket-client.ts';

const runId = process.argv[2];
if (!runId) {
  process.stderr.write('usage: hb-cancel <runId>\n');
  process.exit(2);
}

const sock = await connect();
onResponses(sock, (msg) => {
  if (msg.op === 'cancelled') {
    process.stdout.write(`cancelled ${msg.runId}\n`);
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

send(sock, { op: 'cancel', runId });
