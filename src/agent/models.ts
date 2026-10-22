/**
 * Model handles for the graph.
 *
 * `createChatModel` builds a `ChatOpenAI` pointed at an OpenRouter-shaped
 * endpoint. The extension never holds the user's key (R-12): the `fetch` passed
 * in belongs to the host proxy, which attaches the real credential on its way
 * out. `apiKey` here is a non-secret placeholder only because the underlying
 * openai client refuses to construct without one.
 *
 * No `provider.data_collection` is sent: which endpoints may serve a request is
 * left to the user's OpenRouter privacy settings. A per-request "deny" for paid
 * models used to sit here and 404'd any paid model whose only endpoint trains on
 * prompts (meta/muse-spark-1.3-contributor), a restriction the user never asked for.
 */
import { ChatOpenAI } from '@langchain/openai';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { BaseChatModelParams } from '@langchain/core/language_models/chat_models';
import type { BindToolsInput } from '@langchain/core/language_models/chat_models';
import type { BaseLanguageModelInput } from '@langchain/core/language_models/base';
import { AIMessage, type AIMessageChunk, type BaseMessage, type UsageMetadata } from '@langchain/core/messages';
import type { ChatResult } from '@langchain/core/outputs';
import type { Runnable } from '@langchain/core/runnables';
import type { ModelSource } from '@/src/storage';

/** Sentinel key. The real credential is added by the host proxy behind `fetch` (R-12). */
export const PROXY_MANAGED_KEY = 'host-proxy-managed';

export const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';
/** Kilo AI Gateway: OpenAI-compatible, same client, different base and credential. */
export const KILO_BASE_URL = 'https://api.kilo.ai/api/gateway';

function baseUrlFor(source: ModelSource): string {
  return source === 'kilo' ? KILO_BASE_URL : DEFAULT_BASE_URL;
}

/**
 * Waits between retries of a rate-limited model call: about a minute in all. LangChain
 * core (1.2.12) stops at once on a 429 with no Retry-After header ("headerless_429",
 * classed as capacity, not retried), and that is exactly what OpenRouter's free tier
 * sends. Live, one such 429 ended runs on gemma-4 and laguna after 0 to 4 steps.
 */
export const RATE_LIMIT_DELAYS_MS: readonly number[] = [2_000, 4_000, 8_000, 16_000, 30_000];

/** Short waits for a 500/502/503/504/529 or a dropped connection. Separate from the 429 budget. */
export const TRANSIENT_DELAYS_MS: readonly number[] = [400, 800];

export const DEFAULT_REQUEST_TIMEOUT_MS = 300_000;

function requestTimeoutMs(value: unknown): number {
  const ms = Number(value);
  return Number.isInteger(ms) && ms > 0 && ms <= 86_400_000 ? ms : DEFAULT_REQUEST_TIMEOUT_MS;
}

/** A fresh deadline per attempt, including body consumption by the response hardener. */
export function withRequestTimeout(fetch: typeof globalThis.fetch, timeoutMs: number): typeof globalThis.fetch {
  return async (input, init) => {
    const deadline = new AbortController();
    const caller = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    const signal = caller ? AbortSignal.any([caller, deadline.signal]) : deadline.signal;
    const timer = setTimeout(() => deadline.abort(new DOMException(
      `Model request timed out after ${timeoutMs}ms`, 'TimeoutError',
    )), timeoutMs);
    try {
      return await fetch(input, { ...init, signal });
    } catch (error) {
      // The host transport reports all aborts as AbortError; retain the deadline reason.
      throw signal.aborted ? signal.reason : error;
    } finally {
      clearTimeout(timer);
    }
  };
}

const TRANSIENT_STATUS = new Set([500, 502, 503, 504, 529]);

/**
 * Retries 429s itself, honouring Retry-After (capped at 60 s), and stops waiting on abort.
 * Transient 5xx responses and transport failures get their own short schedule so
 * `maxRetries: 0` does not drop them, and they do not rerun the one-minute 429 budget.
 */
export function retryRateLimited(
  fetch: typeof globalThis.fetch,
  delaysMs: readonly number[] = RATE_LIMIT_DELAYS_MS,
  transientDelaysMs: readonly number[] = TRANSIENT_DELAYS_MS,
): typeof globalThis.fetch {
  // Honour each Retry-After, but the waits together stay inside the schedule
  // (about a minute for the default delays). A provider that sends Retry-After: 60
  // on every 429 would otherwise hold the call for several minutes.
  const budgetMs = delaysMs.reduce((sum, ms) => sum + ms, 0);
  return async (input, init) => {
    let waited = 0;
    let rateAttempts = 0;
    let transientAttempts = 0;
    const signal = init?.signal ?? undefined;
    for (;;) {
      if (signal?.aborted) throw signal.reason ?? new Error('aborted');
      let res: Response;
      try {
        res = await fetch(input, init);
      } catch (error) {
        if (transientAttempts >= transientDelaysMs.length) throw error;
        const wait = transientDelaysMs[transientAttempts] ?? 0;
        transientAttempts += 1;
        if (wait > 0) await sleep(wait, signal);
        continue;
      }
      if (TRANSIENT_STATUS.has(res.status) && transientAttempts < transientDelaysMs.length) {
        const wait = transientDelaysMs[transientAttempts] ?? 0;
        transientAttempts += 1;
        await res.body?.cancel().catch(() => undefined);
        if (wait > 0) await sleep(wait, signal);
        continue;
      }
      if (res.status !== 429 || rateAttempts >= delaysMs.length) return res;
      // A Retry-After of 0 needs none of the budget. Checking the budget first
      // dropped that immediate retry once an earlier wait had used it up, and
      // dropped every retry when the test delays were all zero.
      const requested = retryAfterDelayMs(res.headers.get('retry-after'), delaysMs[rateAttempts]!);
      if (requested > 0 && waited >= budgetMs) return res;
      const wait = Math.min(requested, Math.max(0, budgetMs - waited));
      rateAttempts += 1;
      await res.body?.cancel().catch(() => undefined);
      waited += wait;
      if (wait > 0) await sleep(wait, signal);
    }
  };
}

/** Delay to the next attempt, in milliseconds, from one 429's Retry-After header. */
export function retryAfterDelayMs(headerValue: string | null, fallbackMs: number): number {
  const raw = headerValue?.trim();
  if (!raw) return fallbackMs;
  if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw) > 0 ? Math.min(Number(raw) * 1000, 60_000) : 0;
  const date = Date.parse(raw);
  if (Number.isNaN(date)) return fallbackMs;
  // A provider-issued date in the past is the same "go again now" as a 0.
  return date > Date.now() ? Math.min(date - Date.now(), 60_000) : 0;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error('aborted'));
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error('aborted'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export interface CreateChatModelOptions {
  /** The provider's own model id, e.g. "nvidia/nemotron-3.5-lightning:free". Never prefixed with a source. */
  model: string;
  /** The host proxy's fetch. Every request goes through it; it holds the key. */
  fetch: typeof globalThis.fetch;
  /** Which catalog this model came from. Absent defaults to OpenRouter (R-11 continuity: old stored configs never named a source). */
  source?: ModelSource;
  baseURL?: string;
  temperature?: number;
  /** Test seam: waits between rate-limit retries. */
  rateLimitDelaysMs?: readonly number[];
  /** Per-attempt deadline. Defaults to WXT_LLM_TIMEOUT_MS, or five minutes. */
  requestTimeoutMs?: number;
}

/**
 * OpenRouter reports upstream provider failures (and free-tier hiccups) as an
 * HTTP 200 whose JSON body is `{ error: { code, message } }` or simply lacks
 * `choices`. The openai SDK only retries on real error statuses, and LangChain
 * dereferences `choices[0]` and dies with "reading 'message'" otherwise (seen
 * live against `nvidia/nemotron-3-ultra-550b-a55b:free`, 2026-09-03). This
 * rewrites such replies into the status they should have carried so the
 * wrapper's retry policy (429, and a short schedule for 5xx) engages.
 *
 * OpenRouter-specific: this is a quirk of *OpenRouter's* proxying (it forwards a
 * failed upstream provider call as if it succeeded). There is no live evidence
 * Kilo does the same -- a real Kilo chat/completions call returned a normal
 * `finish_reason: tool_calls` with no such wrapping -- so `createChatModel` below
 * applies this only to the OpenRouter source and leaves Kilo's `fetch` untouched
 * rather than assume the same failure mode without evidence for it.
 */
export function hardenEmptyChoices(fetch: typeof globalThis.fetch): typeof globalThis.fetch {
  return async (input, init) => {
    const res = await fetch(input, init);
    if (res.status !== 200) return res;
    const contentType = res.headers.get('content-type') ?? '';
    if (!contentType.includes('application/json')) return res;
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return errorResponse(502, 'openrouter returned unparseable JSON', res.headers);
    }
    const obj = parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : undefined;
    const error = obj?.error as { code?: unknown; message?: unknown } | undefined;
    if (error && typeof error === 'object') {
      const code = typeof error.code === 'number' && error.code >= 400 && error.code < 600 ? error.code : 502;
      return errorResponse(code, typeof error.message === 'string' ? error.message : 'provider error', res.headers);
    }
    if (obj && !Array.isArray(obj.choices) && obj.object !== 'list') {
      return errorResponse(502, `openrouter reply has no choices: ${text.slice(0, 200)}`, res.headers);
    }
    return new Response(text, { status: res.status, statusText: res.statusText, headers: res.headers });
  };
}

function errorResponse(status: number, message: string, upstream: Headers): Response {
  const headers = new Headers(upstream);
  headers.set('content-type', 'application/json');
  return new Response(JSON.stringify({ error: { message, code: status } }), { status, headers });
}

/**
 * No `maxTokens`/completion cap is set here, and none should be added casually: a
 * low cap silently breaks a reasoning model before it reaches its tool call (seen
 * live against `meta/muse-spark-1.3-contributor` via Kilo -- a 400-token cap
 * produced `finish_reason: length` with empty content and no tool call; 3000
 * tokens let it emit a correct tool call after 682 reasoning tokens). Reasoning
 * tokens count against whatever cap is set, so any future cap must budget for
 * them, not just the visible completion.
 */
export function createChatModel(options: CreateChatModelOptions): ChatOpenAI {
  const { model, fetch, source = 'openrouter', baseURL = baseUrlFor(source), temperature = 0, rateLimitDelaysMs } = options;
  const timeoutMs = requestTimeoutMs(options.requestTimeoutMs ?? import.meta.env.WXT_LLM_TIMEOUT_MS);
  const rateBudget = (rateLimitDelaysMs ?? RATE_LIMIT_DELAYS_MS).reduce((sum, ms) => sum + ms, 0);
  return new ChatOpenAI({
    model,
    temperature,
    apiKey: PROXY_MANAGED_KEY,
    // 429s are retried only inside retryRateLimited, which already spends the
    // one-minute budget. Leaving LangChain's default retries on would run that
    // whole schedule again for each SDK attempt.
    maxRetries: 0,
    // The SDK wraps the whole fetch/retry loop in one signal. Its outer deadline
    // must leave room for every attempt; the inner deadline resets on each retry.
    timeout: timeoutMs * (1 + TRANSIENT_DELAYS_MS.length + (rateLimitDelaysMs ?? RATE_LIMIT_DELAYS_MS).length)
      + rateBudget + TRANSIENT_DELAYS_MS.reduce((sum, ms) => sum + ms, 0) + 1_000,
    // Applied to BOTH gateways. It was OpenRouter-only on the reasoning that Kilo had
    // shown no such quirk; then the free Nemotron pair on Kilo failed a live eBay run with
    // "Cannot read properties of undefined (reading 'message')", which is LangChain
    // dereferencing `generations[0][0]` after a 200 with no `choices`. The check is
    // provider-agnostic, so there is no reason to leave either gateway unguarded.
    // Retry outside the hardening, so a 429 reported inside a 200 body is retried too.
    configuration: { baseURL, fetch: retryRateLimited(withRequestTimeout(hardenEmptyChoices(fetch), timeoutMs), rateLimitDelaysMs) },
  });
}

/* ------------------------------------------------------------------------- */
/* Test double                                                               */
/* ------------------------------------------------------------------------- */

/** One scripted model turn: plain text, a single tool call, or a batched pair. */
export type FakeTurn =
  | { kind: 'text'; text: string }
  | { kind: 'tool'; name: string; args: Record<string, unknown>; text?: string }
  | { kind: 'tools'; calls: { name: string; args: Record<string, unknown> }[]; text?: string };

export interface FakeCall {
  /** Zero-based index of this call on this model instance. */
  index: number;
  messages: BaseMessage[];
  /** Names of the tools bound at the time of the call. */
  tools: string[];
}

export interface FakeChatModelInit extends BaseChatModelParams {
  /** Turns played in order. The last one repeats once the list is exhausted. */
  turns?: FakeTurn[];
  /** Takes precedence over `turns` when present. */
  respond?: (call: FakeCall) => FakeTurn;
  label?: string;
  /**
   * What the fake reports as provider usage, set on the reply exactly where
   * `@langchain/openai` puts it. Absent means the provider reported nothing.
   */
  usage?: UsageMetadata | ((call: FakeCall) => UsageMetadata | undefined);
}

/**
 * A `BaseChatModel` that never touches the network.
 *
 * Supports `bindTools` and scripts the Follower's structured signal by putting it
 * in the tool-call arguments, exactly where a real tool-calling model puts it.
 */
export class FakeChatModel extends BaseChatModel {
  /** Every call this instance received, in order. Assert history separation on it. */
  readonly calls: FakeCall[] = [];

  readonly label: string;

  #turns: FakeTurn[];
  #respond?: (call: FakeCall) => FakeTurn;
  #usage?: FakeChatModelInit['usage'];
  #boundTools: string[] = [];
  #toolCallSeq = 0;

  constructor(init: FakeChatModelInit = {}) {
    super(init);
    this.#turns = init.turns ?? [{ kind: 'text', text: 'ok' }];
    this.#respond = init.respond;
    this.#usage = init.usage;
    this.label = init.label ?? 'fake';
  }

  _llmType(): string {
    return 'fake';
  }

  override bindTools(
    tools: BindToolsInput[],
  ): Runnable<BaseLanguageModelInput, AIMessageChunk, this['ParsedCallOptions']> {
    this.#boundTools = tools.map((t) =>
      typeof t === 'object' && t !== null && 'name' in t ? String(t.name) : 'unknown',
    );
    // The fake answers directly; nothing downstream needs a distinct bound object.
    return this as unknown as Runnable<
      BaseLanguageModelInput,
      AIMessageChunk,
      this['ParsedCallOptions']
    >;
  }

  /** The tool names most recently bound. */
  get boundTools(): string[] {
    return [...this.#boundTools];
  }

  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    const result = this.#reply(messages);
    const message = result.generations[0]?.message;
    const usage = typeof this.#usage === 'function' ? this.#usage(this.calls.at(-1)!) : this.#usage;
    if (message instanceof AIMessage && usage) message.usage_metadata = usage;
    return result;
  }

  #reply(messages: BaseMessage[]): ChatResult {
    const call: FakeCall = {
      index: this.calls.length,
      messages,
      tools: [...this.#boundTools],
    };
    this.calls.push(call);

    const turn =
      this.#respond?.(call) ??
      this.#turns[Math.min(call.index, this.#turns.length - 1)] ??
      ({ kind: 'text', text: 'ok' } satisfies FakeTurn);

    if (turn.kind === 'text') {
      const message = new AIMessage({ content: turn.text });
      return { generations: [{ text: turn.text, message }] };
    }

    if (turn.kind === 'tools') {
      const message = new AIMessage({
        content: turn.text ?? '',
        tool_calls: turn.calls.map((c) => {
          this.#toolCallSeq += 1;
          return {
            id: `${this.label}-call-${this.#toolCallSeq}`,
            name: c.name,
            args: c.args,
            type: 'tool_call' as const,
          };
        }),
      });
      return { generations: [{ text: turn.text ?? '', message }] };
    }

    this.#toolCallSeq += 1;
    const text = turn.text ?? '';
    const message = new AIMessage({
      content: text,
      tool_calls: [
        {
          id: `${this.label}-call-${this.#toolCallSeq}`,
          name: turn.name,
          args: turn.args,
          type: 'tool_call',
        },
      ],
    });
    return { generations: [{ text, message }] };
  }
}

/** @deprecated Use {@link hardenEmptyChoices}; the quirk is not OpenRouter's alone. */
export const hardenOpenRouterFetch = hardenEmptyChoices;
