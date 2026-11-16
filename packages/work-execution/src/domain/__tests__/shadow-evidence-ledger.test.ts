import { describe, expect, it } from 'vitest';

import { CUTOVER_SHADOW_CRITERIA } from '../cutover-records.js';
import {
  SHADOW_EVIDENCE_KEPT_DAYS,
  SHADOW_DAY_GRACE_MS,
  emptyShadowEvidenceLedger,
  classifyShadowDayWindow,
  mergeShadowDay,
  readShadowEvidenceLedger,
  type ShadowDayVerdict,
  type ShadowEvidenceDay,
  type ShadowEvidenceLedger,
} from '../shadow-evidence-ledger.js';

const DAY = '2026-11-14';
const DAY_MS = 86_400_000;
const SHA = 'a'.repeat(40);
const DIGEST = 'b'.repeat(64);

function verdict(overrides: Partial<ShadowDayVerdict> = {}): ShadowDayVerdict {
  return { verdict: 'pass', reasonCode: 'ok', inputDigest: DIGEST, ...overrides };
}

function day(overrides: Partial<ShadowEvidenceDay> = {}): ShadowEvidenceDay {
  return { releaseSha: SHA, mergesCompared: 3, verdicts: { S1: verdict() }, ...overrides };
}

function ledger(
  overrides: Partial<Omit<ShadowEvidenceLedger, 'schemaVersion'>> & { schemaVersion?: number } = {},
): ShadowEvidenceLedger {
  return { schemaVersion: 1, revision: 1, days: { [DAY]: day() }, ...overrides } as ShadowEvidenceLedger;
}

function windowReason(value: string, nowMs: number): string {
  const window = classifyShadowDayWindow(value, nowMs);
  return window.ok ? 'ok' : window.reason;
}

describe('readShadowEvidenceLedger', () => {
  it('reads a well-formed ledger', () => {
    const read = readShadowEvidenceLedger(ledger());
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.ledger.revision).toBe(1);
      expect(read.ledger.days[DAY]?.verdicts.S1).toEqual(verdict());
    }
  });

  it('reads an absent schemaVersion as 1 and refuses a newer one', () => {
    const absent = { revision: 1, days: {} };
    expect(readShadowEvidenceLedger(absent).ok).toBe(true);
    expect(readShadowEvidenceLedger(ledger({ schemaVersion: 2 }))).toEqual({ ok: false, reason: 'unknown-version' });
  });

  it('refuses malformed ledgers without throwing', () => {
    for (const raw of [
      null,
      'ledger',
      5,
      [],
      ledger({ revision: -1 }),
      ledger({ revision: '1' as unknown as number }),
      ledger({ revision: 1.5 }),
      ledger({ days: [] as unknown as ShadowEvidenceLedger['days'] }),
      ledger({ days: { '2026-02-30': day() } }),
      ledger({ days: { [DAY]: day({ releaseSha: 'short' }) } }),
      ledger({ days: { [DAY]: day({ mergesCompared: -1 }) } }),
      ledger({ days: { [DAY]: { ...day(), extra: true } as unknown as ShadowEvidenceDay } }),
      ledger({ days: { [DAY]: day({ verdicts: { X9: verdict() } as ShadowEvidenceDay['verdicts'] }) } }),
      ledger({ days: { [DAY]: day({ verdicts: { S1: verdict({ inputDigest: 'nope' }) } }) } }),
    ]) {
      expect(readShadowEvidenceLedger(raw)).toEqual({ ok: false, reason: 'invalid-ledger' });
    }
  });

  it('refuses a verdict record with a getter without running it', () => {
    const withGetter = ledger();
    Object.defineProperty((withGetter.days as Record<string, ShadowEvidenceDay>)[DAY], 'S2', {
      enumerable: true,
      get() {
        throw new Error('must never run');
      },
    });
    expect(readShadowEvidenceLedger(withGetter)).toEqual({ ok: false, reason: 'invalid-ledger' });
  });
});

describe('classifyShadowDayWindow', () => {
  const dayEndMs = Date.parse(`${DAY}T00:00:00.000Z`) + DAY_MS;

  it('accepts a past day past its grace and within seven days', () => {
    expect(windowReason(DAY, dayEndMs + SHADOW_DAY_GRACE_MS)).toBe('ok');
  });

  it('refuses a future day and the current day', () => {
    expect(windowReason('2026-11-15', dayEndMs - 1)).toBe('future-day');
    expect(windowReason(DAY, dayEndMs - 1)).toBe('current-day');
  });

  it('refuses a day whose grace period has not ended', () => {
    expect(windowReason(DAY, dayEndMs + SHADOW_DAY_GRACE_MS - 1)).toBe('grace-period');
  });

  it('refuses a day older than seven days', () => {
    expect(windowReason(DAY, dayEndMs + 7 * DAY_MS)).toBe('day-too-old');
    expect(windowReason(DAY, dayEndMs + 7 * DAY_MS - 1)).toBe('ok');
  });

  it('refuses an invalid day', () => {
    for (const bad of ['2026-02-30', '2026-11', 'not-a-day', '2026-1-1']) {
      expect(windowReason(bad, dayEndMs)).toBe('invalid-day');
    }
  });
});

describe('mergeShadowDay', () => {
  const input = {
    day: DAY,
    releaseSha: SHA,
    mergesCompared: 3,
    verdicts: { S1: verdict() } as ShadowEvidenceDay['verdicts'],
  };

  it('records a new day at revision plus one', () => {
    const merged = mergeShadowDay(emptyShadowEvidenceLedger(), input);
    expect(merged.ok).toBe(true);
    if (merged.ok) {
      expect(merged.identicalRepeat).toBe(false);
      expect(merged.ledger.revision).toBe(1);
      expect(merged.ledger.days[DAY]).toEqual(day());
    }
  });

  it('treats an identical repeat as a no-op on the same ledger', () => {
    const merged = mergeShadowDay(ledger(), input);
    expect(merged).toEqual({ ok: true, ledger: ledger(), identicalRepeat: true });
  });

  it('refuses a different verdict on a recorded criterion', () => {
    const merged = mergeShadowDay(ledger(), {
      ...input,
      verdicts: { S1: verdict({ verdict: 'fail', reasonCode: 'diverged' }) },
    });
    expect(merged).toEqual({ ok: false, reason: 'day-criterion-conflict' });
  });

  it('refuses a changed release sha or merge count', () => {
    expect(mergeShadowDay(ledger(), { ...input, releaseSha: 'b'.repeat(40) }).ok).toBe(false);
    expect(mergeShadowDay(ledger(), { ...input, mergesCompared: 4 }).ok).toBe(false);
  });

  it('adds new criteria to a recorded day and keeps the recorded ones', () => {
    const merged = mergeShadowDay(ledger(), {
      ...input,
      verdicts: { S1: verdict(), S2: verdict({ verdict: 'fail' }) },
    });
    expect(merged.ok).toBe(true);
    if (merged.ok) {
      expect(merged.ledger.revision).toBe(2);
      expect(merged.ledger.days[DAY]?.verdicts.S1).toEqual(verdict());
      expect(merged.ledger.days[DAY]?.verdicts.S2).toEqual(verdict({ verdict: 'fail' }));
    }
  });

  it('keeps only the newest 31 days', () => {
    const days: Record<string, ShadowEvidenceDay> = {};
    for (let index = 0; index < SHADOW_EVIDENCE_KEPT_DAYS + 5; index += 1) {
      const key = new Date(Date.parse(`${DAY}T00:00:00.000Z`) - index * DAY_MS).toISOString().slice(0, 10);
      days[key] = day({ verdicts: {} });
    }
    const base = mergeShadowDay(emptyShadowEvidenceLedger(), { ...input, verdicts: {} });
    expect(base.ok).toBe(true);
    if (base.ok) {
      const merged = mergeShadowDay({ ...base.ledger, days }, { ...input, verdicts: { S1: verdict() } });
      expect(merged.ok).toBe(true);
      if (merged.ok && !merged.identicalRepeat) {
        expect(Object.keys(merged.ledger.days)).toHaveLength(SHADOW_EVIDENCE_KEPT_DAYS);
        expect(merged.ledger.days[DAY]).toBeDefined();
        const dropped = Object.keys(days)[SHADOW_EVIDENCE_KEPT_DAYS];
        expect(dropped in merged.ledger.days).toBe(false);
      }
    }
  });

  it('covers every shadow criterion id', () => {
    expect(CUTOVER_SHADOW_CRITERIA).toHaveLength(13);
  });
});
