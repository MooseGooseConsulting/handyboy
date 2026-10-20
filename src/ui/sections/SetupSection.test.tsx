// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import type { ModelInfo, Readiness } from '@/src/messaging';
import { configItem, getConfig, type Config } from '@/src/storage';
import { SetupSection } from './SetupSection';

afterEach(cleanup);

beforeEach(() => {
  fakeBrowser.reset();
});

const catalog: ModelInfo[] = [
  {
    id: 'leader-pick',
    name: 'Atlas Planner',
    free: true,
    vision: false,
    tools: true,
    contextLength: 128_000,
    source: 'openrouter',
  },
  {
    id: 'follower-pick',
    name: 'Atlas Runner',
    free: true,
    vision: false,
    tools: true,
    contextLength: 32_000,
    source: 'openrouter',
  },
  {
    id: 'spare-pick',
    name: 'Atlas Spare',
    free: true,
    vision: false,
    tools: true,
    contextLength: 8_000,
    source: 'openrouter',
  },
];

function stored(over: Partial<Config> = {}): Config {
  return {
    leaderModel: '',
    followerModel: '',
    observe: 'dom',
    planningInterval: 8,
    maxSteps: 40,
    inputFidelity: 'in-page',
    readOnly: false,
    ...over,
  };
}

function renderSetup(over: { models?: ModelInfo[]; readiness?: Readiness } = {}) {
  return render(
    <SetupSection
      models={over.models ?? []}
      modelsStatus="ready"
      onRefreshModels={() => undefined}
      readiness={over.readiness}
      readinessStatus="ready"
      onRefreshReadiness={() => undefined}
    />,
  );
}

function rowText(label: string): string {
  const row = screen.getAllByRole('listitem').find((item) => item.textContent?.includes(label));
  if (!row?.textContent) throw new Error(`no readiness row for ${label}`);
  return row.textContent;
}

async function planningInterval(): Promise<HTMLInputElement> {
  return screen.findByLabelText('Planning interval') as Promise<HTMLInputElement>;
}

describe('SetupSection', () => {
  it('clearing the planning interval would store NaN', async () => {
    const user = userEvent.setup();
    await configItem.setValue(stored({ planningInterval: 7 }));
    renderSetup();

    const field = await planningInterval();
    await waitFor(() => expect(field.value).toBe('7'));

    await user.clear(field);

    expect(field.value).toBe('');
    expect(field.getAttribute('aria-invalid')).toBe('true');
    // A bad clear writes NaN on the storage promise, after this turn. Read once it has settled.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    const saved = await getConfig();
    expect(saved.planningInterval).toBe(7);
    expect(Number.isNaN(saved.planningInterval)).toBe(false);
  });

  it('picking dom, pixels, or both would save a different observe mode than the one chosen', async () => {
    const user = userEvent.setup();
    await configItem.setValue(stored({ observe: 'pixels', planningInterval: 8 }));
    renderSetup();

    await waitFor(() => {
      expect((screen.getByRole('radio', { name: 'Pixels' }) as HTMLInputElement).checked).toBe(true);
    });

    await user.click(screen.getByRole('radio', { name: 'DOM' }));
    await waitFor(async () => expect((await getConfig()).observe).toBe('dom'));
    expect((screen.getByRole('radio', { name: 'DOM' }) as HTMLInputElement).checked).toBe(true);

    await user.click(screen.getByRole('radio', { name: 'Both' }));
    await waitFor(async () => expect((await getConfig()).observe).toBe('both'));
    expect((screen.getByRole('radio', { name: 'Both' }) as HTMLInputElement).checked).toBe(true);

    await user.click(screen.getByRole('radio', { name: 'Pixels' }));
    await waitFor(async () => expect((await getConfig()).observe).toBe('pixels'));
    expect((screen.getByRole('radio', { name: 'Pixels' }) as HTMLInputElement).checked).toBe(true);
    expect((await getConfig()).planningInterval).toBe(8);
  });

  it('choosing the Follower would overwrite the Leader already saved', async () => {
    const user = userEvent.setup();
    await configItem.setValue(
      stored({ leaderModel: 'already-leader', followerModel: 'already-follower', planningInterval: 8 }),
    );
    renderSetup({ models: catalog });

    await waitFor(() => {
      expect((screen.getByRole('combobox', { name: 'Leader model' }) as HTMLInputElement).value).toBe('already-leader');
      expect((screen.getByRole('combobox', { name: 'Follower model' }) as HTMLInputElement).value).toBe(
        'already-follower',
      );
    });

    await user.click(screen.getByRole('combobox', { name: 'Leader model' }));
    await user.click(await screen.findByRole('option', { name: /Atlas Planner/ }));
    await waitFor(async () => {
      const saved = await getConfig();
      expect(saved.leaderModel).toBe('leader-pick');
      expect(saved.followerModel).toBe('already-follower');
    });
    expect((screen.getByRole('combobox', { name: 'Follower model' }) as HTMLInputElement).value).toBe(
      'already-follower',
    );

    await user.click(screen.getByRole('combobox', { name: 'Follower model' }));
    await user.click(await screen.findByRole('option', { name: /Atlas Runner/ }));
    await waitFor(async () => {
      const saved = await getConfig();
      expect(saved.leaderModel).toBe('leader-pick');
      expect(saved.followerModel).toBe('follower-pick');
    });

    await user.click(screen.getByRole('combobox', { name: 'Leader model' }));
    await user.click(await screen.findByRole('option', { name: /Atlas Spare/ }));
    await waitFor(async () => {
      const saved = await getConfig();
      expect(saved.leaderModel).toBe('spare-pick');
      expect(saved.followerModel).toBe('follower-pick');
    });
  });

  it('a hardcoded ready mark would ignore a host key check that failed', async () => {
    const refused: Readiness = {
      hostConnected: true,
      keyReady: false,
      reason: 'host key check: no provider key',
    };
    const view = renderSetup({ readiness: refused });

    expect(screen.getByText('Not ready')).toBeTruthy();
    expect(screen.queryByText('Ready to run')).toBeNull();
    expect(rowText('Provider key')).toContain('host key check: no provider key');
    expect(rowText('Native host')).toContain('ready');

    view.rerender(
      <SetupSection
        models={[]}
        modelsStatus="ready"
        onRefreshModels={() => undefined}
        readiness={{ hostConnected: true, keyReady: true }}
        readinessStatus="ready"
        onRefreshReadiness={() => undefined}
      />,
    );

    expect(screen.getByText('Ready to run')).toBeTruthy();
    expect(screen.queryByText('Not ready')).toBeNull();
    expect(rowText('Provider key')).toContain('ready');
  });

  it('opening setup would escalate input the user left on in-page, or the toggle would not save escalated', async () => {
    const user = userEvent.setup();
    renderSetup();

    await waitFor(() => {
      expect(screen.getByRole('switch', { name: 'Escalate to trusted input' }).getAttribute('aria-checked')).toBe(
        'false',
      );
    });
    expect(screen.getByText('In-page events')).toBeTruthy();
    expect(screen.queryByText('Escalated (debugger/CDP)')).toBeNull();
    expect((await getConfig()).inputFidelity).toBe('in-page');

    await user.click(screen.getByRole('switch', { name: 'Escalate to trusted input' }));
    await waitFor(async () => expect((await getConfig()).inputFidelity).toBe('escalated'));
    expect(screen.getByText('Escalated (debugger/CDP)')).toBeTruthy();
    expect(screen.getByRole('switch', { name: 'Escalate to trusted input' }).getAttribute('aria-checked')).toBe('true');

    cleanup();
    fakeBrowser.reset();
    await configItem.setValue(stored({ inputFidelity: 'in-page', planningInterval: 11 }));
    renderSetup();
    await waitFor(() => expect((screen.getByLabelText('Planning interval') as HTMLInputElement).value).toBe('11'));
    expect(screen.getByRole('switch', { name: 'Escalate to trusted input' }).getAttribute('aria-checked')).toBe('false');
    expect(screen.getByText('In-page events')).toBeTruthy();
    expect((await getConfig()).inputFidelity).toBe('in-page');

    cleanup();
    fakeBrowser.reset();
    await configItem.setValue(stored({ inputFidelity: 'escalated', planningInterval: 13 }));
    renderSetup();
    await waitFor(() => expect((screen.getByLabelText('Planning interval') as HTMLInputElement).value).toBe('13'));
    expect(screen.getByRole('switch', { name: 'Escalate to trusted input' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByText('Escalated (debugger/CDP)')).toBeTruthy();
    expect((await getConfig()).inputFidelity).toBe('escalated');
  });
});
