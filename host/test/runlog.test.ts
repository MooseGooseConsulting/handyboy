import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { resetLogForTests } from '../src/log.ts';
import { makeHarness, type Harness } from './harness.ts';

let h: Harness | undefined;

afterEach(async () => {
  await h?.cleanup();
  h = undefined;
  resetLogForTests();
});

it('a run event carrying keys or a bearer token is redacted on disk and in the dev-socket mirror', async () => {
  // A Kilo key has no recognisable shape; it is only caught because the store
  // registered the literal value when it loaded it.
  const kiloKey = 'kilo-literal-0123456789abcdef';
  h = await makeHarness({ key: 'sk-or-v1-0000aaaa1111bbbb', kiloKey });
  const event = {
    type: 'tool.result',
    output: 'header was Authorization: Bearer abc.def-123 then more text',
    nested: { keys: ['sk-or-v1.aaaabbbbccccdddd.eeeeffff00001111', 'dp.st.dev.abcdefgh12345678', kiloKey] },
    count: 3,
  };

  await h.dispatcher.handle({ type: 'runlog.append', runId: 'run-redact', event });

  const lines = (await readFile(path.join(h.runsDir, 'run-redact.jsonl'), 'utf8')).trim().split('\n');
  expect(lines).toHaveLength(1);
  const onDisk = JSON.parse(lines[0]!);
  const mirrored = h.runEvents[0]?.event;
  const expected = {
    type: 'tool.result',
    output: 'header was Authorization: [redacted] then more text',
    nested: { keys: ['[redacted]', '[redacted]', '[redacted]'] },
    count: 3,
  };
  expect(onDisk).toEqual(expected);
  expect(mirrored).toEqual(expected);
  // The caller's object is theirs; redaction must not rewrite it in place.
  expect(event.nested.keys[2]).toBe(kiloKey);
});

it('a credential used as an object property name is redacted on disk and in the dev-socket mirror', async () => {
  h = await makeHarness({ key: 'sk-or-v1-0000aaaa1111bbbb', kiloKey: null });
  const event = {
    type: 'tool.result',
    output: { 'token sk-or-v1.aaaabbbbccccdddd.eeeeffff00001111 end': 'wrapped', plain: 'kept' },
  };

  await h.dispatcher.handle({ type: 'runlog.append', runId: 'run-redact-key', event });

  const lines = (await readFile(path.join(h.runsDir, 'run-redact-key.jsonl'), 'utf8')).trim().split('\n');
  const onDisk = JSON.parse(lines[0]!);
  const expected = {
    type: 'tool.result',
    output: { 'token [redacted] end': 'wrapped', plain: 'kept' },
  };
  expect(onDisk).toEqual(expected);
  expect(h.runEvents[0]?.event).toEqual(expected);
  // The caller's object is theirs; the key name must be untouched in place.
  expect(Object.keys(event.output)).toEqual(['token sk-or-v1.aaaabbbbccccdddd.eeeeffff00001111 end', 'plain']);
});

it('an own __proto__ property survives redaction instead of hitting the prototype setter', async () => {
  h = await makeHarness({ key: 'sk-or-v1-0000aaaa1111bbbb', kiloKey: null });
  // JSON.parse (not a literal) is how arbitrary tool output carries an own
  // __proto__ property into the event.
  const event = JSON.parse('{"type":"tool.result","output":{"__proto__":"polluted","keep":"yes"}}') as unknown;

  await h.dispatcher.handle({ type: 'runlog.append', runId: 'run-proto', event });

  const lines = (await readFile(path.join(h.runsDir, 'run-proto.jsonl'), 'utf8')).trim().split('\n');
  const onDisk = JSON.parse(lines[0]!) as Record<string, unknown>;
  // The field must persist as an own data property — assignment to "__proto__"
  // on a plain object would have silently dropped it from the serialized line.
  expect(Object.prototype.hasOwnProperty.call(onDisk.output, '__proto__')).toBe(true);
  expect((onDisk.output as Record<string, unknown>).__proto__).toBe('polluted');
  expect((onDisk.output as Record<string, unknown>).keep).toBe('yes');
  const mirrored = h.runEvents[0]?.event as { output: Record<string, unknown> };
  expect(Object.prototype.hasOwnProperty.call(mirrored.output, '__proto__')).toBe(true);
  expect(mirrored.output.__proto__).toBe('polluted');
});
