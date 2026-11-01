import { describe, expect, it } from 'vitest';

import {
  CONDUCTOR_PASS_TRACE_MAX_STEPS,
  conductorPassTraceOf,
  parseConductorPassTraceStateRecord,
  readConductorPassTrace,
  type ConductorPassTraceInput,
} from '../conductor-pass-trace.js';

const RUN_ID = 'run-01JB0000000000000000000000';
const NOW = '2026-10-27T10:00:00.000Z';

type JsonRecord = Record<string, unknown>;

function validStep(overrides: JsonRecord = {}): JsonRecord {
  return { outcome: 'entered', state: 'running', ...overrides };
}

function validReport(overrides: JsonRecord = {}): JsonRecord {
  return { outcome: 'advanced', steps: [validStep()], ...overrides };
}

function validRecord(overrides: JsonRecord = {}): JsonRecord {
  return {
    passId: 'pass-1',
    nowIso: NOW,
    holderId: 'driver-x',
    halted: false,
    progressed: true,
    maxActiveRuns: 1,
    passConcurrency: 1,
    dispatchStaggerMs: 20000,
    runs: [{ runId: RUN_ID, report: validReport() }],
    attention: [{ runId: RUN_ID, kind: 'stop-grace-exceeded' }],
    ...overrides,
  };
}

describe('readConductorPassTrace', () => {
  it('reads a full valid record without schemaVersion as version 1', () => {
    const read = readConductorPassTrace(validRecord());
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.record.schemaVersion).toBe(1);
      expect(read.record).toEqual({
        schemaVersion: 1,
        passId: 'pass-1',
        nowIso: NOW,
        holderId: 'driver-x',
        halted: false,
        progressed: true,
        maxActiveRuns: 1,
        passConcurrency: 1,
        dispatchStaggerMs: 20000,
        runs: [{ runId: RUN_ID, report: { outcome: 'advanced', steps: [{ outcome: 'entered', state: 'running' }] } }],
        attention: [{ runId: RUN_ID, kind: 'stop-grace-exceeded' }],
      });
    }
  });

  it('accepts schemaVersion 1 and refuses other versions', () => {
    expect(readConductorPassTrace(validRecord({ schemaVersion: 1 })).ok).toBe(true);
    for (const version of [2, '1', null]) {
      expect(readConductorPassTrace(validRecord({ schemaVersion: version }))).toEqual({
        ok: false,
        reason: 'unknown-schema-version',
      });
    }
  });

  it('drops unknown step fields', () => {
    const read = readConductorPassTrace(
      validRecord({
        runs: [{ runId: RUN_ID, report: { outcome: 'advanced', steps: [validStep({ worktreePath: '/x' })] } }],
      }),
    );
    expect(read.ok).toBe(true);
    if (read.ok) {
      const report = read.record.runs[0]!.report;
      expect(report.outcome).toBe('advanced');
      if (report.outcome === 'advanced') {
        expect(report.steps[0]).toEqual({ outcome: 'entered', state: 'running' });
        expect(Object.hasOwn(report.steps[0]!, 'worktreePath')).toBe(false);
      }
    }
  });

  it('caps steps at 8', () => {
    const nineSteps = Array.from({ length: 9 }, () => validStep());
    expect(readConductorPassTrace(validRecord({ runs: [{ runId: RUN_ID, report: { outcome: 'advanced', steps: nineSteps } }] }))).toEqual({
      ok: false,
      reason: 'malformed',
    });
    const eightSteps = Array.from({ length: 8 }, () => validStep());
    expect(readConductorPassTrace(validRecord({ runs: [{ runId: RUN_ID, report: { outcome: 'advanced', steps: eightSteps } }] })).ok).toBe(true);
    expect(CONDUCTOR_PASS_TRACE_MAX_STEPS).toBe(8);
  });

  it('refuses a step with an unparseable key and a free-text reason', () => {
    expect(
      readConductorPassTrace(validRecord({ runs: [{ runId: RUN_ID, report: { outcome: 'advanced', steps: [validStep({ key: 'not-a-key' })] } }] })),
    ).toEqual({ ok: false, reason: 'malformed' });
    expect(readConductorPassTrace(validRecord({ runs: [{ runId: RUN_ID, report: { outcome: 'skipped', reason: 'Has Spaces' } }] }))).toEqual({
      ok: false,
      reason: 'malformed',
    });
  });

  it('refuses malformed header fields', () => {
    expect(readConductorPassTrace(validRecord({ passId: 'a/b' }))).toEqual({ ok: false, reason: 'malformed' });
    expect(readConductorPassTrace(validRecord({ nowIso: 'yesterday' }))).toEqual({ ok: false, reason: 'malformed' });
    expect(readConductorPassTrace(validRecord({ maxActiveRuns: 0 }))).toEqual({ ok: false, reason: 'malformed' });
    expect(readConductorPassTrace(validRecord({ dispatchStaggerMs: -1 }))).toEqual({ ok: false, reason: 'malformed' });
  });

  it('refuses non-object inputs and a throwing getter without throwing', () => {
    for (const input of [null, [], 'x']) {
      expect(readConductorPassTrace(input)).toEqual({ ok: false, reason: 'malformed' });
    }
    const throwing: JsonRecord = { ...validRecord(), get runs() { throw new Error('boom'); } };
    expect(() => readConductorPassTrace(throwing)).not.toThrow();
    expect(readConductorPassTrace(throwing)).toEqual({ ok: false, reason: 'malformed' });
  });

  it('returns a fresh copy unaffected by later input mutation', () => {
    const input = validRecord() as {
      runs: Array<{ runId: string; report: JsonRecord }>;
      attention: Array<JsonRecord>;
    };
    const read = readConductorPassTrace(input);
    expect(read.ok).toBe(true);
    input.runs.push({ runId: RUN_ID, report: { outcome: 'skipped', reason: 'lease-held' } });
    (input.runs[0]!.report.steps as JsonRecord[]).push({ outcome: 'entered' });
    input.attention.push({ runId: RUN_ID, kind: 'out-of-scope-findings' });
    if (read.ok) {
      expect(read.record.runs).toHaveLength(1);
      expect(read.record.attention).toHaveLength(1);
      const report = read.record.runs[0]!.report;
      if (report.outcome === 'advanced') {
        expect(report.steps).toHaveLength(1);
      }
    }
  });

  it('parseConductorPassTraceStateRecord returns the record or undefined', () => {
    expect(parseConductorPassTraceStateRecord(validRecord())).toBeDefined();
    expect(parseConductorPassTraceStateRecord(validRecord({ schemaVersion: 2 }))).toBeUndefined();
    expect(parseConductorPassTraceStateRecord(null)).toBeUndefined();
  });
});

const DISPATCH_KEY = 'run-01JB0000000000000000000000/r0/dispatch/0/a1';
const LIMITS = { maxActiveRuns: 2, passConcurrency: 1, dispatchStaggerMs: 20000 };

describe('conductorPassTraceOf', () => {
  it('builds a valid trace from a real-shaped advanced report and copies the limits', () => {
    const input: ConductorPassTraceInput = {
      passId: 'pass-1',
      nowIso: NOW,
      holderId: 'driver-x',
      halted: false,
      progressed: true,
      runs: [
        {
          runId: RUN_ID,
          outcome: 'advanced',
          steps: [
            { outcome: 'entered', state: 'gating' },
            { outcome: 'waiting', reason: 'admission' },
            {
              outcome: 'acted',
              step: 'dispatch',
              key: DISPATCH_KEY,
              result: 'completed',
              reasonCode: null,
              detail: null,
            },
          ],
        },
        { runId: RUN_ID, outcome: 'skipped', reason: 'lease-held' },
        { runId: RUN_ID, outcome: 'resume-refused', reason: 'save-refused' },
      ],
      attention: [{ runId: RUN_ID, kind: 'stop-grace-exceeded' }],
    };
    const read = conductorPassTraceOf(input, LIMITS);
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.record.schemaVersion).toBe(1);
      expect(read.record.maxActiveRuns).toBe(2);
      expect(read.record.passConcurrency).toBe(1);
      expect(read.record.dispatchStaggerMs).toBe(20000);
      expect(read.record.runs).toHaveLength(3);
      expect(read.record.runs[0]!.report).toEqual({
        outcome: 'advanced',
        steps: [
          { outcome: 'entered', state: 'gating' },
          { outcome: 'waiting', reason: 'admission' },
          {
            outcome: 'acted',
            step: 'dispatch',
            key: DISPATCH_KEY,
            result: 'completed',
            reasonCode: null,
            detail: null,
          },
        ],
      });
      expect(read.record.runs[1]!.report).toEqual({ outcome: 'skipped', reason: 'lease-held' });
      expect(read.record.runs[2]!.report).toEqual({ outcome: 'resume-refused', reason: 'save-refused' });
    }
  });

  it('caps nine steps at eight, keeping the first eight in order', () => {
    const nineSteps = Array.from({ length: 9 }, (_, index) => ({
      outcome: 'entered',
      state: `gating-${index}`,
    }));
    const read = conductorPassTraceOf(
      {
        passId: 'pass-1',
        nowIso: NOW,
        holderId: 'driver-x',
        halted: false,
        progressed: true,
        runs: [{ runId: RUN_ID, outcome: 'advanced', steps: nineSteps }],
        attention: [],
      },
      { maxActiveRuns: 1, passConcurrency: 1, dispatchStaggerMs: 20000 },
    );
    expect(read.ok).toBe(true);
    if (read.ok) {
      const report = read.record.runs[0]!.report;
      if (report.outcome === 'advanced') {
        expect(report.steps).toHaveLength(8);
        expect(report.steps).toEqual(nineSteps.slice(0, 8));
      }
    }
  });

  it('drops worktree paths, ssh aliases and ports wherever they appear', () => {
    const input = {
      passId: 'pass-1',
      nowIso: NOW,
      holderId: 'driver-x',
      halted: false,
      progressed: true,
      worktreePath: '/srv/x',
      sshAlias: 'mac-mini',
      port: 2222,
      runs: [
        {
          runId: RUN_ID,
          outcome: 'advanced',
          worktreePath: '/srv/x',
          sshAlias: 'mac-mini',
          port: 2222,
          steps: [{ outcome: 'entered', state: 'running', worktreePath: '/srv/x', sshAlias: 'mac-mini', port: 2222 }],
        },
      ],
      attention: [],
    } as unknown as ConductorPassTraceInput;
    const read = conductorPassTraceOf(input, { maxActiveRuns: 1, passConcurrency: 1, dispatchStaggerMs: 20000 });
    expect(read.ok).toBe(true);
    if (read.ok) {
      const text = JSON.stringify(read.record);
      expect(text).not.toContain('/srv/x');
      expect(text).not.toContain('mac-mini');
      expect(text).not.toContain('2222');
    }
  });

  it('refuses an invalid time and zero limits as malformed', () => {
    const base = {
      passId: 'pass-1',
      nowIso: NOW,
      holderId: 'driver-x',
      halted: false,
      progressed: true,
      runs: [],
      attention: [],
    } as ConductorPassTraceInput;
    expect(
      conductorPassTraceOf({ ...base, nowIso: 'later' }, { maxActiveRuns: 1, passConcurrency: 1, dispatchStaggerMs: 20000 }),
    ).toEqual({ ok: false, reason: 'malformed' });
    expect(conductorPassTraceOf(base, { maxActiveRuns: 0, passConcurrency: 1, dispatchStaggerMs: 20000 })).toEqual({
      ok: false,
      reason: 'malformed',
    });
  });

  it('refuses limits that carry extra fields and stamps schemaVersion 1 on the record', () => {
    const base = {
      passId: 'pass-1',
      nowIso: NOW,
      holderId: 'driver-x',
      halted: false,
      progressed: true,
      runs: [],
      attention: [],
    } as ConductorPassTraceInput;
    expect(conductorPassTraceOf(base, { ...LIMITS, schemaVersion: 2 } as never)).toEqual({
      ok: false,
      reason: 'malformed',
    });
    const read = conductorPassTraceOf(base, LIMITS);
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.record.schemaVersion).toBe(1);
    }
  });
});
