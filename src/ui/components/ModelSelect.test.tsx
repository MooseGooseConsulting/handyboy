// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ModelInfo } from '@/src/messaging';
import { ModelSelect } from './ModelSelect';

afterEach(cleanup);

const models: ModelInfo[] = [
  { id: 'same', name: 'OpenRouter copy', free: true, vision: false, tools: true, contextLength: 1000, source: 'openrouter' },
  { id: 'same', name: 'Kilo copy', free: false, vision: true, tools: true, contextLength: 1000, source: 'kilo' },
];

describe('ModelSelect', () => {
  it('picking the Kilo copy of a shared id does not report the OpenRouter source', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <ModelSelect id="follower" label="Follower model" models={models} value="" onChange={onChange} freeOnly={false} />,
    );

    await user.click(screen.getByRole('combobox', { name: 'Follower model' }));
    await user.click(screen.getByRole('option', { name: /Kilo copy/ }));

    expect(onChange).toHaveBeenCalledWith('same', 'kilo');
  });

  it('tabbing out of the picker closes its list instead of leaving it over the next field', async () => {
    const user = userEvent.setup();
    render(
      <>
        <ModelSelect id="leader" label="Leader model" models={models} value="" onChange={vi.fn()} />
        <ModelSelect id="follower" label="Follower model" models={models} value="" onChange={vi.fn()} />
      </>,
    );
    const leader = screen.getByRole('combobox', { name: 'Leader model' });

    await user.click(leader);
    expect(leader.getAttribute('aria-expanded')).toBe('true');

    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('combobox', { name: 'Follower model' }));
    expect(leader.getAttribute('aria-expanded')).toBe('false');
    expect(document.getElementById(leader.getAttribute('aria-controls')!)?.hidden).toBe(true);
  });

  it('pressing on the open list itself, as on its scrollbar, keeps it open', async () => {
    const user = userEvent.setup();
    render(<ModelSelect id="leader" label="Leader model" models={models} value="" onChange={vi.fn()} />);
    const leader = screen.getByRole('combobox', { name: 'Leader model' });

    await user.click(leader);
    await user.pointer({ keys: '[MouseLeft]', target: screen.getByRole('listbox', { name: 'Leader model' }) });

    expect(document.activeElement).toBe(leader);
    expect(leader.getAttribute('aria-expanded')).toBe('true');
  });
});
