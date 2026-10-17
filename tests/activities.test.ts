import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
// The scorer is a plain Node script so live.sh can run it without a build step.
// @ts-ignore -- untyped .mjs
import { ACTIVITIES, familyOf, filterEvidence, highestPage, listingKey, nextBrowse, nextCompare, scoreboard, titleMatches, scoreActivity, telemetry, waste } from '../scripts/harness/activities.mjs';

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

const obs = (url: string, text?: string): Ev => ({ kind: 'observation', mode: 'dom', url, tokens: 100, ...(text ? { text } : {}) });
const failed = (r: { checks: Array<{ ok: boolean; name: string }> }) => r.checks.filter((c) => !c.ok).map((c) => c.name);

describe('generic activities: browse, any shop-like site', () => {
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

  it('fails a listing for a different part than the one searched, model numbers as complete tokens', () => {
    expect(titleMatches('AMD Ryzen 7 5800x', 'Ryzen 5 5600X')).toBe(false);
    expect(titleMatches('AMD Ryzen 5 5600X 6-Core Processor', 'Ryzen 5 5600X')).toBe(true);
    expect(titleMatches('AMD Ryzen 5 5600XT', 'Ryzen 5 5600X')).toBe(false);
    expect(titleMatches('2TB SATA SSD', '1TB NVMe SSD')).toBe(false);
    expect(titleMatches('Crucial 32GB DDR4-3200 UDIMM', 'DDR4 32GB 3200 RAM')).toBe(true);
    expect(titleMatches('DDR4 32GB 2666 RAM', 'DDR4 32GB 3200 RAM')).toBe(false);
    expect(titleMatches('DDR4 16GB 3200 RAM', 'DDR4 32GB 3200 RAM')).toBe(false);
  });

  it('marks a run invalid, not failed, when the model provider rate-limited it to death', () => {
    const events = log(params.url, [obs(params.url)], 'error');
    (events.at(-1) as Record<string, unknown>).message = '429 Provider returned error';
    expect(scoreActivity('browse', events, { params })).toMatchObject({ verdict: 'invalid', invalid: 'the model provider rate-limited the run (429)' });
  });

  it('marks a run invalid when the site never came up: the requested start URL is not reachability evidence', () => {
    const events = log(params.url, [], 'error');
    (events.at(-1) as Record<string, unknown>).message = 'net::ERR_NAME_NOT_RESOLVED at https://techmikeny.com';
    const r = scoreActivity('browse', events, { params });
    expect(r.verdict).toBe('invalid');
    expect(r.invalid).toMatch(/^site unreachable: net::ERR_NAME_NOT_RESOLVED/);
    const reached = log(params.url, [obs(params.url)], 'error');
    (reached.at(-1) as Record<string, unknown>).message = 'net::ERR_CONNECTION_RESET mid-run';
    expect(scoreActivity('browse', reached, { params }).invalid).toBeNull();
  });

  it('counts the type fallback only for calls that carried the query and landed', () => {
    const done = { summary: JSON.stringify({ title: '32GB DDR4 3200', price: '$54.00', url: listing }) };
    const byName = (events: Ev[]) =>
      Object.fromEntries(scoreActivity('browse', events, { params }).checks.map((c: { name: string; ok: boolean }) => [c.name, c.ok]));
    const lost = log(params.url, [['type', { ref: 'e4', text: 'DDR4 32GB 3200 RAM' }, false], ['done', done]]);
    expect(byName(lost)["searched with the site's own search"]).toBe(false);
    const otherWords = log(params.url, [['type', { ref: 'e4', text: 'used laptops' }], obs('https://techmikeny.com/collections/laptops'), ['done', done]]);
    expect(byName(otherWords)["searched with the site's own search"]).toBe(false);
    const byUrl = log(params.url, [['type', { ref: 'e4', text: 'DDR4 32GB 3200 RAM' }, false], obs(results), ['done', done]]);
    expect(byName(byUrl)["searched with the site's own search"]).toBe(true);
  });

  it('grounds the reported listing against the listing pages it detected, not the whole visit history', () => {
    const events = log(params.url, [
      ['type', { ref: 'e4', text: 'DDR4 32GB 3200 RAM' }],
      obs(results),
      ['click', { ref: 'e40' }],
      obs(`${listing}?variant=7`),
      ['done', { summary: JSON.stringify({ title: '32GB DDR4 3200', price: '$54.00', url: results }) }],
    ]);
    expect(failed(scoreActivity('browse', events, { params }))).toContain('the reported listing is a page it actually visited');
  });

  it('marks a run invalid when it ended on a Cloudflare challenge', () => {
    const events = log(params.url, [obs('https://techmikeny.com/cdn-cgi/challenge-platform/h/b/orchestrate')], 'blocked');
    expect(scoreActivity('browse', events, { params }).invalid).toBe('stopped by a bot wall or CAPTCHA');
  });

  it('carries no eBay-coupled assumptions: eBay params are not generic filter evidence', () => {
    expect(filterEvidence([results, `${results}&_udhi=250`], params.query)).toBeNull();
    expect(filterEvidence([results, `${results}&_sop=price`], params.query)).toBeNull();
    expect(filterEvidence([results, `${results}&sort=price_asc`], params.query)).toBe('sort=price_asc');
  });

  it('a page on the bare parent domain is not the site: only the host and its own subdomains are', () => {
    const forum = { host: 'forums.shop.example', query: 'DDR4 32GB 3200 RAM', url: 'https://forums.shop.example/', site: 'Forum shop' };
    const events = log(forum.url, [obs('https://shop.example/search?q=ddr4+32gb+3200+ram'), ['done', { summary: '{}' }]]);
    const byName = Object.fromEntries(scoreActivity('browse', events, { params: forum }).checks.map((c: { name: string; ok: boolean }) => [c.name, c.ok]));
    expect(byName["searched with the site's own search"]).toBe(false);
    const sub = log(forum.url, [obs('https://www.forums.shop.example/search?q=ddr4+32gb+3200+ram'), ['done', { summary: '{}' }]]);
    const subByName = Object.fromEntries(scoreActivity('browse', sub, { params: forum }).checks.map((c: { name: string; ok: boolean }) => [c.name, c.ok]));
    expect(subByName["searched with the site's own search"]).toBe(true);
  });
});

describe('generic activities: multi-step, filter_sort / site_median / compare_sites', () => {
  const query = 'DDR4 32GB 3200 RAM';
  const results = 'https://shop.test/search?q=ddr4+32gb+3200+ram';
  const ok = (price: string) => ({ title: `Crucial 32GB DDR4 3200 RAM kit ${price}`, price });

  describe('filter_sort', () => {
    const params = { host: 'shop.test', url: 'https://shop.test/', query, site: 'Shop' };

    it('passes when the sort shows in the URL and the three prices run lowest first', () => {
      const rows = [ok('$20.00'), ok('$25.50'), ok('$31.00')];
      const events = log(params.url, [
        obs(results),
        obs(`${results}&sort=price_asc`, rows.map((r) => `${r.title} ${r.price}`).join('\n')),
        ['done', { summary: JSON.stringify({ applied: 'sort by price, low to high', results: rows }) }],
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
        'the reported rows appear on a page it read',
      ]);
    });

    it('fails titles and prices that never appeared on the filtered page', () => {
      const events = log(params.url, [
        obs(results),
        obs(`${results}&sort=price_asc`, 'Unrelated cable $4.00\nUnrelated cable $5.00'),
        ['done', { summary: JSON.stringify({ applied: 'sort by price, low to high', results: [ok('$20.00'), ok('$25.50'), ok('$31.00')] }) }],
      ]);
      expect(failed(scoreActivity('filter_sort', events, { params }))).toContain('the reported rows appear on a page it read');
    });

    it('finds a filter in the path as well as in the query string', () => {
      expect(filterEvidence([results, 'https://shop.test/search/price-low-to-high?q=ddr4+32gb+3200+ram'], query)).toBe('/search/price-low-to-high');
      expect(filterEvidence([results, `${results}&page=2`], query)).toBeNull();
    });
  });

  describe('site_median', () => {
    const params = { host: 'shop.test', url: 'https://shop.test/', query, site: 'Shop' };
    const pagePrices = [9.99, 20, 25, 30, 40, 42.5, 55, 60, 80, 100, 120];
    const priceText = pagePrices.map((p) => `$${p.toFixed(2)}`).join(' ');

    it('passes with a page-two results URL and the median of the prices on those pages', () => {
      const events = log(params.url, [
        obs(results),
        obs(`${results}&page=2`, priceText),
        ['done', { summary: '{"median": 42.5, "count": 11, "low": 9.99, "high": 120}' }],
      ]);
      expect(scoreActivity('site_median', events, { params }).verdict).toBe('pass');
      expect(highestPage([results, `${results}&_pgn=3`], query)).toBe(3);
    });

    it('fails a median reported after reading one page', () => {
      const events = log(params.url, [obs(results, priceText), ['done', { summary: '{"median": 42.5, "count": 11, "low": 9.99, "high": 120}' }]]);
      expect(failed(scoreActivity('site_median', events, { params }))).toEqual(['reached the second page of results']);
    });

    it('fails a median invented from prices the page never showed', () => {
      const events = log(params.url, [
        obs(results),
        obs(`${results}&page=2`, '$10.00 $12.00 $14.00 $16.00 $18.00 $20.00 $22.00 $24.00 $26.00 $28.00'),
        ['done', { summary: '{"median": 42.5, "count": 11, "low": 9.99, "high": 120}' }],
      ]);
      expect(scoreActivity('site_median', events, { params }).verdict).toBe('fail');
      expect(failed(scoreActivity('site_median', events, { params }))).toContain('the median is the median of prices read on the page');
    });
  });

  describe('compare_sites', () => {
    const hosts = ['a-parts.com', 'b-surplus.com', 'c-shop.com'];
    const params = { hosts, host: hosts[0], url: 'https://a-parts.com/', query, site: 'A / B / C' };
    const listing = (h: string, id: number) => `https://${h}/products/ddr4-32gb-${id}`;
    const visit = hosts.flatMap((h, i) => [obs(`https://${h}/search?q=ddr4+32gb+3200+ram`), obs(listing(h, 111111 + i))]);
    const offers = (prices: string[], cheapest: string, urls = hosts.map((h, i) => listing(h, 111111 + i))) =>
      JSON.stringify({
        offers: hosts.map((_h, i) => ({ site: ['A', 'B', 'C'][i], title: `32GB DDR4 3200 RAM ${i}`, price: prices[i], url: urls[i] })),
        cheapest,
      });

    it('passes when all three sites were searched, every listing was opened and the cheapest is named right', () => {
      const events = log(params.url, [...visit, ['done', { summary: offers(['$60', '$48', '$55'], 'B') }]]);
      expect(scoreActivity('compare_sites', events, { params }).verdict).toBe('pass');
    });

    it('fails a wrong cheapest and a listing that was never opened', () => {
      const urls = [listing(hosts[0]!, 111111), listing(hosts[1]!, 111112), listing(hosts[2]!, 999999)];
      const events = log(params.url, [...visit, ['done', { summary: offers(['$60', '$48', '$55'], 'A', urls) }]]);
      expect(failed(scoreActivity('compare_sites', events, { params }))).toEqual([
        'every reported listing is a page it actually visited',
        'each offer is bound to the site it was asked for',
        'the cheapest it names is the lowest price it reported',
      ]);
    });

    it('does not let three listings on one host stand in for the other two sites', () => {
      const onlyA = [111111, 111112, 111113].map((id) => listing(hosts[0]!, id));
      const events = log(params.url, [
        ...hosts.map((h) => obs(`https://${h}/search?q=ddr4+32gb+3200+ram`)),
        ...onlyA.map((u) => obs(u)),
        ['done', { summary: offers(['$60', '$48', '$55'], 'B', onlyA) }],
      ]);
      expect(failed(scoreActivity('compare_sites', events, { params }))).toContain('each offer is bound to the site it was asked for');
    });

    it('does not treat visited search URLs as opened listings', () => {
      const searches = hosts.map((h) => `https://${h}/search?q=ddr4+32gb+3200+ram`);
      const events = log(params.url, [...searches.map((u) => obs(u)), ['done', { summary: offers(['$60', '$48', '$55'], 'B', searches) }]]);
      expect(failed(scoreActivity('compare_sites', events, { params }))).toContain('every reported listing is a page it actually visited');
    });

    it('does not count failed or same-site type calls as a search on every site', () => {
      const events = log(params.url, [
        ['type', { ref: 'e1', text: 'DDR4 32GB 3200 RAM' }, false],
        ['type', { ref: 'e1', text: 'DDR4 32GB 3200 RAM' }, false],
        ['type', { ref: 'e1', text: 'DDR4 32GB 3200 RAM' }, false],
        obs('https://a-parts.com/'),
        ['done', { summary: offers(['$60', '$48', '$55'], 'B') }],
      ]);
      expect(failed(scoreActivity('compare_sites', events, { params }))).toContain('searched on each site');
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
