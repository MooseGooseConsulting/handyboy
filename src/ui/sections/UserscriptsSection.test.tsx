// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Userscript, UserscriptRunResult } from '@/src/messaging';
import { TabPanelVisibleContext } from '../components/Tabs';
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

  it('saving an edit to an existing script keeps the edited copy until the fresh list arrives', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    const { rerender } = render(<UserscriptsSection {...props({ onSave })} />);
    expect(codeField().value).toBe(stored.code);

    await user.click(codeField());
    await user.type(codeField(), '// v2');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ code: `${stored.code}// v2` }));
    // The panel's list still holds the pre-save copy; it must not replace the editor.
    expect(codeField().value).toBe(`${stored.code}// v2`);
    rerender(<UserscriptsSection {...props({ onSave })} />);
    expect(codeField().value).toBe(`${stored.code}// v2`);

    // The stored copy the worker echoes is stamped at save time, never earlier.
    const saved: Userscript = onSave.mock.calls[0]![0];
    rerender(<UserscriptsSection {...props({ onSave, scripts: [saved] })} />);
    expect(codeField().value).toBe(`${stored.code}// v2`);
    expect(screen.getByRole('button', { name: /listing prices/ }).getAttribute('aria-current')).toBe('true');
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

  // 'const rows = [];' is 16 characters, so line 2 starts at offset 17.
  const failedLineTwo: UserscriptRunResult = {
    scriptId: stored.id,
    ok: false,
    error: 'ReferenceError: rows is not defined (line 2)',
    console: [],
    durationMs: 3,
  };

  it('moves the caret once the panel shows, when the result arrived while it was hidden', () => {
    const hidden = (result?: UserscriptRunResult) => (
      <TabPanelVisibleContext.Provider value={false}>
        <UserscriptsSection {...props({ result })} />
      </TabPanelVisibleContext.Provider>
    );
    const shown = (
      <TabPanelVisibleContext.Provider value={true}>
        <UserscriptsSection {...props({ result: failedLineTwo })} />
      </TabPanelVisibleContext.Provider>
    );
    const { rerender } = render(hidden());
    rerender(hidden(failedLineTwo));
    // A hidden panel has no layout: the jump waits instead of running into a no-op.
    expect(codeField().selectionStart).not.toBe(17);

    rerender(shown);
    expect(codeField().selectionStart).toBe(17);
  });

  it('moves the caret when the result outran the script list', () => {
    const { rerender } = render(<UserscriptsSection {...props({ scripts: [] })} />);
    rerender(<UserscriptsSection {...props({ scripts: [], result: failedLineTwo })} />);
    // The executed script is not in the editor yet, so nothing is positioned.
    expect(codeField().selectionStart).not.toBe(17);

    rerender(<UserscriptsSection {...props({ result: failedLineTwo })} />);
    expect(codeField().selectionStart).toBe(17);
  });
});
