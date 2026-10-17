#!/usr/bin/env node
/**
 * Live activities scorer. Full file follows in this commit.
 */
export const QUERIES = ['DDR4 32GB 3200 RAM'];
export function titleMatches(title, query) {
  const tokens = new Set(String(title ?? '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
  const all = String(query ?? '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 2);
  const identifying = all.filter((w) => /\d/.test(w));
  const descriptive = all.filter((w) => !/\d/.test(w) && w.length >= 4);
  if (!identifying.length && !descriptive.length) return false;
  if (!identifying.every((w) => tokens.has(w))) return false;
  if (!descriptive.length) return true;
  return descriptive.filter((w) => tokens.has(w)).length >= Math.ceil(descriptive.length * 0.6);
}
