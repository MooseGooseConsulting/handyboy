import type { Role } from '@/src/messaging';

export function formatTime(at: number): string {
  const date = new Date(at);
  const pad = (n: number, width = 2) => String(n).padStart(width, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)}s`;
}

/**
 * Elapsed time relative to the run's own start (Requirement 4), e.g. `+12.4s`. A run
 * long enough to cross a minute switches to `+1m04s` rather than `+64.0s`. Negative
 * deltas (a clock skew, or an event that raced `run.started`) still render rather than
 * throwing something unreadable at the user.
 */
export function formatElapsed(deltaMs: number): string {
  const sign = deltaMs < 0 ? '-' : '+';
  const abs = Math.abs(deltaMs);
  if (abs < 60_000) return `${sign}${(abs / 1000).toFixed(1)}s`;
  const totalSeconds = Math.floor(abs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${sign}${minutes}m${String(seconds).padStart(2, '0')}s`;
}

export function roleLabel(role: Role): string {
  return role === 'leader' ? 'Leader' : 'Follower';
}

/**
 * A one-line preview of a tool call's key arguments for its collapsed card
 * (Requirement 4: "name, key args, ok/error, duration"). The full, pretty-printed
 * arguments still live behind the expand — this is only a glance.
 */
export function summarizeArgs(args: unknown, limit = 48): string | undefined {
  if (args === undefined || args === null || typeof args !== 'object') return undefined;
  const entries = Object.entries(args as Record<string, unknown>);
  if (entries.length === 0) return undefined;
  const text = entries
    .map(([key, value]) => `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`)
    .join(' ');
  return text.length > limit ? `${text.slice(0, limit).trimEnd()}…` : text;
}

/**
 * Pretty-prints tool arguments for the collapsible card (R-06). Non-serialisable values
 * (a cyclic object from a badly-behaved tool) must never take the panel down.
 */
export function prettyJson(value: unknown): string {
  if (value === undefined) return 'undefined';
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

/** Thousands separators, fixed to one locale so the panel and its tests agree. */
export function formatCount(n: number): string {
  return n.toLocaleString('en-US');
}

export interface UsageNumbers {
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  cachedTokens?: number;
  promptChars: number;
}

/**
 * The pieces of a usage line, shared by the per-call entry and the result card's
 * totals so the two never word the same number differently. Counts the provider did
 * not report are left out rather than shown as zero, which would read as free.
 */
export function usageParts(usage: UsageNumbers): string[] {
  const parts: string[] = [];
  if (usage.inputTokens !== undefined) parts.push(`${formatCount(usage.inputTokens)} in`);
  if (usage.outputTokens !== undefined) parts.push(`${formatCount(usage.outputTokens)} out`);
  if (usage.reasoningTokens !== undefined) parts.push(`${formatCount(usage.reasoningTokens)} reasoning`);
  if (usage.cachedTokens !== undefined) parts.push(`${formatCount(usage.cachedTokens)} cached`);
  if (parts.length === 0) parts.push('no provider token count');
  parts.push(`${formatCount(usage.promptChars)} prompt chars`);
  return parts;
}
