#!/usr/bin/env node
/**
 * Live activities: realistic multi-step jobs on real shop-like sites, performed by the real
 * agent on the free model pair, scored only from what the run log shows the agent did.
 *
 *   node scripts/harness/activities.mjs list
 *   node scripts/harness/activities.mjs task  --activity <id>            -> {url, prompt, options}
 *   node scripts/harness/activities.mjs live  [--log <file>]             (stdin: nb-run stream)
 *   node scripts/harness/activities.mjs score --activity <id> --runlog <file>
 *        [--artifacts <dir>] [--json <out>] [--history <history.jsonl>]
 *
 * The default tested path is the generic set — browse, filter_sort, site_median,
 * compare_sites — which works on any shop-like site in sites.json. The ebay_* activities
 * are legacy: coupled to eBay URL params and sign-in quirks, they are listed as such and
 * building one takes an explicit `--legacy` on `task`. Scoring a saved legacy run needs no
 * opt-in — old runs keep their verdicts.
 *
 * `live` prints one line per step as events arrive. `score` prints the verdict, the
 * telemetry, and the workflow and token waste the log shows, and compares against the
 * last run of the same activity in --history. Exit status of `score`: 0 pass, 1 fail,
 * 3 invalid (the site, not the agent, made the run meaningless: a bot wall, signed out).
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/* ------------------------------------------------------------------ run-log reading */

export const readJsonl = (text) =>
  text
    .split('\n')
    .filter((l) => l.trim())
    .flatMap((l) => {
      try {
        return [JSON.parse(l)];
      } catch {
        return [];
      }
    });

const of = (events, kind) => events.filter((e) => e.kind === kind);
const resultOf = (events, call) =>
  events.find((e) => e.kind === 'tool.result' && e.result?.callId === call.call?.callId)?.result;
const calls = (events, name) => of(events, 'tool.call').filter((c) => !name || c.call?.name === name);
const okCalls = (events, name) => calls(events, name).filter((c) => resultOf(events, c)?.ok === true);

/**
 * Pages the agent actually landed on: the start URL and each observation.
 * A successful `navigate` does not count its requested target. A redirect to a
 * login page, a bot wall, or a 404 still reports `ok` for the request, and the
 * page that was reached shows up as the next observation.
 */
export function urlsVisited(events) {
  const urls = [];
  for (const e of events) {
    if (e.kind === 'run.started' && e.url) urls.push(e.url);
    if (e.kind === 'observation' && e.url) urls.push(e.url);
  }
  return [...new Set(urls)];
}

/** Text the log captured from a page: observation text, or a successful read's result. */
const READ_TOOLS = new Set(['snapshot', 'extract_text', 'leader_snapshot', 'leader_extract_text', 'run_userscript']);

function pageEvidence(events) {
  const parts = [];
  for (const e of events) {
    if (e.kind === 'observation') {
      for (const key of ['text', 'snapshot', 'content']) {
        if (typeof e[key] === 'string') parts.push(e[key]);
      }
    }
    if (e.kind !== 'tool.result' || e.result?.ok !== true) continue;
    if (e.result.name && !READ_TOOLS.has(e.result.name)) continue;
    if (typeof e.result.summary === 'string') parts.push(e.result.summary);
    if (typeof e.result.text === 'string') parts.push(e.result.text);
  }
  return parts.join('\n');
}

/** Dollar amounts written on a page, in the order they appear. */
function pricesRead(text) {
  const out = [];
  const re = /\$\s*(\d{1,7}(?:,\d{3})*(?:\.\d{1,2})?)/g;
  let m;
  while ((m = re.exec(text))) {
    const n = money(m[1]);
    if (Number.isFinite(n) && n > 0) out.push(n);
  }
  return out;
}

const closeMoney = (a, b) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) < 0.011;

function medianOf(nums) {
  if (!nums.length) return NaN;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

const parseUrl = (u) => {
  try {
    return new URL(u);
  } catch {
    return null;
  }
};

export function parseSummary(raw) {
  if (raw && typeof raw === 'object') return { ok: true, value: raw };
  if (typeof raw !== 'string') return { ok: false, error: 'no done summary' };
  for (const candidate of [raw, raw.match(/```(?:json)?\s*([\s\S]*?)```/)?.[1], raw.match(/(\[[\s\S]*\]|\{[\s\S]*\})/)?.[1]]) {
    if (!candidate) continue;
    try {
      return { ok: true, value: JSON.parse(candidate) };
    } catch {
      /* try the next shape */
    }
  }
  return { ok: false, error: 'summary is not JSON' };
}

/** "$1,234.50", "1234.5", 1234.5, "US $12.00" -> number; "Free" -> 0; otherwise NaN. */
export function money(v) {
  if (typeof v === 'number') return v;
  const s = String(v ?? '').trim();
  if (/^free/i.test(s)) return 0;
  const m = s.replace(/,/g, '').match(/-?\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : NaN;
}

const doneSummary = (events) => calls(events, 'done').at(-1)?.call?.args?.summary;
const ended = (events) => of(events, 'run.ended').at(-1);

const check = (name, ok, detail = '', weight = 1) => ({ name, ok: Boolean(ok), detail: String(detail), weight });

const WRITE_TOOLS = new Set(['click', 'hover', 'type', 'press', 'select', 'download', 'write_userscript']);

export const QUERIES = [
  'DDR4 32GB 3200 RAM',
  'DDR5 32GB RAM',
  'DDR4 ECC server memory',
  'RTX 3060 graphics card',
  'RX 6700 XT',
  'Ryzen 5 5600X',
  'Intel i7-12700K',
  '1TB NVMe SSD',
  '2TB SATA SSD',
  'ThinkPad T480',
  'Dell OptiPlex 7050',
  'used gaming PC',
];

const hostOf = (u) => (parseUrl(u)?.hostname ?? '').toLowerCase().replace(/^www\./, '');
const sameSite = (u, host) => {
  const h = hostOf(u);
  return Boolean(h) && (h === host || h.endsWith(`.${host}`));
};

export function titleMatches(title, query) {
  const tokens = new Set(String(title ?? '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
  const all = String(query ?? '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 2);
  const identifying = all.filter((w) => /\d/.test(w));
  const descriptive = all.filter((w) => !/\d/.test(w) && w.length >= 4);
  if (identifying.length === 0 && descriptive.length === 0) return false;
  if (!identifying.every((w) => tokens.has(w))) return false;
  if (!descriptive.length) return true;
  return descriptive.filter((w) => tokens.has(w)).length >= Math.ceil(descriptive.length * 0.6);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  console.error('incomplete harness');
  process.exit(2);
}
