import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { windowsPowerShell, windowsPowerShellEnv } from '../src/permissions.ts';

it.skipIf(process.platform !== 'win32')('registers the pinned extension and an absolute quiet launcher in a disposable registry key', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'hb install '));
  const key = `HKCU:\\Software\\Handyboy\\InstallerTests\\${randomUUID()}`;
  const exec = promisify(execFile);
  const options = { windowsHide: true, env: windowsPowerShellEnv() };
  try {
    await exec(windowsPowerShell(), ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
      fileURLToPath(new URL('../install.ps1', import.meta.url)), '-Dev', '-InstallDirectory', dir, '-RegistryPath', key], options);
    const manifest = JSON.parse(await readFile(path.join(dir, 'com.handyboy.host.json'), 'utf8'));
    expect(manifest.name).toBe('com.handyboy.host');
    expect(manifest.allowed_origins).toHaveLength(1);
    expect(manifest.allowed_origins[0]).toMatch(/^chrome-extension:\/\/[a-p]{32}\/$/);
    // CI's TEMP can use an 8.3 alias; PowerShell expands it to the long path.
    expect(path.isAbsolute(manifest.path)).toBe(true);
    expect(await realpath(manifest.path)).toBe(await realpath(path.join(dir, 'handyboy-host.cmd')));
    const launcher = await readFile(manifest.path, 'utf8');
    expect(launcher).toContain('@echo off\r\n');
    expect(launcher).toContain('HANDYBOY_DEV=1');
    expect(launcher).toContain('src\\main.ts');
    const registration = await exec(windowsPowerShell(), ['-NoProfile', '-Command',
      `(Get-Item -LiteralPath '${key}').GetValue('')`], options);
    expect(await realpath(registration.stdout.trim())).toBe(await realpath(path.join(dir, 'com.handyboy.host.json')));
  } finally {
    await exec(windowsPowerShell(), ['-NoProfile', '-Command', `Remove-Item -LiteralPath '${key}' -Recurse -Force -ErrorAction SilentlyContinue`], options);
    await rm(dir, { recursive: true, force: true });
  }
});
