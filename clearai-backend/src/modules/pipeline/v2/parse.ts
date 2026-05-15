/**
 * Pipeline rewrite — Stage 1: Parse (PR 2).
 *
 * Pure re-export of the deterministic parser from src/modules/pipeline/parse/.
 * The parse logic itself doesn't change in the rewrite (it's the 80% we
 * deliberately keep). This module exists so v2 callers import from a
 * single namespace under src/modules/pipeline/v2/* instead of reaching
 * back into the legacy directory.
 *
 * When PR 13 promotes v2/ to canonical pipeline/, this file goes away
 * and parse.ts moves to its final home.
 */
import { parseItem as parseItemImpl } from '../parse/parse.js';
import type { CanonicalLineItem, ParseOutcome } from './types.js';

export function parseItem(line: CanonicalLineItem): ParseOutcome {
  return parseItemImpl(line);
}
