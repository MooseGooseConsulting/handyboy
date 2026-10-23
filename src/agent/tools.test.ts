import { describe, expect, it } from 'vitest';
import { FakePageTools, createPageToolset, summarize, toolResultText, validateSaveFilename } from './tools';

describe('save_file filenames', () => {
  it('rejects a path, a dotfile, a missing extension, and a name over 100 characters', () => {
    expect(validateSaveFilename('dir/out.json')).toBe('filename must not contain a path separator');
    expect(validateSaveFilename('..secret.json')).toBe('filename must not contain ".."');
    expect(validateSaveFilename('.env.json')).toBe('filename must not start with a dot');
    expect(validateSaveFilename('notes.md')).toBe('filename must end in .json, .txt, or .csv');
    expect(validateSaveFilename(`${'a'.repeat(97)}.json`)).toBe('filename must be at most 100 characters');
    expect(validateSaveFilename('report.CSV')).toBeUndefined();
  });
});

describe('tool result text', () => {
  it('summarize cuts the log line at 240 characters, and the model text keeps the truncation count', () => {
    const long = 'x'.repeat(300);
    expect(summarize(long)).toBe(`${'x'.repeat(239)}…`);
    expect(summarize(long).length).toBe(240);

    const cut = toolResultText('abcdefghij', 4);
    expect(cut).toBe('abcd\n[tool result truncated at 4 of 10 characters]');
    expect(toolResultText('abcd', 4)).toBe('abcd');
  });
});

describe('read-only toolset', () => {
  it('omits click and the other acting tools, and still binds snapshot', () => {
    const page = new FakePageTools();
    const tools = createPageToolset(page, { readOnly: true });
    const names = tools.all.map((tool) => tool.name);
    expect(names).not.toContain('click');
    expect(names).not.toContain('type');
    expect(names).not.toContain('write_userscript');
    expect(names).not.toContain('delete_userscript');
    expect(names).toContain('snapshot');
    expect(names).toContain('save_file');
  });

  it('rejects a wait longer than 15000ms and accepts the boundary values', () => {
    const wait = createPageToolset(new FakePageTools()).byName.get('wait');
    expect(wait).toBeDefined();
    const schema = wait!.schema as { safeParse(input: unknown): { success: boolean } };
    expect(schema.safeParse({ ms: 15001 }).success).toBe(false);
    expect(schema.safeParse({ ms: -1 }).success).toBe(false);
    expect(schema.safeParse({ ms: 1.5 }).success).toBe(false);
    expect(schema.safeParse({ ms: 0 }).success).toBe(true);
    expect(schema.safeParse({ ms: 15000 }).success).toBe(true);
  });
});
