import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Byte-identical fixture guard: the shared model-family case table is
 * committed twice (installation and evidence-and-acceptance) and must stay
 * byte-identical, so a local test catches drift without the gate script
 * (scripts/check-model-family-fixtures.sh). The evidence copy is reached
 * through a relative path — installation must not depend on
 * `@fleet/evidence-and-acceptance` at runtime.
 */
describe('model-family-cases.json byte parity', () => {
  it('matches the evidence-and-acceptance copy byte for byte', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const installationBytes = readFileSync(
      join(here, 'fixtures', 'model-family-cases.json'),
    );
    const evidenceBytes = readFileSync(
      join(
        here,
        '..',
        '..',
        '..',
        'evidence-and-acceptance',
        'src',
        'domain',
        'entities',
        '__tests__',
        'fixtures',
        'model-family-cases.json',
      ),
    );
    expect(installationBytes.equals(evidenceBytes)).toBe(true);
  });
});