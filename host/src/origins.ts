import { KILO_BASE, OPENROUTER_BASE } from './protocol.ts';

export class OffOriginError extends Error {}

/** The two model sources the host will proxy to and attach a credential for (docs/host-protocol.md). */
export type KnownOrigin = 'openrouter' | 'kilo';

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const KNOWN_BASES: Record<KnownOrigin, { origin: string; prefix: string }> = {
  openrouter: { origin: new URL(OPENROUTER_BASE).origin, prefix: '/api/v1' },
  kilo: { origin: new URL(KILO_BASE).origin, prefix: '/api/gateway' },
};

/** Drops leading and trailing slashes. A query string, if present, stays. */
function trimEdgeSlashes(s: string): string {
  const q = s.indexOf('?');
  const query = q >= 0 ? s.slice(q) : '';
  const path = (q >= 0 ? s.slice(0, q) : s).replace(/^\/+/, '').replace(/\/+$/, '');
  return path + query;
}

/**
 * Splits a request target into its path (with no leading/trailing slash and no
 * known-origin prefix) and which known origin it named, if any. An absolute URL
 * is accepted only if it is on one of the known origins -- anything else throws
 * rather than being silently rewritten, so a client cannot aim the host at
 * another host and have a credential attached to it (C-06/security seam).
 *
 * A relative path (no scheme) has no origin of its own -- callers that need one
 * default it themselves (`resolveUrl` in llm.ts defaults to OpenRouter, for
 * backward compatibility with paths sent before Kilo existed).
 */
export function normalizeRequest(url: string): { path: string; origin: KnownOrigin | null } {
  const s = url.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s) || s.startsWith('//')) {
    const abs = new URL(s.startsWith('//') ? `https:${s}` : s);
    const entry = (Object.entries(KNOWN_BASES) as Array<[KnownOrigin, { origin: string; prefix: string }]>).find(
      ([, v]) => v.origin === abs.origin,
    );
    if (!entry) {
      throw new OffOriginError(`refusing to proxy off-origin url: ${abs.origin}`);
    }
    const [origin, { prefix }] = entry;
    const prefixRe = new RegExp(`^${escapeRegExp(prefix)}(?=/|$)`);
    const path = abs.pathname.replace(prefixRe, '') + abs.search;
    return { path: trimEdgeSlashes(path), origin };
  }
  return { path: trimEdgeSlashes(s), origin: null };
}
