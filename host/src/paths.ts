import { homedir } from 'node:os';
import path from 'node:path';

/**
 * `HB_HOME` overrides the home directory root for every path below. It exists so
 * install.sh and the tests can write into a temp tree instead of the real profile.
 */
export function home(): string {
  return process.env.HB_HOME || homedir();
}

export function dataDir(): string {
  const xdg = process.env.HB_HOME ? undefined : process.env.XDG_DATA_HOME;
  return path.join(xdg || path.join(home(), '.local', 'share'), 'handyboy');
}

export function runsDir(): string {
  return path.join(dataDir(), 'runs');
}

export function hostLogPath(): string {
  return path.join(dataDir(), 'host.log');
}

/** Extension-side diagnostics forwarded over `log.append`, one JSON object per line. */
export function extLogPath(): string {
  return path.join(dataDir(), 'ext.log');
}

export function socketPath(): string {
  const runtime = process.env.XDG_RUNTIME_DIR || path.join(dataDir(), 'run');
  return process.env.HANDYBOY_SOCK || path.join(runtime, 'handyboy.sock');
}

/** `save_file`'s host-side output, one subdirectory per run: `<dir>/<runId>/<filename>`. */
export function artifactsDir(): string {
  return path.join(dataDir(), 'artifacts');
}
