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
    // Model numbers and capacities match as complete tokens: 5600XT is not 5600X.
    expect(titleMatches('AMD Ryzen 5 5600XT', 'Ryzen 5 5600X')).toBe(false);
    expect(titleMatches('2TB SATA SSD', '1TB NVMe SSD')).toBe(false);
    expect(titleMatches('Crucial 32GB DDR4-3200 UDIMM', 'DDR4 32GB 3200 RAM')).toBe(true);
    // Speed and capacity are identifying tokens: two of three is not enough.
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
    // A page that really loaded (an observation, not just the request) keeps the run valid.
    const reached = log(params.url, [obs(params.url)], 'error');
    (reached.at(-1) as Record<string, unknown>).message = 'net::ERR_CONNECTION_RESET mid-run';
    expect(scoreActivity('browse', reached, { params }).invalid).toBeNull();
  });

  it('counts the type fallback only for calls that carried the query and landed', () => {
    const done = { summary: JSON.stringify({ title: '32GB DDR4 3200', price: '$54.00', url: listing }) };
    const byName = (events: Ev[]) =>
      Object.fromEntries(scoreActivity('browse', events, { params }).checks.map((c: { name: string; ok: boolean }) => [c.name, c.ok]));
    // A type call whose result failed, with no results page after it, proves no search happened.
    const lost = log(params.url, [['type', { ref: 'e4', text: 'DDR4 32GB 3200 RAM' }, false], ['done', done]]);
    expect(byName(lost)["searched with the site's own search"]).toBe(false);
    // A successful type call that never carried the query does not count either.
    const otherWords = log(params.url, [['type', { ref: 'e4', text: 'used laptops' }], obs('https://techmikeny.com/collections/laptops'), ['done', done]]);
    expect(byName(otherWords)["searched with the site's own search"]).toBe(false);
    // A failed type plus a results URL for the query still counts: the URL is evidence
    // on its own; a failed call is not rehabilitated by what came after it.
    const byUrl = log(params.url, [['type', { ref: 'e4', text: 'DDR4 32GB 3200 RAM' }, false], obs(results), ['done', done]]);
    expect(byName(byUrl)["searched with the site's own search"]).toBe(true);
  });

  it('grounds the reported listing against the listing pages it detected, not the whole visit history', () => {
    // Reporting the results page it stayed on is not reporting a listing it opened.
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
    // _udhi/_udlo/_sop are eBay's params; the generic check only scores common ones.
    expect(filterEvidence([results, `${results}&_udhi=250`], params.query)).toBeNull();
    expect(filterEvidence([results, `${results}&_sop=price`], params.query)).toBeNull();
    expect(filterEvidence([results, `${results}&sort=price_asc`], params.query)).toBe('sort=price_asc');
  });

  it('a page on the bare parent domain is not the site: only the host and its own subdomains are', () => {
    const forum = { host: 'forums.shop.example', query: 'DDR4 32GB 3200 RAM', url: 'https://forums.shop.example/', site: 'Forum shop' };
    // Before the reverse-suffix match was removed, a visit to shop.example counted as
    // reaching forums.shop.example; the other way round it is a different site.
    const events = log(forum.url, [obs('https://shop.example/search?q=ddr4+32gb+3200+ram'), ['done', { summary: '{}' }]]);
    const byName = Object.fromEntries(scoreActivity('browse', events, { params: forum }).checks.map((c: { name: string; ok: boolean }) => [c.name, c.ok]));
    expect(byName["searched with the site's own search"]).toBe(false);
    // A subdomain of the host still counts: www.forums.shop.example is the same site.
    const sub = log(forum.url, [obs('https://www.forums.shop.example/search?q=ddr4+32gb+3200+ram'), ['done', { summary: '{}' }]]);
    const subByName = Object.fromEntries(scoreActivity('browse', sub, { params: forum }).checks.map((c: { name: string; ok: boolean }) => [c.name, c.ok]));
    expect(subByName["searched with the site's own search"]).toBe(true);
  });
});
