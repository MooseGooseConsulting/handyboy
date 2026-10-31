// @vitest-environment jsdom
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TabPanel, Tabs } from './Tabs';

afterEach(cleanup);

type Tab = 'run' | 'setup';

/** Stands in for a section that keeps work in progress in its own state. */
function Draft() {
  const [text, setText] = useState('');
  return <textarea aria-label="Objective" value={text} onChange={(event) => setText(event.target.value)} />;
}

function Panel() {
  const [tab, setTab] = useState<Tab>('run');
  return (
    <>
      <Tabs
        items={[
          { value: 'run', label: 'Run' },
          { value: 'setup', label: 'Setup' },
        ]}
        value={tab}
        onChange={setTab}
        label="Panel sections"
      />
      <TabPanel value="run" active={tab}>
        <Draft />
      </TabPanel>
      <TabPanel value="setup" active={tab}>
        <p>setup body</p>
      </TabPanel>
    </>
  );
}

describe('Tabs', () => {
  it('switching away from a tab and back keeps what was typed in it', async () => {
    const user = userEvent.setup();
    render(<Panel />);

    await user.type(screen.getByRole('textbox', { name: 'Objective' }), 'compare three listings');
    await user.click(screen.getByRole('tab', { name: 'Setup' }));
    expect(screen.getByRole('tabpanel', { name: 'Setup' }).textContent).toContain('setup body');
    // The inactive panel is out of the accessibility tree, so it reads as gone to the user.
    expect(screen.queryByRole('textbox', { name: 'Objective' })).toBeNull();

    await user.click(screen.getByRole('tab', { name: 'Run' }));
    expect((screen.getByRole('textbox', { name: 'Objective' }) as HTMLTextAreaElement).value).toBe(
      'compare three listings',
    );
  });
});
