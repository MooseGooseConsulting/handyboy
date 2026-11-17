import { describe, expect, it } from 'vitest';
import { protectSecret, redact } from '../src/log.ts';

describe('host log redaction', () => {
  it('a registered secret that is not an sk-or key is still removed from the line', () => {
    const secret = 'warehouse-token-91';
    protectSecret(secret);
    const line = redact(`upstream said ${secret} and sk-or-v1.aaaabbbbccccdddd.eeeeffff00001111`);
    expect(line.includes(secret)).toBe(false);
    expect(line.includes('aaaabbbbccccdddd')).toBe(false);
    expect(line).toBe('upstream said [redacted] and [redacted]');
  });
});
