import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
// The scorer is a plain Node script so live.sh can run it without a build step.
// @ts-ignore -- untyped .mjs
import { familyOf, nextBrowse, scoreActivity, telemetry, waste } from '../scripts/harness/activities.mjs';

type Ev = Record<string, unknown>;

/** A run log in the shape the host streams, built from a compact list of steps. */
function log(startUrl: string, steps: Array<Ev | [string, Record<string, unknown>, boolean?, number?]>, status = 'done'): Ev[] {
  const out: Ev[] = [{ kind: 'run.started', url: startUrl, at: 1000 }, { kind: 'leader.plan', plan: 'p', subgoals: [], at: 1001 }];
  let n = 0;
  for (const s of steps) {
    if (!Array.isArray(s)) {
      out.push({ at: 1002 + n, ...s });
      continue;
    }
    const [name, args, ok = true, chars = 10] = s;
    const callId = `c${n++}`;
    out.push({ kind: 'tool.call', role: 'follower', call: { callId, name, args }, at: 1002 + n });
    out.push({ kind: 'tool.result', role: 'follower', result: { callId, name, ok, summary: ok ? 'ok' : 'boom', chars }, at: 1002 + n });
  }
  out.push({ kind: 'run.ended', status, steps: n, at: 5000 });
  return out;
}

const obs = (url: string): Ev => ({ kind: 'observation', mode: 'dom', url, tokens: 100 });
const SEARCH = 'https://www.ebay.com/sch/i.html?_nkw=canon+ae-1&LH_BIN=1&_udhi=250';
const ITEMS = ['https://www.ebay.com/itm/111111111111', 'https://www.ebay.com/itm/222222222222', 'https://www.ebay.com/itm/333333333333'];
const rows = ITEMS.map((url, i) => ({ title: `AE-1 #${i}`, price: '$199.00', shipping: 'Free', seller: 's', url }));

describe('live activity scoring', () => {
  it('passes a compare run that used the filters, opened three listings and reported exactly those', () => {
    const events = log('https://www.ebay.com/', [
      ['navigate', { url: SEARCH }],
      ...ITEMS.map((u) => obs(u)),
      ['done', { summary: JSON.stringify(rows) }],
    ]);
    const r = scoreActivity('ebay_compare', events);
    expect(r.checks.filter((c: { ok: boolean }) => !c.ok)).toEqual([]);
    expect(r.verdict).toBe('pass');
  });

  it('fails a compare run that claims success in prose without having applied a filter or opened a listing', () => {
    const events = log('https://www.ebay.com/', [
      ['navigate', { url: 'https://www.ebay.com/sch/i.html?_nkw=canon+ae-1+film+camera' }],
      ['click', { ref: 'e12' }],
      ['done', { summary: 'Collected three Canon AE-1 listings as required.' }],
    ]);
    const r = scoreActivity('ebay_compare', events);
    expect(r.verdict).toBe('fail');
    const failed = r.checks.filter((c: { ok: boolean }) => !c.ok).map((c: { name: string }) => c.name);
    expect(failed).toEqual(expect.arrayContaining(["used eBay's Buy It Now filter", 'opened at least three distinct listings', 'reported three listings as JSON']));
    expect(r.stuckAt).toBe('verification');
  });

  it('fails a compare run whose reported listings were never opened, however well formed', () => {
    const invented = rows.map((row, i) => ({ ...row, url: `https://www.ebay.com/itm/99999999999${i}` }));
    const events = log('https://www.ebay.com/', [['navigate', { url: SEARCH }], ...ITEMS.map((u) => obs(u)), ['done', { summary: JSON.stringify(invented) }]]);
    const grounded = scoreActivity('ebay_compare', events).checks.find((c: { name: string }) => c.name.startsWith('every reported listing'));
    expect(grounded.ok).toBe(false);
    expect(grounded.detail).toBe('0/3 reported urls were visited');
  });

  it('marks a run invalid only when it ended still behind an eBay challenge', () => {
    const cleared = log('https://www.ebay.com/', [obs('https://www.ebay.com/splashui/challenge?ap=1'), obs(SEARCH), ['done', { summary: '[]' }]]);
    expect(scoreActivity('ebay_compare', cleared).invalid).toBeNull();

    const stuck = log('https://www.ebay.com/', [obs(SEARCH), obs('https://www.ebay.com/splashui/captcha?ap=1')], 'blocked');
    const r = scoreActivity('ebay_compare', stuck);
    expect(r.verdict).toBe('invalid');
    expect(r.invalid).toBe('stopped by an eBay CAPTCHA');
  });

  it('marks the watchlist invalid when the run was ever sent to sign-in, and fails it for any write tool', () => {
    const signedOut = log('https://www.ebay.com/mye/myebay/watchlist', [obs('https://signin.ebay.com/ws/eBayISAPI.dll?SignIn'), ['done', { summary: '[]' }]]);
    expect(scoreActivity('ebay_watchlist', signedOut).invalid).toBe('not signed in to eBay (sent to sign-in)');

    const wrote = log('https://www.ebay.com/mye/myebay/watchlist', [obs('https://www.ebay.com/mye/myebay/watchlist'), ['click', { ref: 'e3' }], ['done', { summary: '[]' }]]);
    const r = scoreActivity('ebay_watchlist', wrote);
    expect(r.verdict).toBe('fail');
    expect(r.checks.find((c: { name: string }) => c.name.startsWith('changed nothing')).detail).toBe('click');
  });

  it('passes the CSV activity only on a saved file with a header and ten distinct listing rows', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'act-'));
    const file = path.join(dir, 'ebay-listings.csv');
    const lines = ['title,price,url', ...Array.from({ length: 12 }, (_, i) => `"Nikon F3 ${i}","$400",https://www.ebay.com/itm/8400119208${String(i).padStart(2, '0')}`)];
    fs.writeFileSync(file, lines.join('\n'));
    const events = log('https://www.ebay.com/sch/i.html?_nkw=nikon+f3+camera', [
      ['run_userscript', { scriptId: 'x' }],
      { kind: 'file.saved', filename: 'ebay-listings.csv', path: file, bytes: 900 },
      ['done', { summary: 'Saved ebay-listings.csv with 12 rows' }],
    ]);
    expect(scoreActivity('ebay_csv', events).verdict).toBe('pass');

    const claimed = log('https://www.ebay.com/sch/i.html?_nkw=nikon+f3+camera', [['run_userscript', { scriptId: 'x' }], ['done', { summary: 'Saved ebay-listings.csv with 50 rows' }]]);
    expect(scoreActivity('ebay_csv', claimed).checks[0]).toMatchObject({ ok: false, detail: 'no file.saved event for a .csv' });
  });

  it('requires page 2 of sold results and a consistent median for the sold-price activity', () => {
    const sold = 'https://www.ebay.com/sch/i.html?_nkw=canon+ae-1&LH_Sold=1&LH_Complete=1';
    const events = log('https://www.ebay.com/', [
      ['navigate', { url: sold }],
      ['navigate', { url: `${sold}&_pgn=2` }],
      ['done', { summary: '{"median": 150, "count": 40, "low": 60, "high": 320}' }],
    ]);
    expect(scoreActivity('ebay_sold_median', events).verdict).toBe('pass');

    const onePage = log('https://www.ebay.com/', [['navigate', { url: sold }], ['done', { summary: '{"median": 400, "count": 40, "low": 60, "high": 320}' }]]);
    const failed = scoreActivity('ebay_sold_median', onePage).checks.filter((c: { ok: boolean }) => !c.ok).map((c: { name: string }) => c.name);
    expect(failed).toEqual(['read a second page of sold results', 'low <= median <= high, all above $0']);
  });
});

describe('run telemetry and waste', () => {
  it('reports per-role tokens and cache share, and calls out low cache share and oversized tool results', () => {
    const events = log('https://www.ebay.com/', [
      { kind: 'model.usage', role: 'follower', inputTokens: 30_000, cachedTokens: 3_000, outputTokens: 80, promptChars: 80_000 },
      { kind: 'model.usage', role: 'leader', inputTokens: 6_000, cachedTokens: 0, outputTokens: 200, promptChars: 10_000 },
      ['run_userscript', { scriptId: 'x' }, true, 55_000],
      ['run_userscript', { scriptId: 'x' }, true, 55_000],
    ]);
    const t = telemetry(events);
    expect(t.byRole.follower).toMatchObject({ calls: 1, inputTokens: 30_000, cacheShare: 0.1, maxPromptChars: 80_000 });
    const w = waste(events, t).join('\n');
    expect(w).toContain('follower cache share only 10% of 30000 input tokens');
    expect(w).toContain('leader got no cache hits on 6000 input tokens');
    expect(w).toContain('2 tool result(s) over 20k chars fed to the model');
    expect(w).toContain('repeated identical calls: run_userscript({"scriptId":"x"}) ×2');
  });
});

describe('browse: any site, rotating', () => {
  const params = { host: 'techmikeny.com', query: 'DDR4 32GB 3200 RAM', url: 'https://techmikeny.com', site: 'TechMikeNY' };
  const results = 'https://techmikeny.com/search?q=ddr4+32gb+3200+ram';
  const listing = 'https://techmikeny.com/products/32gb-ddr4-3200-rdimm';

  it('passes a run that searched the site, opened a listing and reported that listing', () => {
    const events = log(params.url, [
      ['type', { ref: 'e4', text: 'DDR4 32GB 3200 RAM' }],
      obs(results),
      ['click', { ref: 'e40' }],
      obs(`${listing}?variant=7`),
      ['done', { summary: JSON.stringify({ title: '32GB DDR4 3200', price: '$54.00', url: listing }) }],
    ]);
    const r = scoreActivity('browse', events, { params });
    expect(r.checks.filter((c: { ok: boolean }) => !c.ok)).toEqual([]);
    expect(r.verdict).toBe('pass');
  });

  it('shows where a run broke: searched, but never opened a listing and reported one from the results page', () => {
    const events = log(params.url, [obs(results), ['done', { summary: JSON.stringify({ title: 'x', price: '$54', url: listing }) }]]);
    const r = scoreActivity('browse', events, { params });
    const byName = Object.fromEntries(r.checks.map((c: { name: string; ok: boolean }) => [c.name, c.ok]));
    expect(byName).toMatchObject({
      'reached the site': true,
      "searched with the site's own search": true,
      'opened a listing from the results': false,
      'the reported listing is a page it actually visited': false,
    });
  });

  it('marks a run invalid when it ended on a Cloudflare challenge', () => {
    const events = log(params.url, [obs('https://techmikeny.com/cdn-cgi/challenge-platform/h/b/orchestrate')], 'blocked');
    expect(scoreActivity('browse', events, { params }).invalid).toBe('stopped by a bot wall or CAPTCHA');
  });

  it('treats every country domain of one operator as one site', () => {
    expect(['www.ebay.co.uk', 'ebay.de', 'ebay.com', 'shop.ebay.com.au'].map(familyOf)).toEqual(['ebay', 'ebay', 'ebay', 'ebay']);
    expect(familyOf('uk.webuy.com')).toBe('webuy');
  });

  it('rotates to operators not tested recently, one site per operator per batch', () => {
    const sites = [
      { name: 'eBay', url: 'https://www.ebay.com' },
      { name: 'eBay UK', url: 'https://www.ebay.co.uk' },
      { name: 'A', url: 'https://a-parts.com' },
      { name: 'Login only', url: 'https://walled.example', loginToBrowse: true },
      { name: 'B', url: 'https://b-surplus.de' },
    ];
    const history = [{ activity: 'ebay_csv' }, { activity: 'browse', params: { host: 'a-parts.com' } }];
    const picks = [0, 1, 2].map((i) => nextBrowse(sites, history, i).params.host);
    expect(picks).toEqual(['b-surplus.de', 'ebay.com', 'a-parts.com']);
  });
});
