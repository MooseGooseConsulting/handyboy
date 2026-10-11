// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { ModelUsageEvent, ObservationEvent } from './SimpleEvents';

afterEach(cleanup);

describe('size readouts in the run log', () => {
  it('labels the observation size as a snapshot estimate, not the prompt size', () => {
    render(<ObservationEvent event={{ kind: 'observation', mode: 'dom', tokens: 18_048, hasScreenshot: false, at: 1 }} />);
    const text = screen.getByTestId('log-entry').textContent ?? '';
    expect(text).toContain('≈18,048 snapshot tokens');
    expect(text).not.toMatch(/\b18,?048 tokens\b/);
  });

  it("shows one line per model call with the provider's counts and the prompt's size", () => {
    render(
      <ModelUsageEvent
        event={{
          kind: 'model.usage',
          role: 'follower',
          model: 'nvidia/nemotron-3.5-lightning:free',
          inputTokens: 72_400,
          outputTokens: 61,
          reasoningTokens: 12,
          promptChars: 289_000,
          at: 1,
        }}
      />,
    );
    const line = screen.getByTestId('model-usage').textContent ?? '';
    expect(line).toContain('Follower');
    expect(line).toContain('nvidia/nemotron-3.5-lightning:free');
    expect(line).toContain('72,400 in · 61 out · 12 reasoning · 289,000 prompt chars');
    expect(line).not.toContain('cached');
  });

  it('says the provider gave no count instead of showing zero tokens', () => {
    render(<ModelUsageEvent event={{ kind: 'model.usage', role: 'leader', model: 'm', promptChars: 900, at: 1 }} />);
    const line = screen.getByTestId('model-usage').textContent ?? '';
    expect(line).toContain('no provider token count · 900 prompt chars');
    expect(line).not.toContain('0 in');
  });
});
