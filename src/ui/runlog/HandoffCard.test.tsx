// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { HandoffCard } from './HandoffCard';

afterEach(cleanup);

describe('HandoffCard', () => {
  it('shows both roles, the reason, and a BLOCKED signal, and omits the signal badge when there is none', () => {
    const { rerender } = render(
      <HandoffCard
        event={{
          kind: 'handoff',
          from: 'follower',
          to: 'leader',
          reason: 'the checkout page changed shape',
          signal: 'BLOCKED',
          at: 1_700_000_000_000,
        }}
      />,
    );
    const card = screen.getByTestId('handoff-card');
    expect(card.textContent).toContain('Follower');
    expect(card.textContent).toContain('Leader');
    expect(card.textContent).toContain('BLOCKED');
    expect(card.textContent).toContain('the checkout page changed shape');
    expect(screen.getByLabelText('hands control to')).toBeTruthy();

    rerender(
      <HandoffCard
        event={{
          kind: 'handoff',
          from: 'leader',
          to: 'follower',
          reason: 'plan is set',
          at: 2,
        }}
      />,
    );
    expect(screen.getByTestId('handoff-card').textContent).not.toContain('BLOCKED');
    expect(screen.getByTestId('handoff-card').textContent?.indexOf('Leader')).toBeLessThan(
      screen.getByTestId('handoff-card').textContent?.indexOf('Follower') ?? -1,
    );
  });
});
