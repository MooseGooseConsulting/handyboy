import { describe, expect, it } from 'vitest';
import type { RunEvent } from '@/src/messaging';
import { initialRunLogState, runLogReducer, runPhase, toEntries } from './runlog';

const call = (callId: string, at: number): RunEvent => ({
  kind: 'tool.call',
  role: 'follower',
  call: { callId, name: 'click', args: { ref: 'e1' } },
  at,
});

const result = (callId: string, at: number): RunEvent => ({
  kind: 'tool.result',
  role: 'follower',
  result: { callId, name: 'click', ok: true, summary: 'clicked', durationMs: 4 },
  at,
});

describe('run log reducer', () => {
  it('a replay of the same tool call does not add a second row', () => {
    const once = runLogReducer(initialRunLogState, { type: 'event', runId: 'run-1', event: call('c1', 1) });
    const twice = runLogReducer(once, { type: 'event', runId: 'run-1', event: call('c1', 99) });
    expect(twice.events).toHaveLength(1);
    expect(twice.events[0]).toMatchObject({ at: 1 });
  });

  it('an event from a different run replaces the log instead of interleaving it', () => {
    const first = runLogReducer(initialRunLogState, { type: 'event', runId: 'run-1', event: call('c1', 1) });
    const next = runLogReducer(first, { type: 'event', runId: 'run-2', event: call('c2', 2) });
    expect(next.runId).toBe('run-2');
    expect(next.events).toHaveLength(1);
    expect(next.events[0]).toMatchObject({ call: { callId: 'c2' } });
  });

  it('a tool result pairs with its call, and a result with no call is still shown', () => {
    const entries = toEntries([call('c1', 1), result('c1', 2), result('c9', 3)]);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ kind: 'tool', callId: 'c1' });
    expect(entries[1]).toMatchObject({ kind: 'tool', callId: 'c9' });
  });

  it('pause then end is ended, and a run id with no events is still running', () => {
    const started = runLogReducer(initialRunLogState, {
      type: 'event',
      runId: 'run-1',
      event: {
        kind: 'run.started',
        runId: 'run-1',
        prompt: 'go',
        config: {
          leaderModel: 'l',
          followerModel: 'f',
          observe: 'dom',
          planningInterval: 5,
          maxSteps: 10,
          inputFidelity: 'in-page',
        },
        tabId: 1,
        url: 'https://shop.example/',
        at: 1,
      },
    });
    const paused = runLogReducer(started, {
      type: 'event',
      runId: 'run-1',
      event: { kind: 'run.paused', at: 2 },
    });
    expect(runPhase(paused)).toBe('paused');
    const ended = runLogReducer(paused, {
      type: 'event',
      runId: 'run-1',
      event: { kind: 'run.ended', status: 'done', message: 'ok', steps: 1, at: 3 },
    });
    expect(runPhase(ended)).toBe('ended');
    expect(runPhase({ runId: 'run-9', events: [], keys: [] })).toBe('running');
  });
});
