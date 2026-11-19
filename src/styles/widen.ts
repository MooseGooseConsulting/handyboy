/**
 * Widen preset groundwork for durable rescaling (see
 * `docs/research/restyle-proposal.md` §1d and `docs/research/restyle-critique.md`).
 *
 * Pure functions only, no `chrome.*`: the agent's future widen loop needs a
 * deterministic starting stylesheet, a structural validator, and a way to flag
 * selectors that will not survive the site's next deploy. Nothing here touches
 * the page, storage, or the run — wiring (store, apply, panel) is a later step.
 *
 * The fragile-selector heuristic is inspired by Stylebot's
 * `src/core/css/hashed-class.ts` (MIT, `ankit/stylebot`): build tools combine
 * an authored part with a hash (`Header_nav__a1B2c`, `prc-TopicTag-LS-jX`), so
 * a selector built on the hash part breaks on rebuild while one built on the
 * authored part survives. This port keeps the idea and the segment shapes, not
 * the code.
 */

/** Ceiling on one stored stylesheet. Mirrors the catalog's reasoning in
 * `src/userscripts/catalog.ts`: generous for hand-written CSS, bounded for
 * storage and injection. */
export const WIDEN_CSS_MAX_BYTES = 64 * 1024;

/** Default page width: wide enough to use a monitor, narrow enough that prose
 * with the line-length cap stays readable. */
export const DEFAULT_MAX_WIDTH_PX = 1200;

/** Container selectors a phone-first stylesheet typically pins narrow. Narrow
 * on purpose: never bare `div`/`*` (a background on `div` paints every card
 * at once — Stylebot's rule, same reason). */
const WIDEN_TARGETS = [
  'main',
  'article',
  '[role="main"]',
  '.main',
  '.main-content',
  '.content',
  '.container',
  '.page-content',
  '.post',
  '.entry-content',
] as const;

export interface WidenOptions {
  /** Page width in px. Clamped to 800–2000 so a weak model cannot file 1px or 99999px. */
  maxWidthPx?: number;
  /** Cap prose line length so wider containers do not make articles unreadable. Default true. */
  proseCap?: boolean;
}

function clampWidth(px: number | undefined): number {
  if (typeof px !== 'number' || !Number.isFinite(px)) return DEFAULT_MAX_WIDTH_PX;
  return Math.min(2000, Math.max(800, Math.round(px)));
}

/**
 * Builds the starting widen stylesheet. Overrides the constraining `max-width`
 * with the chosen page width and keeps centering; optionally caps prose at a
 * readable line length. `!important` is included because site rules otherwise
 * outrank an injected stylesheet of equal specificity (the prepare step in the
 * proposal keeps this split: raw stored, prepared injected).
 */
export function buildWidenCss(options: WidenOptions = {}): string {
  const width = clampWidth(options.maxWidthPx);
  const proseCap = options.proseCap ?? true;
  const targets = WIDEN_TARGETS.join(',\n');
  const prose = proseCap
    ? `\n\n/* Prose stays readable inside the wider container. */\n${['p', 'li', '.post p', '.entry-content p'].join(',\n')} {\n  max-width: 75ch !important;\n}\n`
    : '\n';
  return (
    `/* Widen preset: lifts phone-first max-width pins to ${width}px, keeps centering. */\n` +
    `${targets} {\n  max-width: ${width}px !important;\n  width: 95% !important;\n  margin-left: auto !important;\n  margin-right: auto !important;\n}\n${prose}`
  );
}

export type StyleValidation = { ok: true } | { ok: false; errors: string[] };

/**
 * Structural validation for a stylesheet before it is stored. Rejects what
 * cannot run (empty), what cannot be injected boundedly (oversize), and what
 * is structurally broken (unbalanced braces/comments, embedded HTML). Policy
 * (which hosts, whose profile, remote URLs) lives with the store and the
 * authoring rails, not here.
 */
export function validateStyleCss(css: unknown): StyleValidation {
  if (typeof css !== 'string' || css.trim().length === 0) {
    return { ok: false, errors: ['css must not be empty'] };
  }
  const errors: string[] = [];
  if (new TextEncoder().encode(css).length > WIDEN_CSS_MAX_BYTES) {
    errors.push(`css exceeds the ${WIDEN_CSS_MAX_BYTES}-byte limit`);
  }
  let depth = 0;
  for (const ch of css) {
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    if (depth < 0) break;
  }
  if (depth !== 0) errors.push('css has unbalanced braces');
  const opens = (css.match(/\/\*/g) ?? []).length;
  const closes = (css.match(/\*\//g) ?? []).length;
  if (opens !== closes) errors.push('css has an unclosed comment');
  if (/<\s*\/?\s*(script|style)\b/i.test(css)) errors.push('css must not contain HTML tags');
  return errors.length > 0 ? { ok: false, errors } : { ok: true };
}

/** A name that reads like a word with a number (`item2`, `Large`), not a hash. */
function isPlainWord(segment: string): boolean {
  return /^[A-Z]?[a-z]+\d+$/.test(segment) || /^[A-Za-z][a-z]+$/.test(segment);
}

/** Whether letters and digits are mixed inside the value (`E0kJGG`), rather
 * than digits trailing a word (`item12`). */
function hasDigitAmongLetters(value: string): boolean {
  return /\d/.test(value) && /[a-z]/i.test(value) && !/^[A-Z]?[a-z]+\d+$/.test(value);
}

/** Case-transition density: hashes flip case often (`ZcdlOG`), words do not (`navBar`). */
function caseTransitionRatio(value: string): number {
  if (value.length < 2) return 0;
  let transitions = 0;
  for (let i = 1; i < value.length; i++) {
    const prevUpper = value[i - 1] !== value[i - 1]!.toLowerCase();
    const curUpper = value[i] !== value[i]!.toLowerCase();
    if (prevUpper !== curUpper) transitions++;
  }
  return transitions / value.length;
}

/** A 5–10 char segment that reads like a build hash (`a1B2c`), not a word. */
function isHashSegment(segment: string): boolean {
  if (!/^[\w-]{5,10}$/.test(segment) || isPlainWord(segment)) return false;
  if (hasDigitAmongLetters(segment)) return true;
  return caseTransitionRatio(segment) > 0.3;
}

/** A short dash-suffix hash (`LS-jX`, `c50BI`), not a size token (`xs-12`). */
function isDashedHash(segment: string): boolean {
  return /[a-z]\d|\d[a-z]/i.test(segment) || caseTransitionRatio(segment) >= 0.4;
}

/**
 * Whether a selector leans on generated class names that the site's next
 * deploy will rename. Splits compounds on combinators, then each `.class`
 * token on `-`/`_`: a token with a hash segment or a dashed hash suffix is
 * fragile. IDs, attributes (`td[bgcolor="..."]`), tags, and plain words pass.
 */
export function isFragileSelector(selector: string): boolean {
  const compounds = String(selector).split(/[\s>+~]+/);
  for (const compound of compounds) {
    const classes = compound.split('.').slice(1);
    for (const cls of classes) {
      const base = cls.split(':')[0]!.split('[')[0]!;
      if (!base) continue;
      const parts = base.split(/[-_]/).filter(Boolean);
      if (parts.some((part) => isHashSegment(part))) return true;
      const last = parts[parts.length - 1];
      if (parts.length > 1 && last && /^[A-Za-z0-9]{3,6}$/.test(last) && isDashedHash(last)) return true;
      if (/^\w{6}_[A-Za-z][\w-]{2,}$/.test(base) && hasDigitAmongLetters(base.slice(0, 6))) return true;
    }
  }
  return false;
}
