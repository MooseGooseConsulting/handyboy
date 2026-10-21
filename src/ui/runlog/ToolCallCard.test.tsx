// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ToolEntry } from '../state/runlog';
import { ToolCallCard } from './ToolCallCard';

afterEach(cleanup);

const entry = (over: Partial<ToolEntry> = {}): ToolEntry => ({
  kind: 'tool',
  key: 'tool:c1',
  callId: 'c1',
  call: {
    kind: 'tool.call',
    role: 'follower',
    call: { callId: 'c1', name: 'click_element', args: { selector: '#buy' } },
    at: 1,
  },
  result: {
    kind: 'tool.result',
    role: 'follower',
    result: { callId: 'c1', name: 'click_element', ok: false, summary: 'element not found', durationMs: 1240 },
    at: 2,
  },
  ...over,
});

describe('ToolCallCard', () => {
  it('a failed call reads fail and its duration while collapsed, and the arguments appear only after it is opened', async () => {
    const user = userEvent.setup();
    render(<ToolCallCard entry={entry()} />);
    const summary = screen.getByTestId('tool-call-summary');
    expect(summary.textContent).toContain('click_element');
    expect(summary.textContent).toContain('fail');
    expect(summary.textContent).toContain('1.24s');
    expect(summary.textContent).toContain('selector=#buy');
    expect(screen.queryByText('element not found')).toBeNull();

    await user.click(screen.getByRole('button'));
    expect(screen.getByRole('button').getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('element not found')).toBeTruthy();
  });

  it('a call with no result yet reads running and does not invent a duration', () => {
    render(<ToolCallCard entry={entry({ result: undefined })} />);
    expect(screen.getByTestId('tool-call-summary').textContent).toContain('running…');
    expect(screen.getByTestId('tool-call-summary').textContent).not.toContain('1.24s');
  });
});
