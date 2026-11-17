import { beforeEach, describe, expect, it } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { DEFAULT_CONFIG, getConfig, setConfig } from '@/src/storage';

beforeEach(() => {
  fakeBrowser.reset();
});

describe('stored config', () => {
  it('a patch that only sets the leader keeps the observe mode and the follower', async () => {
    expect(await getConfig()).toEqual(DEFAULT_CONFIG);
    const next = await setConfig({ leaderModel: 'nvidia/nemotron-ultra' });
    expect(next.leaderModel).toBe('nvidia/nemotron-ultra');
    expect(next.followerModel).toBe('');
    expect(next.observe).toBe('dom');
    expect(next.inputFidelity).toBe('in-page');
    expect(await getConfig()).toEqual(next);
  });
});
