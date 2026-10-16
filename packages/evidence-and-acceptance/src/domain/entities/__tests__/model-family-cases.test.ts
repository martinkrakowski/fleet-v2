import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { underlyingModelFamily } from '../ReviewReceipt.js';

type FamilyCase =
  | { model: string; family: string }
  | { same: [string, string] }
  | { different: [string, string] };

/**
 * The shared model-family case table, committed byte-identical in
 * installation and evidence-and-acceptance (guarded by
 * scripts/check-model-family-fixtures.sh). This test runs every case
 * against the evidence copy of the rule.
 */
const CASES = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'model-family-cases.json'), 'utf8'),
) as FamilyCase[];

describe('underlyingModelFamily shared fixture cases (evidence copy)', () => {
  it('maps every model id to its expected family', () => {
    for (const entry of CASES) {
      if ('model' in entry) {
        expect(underlyingModelFamily(entry.model)).toBe(entry.family);
      }
    }
  });

  it('keeps every same pair in one family', () => {
    for (const entry of CASES) {
      if ('same' in entry) {
        const [left, right] = entry.same;
        expect(underlyingModelFamily(left)).toBe(underlyingModelFamily(right));
      }
    }
  });

  it('keeps every different pair in distinct families', () => {
    for (const entry of CASES) {
      if ('different' in entry) {
        const [left, right] = entry.different;
        expect(underlyingModelFamily(left)).not.toBe(underlyingModelFamily(right));
      }
    }
  });
});