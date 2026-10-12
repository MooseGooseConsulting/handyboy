import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
// The scorer is a plain Node script so live.sh can run it without a build step.
// @ts-ignore -- untyped .mjs
import { familyOf, filterEvidence, highestPage, listingKey, nextBrowse, scoreboard, titleMatches, scoreActivity, telemetry, waste } from '../scripts/harness/activities.mjs';

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

  it('counts a product page as a listing even when its URL carries the search keywords', () => {
    const amazon = { host: 'amazon.co.uk', query: 'RX 6700 XT', url: 'https://www.amazon.co.uk/', site: 'Amazon' };
    const product = 'https://www.amazon.co.uk/Sapphire-Radeon-Renewed/dp/B098XXF99T/ref=sr_1_1?crid=2K&keywords=RX+6700+XT';
    const events = log(amazon.url, [
      obs('https://www.amazon.co.uk/s?k=RX+6700+XT&ref=nb_sb_noss_1'),
      obs(product),
      ['done', { summary: JSON.stringify({ title: 'Sapphire Radeon RX 6700 XT (Renewed)', price: '£229.99', url: product }) }],
    ]);
    expect(scoreActivity('browse', events, { params: amazon }).verdict).toBe('pass');
  });

  it('accepts a reported listing URL with its tracking suffix trimmed, but not a different product', () => {
    const k = 'https://www.kleinanzeigen.de/s-anzeige/2x-64gb-crucial-ddr4/3317781317-225-1866';
    expect(listingKey('https://www.kleinanzeigen.de/s-anzeige/2x-64gb-crucial-ddr4/3317781317')).toBe(listingKey(k));
    const visited = 'https://www.amazon.co.uk/Sapphire-Radeon-Renewed/dp/B098XXF99T/ref=sr_1_1?crid=2K';
    expect(listingKey('https://www.amazon.co.uk/dp/B098XXF99T')).toBe(listingKey(visited));
    expect(listingKey('https://www.amazon.co.uk/dp/B07FPH493J')).not.toBe(listingKey(visited));
  });

  it('fails a listing for a different part than the one searched', () => {
    expect(titleMatches('AMD Ryzen 7 5800x', 'Ryzen 5 5600X')).toBe(false);
    expect(titleMatches('AMD Ryzen 5 5600X 6-Core Processor', 'Ryzen 5 5600X')).toBe(true);
    expect(titleMatches('Crucial 32GB DDR4-3200 UDIMM', 'DDR4 32GB 3200 RAM')).toBe(true);
  });

  it('marks a run invalid, not failed, when the model provider rate-limited it to death', () => {
    const events = log(params.url, [obs(params.url)], 'error');
    (events.at(-1) as Record<string, unknown>).message = '429 Provider returned error';
    expect(scoreActivity('browse', events, { params })).toMatchObject({ verdict: 'invalid', invalid: 'the model provider rate-limited the run (429)' });
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

describe('scoreboard', () => {
  const run = (leader: string, follower: string, host: string, verdict: string, score: number) => ({
    activity: 'browse',
    verdict,
    score,
    params: { host },
    telemetry: { modelCalls: 10, seconds: 60, byRole: { leader: { models: [leader], inputTokens: 1000 }, follower: { models: [follower], inputTokens: 9000 } } },
  });

  it('ranks model pairs by pass rate over valid runs, keeping invalid runs out of it', () => {
    const board = scoreboard([
      run('nvidia/a:free', 'nvidia/b:free', 'mercari.com', 'pass', 1),
      run('nvidia/a:free', 'nvidia/b:free', 'kleinanzeigen.de', 'invalid', 0),
      run('google/g:free', 'google/h:free', 'mercari.com', 'fail', 0.5),
    ]);
    const lines = board.split('\n');
    expect(lines[3]).toMatch(/^a \+ b\s+1\/1\s+1\s+100%/);
    expect(lines[4]).toContain('mercari.com P   kleinanzeigen.de i');
    expect(lines[5]).toMatch(/^g \+ h\s+0\/1\s+1\s+50%/);
  });
});

describe('multi-step activities', () => {
  const query = 'DDR4 32GB 3200 RAM';
  const results = 'https://shop.test/search?q=ddr4+32gb+3200+ram';
  const ok = (price: string) => ({ title: `Crucial 32GB DDR4 3200 RAM kit ${price}`, price });
  const failed = (r: { checks: Array<{ ok: boolean; name: string }> }) => r.checks.filter((c) => !c.ok).map((c) => c.name);

  describe('filter_sort', () => {
    const params = { host: 'shop.test', url: 'https://shop.test/', query, site: 'Shop' };

    it('passes when the sort shows in the URL and the three prices run lowest first', () => {
      const events = log(params.url, [
        obs(results),
        obs(`${results}&sort=price_asc`),
        ['done', { summary: JSON.stringify({ applied: 'sort by price, low to high', results: [ok('$20.00'), ok('$25.50'), ok('$31.00')] }) }],
      ]);
      expect(scoreActivity('filter_sort', events, { params }).verdict).toBe('pass');
    });

    it('fails an agent that sorted the list itself: no sort in the URL and prices not ascending', () => {
      const events = log(params.url, [
        obs(results),
        ['done', { summary: JSON.stringify({ applied: 'sorted by price low to high', results: [ok('$40.00'), ok('$25.50'), ok('$31.00')] }) }],
      ]);
      const r = scoreActivity('filter_sort', events, { params });
      expect(r.verdict).toBe('fail');
      expect(failed(r)).toEqual([
        'a sort or filter shows in the URL after the results',
        'the prices run lowest first, as a price sort would give',
      ]);
    });

    it('finds a filter in the path as well as in the query string', () => {
      expect(filterEvidence([results, 'https://shop.test/search/price-low-to-high?q=ddr4+32gb+3200+ram'], query)).toBe('/search/price-low-to-high');
      expect(filterEvidence([results, `${results}&page=2`], query)).toBeNull();
    });
  });

  describe('site_median', () => {
    const params = { host: 'shop.test', url: 'https://shop.test/', query, site: 'Shop' };

    it('passes with a page-two results URL and a consistent median', () => {
      const events = log(params.url, [
        obs(results),
        obs(`${results}&page=2`),
        ['done', { summary: '{"median": 42.5, "count": 24, "low": 9.99, "high": 120}' }],
      ]);
      expect(scoreActivity('site_median', events, { params }).verdict).toBe('pass');
      expect(highestPage([results, `${results}&_pgn=3`], query)).toBe(3);
    });

    it('fails a median reported after reading one page', () => {
      const events = log(params.url, [obs(results), ['done', { summary: '{"median": 42.5, "count": 12, "low": 9.99, "high": 120}' }]]);
      expect(failed(scoreActivity('site_median', events, { params }))).toEqual(['reached the second page of results']);
    });
  });

  describe('compare_sites', () => {
    const hosts = ['a-parts.com', 'b-surplus.com', 'c-shop.com'];
    const params = { hosts, host: hosts[0], url: 'https://a-parts.com/', query, site: 'A / B / C' };
    const listing = (h: string, id: number) => `https://${h}/products/ddr4-32gb-${id}`;
    const visit = hosts.flatMap((h, i) => [obs(`https://${h}/search?q=ddr4+32gb+3200+ram`), obs(listing(h, 111111 + i))]);
    const offers = (prices: string[], cheapest: string, urls = hosts.map((h, i) => listing(h, 111111 + i))) =>
      JSON.stringify({
        offers: hosts.map((h, i) => ({ site: ['A', 'B', 'C'][i], title: `32GB DDR4 3200 RAM ${i}`, price: prices[i], url: urls[i] })),
        cheapest,
      });

    it('passes when all three sites were searched, every listing was opened and the cheapest is named right', () => {
      const events = log(params.url, [...visit, ['done', { summary: offers(['$60', '$48', '$55'], 'B') }]]);
      expect(scoreActivity('compare_sites', events, { params }).verdict).toBe('pass');
    });

    it('fails a wrong cheapest and a listing that was never opened', () => {
      const urls = [listing(hosts[0], 111111), listing(hosts[1], 111112), listing(hosts[2], 999999)];
      const events = log(params.url, [...visit, ['done', { summary: offers(['$60', '$48', '$55'], 'A', urls) }]]);
      expect(failed(scoreActivity('compare_sites', events, { params }))).toEqual([
        'every reported listing is a page it actually visited',
        'the cheapest it names is the lowest price it reported',
      ]);
    });

    it('fails a run that never left the first site', () => {
      const events = log(params.url, [visit[0]!, visit[1]!, ['done', { summary: offers(['$60', '$48', '$55'], 'B') }]]);
      expect(failed(scoreActivity('compare_sites', events, { params }))).toContain('reached all three sites');
    });

    it('counts all three operators as tested for the rotation', () => {
      const sites = ['a-parts.com', 'b-surplus.com', 'c-shop.com', 'd-ram.com'].map((h) => ({ name: h, url: `https://${h}`, country: 'US', kind: 'refurbisher' }));
      const history = [{ activity: 'compare_sites', params }];
      expect(nextBrowse(sites, history, 0)!.params.host).toBe('d-ram.com');
    });
  });
});
