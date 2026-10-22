import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ArtifactError, MAX_ARTIFACT_BYTES, saveArtifact } from '../src/artifacts.ts';
import { RunLogError } from '../src/runlog.ts';
import { readWindowsAcl } from './windows-acl.ts';

let dir: string | undefined;

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

describe('artifacts', () => {
  it('writes a private file under the run id using platform permissions and refuses path traversal', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'hb-art-'));
    const saved = await saveArtifact('run-1', 'report.json', '{"ok":true}', dir);
    expect(saved.path).toBe(path.join(dir, 'run-1', 'report.json'));
    expect(saved.bytes).toBe(Buffer.byteLength('{"ok":true}', 'utf8'));
    expect(await readFile(saved.path, 'utf8')).toBe('{"ok":true}');
    if (process.platform === 'win32') {
      const acl = await readWindowsAcl(saved.path);
      expect(acl.rules.filter((rule) => rule.allow).map((rule) => rule.sid).sort()).toEqual([acl.user, 'S-1-5-18'].sort());
    } else {
      expect((await stat(saved.path)).mode & 0o777).toBe(0o600);
    }

    await expect(saveArtifact('run-1', '../escape.json', 'x', dir)).rejects.toThrow(ArtifactError);
    await expect(saveArtifact('../run', 'report.json', 'x', dir)).rejects.toThrow(RunLogError);
  });

  it('rejects content over the 8 MiB cap before creating a file', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'hb-art-'));
    const huge = 'x'.repeat(MAX_ARTIFACT_BYTES + 1);
    await expect(saveArtifact('run-1', 'big.txt', huge, dir)).rejects.toThrow(/exceeds/);
  });
});
