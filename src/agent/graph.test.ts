/**
 * R-03 and R-04 on the compiled graph.
 *
 * Each expected trace is a hand-checked literal for that test's inputs. Nothing
 * here calls the router to predict itself, so a wrong next actor fails the
 * literal instead of moving the oracle with the bug.
 */
import { AIMessage } from '@langchain/core/messages';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { tool } from '@langchain/core/tools';
import * as z from 'zod';
import { describe, expect, it } from 'vitest';
import { buildAgentGraph } from './graph';
import type { PageTools } from './tools';

type Signal = 'CONTINUE' | 'SUBGOAL_COMPLETE' | 'RETURN_TO_LEADER' | 'BLOCKED';

/** One node execution, after that node's update is applied to the running state. */
interface Visit {
  node: string;
  stepCount: number;
  stepsSinceReplan: number;
  lastSignal: string | null;
  status: string;
}

const look = tool(async () => 'saw the results page', {
  name: 'look',
  description: 'Read what is on the page.',
  schema: z.object({
    signal: z.string().optional(),
    note: z.string().optional(),
  }),
});

function unused(name: string) {
  return async () => {
    throw new Error(`page.${name} was called`);
  };
}

const page: PageTools = {
  snapshot: async () => ({ text: 'results page', tokens: 2 }),
  screenshot: unused('screenshot'),
  extractText: unused('extractText'),
  getBox: unused('getBox'),
  click: unused('click'),
  hover: unused('hover'),
  type: unused('type'),
  press: unused('press'),
  scroll: unused('scroll'),
  select: unused('select'),
  navigate: unused('navigate'),
  download: unused('download'),
  runUserscript: unused('runUserscript'),
  listUserscripts: unused('listUserscripts'),
  readUserscript: unused('readUserscript'),
  writeUserscript: unused('writeUserscript'),
  saveFile: unused('saveFile'),
  wait: unused('wait'),
  done: unused('done'),
  blocked: unused('blocked'),
};

function scriptedLeader(): BaseChatModel {
  let n = 0;
  const model = {
    model: 'scripted-leader',
    bindTools() {
      return model;
    },
    async invoke() {
      n += 1;
      return new AIMessage({
        content: '',
        tool_calls: [
          {
            id: `plan-${n}`,
            name: 'set_plan',
            args: {
              plan: 'Open the results and save the first one.',
              subgoals: ['Open the results page', 'Save the first result'],
              currentSubgoal: 0,
            },
            type: 'tool_call',
          },
        ],
      });
    },
  };
  return model as unknown as BaseChatModel;
}

function scriptedFollower(signals: readonly Signal[]): BaseChatModel {
  let n = 0;
  const model = {
    model: 'scripted-follower',
    bindTools() {
      return model;
    },
    async invoke() {
      const signal = signals[n];
      if (signal === undefined) {
        throw new Error(`follower kept acting after ${signals.length} scripted signals`);
      }
      n += 1;
      return new AIMessage({
        content: '',
        tool_calls: [
          {
            id: `look-${n}`,
            name: 'look',
            args: { signal, note: 'checked the page' },
            type: 'tool_call',
          },
        ],
      });
    },
  };
  return model as unknown as BaseChatModel;
}

/**
 * Runs the real graph. The models only supply the next tool call; the visits
 * are the nodes the graph actually scheduled.
 */
async function drive(planningInterval: number, maxSteps: number, signals: readonly Signal[]): Promise<Visit[]> {
  const context = {
    objective: 'Save the first result.',
    planningInterval,
    maxSteps,
    observe: 'dom' as const,
    readOnly: false,
    leaderModel: scriptedLeader(),
    followerModel: scriptedFollower(signals),
    toolset: { all: [look], byName: new Map([['look', look]]) },
    page,
    availableUserscripts: [],
    refreshUserscripts: async () => [],
  };
  const graph = buildAgentGraph();
  const stream = await graph.stream(
    {},
    { context, streamMode: 'updates', recursionLimit: 40 },
  );

  let stepCount = 0;
  let stepsSinceReplan = 0;
  let lastSignal: string | null = null;
  let status = 'running';
  const visits: Visit[] = [];

  for await (const chunk of stream) {
    if (chunk === null || typeof chunk !== 'object' || Array.isArray(chunk)) {
      throw new Error(`unexpected stream chunk ${JSON.stringify(chunk)}`);
    }
    const entries = Object.entries(chunk as Record<string, unknown>);
    if (entries.length !== 1) {
      throw new Error(`expected one node per update, saw ${entries.map(([key]) => key).join(', ')}`);
    }
    const [node, raw] = entries[0]!;
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error(`update from ${node} was not an object`);
    }
    const update = raw as Record<string, unknown>;
    if (typeof update.stepCount === 'number') stepCount = update.stepCount;
    if (typeof update.stepsSinceReplan === 'number') stepsSinceReplan = update.stepsSinceReplan;
    if ('lastSignal' in update) lastSignal = (update.lastSignal as string | null) ?? null;
    if (typeof update.status === 'string') status = update.status;
    visits.push({ node, stepCount, stepsSinceReplan, lastSignal, status });
  }

  return visits;
}

describe('follower signal and replan cadence', () => {
  // Interval 4 and budget 9 are the same in the four signal runs. Step 1 is
  // under both, so the next actor is the signal.
  it('fails if CONTINUE hands off: step 1 of interval 4 stays on the follower', async () => {
    const visits = await drive(4, 9, ['CONTINUE', 'CONTINUE', 'BLOCKED']);
    expect(visits).toEqual([
      { node: 'leader', stepCount: 0, stepsSinceReplan: 0, lastSignal: null, status: 'running' },
      { node: 'follower', stepCount: 1, stepsSinceReplan: 1, lastSignal: 'CONTINUE', status: 'running' },
      { node: 'follower', stepCount: 2, stepsSinceReplan: 2, lastSignal: 'CONTINUE', status: 'running' },
      { node: 'follower', stepCount: 3, stepsSinceReplan: 3, lastSignal: 'BLOCKED', status: 'blocked' },
    ]);
  });

  it('fails if SUBGOAL_COMPLETE is ignored: step 1 of interval 4 calls the leader', async () => {
    const visits = await drive(4, 9, ['SUBGOAL_COMPLETE', 'BLOCKED']);
    expect(visits).toEqual([
      { node: 'leader', stepCount: 0, stepsSinceReplan: 0, lastSignal: null, status: 'running' },
      { node: 'follower', stepCount: 1, stepsSinceReplan: 1, lastSignal: 'SUBGOAL_COMPLETE', status: 'running' },
      { node: 'leader', stepCount: 1, stepsSinceReplan: 0, lastSignal: 'SUBGOAL_COMPLETE', status: 'running' },
      { node: 'follower', stepCount: 2, stepsSinceReplan: 1, lastSignal: 'BLOCKED', status: 'blocked' },
    ]);
  });

  it('fails if RETURN_TO_LEADER is ignored: step 1 of interval 4 calls the leader', async () => {
    const visits = await drive(4, 9, ['RETURN_TO_LEADER', 'BLOCKED']);
    expect(visits).toEqual([
      { node: 'leader', stepCount: 0, stepsSinceReplan: 0, lastSignal: null, status: 'running' },
      { node: 'follower', stepCount: 1, stepsSinceReplan: 1, lastSignal: 'RETURN_TO_LEADER', status: 'running' },
      { node: 'leader', stepCount: 1, stepsSinceReplan: 0, lastSignal: 'RETURN_TO_LEADER', status: 'running' },
      { node: 'follower', stepCount: 2, stepsSinceReplan: 1, lastSignal: 'BLOCKED', status: 'blocked' },
    ]);
  });

  it('fails if BLOCKED keeps the run going: step 1 of interval 4 ends it', async () => {
    const visits = await drive(4, 9, ['BLOCKED', 'CONTINUE']);
    expect(visits).toEqual([
      { node: 'leader', stepCount: 0, stepsSinceReplan: 0, lastSignal: null, status: 'running' },
      { node: 'follower', stepCount: 1, stepsSinceReplan: 1, lastSignal: 'BLOCKED', status: 'blocked' },
    ]);
  });

  it('fails if the leader skips its interval: CONTINUE step 3 of interval 3 replans while maxSteps is 8', async () => {
    const visits = await drive(3, 8, ['CONTINUE', 'CONTINUE', 'CONTINUE', 'BLOCKED']);
    expect(visits).toEqual([
      { node: 'leader', stepCount: 0, stepsSinceReplan: 0, lastSignal: null, status: 'running' },
      { node: 'follower', stepCount: 1, stepsSinceReplan: 1, lastSignal: 'CONTINUE', status: 'running' },
      { node: 'follower', stepCount: 2, stepsSinceReplan: 2, lastSignal: 'CONTINUE', status: 'running' },
      { node: 'follower', stepCount: 3, stepsSinceReplan: 3, lastSignal: 'CONTINUE', status: 'running' },
      { node: 'leader', stepCount: 3, stepsSinceReplan: 0, lastSignal: 'CONTINUE', status: 'running' },
      { node: 'follower', stepCount: 4, stepsSinceReplan: 1, lastSignal: 'BLOCKED', status: 'blocked' },
    ]);
  });

  it('fails if maxSteps replans or does not stop: CONTINUE step 3 ends the run while the interval is 6', async () => {
    const visits = await drive(6, 3, ['CONTINUE', 'CONTINUE', 'CONTINUE', 'CONTINUE']);
    expect(visits).toEqual([
      { node: 'leader', stepCount: 0, stepsSinceReplan: 0, lastSignal: null, status: 'running' },
      { node: 'follower', stepCount: 1, stepsSinceReplan: 1, lastSignal: 'CONTINUE', status: 'running' },
      { node: 'follower', stepCount: 2, stepsSinceReplan: 2, lastSignal: 'CONTINUE', status: 'running' },
      { node: 'follower', stepCount: 3, stepsSinceReplan: 3, lastSignal: 'CONTINUE', status: 'max-steps' },
    ]);
  });

  it('fails if the interval outranks maxSteps: a CONTINUE step that reaches both 3s ends the run', async () => {
    const visits = await drive(3, 3, ['CONTINUE', 'CONTINUE', 'CONTINUE', 'CONTINUE']);
    expect(visits).toEqual([
      { node: 'leader', stepCount: 0, stepsSinceReplan: 0, lastSignal: null, status: 'running' },
      { node: 'follower', stepCount: 1, stepsSinceReplan: 1, lastSignal: 'CONTINUE', status: 'running' },
      { node: 'follower', stepCount: 2, stepsSinceReplan: 2, lastSignal: 'CONTINUE', status: 'running' },
      { node: 'follower', stepCount: 3, stepsSinceReplan: 3, lastSignal: 'CONTINUE', status: 'max-steps' },
    ]);
  });

  it('fails if maxSteps counts from the last replan: follower step 5 ends with the interval count at 1', async () => {
    const visits = await drive(2, 5, [
      'CONTINUE',
      'CONTINUE',
      'CONTINUE',
      'CONTINUE',
      'CONTINUE',
      'CONTINUE',
    ]);
    expect(visits).toEqual([
      { node: 'leader', stepCount: 0, stepsSinceReplan: 0, lastSignal: null, status: 'running' },
      { node: 'follower', stepCount: 1, stepsSinceReplan: 1, lastSignal: 'CONTINUE', status: 'running' },
      { node: 'follower', stepCount: 2, stepsSinceReplan: 2, lastSignal: 'CONTINUE', status: 'running' },
      { node: 'leader', stepCount: 2, stepsSinceReplan: 0, lastSignal: 'CONTINUE', status: 'running' },
      { node: 'follower', stepCount: 3, stepsSinceReplan: 1, lastSignal: 'CONTINUE', status: 'running' },
      { node: 'follower', stepCount: 4, stepsSinceReplan: 2, lastSignal: 'CONTINUE', status: 'running' },
      { node: 'leader', stepCount: 4, stepsSinceReplan: 0, lastSignal: 'CONTINUE', status: 'running' },
      { node: 'follower', stepCount: 5, stepsSinceReplan: 1, lastSignal: 'CONTINUE', status: 'max-steps' },
    ]);
  });
});
