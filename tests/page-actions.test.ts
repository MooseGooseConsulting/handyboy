// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { click, getBox, hover, press, resetPointerForTests, scroll, select, type } from '@/src/page/actions';
import { resolveRef, snapshot } from '@/src/page/snapshot';
import { PageDriver } from '@/src/page/driver';
import type { ChromeApi } from '@/src/page/driver';
import { recordTabReplaced, resetTabReplacements } from '@/src/page/tabReplacement';
