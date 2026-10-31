// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { createChannel, createFakePortPair, type Envelope, type PanelToWorker, type Readiness } from '@/src/messaging';
import type { Config } from '@/src/storage';
import { RunSection } from '@/src/ui/sections/RunSection';
import { usePanel, type PanelApi } from './usePanel';

beforeEach(() => fakeBrowser.reset());
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const config: Config = {
  leaderModel: 'fixture-leader', followerModel: 'fixture-follower',
  leaderModelSource: 'kilo', followerModelSource: 'kilo',
  observe: 'dom', planningInterval: 5, maxSteps: 20, inputFidelity: 'in-page',
};
const ready: Readiness = { hostConnected: true, keyReady: true };

function panelFixture(initial = config) {
  const [panelPort, workerPort] = createFakePortPair();
  const worker = createChannel(workerPort);
  const sent: Envelope[] = [];
  worker.onMessage((message) => sent.push(message));
  // Exercise ChromePort's actual adapter without connecting to an extension or browser.
  vi.stubGlobal('chrome', { runtime: { connect: () => ({
    postMessage: (message: Envelope) => panelPort.postMessage(message),
    onMessage: { addListener: (listener: (message: Envelope) => void) => panelPort.onMessage(listener) },
    onDisconnect: { addListener: (listener: () => void) => panelPort.onDisconnect(listener) },
    disconnect: () => panelPort.disconnect(),
  }) } });
  let api!: PanelApi;
  function Panel({ selection }: { selection: Config }) {
    api = usePanel(selection);
    return <RunSection config={selection} readiness={api.readiness} readinessStatus={api.readinessStatus}
      log={api.log} starting={api.starting} onStart={(prompt) => api.startRun(prompt, selection)}
      onPause={api.pauseRun} onResume={api.resumeRun} onAbort={api.abortRun} />;
  }
  const view = render(<Panel selection={initial} />);
  fireEvent.change(screen.getByRole('textbox', { name: 'Objective' }), { target: { value: 'synthetic objective' } });
  const requests = () => sent.filter((m) => m.type === 'readiness.get')
    .map((m) => m.payload as PanelToWorker['readiness.get']);
  const answer = (request: PanelToWorker['readiness.get'], status = ready) => act(() => {
    worker.send('readiness', { ...status, requestId: request.requestId });
  });
  const button = () => screen.getByRole('button', { name: 'Run' }) as HTMLButtonElement;
  return { sent, worker, requests, answer, button, api: () => api,
    change: (selection: Config) => view.rerender(<Panel selection={selection} />) };
}

describe('panel selected-source readiness', () => {
  it('changes refresh both role sources, block Run immediately, and discard late ready answers', () => {
    const f = panelFixture();
    const first = f.requests()[0]!;
    expect(first).toMatchObject({ leaderModelSource: 'kilo', followerModelSource: 'kilo' });
    expect(f.button().disabled).toBe(true);
    f.answer(first);
    expect(f.button().disabled).toBe(false);

    f.change({ ...config, leaderModelSource: 'openrouter' });
    const second = f.requests()[1]!;
    expect(second).toMatchObject({ leaderModelSource: 'openrouter', followerModelSource: 'kilo' });
    expect(f.button().disabled).toBe(true);
    f.answer(first);
    expect(f.button().disabled).toBe(true);
    f.answer(second, { hostConnected: true, keyReady: false, reason: 'openrouter: key not configured' });
    expect(screen.getByText('openrouter: key not configured')).toBeTruthy();
    fireEvent.click(f.button());
    expect(f.sent.filter((m) => m.type === 'run.start')).toHaveLength(0);
    f.answer(first);
    expect(f.button().disabled).toBe(true);

    f.change({ ...config, leaderModelSource: 'openrouter', followerModelSource: 'openrouter' });
    expect(f.requests()[2]).toMatchObject({ leaderModelSource: 'openrouter', followerModelSource: 'openrouter' });
    f.answer(f.requests()[2]!);
    expect(f.button().disabled).toBe(false);
  });

  it('returning to the same sources and overlapping manual refreshes still require the latest answer', () => {
    const f = panelFixture();
    const original = f.requests()[0]!;
    f.change({ ...config, followerModelSource: 'openrouter' });
    f.change(config);
    f.answer(original);
    expect(f.button().disabled).toBe(true);
    f.answer(f.requests()[2]!);
    expect(f.button().disabled).toBe(false);
    act(() => f.api().refreshReadiness());
    const older = f.requests()[3]!;
    act(() => f.api().refreshReadiness());
    f.answer(older);
    expect(f.button().disabled).toBe(true);
    f.answer(f.requests()[4]!);
    expect(f.button().disabled).toBe(false);
  });

  it('omitted sources request OpenRouter and unrelated config edits retain valid source readiness', () => {
    const legacy = { ...config, leaderModelSource: undefined, followerModelSource: undefined };
    const f = panelFixture(legacy);
    expect(f.requests()[0]).toMatchObject({ leaderModelSource: 'openrouter', followerModelSource: 'openrouter' });
    f.answer(f.requests()[0]!);
    f.change({ ...legacy, observe: 'pixels', planningInterval: 8, leaderModel: 'any-other-model' });
    expect(f.requests()).toHaveLength(1);
    expect(f.button().disabled).toBe(false);
  });

  it('a disconnected worker invalidates a ready answer and late replies cannot reopen Run', () => {
    const f = panelFixture();
    f.answer(f.requests()[0]!);
    expect(f.button().disabled).toBe(false);
    act(() => f.worker.close());
    f.answer(f.requests()[0]!);
    expect(f.api().hub.status).toBe('disconnected');
    expect(f.button().disabled).toBe(true);
  });

  it('a worker refusal releases starting and exposes the missing source without inventing a run', () => {
    const f = panelFixture();
    f.answer(f.requests()[0]!);
    fireEvent.click(f.button());
    expect(f.api().starting).toBe(true);
    expect(f.sent.find((m) => m.type === 'run.start')?.payload).toEqual({ prompt: 'synthetic objective', config });
    act(() => f.worker.send('error', { inReplyTo: 'run.start', message: 'kilo: key not configured' }));
    expect(f.api().starting).toBe(false);
    expect(f.api().workerError).toBe('kilo: key not configured');
    expect(f.api().log.runId).toBeUndefined();
    expect(f.api().log.events).toEqual([]);
  });
});
