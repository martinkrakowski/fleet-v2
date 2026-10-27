import { describe, expect, it } from 'vitest';

import { LaneRun } from '../entities/LaneRun.js';
import { LANE_RUN_MAX_PARK_ORDINAL } from '../lane-run-keys.js';
import { LANE_RUN_PARK_REASONS } from '../lane-run-records.js';
import {
  LANE_RUN_RESUMABLE_STATES,
  LANE_RUN_STATES,
  LANE_RUN_TERMINAL_STATES,
  LaneRunState,
  laneRunStateLabel,
} from '../value-objects/LaneRunState.vo.js';

const RUN_ID = 'run-01JB0000000000000000000000';
const VALID = {
  version: 1, runId: RUN_ID, workOrderId: 'wo-example-1', tier: 2,
  seatPlanRef: 'a'.repeat(64),
  cursors: { 'first-pass': 0, fix: null, review: null },
  round: 0, attemptIds: ['attempt-example-1'], prNumber: null,
  parked: null, parkCount: 0, lease: null, revision: 1, runPolicyRevision: 'policy-example-1',
};

const VALID_PARKED = {
  reason: 'ambiguous',
  qualifier: 'dispatch',
  parkedFrom: 'running',
  questionId: null,
};

const VALID_LEASE = { holderId: 'lease-example-1', fence: 1, leaseUntilIso: '2026-10-27T10:00:00Z' };

const VALID_WITHOUT_LEASE: Record<string, unknown> = { ...VALID };
delete VALID_WITHOUT_LEASE.lease;

/**
 * Secret-shaped fakes are assembled at runtime from inert pieces so this file
 * never contains a credential-shaped literal.
 */
function fakeSecretShape(): string {
  return `gh${'p_'}${'A'.repeat(30)}`;
}

const PARK_QUALIFIERS: Record<string, string | null> = {
  ambiguous: 'dispatch',
  'step-refused': 'merge',
  'stop-refused': 'runner-refused',
};

describe('LaneRun.create', () => {
  it('accepts VALID and round-trips', () => {
    const result = LaneRun.create(VALID);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.value.toRecord()).toEqual(VALID);

    const jsonRoundTrip = LaneRun.create(JSON.parse(JSON.stringify(result.value.toRecord())));
    expect(jsonRoundTrip.success).toBe(true);
    if (!jsonRoundTrip.success) return;
    expect(jsonRoundTrip.value.toRecord()).toEqual(VALID);
  });

  it('normalises the lease timestamp and isolates toRecord mutations', () => {
    const withLease = LaneRun.create({ ...VALID, lease: VALID_LEASE });
    expect(withLease.success).toBe(true);
    if (!withLease.success) return;
    expect(withLease.value.toRecord().lease).toEqual({
      holderId: 'lease-example-1',
      fence: 1,
      leaseUntilIso: '2026-10-27T10:00:00.000Z',
    });

    const withOffset = LaneRun.create({
      ...VALID,
      lease: { ...VALID_LEASE, leaseUntilIso: '2026-10-27T10:00:00+02:00' },
    });
    expect(withOffset.success).toBe(true);
    if (!withOffset.success) return;
    expect(withOffset.value.toRecord().lease?.leaseUntilIso).toBe('2026-10-27T08:00:00.000Z');

    const first = withLease.value.toRecord();
    const second = withLease.value.toRecord();
    (first.attemptIds as string[]).push('attempt-example-2');
    (first.cursors as Record<string, number | null>)['first-pass'] = 7;
    expect(second.attemptIds).toEqual(['attempt-example-1']);
    expect(second.cursors).toEqual({ 'first-pass': 0, fix: null, review: null });
  });

  it.each([
    [{ ...VALID, parkCount: LANE_RUN_MAX_PARK_ORDINAL }],
    [{ ...VALID, parked: { ...VALID_PARKED, questionId: 'question-example-1' }, parkCount: 1 }],
  ])('accepts valid boundary record %j', (input) => {
    const result = LaneRun.create(input);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.value.toRecord()).toEqual(input);
  });

  it.each([
    [null, 'LaneRun requires a record'],
    [[], 'LaneRun requires a record'],
    [{ ...VALID, state: 'ready' }, 'LaneRun has an unknown key'],
    [VALID_WITHOUT_LEASE, 'LaneRun has an unknown key'],
    [{ ...VALID, version: 2 }, 'LaneRun version must be 1'],
    [{ ...VALID, runId: 'run-1' }, 'LaneRun runId must be run- followed by a ULID'],
    [{ ...VALID, runId: RUN_ID + '/x' }, 'LaneRun runId must be run- followed by a ULID'],
    [{ ...VALID, workOrderId: '' }, 'LaneRun workOrderId must be a non-empty id of at most 256 bytes'],
    [{ ...VALID, workOrderId: 'é'.repeat(129) }, 'LaneRun workOrderId must be a non-empty id of at most 256 bytes'],
    [{ ...VALID, tier: 0 }, 'LaneRun tier must be 1 or 2'],
    [{ ...VALID, tier: 3 }, 'LaneRun tier must be 1 or 2'],
    [{ ...VALID, seatPlanRef: 'A'.repeat(64) }, 'LaneRun seatPlanRef must be a sha256 hex digest'],
    [
      { ...VALID, cursors: { 'first-pass': 0, fix: null } },
      'LaneRun cursors must be { first-pass, fix, review }, each null or a seat index',
    ],
    [
      { ...VALID, cursors: { 'first-pass': 0, fix: null, review: null, extra: 0 } },
      'LaneRun cursors must be { first-pass, fix, review }, each null or a seat index',
    ],
    [
      { ...VALID, cursors: { 'first-pass': -1, fix: null, review: null } },
      'LaneRun cursors must be { first-pass, fix, review }, each null or a seat index',
    ],
    [
      { ...VALID, cursors: { 'first-pass': 1000, fix: null, review: null } },
      'LaneRun cursors must be { first-pass, fix, review }, each null or a seat index',
    ],
    [{ ...VALID, round: 3 }, 'LaneRun round must be 0, 1 or 2'],
    [
      { ...VALID, attemptIds: Array.from({ length: 33 }, (_, i) => 'attempt-' + String(i)) },
      'LaneRun attemptIds must be at most 32 distinct ids',
    ],
    [{ ...VALID, attemptIds: ['attempt-a', 'attempt-a'] }, 'LaneRun attemptIds must be at most 32 distinct ids'],
    [{ ...VALID, round: 2, attemptIds: ['attempt-1', 'attempt-2'] }, 'LaneRun round exceeds its attempts'],
    [{ ...VALID, prNumber: 0 }, 'LaneRun prNumber must be null or a positive integer'],
    [{ ...VALID, parkCount: -1 }, 'LaneRun parkCount must be a non-negative integer'],
    [{ ...VALID, parkCount: LANE_RUN_MAX_PARK_ORDINAL + 1 }, 'LaneRun parkCount must be a non-negative integer'],
    [
      { ...VALID, parked: { ...VALID_PARKED, extra: true }, parkCount: 1 },
      'LaneRun parked must be null or { reason, qualifier, parkedFrom, questionId }',
    ],
    [
      { ...VALID, parked: { ...VALID_PARKED, reason: 'tired' }, parkCount: 1 },
      'LaneRun parked reason is not a known park reason',
    ],
    [
      { ...VALID, parked: { ...VALID_PARKED, parkedFrom: 'parked' }, parkCount: 1 },
      'LaneRun parked parkedFrom must be a non-terminal state other than parked',
    ],
    [
      { ...VALID, parked: { ...VALID_PARKED, parkedFrom: 'merged' }, parkCount: 1 },
      'LaneRun parked parkedFrom must be a non-terminal state other than parked',
    ],
    [
      { ...VALID, parked: { ...VALID_PARKED, qualifier: null }, parkCount: 1 },
      'LaneRun parked qualifier does not match its reason',
    ],
    [
      { ...VALID, parked: { reason: 'halted', qualifier: 'gate', parkedFrom: 'running', questionId: null }, parkCount: 1 },
      'LaneRun parked qualifier does not match its reason',
    ],
    [
      { ...VALID, parked: { reason: 'stop-refused', qualifier: 'gate', parkedFrom: 'running', questionId: null }, parkCount: 1 },
      'LaneRun parked qualifier does not match its reason',
    ],
    [
      { ...VALID, parked: { reason: 'step-refused', qualifier: 'fix', parkedFrom: 'running', questionId: null }, parkCount: 1 },
      'LaneRun parked qualifier does not match its reason',
    ],
    [{ ...VALID, parked: VALID_PARKED, parkCount: 0 }, 'LaneRun parkCount must count the current park'],
    [
      { ...VALID, lease: { holderId: 'lease-example-1', fence: 0, leaseUntilIso: '2026-10-27T10:00:00Z' } },
      'LaneRun lease must be null or { holderId, fence, leaseUntilIso }',
    ],
    [
      { ...VALID, lease: { holderId: 'lease-example-1', fence: 1, leaseUntilIso: '2026-10-27T10:00:00' } },
      'LaneRun lease must be null or { holderId, fence, leaseUntilIso }',
    ],
    [{ ...VALID, revision: 0 }, 'LaneRun revision must be a positive integer'],
    [{ ...VALID, runPolicyRevision: '  ' }, 'LaneRun runPolicyRevision must be a non-empty id of at most 256 bytes'],
  ])('refuses with the fixed message %j', (input, message) => {
    const result = LaneRun.create(input);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.message).toBe(message);
    expect(result.code).toBe('invalid');
  });

  it.each(LANE_RUN_PARK_REASONS)('accepts park reason %s', (reason) => {
    const qualifier = PARK_QUALIFIERS[reason] ?? null;
    const result = LaneRun.create({
      ...VALID,
      parked: { reason, qualifier, parkedFrom: 'running', questionId: null },
      parkCount: 1,
    });
    expect(result.success).toBe(true);
  });

  it.each([
    [{ ...VALID, runId: 'run-XYZZY' }],
    [{ ...VALID, 'XYZZY-key': true }],
    [{ ...VALID, parked: { reason: 'XYZZY', qualifier: null, parkedFrom: 'running', questionId: null }, parkCount: 1 }],
    [{ ...VALID, workOrderId: 'X'.repeat(300) }],
    [{ ...VALID, tier: 'XYZZY' }],
  ])('never echoes hostile input %j', (input) => {
    const result = LaneRun.create(input);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.message).not.toContain('XYZZY');
  });

  it.each([
    [{ ...VALID, workOrderId: fakeSecretShape() }, 'LaneRun workOrderId contains a secret-shaped value and was refused'],
    [{ ...VALID, attemptIds: [fakeSecretShape()] }, 'LaneRun attemptIds contains a secret-shaped value and was refused'],
    [
      { ...VALID, parked: { reason: 'halted', qualifier: null, parkedFrom: 'running', questionId: fakeSecretShape() }, parkCount: 1 },
      'LaneRun parked questionId contains a secret-shaped value and was refused',
    ],
    [
      { ...VALID, lease: { holderId: fakeSecretShape(), fence: 1, leaseUntilIso: '2026-10-27T10:00:00Z' } },
      'LaneRun lease holderId contains a secret-shaped value and was refused',
    ],
    [{ ...VALID, runPolicyRevision: fakeSecretShape() }, 'LaneRun runPolicyRevision contains a secret-shaped value and was refused'],
  ])('refuses secret-shaped values %j', (input, message) => {
    const result = LaneRun.create(input);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.message).toBe(message);
    expect(result.error.message).not.toContain(fakeSecretShape());
  });

  it('never throws on hostile input', () => {
    const getterRecord: Record<string, unknown> = { ...VALID };
    Object.defineProperty(getterRecord, 'workOrderId', {
      get() {
        throw new Error('boom');
      },
      enumerable: true,
    });
    const throwingProxy = new Proxy({ ...VALID }, {
      ownKeys() {
        throw new Error('boom');
      },
    });
    const inputs: unknown[] = [
      undefined,
      42,
      'string',
      Object.create(null),
      { ...VALID, attemptIds: { not: 'an array' } },
      getterRecord,
      throwingProxy,
    ];
    for (const input of inputs) {
      const result = LaneRun.create(input);
      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error.message).not.toContain('boom');
    }
  });
});

describe('LaneRunState', () => {
  it('lists 18 distinct states in order', () => {
    expect(LANE_RUN_STATES).toEqual([
      'ready', 'dispatching', 'running', 'seat-failed', 'collecting', 'gating', 'brief-check',
      'code-review', 'fixing', 'accepting', 'awaiting-premerge', 'opening-pr', 'pushing',
      'watching-ci', 'merging', 'merged', 'stopped', 'parked',
    ]);
    expect(new Set(LANE_RUN_STATES).size).toBe(18);
  });

  it('declares the terminal pair', () => {
    expect(LANE_RUN_TERMINAL_STATES).toEqual(['merged', 'stopped']);
  });

  it('declares 15 resumable states excluding parked, merged and stopped', () => {
    expect(LANE_RUN_RESUMABLE_STATES).toHaveLength(15);
    expect(LANE_RUN_RESUMABLE_STATES).not.toContain('parked');
    expect(LANE_RUN_RESUMABLE_STATES).not.toContain('merged');
    expect(LANE_RUN_RESUMABLE_STATES).not.toContain('stopped');
  });

  it('refuses an undeclared state with the fixed message', () => {
    const result = LaneRunState.create('XYZZY');
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.message).toBe('Invalid lane run state');
  });

  it('labels unknown input as unknown', () => {
    expect(laneRunStateLabel(42)).toBe('unknown');
  });

  it('reads declared states, terminality and equality', () => {
    const stopped = LaneRunState.create('stopped');
    expect(stopped.success).toBe(true);
    if (!stopped.success) return;
    expect(stopped.value.getValue()).toBe('stopped');
    expect(stopped.value.isTerminal()).toBe(true);

    const running = LaneRunState.create('running');
    expect(running.success).toBe(true);
    if (!running.success) return;
    expect(running.value.isTerminal()).toBe(false);
    expect(running.value.equals(stopped.value)).toBe(false);
    expect(running.value.equals(running.value)).toBe(true);
  });
});
