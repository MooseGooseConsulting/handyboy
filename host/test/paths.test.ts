import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { dataDir, socketPath } from '../src/paths.ts';

const touched = ['HB_HOME', 'XDG_DATA_HOME', 'XDG_RUNTIME_DIR', 'HANDYBOY_SOCK', 'LOCALAPPDATA'] as const;
const previous = new Map<string, string | undefined>();

function setEnv(name: (typeof touched)[number], value: string | undefined): void {
  if (!previous.has(name)) previous.set(name, process.env[name]);
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

afterEach(() => {
  for (const name of touched) {
    if (!previous.has(name)) continue;
    const value = previous.get(name);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  previous.clear();
});

describe('host paths', () => {
  it('HB_HOME ignores XDG_DATA_HOME, and HANDYBOY_SOCK wins over the runtime dir', () => {
    setEnv('HB_HOME', '/tmp/hb-root');
    setEnv('XDG_DATA_HOME', '/tmp/xdg-data');
    setEnv('XDG_RUNTIME_DIR', '/tmp/xdg-run');
    setEnv('HANDYBOY_SOCK', undefined);
    if (process.platform === 'win32') {
      expect(dataDir()).toBe(path.join('/tmp/hb-root', 'Handyboy'));
      expect(socketPath()).toMatch(/^\\\\\.\\pipe\\handyboy-[a-f0-9]{24}$/);
      const first = socketPath();
      setEnv('HB_HOME', '/tmp/another-profile');
      expect(socketPath()).not.toBe(first);
    } else {
      expect(dataDir()).toBe(path.join('/tmp/hb-root', '.local', 'share', 'handyboy'));
      expect(socketPath()).toBe(path.join('/tmp/xdg-run', 'handyboy.sock'));
    }

    setEnv('HANDYBOY_SOCK', '/tmp/explicit.sock');
    expect(socketPath()).toBe('/tmp/explicit.sock');
  });

  it('without HB_HOME the data dir follows the platform data directory', () => {
    setEnv('HB_HOME', undefined);
    setEnv('XDG_DATA_HOME', '/tmp/xdg-data');
    setEnv('LOCALAPPDATA', 'C:\\fixture-local');
    expect(dataDir()).toBe(process.platform === 'win32'
      ? path.join('C:\\fixture-local', 'Handyboy') : path.join('/tmp/xdg-data', 'handyboy'));
  });
});
