import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

// The dev-loop scripts run against a throwaway copy of the repo layout: stub host CLIs,
// a stub wxt, and a fake Chrome config dir. Nothing here touches the real Chrome or host.

const REPO = fileURLToPath(new URL('..', import.meta.url));
const CLEAN_MANIFEST = '{"manifest_version":3,"name":"Handyboy"}';
const roots: string[] = [];

afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function write(file: string, text: string, mode?: number): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
  if (mode !== undefined) chmodSync(file, mode);
}

/** Same derivation as scripts/registrations.sh and host/install.sh. */
function extId(): string {
  const key = /'(MII[A-Za-z0-9+/=]+)'/.exec(readFileSync(path.join(REPO, 'wxt.config.ts'), 'utf8'))![1]!;
  const hex = createHash('sha256').update(Buffer.from(key, 'base64')).digest('hex').slice(0, 32);
  return [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
}

function makeRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'hb-dev-loop-'));
  roots.push(root);
  for (const f of ['scripts/e2e.sh', 'scripts/registrations.sh', 'scripts/check-invariants.sh', 'wxt.config.ts']) {
    mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
    copyFileSync(path.join(REPO, f), path.join(root, f));
  }
  // What the source scans cover, all clean.
  for (const f of ['entrypoints/injected-content.ts', 'entrypoints/background.ts', 'src/page/handler.ts', 'src/userscripts/run.ts']) {
    write(path.join(root, f), 'export const ok = 1;\n');
  }
  const record = (name: string): string => `echo ${name} >>"$(dirname "$0")/../../calls"\n`;
  write(
    path.join(root, 'node_modules/.bin/wxt'),
    `#!/bin/sh\n${record('wxt')}m="\${FAKE_MANIFEST:-}"\n[ -n "$m" ] || m='${CLEAN_MANIFEST}'\n` +
      `mkdir -p .output/chrome-mv3\nprintf '%s' "$m" >.output/chrome-mv3/manifest.json\n`,
    0o755,
  );
  // What a mise shim with no version set does.
  write(path.join(root, 'bin/pnpm'), '#!/bin/sh\necho "mise ERROR No version is set for shim: pnpm" >&2\nexit 1\n', 0o755);
  const hb = (name: string, body: string): void =>
    write(path.join(root, 'host/bin', name), `#!/bin/sh\n${record(name)}${body}\n`, 0o755);
  hb('hb-reload', 'echo "reloaded: new host pid 2"');
  hb('hb-status', 'echo \'{"op":"status"}\'');
  hb('hb-cancel', ':');
  hb(
    'hb-run',
    `echo '{"kind":"tool.call","call":{"name":"done","args":{"summary":"ok"}}}'\necho '{"kind":"run.ended","status":"done"}'`,
  );
  hb('hb-logs', 'exit "${FAKE_HB_LOGS_RC:-0}"');
  return root;
}

/** Registers Handyboy in a fake Chrome profile, as "Load unpacked" from `dir` would. */
function register(root: string, profile: string, dir: string): void {
  const prefs = { extensions: { settings: { [extId()]: { path: dir, user_scripts_enabled: true } } } };
  write(path.join(root, 'chrome', profile, 'Preferences'), JSON.stringify(prefs));
}

function run(root: string, script: string, args: string[] = [], env: Record<string, string> = {}) {
  const r = spawnSync('bash', [path.join(root, 'scripts', script), ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${path.join(root, 'bin')}:${process.env.PATH}`,
      HOME: root,
      HB_LIVE_CHROME_DIR: path.join(root, 'chrome'),
      ...env,
    },
  });
  const calls = existsSync(path.join(root, 'calls')) ? readFileSync(path.join(root, 'calls'), 'utf8').split('\n') : [];
  return { code: r.status, out: `${r.stdout}${r.stderr}`, calls };
}

const E2E_ARGS = ['--prompt', 'a custom task'];

describe('scripts/e2e.sh', () => {
  it('builds with the project wxt when pnpm is a shim with no version set, then reloads and passes', () => {
    const root = makeRoot();
    register(root, 'Default', path.join(root, '.output/chrome-mv3'));
    const r = run(root, 'e2e.sh', E2E_ARGS);
    expect(r.out).not.toContain('build failed');
    expect(r.calls).toContain('wxt');
    expect(r.calls).toContain('hb-reload');
    expect(r.code).toBe(0);
  });

  it('refuses to reload when a Chrome profile loads Handyboy from a directory holding another build', () => {
    const root = makeRoot();
    const elsewhere = path.join(root, 'other-checkout/.output/chrome-mv3');
    write(path.join(elsewhere, 'manifest.json'), '{"manifest_version":3,"name":"Handyboy","stale":true}');
    register(root, 'Default', path.join(root, '.output/chrome-mv3'));
    register(root, 'Profile 1', elsewhere);
    const r = run(root, 'e2e.sh', E2E_ARGS);
    expect(r.code).toBe(1);
    expect(r.out).toContain(`"Profile 1": ${elsewhere}`);
    expect(r.calls).not.toContain('hb-reload');
    expect(r.calls).not.toContain('hb-run');
  });

  it('refuses to reload when no Chrome profile shows where Handyboy is loaded from', () => {
    const root = makeRoot();
    const r = run(root, 'e2e.sh', E2E_ARGS);
    expect(r.code).toBe(1);
    expect(r.out).toContain('no Chrome profile');
    expect(r.calls).not.toContain('hb-reload');
  });

  it('reloads a registration elsewhere when that directory holds an exact copy of this build', () => {
    const root = makeRoot();
    const copy = path.join(root, 'main-checkout/.output/chrome-mv3');
    write(path.join(copy, 'manifest.json'), CLEAN_MANIFEST);
    register(root, 'Default', copy);
    const r = run(root, 'e2e.sh', E2E_ARGS);
    expect(r.calls).toContain('hb-reload');
    expect(r.code).toBe(0);
  });

  it('notes, but does not fail on, a profile registered from a deleted worktree, since it loads no build', () => {
    const root = makeRoot();
    const gone = path.join(root, 'deleted-worktree/.output/chrome-mv3');
    register(root, 'Default', path.join(root, '.output/chrome-mv3'));
    register(root, 'Profile 2', gone);
    const r = run(root, 'e2e.sh', E2E_ARGS);
    expect(r.out).toContain(`"Profile 2" registers Handyboy from ${gone}, which holds no build`);
    expect(r.calls).toContain('hb-reload');
    expect(r.code).toBe(0);
  });

  it('notes, but does not fail on, a profile whose Preferences cannot be parsed, since that is not "unregistered"', () => {
    const root = makeRoot();
    register(root, 'Default', path.join(root, '.output/chrome-mv3'));
    const prefs = path.join(root, 'chrome', 'Profile 3', 'Preferences');
    write(prefs, '{not json');
    const r = run(root, 'e2e.sh', E2E_ARGS);
    expect(r.out).toContain(`${prefs} is unreadable or malformed; that profile's build was not checked`);
    expect(r.calls).toContain('hb-reload');
    expect(r.code).toBe(0);
  });

  it('fails closed when a registration exists but is not an object, since a partial list must not pass for complete', () => {
    const root = makeRoot();
    register(root, 'Default', path.join(root, '.output/chrome-mv3'));
    // Sorts after Default: its line is on stdout before the malformed one crashes the scan.
    const prefs = path.join(root, 'chrome', 'Profile 4', 'Preferences');
    write(prefs, JSON.stringify({ extensions: { settings: { [extId()]: 'bogus' } } }));
    const r = run(root, 'e2e.sh', E2E_ARGS);
    expect(r.out).toContain(`${prefs} has a malformed Handyboy registration; that profile's build was not checked`);
    expect(r.calls).not.toContain('hb-reload');
    expect(r.code).toBe(1);
  });

  it('fails closed when a profile runs Handyboy packaged, since a reload would run Chrome\'s copy, not this build', () => {
    const root = makeRoot();
    register(root, 'Default', path.join(root, '.output/chrome-mv3'));
    // A packaged install (crx or Web Store) has no unpacked path in Preferences.
    const prefs = path.join(root, 'chrome', 'Profile 5', 'Preferences');
    write(prefs, JSON.stringify({ extensions: { settings: { [extId()]: { user_scripts_enabled: true } } } }));
    const r = run(root, 'e2e.sh', E2E_ARGS);
    expect(r.out).toContain('"Profile 5" runs Handyboy packaged, not from an unpacked directory');
    expect(r.calls).not.toContain('hb-reload');
    expect(r.code).toBe(1);
  });

  it('fails the run when hb-logs cannot read the extension log, since errors would go unseen', () => {
    const root = makeRoot();
    register(root, 'Default', path.join(root, '.output/chrome-mv3'));
    const r = run(root, 'e2e.sh', E2E_ARGS, { FAKE_HB_LOGS_RC: '2' });
    expect(r.calls).toContain('hb-logs');
    expect(r.out).toContain('hb-logs exited 2');
    expect(r.code).toBe(1);
  });
});

describe('scripts/check-invariants.sh', () => {
  it('passes a clean tree, so the failures below are about the one thing each changes', () => {
    const r = run(makeRoot(), 'check-invariants.sh');
    expect(r.out).toContain('stealth invariants: all clear');
    expect(r.code).toBe(0);
  });

  it('checks a fresh build rather than a stale .output left by older code', () => {
    const root = makeRoot();
    write(path.join(root, '.output/chrome-mv3/manifest.json'), CLEAN_MANIFEST);
    const r = run(root, 'check-invariants.sh', [], {
      FAKE_MANIFEST: '{"manifest_version":3,"web_accessible_resources":[]}',
    });
    expect(r.calls).toContain('wxt');
    expect(r.out).toContain('INVARIANT FAILED: manifest declares web_accessible_resources');
    expect(r.code).toBe(1);
  });

  it.each(['entrypoints', 'src', 'scripts', 'src/page', 'src/userscripts', 'entrypoints/injected-content.ts'])(
    'fails instead of passing silently when the scanned path %s has moved',
    (moved) => {
      const root = makeRoot();
      // The script itself lives in scripts/, so only what it scans there can go.
      if (moved === 'scripts') {
        mkdirSync(path.join(root, 'tools'));
        for (const f of ['check-invariants.sh', 'registrations.sh', 'e2e.sh']) {
          copyFileSync(path.join(root, 'scripts', f), path.join(root, 'tools', f));
        }
        rmSync(path.join(root, 'scripts'), { recursive: true });
        const r = run(root, '../tools/check-invariants.sh');
        expect(r.out).toContain('scanned path scripts does not exist');
        expect(r.code).toBe(1);
        return;
      }
      rmSync(path.join(root, moved), { recursive: true });
      const r = run(root, 'check-invariants.sh');
      expect(r.out).toContain(`scanned path ${moved} does not exist`);
      expect(r.code).toBe(1);
    },
  );
});
