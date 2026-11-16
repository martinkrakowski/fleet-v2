import { describe, expect, it } from 'vitest';

import { CUTOVER_SHADOW_CRITERIA, type CutoverShadowCriterion } from '../../../domain/cutover-records.js';
import {
  SHADOW_DAY_GRACE_MS,
  type ShadowEvidenceLedger,
} from '../../../domain/shadow-evidence-ledger.js';
import type { ShadowCriterionEvaluation } from '../../ports/in/RecordShadowDayPort.in-port.js';
import type {
  ShadowEvidenceCompareAndSetInput,
  ShadowEvidencePort,
  ShadowEvidenceRead,
} from '../../ports/out/ShadowEvidencePort.out-port.js';
import { RecordShadowDayUseCase } from '../RecordShadowDayUseCase.use-case.js';

const DAY = '2026-11-14';
const DAY_END_MS = Date.parse(`${DAY}T00:00:00.000Z`) + 86_400_000;
const NOW = new Date(DAY_END_MS + SHADOW_DAY_GRACE_MS).toISOString();
const SHA = 'a'.repeat(40);
const DIGEST = 'b'.repeat(64);

function request(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { day: DAY, releaseSha: SHA, mergesCompared: 3, nowIso: NOW, ...overrides };
}

function pass(criterion: string): ShadowCriterionEvaluation {
  return { status: 'evaluated', verdict: 'pass', reasonCode: `${criterion.toLowerCase()}-ok`, inputDigest: DIGEST };
}

/** An in-memory ShadowEvidencePort with the CAS semantics the contract states. */
function memoryStore(initial: ShadowEvidenceLedger | null = null): ShadowEvidencePort & {
  writes: ShadowEvidenceCompareAndSetInput[];
} {
  let stored: ShadowEvidenceLedger | null = initial;
  const writes: ShadowEvidenceCompareAndSetInput[] = [];
  return {
    writes,
    async read(): Promise<ShadowEvidenceRead> {
      return stored === null ? { status: 'absent' } : { status: 'ok', ledger: stored };
    },
    async compareAndSet(input: ShadowEvidenceCompareAndSetInput) {
      writes.push(input);
      if (stored !== null && stored.revision !== input.expectedRevision) {
        return { outcome: 'conflict' };
      }
      stored = input.next;
      return { outcome: 'recorded', ledger: stored };
    },
  };
}

function useCase(
  store: ShadowEvidencePort,
  evaluate: (criterion: CutoverShadowCriterion) => Promise<ShadowCriterionEvaluation> = async (criterion) =>
    pass(criterion),
  nowIso: () => string = () => NOW,
): RecordShadowDayUseCase {
  return new RecordShadowDayUseCase({ shadowEvidence: store, evaluate, nowIso });
}

describe('RecordShadowDayUseCase', () => {
  it('evaluates every criterion and records them in the ledger with compare-and-set', async () => {
    const store = memoryStore();
    const result = await useCase(store).execute(request());
    expect(result.outcome).toBe('completed');
    if (result.outcome === 'completed') {
      expect(result.recorded).toHaveLength(CUTOVER_SHADOW_CRITERIA.length);
      expect(result.unevaluated).toEqual([]);
      expect(result.identicalRepeat).toBe(false);
      expect(result.revision).toBe(1);
    }
    expect(store.writes[0]?.expectedRevision).toBe(0);
  });

  it('reports an identical repeat as a no-op without a write', async () => {
    const store = memoryStore();
    await useCase(store).execute(request());
    const writes = store.writes.length;
    const result = await useCase(store).execute(request());
    expect(result).toMatchObject({ outcome: 'completed', identicalRepeat: true, recorded: expect.any(Array) });
    expect(store.writes).toHaveLength(writes);
  });

  it('reports criteria with unavailable, throwing or malformed evaluators as unevaluated and records them nowhere', async () => {
    const store = memoryStore();
    const result = await useCase(store, async (criterion): Promise<ShadowCriterionEvaluation> => {
      if (criterion === 'S1') return { status: 'unevaluated', reason: 'sources-unreadable' };
      if (criterion === 'S2') throw new Error('boom');
      if (criterion === 'S3') {
        return { status: 'evaluated', verdict: 'maybe' as 'pass' | 'fail', reasonCode: 'x', inputDigest: DIGEST };
      }
      return pass(criterion);
    }).execute(request());
    expect(result.outcome).toBe('completed');
    if (result.outcome === 'completed') {
      expect(result.recorded).toHaveLength(CUTOVER_SHADOW_CRITERIA.length - 3);
      expect(result.unevaluated).toEqual([
        { criterion: 'S1', reason: 'sources-unreadable' },
        { criterion: 'S2', reason: 'evaluator-unavailable' },
        { criterion: 'S3', reason: 'invalid-evaluation' },
      ]);
      const write = store.writes[0];
      expect(write).toBeDefined();
      if (write) {
        expect(write.next.days[DAY]?.verdicts.S1).toBeUndefined();
        expect(write.next.days[DAY]?.verdicts.S4).toBeDefined();
      }
    }
  });

  it('completes with nothing recorded when every criterion is unevaluated, writing nothing', async () => {
    const store = memoryStore();
    const result = await useCase(store, async () => ({ status: 'unevaluated', reason: 'not-yet-built' })).execute(
      request(),
    );
    expect(result).toMatchObject({ outcome: 'completed', recorded: [], identicalRepeat: false, revision: 0 });
    expect(store.writes).toHaveLength(0);
  });

  it('refuses the current day, a future day, a day inside its grace and a day older than seven days', async () => {
    const store = memoryStore();
    const use = useCase(store);
    expect(await use.execute(request({ day: '2026-11-20' }))).toEqual({ outcome: 'refused', reason: 'future-day' });
    expect(await use.execute(request({ day: '2026-11-15', nowIso: '2026-11-15T09:00:00.000Z' }))).toEqual({
      outcome: 'refused',
      reason: 'current-day',
    });
    expect(await use.execute(request({ nowIso: new Date(DAY_END_MS + 1).toISOString() }))).toEqual({
      outcome: 'refused',
      reason: 'grace-period',
    });
    expect(
      await use.execute(request({ day: '2026-11-01', nowIso: new Date(DAY_END_MS + 20 * 86_400_000).toISOString() })),
    ).toEqual({ outcome: 'refused', reason: 'day-too-old' });
    expect(store.writes).toHaveLength(0);
  });

  it('refuses an invalid, secret-shaped or malformed request', async () => {
    const use = useCase(memoryStore());
    expect(await use.execute(request({ day: '2026-02-30' }))).toEqual({ outcome: 'refused', reason: 'invalid-request' });
    expect(await use.execute(request({ releaseSha: 'nope' }))).toEqual({ outcome: 'refused', reason: 'invalid-request' });
    expect(await use.execute(request({ mergesCompared: -1 }))).toEqual({ outcome: 'refused', reason: 'invalid-request' });
    expect(await use.execute(request({ extra: true }))).toEqual({ outcome: 'refused', reason: 'invalid-request' });
    expect(await use.execute(null)).toEqual({ outcome: 'refused', reason: 'invalid-request' });
    expect(await use.execute(request({ releaseSha: 'github_pat_1234567890123456789012' }))).toEqual({
      outcome: 'refused',
      reason: 'secret-shaped',
    });
  });

  it('answers unknown for an unreadable or unknown-version ledger and never overwrites it', async () => {
    const unreadable: ShadowEvidencePort = {
      async read() {
        return { status: 'unreadable' };
      },
      async compareAndSet() {
        return { outcome: 'refused' };
      },
    };
    expect(await useCase(unreadable).execute(request())).toEqual({ outcome: 'unknown', reason: 'ledger-unreadable' });
    const newer: ShadowEvidencePort = {
      async read() {
        return { status: 'unknown-version' };
      },
      async compareAndSet() {
        return { outcome: 'refused' };
      },
    };
    expect(await useCase(newer).execute(request())).toEqual({ outcome: 'unknown', reason: 'ledger-unknown-version' });
  });

  it('retries a compare-and-set conflict against a fresh read and records on the next pass', async () => {
    const initial: ShadowEvidenceLedger = { schemaVersion: 1, revision: 4, days: {} };
    let ledger = initial;
    let bumped = false;
    const racy: ShadowEvidencePort = {
      async read() {
        return { status: 'ok', ledger };
      },
      async compareAndSet(input) {
        if (!bumped) {
          bumped = true;
          ledger = { ...ledger, revision: input.expectedRevision + 1 };
          return { outcome: 'conflict' };
        }
        ledger = input.next;
        return { outcome: 'recorded', ledger };
      },
    };
    const result = await useCase(racy).execute(request());
    expect(result).toMatchObject({ outcome: 'completed', revision: 6, identicalRepeat: false });
  });

  it('answers unknown when every compare-and-set pass conflicts', async () => {
    const racy: ShadowEvidencePort = {
      async read() {
        return { status: 'absent' };
      },
      async compareAndSet(_input) {
        return { outcome: 'conflict' };
      },
    };
    expect(await useCase(racy).execute(request())).toEqual({ outcome: 'unknown', reason: 'ledger-write-failed' });
  });

  it('answers unknown when the deadline is reached and writes nothing', async () => {
    const store = memoryStore();
    const result = await useCase(store, undefined, () => new Date(DAY_END_MS + SHADOW_DAY_GRACE_MS + 60_000).toISOString()).execute(
      request({ deadlineIso: new Date(DAY_END_MS + SHADOW_DAY_GRACE_MS + 30_000).toISOString() }),
    );
    expect(result).toEqual({ outcome: 'unknown', reason: 'deadline-exceeded' });
    expect(store.writes).toHaveLength(0);
  });

  it('answers unknown when the effective clock is unusable', async () => {
    const use = useCase(memoryStore(), undefined, () => 'not-a-clock');
    expect(await use.execute(request({ nowIso: undefined }))).toEqual({ outcome: 'unknown', reason: 'clock-invalid' });
  });
});
