import { assertOnKnownBase, normalizeRequest, type KnownOrigin } from './origins.ts';
import { CHUNK_BYTES, KILO_BASE, OPENROUTER_BASE, type LlmRequestMsg, type OutboundMsg } from './protocol.ts';
import type { SecretStore } from './secrets.ts';

export interface SourceStatus {
  ready: boolean;
  reason?: string;
}

export interface KeyStatus extends SourceStatus {
  /**
   * Per-source detail. `sources.openrouter` is a validated status (live GET /key)
   * except in Kilo-scoped responses, where it is presence-only — a Kilo answer
   * never runs on OpenRouter, so the probe would be pure latency.
   */
  sources?: Record<KnownOrigin, SourceStatus>;
}

export type FetchLike =(input: string, init?: RequestInit) => Promise<Response>;

export interface LlmDeps {
  fetch: FetchLike;
  secrets: SecretStore;
  send: (msg: OutboundMsg) => void;
  referer?: string;
  title?: string;
}

/** Headers the client must not be able to set; the host owns them. */
const CLIENT_FORBIDDEN = new Set(['authorization', 'host', 'content-length', 'connection', 'http-referer', 'x-title']);

const BASE_FOR: Record<KnownOrigin, string> = { openrouter: OPENROUTER_BASE, kilo: KILO_BASE };

/**
 * Resolves a request target to an absolute URL and the credentialed source it
 * belongs to (C-06/C-07 security seam: this is what picks the key, so it must
 * never guess wrong). `normalizeRequest` throws `OffOriginError` for anything
 * not on a known origin -- a relative path has no origin of its own and
 * defaults to OpenRouter, preserving every path sent before Kilo existed.
 * The resolved URL is checked again because resolution itself can leave the
 * base (`../`, or a path segment that parses as `http:host`).
 */
export function resolveUrl(pathOrUrl: string): { url: string; source: KnownOrigin } {
  const { path, origin } = normalizeRequest(pathOrUrl);
  const source: KnownOrigin = origin ?? 'openrouter';
  const url = new URL(path, BASE_FOR[source]);
  assertOnKnownBase(url, source);
  return { url: url.toString(), source };
}

function headersToObject(h: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  h.forEach((v, k) => {
    out[k] = v;
  });
  return out;
}

export class LlmProxy {
  readonly #inflight = new Map<string, AbortController>();
  readonly deps: LlmDeps;

  constructor(deps: LlmDeps) {
    this.deps = deps;
  }

  abort(id: string): void {
    this.#inflight.get(id)?.abort();
  }

  abortAll(): void {
    for (const c of this.#inflight.values()) c.abort();
    this.#inflight.clear();
  }

  /**
   * Readiness per source. Reporting OpenRouter alone blocked a Kilo-only setup and
   * passed a Kilo run with no Kilo key loaded. With `source`, `ready` is that source's
   * answer; without it, `ready` means at least one source is configured (has a key,
   * or one the store rejected) and every configured source passes its check, and
   * `sources` says which is which.
   */
  async keyStatus(source?: KnownOrigin): Promise<KeyStatus> {
    const first = await this.#keyStatusOnce(source);
    const { secrets } = this.deps;
    if (first.ready || secrets.allReady()) {
      // A ready answer can still hide a source that was absent at load but has
      // since been configured. Re-check in the background (cooldown-limited, so a
      // never-configured source costs one lookup per window, not one per poll) and
      // let a later poll report it; this response still returns immediately.
      if (!secrets.allReady()) void secrets.reloadMissing().catch(() => {});
      return first;
    }
    // Keys load once at host start; a transient Doppler failure there would
    // otherwise read as "not ready" until Chrome respawns the host. Re-check only
    // if the reload found something, so a rejected key is not GET /key'd twice.
    const loaded = (s: KnownOrigin) => secrets.key(s) !== null;
    const before = (['openrouter', 'kilo'] as const).filter(loaded).length;
    await secrets.reloadMissing();
    const after = (['openrouter', 'kilo'] as const).filter(loaded).length;
    return after > before ? this.#keyStatusOnce(source) : first;
  }

  async #keyStatusOnce(source?: KnownOrigin): Promise<KeyStatus> {
    const sources: Record<KnownOrigin, SourceStatus> = {
      // A Kilo-scoped answer never runs on OpenRouter, so don't spend the live
      // GET /key (20 s timeout) filling in sources.openrouter — presence is enough.
      openrouter: source === 'kilo' ? this.deps.secrets.status('openrouter') : await this.#openRouterStatus(),
      kilo: this.deps.secrets.status('kilo'),
    };
    if (source) {
      const s = sources[source];
      return { ready: s.ready, ...(s.reason ? { reason: s.reason } : {}), sources };
    }
    // A source the store never saw a value for is not configured and must not block
    // the other. A configured source blocks when its key is present-but-invalid or
    // loads and fails its check — a working Kilo key must not hide either.
    const all = Object.entries(sources) as Array<[KnownOrigin, SourceStatus]>;
    const counted = all.filter(([name]) => this.deps.secrets.configured(name));
    if (counted.length > 0 && counted.every(([, s]) => s.ready)) return { ready: true, sources };
    const blocking = counted.length > 0 ? counted.filter(([, s]) => !s.ready) : all;
    const reason = blocking.map(([name, s]) => `${name}: ${s.reason ?? 'not ready'}`).join('; ');
    return { ready: false, reason, sources };
  }

  /**
   * GET /key with the real key: validates readiness without spending a completion (R-11).
   * OpenRouter-specific -- Kilo has no documented equivalent validation endpoint, so its
   * readiness is presence-only (`SecretStore.status('kilo')`) rather than a live round trip.
   */
  async #openRouterStatus(): Promise<SourceStatus> {
    const key = this.deps.secrets.openRouterKey;
    if (!key) return { ready: false, reason: this.deps.secrets.missingReason ?? 'no key loaded' };
    try {
      const { url } = resolveUrl('key');
      const res = await this.deps.fetch(url, {
        method: 'GET',
        headers: { authorization: `Bearer ${key}`, ...this.#brandHeaders() },
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) return { ready: false, reason: `GET /key returned ${res.status}` };
      return { ready: true };
    } catch (err) {
      return { ready: false, reason: `GET /key failed: ${(err as Error).message}` };
    }
  }

  /** GET /models for one source. Public catalog; no Authorization sent for OpenRouter. */
  async models(source: KnownOrigin = 'openrouter'): Promise<{ status: number; body: unknown }> {
    const url = new URL('models', BASE_FOR[source]).toString();
    // Kilo's catalog auth requirement is unconfirmed; attach the key when we have one
    // rather than assume it is public like OpenRouter's documented no-auth /models.
    const kiloKey = source === 'kilo' ? this.deps.secrets.key('kilo') : null;
    const res = await this.deps.fetch(url, {
      method: 'GET',
      headers: { ...this.#brandHeaders(), ...(kiloKey ? { authorization: `Bearer ${kiloKey}` } : {}) },
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    return { status: res.status, body };
  }

  /**
   * Fetches both catalogs in parallel and merges them into one `models.list.result`
   * body. A source that fails (network error or non-200) does not fail the whole
   * call -- the surviving source's models still come back, and `errors` names which
   * source failed and why, so the extension can say so rather than silently showing
   * half a catalog.
   */
  /**
   * Projects a provider catalog down to the fields the extension's mapper reads.
   *
   * Chrome caps a host->extension message at 1 MiB. Two full catalogs is 1.17 MB
   * -- the raw bodies carry a `description` paragraph per model -- so forwarding
   * them verbatim silently failed with "outbound message is 1167174 bytes".
   * `src/host/native.ts` only ever reads the keys kept here.
   */
  #slimCatalog(body: unknown): unknown {
    if (typeof body !== 'object' || body === null) return body;
    const obj = body as { data?: unknown };
    if (!Array.isArray(obj.data)) return body;
    const data = obj.data.map((raw) => {
      if (typeof raw !== 'object' || raw === null) return raw;
      const m = raw as Record<string, unknown>;
      const architecture = m.architecture as { input_modalities?: unknown } | undefined;
      return {
        id: m.id,
        name: m.name,
        context_length: m.context_length,
        pricing: m.pricing,
        supported_parameters: m.supported_parameters,
        ...(architecture ? { architecture: { input_modalities: architecture.input_modalities } } : {}),
        ...(m.isFree !== undefined ? { isFree: m.isFree } : {}),
        ...(m.mayTrainOnYourPrompts !== undefined ? { mayTrainOnYourPrompts: m.mayTrainOnYourPrompts } : {}),
      };
    });
    return { ...obj, data };
  }

  async modelsAll(): Promise<{ status: number; body: unknown }> {
    const sources: KnownOrigin[] = ['openrouter', 'kilo'];
    const settled = await Promise.allSettled(sources.map((source) => this.models(source)));

    const catalogs: Partial<Record<KnownOrigin, { status: number; body: unknown }>> = {};
    const errors: Partial<Record<KnownOrigin, string>> = {};
    settled.forEach((result, i) => {
      const source = sources[i]!;
      if (result.status === 'fulfilled') {
        if (result.value.status === 200) {
          catalogs[source] = { status: result.value.status, body: this.#slimCatalog(result.value.body) };
        } else {
          errors[source] = `upstream status ${result.value.status}`;
        }
      } else {
        errors[source] = (result.reason as Error).message;
      }
    });

    const anyOk = Object.keys(catalogs).length > 0;
    return {
      status: anyOk ? 200 : 502,
      body: { sources: catalogs, ...(Object.keys(errors).length > 0 ? { errors } : {}) },
    };
  }

  #brandHeaders(): Record<string, string> {
    return {
      'HTTP-Referer': this.deps.referer ?? 'https://github.com/MooseGooseConsulting/handyboy',
      'X-Title': this.deps.title ?? 'Handyboy',
    };
  }

  async request(msg: LlmRequestMsg): Promise<void> {
    const { send } = this.deps;

    // Which credential to attach is decided by the request's own URL origin (C-06/C-07
    // security seam), never by anything the client asserts about itself -- so this
    // resolves before the key lookup, and an unrecognised origin never reaches it.
    let url: string;
    let source: KnownOrigin;
    try {
      ({ url, source } = resolveUrl(msg.url));
    } catch (err) {
      send({ type: 'llm.error', id: msg.id, code: 'bad_request', message: (err as Error).message });
      return;
    }

    const apiKey = this.deps.secrets.key(source);
    if (!apiKey) {
      const reason = this.deps.secrets.status(source).reason;
      send({
        type: 'llm.error',
        id: msg.id,
        code: 'no_key',
        message: reason ?? `no ${source} key loaded`,
      });
      return;
    }

    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(msg.headers ?? {})) {
      if (!CLIENT_FORBIDDEN.has(k.toLowerCase())) headers[k] = v;
    }
    if (msg.body !== undefined && !Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) {
      headers['content-type'] = 'application/json';
    }
    headers['authorization'] = `Bearer ${apiKey}`;
    Object.assign(headers, this.#brandHeaders());

    const controller = new AbortController();
    this.#inflight.set(msg.id, controller);

    try {
      const res = await this.deps.fetch(url, {
        method: msg.method ?? (msg.body === undefined ? 'GET' : 'POST'),
        headers,
        body: msg.body === undefined ? undefined : JSON.stringify(msg.body),
        signal: controller.signal,
      });

      const reader = res.body?.getReader();
      if (reader) {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value || value.byteLength === 0) continue;
          const buf = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
          for (let off = 0; off < buf.byteLength; off += CHUNK_BYTES) {
            const bytes = buf.subarray(off, Math.min(off + CHUNK_BYTES, buf.byteLength)).toString('base64');
            send({ type: 'llm.chunk', id: msg.id, bytes });
          }
        }
      }

      const outHeaders = headersToObject(res.headers);
      send({ type: 'llm.end', id: msg.id, status: res.status, headers: outHeaders });
    } catch (err) {
      const aborted = controller.signal.aborted;
      send({
        type: 'llm.error',
        id: msg.id,
        code: aborted ? 'aborted' : 'upstream',
        message: aborted ? 'aborted by client' : (err as Error).message,
      });
    } finally {
      this.#inflight.delete(msg.id);
    }
  }
}
