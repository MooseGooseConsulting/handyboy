// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import type { ModelInfo, Readiness } from '@/src/messaging';
import { configItem, getConfig, type Config } from '@/src/storage';
import { freeOnlyItem } from '../state/modelFilter';
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
  it('a Leader that trains on prompts gets a red warning but stays selected and runnable', async () => {
    const museOpenRouter: ModelInfo = {
      id: 'meta/muse-spark-1.3-contributor',
      name: 'Meta: Muse Spark 1.3 Contributor',
      free: false,
      vision: false,
      tools: true,
      contextLength: 1000,
      source: 'openrouter',
    };
    const museKilo: ModelInfo = { ...museOpenRouter, source: 'kilo', mayTrainOnYourPrompts: true };
    await configItem.setValue(stored({ leaderModel: museOpenRouter.id, followerModel: 'follower-pick' }));
    renderSetup({ models: [...catalog, museOpenRouter, museKilo] });

    const warning = await screen.findByText(/may train on your prompts/);
    expect(warning.textContent).toContain('Leader (Meta: Muse Spark 1.3 Contributor)');
    expect(warning.textContent).not.toContain('Follower');
    expect((await getConfig()).leaderModel).toBe(museOpenRouter.id);
  });

  it('a paid OpenRouter Leader gets an amber unknown warning instead of none when the Kilo catalog is missing', async () => {
    const museOpenRouter: ModelInfo = {
      id: 'meta/muse-spark-1.3-contributor',
      name: 'Meta: Muse Spark 1.3 Contributor',
      free: false,
      vision: false,
      tools: true,
      contextLength: 1000,
      source: 'openrouter',
    };
    const known: ModelInfo = { ...catalog[1]!, mayTrainOnYourPrompts: false };
    await configItem.setValue(stored({ leaderModel: museOpenRouter.id, followerModel: known.id }));
    renderSetup({ models: [known, museOpenRouter] });

    const warning = await screen.findByText(/^Unknown whether/);
    expect(warning.textContent).toContain('Leader (Meta: Muse Spark 1.3 Contributor)');
    expect(screen.queryByText(/may train on your prompts/)).toBeNull();
  });

  it('an unknown Kilo model is not sent to OpenRouter privacy settings, which do not govern Kilo', async () => {
    const kiloModel: ModelInfo = { ...catalog[0]!, id: 'kilo/unflagged', name: 'Kilo Unflagged', source: 'kilo' };
    const known: ModelInfo = { ...catalog[1]!, mayTrainOnYourPrompts: false };
    await configItem.setValue(stored({ leaderModel: kiloModel.id, leaderModelSource: 'kilo', followerModel: known.id }));
    renderSetup({ models: [known, kiloModel] });

    const warning = await screen.findByText(/^Unknown whether/);
    expect(warning.textContent).toContain("Kilo's catalog gives no training flag");
    expect(warning.textContent).not.toContain('OpenRouter');
  });

  it('a saved model missing from the loaded catalog still gets its warning, judged from the stored id', async () => {
    await configItem.setValue(stored({ leaderModel: 'nvidia/nemotron-3-ultra-550b-a55b:free', followerModel: 'paid/not-loaded' }));
    renderSetup({ models: catalog });

    const red = await screen.findByText(/may train on your prompts/);
    expect(red.textContent).toContain('Leader (nvidia/nemotron-3-ultra-550b-a55b:free)');
    const amber = await screen.findByText(/^Unknown whether/);
    expect(amber.textContent).toContain('Follower (paid/not-loaded)');
  });

  it('a stored OpenRouter pick is judged as the OpenRouter entry, not its same-id Kilo twin', async () => {
    const openrouter: ModelInfo = { ...catalog[0]!, id: 'twin/model', name: 'Twin via OpenRouter', free: false, source: 'openrouter' };
    const kilo: ModelInfo = { ...openrouter, name: 'Twin via Kilo', source: 'kilo', mayTrainOnYourPrompts: false };
    const known: ModelInfo = { ...catalog[1]!, mayTrainOnYourPrompts: false };
    await configItem.setValue(stored({ leaderModel: openrouter.id, followerModel: known.id }));
    renderSetup({ models: [kilo, openrouter, known] });

    const amber = await screen.findByText(/^Unknown whether/);
    expect(amber.textContent).toContain('Leader (Twin via OpenRouter)');
  });

  it('no warning shows when neither selected model trains on prompts', async () => {
    await configItem.setValue(stored({ leaderModel: 'leader-pick', followerModel: 'follower-pick' }));
    renderSetup({ models: catalog.map((model) => ({ ...model, mayTrainOnYourPrompts: false })) });
    await screen.findAllByText('Atlas Planner');
    expect(screen.queryByText(/may train on your prompts/)).toBeNull();
    expect(screen.queryByText(/^Unknown whether/)).toBeNull();
  });

  const paid: ModelInfo = {
    id: 'paid-pick',
    name: 'Atlas Premium',
    free: false,
    vision: false,
    tools: true,
    contextLength: 200_000,
    source: 'openrouter',
    mayTrainOnYourPrompts: false,
  };

  async function choose(role: 'Leader' | 'Follower', option: RegExp) {
    const user = userEvent.setup();
    await user.click(screen.getByRole('combobox', { name: `${role} model` }));
    await user.click(await screen.findByRole('option', { name: option }));
  }

  it('picking a free Follower leaves the paid Leader warning standing', async () => {
    await freeOnlyItem.setValue(false);
    await configItem.setValue(stored({ leaderModel: 'leader-pick', followerModel: 'follower-pick' }));
    renderSetup({ models: [...catalog, paid] });
    await screen.findAllByText('Atlas Planner');

    await choose('Leader', /Atlas Premium/);
    expect((await screen.findByRole('alert')).textContent).toContain('Leader is now a paid model (Atlas Premium)');

    await choose('Follower', /Atlas Spare/);
    await waitFor(async () => expect((await getConfig()).followerModel).toBe('spare-pick'));
    expect(screen.getByRole('alert').textContent).toContain('Leader is now a paid model (Atlas Premium)');
  });

  it('resetting to defaults takes the paid-model warning away with the paid pick', async () => {
    const user = userEvent.setup();
    await freeOnlyItem.setValue(false);
    await configItem.setValue(stored({ leaderModel: 'leader-pick', followerModel: 'follower-pick' }));
    renderSetup({ models: [...catalog, paid] });
    await screen.findAllByText('Atlas Planner');

    await choose('Leader', /Atlas Premium/);
    expect((await screen.findByRole('alert')).textContent).toContain('Leader is now a paid model');

    await user.click(screen.getByRole('button', { name: 'Reset to defaults' }));
    await waitFor(async () => expect((await getConfig()).leaderModel).not.toBe('paid-pick'));
    expect(screen.queryByText(/is now a paid model/)).toBeNull();
  });

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
