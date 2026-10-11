// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { RunEvent } from '@/src/messaging';
import { RunResultCard } from './RunResultCard';

afterEach(cleanup);

const CONFIG = {
  leaderModel: 'a',
  followerModel: 'b',
  observe: 'dom' as const,
  planningInterval: 5,
  maxSteps: 50,
  inputFidelity: 'in-page' as const,
};

const started: RunEvent = {
  kind: 'run.started',
  runId: 'run-1',
  prompt: 'buy the thing',
  config: CONFIG,
  tabId: 1,
  url: 'https://example.com',
  at: 1_000,
};

describe('RunResultCard', () => {
  it('renders nothing before the run ends', () => {
    render(<RunResultCard events={[started]} />);
    expect(screen.queryByTestId('run-result-card')).toBeNull();
  });

  it('shows outcome, summary, steps and elapsed time', () => {
    render(
      <RunResultCard
        events={[started, { kind: 'run.ended', status: 'done', message: 'Found the three threads.', steps: 4, at: 13_400 }]}
      />,
    );
    const card = screen.getByTestId('run-result-card');
    expect(card.textContent).toContain('Done');
    expect(card.textContent).toContain('4 steps');
    expect(card.textContent).toContain('12.4s');
    expect(screen.getByTestId('run-result-message').textContent).toBe('Found the three threads.');
  });

  it('collapses a long summary behind show more', async () => {
    const user = userEvent.setup();
    const long = 'x'.repeat(300);
    render(
      <RunResultCard events={[started, { kind: 'run.ended', status: 'error', message: long, steps: 1, at: 2_000 }]} />,
    );
    expect(screen.getByTestId('run-result-message').textContent).not.toBe(long);
    await user.click(screen.getByRole('button', { name: 'show more' }));
    expect(screen.getByTestId('run-result-message').textContent).toBe(long);
  });

  it('lists saved files read generically off the event stream (TODO: file.saved)', () => {
    const events = [
      started,
      { kind: 'file.saved', name: 'report.pdf', url: 'blob:report' } as unknown as RunEvent,
      { kind: 'run.ended', status: 'done', message: 'done', steps: 1, at: 2_000 } as RunEvent,
    ];
    render(<RunResultCard events={events} />);
    const files = screen.getByTestId('run-result-files');
    expect(files.textContent).toContain('report.pdf');
    expect(screen.getByRole('link', { name: 'report.pdf' }).getAttribute('href')).toBe('blob:report');
  });

  it('shows per-role token totals on the run result card', () => {
    const usage = (role: 'leader' | 'follower', inputTokens: number | undefined, promptChars: number): RunEvent => ({
      kind: 'model.usage',
      role,
      model: `${role}-model`,
      ...(inputTokens !== undefined ? { inputTokens, outputTokens: 10 } : {}),
      promptChars,
      at: 1_500,
    });
    render(
      <RunResultCard
        events={[
          started,
          usage('leader', 2_000, 8_000),
          usage('follower', 70_000, 280_000),
          usage('leader', 3_000, 12_000),
          usage('follower', undefined, 290_000),
          { kind: 'run.ended', status: 'done', message: 'ok', steps: 2, at: 2_000 },
        ]}
      />,
    );
    const rows = [...screen.getByTestId('run-result-usage').querySelectorAll('li')].map((li) => li.textContent);
    expect(rows).toEqual([
      'Leader2 calls · 5,000 in · 20 out · 20,000 prompt chars',
      'Follower2 calls · 70,000 in · 10 out · 570,000 prompt chars · 1 without a provider count',
    ]);
  });

  it('leaves the usage section out when no model call was recorded', () => {
    render(<RunResultCard events={[started, { kind: 'run.ended', status: 'done', message: '', steps: 0, at: 2_000 }]} />);
    expect(screen.queryByTestId('run-result-usage')).toBeNull();
  });

  it('names the outcome for blocked, aborted and max-steps too', () => {
    const { rerender } = render(
      <RunResultCard events={[started, { kind: 'run.ended', status: 'blocked', message: '', steps: 1, at: 2_000 }]} />,
    );
    expect(screen.getByTestId('run-result-card').textContent).toContain('Blocked');

    rerender(
      <RunResultCard events={[started, { kind: 'run.ended', status: 'aborted', message: '', steps: 1, at: 2_000 }]} />,
    );
    expect(screen.getByTestId('run-result-card').textContent).toContain('Aborted');

    rerender(
      <RunResultCard events={[started, { kind: 'run.ended', status: 'max-steps', message: '', steps: 1, at: 2_000 }]} />,
    );
    expect(screen.getByTestId('run-result-card').textContent).toContain('Max steps reached');
  });
});
