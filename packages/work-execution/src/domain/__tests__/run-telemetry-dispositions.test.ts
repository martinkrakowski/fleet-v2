import { describe, expect, it } from 'vitest';

import {
  TELEMETRY_COUNTER_KEYS,
  TELEMETRY_DISPOSITION_RECORD_VERSION,
  applyDispositionWrite,
  dispositionCounts,
  dispositionsOfTrace,
  emptyTelemetryDispositionRecord,
  readTelemetryDispositionRecord,
  type TelemetryDispositionRecord,
} from '../run-telemetry-dispositions.js';

const TRACE = 'a'.repeat(32);
const OTHER_TRACE = 'b'.repeat(32);
const SPAN = 'c'.repeat(16);
const OTHER_SPAN = 'd'.repeat(16);
const FINGERPRINT = 'abc12345';
const OTHER_FINGERPRINT = 'def67890';
const NOW = '2026-10-27T10:00:00.000Z';

function fullRecord(): TelemetryDispositionRecord {
  const result = applyDispositionWrite(emptyTelemetryDispositionRecord(), {
    saltFingerprint: FINGERPRINT,
    updates: [
      { traceId: TRACE, spanId: SPAN, disposition: { state: 'exported', route: 'collector' } },
      { traceId: TRACE, spanId: OTHER_SPAN, disposition: { state: 'rejected', reason: 'http-4xx' } },
    ],
    counters: { 'queue-drops': 2 },
    exportedAt: true,
    nowIso: NOW,
  });
  if (result.outcome !== 'written') {
    expect.fail('the fixture write must succeed');
  }
  return result.record;
}

function writeOf(record: unknown): { outcome: string; reason?: string; record?: TelemetryDispositionRecord } {
  const result = applyDispositionWrite(emptyTelemetryDispositionRecord(), record);
  return result as { outcome: string; reason?: string; record?: TelemetryDispositionRecord };
}

function requestWith(updates: unknown): unknown {
  return {
    saltFingerprint: FINGERPRINT,
    updates,
    nowIso: NOW,
  };
}

describe('readTelemetryDispositionRecord', () => {
  it('accepts the empty record', () => {
    const empty = emptyTelemetryDispositionRecord();
    const roundTrip = readTelemetryDispositionRecord(JSON.parse(JSON.stringify(empty)));
    expect(roundTrip.ok).toBe(true);
    if (roundTrip.ok) {
      expect(roundTrip.record).toEqual(empty);
    }
  });

  it('accepts a full fixture and returns a frozen copy on null-prototype maps', () => {
    const record = fullRecord();
    const raw = JSON.parse(JSON.stringify(record));
    const result = readTelemetryDispositionRecord(raw);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.record).toEqual(record);
      expect(Object.isFrozen(result.record)).toBe(true);
      expect(Object.getPrototypeOf(result.record.spans)).toBe(null);
      expect(Object.isFrozen(result.record.spans[TRACE])).toBe(true);
      expect(Object.getPrototypeOf(result.record.counters)).toBe(null);
    }
  });

  it('refuses each malformed field', () => {
    const base = JSON.parse(JSON.stringify(fullRecord())) as Record<string, unknown>;
    const cases: Array<[string, Record<string, unknown>]> = [
      ['an extra key', { ...base, extra: true }],
      ['a missing key', (() => {
        const copy = { ...base };
        delete copy.lastExportAtIso;
        return copy;
      })()],
      ['a wrong version', { ...base, version: 2 }],
      ['a bad fingerprint', { ...base, saltFingerprint: 'XYZ' }],
      ['a bad trace id', (() => {
        const spans = { ...(base.spans as Record<string, unknown>) };
        spans['nothex'] = spans[TRACE];
        delete spans[TRACE];
        return { ...base, spans };
      })()],
      ['a bad span id', (() => {
        const spans = base.spans as Record<string, unknown>;
        const entry = { ...(spans[TRACE] as Record<string, unknown>) };
        entry['nothex'] = entry[SPAN];
        delete entry[SPAN];
        return { ...base, spans: { [TRACE]: entry } };
      })()],
      ['an unknown disposition text', (() => {
        const spans = base.spans as Record<string, unknown>;
        const entry = { ...(spans[TRACE] as Record<string, unknown>) };
        entry[SPAN] = 'exported@unknown-route';
        return { ...base, spans: { [TRACE]: entry } };
      })()],
      ['a missing counter', (() => {
        const counters = { ...(base.counters as Record<string, unknown>) };
        delete counters.timeout;
        return { ...base, counters };
      })()],
      ['a negative counter', { ...base, counters: { ...(base.counters as Record<string, unknown>), timeout: -1 } }],
      ['a fractional counter', { ...base, counters: { ...(base.counters as Record<string, unknown>), timeout: 1.5 } }],
      ['a bad time', { ...base, lastExportAtIso: '2026-10-27T10:00:00' }],
      ['a non-record', {} as Record<string, unknown>],
    ];
    for (const [label, input] of cases) {
      const result = readTelemetryDispositionRecord(input);
      expect(result.ok, label).toBe(false);
    }
  });

  it('refuses __proto__ and constructor keys', () => {
    const countersJson = JSON.stringify(
      Object.fromEntries(TELEMETRY_COUNTER_KEYS.map((key) => [key, 0])),
    );
    const raw = `{"version":1,"saltFingerprint":null,"spans":{"__proto__":{}},"counters":${countersJson},"lastExportAtIso":null}`;
    expect(readTelemetryDispositionRecord(JSON.parse(raw)).ok).toBe(false);
    const constructorRaw = `{"version":1,"saltFingerprint":null,"spans":{"constructor":{}},"counters":${countersJson},"lastExportAtIso":null}`;
    expect(readTelemetryDispositionRecord(JSON.parse(constructorRaw)).ok).toBe(false);
  });
});

describe('applyDispositionWrite merge rules', () => {
  it('a pending over a stored exported@collector is kept without reopen', () => {
    const current = fullRecord();
    const result = applyDispositionWrite(current, {
      saltFingerprint: FINGERPRINT,
      updates: [{ traceId: TRACE, spanId: SPAN, disposition: { state: 'pending' } }],
      nowIso: NOW,
    });
    expect(result).toMatchObject({ outcome: 'written', applied: 0, kept: 1 });
    if (result.outcome === 'written') {
      expect(result.record.spans[TRACE]![SPAN]).toBe('exported@collector');
    }
  });

  it('a pending with reopen replaces a stored final entry', () => {
    const current = fullRecord();
    const result = applyDispositionWrite(current, {
      saltFingerprint: FINGERPRINT,
      reopen: true,
      updates: [{ traceId: TRACE, spanId: SPAN, disposition: { state: 'pending' } }],
      nowIso: NOW,
    });
    expect(result).toMatchObject({ outcome: 'written', applied: 1, kept: 0 });
    if (result.outcome === 'written') {
      expect(result.record.spans[TRACE]![SPAN]).toBe('pending');
    }
  });

  it('a rejected:http-4xx over a pending replaces', () => {
    const written = applyDispositionWrite(emptyTelemetryDispositionRecord(), {
      saltFingerprint: FINGERPRINT,
      updates: [{ traceId: TRACE, spanId: SPAN, disposition: { state: 'pending' } }],
      nowIso: NOW,
    });
    if (written.outcome !== 'written') {
      expect.fail('the first write must succeed');
    }
    const result = applyDispositionWrite(written.record, {
      saltFingerprint: FINGERPRINT,
      updates: [{ traceId: TRACE, spanId: SPAN, disposition: { state: 'rejected', reason: 'http-4xx' } }],
      nowIso: NOW,
    });
    expect(result).toMatchObject({ outcome: 'written', applied: 1, kept: 0 });
    if (result.outcome === 'written') {
      expect(result.record.spans[TRACE]![SPAN]).toBe('rejected:http-4xx');
    }
  });

  it('an exported over a rejected replaces, so the last HTTP result wins', () => {
    const written = applyDispositionWrite(emptyTelemetryDispositionRecord(), {
      saltFingerprint: FINGERPRINT,
      updates: [{ traceId: TRACE, spanId: SPAN, disposition: { state: 'rejected', reason: 'http-4xx' } }],
      nowIso: NOW,
    });
    if (written.outcome !== 'written') {
      expect.fail('the first write must succeed');
    }
    const result = applyDispositionWrite(written.record, {
      saltFingerprint: FINGERPRINT,
      updates: [{ traceId: TRACE, spanId: SPAN, disposition: { state: 'exported', route: 'collector' } }],
      nowIso: NOW,
    });
    expect(result).toMatchObject({ outcome: 'written', applied: 1, kept: 0 });
    if (result.outcome === 'written') {
      expect(result.record.spans[TRACE]![SPAN]).toBe('exported@collector');
    }
  });

  it('updates within one request apply in array order', () => {
    const result = applyDispositionWrite(emptyTelemetryDispositionRecord(), {
      saltFingerprint: FINGERPRINT,
      updates: [
        { traceId: TRACE, spanId: SPAN, disposition: { state: 'pending' } },
        { traceId: TRACE, spanId: SPAN, disposition: { state: 'exported', route: 'collector' } },
      ],
      nowIso: NOW,
    });
    expect(result).toMatchObject({ outcome: 'written', applied: 2, kept: 0 });
    if (result.outcome === 'written') {
      expect(result.record.spans[TRACE]![SPAN]).toBe('exported@collector');
    }
  });

  it('a write builds the result on null-prototype maps, outer and inner', () => {
    const result = applyDispositionWrite(fullRecord(), {
      saltFingerprint: FINGERPRINT,
      updates: [{ traceId: TRACE, spanId: SPAN, disposition: { state: 'pending' } }],
      reopen: true,
      nowIso: NOW,
    });
    if (result.outcome !== 'written') {
      expect.fail('the write must succeed');
    }
    expect(Object.getPrototypeOf(result.record.spans)).toBe(null);
    expect(Object.getPrototypeOf(result.record.spans[TRACE]!)).toBe(null);
  });
});

describe('applyDispositionWrite refusals, counters and timestamps', () => {
  it('a fingerprint mismatch refuses and the result carries no record', () => {
    const current = fullRecord();
    const result = applyDispositionWrite(current, {
      saltFingerprint: OTHER_FINGERPRINT,
      updates: [{ traceId: TRACE, spanId: SPAN, disposition: { state: 'pending' } }],
      nowIso: NOW,
    });
    expect(result).toEqual({ outcome: 'refused', reason: 'salt-mismatch' });
  });

  it('the first write records the fingerprint', () => {
    const result = applyDispositionWrite(emptyTelemetryDispositionRecord(), {
      saltFingerprint: FINGERPRINT,
      updates: [],
      nowIso: NOW,
    });
    if (result.outcome !== 'written') {
      expect.fail('the first write must succeed');
    }
    expect(result.record.saltFingerprint).toBe(FINGERPRINT);
  });

  it.each([
    ['a bad fingerprint', { saltFingerprint: 'XYZ', updates: [], nowIso: NOW }],
    ['a bad trace id', requestWith([{ traceId: 'nothex', spanId: SPAN, disposition: { state: 'pending' } }])],
    ['a bad span id', requestWith([{ traceId: TRACE, spanId: 'nothex', disposition: { state: 'pending' } }])],
    ['an unknown disposition', requestWith([{ traceId: TRACE, spanId: SPAN, disposition: { state: 'nope' } }])],
    ['an unknown counter key', { saltFingerprint: FINGERPRINT, updates: [], counters: { bogus: 1 }, nowIso: NOW }],
    ['a fractional counter', { saltFingerprint: FINGERPRINT, updates: [], counters: { timeout: 1.5 }, nowIso: NOW }],
    ['a negative counter', { saltFingerprint: FINGERPRINT, updates: [], counters: { timeout: -1 }, nowIso: NOW }],
    ['a bad time', { saltFingerprint: FINGERPRINT, updates: [], nowIso: '2026-10-27T10:00:00' }],
    ['a non-boolean reopen', { saltFingerprint: FINGERPRINT, updates: [], reopen: 'yes', nowIso: NOW }],
    ['a null reopen', { saltFingerprint: FINGERPRINT, updates: [], reopen: null, nowIso: NOW }],
    ['a non-boolean exportedAt', { saltFingerprint: FINGERPRINT, updates: [], exportedAt: 'yes', nowIso: NOW }],
    ['a null exportedAt', { saltFingerprint: FINGERPRINT, updates: [], exportedAt: null, nowIso: NOW }],
    ['a null counters', { saltFingerprint: FINGERPRINT, updates: [], counters: null, nowIso: NOW }],
    ['too many updates', {
      saltFingerprint: FINGERPRINT,
      updates: Array.from({ length: 4097 }, (_, index) => ({
        traceId: TRACE,
        spanId: index.toString(16).padStart(16, '0'),
        disposition: { state: 'pending' },
      })),
      nowIso: NOW,
    }],
  ])('one bad element refuses the whole request as invalid-request (%s)', (_label, request) => {
    const result = applyDispositionWrite(fullRecord(), request);
    expect(result).toEqual({ outcome: 'refused', reason: 'invalid-request' });
  });

  it('counters add up', () => {
    const first = applyDispositionWrite(emptyTelemetryDispositionRecord(), {
      saltFingerprint: FINGERPRINT,
      updates: [],
      counters: { timeout: 2, 'queue-drops': 3 },
      nowIso: NOW,
    });
    if (first.outcome !== 'written') {
      expect.fail('the first write must succeed');
    }
    const second = applyDispositionWrite(first.record, {
      saltFingerprint: FINGERPRINT,
      updates: [],
      counters: { timeout: 1 },
      nowIso: NOW,
    });
    if (second.outcome !== 'written') {
      expect.fail('the second write must succeed');
    }
    expect(second.record.counters.timeout).toBe(3);
    expect(second.record.counters['queue-drops']).toBe(3);
    for (const key of TELEMETRY_COUNTER_KEYS) {
      expect(second.record.counters[key]).toBeGreaterThanOrEqual(0);
    }
  });

  it('a counter increment that overflows a safe non-negative integer refuses the request', () => {
    const first = applyDispositionWrite(emptyTelemetryDispositionRecord(), {
      saltFingerprint: FINGERPRINT,
      updates: [],
      counters: { timeout: Number.MAX_SAFE_INTEGER },
      nowIso: NOW,
    });
    if (first.outcome !== 'written') {
      expect.fail('the first write must succeed');
    }
    const result = applyDispositionWrite(first.record, {
      saltFingerprint: FINGERPRINT,
      updates: [],
      counters: { timeout: 1 },
      nowIso: NOW,
    });
    expect(result).toEqual({ outcome: 'refused', reason: 'invalid-request' });
  });

  it('exportedAt sets lastExportAtIso from nowIso and absent leaves it', () => {
    const withTime = applyDispositionWrite(emptyTelemetryDispositionRecord(), {
      saltFingerprint: FINGERPRINT,
      updates: [],
      exportedAt: true,
      nowIso: NOW,
    });
    if (withTime.outcome !== 'written') {
      expect.fail('the write must succeed');
    }
    expect(withTime.record.lastExportAtIso).toBe(NOW);
    const without = applyDispositionWrite(withTime.record, {
      saltFingerprint: FINGERPRINT,
      updates: [],
      nowIso: '2026-10-27T11:00:00.000Z',
    });
    if (without.outcome !== 'written') {
      expect.fail('the write must succeed');
    }
    expect(without.record.lastExportAtIso).toBe(NOW);
  });

  it('never mutates the current record and freezes the result', () => {
    const current = fullRecord();
    const before = JSON.parse(JSON.stringify(current));
    const result = applyDispositionWrite(current, {
      saltFingerprint: FINGERPRINT,
      updates: [{ traceId: TRACE, spanId: SPAN, disposition: { state: 'pending' } }],
      reopen: true,
      counters: { timeout: 1 },
      nowIso: NOW,
    });
    expect(result.outcome).toBe('written');
    expect(current).toEqual(before);
    if (result.outcome === 'written') {
      expect(Object.isFrozen(result.record)).toBe(true);
    }
  });

  it('refuses a non-record request', () => {
    expect(writeOf('no')).toEqual({ outcome: 'refused', reason: 'invalid-request' });
  });
});

describe('dispositionsOfTrace and dispositionCounts', () => {
  it('returns the parsed dispositions of one trace and an empty map for an unknown or invalid trace', () => {
    const record = fullRecord();
    const dispositions = dispositionsOfTrace(record, TRACE);
    expect(dispositions.get(SPAN)).toEqual({ state: 'exported', route: 'collector' });
    expect(dispositions.get(OTHER_SPAN)).toEqual({ state: 'rejected', reason: 'http-4xx' });
    expect(dispositionsOfTrace(record, OTHER_TRACE).size).toBe(0);
    expect(dispositionsOfTrace(record, 'nothex').size).toBe(0);
  });

  it('counts dispositions across all spans', () => {
    const record = fullRecord();
    const counts = dispositionCounts(record);
    expect(counts['exported@collector']).toBe(1);
    expect(counts['rejected:http-4xx']).toBe(1);
    expect(counts.pending).toBe(0);
  });

  it('counts zero on the empty record', () => {
    const counts = dispositionCounts(emptyTelemetryDispositionRecord());
    expect(counts.pending).toBe(0);
    expect(counts['exported@phoenix']).toBe(0);
  });
});

describe('emptyTelemetryDispositionRecord', () => {
  it('has version 1, a null fingerprint, empty spans, zero counters and no time', () => {
    const empty = emptyTelemetryDispositionRecord();
    expect(empty.version).toBe(TELEMETRY_DISPOSITION_RECORD_VERSION);
    expect(empty.saltFingerprint).toBe(null);
    expect(Object.keys(empty.spans)).toHaveLength(0);
    for (const key of TELEMETRY_COUNTER_KEYS) {
      expect(empty.counters[key]).toBe(0);
    }
    expect(empty.lastExportAtIso).toBe(null);
    expect(Object.isFrozen(empty)).toBe(true);
  });
});

describe('the reader round-trips what a write produces', () => {
  it('reads back a written record', () => {
    const result = applyDispositionWrite(emptyTelemetryDispositionRecord(), {
      saltFingerprint: FINGERPRINT,
      updates: [{ traceId: TRACE, spanId: SPAN, disposition: { state: 'exported', route: 'collector' } }],
      counters: { network: 1 },
      exportedAt: true,
      nowIso: NOW,
    });
    if (result.outcome !== 'written') {
      expect.fail('the write must succeed');
    }
    const read = readTelemetryDispositionRecord(JSON.parse(JSON.stringify(result.record)));
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.record).toEqual(result.record);
    }
  });
});
