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

export function titleMatches(title, query) {
  const tokens = new Set(String(title ?? '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
  const words = (q) => q.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 2);
  const all = words(query);
  const identifying = all.filter((w) => /\d/.test(w));
  const descriptive = all.filter((w) => !/\d/.test(w) && w.length >= 4);
  if (identifying.length === 0 && descriptive.length === 0) return false;
  if (!identifying.every((w) => tokens.has(w))) return false;
  if (!descriptive.length) return true;
  return descriptive.filter((w) => tokens.has(w)).length >= Math.ceil(descriptive.length * 0.6);
}
