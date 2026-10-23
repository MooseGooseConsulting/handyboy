// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Userscript, UserscriptRunResult } from '@/src/messaging';
import { UserscriptsSection } from './UserscriptsSection';

afterEach(cleanup);

const stored: Userscript = {
  id: 'script-stored',
  name: 'listing prices',
  matches: ['*://shop.example/*'],
  code: 'const rows = [];\nreturn rows;\n',
  updatedAt: 1,
};

function props(over: Partial<Parameters<typeof UserscriptsSection>[0]> = {}) {
  return {
    scripts: [stored],
    scriptsStatus: 'ready' as const,
    runStatus: 'ready' as const,
    onSave: vi.fn(),
    onRun: vi.fn(),
    onDelete: vi.fn(),
    onRefresh: vi.fn(),
    ...over,
  };
}

const nameField = () => screen.getByLabelText('Name') as HTMLInputElement;
const codeField = () => screen.getByLabelText('Code') as HTMLTextAreaElement;

describe('UserscriptsSection', () => {
  it('saving a new script keeps it in the editor while the worker is still storing it', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    const { rerender } = render(<UserscriptsSection {...props({ onSave })} />);
    expect(nameField().value).toBe('listing prices');

    await user.click(screen.getByRole('button', { name: 'new' }));
    await user.clear(nameField());
    await user.type(nameField(), 'review counts');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ name: 'review counts' }));
    // The list the panel holds has not caught up with the save yet.
    expect(nameField().value).toBe('review counts');

    const saved: Userscript = onSave.mock.calls[0]![0];
    rerender(<UserscriptsSection {...props({ onSave, scripts: [stored, saved] })} />);
    expect(nameField().value).toBe('review counts');
    expect(screen.getByRole('button', { name: /review counts/ }).getAttribute('aria-current')).toBe('true');
  });

  it('typing after a failed run keeps the caret where the user is typing', async () => {
    const user = userEvent.setup();
    const failed: UserscriptRunResult = {
      scriptId: stored.id,
      ok: false,
      error: 'ReferenceError: rowz is not defined (line 1)',
      console: [],
      durationMs: 3,
    };
    const { rerender } = render(<UserscriptsSection {...props()} />);
    rerender(<UserscriptsSection {...props({ result: failed })} />);
    // The failed run itself does put the caret on the error line.
    expect(codeField().selectionStart).toBe(0);

    await user.click(codeField());
    codeField().setSelectionRange(codeField().value.length, codeField().value.length);
    await user.type(codeField(), '// fixed', { skipClick: true });

    expect(codeField().value).toBe(`${stored.code}// fixed`);
    expect(codeField().selectionStart).toBe(codeField().value.length);
  });
});
