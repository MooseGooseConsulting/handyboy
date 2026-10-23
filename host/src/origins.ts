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

/**
 * The WHATWG URL parser reads `\` as `/` and silently drops tabs, newlines and
 * leading C0 bytes, so a target carrying any of them can parse to a different
 * host than the string checks below saw. No API path needs them; refuse outright.
 */
const PARSER_REWRITTEN = /[\\\x00-\x1f\x7f]/;

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
 * "Absolute" is whatever the URL parser itself accepts without a base, not a
 * `scheme://` regex: `http:evil.example` has no slashes yet parses as
 * `http://evil.example/`, and treating it as a relative path let it escape.
 *
 * A relative path (no scheme) has no origin of its own -- callers that need one
 * default it themselves (`resolveUrl` in llm.ts defaults to OpenRouter, for
 * backward compatibility with paths sent before Kilo existed). The returned path
 * is not yet proof of anything: resolving it against a base can still escape
 * (`../`, or a path that itself reads as `http:...`), which is why `resolveUrl`
 * re-checks the final URL with `assertOnKnownBase`.
 */
export function normalizeRequest(url: string): { path: string; origin: KnownOrigin | null } {
  const s = url.trim();
  if (PARSER_REWRITTEN.test(s)) {
    throw new OffOriginError('refusing request target containing a backslash or control character');
  }
  if (s.startsWith('//') || URL.canParse(s)) {
    const abs = new URL(s.startsWith('//') ? `https:${s}` : s);
    if (abs.username || abs.password) {
      throw new OffOriginError('refusing request target carrying credentials in the url');
    }
    const entry = (Object.entries(KNOWN_BASES) as Array<[KnownOrigin, { origin: string; prefix: string }]>).find(
      ([, v]) => v.origin === abs.origin,
    );
    if (!entry) {
      throw new OffOriginError(`refusing to proxy off-origin url: ${abs.origin}`);
    }
    const [origin, { prefix }] = entry;
    const prefixRe = new RegExp(`^${escapeRegExp(prefix)}(?=/|$)`);
    if (!prefixRe.test(abs.pathname)) {
      throw new OffOriginError(`refusing ${origin} url outside ${prefix}`);
    }
    const path = abs.pathname.replace(prefixRe, '') + abs.search;
    return { path: trimEdgeSlashes(path), origin };
  }
  return { path: trimEdgeSlashes(s), origin: null };
}

/**
 * The last word before a credential is attached: the URL that will actually be
 * fetched must sit on the source's exact origin, under its API prefix, with no
 * userinfo. Checking the input string alone is not enough -- every escape found
 * so far parsed to a different host only once resolved against the base.
 */
export function assertOnKnownBase(url: URL, source: KnownOrigin): void {
  const { origin, prefix } = KNOWN_BASES[source];
  if (url.origin !== origin) {
    throw new OffOriginError(`refusing to proxy off-origin url: ${url.origin}`);
  }
  if (url.username || url.password) {
    throw new OffOriginError('refusing request target carrying credentials in the url');
  }
  if (!url.pathname.startsWith(`${prefix}/`)) {
    throw new OffOriginError(`refusing ${source} url outside ${prefix}`);
  }
}
