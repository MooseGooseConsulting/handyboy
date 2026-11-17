import { expect, it } from 'vitest';
import { redactEvent, redactText } from './redact';

/**
 * Hand-built fixture. The two hex segments are what a regex that stops at `.`
 * would leave behind after stripping only `sk-or-v1`.
 */
const KEY = 'sk-or-v1.a1b2c3d4e5f60718.89abcdef01234567';
const HEAD = 'a1b2c3d4e5f60718';
const TAIL = '89abcdef01234567';

function assertDottedKeyGone(output: string): void {
  expect(output.includes(KEY), 'dotted OpenRouter key survived extension log redaction').toBe(false);
  expect(output.includes(HEAD), 'left half of a dotted OpenRouter key survived extension log redaction').toBe(false);
  expect(output.includes(TAIL), 'right half of a dotted OpenRouter key survived extension log redaction').toBe(false);
}

it('a dotted OpenRouter key sk-or-v1.<hex>.<hex> does not survive extension log redaction', () => {
  const line = redactText(`model call failed key=${KEY} status=401`);
  assertDottedKeyGone(line);
  expect(line).toBe('model call failed key=[redacted] status=401');

  const args = { text: `note ${KEY} done` };
  const redacted = redactEvent({
    kind: 'tool.call',
    role: 'follower',
    call: { callId: 'call-1', name: 'remember', args },
    at: 1_720_000_000_000,
  });
  assertDottedKeyGone(JSON.stringify(redacted));
  expect(args.text.includes(KEY), 'redactEvent mutated the event it was given').toBe(true);
  expect(redacted).toEqual({
    kind: 'tool.call',
    role: 'follower',
    call: { callId: 'call-1', name: 'remember', args: { text: 'note [redacted] done' } },
    at: 1_720_000_000_000,
  });
});

it('a bearer token, a Doppler token, and a screenshot data URL do not survive redaction', () => {
  const bearer = 'Bearer sk-live-secret-token';
  const doppler = 'dp.ct.abcdef0123456789';
  const png = 'data:image/png;base64,aaaa';
  const line = redactText(`auth=${bearer} doppler=${doppler} shot=${png} tail`);
  expect(line.includes(bearer)).toBe(false);
  expect(line.includes('sk-live-secret-token')).toBe(false);
  expect(line.includes(doppler)).toBe(false);
  expect(line.includes(png)).toBe(false);
  expect(line).toBe('auth=[redacted] doppler=[redacted] shot=[screenshot omitted] tail');
});
