import { describe, expect, it } from 'vitest';

import {
  readActionJournalEntryRecord,
  readAttemptRecord,
  readCapacityReservationRecord,
} from '../execution-record-readers.js';

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const without = <T>(value: T, key: string): T => {
  const copy = { ...value } as Record<string, unknown>;
  delete copy[key];
  return copy as T;
};

const validAttempt = {
  schemaVersion: 1,
  id: 'att_123',
  workOrderId: 'wo_456',
  kind: 'initial',
  fixNumber: 0,
  priorAttemptId: null,
  worktreePath: '.lane/worktrees/abc',
  baseCommit: 'deadbeef',
  state: 'running',
  revision: 2,
  dispatchRevision: 1,
  outcome: 'partial',
  briefDigest: 'sha256:abc',
  briefPackagePath: '.lane/briefs/abc.json',
  sessionId: 'ses_1',
  completionReceipt: {
    attemptId: 'att_123',
    sessionId: 'ses_1',
    endedAtIso: '2026-11-01T00:00:00.000Z',
    authoritative: true,
    exitStatus: 0,
    stoppedByRequest: false,
  },
  artifacts: {
    headCommit: 'cafebabe',
    commitsSinceBase: ['aaa', 'bbb'],
    collectedArtifactPaths: ['dist/x.js'],
    notes: 'present',
    manifestPath: '.lane/artifacts-manifest-abcdef.json',
    manifestSha256: 'abcd'.repeat(8) + 'ef'.repeat(8) + '0123'.repeat(4),
  },
  runner: {
    kind: 'opencode',
    remotePort: 4321,
    host: 'host-alias',
    hostName: 'lane-host',
    agent: 'agent-x',
    model: 'model-y',
    variant: 'v1',
    useFreeSeats: true,
  },
  seatOverride: {
    model: 'model-z',
    agent: 'agent-z',
    variant: 'v2',
    reason: 'operator asked',
    setBy: 'ops',
    expiresAtIso: '2026-11-02T00:00:00.000Z',
  },
  usage: {
    source: 'opencode-db',
    readAtIso: '2026-11-01T00:00:00.000Z',
    sessionId: 'ses_1',
    steps: 42,
    wallSeconds: 0.25,
    tokensInput: 100,
    tokensOutput: 200,
    tokensReasoning: 10,
    tokensCacheRead: 5,
    tokensCacheWrite: 3,
    costUsd: 0.25,
    model: 'model-y',
    agent: 'agent-x',
    reason: null,
  },
  stopReason: 'rate-limited',
  seatPlan: {
    version: 1,
    'first-pass': [{ id: 's1', model: 'm1', tool: 'opencode', variant: 'v', agent: 'a', on: ['rate-limited'] }],
    fix: [{ id: 's2', model: 'm2', tool: 'agy' }],
    review: [{ id: 's3', model: 'm3', tool: 'opencode' }],
  },
  seatSelection: {
    role: 'first-pass',
    seatIndex: 0,
    seatId: 's1',
    model: 'm1',
    tool: 'opencode',
    variant: 'v',
    agent: 'a',
    ticket: 7,
    availableCount: 3,
  },
  reviewerSeat: 'rev-1',
  dispatchedTimeLimitSeconds: 3600,
  ownerDecisionReferences: ['decision-1', 'decision-2'],
  createdAtIso: '2026-11-01T00:00:00.000Z',
  updatedAtIso: '2026-11-01T00:01:00.000Z',
};

const validReservation = {
  schemaVersion: 1,
  id: 'res_1',
  attemptId: 'att_1',
  hostId: 'host_1',
  slotIndex: 0,
  held: true,
  seatTool: 'opencode',
  hostName: 'lane-host',
  hostKind: 'opencode',
  transport: 'ssh',
  sshAlias: 'alias',
  port: 22,
  worktreePath: '.lane/worktrees/x',
  reservedAtIso: '2026-11-01T00:00:00.000Z',
  releasedAtIso: null,
};

const validJournal = {
  schemaVersion: 1,
  id: 'jrn_1',
  attemptId: 'att_1',
  workOrderId: 'wo_1',
  action: 'dispatch',
  baseCommit: 'deadbeef',
  recordedAtIso: '2026-11-01T00:00:00.000Z',
  status: 'intent-recorded',
  sessionId: 'ses_1',
  detail: null,
  stopReason: 'none',
  observedSessionIds: ['ses_1', 'ses_2'],
  authorizedBy: 'policy:autoMerge@3',
};

function defineGetter(target: Record<string, unknown>, key: string): Record<string, unknown> {
  Object.defineProperty(target, key, {
    get() {
      throw new Error('a getter must never run during a read');
    },
    enumerable: true,
  });
  return target;
}

function throwingProxy(): object {
  return new Proxy(
    {},
    {
      ownKeys() {
        throw new Error('boom');
      },
      getOwnPropertyDescriptor() {
        throw new Error('boom');
      },
      getPrototypeOf() {
        throw new Error('boom');
      },
    },
  );
}

const allReaders = [
  ['attempt', readAttemptRecord, validAttempt],
  ['reservation', readCapacityReservationRecord, validReservation],
  ['journal', readActionJournalEntryRecord, validJournal],
] as const;

describe('execution-record-readers: schema version contract', () => {
  it('reads an absent schemaVersion as 1', () => {
    for (const [, read, fixture] of allReaders) {
      const result = read(without(clone(fixture), 'schemaVersion'));
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.record.schemaVersion).toBe(1);
      }
    }
  });

  it('refuses a non-1 schemaVersion as unknown-schema-version', () => {
    const badVersions: unknown[] = [0, -1, 2, 99, 1.5, '1', null, undefined, true, {}];
    for (const [, read, fixture] of allReaders) {
      for (const value of badVersions) {
        const input = { ...clone(fixture), schemaVersion: value };
        expect(read(input)).toEqual({ ok: false, reason: 'unknown-schema-version' });
      }
      const withFutureField = { ...clone(fixture), schemaVersion: 99, unknownFutureField: 'x' };
      expect(read(withFutureField)).toEqual({ ok: false, reason: 'unknown-schema-version' });
    }
  });

  it('applies the migration window for currentVersion 2', () => {
    for (const [, read, fixture] of allReaders) {
      expect(read(without(clone(fixture), 'schemaVersion'), { currentVersion: 2 }).ok).toBe(true);
      expect(read({ ...clone(fixture), schemaVersion: 1 }, { currentVersion: 2 }).ok).toBe(true);
      expect(read({ ...clone(fixture), schemaVersion: 2 }, { currentVersion: 2 }).ok).toBe(true);
      expect(read({ ...clone(fixture), schemaVersion: 0 }, { currentVersion: 2 })).toEqual({
        ok: false,
        reason: 'unknown-schema-version',
      });
      expect(read({ ...clone(fixture), schemaVersion: 3 }, { currentVersion: 2 })).toEqual({
        ok: false,
        reason: 'unknown-schema-version',
      });
    }
  });

  it('applies the migration window for currentVersion 3', () => {
    for (const [, read, fixture] of allReaders) {
      expect(read(without(clone(fixture), 'schemaVersion'), { currentVersion: 3 })).toEqual({
        ok: false,
        reason: 'unknown-schema-version',
      });
      expect(read({ ...clone(fixture), schemaVersion: 1 }, { currentVersion: 3 })).toEqual({
        ok: false,
        reason: 'unknown-schema-version',
      });
      expect(read({ ...clone(fixture), schemaVersion: 2 }, { currentVersion: 3 }).ok).toBe(true);
      expect(read({ ...clone(fixture), schemaVersion: 3 }, { currentVersion: 3 }).ok).toBe(true);
      expect(read({ ...clone(fixture), schemaVersion: 4 }, { currentVersion: 3 })).toEqual({
        ok: false,
        reason: 'unknown-schema-version',
      });
    }
  });
});

describe('execution-record-readers: round-trip', () => {
  it('round-trips every declared attempt field and returns fresh nested copies', () => {
    const input = clone(validAttempt);
    const result = readAttemptRecord(input);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.record).toEqual(input);
    expect(result.record.seatPlan).not.toBe(input.seatPlan);
    expect(result.record.seatPlan?.['first-pass']).not.toBe(input.seatPlan['first-pass']);
    expect(result.record.seatPlan?.['first-pass']?.[0]).not.toBe(input.seatPlan['first-pass'][0]);
    expect(result.record.artifacts?.commitsSinceBase).not.toBe(input.artifacts.commitsSinceBase);
    expect(result.record.artifacts?.collectedArtifactPaths).not.toBe(input.artifacts.collectedArtifactPaths);
    expect(result.record.ownerDecisionReferences).not.toBe(input.ownerDecisionReferences);
    expect(result.record.runner).not.toBe(input.runner);
    expect(result.record.usage).not.toBe(input.usage);
    expect(result.record.seatSelection).not.toBe(input.seatSelection);
    expect(result.record.seatOverride).not.toBe(input.seatOverride);
    expect(result.record.completionReceipt).not.toBe(input.completionReceipt);
    input.artifacts.commitsSinceBase.push('mutated');
    (input.seatPlan['first-pass'] as Array<Record<string, unknown>>).push({ id: 'x', model: 'y' });
    input.runner.hostName = 'mutated-host';
    expect(result.record.artifacts?.commitsSinceBase).not.toContain('mutated');
    expect(result.record.seatPlan?.['first-pass']).toHaveLength(1);
    expect(result.record.runner?.hostName).toBe('lane-host');
  });

  it('round-trips every declared reservation field', () => {
    const input = clone(validReservation);
    const result = readCapacityReservationRecord(input);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.record).toEqual(input);
    }
  });

  it('round-trips every declared action-journal field', () => {
    const input = clone(validJournal);
    const result = readActionJournalEntryRecord(input);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.record).toEqual(input);
    expect(result.record.observedSessionIds).not.toBe(input.observedSessionIds);
  });
});

describe('execution-record-readers: attempt tightening (D6)', () => {
  it('reads revision absent as 0, keeps a non-negative safe integer, and refuses anything else', () => {
    const absent = readAttemptRecord(without(clone(validAttempt), 'revision'));
    expect(absent.ok).toBe(true);
    if (absent.ok) {
      expect(absent.record.revision).toBe(0);
    }
    const kept = readAttemptRecord(clone(validAttempt));
    expect(kept.ok).toBe(true);
    if (kept.ok) {
      expect(kept.record.revision).toBe(2);
    }
    expect(readAttemptRecord({ ...clone(validAttempt), revision: 1.5 })).toEqual({
      ok: false,
      reason: 'malformed',
    });
    expect(readAttemptRecord({ ...clone(validAttempt), revision: -1 })).toEqual({
      ok: false,
      reason: 'malformed',
    });
  });

  it('normalizes runner kind, remotePort and hostName', () => {
    const noKind = readAttemptRecord({ ...clone(validAttempt), runner: { ...validAttempt.runner, kind: undefined } });
    expect(noKind.ok).toBe(true);
    if (noKind.ok) {
      expect(noKind.record.runner?.kind).toBe('opencode');
    }
    const agy = readAttemptRecord({ ...clone(validAttempt), runner: { ...validAttempt.runner, kind: 'agy' } });
    expect(agy.ok).toBe(true);
    if (agy.ok) {
      expect(agy.record.runner?.kind).toBe('agy');
    }
    expect(readAttemptRecord({ ...clone(validAttempt), runner: { ...validAttempt.runner, kind: 'nope' } })).toEqual({
      ok: false,
      reason: 'malformed',
    });

    const noPort = readAttemptRecord({
      ...clone(validAttempt),
      runner: { ...validAttempt.runner, remotePort: undefined },
    });
    expect(noPort.ok).toBe(true);
    if (noPort.ok) {
      expect(noPort.record.runner?.remotePort).toBeNull();
    }
    const portOne = readAttemptRecord({ ...clone(validAttempt), runner: { ...validAttempt.runner, remotePort: 1 } });
    expect(portOne.ok).toBe(true);
    if (portOne.ok) {
      expect(portOne.record.runner?.remotePort).toBe(1);
    }
    expect(readAttemptRecord({ ...clone(validAttempt), runner: { ...validAttempt.runner, remotePort: 1.5 } })).toEqual(
      { ok: false, reason: 'malformed' },
    );

    for (const hostName of [undefined, '', '   ']) {
      const read = readAttemptRecord({ ...clone(validAttempt), runner: { ...validAttempt.runner, hostName } });
      expect(read.ok).toBe(true);
      if (read.ok) {
        expect(read.record.runner?.hostName).toBeNull();
      }
    }
    const keptHost = readAttemptRecord({ ...clone(validAttempt), runner: { ...validAttempt.runner, hostName: 'lane-host' } });
    expect(keptHost.ok).toBe(true);
    if (keptHost.ok) {
      expect(keptHost.record.runner?.hostName).toBe('lane-host');
    }
    expect(readAttemptRecord({ ...clone(validAttempt), runner: { ...validAttempt.runner, hostName: 1 } })).toEqual({
      ok: false,
      reason: 'malformed',
    });
  });

  it('refuses an invalid state', () => {
    expect(readAttemptRecord({ ...clone(validAttempt), state: 'not-a-state' })).toEqual({
      ok: false,
      reason: 'malformed',
    });
  });

  it('keeps float usage values', () => {
    const result = readAttemptRecord(clone(validAttempt));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.record.usage?.costUsd).toBe(0.25);
      expect(result.record.usage?.wallSeconds).toBe(0.25);
    }
  });

  it('omits optional attempt fields when their value is undefined', () => {
    const inputWithUndefined = {
      ...clone(validAttempt),
      dispatchRevision: undefined,
      dispatchedTimeLimitSeconds: undefined,
      seatOverride: undefined,
      usage: undefined,
      seatSelection: undefined,
      seatPlan: undefined,
      stopReason: undefined,
      reviewerSeat: undefined,
      ownerDecisionReferences: undefined,
    };
    const result = readAttemptRecord(inputWithUndefined);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(Object.hasOwn(result.record, 'dispatchRevision')).toBe(false);
    expect(Object.hasOwn(result.record, 'dispatchedTimeLimitSeconds')).toBe(false);
    expect(Object.hasOwn(result.record, 'seatOverride')).toBe(false);
    expect(Object.hasOwn(result.record, 'usage')).toBe(false);
    expect(Object.hasOwn(result.record, 'seatSelection')).toBe(false);
    expect(Object.hasOwn(result.record, 'seatPlan')).toBe(false);
    expect(Object.hasOwn(result.record, 'stopReason')).toBe(false);
    expect(Object.hasOwn(result.record, 'reviewerSeat')).toBe(false);
    expect(Object.hasOwn(result.record, 'ownerDecisionReferences')).toBe(false);
  });

  it('refuses a missing key on usage sessionId, model, agent, and reason', () => {
    const fields = ['sessionId', 'model', 'agent', 'reason'] as const;
    for (const field of fields) {
      const missingAttempt = clone(validAttempt);
      const usageCopy = { ...missingAttempt.usage };
      delete (usageCopy as Record<string, unknown>)[field];
      missingAttempt.usage = usageCopy as typeof validAttempt.usage;
      expect(readAttemptRecord(missingAttempt)).toEqual({
        ok: false,
        reason: 'malformed',
      });

      const nullAttempt = clone(validAttempt);
      nullAttempt.usage = {
        ...nullAttempt.usage,
        [field]: null,
      };
      const nullResult = readAttemptRecord(nullAttempt);
      expect(nullResult.ok).toBe(true);
      if (nullResult.ok) {
        expect(nullResult.record.usage?.[field]).toBeNull();
      }
    }
  });

  it('refuses a missing key on seatSelection tool, variant, and agent', () => {
    const fields = ['tool', 'variant', 'agent'] as const;
    for (const field of fields) {
      const missingAttempt = clone(validAttempt);
      const seatSelectionCopy = { ...missingAttempt.seatSelection };
      delete (seatSelectionCopy as Record<string, unknown>)[field];
      missingAttempt.seatSelection = seatSelectionCopy as typeof validAttempt.seatSelection;
      expect(readAttemptRecord(missingAttempt)).toEqual({
        ok: false,
        reason: 'malformed',
      });

      const nullAttempt = clone(validAttempt);
      nullAttempt.seatSelection = {
        ...nullAttempt.seatSelection,
        [field]: null,
      };
      const nullResult = readAttemptRecord(nullAttempt);
      expect(nullResult.ok).toBe(true);
      if (nullResult.ok) {
        expect(nullResult.record.seatSelection?.[field]).toBeNull();
      }
    }
  });
});

describe('execution-record-readers: reservation null normalizations', () => {
  it('normalizes absent or unknown host fields to null', () => {
    for (const seatTool of [undefined, 'nope', 1]) {
      const read = readCapacityReservationRecord({ ...clone(validReservation), seatTool });
      expect(read.ok).toBe(true);
      if (read.ok) {
        expect(read.record.seatTool).toBeNull();
      }
    }
    for (const hostKind of [undefined, 'nope']) {
      const read = readCapacityReservationRecord({ ...clone(validReservation), hostKind });
      expect(read.ok).toBe(true);
      if (read.ok) {
        expect(read.record.hostKind).toBeNull();
      }
    }
    for (const transport of [undefined, 'https']) {
      const read = readCapacityReservationRecord({ ...clone(validReservation), transport });
      expect(read.ok).toBe(true);
      if (read.ok) {
        expect(read.record.transport).toBeNull();
      }
    }
    const withoutHostName = without(clone(validReservation), 'hostName');
    for (const input of [withoutHostName, { ...clone(validReservation), hostName: '' }, { ...clone(validReservation), hostName: '   ' }]) {
      const read = readCapacityReservationRecord(input);
      expect(read.ok).toBe(true);
      if (read.ok) {
        expect(read.record.hostName).toBeNull();
      }
    }
    for (const sshAlias of [undefined, '']) {
      const read = readCapacityReservationRecord({ ...clone(validReservation), sshAlias });
      expect(read.ok).toBe(true);
      if (read.ok) {
        expect(read.record.sshAlias).toBeNull();
      }
    }
    for (const worktreePath of [undefined, '']) {
      const read = readCapacityReservationRecord({ ...clone(validReservation), worktreePath });
      expect(read.ok).toBe(true);
      if (read.ok) {
        expect(read.record.worktreePath).toBeNull();
      }
    }
  });

  it('normalizes port with null for anything that is not a positive safe integer', () => {
    const kept = readCapacityReservationRecord(clone(validReservation));
    expect(kept.ok).toBe(true);
    if (kept.ok) {
      expect(kept.record.port).toBe(22);
    }
    for (const port of [1.5, Number.MAX_SAFE_INTEGER + 1, 0, -1, '22']) {
      const read = readCapacityReservationRecord({ ...clone(validReservation), port });
      expect(read.ok).toBe(true);
      if (read.ok) {
        expect(read.record.port).toBeNull();
      }
    }
  });

  it('refuses a held reservation with a non-null releasedAtIso and normalizes an omitted one', () => {
    expect(readCapacityReservationRecord({ ...clone(validReservation), releasedAtIso: '2026-11-02T00:00:00.000Z' })).toEqual({
      ok: false,
      reason: 'malformed',
    });
    const read = readCapacityReservationRecord(without(clone(validReservation), 'releasedAtIso'));
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.record.releasedAtIso).toBeNull();
    }
  });
});

describe('execution-record-readers: action journal', () => {
  it('refuses an invalid action and an invalid status', () => {
    expect(readActionJournalEntryRecord({ ...clone(validJournal), action: 'explode' })).toEqual({
      ok: false,
      reason: 'malformed',
    });
    expect(readActionJournalEntryRecord({ ...clone(validJournal), status: 'exploded' })).toEqual({
      ok: false,
      reason: 'malformed',
    });
  });

  it('round-trips a declared stopReason through parseStopReason and refuses a non-string one', () => {
    const read = readActionJournalEntryRecord(clone(validJournal));
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.record.stopReason).toBe('none');
    }
    expect(readActionJournalEntryRecord({ ...clone(validJournal), stopReason: 5 })).toEqual({
      ok: false,
      reason: 'malformed',
    });
    const unknown = readActionJournalEntryRecord({ ...clone(validJournal), stopReason: 'not-declared' });
    expect(unknown.ok).toBe(true);
    if (unknown.ok) {
      expect(unknown.record.stopReason).toBe('unknown');
    }
  });

  it('copies observedSessionIds fresh and keeps absent optional keys omitted', () => {
    const input = clone(validJournal);
    const minimal = without(without(input, 'stopReason'), 'observedSessionIds');
    const read = readActionJournalEntryRecord(minimal);
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(Object.hasOwn(read.record, 'stopReason')).toBe(false);
      expect(Object.hasOwn(read.record, 'observedSessionIds')).toBe(false);
    }
    const withSessions = readActionJournalEntryRecord(input);
    expect(withSessions.ok).toBe(true);
    if (withSessions.ok) {
      expect(withSessions.record.observedSessionIds).not.toBe(input.observedSessionIds);
      expect(withSessions.record.observedSessionIds).toEqual(input.observedSessionIds);
    }
  });

  it('omits optional action-journal fields when their value is undefined', () => {
    const inputWithUndefined = {
      ...clone(validJournal),
      stopReason: undefined,
      observedSessionIds: undefined,
      authorizedBy: undefined,
    };
    const result = readActionJournalEntryRecord(inputWithUndefined);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(Object.hasOwn(result.record, 'stopReason')).toBe(false);
    expect(Object.hasOwn(result.record, 'observedSessionIds')).toBe(false);
    expect(Object.hasOwn(result.record, 'authorizedBy')).toBe(false);
  });
});

describe('execution-record-readers: hostile input', () => {
  it('returns malformed for non-record inputs and never throws', () => {
    for (const input of [null, [], 'x', 42, new Date()]) {
      for (const [, read] of allReaders) {
        expect(read(input)).toEqual({ ok: false, reason: 'malformed' });
      }
    }
  });

  it('refuses an accessor schemaVersion without running it', () => {
    for (const [, read, fixture] of allReaders) {
      const input = defineGetter(clone(fixture) as Record<string, unknown>, 'schemaVersion');
      expect(read(input)).toEqual({ ok: false, reason: 'malformed' });
    }
  });

  it('refuses a non-enumerable schemaVersion', () => {
    for (const [, read, fixture] of allReaders) {
      const input = clone(fixture) as Record<string, unknown>;
      Object.defineProperty(input, 'schemaVersion', { value: 1, enumerable: false });
      expect(read(input)).toEqual({ ok: false, reason: 'malformed' });
    }
  });

  it('refuses a throwing body-field getter without running it', () => {
    const input = defineGetter(clone(validAttempt) as Record<string, unknown>, 'id');
    expect(readAttemptRecord(input)).toEqual({ ok: false, reason: 'malformed' });
  });

  it('refuses throwing getters on nested seatPlan and seat fields without running them', () => {
    let getterCalls = 0;

    const planGetter = clone(validAttempt);
    Object.defineProperty(planGetter.seatPlan, 'version', {
      get() {
        getterCalls += 1;
        throw new Error('seatPlan getter must never run');
      },
      enumerable: true,
    });
    expect(readAttemptRecord(planGetter)).toEqual({ ok: false, reason: 'malformed' });
    expect(getterCalls).toBe(0);

    const seatGetter = clone(validAttempt);
    Object.defineProperty(seatGetter.seatPlan['first-pass'][0], 'model', {
      get() {
        getterCalls += 1;
        throw new Error('seat getter must never run');
      },
      enumerable: true,
    });
    expect(readAttemptRecord(seatGetter)).toEqual({ ok: false, reason: 'malformed' });
    expect(getterCalls).toBe(0);

    const indexGetter = clone(validAttempt);
    Object.defineProperty(indexGetter.seatPlan['first-pass'], 0, {
      get() {
        getterCalls += 1;
        throw new Error('array-index getter must never run');
      },
      enumerable: true,
    });
    expect(readAttemptRecord(indexGetter)).toEqual({ ok: false, reason: 'malformed' });
    expect(getterCalls).toBe(0);

    const seatProto = {
      get model() {
        getterCalls += 1;
        throw new Error('prototype getter must never run');
      },
    };
    const nonPlainSeat = Object.create(seatProto);
    nonPlainSeat.id = 's1';
    nonPlainSeat.tool = 'opencode';
    const nonPlainAttempt = clone(validAttempt);
    nonPlainAttempt.seatPlan['first-pass'] = [nonPlainSeat];
    expect(readAttemptRecord(nonPlainAttempt)).toEqual({ ok: false, reason: 'malformed' });
    expect(getterCalls).toBe(0);
  });

  it('refuses throwing proxy traps without throwing', () => {
    for (const [, read] of allReaders) {
      expect(read(throwingProxy())).toEqual({ ok: false, reason: 'malformed' });
    }
  });

  it('refuses a runtime-assembled secret-shaped id and never echoes it', () => {
    const secretId = `gh${'p_'}${'A'.repeat(30)}`;
    const readersWithFixtures = [
      [readAttemptRecord, validAttempt],
      [readCapacityReservationRecord, validReservation],
      [readActionJournalEntryRecord, validJournal],
    ] as const;
    for (const [read, fixture] of readersWithFixtures) {
      const result = read({ ...clone(fixture), id: secretId });
      expect(result).toEqual({ ok: false, reason: 'malformed' });
      expect(JSON.stringify(result)).not.toContain(secretId);
    }
  });

  it('refuses an array with an extra getter without running the getter', () => {
    let getterCalls = 0;
    const journal = clone(validJournal);
    Object.defineProperty(journal.observedSessionIds, 'extra', {
      get() {
        getterCalls += 1;
        throw new Error('observedSessionIds extra getter must never run');
      },
      enumerable: true,
    });
    expect(readActionJournalEntryRecord(journal)).toEqual({ ok: false, reason: 'malformed' });
    expect(getterCalls).toBe(0);

    const attempt = clone(validAttempt);
    Object.defineProperty(attempt.artifacts.commitsSinceBase, 'extra', {
      get() {
        getterCalls += 1;
        throw new Error('commitsSinceBase extra getter must never run');
      },
      enumerable: true,
    });
    expect(readAttemptRecord(attempt)).toEqual({ ok: false, reason: 'malformed' });
    expect(getterCalls).toBe(0);

    const attemptDecisions = clone(validAttempt);
    Object.defineProperty(attemptDecisions.ownerDecisionReferences, 'extra', {
      get() {
        getterCalls += 1;
        throw new Error('ownerDecisionReferences extra getter must never run');
      },
      enumerable: true,
    });
    expect(readAttemptRecord(attemptDecisions)).toEqual({ ok: false, reason: 'malformed' });
    expect(getterCalls).toBe(0);

    const attemptPlan = clone(validAttempt);
    Object.defineProperty(attemptPlan.seatPlan['first-pass'], 'extra', {
      get() {
        getterCalls += 1;
        throw new Error('seatPlan extra getter must never run');
      },
      enumerable: true,
    });
    expect(readAttemptRecord(attemptPlan)).toEqual({ ok: false, reason: 'malformed' });
    expect(getterCalls).toBe(0);
  });

  it('refuses an array with a symbol key', () => {
    const journal = clone(validJournal);
    (journal.observedSessionIds as unknown as Record<symbol, unknown>)[Symbol('extra')] = 'ses_extra';
    expect(readActionJournalEntryRecord(journal)).toEqual({ ok: false, reason: 'malformed' });

    const attempt = clone(validAttempt);
    (attempt.artifacts.commitsSinceBase as unknown as Record<symbol, unknown>)[Symbol('extra')] = 'extra_commit';
    expect(readAttemptRecord(attempt)).toEqual({ ok: false, reason: 'malformed' });

    const attemptDecisions = clone(validAttempt);
    (attemptDecisions.ownerDecisionReferences as unknown as Record<symbol, unknown>)[Symbol('extra')] = 'extra_ref';
    expect(readAttemptRecord(attemptDecisions)).toEqual({ ok: false, reason: 'malformed' });

    const attemptPlan = clone(validAttempt);
    (attemptPlan.seatPlan['first-pass'] as unknown as Record<symbol, unknown>)[Symbol('extra')] = { id: 's99' };
    expect(readAttemptRecord(attemptPlan)).toEqual({ ok: false, reason: 'malformed' });
  });

  it('refuses an array with a non-enumerable property', () => {
    const journal = clone(validJournal);
    Object.defineProperty(journal.observedSessionIds, 'extra', {
      value: 'ses_hidden',
      enumerable: false,
    });
    expect(readActionJournalEntryRecord(journal)).toEqual({ ok: false, reason: 'malformed' });

    const journalNonEnumIndex = clone(validJournal);
    Object.defineProperty(journalNonEnumIndex.observedSessionIds, 0, {
      value: 'ses_1',
      enumerable: false,
    });
    expect(readActionJournalEntryRecord(journalNonEnumIndex)).toEqual({ ok: false, reason: 'malformed' });

    const attempt = clone(validAttempt);
    Object.defineProperty(attempt.artifacts.commitsSinceBase, 'extra', {
      value: 'hidden',
      enumerable: false,
    });
    expect(readAttemptRecord(attempt)).toEqual({ ok: false, reason: 'malformed' });

    const attemptNonEnumIndex = clone(validAttempt);
    Object.defineProperty(attemptNonEnumIndex.artifacts.commitsSinceBase, 0, {
      value: 'aaa',
      enumerable: false,
    });
    expect(readAttemptRecord(attemptNonEnumIndex)).toEqual({ ok: false, reason: 'malformed' });

    const attemptPlan = clone(validAttempt);
    Object.defineProperty(attemptPlan.seatPlan['first-pass'], 'extra', {
      value: 'hidden',
      enumerable: false,
    });
    expect(readAttemptRecord(attemptPlan)).toEqual({ ok: false, reason: 'malformed' });
  });

  it('still reads a plain JSON array', () => {
    const jsonJournal = JSON.parse(JSON.stringify(validJournal));
    const journalRead = readActionJournalEntryRecord(jsonJournal);
    expect(journalRead.ok).toBe(true);

    const jsonAttempt = JSON.parse(JSON.stringify(validAttempt));
    const attemptRead = readAttemptRecord(jsonAttempt);
    expect(attemptRead.ok).toBe(true);
  });

  it('reads revision as 0 when absent even if Object.prototype has revision 7', () => {
    let result: ReturnType<typeof readAttemptRecord> | undefined;
    Object.defineProperty(Object.prototype, 'revision', {
      value: 7,
      configurable: true,
      writable: true,
    });
    try {
      result = readAttemptRecord(without(clone(validAttempt), 'revision'));
    } finally {
      delete (Object.prototype as { revision?: unknown }).revision;
    }
    expect(result?.ok).toBe(true);
    if (result?.ok) {
      expect(result.record.revision).toBe(0);
    }
  });

  it('does not treat an inherited negative revision on Object.prototype as malformed', () => {
    let result: ReturnType<typeof readAttemptRecord> | undefined;
    Object.defineProperty(Object.prototype, 'revision', {
      value: -1,
      configurable: true,
      writable: true,
    });
    try {
      result = readAttemptRecord(without(clone(validAttempt), 'revision'));
    } finally {
      delete (Object.prototype as { revision?: unknown }).revision;
    }
    expect(result?.ok).toBe(true);
    if (result?.ok) {
      expect(result.record.revision).toBe(0);
    }
  });

  it('does not allow SeatPlan.create to see inherited id or model from Object.prototype', () => {
    let resultWithoutId: ReturnType<typeof readAttemptRecord> | undefined;
    let resultWithoutModel: ReturnType<typeof readAttemptRecord> | undefined;
    Object.defineProperty(Object.prototype, 'id', {
      value: 'hostile-id',
      configurable: true,
      writable: true,
    });
    Object.defineProperty(Object.prototype, 'model', {
      value: 'hostile-model',
      configurable: true,
      writable: true,
    });
    try {
      const attemptMissingSeatId = clone(validAttempt);
      const seatWithoutId = { ...attemptMissingSeatId.seatPlan['first-pass'][0] } as Record<string, unknown>;
      delete seatWithoutId.id;
      attemptMissingSeatId.seatPlan = {
        ...attemptMissingSeatId.seatPlan,
        'first-pass': [seatWithoutId],
      } as typeof validAttempt.seatPlan;
      resultWithoutId = readAttemptRecord(attemptMissingSeatId);

      const attemptMissingSeatModel = clone(validAttempt);
      const seatWithoutModel = { ...attemptMissingSeatModel.seatPlan['first-pass'][0] } as Record<string, unknown>;
      delete seatWithoutModel.model;
      attemptMissingSeatModel.seatPlan = {
        ...attemptMissingSeatModel.seatPlan,
        'first-pass': [seatWithoutModel],
      } as typeof validAttempt.seatPlan;
      resultWithoutModel = readAttemptRecord(attemptMissingSeatModel);
    } finally {
      delete (Object.prototype as { id?: unknown }).id;
      delete (Object.prototype as { model?: unknown }).model;
    }
    expect(resultWithoutId).toEqual({ ok: false, reason: 'malformed' });
    expect(resultWithoutModel).toEqual({ ok: false, reason: 'malformed' });
  });

  it('does not treat inherited optional fields on Object.prototype as present', () => {
    let result: ReturnType<typeof readAttemptRecord> | undefined;
    Object.defineProperty(Object.prototype, 'seatPlan', {
      value: validAttempt.seatPlan,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(Object.prototype, 'usage', {
      value: validAttempt.usage,
      configurable: true,
      writable: true,
    });
    try {
      const input = without(without(clone(validAttempt), 'seatPlan'), 'usage');
      result = readAttemptRecord(input);
    } finally {
      delete (Object.prototype as { seatPlan?: unknown }).seatPlan;
      delete (Object.prototype as { usage?: unknown }).usage;
    }
    expect(result?.ok).toBe(true);
    if (result?.ok) {
      expect(Object.hasOwn(result.record, 'seatPlan')).toBe(false);
      expect(Object.hasOwn(result.record, 'usage')).toBe(false);
    }
  });
});
