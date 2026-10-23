/**
 * R-03 and R-04 on the compiled graph.
 *
 * Each expected trace is a hand-checked literal for that test's inputs. Nothing
 * here calls the router to predict itself, so a wrong next actor fails the
 * literal instead of moving the oracle with the bug.
 */
import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
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

function scriptedFollower(signals: readonly Signal[], prompts: string[] = []): BaseChatModel {
  let n = 0;
  const model = {
    model: 'scripted-follower',
    bindTools() {
      return model;
    },
    async invoke(sent: BaseMessage[]) {
      prompts.push(observationText(sent));
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

/** The text of the observation the Follower was just shown (the last message sent). */
function observationText(sent: BaseMessage[]): string {
  const last = sent[sent.length - 1];
  if (!(last instanceof HumanMessage)) return '';
  const { content } = last;
  if (typeof content === 'string') return content;
  return content.map((block) => (block.type === 'text' ? String(block.text) : '')).join('\n');
}

interface DriveOptions {
  page?: PageTools;
  observe?: 'dom' | 'pixels' | 'both';
  leaderModel?: BaseChatModel;
  /** Receives each Follower observation's text, in step order. */
  followerPrompts?: string[];
}

/**
 * Runs the real graph. The models only supply the next tool call; the visits
 * are the nodes the graph actually scheduled.
 */
async function drive(
  planningInterval: number,
  maxSteps: number,
  signals: readonly Signal[],
  options: DriveOptions = {},
): Promise<Visit[]> {
  const context = {
    objective: 'Save the first result.',
    planningInterval,
    maxSteps,
    observe: options.observe ?? ('dom' as const),
    readOnly: false,
    leaderModel: options.leaderModel ?? scriptedLeader(),
    followerModel: scriptedFollower(signals, options.followerPrompts),
    toolset: { all: [look], byName: new Map([['look', look]]) },
    page: options.page ?? page,
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

/**
 * A Leader whose first set_plan breaks the schema (no subgoals), then plans properly
 * if it is given another lap. Records what it was sent on each call.
 */
function leaderWithInvalidFirstPlan(sent: BaseMessage[][]): BaseChatModel {
  const model = {
    model: 'scripted-leader',
    bindTools() {
      return model;
    },
    async invoke(messages: BaseMessage[]) {
      sent.push([...messages]);
      const valid = sent.length > 1;
      return new AIMessage({
        content: '',
        tool_calls: [
          {
            id: `plan-${sent.length}`,
            name: 'set_plan',
            args: valid
              ? { plan: 'Open the results and save the first one.', subgoals: ['Open the results page'], currentSubgoal: 0 }
              : { plan: 'Open the results and save the first one.', subgoals: [] },
            type: 'tool_call',
          },
        ],
      });
    },
  };
  return model as unknown as BaseChatModel;
}

/**
 * A Leader that spends both evidence reads, hits the over-cap refusal, and only
 * then calls set_plan — invalid on the first try. Codex review on this PR: the
 * rejection lands on what was the final ordinary lap, and without a correction
 * lap the prose fallback hands the Follower the objective instead of the fixed
 * plan.
 */
function leaderRejectingPlanOnFinalLap(sent: BaseMessage[][]): BaseChatModel {
  const script: { name: string; args: Record<string, unknown> }[] = [
    { name: 'leader_snapshot', args: {} },
    { name: 'leader_snapshot', args: {} },
    // The read budget is spent, so this one is refused. It still consumes a lap.
    { name: 'leader_snapshot', args: {} },
    { name: 'set_plan', args: { plan: 'Open the results and save the first one.', subgoals: [] } },
    {
      name: 'set_plan',
      args: { plan: 'Open the results and save the first one.', subgoals: ['Open the results page'], currentSubgoal: 0 },
    },
  ];
  const model = {
    model: 'scripted-leader',
    bindTools() {
      return model;
    },
    async invoke(messages: BaseMessage[]) {
      sent.push([...messages]);
      const step = script[sent.length - 1];
      if (!step) throw new Error(`scripted leader ran past its ${script.length} scripted calls`);
      return new AIMessage({
        content: '',
        tool_calls: [{ id: `plan-${sent.length}`, name: step.name, args: step.args, type: 'tool_call' }],
      });
    },
  };
  return model as unknown as BaseChatModel;
}

/**
 * CodeAnt's variant on the same bug: the screenshot's vision retry consumes an
 * ordinary lap (invoke 2 throws on the image), one read takes another, and the
 * rejected set_plan again lands on the final lap.
 */
function leaderVisionRetryThenLatePlanRejection(sent: BaseMessage[][]): BaseChatModel {
  const script: { name: string; args: Record<string, unknown> }[] = [
    { name: 'leader_screenshot', args: {} },
    { name: 'leader_snapshot', args: {} },
    { name: 'set_plan', args: { plan: 'Open the results and save the first one.', subgoals: [] } },
    {
      name: 'set_plan',
      args: { plan: 'Open the results and save the first one.', subgoals: ['Open the results page'], currentSubgoal: 0 },
    },
  ];
  let calls = 0;
  const model = {
    model: 'scripted-leader',
    bindTools() {
      return model;
    },
    async invoke(messages: BaseMessage[]) {
      sent.push([...messages]);
      calls += 1;
      // The thrown call below still consumed a lap, so later calls map to the
      // script one slot earlier.
      if (calls === 2) throw new Error('provider rejected the request: image blocks are not supported by this model');
      const step = script[calls === 1 ? 0 : calls - 2];
      if (!step) throw new Error(`scripted leader ran past its ${script.length} scripted calls`);
      return new AIMessage({
        content: '',
        tool_calls: [{ id: `plan-${calls}`, name: step.name, args: step.args, type: 'tool_call' }],
      });
    },
  };
  return model as unknown as BaseChatModel;
}

const pixelsPage: PageTools = {
  ...page,
  screenshot: async () => ({ dataUrl: 'data:image/png;base64,cGxheA==', width: 4, height: 3 }),
};

describe('leader set_plan validation', () => {
  it('gives the leader another lap with the validation error when its set_plan breaks the schema', async () => {
    const leaderSent: BaseMessage[][] = [];
    const followerPrompts: string[] = [];
    const visits = await drive(4, 9, ['BLOCKED'], {
      leaderModel: leaderWithInvalidFirstPlan(leaderSent),
      followerPrompts,
    });

    expect(visits.map((v) => v.node)).toEqual(['leader', 'follower']);
    expect(leaderSent).toHaveLength(2);
    const failed = leaderSent[1]!.find(
      (m): m is ToolMessage => m instanceof ToolMessage && m.tool_call_id === 'plan-1',
    );
    expect(failed?.status).toBe('error');
    // The validator's own words, not just the retry hint, reach the Leader.
    expect(String(failed?.content)).toMatch(/did not match expected schema[\s\S]*→ at subgoals/);
    expect(followerPrompts[0]).toContain('Current subgoal: Open the results page');
  });

  it('reserves a correction lap when the rejected set_plan lands on the final ordinary lap', async () => {
    const leaderSent: BaseMessage[][] = [];
    const followerPrompts: string[] = [];
    const visits = await drive(4, 9, ['BLOCKED'], {
      leaderModel: leaderRejectingPlanOnFinalLap(leaderSent),
      followerPrompts,
    });

    expect(visits.map((v) => v.node)).toEqual(['leader', 'follower']);
    // read, read, refused read, rejected set_plan, corrected set_plan.
    expect(leaderSent).toHaveLength(5);
    expect(followerPrompts[0]).toContain('Current subgoal: Open the results page');
  });

  it('reserves a correction lap when a vision retry consumed an ordinary lap', async () => {
    const leaderSent: BaseMessage[][] = [];
    const followerPrompts: string[] = [];
    const visits = await drive(4, 9, ['BLOCKED'], {
      leaderModel: leaderVisionRetryThenLatePlanRejection(leaderSent),
      page: pixelsPage,
      observe: 'both',
      followerPrompts,
    });

    expect(visits.map((v) => v.node)).toEqual(['leader', 'follower']);
    // screenshot, vision-retry lap, read, rejected set_plan, corrected set_plan.
    expect(leaderSent).toHaveLength(5);
    expect(followerPrompts[0]).toContain('Current subgoal: Open the results page');
  });
});

function failingPage(): PageTools {
  return {
    ...page,
    snapshot: async () => {
      throw new Error('snapshot walk timed out');
    },
    screenshot: async () => {
      throw new Error('captureVisibleTab stalled');
    },
  };
}

function screenshotFailingPage(): PageTools {
  return {
    ...page,
    screenshot: async () => {
      throw new Error('captureVisibleTab stalled');
    },
  };
}

describe('follower observation failures', () => {
  it.each(['dom', 'both', 'pixels'] as const)(
    'keeps a %s run going when the page snapshot fails, until the step budget ends it',
    async (observe) => {
      const followerPrompts: string[] = [];
      const visits = await drive(6, 2, ['CONTINUE', 'CONTINUE', 'CONTINUE'], {
        page: failingPage(),
        observe,
        followerPrompts,
      });

      expect(visits).toEqual([
        { node: 'leader', stepCount: 0, stepsSinceReplan: 0, lastSignal: null, status: 'running' },
        { node: 'follower', stepCount: 1, stepsSinceReplan: 1, lastSignal: 'CONTINUE', status: 'running' },
        { node: 'follower', stepCount: 2, stepsSinceReplan: 2, lastSignal: 'CONTINUE', status: 'max-steps' },
      ]);
      expect(followerPrompts).toHaveLength(2);
      for (const prompt of followerPrompts) {
        expect(prompt).toContain('snapshot walk timed out');
        // With no snapshot taken, nothing in the prompt is current page text.
        expect(prompt).not.toContain('the page text above is current');
        expect(prompt).not.toContain('here is the page text instead');
      }
    },
  );

  it('resends the snapshot text on an unchanged step when the screenshot is lost', async () => {
    const followerPrompts: string[] = [];
    await drive(6, 2, ['CONTINUE', 'CONTINUE'], {
      page: screenshotFailingPage(),
      observe: 'both',
      followerPrompts,
    });

    // Step 2 repeats step 1's snapshot, so the unchanged note replaces the page
    // text. The lost screenshot must resend the snapshot or the Follower sees
    // no page at all.
    expect(followerPrompts[1]).toContain('Page unchanged since step 1');
    expect(followerPrompts[1]).toContain('results page');
    expect(followerPrompts[1]).toContain('the page text above is current');
  });
});
