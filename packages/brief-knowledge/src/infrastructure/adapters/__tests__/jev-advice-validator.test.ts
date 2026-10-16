// Lane D2 tests: pure Jev score validator and declared-field state builder.
import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  JEV_CRITERIA_LEVELS,
  validateScoreAnswers,
} from '../jev-advice-validator.js';
import {
  MAX_STATE_FIELD_BYTES,
  MAX_STATE_TOTAL_BYTES,
  buildRankingAdviceState,
} from '../jev-advice-state.js';

const FIXTURE_DIR = fileURLToPath(new URL('../__fixtures__/jev/', import.meta.url));

async function loadFixture(name: string): Promise<unknown> {
  return JSON.parse(await readFile(`${FIXTURE_DIR}${name}`, 'utf8')) as unknown;
}

const ASKED_KEYS = ['k0', 'k1'];

function mutateFixture(body: unknown, mutate: (clone: Record<string, unknown>) => void): unknown {
  const clone = JSON.parse(JSON.stringify(body)) as Record<string, unknown>;
  mutate(clone);
  return clone;
}

describe('validateScoreAnswers', () => {
  it('accepts the recorded fixture and computes expectation scores', async () => {
    const body = await loadFixture('jev-score-response.json');
    const result = validateScoreAnswers(body, ASKED_KEYS, 4, 0.5);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // k0: (0.01*1 + 0.04*2 + 0.94*3) / 3 = 2.91/3 = 0.97; k1: 0.
    expect(result.scores.k0).toBeCloseTo(0.97, 10);
    expect(result.scores.k1).toBe(0);
    expect(result.confidence).toBe(0.91);
    expect(result.model).toBe('typesafe/jev-1.14-20261014');
  });

  it('accepts a probability sum of 1.019 and rejects 1.021', async () => {
    const body = await loadFixture('jev-score-response.json');
    const accepted = mutateFixture(body, (clone) => {
      const answers = clone.answers as Record<
        string,
        { probabilities: Record<string, number> }
      >;
      // 0.02 + 0.01 + 0.04 + 0.949 = 1.019, within the 0.02 tolerance.
      answers.k0.probabilities = { 0: 0.02, 1: 0.01, 2: 0.04, 3: 0.949 };
    });
    expect(validateScoreAnswers(accepted, ASKED_KEYS, 4, 0.5).ok).toBe(true);

    const rejected = mutateFixture(body, (clone) => {
      const answers = clone.answers as Record<
        string,
        { probabilities: Record<string, number> }
      >;
      // 0.03 + 0.01 + 0.04 + 0.941 = 1.021, outside the 0.02 tolerance.
      answers.k0.probabilities = { 0: 0.03, 1: 0.01, 2: 0.04, 3: 0.941 };
    });
    expect(validateScoreAnswers(rejected, ASKED_KEYS, 4, 0.5)).toEqual({
      ok: false,
      reason: 'shape',
    });
  });

  it('refuses a model or id with a space, over 128 chars, or bad characters', async () => {
    const body = await loadFixture('jev-score-response.json');

    const spacedModel = mutateFixture(body, (clone) => {
      clone.model = 'typesafe jev';
    });
    expect(validateScoreAnswers(spacedModel, ASKED_KEYS, 4, 0.5)).toEqual({
      ok: false,
      reason: 'shape',
    });

    const longModel = mutateFixture(body, (clone) => {
      clone.model = 'a'.repeat(200);
    });
    expect(validateScoreAnswers(longModel, ASKED_KEYS, 4, 0.5)).toEqual({
      ok: false,
      reason: 'shape',
    });

    const spacedId = mutateFixture(body, (clone) => {
      clone.id = 'gen fixture';
    });
    expect(validateScoreAnswers(spacedId, ASKED_KEYS, 4, 0.5)).toEqual({
      ok: false,
      reason: 'shape',
    });

    const longId = mutateFixture(body, (clone) => {
      clone.id = 'g'.repeat(200);
    });
    expect(validateScoreAnswers(longId, ASKED_KEYS, 4, 0.5)).toEqual({
      ok: false,
      reason: 'shape',
    });
  });

  it('ranks k0 above k1 from the fixture', async () => {
    const body = await loadFixture('jev-score-response.json');
    const result = validateScoreAnswers(body, ASKED_KEYS, 4, 0.5);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.scores.k0).toBeGreaterThan(result.scores.k1);
  });

  it('rejects a missing asked key as shape', async () => {
    const body = await loadFixture('jev-score-response.json');
    const mutated = mutateFixture(body, (clone) => {
      delete (clone.answers as Record<string, unknown>).k1;
    });
    expect(validateScoreAnswers(mutated, ASKED_KEYS, 4, 0)).toEqual({ ok: false, reason: 'shape' });
  });

  it('rejects probabilities as an array as shape', async () => {
    const body = await loadFixture('jev-score-response.json');
    const mutated = mutateFixture(body, (clone) => {
      const k0 = (clone.answers as Record<string, unknown>).k0 as Record<string, unknown>;
      k0.probabilities = [0.01, 0.01, 0.04, 0.94];
    });
    expect(validateScoreAnswers(mutated, ASKED_KEYS, 4, 0)).toEqual({ ok: false, reason: 'shape' });
  });

  it('rejects NaN probabilities as shape', async () => {
    const body = await loadFixture('jev-score-response.json');
    const mutated = mutateFixture(body, (clone) => {
      const k0 = (clone.answers as Record<string, unknown>).k0 as Record<string, unknown>;
      (k0.probabilities as Record<string, unknown>)['2'] = NaN;
    });
    expect(validateScoreAnswers(mutated, ASKED_KEYS, 4, 0)).toEqual({ ok: false, reason: 'shape' });
  });

  it('rejects out-of-range probabilities as shape', async () => {
    const body = await loadFixture('jev-score-response.json');
    const mutated = mutateFixture(body, (clone) => {
      const k0 = (clone.answers as Record<string, unknown>).k0 as Record<string, unknown>;
      (k0.probabilities as Record<string, unknown>)['3'] = 1.5;
    });
    expect(validateScoreAnswers(mutated, ASKED_KEYS, 4, 0)).toEqual({ ok: false, reason: 'shape' });
  });

  it('rejects a bad probability sum as shape', async () => {
    const body = await loadFixture('jev-score-response.json');
    const mutated = mutateFixture(body, (clone) => {
      const k0 = (clone.answers as Record<string, unknown>).k0 as Record<string, unknown>;
      k0.probabilities = { '0': 0.4, '1': 0.1, '2': 0.1, '3': 0.1 };
    });
    expect(validateScoreAnswers(mutated, ASKED_KEYS, 4, 0)).toEqual({ ok: false, reason: 'shape' });
  });

  it('rejects a wrong probability key set as shape', async () => {
    const body = await loadFixture('jev-score-response.json');
    const mutated = mutateFixture(body, (clone) => {
      const k0 = (clone.answers as Record<string, unknown>).k0 as Record<string, unknown>;
      k0.probabilities = { '0': 0.01, '1': 0.01, '2': 0.04, '4': 0.94 };
    });
    expect(validateScoreAnswers(mutated, ASKED_KEYS, 4, 0)).toEqual({ ok: false, reason: 'shape' });
  });

  it('rejects a wrong answer type as shape', async () => {
    const body = await loadFixture('jev-score-response.json');
    const mutated = mutateFixture(body, (clone) => {
      const k0 = (clone.answers as Record<string, unknown>).k0 as Record<string, unknown>;
      k0.type = 'yes-no';
    });
    expect(validateScoreAnswers(mutated, ASKED_KEYS, 4, 0)).toEqual({ ok: false, reason: 'shape' });
  });

  it('rejects confidence below minConfidence as low-confidence', async () => {
    const body = await loadFixture('jev-score-response.json');
    const result = validateScoreAnswers(body, ASKED_KEYS, 4, 0.95);
    expect(result).toEqual({ ok: false, reason: 'low-confidence' });
  });

  it('rejects non-object bodies and a missing model as shape', () => {
    expect(validateScoreAnswers(null, ASKED_KEYS, 4, 0)).toEqual({ ok: false, reason: 'shape' });
    expect(validateScoreAnswers('x', ASKED_KEYS, 4, 0)).toEqual({ ok: false, reason: 'shape' });
    expect(validateScoreAnswers({ answers: {} }, ASKED_KEYS, 4, 0)).toEqual({
      ok: false,
      reason: 'shape',
    });
  });
});

describe('buildRankingAdviceState', () => {
  const baseReq = {
    taskSummary: 'Fix the failing date parsing test in src/utils/date.ts',
    pathPrefixes: ['src/utils'],
    candidates: [
      { id: 'entry-a', claimText: 'Date strings are parsed with parseISO; never use new Date(string).' },
      { id: 'entry-b', claimText: 'The README badge links to the CI workflow.' },
    ],
  };

  it('builds the declared fields only, keyed k0..kn with id mapping', () => {
    const state = buildRankingAdviceState(baseReq);
    expect(state.ok).toBe(true);
    if (!state.ok) return;
    const parsed = JSON.parse(state.stateJson) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual(['candidates', 'pathPrefixes', 'taskSummary']);
    expect(parsed.candidates).toEqual({
      k0: baseReq.candidates[0].claimText,
      k1: baseReq.candidates[1].claimText,
    });
    expect(state.keys).toEqual(['k0', 'k1']);
    expect(state.idsByKey).toEqual({ k0: 'entry-a', k1: 'entry-b' });
    expect(state.criteria).toEqual(JEV_CRITERIA_LEVELS);
  });

  it('matches the recorded request fixture shape', async () => {
    const request = (await loadFixture('jev-score-request.json')) as {
      state: string;
    };
    const state = buildRankingAdviceState({
      taskSummary: 'Fix the failing date parsing test in src/utils/date.ts',
      pathPrefixes: ['src/utils'],
      candidates: [
        {
          id: 'ignored',
          claimText: 'Date strings are parsed with parseISO; never use new Date(string).',
        },
        { id: 'ignored-too', claimText: 'The README badge links to the CI workflow.' },
      ],
    });
    expect(state.ok).toBe(true);
    if (!state.ok) return;
    expect(state.stateJson).toBe(request.state);
  });

  it('returns a stable sha-256 of the exact serialized state', () => {
    const state = buildRankingAdviceState(baseReq);
    expect(state.ok).toBe(true);
    if (!state.ok) return;
    expect(state.stateSha256).toMatch(/^[0-9a-f]{64}$/);
    const again = buildRankingAdviceState(baseReq);
    expect(again.ok && again.stateSha256 === state.stateSha256).toBe(true);
  });

  it('refuses a secret-pattern hit in taskSummary', () => {
    const state = buildRankingAdviceState({
      ...baseReq,
      taskSummary: 'use token sk-abcdefghijklmnopqrstuvwx now',
    });
    expect(state.ok).toBe(false);
    if (state.ok) return;
    expect(state.reason).toBe('redaction-refused');
    expect(state.detail).not.toContain('sk-');
  });

  it('refuses a field over the 8 KiB cap and a total over 32 KiB', () => {
    const overField = buildRankingAdviceState({
      ...baseReq,
      taskSummary: 'a'.repeat(MAX_STATE_FIELD_BYTES + 1),
    });
    expect(overField.ok).toBe(false);

    const claims = Array.from({ length: 5 }, (_, i) => ({
      id: `c${i}`,
      claimText: 'b'.repeat(MAX_STATE_FIELD_BYTES),
    }));
    const overTotal = buildRankingAdviceState({
      ...baseReq,
      candidates: claims,
    });
    expect(overTotal.ok).toBe(false);
    expect(overTotal.ok ? '' : overTotal.reason).toBe('redaction-refused');
    expect(MAX_STATE_TOTAL_BYTES).toBe(32 * 1024);
  });
});
