// @vitest-environment jsdom
/**
 * The plan in #7 measured live eBay runs resending four copies of an ~18k-token
 * snapshot on every Follower call. This replays that shape against the eBay fixture:
 * a read-only extract_text loop, the page never changing, ten Follower calls.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MemorySaver } from '@langchain/langgraph/web';
import type { RunEvent } from '@/src/messaging/contract';
import { snapshot } from '@/src/page/snapshot';
import { promptChars } from '@/src/agent/graph';
import { FakeChatModel } from '@/src/agent/models';
import { FakePageTools } from '@/src/agent/tools';
import { startRun } from '@/src/agent/run';

const FIXTURE = resolve(process.cwd(), 'tests/fixtures/ebay-ddr5-current.html');
const TURNS = 10;

describe('Follower prompt size on the eBay fixture', () => {
  it("a ten-turn extract_text loop over the eBay fixture sends one snapshot's worth of page text per call", async () => {
    document.body.innerHTML = readFileSync(FIXTURE, 'utf8');
    const snap = snapshot();
    expect(snap.text.length).toBeGreaterThan(20_000);

    const page = new FakePageTools({ snapshots: [{ text: snap.text, tokens: snap.approxTokens }] });
    const leader = new FakeChatModel({
      label: 'leader',
      respond: () => ({ kind: 'tool', name: 'set_plan', args: { plan: 'read it', subgoals: ['read the list'] } }),
    });
    const follower = new FakeChatModel({
      label: 'follower',
      respond: (call) =>
        call.index < TURNS - 1
          ? { kind: 'tool', name: 'extract_text', args: { startChar: call.index * 1000, signal: 'CONTINUE' } }
          : { kind: 'tool', name: 'done', args: { summary: '{"count":60}' } },
    });
    const events: RunEvent[] = [];
    const ended = await startRun({
      prompt: 'read every listing',
      config: {
        leaderModel: 'fake/leader',
        followerModel: 'fake/follower',
        observe: 'dom',
        planningInterval: TURNS + 1,
        maxSteps: TURNS + 1,
        inputFidelity: 'in-page',
      },
      tools: page,
      models: { leader, follower },
      onEvent: (event) => events.push(event),
      checkpointer: new MemorySaver(),
      runId: 'ebay-snapshot-budget',
    }).done;

    expect(ended.status).toBe('done');
    expect(follower.calls).toHaveLength(TURNS);
    for (const call of follower.calls) {
      const copies = call.messages
        .flatMap((m) => (typeof m.content === 'string' ? [m.content] : m.content.map((b) => (b.type === 'text' ? String(b.text) : ''))))
        .filter((text) => text.includes(snap.text)).length;
      expect(copies).toBe(1);
      // One snapshot plus the system prompt, three short kept turns and their notes.
      expect(promptChars(call.messages)).toBeLessThan(snap.text.length + 6_000);
    }
    // The run log reports the same size the model was sent.
    const sizes = events.flatMap((e) => (e.kind === 'model.usage' && e.role === 'follower' ? [e.promptChars] : []));
    expect(sizes).toEqual(follower.calls.map((call) => promptChars(call.messages)));
  });
});
