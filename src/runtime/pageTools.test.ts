import { describe, expect, it } from 'vitest';
import type { BaseMessage } from '@langchain/core/messages';
import { MemorySaver } from '@langchain/langgraph/web';
import { buildAgentGraph } from '@/src/agent/graph';
import { FakeChatModel } from '@/src/agent/models';
import { createPageToolset } from '@/src/agent/tools';
import { DebuggerInputTier, type DebuggerApi, type DebuggerTarget } from '@/src/input/debugger';
import type { ObserveMode } from '@/src/storage';
import {
  EscalatableInput,
  createInPageTier,
  createInputPagePort,
  createPageTools,
  type RuntimeDriver,
} from './pageTools';

/** Text only the DOM snapshot returns. A pixels-only run must not be shown it. */
const DOM_SNAPSHOT = 'the purchase control is the only button';
/** Image only the screenshot returns. A DOM-only run must not be shown it. */
const PIXEL_URL = 'data:image/png;base64,cGl4ZWw=';

/**
 * Box handed to the escalated tier, and the viewport point of a click on it.
 *
 * Centre of 100,200 40×20 is 120,210. The run's rng returns 0 for the two jitter
 * samples, so each offset is −1 × half-extent × 0.35: −7 and −3.5. The click
 * lands at 113, 206.5. Those two numbers are computed here, not by the jitter helper.
 */
const BOX = { x: 100, y: 200, width: 40, height: 20 };
const CLICK_X = 113;
const CLICK_Y = 206.5;
const TAB = 11;
const REF = 'e12';

class PageDouble implements RuntimeDriver {
  readonly clicks: Array<{ tabId: number; ref: string }> = [];

  async snapshot() {
    return {
      ok: true,
      text: DOM_SNAPSHOT,
      nodes: 1,
      truncated: false,
      approxTokens: 8,
      url: 'https://shop.test/cart',
      title: 'Cart',
    };
  }

  async screenshot() {
    return {
      ok: true,
      dataUrl: PIXEL_URL,
      width: 641,
      height: 479,
      devicePixelRatio: 1,
      deviceWidth: 641,
      deviceHeight: 479,
    };
  }

  async extractText() {
    return { ok: true, text: '' };
  }

  async click(tabId: number, ref: string) {
    this.clicks.push({ tabId, ref });
    return { ok: true };
  }

  async type() {
    return { ok: true };
  }

  async press() {
    return { ok: true };
  }

  async select() {
    return { ok: true };
  }

  async scroll() {
    return { ok: true };
  }

  async hover() {
    return { ok: true };
  }

  async ping_() {
    return { ok: true, width: 641, height: 479 };
  }

  async getBox() {
    return { ok: true, box: { ...BOX, centerX: 120, centerY: 210 } };
  }

  async navigate() {
    return { ok: true };
  }

  async download() {
    return { ok: true, downloadId: 1 };
  }

  async saveFile() {
    return { ok: true, downloadId: 2 };
  }
}

function textOf(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(textOf).join('\n');
  if (value && typeof value === 'object') return Object.values(value).map(textOf).join('\n');
  return '';
}

function followerWasShown(messages: BaseMessage[]): string {
  return messages.map((message) => textOf(message.content)).join('\n');
}

/** Two rng samples of 0 (the click's jitter), then a steady non-zero for the pointer path. */
function clickRng(): () => number {
  let drawn = 0;
  return () => {
    drawn += 1;
    return drawn <= 2 ? 0 : 0.4;
  };
}

function debuggerPort() {
  const attached: DebuggerTarget[] = [];
  const commands: Array<{ method: string; params?: Record<string, unknown> }> = [];
  const api: DebuggerApi = {
    async attach(target) {
      attached.push(target);
    },
    async detach() {},
    async sendCommand(_target, method, params) {
      commands.push({ method, params });
    },
    onDetach: {
      addListener() {},
      removeListener() {},
    },
  };
  return { api, attached, commands };
}

async function runToldToObserve(observe: ObserveMode): Promise<string> {
  const driver = new PageDouble();
  const input = new EscalatableInput({
    fidelity: 'in-page',
    inPageTier: createInPageTier(driver),
    page: createInputPagePort(driver, TAB),
    emit: () => {},
  });
  const page = createPageTools({
    tabId: TAB,
    driver,
    input,
    observe,
    emit: () => {},
    runUserscript: async () => {
      throw new Error('this run only observes');
    },
  });
  const graph = buildAgentGraph(new MemorySaver());
  const state = await graph.invoke(
    { status: 'running' },
    {
      configurable: { thread_id: `observe-${observe}` },
      recursionLimit: 25,
      context: {
        objective: 'see the cart',
        planningInterval: 4,
        maxSteps: 2,
        observe,
        readOnly: false,
        leaderModel: new FakeChatModel({
          label: 'leader',
          turns: [
            {
              kind: 'tool',
              name: 'set_plan',
              args: { plan: 'look once', subgoals: ['look at the cart'], currentSubgoal: 0 },
            },
          ],
        }),
        followerModel: new FakeChatModel({
          label: 'follower',
          turns: [{ kind: 'tool', name: 'done', args: { summary: 'looked' } }],
        }),
        toolset: createPageToolset(page),
        page,
        availableUserscripts: [],
        refreshUserscripts: async () => [],
      },
    },
  );
  return followerWasShown(state.followerMessages);
}

describe('observe mode is the run argument (R-08)', () => {
  it('hardcoding observe to pixels or both would drop the DOM snapshot or add a screenshot when the run is told to observe dom', async () => {
    const shown = await runToldToObserve('dom');
    expect(shown).toContain(DOM_SNAPSHOT);
    expect(shown).not.toContain(PIXEL_URL);
  });

  it('hardcoding observe to dom or both would drop the screenshot or add a DOM snapshot when the run is told to observe pixels', async () => {
    const shown = await runToldToObserve('pixels');
    expect(shown).toContain(PIXEL_URL);
    expect(shown).not.toContain(DOM_SNAPSHOT);
  });

  it('hardcoding observe to dom or pixels would drop either the snapshot or the screenshot when the run is told to observe both', async () => {
    const shown = await runToldToObserve('both');
    expect(shown).toContain(DOM_SNAPSHOT);
    expect(shown).toContain(PIXEL_URL);
  });
});

function toolsAt(fidelity: 'in-page' | 'escalated') {
  const driver = new PageDouble();
  const port = debuggerPort();
  const rng = clickRng();
  const input = new EscalatableInput({
    fidelity,
    inPageTier: createInPageTier(driver),
    debuggerTier: new DebuggerInputTier(port.api, { rng, sleep: async () => {} }),
    page: createInputPagePort(driver, TAB),
    emit: () => {},
    rng,
  });
  const tools = createPageTools({
    tabId: TAB,
    driver,
    input,
    observe: 'dom',
    emit: () => {},
    runUserscript: async () => {
      throw new Error('this run only clicks');
    },
  });
  return { driver, port, input, tools };
}

describe('click fidelity is the run argument (R-13)', () => {
  it('sending the default click to the debugger tier would address a viewport point and raise the debugging banner', async () => {
    const { driver, port, input, tools } = toolsAt('in-page');
    await input.attach(TAB);
    await tools.click(REF);

    expect(driver.clicks).toEqual([{ tabId: TAB, ref: REF }]);
    expect(port.attached).toEqual([]);
    expect(port.commands).toEqual([]);
  });

  it('sending an escalated click to the in-page tier would address the element ref instead of its viewport point', async () => {
    const { driver, port, input, tools } = toolsAt('escalated');
    await input.attach(TAB);
    await tools.click(REF);

    expect(driver.clicks).toEqual([]);
    expect(port.attached).toEqual([{ tabId: TAB }]);
    const pressed = port.commands.filter(
      (command) => command.method === 'Input.dispatchMouseEvent' && command.params?.type === 'mousePressed',
    );
    expect(pressed).toEqual([
      {
        method: 'Input.dispatchMouseEvent',
        params: expect.objectContaining({ type: 'mousePressed', x: CLICK_X, y: CLICK_Y }),
      },
    ]);
  });
});
