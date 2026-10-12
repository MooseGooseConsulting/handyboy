import { describe, expect, it } from 'vitest';
import { MemorySaver } from '@langchain/langgraph/web';
import type { RunEvent } from '@/src/messaging/contract';
import { FakeChatModel } from '@/src/agent/models';
import { FakePageTools } from '@/src/agent/tools';
import { startRun } from '@/src/agent/run';

describe('observation events', () => {
  it('each observation in the run log names the page the snapshot was taken of', async () => {
    const urls = ['https://www.ebay.com/sch/i.html?_nkw=a', 'https://www.ebay.com/itm/123456789012'];
    const page = new FakePageTools({ snapshots: urls.map((url, i) => ({ text: `page ${i}`, tokens: 2, url })) });
    const leader = new FakeChatModel({
      label: 'leader',
      respond: () => ({ kind: 'tool', name: 'set_plan', args: { plan: 'p', subgoals: ['s'] } }),
    });
    const follower = new FakeChatModel({
      label: 'follower',
      respond: (call) =>
        call.index === 0
          ? { kind: 'tool', name: 'extract_text', args: { signal: 'CONTINUE' } }
          : { kind: 'tool', name: 'done', args: { summary: 'ok' } },
    });
    const events: RunEvent[] = [];
    const ended = await startRun({
      prompt: 'read',
      config: { leaderModel: 'fake/l', followerModel: 'fake/f', observe: 'dom', planningInterval: 10, maxSteps: 5, inputFidelity: 'in-page' },
      tools: page,
      models: { leader, follower },
      onEvent: (event) => events.push(event),
      checkpointer: new MemorySaver(),
      runId: 'observation-url',
    }).done;

    expect(ended.status).toBe('done');
    expect(events.flatMap((e) => (e.kind === 'observation' ? [e.url] : []))).toEqual(urls);
  });

  it.each(['both', 'pixels'] as const)('a screenshot that times out in %s mode costs one observation, not the run', async (observe) => {
    class StalledCapture extends FakePageTools {
      override async screenshot(): Promise<never> {
        throw new Error('captureVisibleTab failed: captureVisibleTab did not answer in 20000ms');
      }
    }
    const page = new StalledCapture({ snapshots: [{ text: 'the results page', tokens: 4, url: 'https://shop.test/s?q=ram' }] });
    const leader = new FakeChatModel({ label: 'leader', respond: () => ({ kind: 'tool', name: 'set_plan', args: { plan: 'p', subgoals: ['s'] } }) });
    const follower = new FakeChatModel({ label: 'follower', respond: () => ({ kind: 'tool', name: 'done', args: { summary: 'ok' } }) });
    const events: RunEvent[] = [];
    const ended = await startRun({
      prompt: 'read',
      config: { leaderModel: 'fake/l', followerModel: 'fake/f', observe, planningInterval: 10, maxSteps: 5, inputFidelity: 'in-page' },
      tools: page,
      models: { leader, follower },
      onEvent: (event) => events.push(event),
      checkpointer: new MemorySaver(),
      runId: `stalled-capture-${observe}`,
    }).done;

    expect(ended.status).toBe('done');
    expect(events.find((e) => e.kind === 'observation')).toMatchObject({ hasScreenshot: false, url: 'https://shop.test/s?q=ram' });
    const prompt = JSON.stringify(follower.calls[0]!.messages);
    expect(prompt).toContain('No screenshot this step (captureVisibleTab failed');
    expect(prompt).toContain('the results page');
  });
});
