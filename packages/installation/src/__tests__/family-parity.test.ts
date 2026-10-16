import { describe, expect, it } from 'vitest';

import { underlyingModelFamily as evidenceFamily } from '@fleet/evidence-and-acceptance';

import { underlyingModelFamily as installationFamily } from '../policy.js';

/**
 * Drift guard: installation keeps a local copy of the model-family rule
 * (installation must not depend on `@fleet/evidence-and-acceptance` at
 * runtime), so this test pins both copies to identical output over the
 * shared table plus odd inputs. If one copy changes without the other,
 * this test fails.
 */

const SAME_FAMILY_GROUPS: readonly string[][] = [
  [
    'nvidia/z-ai/glm-5.3',
    'openrouter/z-ai/glm-5.3',
    'z-ai/glm-5.3#none',
    'z-ai/glm-5.3#low',
    'nvidia/z-ai/glm-5.3-flash',
    'z-ai/glm-5.3-flashx',
    'glm-5.3',
    'GLM-5.3',
  ],
  [
    'openrouter/anthropic/claude-3-5-sonnet:beta',
    'anthropic/claude-3-5-sonnet:nitro',
    'anthropic/claude-3-5-sonnet@20250929',
    'anthropic/claude-3-5-sonnet@20250929:beta',
    'anthropic/claude-3-5-sonnet',
    'anthropic/claude-3-5-sonnet:free',
  ],
  [
    'opencode/longcat-2.5-preview-free',
    'opencode/longcat-2.5-preview',
    'longcat-2.5',
    'longcat-2.5:paid',
  ],
  ['bare-model', 'bare-model', 'Bare-Model#high'],
  ['openai/gpt-4o', 'gpt-4o', 'openai/gpt-4o@20250929'],
  ['gpt-6-luna-mini', 'gpt-6-luna', 'openrouter/openai/gpt-6-luna:free'],
  [
    'claude-sonnet-4-5',
    'claude-3-5-sonnet-20241022',
    'claude-opus-5-5',
    'claude-haiku-4-5',
    'openrouter/anthropic/claude-opus-5-5:beta',
  ],
  ['grok-4.7', 'grok-code-fast-4.7', 'grok-4.7-fast'],
  ['gemini-2.5-pro', 'gemini-flash-latest'],
  ['gpt-5', 'gpt-oss-120b'],
  ['glm-5.3', 'glm-z1-32b'],
  ['laguna-s-2.1', 'laguna-s-2.1'],
  ['space-bunny-free', 'space-bunny-paid'],
];

const DISTINCT_PAIRS: readonly [string, string][] = [
  // One family per vendor line (owner rule 2026-10-16): sonnet vs opus is
  // the same `claude` family; these pairs stay distinct.
  ['gemini-3.1-pro', 'grok-4.7'],
  ['gpt-6-luna', 'glm-5.3'],
  ['claude-opus-5-5', 'glm-5.3'],
  ['gpt-6-luna', 'gemini-3.8-pro'],
  ['claude-sonnet-4-5', 'glm-5.3'],
  ['model-a', 'other-b'],
];

const ODD_INPUTS: readonly string[] = [
  '',
  '/',
  '//',
  'z-ai/',
  '#low',
  '#',
  ':nitro',
  '@20250929',
  '   ',
  'model:',
  'provider/model:beta#high@20250929',
  'provider/a/b/c/model-name',
  'UPPER/Case-Model#VARIANT',
  'provider/model@tag:v2:x',
];

describe('underlyingModelFamily parity (installation copy vs evidence copy)', () => {
  it('returns identical output for every same-family group member', () => {
    for (const group of SAME_FAMILY_GROUPS) {
      const families = group.map((model) => installationFamily(model));
      const evidenceFamilies = group.map((model) => evidenceFamily(model));
      expect(families).toEqual(evidenceFamilies);
      const nonEmpty = families.filter((family) => family !== '');
      expect(new Set(nonEmpty).size).toBe(1);
    }
  });

  it('returns identical, distinct output for every distinct pair', () => {
    for (const [left, right] of DISTINCT_PAIRS) {
      expect(installationFamily(left)).toBe(evidenceFamily(left));
      expect(installationFamily(right)).toBe(evidenceFamily(right));
      expect(installationFamily(left)).not.toBe(installationFamily(right));
    }
  });

  it('returns identical output for odd inputs', () => {
    for (const model of ODD_INPUTS) {
      expect(installationFamily(model)).toBe(evidenceFamily(model));
    }
    // An empty family is invalid and must be reported as the empty string.
    for (const model of ['', '/', 'z-ai/', '#low']) {
      expect(installationFamily(model)).toBe('');
    }
  });
});