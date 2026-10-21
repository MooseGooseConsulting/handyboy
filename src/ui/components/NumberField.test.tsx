// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach } from 'vitest';
import { NumberField } from './NumberField';

afterEach(cleanup);

describe('NumberField', () => {
  it('clearing the field shows the error and does not commit NaN', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<NumberField id="interval" value={7} min={1} max={100} onChange={onChange} />);
    const input = screen.getByRole('spinbutton') as HTMLInputElement;

    await user.clear(input);

    expect(input.value).toBe('');
    expect(screen.getByRole('alert').textContent).toContain('1');
    expect(onChange).not.toHaveBeenCalled();
    expect(input.getAttribute('aria-invalid')).toBe('true');
  });

  it('a value inside the range is committed, and 101 is shown but not committed', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<NumberField id="interval" value={7} min={1} max={100} onChange={onChange} />);
    const input = screen.getByRole('spinbutton');

    await user.clear(input);
    await user.type(input, '12');
    expect(onChange).toHaveBeenCalledWith(12);

    onChange.mockClear();
    await user.clear(input);
    await user.type(input, '101');
    expect(onChange.mock.calls.map((call) => call[0])).not.toContain(101);
    expect(onChange.mock.calls.at(-1)?.[0]).toBe(10);
  });
});
