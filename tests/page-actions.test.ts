// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { click, getBox, hover, press, resetPointerForTests, scroll, select, type } from '@/src/page/actions';
import { resolveRef, snapshot } from '@/src/page/snapshot';
import { PageDriver } from '@/src/page/driver';
import type { ChromeApi } from '@/src/page/driver';
import { recordTabReplaced, resetTabReplacements } from '@/src/page/tabReplacement';

/**
 * Take a snapshot (the only thing that mints refs) and hand back the ref for `selector`.
 * Every action test goes through this, which also proves refs are the only handle actions
 * accept — there is no selector back door.
 */
function refOf(selector: string): string {
  const text = snapshot({ maxNodes: 10000 }).text;
  const target = document.querySelector(selector);
  if (!target) throw new Error(`no element matched ${selector}`);
  for (const match of text.matchAll(/\[ref=(e\d+)\]/g)) {
    const ref = match[1] ?? '';
    if (ref && resolveRef(ref) === target) return ref;
  }
  throw new Error(`no ref for ${selector}`);
}

/** `refOf` for an element no selector reaches (e.g. inside a shadow root). */
function refOfElement(target: Element): string {
  const text = snapshot({ maxNodes: 10000 }).text;
  for (const match of text.matchAll(/\[ref=(e\d+)\]/g)) {
    const ref = match[1] ?? '';
    if (ref && resolveRef(ref) === target) return ref;
  }
  throw new Error('no ref for element');
}
