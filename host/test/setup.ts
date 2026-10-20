import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Without this, any test that logs appends to the developer's real host.log, which is the
// file `hb-logs` reads when a live run goes wrong. Tests that need their own tree still set HB_HOME.
// An empty HB_HOME counts as unset in paths.ts, so it must count as unset here too.
if (!process.env.HB_HOME) process.env.HB_HOME = mkdtempSync(path.join(tmpdir(), 'nb-test-home-'));
