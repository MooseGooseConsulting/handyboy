import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { encodeFrame, FrameParser } from '../src/framing.ts';

it.skipIf(process.platform !== 'win32')('launches the real native host, reports missing credentials, and lets the actual CLI finish a fixture run', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'hb-native-'));
  const hostRoot = fileURLToPath(new URL('../', import.meta.url));
  // Do not consult the developer's Doppler session in an automated test.
  const env = { ...process.env, HB_HOME: dir, HANDYBOY_SOCK: '', HANDYBOY_DEV: '1',
    PATH: path.join(process.env.SystemRoot!, 'System32'), HANDYBOY_LOG_STDERR: '0' };
  const child = spawn(process.execPath, [path.join(hostRoot, 'src/main.ts')], { env, windowsHide: true });
  const exited = new Promise<void>((resolve) => child.once('close', () => resolve()));
  child.stderr.resume();
  const parser = new FrameParser();
  let ready!: () => void;
  let failed!: (error: Error) => void;
  const hello = new Promise<void>((resolve, reject) => { ready = resolve; failed = reject; });
  const timeout = setTimeout(() => failed(new Error('host hello timed out')), 10_000);
  child.once('error', failed);
  child.once('exit', () => failed(new Error('host exited before readiness')));
  child.stdout.on('data', (bytes) => {
    for (const record of parser.push(bytes)) {
      const message = record as { type: string; runId?: string };
      if (message.type === 'hello') { clearTimeout(timeout); ready(); }
      if (message.type === 'run.start') {
        child.stdin.write(encodeFrame({ type: 'runlog.append', runId: message.runId,
          event: { type: 'run.end', status: 'error', message: 'fixture completed' } }));
      }
    }
  });
  const exec = promisify(execFile);
  try {
    await hello;
    const status = await exec(process.execPath, [path.join(hostRoot, 'src/cli/nb-status.ts')], { env, windowsHide: true, timeout: 5000 })
      .catch((error: { code: number; stdout: string }) => {
        expect(error.code).toBe(1);
        return error;
      });
    const report = JSON.parse(status.stdout);
    expect(report.extensionConnected).toBe(true);
    expect(report.key.ready).toBe(false);
    expect(report.key.reason).toContain('doppler binary not found');
    const run = await exec(process.execPath, [path.join(hostRoot, 'src/cli/nb-run.ts'), 'fixture', '--run-id', 'windows-native'],
      { env, windowsHide: true, timeout: 5000 });
    expect(JSON.parse(run.stdout)).toMatchObject({ type: 'run.end', message: 'fixture completed' });
    const saved = await readFile(path.join(dir, 'Handyboy/runs/windows-native.jsonl'), 'utf8');
    expect(saved).toContain('fixture completed');
  } finally {
    clearTimeout(timeout);
    child.stdin.end();
    const kill = setTimeout(() => child.kill(), 5000);
    await exited;
    clearTimeout(kill);
    await rm(dir, { recursive: true, force: true });
  }
});
