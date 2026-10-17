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

/* ------------------------------------------------------------------ activities */

/**
 * Used-hardware queries the browse activity rotates through.
 */
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
/** Same site: the host or any subdomain of it (shop.example.com counts for example.com).
 *  Not the other way round: a visit to the bare example.com is not evidence of reaching
 *  the site whose host is shop.example.com. */
const sameSite = (u, host) => {
  const h = hostOf(u);
  return Boolean(h) && (h === host || h.endsWith(`.${host}`));
};
const pageKey = (u) => {
  const p = parseUrl(u);
  return p ? `${p.hostname.replace(/^www\./, '')}${p.pathname.replace(/\/$/, '')}` : String(u);
};
const words = (q) => q.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 2);
/**
 * A results page for the query: most query words in its search params, or in a path that
 * looks like search (/search/ddr4-ram, /s/ddr4). Not a product slug that happens to share
 * the words: /products/32gb-ddr4-3200-rdimm is a listing.
 */
const carriesQuery = (u, query) => {
  const p = parseUrl(u);
  if (!p) return false;
  const norm = (x) => {
    try {
      return decodeURIComponent(x).toLowerCase().replace(/[+_\-]/g, ' ');
    } catch {
      return x.toLowerCase();
    }
  };
  const hits = (s) => {
    const w = words(query);
    return w.length > 0 && w.filter((x) => s.includes(x)).length >= Math.ceil(w.length * 0.6);
  };
  return hits(norm(p.search)) || (SEARCH_PATH.test(p.pathname) && hits(norm(p.pathname)));
};

// /search/ddr4, /s/ddr4, and Kleinanzeigen's /s-ddr4-ecc/k0.
const SEARCH_PATH = /\/(search|s|sch|find|results?|suche|recherche|zoeken|buscar|cerca)(\/|$)|^\/s-[^/]+\/k\d+/i;
// Listing pages across the common shapes: Amazon /dp/, eBay /itm/, Mercari /item/,
// Shopify /products/, Kleinanzeigen /s-anzeige/, forum /threads/.
const PRODUCT_PATH = /\/(dp|gp\/product|itm|item|items|product|products|p|listing|listings|anzeige|s-anzeige|offer|angebot|threads|ad|annonce|lot|lots)\/[^/]+/i;
const productShaped = (u) => PRODUCT_PATH.test(parseUrl(u)?.pathname ?? '');

// Generic bot walls: Cloudflare, DataDome, PerimeterX, Akamai, plain captcha pages.
const WALL = /captcha|cf_chl|challenge-platform|\/challenge|datadome|perimeterx|px-captcha|_incapsula|access.denied|are.you.a.robot|verify.you.are.human/i;

/**
 * The type fallback for "searched with the site's own search": a type call that really
 * typed the query — the result was ok, and the text carried query words. A failed call,
 * or one that typed something else, proves no search happened. (A results URL carrying
 * the query covers itself through the URL check; it does not rehabilitate a failed call.)
 */
const typedQuery = (events, query) =>
  okCalls(events, 'type').some((c) => words(query).some((w) => String(c.call?.args?.text ?? '').toLowerCase().includes(w)));

export function browseInvalid(events, { host }) {
  const ends = ended(events);
  const lastUrl = of(events, 'observation').map((o) => o.url).filter(Boolean).at(-1) ?? '';
  if (WALL.test(lastUrl) || (ends && WALL.test(ends.message ?? ''))) return 'stopped by a bot wall or CAPTCHA';
  // Never got onto the site at all and the failure is the network, not the agent. The
  // requested start URL is not reachability evidence: it is what was asked for, not what
  // was reached — an unreachable site's log shows no observation and no ok navigate.
  const onSite = urlsVisited(events.filter((e) => e.kind !== 'run.started')).some((u) => sameSite(u, host));
  if (!onSite && /net::ERR|ERR_NAME|ERR_CONNECTION|timed out|did not load|404|5\d\d/i.test(ends?.message ?? '')) {
    return `site unreachable: ${String(ends.message).slice(0, 100)}`;
  }
  return null;
}

/**
 * What identifies a listing: an Amazon ASIN, else the longest run of 6+ digits in the
 * path (eBay, Kleinanzeigen, Mercari ids), else host and path. A reported URL with its
 * tracking suffix trimmed (/3317781317 for /3317781317-225-1866) is the same listing;
 * /dp/B07FPH493J reported after visiting /dp/B098XXF99T is not.
 */
export function listingKey(u) {
  const p = parseUrl(u);
  if (!p) return String(u);
  const host = p.hostname.replace(/^www\./, '');
  const asin = p.pathname.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/i);
  if (asin) return `${host} asin:${asin[1].toUpperCase()}`;
  const ids = p.pathname.match(/\d{6,}/g);
  if (ids) return `${host} id:${[...ids].sort((a, b) => b.length - a.length)[0]}`;
  return pageKey(u);
}

/** Identifying tokens (anything with a digit: speed, capacity, model) must all match
 *  as complete tokens. Descriptive words keep a 60% threshold. "DDR4 32GB 2666" is
 *  not "DDR4 32GB 3200", and "Ryzen 5 5600XT" is not "Ryzen 5 5600X". */
export function titleMatches(title, query) {
  const tokens = new Set(String(title ?? '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
  const all = words(query);
  const identifying = all.filter((w) => /\d/.test(w));
  const descriptive = all.filter((w) => !/\d/.test(w) && w.length >= 4);
  if (identifying.length === 0 && descriptive.length === 0) return false;
  if (!identifying.every((w) => tokens.has(w))) return false;
  if (!descriptive.length) return true;
  return descriptive.filter((w) => tokens.has(w)).length >= Math.ceil(descriptive.length * 0.6);
}

export function browseChecks(events, { host, query, url: home }) {
  const urls = urlsVisited(events).filter((u) => sameSite(u, host));
  const homeKey = pageKey(home);
  const searchIdx = urls.findIndex((u) => carriesQuery(u, query));
  const typed = typedQuery(events, query);
  // A listing: a page on the site, reached after the search, that is product-shaped, or
  // else not a results page and not a path already seen as one. Product shape wins over
  // the query check: Amazon's product URLs carry the search keywords in their query string.
  const after = searchIdx >= 0 ? urls.slice(searchIdx + 1) : typed ? urls.slice(1) : [];
  const resultPaths = new Set(urls.filter((u) => !productShaped(u) && carriesQuery(u, query)).map(pageKey));
  const listings = after.filter(
    (u) => pageKey(u) !== homeKey && (productShaped(u) || (!carriesQuery(u, query) && !resultPaths.has(pageKey(u)))),
  );
  const parsed = parseSummary(doneSummary(events));
  const v = parsed.ok && parsed.value && !Array.isArray(parsed.value) ? parsed.value : Array.isArray(parsed.value) ? parsed.value[0] ?? {} : {};
  const reported = typeof v?.url === 'string' ? v.url : '';
  // Ground the report against the listing pages the run detected, not the whole visit
  // history: a results page it stayed on is not a listing it opened.
  const grounded = Boolean(reported) && listings.some((u) => listingKey(u) === listingKey(reported));
  const price = money(v?.price);
  return [
    check('reached the site', urls.length > 0, urls[0] ?? `no page on ${host}`),
    check('searched with the site\'s own search', searchIdx >= 0 || typed, searchIdx >= 0 ? urls[searchIdx] : typed ? 'typed the query (results URL does not carry it)' : 'no results page for the query and nothing typed'),
    check('opened a listing from the results', listings.length > 0, listings[0] ?? 'no page after the results', 2),
    check('reported title, price and url as JSON', Boolean(v?.title && v?.price !== undefined && reported), parsed.ok ? JSON.stringify(v).slice(0, 160) : parsed.error),
    check('the reported listing is a page it actually visited', grounded, reported || 'no url reported', 2),
    check('the price is a number above $0', Number.isFinite(price) && price > 0, String(v?.price ?? '')),
    // Searched "Ryzen 5 5600X", opened a Ryzen 7 5800X: a listing, but not the one asked for.
    check('the listing is for what was searched', titleMatches(v?.title, query), String(v?.title ?? '').slice(0, 100)),
    check('the run ended done', ended(events)?.status === 'done', ended(events)?.status ?? 'no run.ended'),
  ];
}
