import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Without this, any test that logs appends to the developer's real host.log, which is the
// file `nb-logs` reads when a live run goes wrong. Tests that need their own tree still set NB_HOME.
// An empty NB_HOME counts as unset in paths.ts, so it must count as unset here too.
if (!process.env.NB_HOME) process.env.NB_HOME = mkdtempSync(path.join(tmpdir(), 'nb-test-home-'));
