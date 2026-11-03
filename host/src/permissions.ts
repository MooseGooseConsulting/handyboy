import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const exec = promisify(execFile);

/** Windows ignores chmod's Unix permission bits. Restrict the actual DACL instead. */
export function windowsPowerShell(): string {
  return path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

export function windowsPowerShellEnv(): NodeJS.ProcessEnv {
  // PowerShell 7's inherited module path can make Windows PowerShell load
  // incompatible editions of its own built-in modules.
  return { ...process.env, PSModulePath: path.join(path.dirname(windowsPowerShell()), 'Modules') };
}

export async function protectWindowsPath(target: string, kind: 'directory'): Promise<void> {
  if (process.platform !== 'win32') return;
  const script = fileURLToPath(new URL('../windows/private-acl.ps1', import.meta.url));
  await exec(windowsPowerShell(), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-Target', target, '-Kind', kind],
    { windowsHide: true, timeout: 15_000, env: windowsPowerShellEnv() });
}
