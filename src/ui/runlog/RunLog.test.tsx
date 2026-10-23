// @vitest-environment jsdom
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { RunEvent } from '@/src/messaging';
import type { Config } from '@/src/storage';
import { TabPanel, Tabs } from '../components/Tabs';
import { RunLog } from './RunLog';

const config: Config = {
  leaderModel: 'atlas-planner',
  followerModel: 'atlas-runner',
  observe: 'dom',
  planningInterval: 4,
  maxSteps: 20,
  inputFidelity: 'in-page',
};

const started: RunEvent = {
  kind: 'run.started',
  runId: 'run-17',
  prompt: 'Book a table for two at 7',
  config,
  tabId: 3,
  url: 'https://example.test/reserve',
  at: 1_000,
};

const said = (text: string, at: number): RunEvent => ({ kind: 'model.text', role: 'follower', text, at });

type Tab = 'run' | 'setup';

/** The side panel's shape: the log sits in a tab that stays mounted while hidden. */
function Panel({ events }: { events: RunEvent[] }) {
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
        <RunLog events={events} emptyMessage="No run yet." />
      </TabPanel>
      <TabPanel value="setup" active={tab}>
        <p>setup body</p>
      </TabPanel>
    </>
  );
}

let scrollIntoView: ReturnType<typeof vi.fn>;

beforeEach(() => {
  scrollIntoView = vi.fn();
  // jsdom has no layout and no scrollIntoView; the spy stands in for the browser's.
  HTMLElement.prototype.scrollIntoView = scrollIntoView as unknown as HTMLElement['scrollIntoView'];
});

afterEach(() => {
  cleanup();
  delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView;
});

describe('RunLog', () => {
  it('returning to the Run tab scrolls a pinned log to events that arrived while it was hidden', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<Panel events={[started]} />);
    expect(scrollIntoView).toHaveBeenCalled();

    await user.click(screen.getByRole('tab', { name: 'Setup' }));
    scrollIntoView.mockClear();
    rerender(<Panel events={[started, said('opening the booking form', 2_000), said('picked 7pm', 3_000)]} />);
    // Scrolling a display:none panel does nothing in a browser, so it is not attempted.
    expect(scrollIntoView).not.toHaveBeenCalled();

    await user.click(screen.getByRole('tab', { name: 'Run' }));
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'end' });
  });
});
