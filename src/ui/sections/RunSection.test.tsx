// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import type { Readiness, RunEvent } from '@/src/messaging';
import type { Config } from '@/src/storage';
import type { RunLogState } from '../state/runlog';
import { RunSection } from './RunSection';

afterEach(cleanup);

const hostReady: Readiness = { hostConnected: true, keyReady: true };

/** A complete panel config so the run gate can open. Values are fixtures, not defaults copied from storage. */
const panelConfig: Config = {
  leaderModel: 'atlas-planner',
  followerModel: 'atlas-runner',
  observe: 'dom',
  planningInterval: 4,
  maxSteps: 20,
  inputFidelity: 'in-page',
};

function moving(events: RunEvent[]): RunLogState {
  return { runId: 'run-17', events, keys: [] };
}

function started(at: number): RunEvent {
  return {
    kind: 'run.started',
    runId: 'run-17',
    prompt: 'Book a table for two at 7',
    config: panelConfig,
    tabId: 3,
    url: 'https://example.test/reserve',
    at,
  };
}

function renderRun(log: RunLogState, onStart: (prompt: string) => void = () => undefined) {
  return render(
    <RunSection
      config={panelConfig}
      readiness={hostReady}
      readinessStatus="ready"
      log={log}
      onStart={onStart}
      onPause={() => undefined}
      onResume={() => undefined}
      onAbort={() => undefined}
    />,
  );
}

describe('RunSection', () => {
  it('dropping the typed objective on start would send a different task than the user wrote', async () => {
    const user = userEvent.setup();
    const startedWith: string[] = [];
    renderRun({ events: [], keys: [] }, (prompt) => {
      startedWith.push(prompt);
    });

    await user.type(screen.getByRole('textbox', { name: 'Objective' }), 'Book a table for two at 7');
    await user.click(screen.getByRole('button', { name: 'Run' }));

    expect(startedWith).toEqual(['Book a table for two at 7']);
  });

  it('hiding a tool call while the run is moving would leave its name and outcome off the log', async () => {
    const user = userEvent.setup();
    const at = 1_700_000_000_000;
    renderRun(
      moving([
        started(at),
        { kind: 'step', n: 1, role: 'follower', at: at + 500 },
        {
          kind: 'tool.call',
          role: 'follower',
          call: { callId: 'call-9', name: 'click_reserve', args: { name: 'Reserve' } },
          at: at + 800,
        },
        {
          kind: 'tool.result',
          role: 'follower',
          result: {
            callId: 'call-9',
            name: 'click_reserve',
            ok: true,
            summary: 'Clicked Reserve and the form submitted',
            durationMs: 240,
          },
          at: at + 1_040,
        },
      ]),
    );

    expect(screen.getByText('Running')).toBeTruthy();
    const call = screen.getByRole('button', { name: /click_reserve/ });
    expect(call.textContent).toContain('click_reserve');
    expect(call.textContent).toContain('ok');

    await user.click(call);

    expect(screen.getByText('Clicked Reserve and the form submitted')).toBeTruthy();
    expect(screen.getByText('Running')).toBeTruthy();
  });

  it('dropping a Leader to Follower handoff would leave that transfer out of the moving log', () => {
    const at = 1_700_000_000_000;
    renderRun(
      moving([
        started(at),
        {
          kind: 'handoff',
          from: 'leader',
          to: 'follower',
          reason: 'Plan is set; the follower takes the page',
          at: at + 400,
        },
      ]),
    );

    expect(screen.getByText('Running')).toBeTruthy();
    expect(screen.getByText('Handoff')).toBeTruthy();
    expect(screen.getByText('Leader')).toBeTruthy();
    expect(screen.getByText('Follower')).toBeTruthy();
    expect(screen.getByLabelText('hands control to')).toBeTruthy();
    expect(screen.getByText('Plan is set; the follower takes the page')).toBeTruthy();
  });
});
