// @vitest-environment jsdom
/**
 * The plan in #7 measured live eBay runs resending four copies of an ~18k-token
 * snapshot on every Follower call. This replays that shape against the eBay fixture:
 * a read-only extract_text loop, ten Follower calls.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MemorySaver } from '@langchain/langgraph/web';
import type { RunEvent } from '@/src/messaging/contract';
import { snapshot } from '@/src/page/snapshot';
import { promptChars } from '@/src/agent/graph';
import { FakeChatModel, type FakeCall } from '@/src/agent/models';
import { FakePageTools } from '@/src/agent/tools';
import { startRun } from '@/src/agent/run';

const FIXTURE = resolve(process.cwd(), 'tests/fixtures/ebay-ddr5-current.html');
const TURNS = 10;

function fixtureSnapshot(): string {
  document.body.innerHTML = readFileSync(FIXTURE, 'utf8');
  const text = snapshot().text;
  expect(text.length).toBeGreaterThan(20_000);
  return text;
}

async function readLoop(snapshots: string[]): Promise<{ follower: FakeChatModel; events: RunEvent[] }> {
  const page = new FakePageTools({ snapshots: snapshots.map((text) => ({ text, tokens: Math.ceil(text.length / 4) })) });
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
    runId: `ebay-snapshot-budget-${snapshots.length}`,
  }).done;
  expect(ended.status).toBe('done');
  expect(follower.calls).toHaveLength(TURNS);
  return { follower, events };
}

/** Text blocks in a call's prompt that carry the fixture's snapshot. */
function copiesIn(call: FakeCall, text: string): number {
  return call.messages
    .flatMap((m) => (typeof m.content === 'string' ? [m.content] : m.content.map((b) => (b.type === 'text' ? String(b.text) : ''))))
    .filter((block) => block.includes(text)).length;
}

describe('Follower prompt size on the eBay fixture', () => {
  it("a ten-turn extract_text loop over the eBay fixture sends one snapshot's worth of page text per call", async () => {
    const text = fixtureSnapshot();
    // A marker that changes every turn keeps each observation a fresh snapshot, so
    // this measures the one-copy rule alone, apart from the unchanged-page note.
    const { follower, events } = await readLoop(Array.from({ length: TURNS }, (_, i) => `${text}\nread ${i}`));

    for (const call of follower.calls) {
      expect(copiesIn(call, text)).toBe(1);
      // One snapshot plus the system prompt, three short kept turns and their notes.
      expect(promptChars(call.messages)).toBeLessThan(text.length + 6_000);
    }
    // The run log reports the same size the model was sent.
    const sizes = events.flatMap((e) => (e.kind === 'model.usage' && e.role === 'follower' ? [e.promptChars] : []));
    expect(sizes).toEqual(follower.calls.map((call) => promptChars(call.messages)));
  });

  it('a ten-turn read loop over an unchanged eBay page sends its snapshot once for the whole run', async () => {
    const text = fixtureSnapshot();
    const { follower } = await readLoop([text]);

    expect(follower.calls.map((call) => copiesIn(call, text))).toEqual([1, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    const total = follower.calls.reduce((sum, call) => sum + promptChars(call.messages), 0);
    // One snapshot for the run; every other call is the system prompt and three short
    // kept turns (measured ~2.8k chars each). Before #7 this loop sent ~864k.
    expect(total).toBeLessThan(text.length + TURNS * 3_500);
  });
});
