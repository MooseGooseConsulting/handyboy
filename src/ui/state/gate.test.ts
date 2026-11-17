import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, type Config } from '@/src/storage';
import { configGate, readinessGate, runGate } from './gate';

function config(over: Partial<Config> = {}): Config {
  return {
    ...DEFAULT_CONFIG,
    leaderModel: 'leader',
    followerModel: 'follower',
    ...over,
  };
}

describe('run gate', () => {
  it('refuses a run when the planning interval is NaN, 0, or 101', () => {
    expect(configGate(config({ planningInterval: Number.NaN })).ok).toBe(false);
    expect(configGate(config({ planningInterval: 0 })).reason).toBe('Planning interval must be 1–100.');
    expect(configGate(config({ planningInterval: 101 })).ok).toBe(false);
    expect(configGate(config({ planningInterval: 1 })).ok).toBe(true);
    expect(configGate(config({ planningInterval: 100 })).ok).toBe(true);
  });

  it('refuses a run when max steps is outside 1–1000, including a fractional value', () => {
    expect(configGate(config({ maxSteps: 0 })).reason).toBe('Max steps must be 1–1000.');
    expect(configGate(config({ maxSteps: 1001 })).ok).toBe(false);
    expect(configGate(config({ maxSteps: 2.5 })).ok).toBe(false);
    expect(configGate(config({ maxSteps: 1000 })).ok).toBe(true);
  });

  it('a missing leader blocks before cadence, and a failed key blocks before the config', () => {
    expect(configGate(config({ leaderModel: '' })).reason).toBe('Pick a Leader model.');
    const readiness = { hostConnected: true, keyReady: false, reason: 'no key in the store' };
    expect(runGate(readiness, 'ready', config()).reason).toBe('no key in the store');
    expect(readinessGate({ hostConnected: false, keyReady: false }, 'ready').ok).toBe(false);
    expect(runGate({ hostConnected: true, keyReady: true }, 'ready', config()).ok).toBe(true);
  });
});
