/**
 * `--option k=v` pairs for nb-run. `true` and `false` become booleans because the worker
 * only honours a boolean `readOnly`: as a string it was silently ignored, and the stored
 * panel toggle won. Everything else stays a string; the worker parses numbers itself.
 */
export function parseRunOptions(argv: readonly string[]): Record<string, unknown> {
  const options: Record<string, unknown> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== '--option') continue;
    const kv = argv[i + 1] ?? '';
    const eq = kv.indexOf('=');
    if (eq <= 0) continue;
    const value = kv.slice(eq + 1);
    options[kv.slice(0, eq)] = value === 'true' ? true : value === 'false' ? false : value;
  }
  return options;
}
