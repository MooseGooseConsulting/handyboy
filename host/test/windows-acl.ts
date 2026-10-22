import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { windowsPowerShell, windowsPowerShellEnv } from '../src/permissions.ts';

export async function readWindowsAcl(target: string, pipe = false): Promise<{ user: string; rules: Array<{ sid: string; allow: boolean }> }> {
  const { stdout } = await promisify(execFile)(windowsPowerShell(), ['-NoProfile', '-NonInteractive', '-File',
    fileURLToPath(new URL('./windows-acl.ps1', import.meta.url)), '-Target', target, ...(pipe ? ['-Pipe'] : [])], { windowsHide: true, env: windowsPowerShellEnv() });
  return JSON.parse(stdout);
}
