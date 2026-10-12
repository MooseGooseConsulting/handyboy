#!/usr/bin/env node
/**
 * Live activities: realistic multi-step jobs on real eBay, performed by the real agent on
 * the free model pair, scored only from what the run log shows the agent did.
 *
 *   node scripts/harness/activities.mjs list
 *   node scripts/harness/activities.mjs task  --activity <id>            -> {url, prompt, options}
 *   node scripts/harness/activities.mjs live  [--log <file>]             (stdin: nb-run stream)
 *   node scripts/harness/activities.mjs score --activity <id> --runlog <file>
 *        [--artifacts <dir>] [--json <out>] [--history <history.jsonl>]
 *
 * `live` prints one line per step as events arrive. `score` prints the verdict, the
 * telemetry, and the workflow and token waste the log shows, and compares against the
 * last run of the same activity in --history. Exit status of `score`: 0 pass, 1 fail,
 * 3 invalid (the site, not the agent, made the run meaningless: a CAPTCHA, signed out).
 */
import fs from 'node:fs';
import path from 'node:path';

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

/** Every page the agent was on: the start URL, each observation, each navigate it asked for. */
export function urlsVisited(events) {
  const urls = [];
  for (const e of events) {
    if (e.kind === 'run.started' && e.url) urls.push(e.url);
    if (e.kind === 'observation' && e.url) urls.push(e.url);
    if (e.kind === 'tool.call' && e.call?.name === 'navigate' && e.call.args?.url) {
      if (resultOf(events, e)?.ok) urls.push(String(e.call.args.url));
    }
  }
  return [...new Set(urls)];
}

const parseUrl = (u) => {
  try {
    return new URL(u);
  } catch {
    return null;
  }
};

/** eBay item id from any listing URL shape (/itm/123, /itm/slug/123, ?item=123). */
export function itemId(u) {
  const m = String(u).match(/\/itm\/(?:[^/?#]+\/)?(\d{9,})/) ?? String(u).match(/[?&]item=(\d{9,})/);
  return m ? m[1] : null;
}

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

const onEbay = (u) => /(^|\.)ebay\.com$/.test(parseUrl(u)?.hostname ?? '');
const searchUrls = (urls) => urls.filter((u) => onEbay(u) && parseUrl(u)?.searchParams.get('_nkw'));

/**
 * Signed out, or stopped by a CAPTCHA or bot wall: the site, not the agent, made the run
 * meaningless. Only when the run ended still behind the wall: eBay often shows a
 * challenge that clears itself, and a run that got past it is scored normally.
 */
function invalidReason(events, { needsSignIn = false } = {}) {
  const last = of(events, 'observation').map((o) => o.url).filter(Boolean).at(-1) ?? urlsVisited(events).at(-1) ?? '';
  const wall = /splashui\/(captcha|challenge)|\/captcha/i;
  const signin = /signin\.ebay\.com|[?&]ru=https?%3A%2F%2Fsignin\.ebay\.com/i;
  // A signed-in activity that was ever sent to sign-in cannot be scored on what it read.
  if (needsSignIn && urlsVisited(events).some((u) => signin.test(u))) return 'not signed in to eBay (sent to sign-in)';
  if (wall.test(last)) return 'stopped by an eBay CAPTCHA';
  return null;
}

/* ---------------------------------------------- browse: any site, the everyday test */

/** Used-hardware queries the browse activity rotates through. */
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
/** Same site: the host or any subdomain of it (shop.example.com counts for example.com). */
const sameSite = (u, host) => {
  const h = hostOf(u);
  return Boolean(h) && (h === host || h.endsWith(`.${host}`) || host.endsWith(`.${h}`));
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
  return hits(norm(p.search)) || (/\/(search|s|sch|find|results?|suche|recherche|zoeken|buscar|cerca)(\/|$)/i.test(p.pathname) && hits(norm(p.pathname)));
};

// Generic bot walls: Cloudflare, DataDome, PerimeterX, Akamai, plain captcha pages.
const WALL = /captcha|cf_chl|challenge-platform|\/challenge|datadome|perimeterx|px-captcha|_incapsula|access.denied|are.you.a.robot|verify.you.are.human/i;

export function browseInvalid(events, { host }) {
  const ends = ended(events);
  const lastUrl = of(events, 'observation').map((o) => o.url).filter(Boolean).at(-1) ?? '';
  if (WALL.test(lastUrl) || (ends && WALL.test(ends.message ?? ''))) return 'stopped by a bot wall or CAPTCHA';
  // Never got onto the site at all and the failure is the network, not the agent.
  const onSite = urlsVisited(events).some((u) => sameSite(u, host));
  if (!onSite && /net::ERR|ERR_NAME|ERR_CONNECTION|timed out|did not load|404|5\d\d/i.test(ends?.message ?? '')) {
    return `site unreachable: ${String(ends.message).slice(0, 100)}`;
  }
  return null;
}

export function browseChecks(events, { host, query, url: home }) {
  const urls = urlsVisited(events).filter((u) => sameSite(u, host));
  const homeKey = pageKey(home);
  const searchIdx = urls.findIndex((u) => carriesQuery(u, query));
  const typed = calls(events, 'type').some((c) => words(query).some((w) => String(c.call?.args?.text ?? '').toLowerCase().includes(w)));
  // A listing: a page on the site, reached after the search, that is neither the home
  // page nor a results page for the query.
  const after = searchIdx >= 0 ? urls.slice(searchIdx + 1) : typed ? urls.slice(1) : [];
  const listings = after.filter((u) => pageKey(u) !== homeKey && !carriesQuery(u, query));
  const parsed = parseSummary(doneSummary(events));
  const v = parsed.ok && parsed.value && !Array.isArray(parsed.value) ? parsed.value : Array.isArray(parsed.value) ? parsed.value[0] ?? {} : {};
  const reported = typeof v?.url === 'string' ? v.url : '';
  const grounded = Boolean(reported) && urls.some((u) => pageKey(u) === pageKey(reported));
  const price = money(v?.price);
  return [
    check('reached the site', urls.length > 0, urls[0] ?? `no page on ${host}`),
    check('searched with the site\'s own search', searchIdx >= 0 || typed, searchIdx >= 0 ? urls[searchIdx] : typed ? 'typed the query (results URL does not carry it)' : 'no results page for the query and nothing typed'),
    check('opened a listing from the results', listings.length > 0, listings[0] ?? 'no page after the results', 2),
    check('reported title, price and url as JSON', Boolean(v?.title && v?.price !== undefined && reported), parsed.ok ? JSON.stringify(v).slice(0, 160) : parsed.error),
    check('the reported listing is a page it actually visited', grounded, reported || 'no url reported', 2),
    check('the price is a number above $0', Number.isFinite(price) && price > 0, String(v?.price ?? '')),
    check('the run ended done', ended(events)?.status === 'done', ended(events)?.status ?? 'no run.ended'),
  ];
}

export function browseTask(site, query) {
  return {
    title: `Browse ${site.name}: ${query}`,
    url: site.url,
    params: { host: hostOf(site.url) || site.host, query, url: site.url, site: site.name },
    maxSteps: 20,
    prompt: [
      `This is ${site.name}. Use the site's own search to look for: ${query}.`,
      'Open one listing from the results and read its title and price.',
      'Call done with only JSON: {"title": "...", "price": "$123.45", "url": "<the listing page url>"}.',
    ].join(' '),
  };
}

/** ebay.co.uk, ebay.de and ebay.com are one operator: rotation counts them as one site. */
export const familyOf = (host) => {
  const parts = String(host).toLowerCase().replace(/^www\./, '').split('.');
  // Drop the public suffix (co.uk, com.au, de, com...) and keep the operator's label.
  const tail = parts.length >= 3 && /^(co|com|org|net|gov|ac)$/.test(parts.at(-2)) ? 2 : 1;
  return parts.at(-1 - tail) ?? parts[0];
};
const familyOfRun = (h) => (h.activity === 'browse' ? familyOf(h.params?.host ?? '') : h.activity?.startsWith('ebay_') ? 'ebay' : null);

/**
 * The next site to browse: an operator never tested before first, then the least
 * recently tested, so a long series spreads across the whole list instead of
 * returning to the same few operators. `offset` picks the Nth best, for a batch.
 */
export function nextBrowse(sites, history, offset = 0) {
  const lastUsed = new Map();
  history.forEach((h, i) => {
    const f = familyOfRun(h);
    if (f) lastUsed.set(f, i);
  });
  const usable = sites.filter((s) => !s.loginToBrowse && s.url);
  const ranked = usable
    .map((s, i) => {
      const f = familyOf(hostOf(s.url));
      return { s, f, order: lastUsed.has(f) ? lastUsed.get(f) : -1e6 + i };
    })
    .sort((a, b) => a.order - b.order);
  // One site per operator per batch.
  const seen = new Set();
  const distinct = ranked.filter(({ f }) => !seen.has(f) && seen.add(f));
  const browses = history.filter((h) => h.activity === 'browse').length;
  const site = distinct[offset % Math.max(1, distinct.length)]?.s;
  return site ? browseTask(site, QUERIES[(browses + offset) % QUERIES.length]) : null;
}

export const SITES_FILE = new URL('./sites.json', import.meta.url);

export const ACTIVITIES = {
  browse: {
    title: 'Open a site, search it, open a listing, report it (any site; rotates)',
    dynamic: true,
    score: (events, ctx) => browseChecks(events, ctx.params),
    invalid: (events, ctx) => browseInvalid(events, ctx.params),
  },

  ebay_compare: {
    title: 'Search, filter and compare three listings',
    url: 'https://www.ebay.com/',
    maxSteps: 40,
    prompt: [
      'On eBay, find a used Canon AE-1 film camera. Only Buy It Now listings, priced at most $250:',
      "use eBay's own filters for both, not just your judgement.",
      'Open three different listings from the results and, for each, read the title, the price,',
      'the shipping cost and the seller.',
      'When you are done, call done with only a JSON array of the three, in this shape:',
      '[{"title": "...", "price": "$199.00", "shipping": "$15.00 or Free", "seller": "...", "url": "https://www.ebay.com/itm/..."}]',
    ].join(' '),
    score(events) {
      const urls = urlsVisited(events);
      const searches = searchUrls(urls);
      const query = searches.map((u) => parseUrl(u).searchParams.get('_nkw').toLowerCase());
      const bin = searches.some((u) => parseUrl(u).searchParams.get('LH_BIN') === '1');
      const priceCap = searches
        .map((u) => money(parseUrl(u).searchParams.get('_udhi')))
        .filter((n) => Number.isFinite(n));
      const visitedItems = new Set(urls.map(itemId).filter(Boolean));
      const parsed = parseSummary(doneSummary(events));
      const rows = parsed.ok && Array.isArray(parsed.value) ? parsed.value : [];
      const rowIds = rows.map((r) => itemId(r?.url ?? ''));
      const grounded = rowIds.filter((id) => id && visitedItems.has(id));
      const prices = rows.map((r) => money(r?.price));
      return [
        check('searched eBay for the AE-1', query.some((q) => /ae-?1/.test(q) && /canon/.test(q)), query.join(' | ') || 'no eBay search URL'),
        check("used eBay's Buy It Now filter", bin, bin ? 'LH_BIN=1' : 'no search URL with LH_BIN=1'),
        check("used eBay's price filter at $250 or less", priceCap.some((n) => n <= 250), priceCap.length ? `_udhi=${priceCap.join(',')}` : 'no _udhi in any search URL'),
        check('opened at least three distinct listings', visitedItems.size >= 3, `${visitedItems.size} listing page(s): ${[...visitedItems].slice(0, 6).join(', ')}`, 2),
        check('reported three listings as JSON', rows.length >= 3 && rows.every((r) => r?.title && r?.seller), parsed.ok ? `${rows.length} row(s)` : parsed.error, 2),
        check('every reported listing is one it actually opened', rows.length >= 3 && grounded.length === rows.length, `${grounded.length}/${rows.length} reported urls were visited`, 3),
        check('every reported price is a number at most $250', rows.length >= 3 && prices.every((p) => Number.isFinite(p) && p <= 250), prices.join(', ')),
        check('the run ended done', ended(events)?.status === 'done', ended(events)?.status ?? 'no run.ended'),
      ];
    },
    invalid: (events) => invalidReason(events),
  },

  ebay_watchlist: {
    title: 'Read my watchlist, signed in, read-only',
    url: 'https://www.ebay.com/mye/myebay/watchlist',
    maxSteps: 25,
    options: { readOnly: true },
    prompt: [
      'This is my eBay watchlist. Without changing anything, list every item on it with its current price.',
      'If the list spans more than one page, include them all.',
      'Call done with only a JSON array: [{"title": "...", "price": "$12.34"}], or [] if the watchlist is empty.',
    ].join(' '),
    score(events) {
      const urls = urlsVisited(events);
      const onList = urls.some((u) => /ebay\.com\/(mye\/myebay\/watchlist|myb\/WatchList)/i.test(u));
      const writes = calls(events).filter((c) => WRITE_TOOLS.has(c.call?.name));
      const parsed = parseSummary(doneSummary(events));
      const rows = parsed.ok && Array.isArray(parsed.value) ? parsed.value : null;
      const read = okCalls(events, 'extract_text').length + okCalls(events, 'run_userscript').length + okCalls(events, 'snapshot').length;
      return [
        check('reached the watchlist page while signed in', onList, urls.filter(onEbay).slice(-3).join(' | ')),
        check('changed nothing: no write tool was called', writes.length === 0, writes.map((c) => c.call.name).join(', ') || 'none', 2),
        check('read the page content', read >= 1 || of(events, 'observation').length >= 1, `${read} explicit read(s)`),
        check('reported the watchlist as a JSON array', Array.isArray(rows) && rows.every((r) => r?.title), parsed.ok ? `${rows?.length ?? 'not an array'} item(s)` : parsed.error, 2),
        check('every reported price is a number', Array.isArray(rows) && rows.every((r) => Number.isFinite(money(r?.price))), (rows ?? []).map((r) => r?.price).join(', ')),
        check('the run ended done', ended(events)?.status === 'done', ended(events)?.status ?? 'no run.ended'),
      ];
    },
    invalid: (events) => invalidReason(events, { needsSignIn: true }),
  },

  ebay_csv: {
    title: 'Extract a results page to a CSV file',
    url: 'https://www.ebay.com/sch/i.html?_nkw=nikon+f3+camera',
    maxSteps: 30,
    prompt: [
      'Save every listing on this eBay results page to a CSV file named ebay-listings.csv,',
      'with the columns title, price, url (the listing link).',
      'Writing a userscript that extracts the rows is the reliable way; save its output with save_file.',
      'Call done with a one-line summary naming the file and how many rows it has.',
    ].join(' '),
    score(events, { artifactsDir } = {}) {
      const saved = of(events, 'file.saved').filter((f) => /\.csv$/i.test(f.filename));
      const file = saved.at(-1);
      let text = '';
      const candidates = [file?.path, file && artifactsDir ? path.join(artifactsDir, file.filename) : null].filter(Boolean);
      for (const p of candidates) {
        try {
          text = fs.readFileSync(p, 'utf8');
          break;
        } catch {
          /* next */
        }
      }
      const lines = text.split(/\r?\n/).filter((l) => l.trim());
      const header = (lines[0] ?? '').toLowerCase();
      const body = lines.slice(1);
      const withItem = body.filter((l) => itemId(l));
      const ids = new Set(withItem.map(itemId));
      const scripted = okCalls(events, 'run_userscript').length;
      return [
        check('saved a .csv file', Boolean(file), file ? `${file.filename} (${file.bytes} bytes)` : 'no file.saved event for a .csv'),
        check('the file is readable on disk', text.length > 0, candidates.join(' | ') || 'no path'),
        check('the header has title, price and url', /title/.test(header) && /price/.test(header) && /url|link/.test(header), header.slice(0, 120)),
        check('at least 10 listing rows', body.length >= 10, `${body.length} row(s)`, 2),
        check('rows link to distinct eBay listings', ids.size >= Math.min(10, body.length) && ids.size >= 10, `${ids.size} distinct item ids in ${body.length} rows`, 2),
        check('extracted with a userscript that ran ok', scripted >= 1, `${scripted} ok run_userscript call(s)`),
        check('the run ended done', ended(events)?.status === 'done', ended(events)?.status ?? 'no run.ended'),
      ];
    },
    invalid: (events) => invalidReason(events),
  },

  ebay_sold_median: {
    title: 'Median sold price across two pages of sold listings',
    url: 'https://www.ebay.com/',
    maxSteps: 40,
    prompt: [
      'What have used Canon AE-1 cameras actually sold for on eBay recently?',
      "Use eBay's Sold Items filter, read the sold prices on the first two pages of results,",
      'and work out the median.',
      'Call done with only JSON: {"median": 123.45, "count": <number of sold prices you used>, "low": <lowest>, "high": <highest>}.',
    ].join(' '),
    score(events) {
      const urls = urlsVisited(events);
      const searches = searchUrls(urls);
      const sold = searches.filter((u) => parseUrl(u).searchParams.get('LH_Sold') === '1');
      const page2 = sold.some((u) => Number(parseUrl(u).searchParams.get('_pgn')) >= 2);
      const parsed = parseSummary(doneSummary(events));
      const v = parsed.ok && parsed.value && !Array.isArray(parsed.value) ? parsed.value : {};
      const [median, count, low, high] = ['median', 'count', 'low', 'high'].map((k) => money(v[k]));
      const sane = [median, count, low, high].every(Number.isFinite) && low <= median && median <= high && low > 0;
      return [
        check("used eBay's Sold Items filter", sold.length >= 1, sold.length ? 'LH_Sold=1' : 'no search URL with LH_Sold=1', 2),
        check('read a second page of sold results', page2, page2 ? '_pgn>=2 with LH_Sold=1' : 'never reached page 2 of sold results', 2),
        check('reported median, count, low and high as numbers', [median, count, low, high].every(Number.isFinite), parsed.ok ? JSON.stringify(v).slice(0, 160) : parsed.error),
        check('low <= median <= high, all above $0', sane, `${low} <= ${median} <= ${high}`, 2),
        check('used at least 20 sold prices', count >= 20, `count=${count}`),
        check('the run ended done', ended(events)?.status === 'done', ended(events)?.status ?? 'no run.ended'),
      ];
    },
    invalid: (events) => invalidReason(events),
  },
};

/* ------------------------------------------------------------------ telemetry and waste */

const argsKey = (c) => `${c.call?.name}(${JSON.stringify(c.call?.args ?? {})})`;

export function telemetry(events) {
  const usage = of(events, 'model.usage');
  const byRole = {};
  for (const u of usage) {
    const r = (byRole[u.role] ??= { calls: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, promptChars: 0, maxPromptChars: 0, unknownTokens: 0 });
    r.calls += 1;
    if (typeof u.inputTokens === 'number') r.inputTokens += u.inputTokens;
    else r.unknownTokens += 1;
    r.outputTokens += u.outputTokens ?? 0;
    r.cachedTokens += u.cachedTokens ?? 0;
    r.promptChars += u.promptChars ?? 0;
    r.maxPromptChars = Math.max(r.maxPromptChars, u.promptChars ?? 0);
  }
  for (const r of Object.values(byRole)) r.cacheShare = r.inputTokens ? r.cachedTokens / r.inputTokens : null;

  const toolCalls = calls(events).filter((c) => c.role === 'follower' || c.role === 'leader');
  const errors = toolCalls
    .map((c) => ({ c, r: resultOf(events, c) }))
    .filter(({ r }) => r && r.ok === false)
    .map(({ c, r }) => `${c.call.name}: ${String(r.summary ?? r.error ?? '').slice(0, 120)}`);
  const started = of(events, 'run.started')[0]?.at ?? events[0]?.at;
  const end = ended(events)?.at ?? events.at(-1)?.at;

  // Gaps between consecutive model calls well above a normal round trip: rate limits or retries.
  const stamps = usage.map((u) => u.at).filter(Number.isFinite);
  const stalls = [];
  for (let i = 1; i < stamps.length; i++) if (stamps[i] - stamps[i - 1] > 30_000) stalls.push(Math.round((stamps[i] - stamps[i - 1]) / 1000));

  return {
    status: ended(events)?.status ?? 'unknown',
    message: ended(events)?.message ?? '',
    steps: ended(events)?.steps ?? of(events, 'step').length,
    seconds: started && end ? Math.round((end - started) / 1000) : null,
    modelCalls: usage.length,
    byRole,
    toolCalls: toolCalls.length,
    toolsUsed: Object.entries(toolCalls.reduce((m, c) => ((m[c.call.name] = (m[c.call.name] ?? 0) + 1), m), {}))
      .sort((a, b) => b[1] - a[1])
      .map(([n, k]) => `${n}×${k}`)
      .join(' '),
    toolErrors: errors,
    handoffs: of(events, 'handoff').length,
    replans: of(events, 'leader.plan').filter((p) => p.replan).length,
    observations: of(events, 'observation').length,
    unchangedObservations: of(events, 'observation').filter((o) => o.unchanged).length,
    urls: urlsVisited(events),
    stallsSeconds: stalls,
  };
}

/** Workflow and token waste the log shows, each with the evidence. */
export function waste(events, t = telemetry(events)) {
  const out = [];
  const toolCalls = calls(events);
  // The same call with the same arguments more than once: the agent lost track of what it did.
  const seen = new Map();
  for (const c of toolCalls) seen.set(argsKey(c), (seen.get(argsKey(c)) ?? 0) + 1);
  const repeats = [...seen].filter(([k, n]) => n >= 2 && !k.startsWith('wait('));
  if (repeats.length) out.push(`repeated identical calls: ${repeats.map(([k, n]) => `${k.slice(0, 80)} ×${n}`).join('; ')}`);
  // An explicit snapshot right after an observation the model already received.
  const snaps = calls(events, 'snapshot').length + calls(events, 'leader_snapshot').length;
  if (snaps) out.push(`${snaps} explicit snapshot call(s) on top of the per-step observation`);
  const bigReads = of(events, 'tool.result').filter((r) => (r.result?.chars ?? 0) > 20_000);
  if (bigReads.length) out.push(`${bigReads.length} tool result(s) over 20k chars fed to the model (${bigReads.map((r) => `${r.result.name} ${r.result.chars}`).join(', ')})`);
  const f = t.byRole.follower;
  if (f && f.cacheShare !== null && f.cacheShare < 0.5) out.push(`follower cache share only ${(f.cacheShare * 100).toFixed(0)}% of ${f.inputTokens} input tokens`);
  const l = t.byRole.leader;
  if (l && l.inputTokens > 5_000 && (l.cacheShare ?? 0) === 0) out.push(`leader got no cache hits on ${l.inputTokens} input tokens`);
  if (f && t.toolCalls && f.calls > t.toolCalls * 1.5) out.push(`${f.calls} follower model calls for ${t.toolCalls} tool calls`);
  if (t.modelCalls && t.steps && t.modelCalls / Math.max(1, okCalls(events).length) > 2) {
    out.push(`${t.modelCalls} model calls for ${okCalls(events).length} successful tool calls`);
  }
  if (t.toolErrors.length) out.push(`${t.toolErrors.length} failed tool call(s): ${t.toolErrors.slice(0, 4).join(' | ')}`);
  if (t.stallsSeconds.length) out.push(`${t.stallsSeconds.length} gap(s) over 30 s between model calls (${t.stallsSeconds.join(', ')} s): rate limits or retries`);
  if (t.replans >= 3) out.push(`${t.replans} replans`);
  return out;
}

/** Where a failed run stopped, from the furthest stage the log shows it reached. */
export function stuckAt(events, checks) {
  if (!of(events, 'run.started').length) return 'setup';
  if (!of(events, 'leader.plan').length) return 'planning';
  if (urlsVisited(events).length <= 1 && !okCalls(events).some((c) => c.call.name !== 'set_plan')) return 'navigation';
  if (!calls(events, 'done').length) return 'execution';
  if (checks.some((c) => !c.ok)) return 'verification';
  return null;
}

export function scoreActivity(id, events, ctx = {}) {
  const a = ACTIVITIES[id];
  if (!a) throw new Error(`unknown activity ${id}`);
  const t = telemetry(events);
  const invalid = a.invalid?.(events, ctx) ?? null;
  const checks = a.score(events, ctx);
  const total = checks.reduce((s, c) => s + c.weight, 0);
  const got = checks.filter((c) => c.ok).reduce((s, c) => s + c.weight, 0);
  const passed = !invalid && checks.every((c) => c.ok);
  const parsed = parseSummary(doneSummary(events));
  return {
    activity: id,
    verdict: invalid ? 'invalid' : passed ? 'pass' : 'fail',
    invalid,
    score: total ? got / total : 0,
    checks,
    stuckAt: passed || invalid ? null : stuckAt(events, checks),
    selfReported: t.status === 'done' ? 'done' : t.status,
    summary: parsed.ok ? parsed.value : doneSummary(events) ?? null,
    telemetry: t,
    waste: waste(events, t),
  };
}

/* ------------------------------------------------------------------ printing */

const k = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n ?? 0));
const pct = (x) => (x === null || x === undefined ? '—' : `${Math.round(x * 100)}%`);
const clock = (at) => new Date(at).toTimeString().slice(0, 8);

export function formatReport(r, previous) {
  const t = r.telemetry;
  const lines = [];
  lines.push(`${r.verdict.toUpperCase()}  ${r.activity}  score ${(r.score * 100).toFixed(0)}%${r.invalid ? `  (${r.invalid})` : ''}${r.stuckAt ? `  stuck at: ${r.stuckAt}` : ''}`);
  for (const c of r.checks) lines.push(`  ${c.ok ? 'ok  ' : 'FAIL'}  ${c.name}${c.detail ? `  -- ${c.detail}` : ''}`);
  lines.push('telemetry');
  lines.push(`  ended ${t.status} after ${t.steps} steps, ${t.seconds ?? '?'} s; ${t.modelCalls} model calls, ${t.toolCalls} tool calls, ${t.handoffs} handoffs, ${t.replans} replans`);
  for (const [role, u] of Object.entries(t.byRole)) {
    lines.push(`  ${role.padEnd(8)} ${u.calls} calls  in ${k(u.inputTokens)} (${pct(u.cacheShare)} cached)  out ${k(u.outputTokens)}  largest prompt ${k(u.maxPromptChars)} chars${u.unknownTokens ? `  ${u.unknownTokens} call(s) without token counts` : ''}`);
  }
  lines.push(`  tools: ${t.toolsUsed || 'none'}`);
  lines.push(`  observations ${t.observations} (${t.unchangedObservations} unchanged, sent as a note)`);
  lines.push(`  pages: ${t.urls.length} distinct; last ${t.urls.at(-1) ?? '—'}`);
  lines.push(`waste${r.waste.length ? '' : ': none found'}`);
  for (const w of r.waste) lines.push(`  - ${w}`);
  if (previous) {
    const pt = previous.telemetry;
    const d = (a, b) => (a - b > 0 ? `+${a - b}` : String(a - b));
    lines.push(`vs previous run (${previous.at}, ${previous.verdict})`);
    lines.push(`  model calls ${d(t.modelCalls, pt.modelCalls)}, steps ${d(t.steps, pt.steps)}, seconds ${d(t.seconds ?? 0, pt.seconds ?? 0)}, follower cache ${pct(pt.byRole.follower?.cacheShare)} -> ${pct(t.byRole.follower?.cacheShare)}`);
  }
  return lines.join('\n');
}

/** One terminal line per interesting event; state carries the pending call per callId. */
export function liveLine(e, state) {
  switch (e.kind) {
    case 'run.started':
      return `${clock(e.at)}  start     ${e.url}`;
    case 'leader.plan':
      return `${clock(e.at)}  leader    ${e.replan ? 'replan' : 'plan'}: ${String(e.plan).slice(0, 110)}`;
    case 'observation':
      if (e.url && e.url !== state.url) {
        state.url = e.url;
        return `${clock(e.at)}  page      ${e.url.slice(0, 120)}${e.unchanged ? '  (unchanged)' : `  ~${k(e.tokens ?? 0)} tok`}`;
      }
      return null;
    case 'model.usage': {
      const cached = e.inputTokens ? ` (${Math.round(((e.cachedTokens ?? 0) / e.inputTokens) * 100)}% cached)` : '';
      state.lastUsage = `in ${k(e.inputTokens ?? 0)}${cached} out ${k(e.outputTokens ?? 0)}`;
      return null;
    }
    case 'tool.call':
      state.calls[e.call.callId] = { at: e.at, role: e.role, text: `${e.call.name} ${JSON.stringify(e.call.args ?? {}).slice(0, 70)}`, usage: state.lastUsage };
      return null;
    case 'tool.result': {
      const c = state.calls[e.result.callId];
      if (!c) return null;
      const status = e.result.ok ? '' : `  ERR ${String(e.result.summary ?? '').slice(0, 80)}`;
      return `${clock(c.at)}  ${String(c.role).padEnd(8)}  ${c.text.padEnd(80)}  ${c.usage ?? ''}  ${e.result.durationMs ?? '?'}ms${status}`;
    }
    case 'handoff':
      return `${clock(e.at)}  handoff   ${e.from} -> ${e.to}: ${String(e.reason).slice(0, 90)}`;
    case 'run.ended':
      return `${clock(e.at)}  end       ${e.status} after ${e.steps} steps: ${String(e.message).slice(0, 100)}`;
    default:
      return null;
  }
}

/* ------------------------------------------------------------------ CLI */

function flag(argv, name) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

async function main(argv) {
  const cmd = argv[0];
  if (cmd === 'list') {
    for (const [id, a] of Object.entries(ACTIVITIES)) console.log(`${id.padEnd(18)} ${a.title}`);
    return 0;
  }
  if (cmd === 'task') {
    const id = flag(argv, 'activity');
    let a = ACTIVITIES[id];
    if (!a) return console.error(`unknown activity; one of ${Object.keys(ACTIVITIES).join(', ')}`), 2;
    if (a.dynamic) {
      const sites = JSON.parse(fs.readFileSync(SITES_FILE, 'utf8'));
      const historyFile = flag(argv, 'history');
      const history = historyFile && fs.existsSync(historyFile) ? readJsonl(fs.readFileSync(historyFile, 'utf8')) : [];
      const site = flag(argv, 'site');
      a = site
        ? browseTask(sites.find((s) => hostOf(s.url) === site.replace(/^www\./, '')) ?? { name: site, url: `https://${site}` }, flag(argv, 'query') ?? QUERIES[0])
        : nextBrowse(sites, history, Number(flag(argv, 'offset') ?? 0));
      if (!a) return console.error('no usable site in sites.json'), 2;
    }
    // observe=dom pins the panel's stored mode: the free pair is text-only, and a screenshot
    // needs the window focused, which a test running behind other windows cannot promise.
    console.log(JSON.stringify({ activity: id, title: a.title, url: a.url, prompt: a.prompt, params: a.params ?? null, options: { maxSteps: a.maxSteps, observe: 'dom', ...(a.options ?? {}) } }));
    return 0;
  }
  if (cmd === 'live') {
    const state = { calls: {}, url: null, lastUsage: null };
    const log = flag(argv, 'log');
    const sink = log ? fs.createWriteStream(log, { flags: 'a' }) : null;
    let buf = '';
    for await (const chunk of process.stdin) {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const raw = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        sink?.write(raw + '\n');
        const [e] = readJsonl(raw);
        const line = e && liveLine(e, state);
        if (line) console.log(line);
      }
    }
    sink?.end();
    return 0;
  }
  if (cmd === 'score') {
    const id = flag(argv, 'activity');
    const events = readJsonl(fs.readFileSync(flag(argv, 'runlog'), 'utf8'));
    const taskFile = flag(argv, 'task');
    const params = taskFile ? JSON.parse(fs.readFileSync(taskFile, 'utf8')).params ?? undefined : undefined;
    const r = scoreActivity(id, events, { artifactsDir: flag(argv, 'artifacts'), params });
    if (params) r.params = params;
    r.at = new Date().toISOString();
    const historyFile = flag(argv, 'history');
    let previous;
    if (historyFile && fs.existsSync(historyFile)) {
      // A browse run compares against the last run on the same site, not any site.
      previous = readJsonl(fs.readFileSync(historyFile, 'utf8'))
        .filter((h) => h.activity === id && (!params || h.params?.host === params.host))
        .at(-1);
    }
    console.log(formatReport(r, previous));
    const json = flag(argv, 'json');
    if (json) fs.writeFileSync(json, JSON.stringify(r, null, 2));
    if (historyFile) fs.appendFileSync(historyFile, JSON.stringify({ ...r, telemetry: { ...r.telemetry, urls: undefined } }) + '\n');
    return r.verdict === 'pass' ? 0 : r.verdict === 'invalid' ? 3 : 1;
  }
  console.error('usage: activities.mjs list | task --activity <id> | live [--log f] | score --activity <id> --runlog <f> [--artifacts dir] [--json f] [--history f]');
  return 2;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).then((code) => process.exit(code ?? 0));
}
