import { describe, expect, it } from 'vitest';

import { LaneRun, readLaneRunRecord } from '../entities/LaneRun.js';
import {
  LANE_RUN_JOURNAL_ENTRY_VERSION,
  laneRunJournalState,
  prepareLaneRunJournalAppend,
} from '../lane-run-journal.js';
import type { LaneRunJournalEntryRecord } from '../lane-run-journal.js';
import {
  LANE_RUN_PROVENANCES,
  parseLaneRunProvenance,
  resolveLaneRunProvenance,
} from '../lane-run-records.js';
import {
  LANE_RUN_ADOPTED_ENTRY_STATE,
  LANE_RUN_EXITS,
  canEnterInitialLaneRunState,
  canEnterLaneRunState,
} from '../lane-run-transitions.js';
import { LANE_RUN_STATES } from '../value-objects/LaneRunState.vo.js';

const RUN_ID = 'run-01JB0000000000000000000000';
const ULID = '01JB0000000000000000000001';
const SEAT_PLAN_REF = 'a'.repeat(64);

function runRecord(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    runId: RUN_ID,
    workOrderId: 'wo-1',
    tier: 1,
    seatPlanRef: SEAT_PLAN_REF,
    cursors: { 'first-pass': null, fix: null, review: null },
    round: 0,
    attemptIds: ['attempt-1'],
    prNumber: null,
    parked: null,
    parkCount: 0,
    lease: null,
    revision: 1,
    runPolicyRevision: 'policy-1',
    ...extra,
  };
}

function conduct(state: string, runId: string = RUN_ID): LaneRunJournalEntryRecord {
  return {
    version: LANE_RUN_JOURNAL_ENTRY_VERSION,
    entryId: ULID,
    kind: 'conduct',
    key: null,
    runId,
    recordedAtIso: '2026-11-06T10:00:00.000Z',
    mode: null,
    expectedRevision: null,
    mintedId: null,
    outcome: null,
    reasonCode: null,
    detail: null,
    grantId: null,
    state: state as LaneRunJournalEntryRecord['state'],
  };
}

describe('adopted-run transition table (CO28)', () => {
  it('ready exits to dispatching and collecting', () => {
    expect(LANE_RUN_EXITS.ready).toEqual(['dispatching', 'collecting']);
    expect(LANE_RUN_ADOPTED_ENTRY_STATE).toBe('collecting');
  });

  it('canEnterLaneRunState allows ready to collecting and keeps the other rows', () => {
    expect(canEnterLaneRunState('ready', 'collecting', null, false, 'adopted')).toBe(true);
    expect(canEnterLaneRunState('ready', 'dispatching')).toBe(true);
    expect(canEnterLaneRunState('ready', 'gating')).toBe(false);
    expect(canEnterLaneRunState('ready', 'running')).toBe(false);
    expect(canEnterLaneRunState('dispatching', 'collecting')).toBe(false);
  });

  it('refuses ready to collecting for a started, provenance-absent or unreadable run (the transition itself)', () => {
    for (const provenance of ['started', undefined, null, 'unknown', '', 'Adopted', 1, {}, ['adopted']]) {
      expect(canEnterLaneRunState('ready', 'collecting', null, false, provenance)).toBe(false);
    }
    expect(canEnterLaneRunState('ready', 'collecting')).toBe(false);
    expect(canEnterLaneRunState('ready', 'dispatching', null, false, 'started')).toBe(true);
    // The adopted entry does not widen any other row.
    expect(canEnterLaneRunState('dispatching', 'collecting', null, false, 'adopted')).toBe(false);
    expect(canEnterLaneRunState('ready', 'gating', null, false, 'adopted')).toBe(false);
    expect(canEnterLaneRunState('ready', 'collecting', null, false, resolveLaneRunProvenance({}))).toBe(false);
    expect(canEnterLaneRunState('ready', 'collecting', null, false, resolveLaneRunProvenance({ provenance: 'adopted' }))).toBe(true);
  });

  it('an initial collecting conduct entry is accepted by the journal and projects collecting', () => {
    const entry = conduct('collecting');
    const decision = prepareLaneRunJournalAppend([], entry);
    expect(decision.ok).toBe(true);
    expect(laneRunJournalState([entry], RUN_ID)).toBe('collecting');
    expect(laneRunJournalState([], RUN_ID)).toBe('ready');
  });

  it('canEnterInitialLaneRunState accepts only the two provenance pairs', () => {
    expect(canEnterInitialLaneRunState('started', 'dispatching')).toBe(true);
    expect(canEnterInitialLaneRunState('adopted', 'collecting')).toBe(true);
    expect(canEnterInitialLaneRunState('started', 'collecting')).toBe(false);
    expect(canEnterInitialLaneRunState('adopted', 'dispatching')).toBe(false);
    for (const state of LANE_RUN_STATES) {
      if (state !== 'dispatching') expect(canEnterInitialLaneRunState('started', state)).toBe(false);
      if (state !== 'collecting') expect(canEnterInitialLaneRunState('adopted', state)).toBe(false);
    }
  });

  it('canEnterInitialLaneRunState is total on invalid runtime values', () => {
    const hostile = { toString: () => { throw new Error('boom'); } };
    const values: unknown[] = [undefined, null, 0, 1, '', 'Started', 'unknown', [], {}, hostile, Symbol('x')];
    for (const provenance of values) {
      for (const to of values) {
        expect(() => canEnterInitialLaneRunState(provenance, to)).not.toThrow();
        expect(canEnterInitialLaneRunState(provenance, to)).toBe(false);
      }
    }
    expect(canEnterInitialLaneRunState('adopted', hostile)).toBe(false);
    expect(canEnterInitialLaneRunState(hostile, 'collecting')).toBe(false);
  });
});

describe('lane run provenance (D-R8)', () => {
  it('lists exactly started and adopted', () => {
    expect([...LANE_RUN_PROVENANCES]).toEqual(['started', 'adopted']);
  });

  it('parseLaneRunProvenance accepts only the two values', () => {
    expect(parseLaneRunProvenance('started')).toBe('started');
    expect(parseLaneRunProvenance('adopted')).toBe('adopted');
    for (const value of [undefined, null, '', 'Adopted', 'unknown', 1, true, [], {}, 'toString', '__proto__']) {
      expect(parseLaneRunProvenance(value)).toBeUndefined();
    }
  });

  it('resolveLaneRunProvenance reads absent and undefined as started', () => {
    expect(resolveLaneRunProvenance({})).toBe('started');
    expect(resolveLaneRunProvenance({ provenance: undefined })).toBe('started');
    expect(resolveLaneRunProvenance({ provenance: 'started' })).toBe('started');
    expect(resolveLaneRunProvenance({ provenance: 'adopted' })).toBe('adopted');
  });

  it('resolveLaneRunProvenance reads every other present value as unknown', () => {
    for (const provenance of [null, '', 'imported', 'ADOPTED', 7, true, [], {}]) {
      expect(resolveLaneRunProvenance({ provenance })).toBe('unknown');
    }
  });

  it('resolveLaneRunProvenance is total and never reads the prototype', () => {
    for (const value of [null, undefined, 'adopted', 3, [], [{ provenance: 'adopted' }]]) {
      expect(resolveLaneRunProvenance(value)).toBe('unknown');
    }
    const throwing = {
      get provenance(): string {
        throw new Error('boom');
      },
    };
    expect(resolveLaneRunProvenance(throwing)).toBe('unknown');
    const inherited = Object.create({ provenance: 'adopted' }) as Record<string, unknown>;
    expect(resolveLaneRunProvenance(inherited)).toBe('started');
  });
});

describe('LaneRun record reader and provenance (D-R8)', () => {
  it('reads a legacy record without provenance and keeps it absent', () => {
    const read = readLaneRunRecord(runRecord());
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(Object.hasOwn(read.record, 'provenance')).toBe(false);
      expect(resolveLaneRunProvenance(read.record)).toBe('started');
    }
  });

  it('preserves started and adopted through read and toRecord', () => {
    for (const provenance of LANE_RUN_PROVENANCES) {
      const read = readLaneRunRecord(runRecord({ provenance }));
      expect(read.ok).toBe(true);
      if (read.ok) {
        expect(read.record.provenance).toBe(provenance);
      }
      const created = LaneRun.create(runRecord({ provenance }));
      expect(created.success).toBe(true);
      if (created.success) {
        expect(created.value.toRecord().provenance).toBe(provenance);
      }
    }
  });

  it('refuses an unknown, null, empty, numeric or undefined-valued provenance as malformed', () => {
    for (const provenance of ['imported', 'Adopted', '', null, 1, true, [], {}, undefined]) {
      const read = readLaneRunRecord(runRecord({ provenance }));
      expect(read).toEqual({ ok: false, reason: 'malformed' });
      expect(LaneRun.create(runRecord({ provenance })).success).toBe(false);
    }
  });

  it('refuses a provenance supplied by a getter without running it', () => {
    let ran = false;
    const record = runRecord();
    Object.defineProperty(record, 'provenance', {
      enumerable: true,
      get(): string {
        ran = true;
        return 'adopted';
      },
    });
    expect(readLaneRunRecord(record)).toEqual({ ok: false, reason: 'malformed' });
    expect(ran).toBe(false);
  });
});
