import { describe, expect, it } from 'vitest';

import { LaneRun } from '../entities/LaneRun.js';
import type { LaneRunRecord } from '../lane-run-records.js';
import { canEnterLaneRunState } from '../lane-run-transitions.js';
import {
  laneRunAttemptPhaseOf,
  nextLaneRunAction,
} from '../lane-run-decider.js';
import type {
  LaneRunAttemptFact,
  LaneRunDecision,
  LaneRunFacts,
  LaneRunReviewFact,
} from '../lane-run-decider.js';
import { ATTEMPT_STATES } from '../value-objects/AttemptState.vo.js';
import type { LaneRunStateValue } from '../value-objects/LaneRunState.vo.js';

const RUN_ID = 'run-01JB0000000000000000000000';
const NOW = '2026-10-27T10:00:00.000Z';
const HEAD = '0123456789ab';

const BASE_RECORD = {
  version: 1,
  runId: RUN_ID,
  workOrderId: 'wo-example-1',
  tier: 2,
  seatPlanRef: 'a'.repeat(64),
  cursors: { 'first-pass': 0, fix: null, review: null },
  round: 0,
  attemptIds: ['attempt-example-1'],
  prNumber: null,
  parked: null,
  parkCount: 0,
  lease: null,
  revision: 1,
  runPolicyRevision: 'policy-example-1',
};

const PARKED_BLOCKER = { reason: 'blocker-after-round-2', qualifier: null, parkedFrom: 'gating', questionId: null };
const PARKED_HALTED = { reason: 'halted', qualifier: null, parkedFrom: 'running', questionId: null };
const PARKED_UNCONFIRMED = { reason: 'stop-unconfirmed', qualifier: null, parkedFrom: 'running', questionId: null };

function record(overrides: Record<string, unknown>): LaneRunRecord {
  const result = LaneRun.create({ ...BASE_RECORD, ...overrides });
  expect(result.success).toBe(true);
  if (!result.success) {
    throw new Error('fixture must be a valid LaneRun record');
  }
  return result.value.toRecord();
}

function attemptFact(overrides: Partial<LaneRunAttemptFact> = {}): LaneRunAttemptFact {
  return {
    attemptId: 'attempt-example-1',
    round: 0,
    seatIndex: 0,
    phase: 'running',
    stopReason: 'none',
    deadlineIso: null,
    stopsIssued: 0,
    dispatchResult: 'started',
    collection: null,
    ...overrides,
  };
}

function baseFacts(overrides: Partial<LaneRunFacts> = {}): LaneRunFacts {
  return {
    state: 'ready',
    halted: false,
    stopMode: null,
    stopRequestedAtIso: null,
    stopGraceMinutes: 45,
    pendingIntent: null,
    admission: 'admitted',
    costCeilingReached: false,
    implementerSeat: { ok: true, seatIndex: 0 },
    reviewSeat: { ok: true, seatIndex: 0 },
    roundSeatIndexes: [],
    attempt: null,
    head12: null,
    acceptedHead12: null,
    gate: 'none',
    briefCheck: { verdict: 'none', seatIndex: null, retries: 0 },
    codeReview: { verdict: 'none', seatIndex: null, retries: 0 },
    preMerge: 'none',
    acceptance: 'none',
    ci: 'pending',
    pr: null,
    refusedStep: null,
    merge: { oneWayDoor: false, branchBehind: false, trainFree: true, policyGrant: true },
    ...overrides,
  };
}

function decide(rec: LaneRunRecord, facts: LaneRunFacts, nowIso: string = NOW): LaneRunDecision {
  return nextLaneRunAction(rec, facts, nowIso);
}

function reviewFacts(
  kind: 'brief-check' | 'code-review',
  review: Partial<LaneRunReviewFact>,
  extra: Partial<LaneRunFacts> = {},
): LaneRunFacts {
  const value: LaneRunReviewFact = { verdict: 'none', seatIndex: null, retries: 0, ...review };
  return baseFacts({
    state: kind,
    head12: HEAD,
    ...(kind === 'brief-check' ? { briefCheck: value } : { codeReview: value }),
    ...extra,
  });
}

/** Every `enter` decision produced by the rule tests must be a legal transition (§3.2). */
const enterDecisions: Array<{ from: LaneRunStateValue; to: LaneRunStateValue; parkedFrom: string | null }> = [];

function assertDecision(facts: LaneRunFacts, rec: LaneRunRecord, decision: LaneRunDecision, expected: LaneRunDecision): void {
  expect(decision).toEqual(expected);
  if (expected.kind === 'enter') {
    enterDecisions.push({
      from: facts.state,
      to: expected.to,
      parkedFrom: rec.parked === null ? null : rec.parked.parkedFrom,
    });
  }
}

describe('global rules', () => {
  it('G1: merged ends done', () => {
    expect(decide(record({}), baseFacts({ state: 'merged' }))).toEqual({ kind: 'done' });
    expect(decide(record({}), baseFacts({ state: 'stopped' }))).toEqual({ kind: 'done' });
  });

  it('G2: a parked-state mismatch is inconsistent', () => {
    expect(decide(record({}), baseFacts({ state: 'parked' }))).toEqual({ kind: 'wait', reason: 'facts-inconsistent' });
    expect(decide(record({ parked: PARKED_BLOCKER, parkCount: 1 }), baseFacts({ state: 'ready' }))).toEqual({
      kind: 'wait', reason: 'facts-inconsistent',
    });
  });

  it('G3a: an unread intent reconciles first, in any state', () => {
    const facts = baseFacts({
      state: 'running',
      attempt: attemptFact(),
      pendingIntent: { key: `${RUN_ID}/r0/gate/0@${HEAD}`, step: 'gate', reconciliation: 'unread' },
    });
    assertDecision(facts, record({}), decide(record({}), facts), {
      kind: 'reconcile', step: 'gate', key: `${RUN_ID}/r0/gate/0@${HEAD}`,
    });
  });

  it('G3b: an ambiguous intent waits while parked', () => {
    const rec = record({ parked: PARKED_BLOCKER, parkCount: 1 });
    const facts = baseFacts({
      state: 'parked',
      pendingIntent: { key: `${RUN_ID}/r0/gate/0@${HEAD}`, step: 'gate', reconciliation: 'ambiguous' },
    });
    expect(decide(rec, facts)).toEqual({ kind: 'wait', reason: 'parked' });
  });

  it('G3c: an ambiguous intent parks with its step as qualifier', () => {
    const facts = baseFacts({
      state: 'running',
      attempt: attemptFact(),
      pendingIntent: { key: `${RUN_ID}/r0/gate/0@${HEAD}`, step: 'gate', reconciliation: 'ambiguous' },
    });
    assertDecision(facts, record({}), decide(record({}), facts), {
      kind: 'park', reason: 'ambiguous', qualifier: 'gate', parkedFrom: 'running',
    });
  });

  it('G3d: a landed merge ends merged, never stopped', () => {
    const rec = record({});
    const facts = baseFacts({
      state: 'merging',
      stopMode: 'graceful',
      head12: HEAD,
      acceptedHead12: HEAD,
      pr: { state: 'merged', head12: HEAD },
      attempt: attemptFact(),
    });
    assertDecision(facts, rec, decide(rec, facts), { kind: 'enter', to: 'merged' });

    const otherHead = baseFacts({
      state: 'merging',
      stopMode: 'graceful',
      head12: HEAD,
      acceptedHead12: HEAD,
      pr: { state: 'merged', head12: 'ffffffffffff' },
      attempt: attemptFact(),
    });
    assertDecision(otherHead, rec, decide(rec, otherHead), {
      kind: 'park', reason: 'ambiguous', qualifier: 'merge', parkedFrom: 'merging',
    });
  });

  it('G4a: a force stop with nothing running enters stopped', () => {
    const rec = record({});
    const none = baseFacts({ state: 'running', stopMode: 'force', attempt: null });
    assertDecision(none, rec, decide(rec, none), { kind: 'enter', to: 'stopped' });
    const ended = baseFacts({ state: 'running', stopMode: 'force', attempt: attemptFact({ phase: 'ended' }) });
    assertDecision(ended, rec, decide(rec, ended), { kind: 'enter', to: 'stopped' });
  });

  it('G4h: a halted park with a stop pending lifts by itself', () => {
    const rec = record({ parked: PARKED_HALTED, parkCount: 1 });
    const facts = baseFacts({
      state: 'parked',
      halted: false,
      stopMode: 'force',
      attempt: attemptFact(),
    });
    assertDecision(facts, rec, decide(rec, facts), { kind: 'enter', to: 'running' });
  });

  it('G4e: a never-dispatched prepared attempt is cancelled under its stop key', () => {
    const rec = record({});
    const facts = baseFacts({
      state: 'running',
      stopMode: 'force',
      attempt: attemptFact({ phase: 'prepared', dispatchResult: 'none' }),
    });
    expect(decide(rec, facts)).toEqual({
      kind: 'cancel',
      key: `${RUN_ID}/r0/stop/0`,
      attemptId: 'attempt-example-1',
      round: 0,
      seatIndex: 0,
      retry: null,
    });
  });

  it('G4f: a graceful stop waits a parked started prepared attempt', () => {
    const rec = record({ parked: PARKED_UNCONFIRMED, parkCount: 1 });
    const facts = baseFacts({
      state: 'parked',
      stopMode: 'graceful',
      attempt: attemptFact({ phase: 'prepared' }),
    });
    expect(decide(rec, facts)).toEqual({ kind: 'wait', reason: 'parked' });
  });

  it('G4g: a graceful stop parks a started prepared attempt as ambiguous dispatch', () => {
    const facts = baseFacts({
      state: 'running',
      stopMode: 'graceful',
      attempt: attemptFact({ phase: 'prepared' }),
    });
    assertDecision(facts, record({}), decide(record({}), facts), {
      kind: 'park', reason: 'ambiguous', qualifier: 'dispatch', parkedFrom: 'running',
    });
  });

  it('G4b: a halted parked run with a stop waits', () => {
    const rec = record({ parked: PARKED_HALTED, parkCount: 1 });
    const facts = baseFacts({
      state: 'parked',
      halted: true,
      stopMode: 'force',
      attempt: attemptFact(),
    });
    expect(decide(rec, facts)).toEqual({ kind: 'wait', reason: 'parked' });
  });

  it('G4c: a halted run with a stop parks halted', () => {
    const facts = baseFacts({
      state: 'running',
      halted: true,
      stopMode: 'graceful',
      attempt: attemptFact(),
    });
    assertDecision(facts, record({}), decide(record({}), facts), {
      kind: 'park', reason: 'halted', qualifier: null, parkedFrom: 'running',
    });
  });

  it('G4j: a force stop reconciles a started prepared attempt first', () => {
    const facts = baseFacts({
      state: 'running',
      stopMode: 'force',
      attempt: attemptFact({ phase: 'prepared' }),
    });
    expect(decide(record({}), facts)).toEqual({
      kind: 'reconcile', step: 'dispatch', key: `${RUN_ID}/r0/reconcile/0`,
    });

    const parkedRec = record({ parked: PARKED_BLOCKER, parkCount: 1 });
    const parked = baseFacts({
      state: 'parked',
      stopMode: 'force',
      attempt: attemptFact({ phase: 'prepared' }),
    });
    expect(decide(parkedRec, parked)).toEqual({
      kind: 'reconcile', step: 'dispatch', key: `${RUN_ID}/r0/reconcile/0`,
    });
  });

  it('G4d: a force stop stops a dispatching, running or blocked attempt', () => {
    const rec = record({});
    const running = baseFacts({ state: 'running', stopMode: 'force', attempt: attemptFact() });
    expect(decide(rec, running)).toEqual({
      kind: 'act', step: 'stop', key: `${RUN_ID}/r0/stop/0`, round: 0, seatIndex: 0, head12: null, retry: null,
    });
    const dispatching = baseFacts({
      state: 'running', stopMode: 'force', attempt: attemptFact({ phase: 'dispatching' }),
    });
    expect(decide(rec, dispatching)).toEqual({
      kind: 'act', step: 'stop', key: `${RUN_ID}/r0/stop/0`, round: 0, seatIndex: 0, head12: null, retry: null,
    });
    const blocked = baseFacts({
      state: 'parked', stopMode: 'force', attempt: attemptFact({ phase: 'blocked' }),
    });
    const parkedRec = record({ parked: PARKED_UNCONFIRMED, parkCount: 1 });
    expect(decide(parkedRec, blocked)).toEqual({
      kind: 'act', step: 'stop', key: `${RUN_ID}/r0/stop/0`, round: 0, seatIndex: 0, head12: null, retry: null,
    });
  });

  it('GD1: a graceful stop with no live attempt and no drain left enters stopped', () => {
    const rec = record({});
    const none = baseFacts({ state: 'brief-check', stopMode: 'graceful', attempt: null, head12: HEAD });
    assertDecision(none, rec, decide(rec, none), { kind: 'enter', to: 'stopped' });
    const ended = baseFacts({ state: 'code-review', stopMode: 'graceful', attempt: attemptFact({ phase: 'ended' }), head12: HEAD });
    assertDecision(ended, rec, decide(rec, ended), { kind: 'enter', to: 'stopped' });
  });

  it('GD2: a parked graceful-stop run whose attempt may still run stands', () => {
    const rec = record({ parked: PARKED_BLOCKER, parkCount: 1 });
    const running = baseFacts({ state: 'parked', stopMode: 'graceful', attempt: attemptFact() });
    expect(decide(rec, running)).toEqual({ kind: 'wait', reason: 'parked' });
    const blocked = baseFacts({ state: 'parked', stopMode: 'graceful', attempt: attemptFact({ phase: 'blocked' }) });
    expect(decide(rec, blocked)).toEqual({ kind: 'wait', reason: 'parked' });
  });

  it('GD3: a live graceful-stop attempt outside the drain waits on the drain', () => {
    const rec = record({});
    const facts = baseFacts({
      state: 'fixing',
      stopMode: 'graceful',
      attempt: attemptFact(),
      stopRequestedAtIso: '2026-10-27T09:16:00.000Z',
    });
    expect(decide(rec, facts)).toEqual({ kind: 'wait', reason: 'stop-draining' });
  });

  it('GD4: inside the drain states the state rules still apply', () => {
    const rec = record({});
    const facts = baseFacts({
      state: 'collecting',
      stopMode: 'graceful',
      attempt: attemptFact({ phase: 'collected', collection: null }),
    });
    expect(decide(rec, facts)).toEqual({
      kind: 'act', step: 'collect', key: `${RUN_ID}/r0/collect/0`, round: 0, seatIndex: 0, head12: null, retry: null,
    });
  });

  it('GD5: the drain substitutes for dispatch-pending and lane-running waits', () => {
    const rec = record({});
    const grace = { stopRequestedAtIso: '2026-10-27T09:16:00.000Z' };
    const running = baseFacts({ state: 'running', stopMode: 'graceful', attempt: attemptFact(), ...grace });
    expect(decide(rec, running)).toEqual({ kind: 'wait', reason: 'stop-draining' });
    const dispatching = baseFacts({ state: 'dispatching', stopMode: 'graceful', attempt: attemptFact({ phase: 'dispatching' }), ...grace });
    expect(decide(rec, dispatching)).toEqual({ kind: 'wait', reason: 'stop-draining' });
  });

  it('G5: parked waits', () => {
    const rec = record({ parked: PARKED_BLOCKER, parkCount: 1 });
    expect(decide(rec, baseFacts({ state: 'parked' }))).toEqual({ kind: 'wait', reason: 'parked' });
  });

  it('G6: halted parks halted', () => {
    const facts = baseFacts({ state: 'running', halted: true, attempt: attemptFact() });
    assertDecision(facts, record({}), decide(record({}), facts), {
      kind: 'park', reason: 'halted', qualifier: null, parkedFrom: 'running',
    });
  });

  it('G7: a head change re-enters gating', () => {
    const rec = record({});
    const facts = baseFacts({
      state: 'merging',
      head12: HEAD,
      acceptedHead12: 'aaaaaaaaaaaa',
      pr: { state: 'open', head12: HEAD },
      attempt: attemptFact(),
    });
    assertDecision(facts, rec, decide(rec, facts), { kind: 'enter', to: 'gating' });
  });

  it('G7b: a head-change state with a missing head is inconsistent', () => {
    const merging = baseFacts({ state: 'merging', head12: null, acceptedHead12: HEAD, pr: { state: 'open', head12: HEAD } });
    expect(decide(record({}), merging)).toEqual({ kind: 'wait', reason: 'facts-inconsistent' });
    const pushing = baseFacts({ state: 'pushing', head12: HEAD, acceptedHead12: null, pr: { state: 'open', head12: HEAD } });
    expect(decide(record({}), pushing)).toEqual({ kind: 'wait', reason: 'facts-inconsistent' });
  });

  it('G8: a refused state step parks step-refused', () => {
    const rec = record({});
    const facts = baseFacts({ state: 'gating', gate: 'none', head12: HEAD, attempt: attemptFact(), refusedStep: 'gate' });
    assertDecision(facts, rec, decide(rec, facts), {
      kind: 'park', reason: 'step-refused', qualifier: 'gate', parkedFrom: 'gating',
    });
  });

  it('G8b: a refused prepare parks step-refused in ready, seat-failed and fixing', () => {
    for (const state of ['ready', 'seat-failed', 'fixing'] as const) {
      const rec = record({});
      const facts = baseFacts({ state, attempt: attemptFact(), refusedStep: 'prepare' });
      assertDecision(facts, rec, decide(rec, facts), {
        kind: 'park', reason: 'step-refused', qualifier: 'prepare', parkedFrom: state,
      });
    }
  });

  it('a pending unread intent wins over a stop request in either mode', () => {
    const intent = { key: `${RUN_ID}/r0/gate/0@${HEAD}`, step: 'gate' as const, reconciliation: 'unread' as const };
    for (const stopMode of ['force', 'graceful'] as const) {
      const facts = baseFacts({ state: 'running', stopMode, attempt: attemptFact(), pendingIntent: intent });
      expect(decide(record({}), facts)).toEqual({ kind: 'reconcile', step: 'gate', key: intent.key });
    }
  });

  it('a forced stop with nothing running wins over the halt', () => {
    const facts = baseFacts({ state: 'running', halted: true, stopMode: 'force', attempt: null });
    assertDecision(facts, record({}), decide(record({}), facts), { kind: 'enter', to: 'stopped' });
  });

  it('a cancel wins over the halt', () => {
    const facts = baseFacts({
      state: 'running', halted: true, stopMode: 'force', attempt: attemptFact({ phase: 'prepared', dispatchResult: 'none' }),
    });
    expect(decide(record({}), facts)).toEqual({
      kind: 'cancel',
      key: `${RUN_ID}/r0/stop/0`,
      attemptId: 'attempt-example-1',
      round: 0,
      seatIndex: 0,
      retry: null,
    });
  });

  it('halted wins over every state rule', () => {
    const facts = baseFacts({ state: 'gating', halted: true, gate: 'none', head12: HEAD, attempt: attemptFact() });
    assertDecision(facts, record({}), decide(record({}), facts), {
      kind: 'park', reason: 'halted', qualifier: null, parkedFrom: 'gating',
    });
  });
});

describe('ready state', () => {
  it('R1: cost ceiling parks', () => {
    const facts = baseFacts({ state: 'ready', costCeilingReached: true });
    assertDecision(facts, record({}), decide(record({}), facts), {
      kind: 'park', reason: 'cost-ceiling', qualifier: null, parkedFrom: 'ready',
    });
  });

  it('R2: prepares the first attempt', () => {
    const rec = record({ attemptIds: [] });
    const facts = baseFacts({ state: 'ready' });
    expect(decide(rec, facts)).toEqual({
      kind: 'act', step: 'prepare', key: `${RUN_ID}/r0/prepare/0/a1`, round: 0, seatIndex: 0, head12: null, retry: null,
    });
  });

  it('R2: dispatches a prepared round-0 attempt on its seat', () => {
    const rec = record({});
    const facts = baseFacts({
      state: 'ready',
      attempt: attemptFact({ seatIndex: 1, phase: 'prepared' }),
    });
    expect(decide(rec, facts)).toEqual({
      kind: 'act', step: 'dispatch', key: `${RUN_ID}/r0/dispatch/1/a1`, round: 0, seatIndex: 1, head12: null, retry: null,
    });
  });

  it('R2: parks when no seat is eligible', () => {
    const facts = baseFacts({ state: 'ready', implementerSeat: { ok: false } });
    assertDecision(facts, record({}), decide(record({}), facts), {
      kind: 'park', reason: 'seat-plan-exhausted', qualifier: null, parkedFrom: 'ready',
    });
  });

  it('R2: a dispatch needs admission', () => {
    const facts = baseFacts({
      state: 'ready',
      admission: 'no-capacity',
      attempt: attemptFact({ phase: 'prepared' }),
    });
    expect(decide(record({}), facts)).toEqual({ kind: 'wait', reason: 'admission' });
  });
});

describe('dispatching state', () => {
  it('D1: running enters running', () => {
    const facts = baseFacts({ state: 'dispatching', attempt: attemptFact() });
    assertDecision(facts, record({}), decide(record({}), facts), { kind: 'enter', to: 'running' });
  });

  it('D2: cancelled or a trigger stop enters seat-failed', () => {
    const cancelled = baseFacts({ state: 'dispatching', attempt: attemptFact({ phase: 'cancelled' }) });
    assertDecision(cancelled, record({}), decide(record({}), cancelled), { kind: 'enter', to: 'seat-failed' });
    const trigger = baseFacts({
      state: 'dispatching', attempt: attemptFact({ phase: 'ended', stopReason: 'rate-limited' }),
    });
    assertDecision(trigger, record({}), decide(record({}), trigger), { kind: 'enter', to: 'seat-failed' });
  });

  it('D3: ended or collected otherwise enters running', () => {
    const ended = baseFacts({ state: 'dispatching', attempt: attemptFact({ phase: 'ended' }) });
    assertDecision(ended, record({}), decide(record({}), ended), { kind: 'enter', to: 'running' });
    const collected = baseFacts({ state: 'dispatching', attempt: attemptFact({ phase: 'collected' }) });
    assertDecision(collected, record({}), decide(record({}), collected), { kind: 'enter', to: 'running' });
  });

  it('D4: blocked parks ambiguous dispatch', () => {
    const facts = baseFacts({ state: 'dispatching', attempt: attemptFact({ phase: 'blocked' }) });
    assertDecision(facts, record({}), decide(record({}), facts), {
      kind: 'park', reason: 'ambiguous', qualifier: 'dispatch', parkedFrom: 'dispatching',
    });
  });

  it('D5: prepared or dispatching waits dispatch-pending', () => {
    const prepared = baseFacts({ state: 'dispatching', attempt: attemptFact({ phase: 'prepared' }) });
    expect(decide(record({}), prepared)).toEqual({ kind: 'wait', reason: 'dispatch-pending' });
    const dispatching = baseFacts({ state: 'dispatching', attempt: attemptFact({ phase: 'dispatching' }) });
    expect(decide(record({}), dispatching)).toEqual({ kind: 'wait', reason: 'dispatch-pending' });
  });
});

describe('running state', () => {
  it('U1: a trigger stop enters seat-failed', () => {
    const facts = baseFacts({ state: 'running', attempt: attemptFact({ phase: 'ended', stopReason: 'payment' }) });
    assertDecision(facts, record({}), decide(record({}), facts), { kind: 'enter', to: 'seat-failed' });
  });

  it('U2: ended or collected otherwise enters collecting', () => {
    const ended = baseFacts({ state: 'running', attempt: attemptFact({ phase: 'ended' }) });
    assertDecision(ended, record({}), decide(record({}), ended), { kind: 'enter', to: 'collecting' });
    const collected = baseFacts({ state: 'running', attempt: attemptFact({ phase: 'collected' }) });
    assertDecision(collected, record({}), decide(record({}), collected), { kind: 'enter', to: 'collecting' });
  });

  it('U3: cancelled enters seat-failed', () => {
    const facts = baseFacts({ state: 'running', attempt: attemptFact({ phase: 'cancelled' }) });
    assertDecision(facts, record({}), decide(record({}), facts), { kind: 'enter', to: 'seat-failed' });
  });

  it('U4: blocked parks ambiguous dispatch', () => {
    const facts = baseFacts({ state: 'running', attempt: attemptFact({ phase: 'blocked' }) });
    assertDecision(facts, record({}), decide(record({}), facts), {
      kind: 'park', reason: 'ambiguous', qualifier: 'dispatch', parkedFrom: 'running',
    });
  });

  it('U5: past the deadline stops, exhausted parks ambiguous stop', () => {
    const past = baseFacts({
      state: 'running',
      attempt: attemptFact({ deadlineIso: '2026-10-27T09:00:00.000Z' }),
    });
    expect(decide(record({}), past)).toEqual({
      kind: 'act', step: 'stop', key: `${RUN_ID}/r0/stop/0`, round: 0, seatIndex: 0, head12: null, retry: null,
    });
    const exhausted = baseFacts({
      state: 'running',
      attempt: attemptFact({ deadlineIso: '2026-10-27T09:00:00.000Z', stopsIssued: 10 }),
    });
    assertDecision(exhausted, record({}), decide(record({}), exhausted), {
      kind: 'park', reason: 'ambiguous', qualifier: 'stop', parkedFrom: 'running',
    });
  });

  it('U6: otherwise waits lane-running', () => {
    const noDeadline = baseFacts({ state: 'running', attempt: attemptFact() });
    expect(decide(record({}), noDeadline)).toEqual({ kind: 'wait', reason: 'lane-running' });
    const future = baseFacts({
      state: 'running',
      attempt: attemptFact({ deadlineIso: '2026-10-27T11:00:00.000Z' }),
    });
    expect(decide(record({}), future)).toEqual({ kind: 'wait', reason: 'lane-running' });
  });
});

describe('seat-failed state', () => {
  it('F1: cost ceiling parks', () => {
    const facts = baseFacts({ state: 'seat-failed', costCeilingReached: true });
    assertDecision(facts, record({}), decide(record({}), facts), {
      kind: 'park', reason: 'cost-ceiling', qualifier: null, parkedFrom: 'seat-failed',
    });
  });

  it('F2: a prepared attempt for the record round dispatches', () => {
    const rec = record({});
    const facts = baseFacts({ state: 'seat-failed', attempt: attemptFact({ phase: 'prepared' }) });
    expect(decide(rec, facts)).toEqual({
      kind: 'act', step: 'dispatch', key: `${RUN_ID}/r0/dispatch/0/a1`, round: 0, seatIndex: 0, head12: null, retry: null,
    });
  });

  it('F3: an unavailable or already-dispatched seat parks', () => {
    const unavailable = baseFacts({ state: 'seat-failed', implementerSeat: { ok: false } });
    assertDecision(unavailable, record({}), decide(record({}), unavailable), {
      kind: 'park', reason: 'seat-plan-exhausted', qualifier: null, parkedFrom: 'seat-failed',
    });
    const used = baseFacts({ state: 'seat-failed', roundSeatIndexes: [0] });
    assertDecision(used, record({}), decide(record({}), used), {
      kind: 'park', reason: 'seat-plan-exhausted', qualifier: null, parkedFrom: 'seat-failed',
    });
  });

  it('F4: otherwise prepares for the record round', () => {
    const facts = baseFacts({ state: 'seat-failed' });
    expect(decide(record({}), facts)).toEqual({
      kind: 'act', step: 'prepare', key: `${RUN_ID}/r0/prepare/0/a2`, round: 0, seatIndex: 0, head12: null, retry: null,
    });
  });
});

describe('collecting state', () => {
  it('C1: before collection, collects', () => {
    const facts = baseFacts({ state: 'collecting', attempt: attemptFact() });
    expect(decide(record({}), facts)).toEqual({
      kind: 'act', step: 'collect', key: `${RUN_ID}/r0/collect/0`, round: 0, seatIndex: 0, head12: null, retry: null,
    });
  });

  it('C2: no commits enters seat-failed', () => {
    const facts = baseFacts({
      state: 'collecting', attempt: attemptFact({ collection: { commits: 0, manifest: 'sealed' } }),
    });
    assertDecision(facts, record({}), decide(record({}), facts), { kind: 'enter', to: 'seat-failed' });
  });

  it('C3: a missing or mismatched manifest parks artifacts-unsealed', () => {
    const missing = baseFacts({
      state: 'collecting', attempt: attemptFact({ collection: { commits: 1, manifest: 'missing' } }),
    });
    assertDecision(missing, record({}), decide(record({}), missing), {
      kind: 'park', reason: 'artifacts-unsealed', qualifier: null, parkedFrom: 'collecting',
    });
    const mismatch = baseFacts({
      state: 'collecting', attempt: attemptFact({ collection: { commits: 1, manifest: 'mismatch' } }),
    });
    assertDecision(mismatch, record({}), decide(record({}), mismatch), {
      kind: 'park', reason: 'artifacts-unsealed', qualifier: null, parkedFrom: 'collecting',
    });
  });

  it('C4: sealed with commits enters gating', () => {
    const facts = baseFacts({
      state: 'collecting', attempt: attemptFact({ collection: { commits: 1, manifest: 'sealed' } }),
    });
    assertDecision(facts, record({}), decide(record({}), facts), { kind: 'enter', to: 'gating' });
  });
});

describe('gating state', () => {
  it('T1: gate none acts gate', () => {
    const facts = baseFacts({ state: 'gating', head12: HEAD, attempt: attemptFact() });
    expect(decide(record({}), facts)).toEqual({
      kind: 'act', step: 'gate', key: `${RUN_ID}/r0/gate/0@${HEAD}`, round: 0, seatIndex: 0, head12: HEAD, retry: null,
    });
  });

  it('T2: pending waits gate-pending', () => {
    const facts = baseFacts({ state: 'gating', gate: 'pending' });
    expect(decide(record({}), facts)).toEqual({ kind: 'wait', reason: 'gate-pending' });
  });

  it('T3: unknown parks ambiguous gate', () => {
    const facts = baseFacts({ state: 'gating', gate: 'unknown' });
    assertDecision(facts, record({}), decide(record({}), facts), {
      kind: 'park', reason: 'ambiguous', qualifier: 'gate', parkedFrom: 'gating',
    });
  });

  it('T4: passed enters brief-check', () => {
    const facts = baseFacts({ state: 'gating', gate: 'passed' });
    assertDecision(facts, record({}), decide(record({}), facts), { kind: 'enter', to: 'brief-check' });
  });

  it('T5: failed enters fixing, after round 2 parks', () => {
    const failed = baseFacts({ state: 'gating', gate: 'failed' });
    assertDecision(failed, record({}), decide(record({}), failed), { kind: 'enter', to: 'fixing' });
    const rec = record({ round: 2, attemptIds: ['a1', 'a2', 'a3'] });
    const roundTwo = baseFacts({ state: 'gating', gate: 'failed' });
    assertDecision(roundTwo, rec, decide(rec, roundTwo), {
      kind: 'park', reason: 'blocker-after-round-2', qualifier: null, parkedFrom: 'gating',
    });
  });
});

describe('review rules per kind', () => {
  it.each(['brief-check', 'code-review'] as const)('V1: %s with no seat parks review-seat-unavailable', (kind) => {
    const facts = reviewFacts(kind, { verdict: 'none' }, { reviewSeat: { ok: false } });
    assertDecision(facts, record({}), decide(record({}), facts), {
      kind: 'park', reason: 'review-seat-unavailable', qualifier: null, parkedFrom: kind,
    });
  });

  it.each(['brief-check', 'code-review'] as const)('V2: %s none acts the kind', (kind) => {
    const facts = reviewFacts(kind, { verdict: 'none' });
    expect(decide(record({}), facts)).toEqual({
      kind: 'act', step: kind, key: `${RUN_ID}/r0/${kind}/0@${HEAD}`, round: 0, seatIndex: 0, head12: HEAD, retry: null,
    });
  });

  it.each(['brief-check', 'code-review'] as const)('V3: %s pending waits review-pending', (kind) => {
    const facts = reviewFacts(kind, { verdict: 'pending' });
    expect(decide(record({}), facts)).toEqual({ kind: 'wait', reason: 'review-pending' });
  });

  it.each(['brief-check', 'code-review'] as const)('V4: %s no-receipt retries the same seat once', (kind) => {
    const facts = reviewFacts(kind, { verdict: 'no-receipt', seatIndex: 0, retries: 0 });
    expect(decide(record({}), facts)).toEqual({
      kind: 'act', step: kind, key: `${RUN_ID}/r0/${kind}/0@${HEAD}/retry1`, round: 0, seatIndex: 0, head12: HEAD, retry: 1,
    });
  });

  it.each(['brief-check', 'code-review'] as const)('V5: %s no-receipt switches to a new seat without retry', (kind) => {
    const facts = reviewFacts(kind, { verdict: 'no-receipt', seatIndex: 0, retries: 1 }, { reviewSeat: { ok: true, seatIndex: 2 } });
    expect(decide(record({}), facts)).toEqual({
      kind: 'act', step: kind, key: `${RUN_ID}/r0/${kind}/2@${HEAD}`, round: 0, seatIndex: 2, head12: HEAD, retry: null,
    });
  });

  it.each(['brief-check', 'code-review'] as const)('V6: %s no-receipt otherwise parks review-seat-unavailable', (kind) => {
    const facts = reviewFacts(kind, { verdict: 'no-receipt', seatIndex: 0, retries: 1 });
    assertDecision(facts, record({}), decide(record({}), facts), {
      kind: 'park', reason: 'review-seat-unavailable', qualifier: null, parkedFrom: kind,
    });
  });

  it.each(['brief-check', 'code-review'] as const)('V7: %s unknown parks ambiguous', (kind) => {
    const facts = reviewFacts(kind, { verdict: 'unknown' });
    assertDecision(facts, record({}), decide(record({}), facts), {
      kind: 'park', reason: 'ambiguous', qualifier: kind, parkedFrom: kind,
    });
  });

  it.each(['brief-check', 'code-review'] as const)('V8: %s passed enters the next state', (kind) => {
    const facts = reviewFacts(kind, { verdict: 'passed' });
    const to = kind === 'brief-check' ? 'code-review' : 'accepting';
    assertDecision(facts, record({}), decide(record({}), facts), { kind: 'enter', to });
  });

  it.each(['brief-check', 'code-review'] as const)('V9: %s failed enters fixing', (kind) => {
    const facts = reviewFacts(kind, { verdict: 'failed' });
    assertDecision(facts, record({}), decide(record({}), facts), { kind: 'enter', to: 'fixing' });
  });
});

describe('fixing state', () => {
  it('X1: after round 2 parks blocker-after-round-2', () => {
    const rec = record({ round: 2, attemptIds: ['a1', 'a2', 'a3'] });
    const facts = baseFacts({ state: 'fixing' });
    assertDecision(facts, rec, decide(rec, facts), {
      kind: 'park', reason: 'blocker-after-round-2', qualifier: null, parkedFrom: 'fixing',
    });
  });

  it('X2: cost ceiling parks', () => {
    const facts = baseFacts({ state: 'fixing', costCeilingReached: true });
    assertDecision(facts, record({}), decide(record({}), facts), {
      kind: 'park', reason: 'cost-ceiling', qualifier: null, parkedFrom: 'fixing',
    });
  });

  it('X3: a prepared round+1 attempt dispatches round+1', () => {
    const rec = record({ attemptIds: ['attempt-example-1', 'attempt-example-2'] });
    const facts = baseFacts({
      state: 'fixing',
      attempt: attemptFact({ attemptId: 'attempt-example-2', round: 1, phase: 'prepared' }),
    });
    expect(decide(rec, facts)).toEqual({
      kind: 'act', step: 'dispatch', key: `${RUN_ID}/r1/dispatch/0/a2`, round: 1, seatIndex: 0, head12: null, retry: null,
    });
  });

  it('X4: a prior attempt that has not ended waits prior-not-ended', () => {
    const facts = baseFacts({ state: 'fixing', attempt: attemptFact() });
    expect(decide(record({}), facts)).toEqual({ kind: 'wait', reason: 'prior-not-ended' });
  });

  it('X5: otherwise prepares round+1', () => {
    const rec = record({ attemptIds: ['attempt-example-1'] });
    const facts = baseFacts({
      state: 'fixing',
      attempt: attemptFact({ phase: 'collected', collection: { commits: 1, manifest: 'sealed' } }),
    });
    expect(decide(rec, facts)).toEqual({
      kind: 'act', step: 'prepare', key: `${RUN_ID}/r1/prepare/0/a2`, round: 1, seatIndex: 0, head12: null, retry: null,
    });
  });

  it('X5: parks when the next seat is exhausted', () => {
    const rec = record({ attemptIds: ['attempt-example-1'] });
    const facts = baseFacts({
      state: 'fixing',
      attempt: attemptFact({ phase: 'collected', collection: { commits: 1, manifest: 'sealed' } }),
      implementerSeat: { ok: false },
    });
    assertDecision(facts, rec, decide(rec, facts), {
      kind: 'park', reason: 'seat-plan-exhausted', qualifier: null, parkedFrom: 'fixing',
    });
  });
});

describe('accepting, premerge, PR and CI states', () => {
  it('A1: acceptance none acts accept', () => {
    const facts = baseFacts({ state: 'accepting', head12: HEAD, attempt: attemptFact() });
    expect(decide(record({}), facts)).toEqual({
      kind: 'act', step: 'accept', key: `${RUN_ID}/r0/accept/0@${HEAD}`, round: 0, seatIndex: 0, head12: HEAD, retry: null,
    });
  });

  it('A2: acceptance unknown parks ambiguous accept', () => {
    const facts = baseFacts({ state: 'accepting', acceptance: 'unknown' });
    assertDecision(facts, record({}), decide(record({}), facts), {
      kind: 'park', reason: 'ambiguous', qualifier: 'accept', parkedFrom: 'accepting',
    });
  });

  it('A3: rejection parks acceptance-rejected', () => {
    const facts = baseFacts({ state: 'accepting', acceptance: 'rejected' });
    assertDecision(facts, record({}), decide(record({}), facts), {
      kind: 'park', reason: 'acceptance-rejected', qualifier: null, parkedFrom: 'accepting',
    });
  });

  it('A4: accepted enters the acceptance exit', () => {
    const facts = baseFacts({ state: 'accepting', acceptance: 'accepted' });
    assertDecision(facts, record({}), decide(record({}), facts), { kind: 'enter', to: 'awaiting-premerge' });
    const tierOne = baseFacts({ state: 'accepting', acceptance: 'accepted' });
    const rec = record({ tier: 1 });
    assertDecision(tierOne, rec, decide(rec, tierOne), { kind: 'enter', to: 'opening-pr' });
  });

  it('P1: premerge none waits premerge-pending', () => {
    const facts = baseFacts({ state: 'awaiting-premerge', head12: HEAD, acceptedHead12: HEAD });
    expect(decide(record({}), facts)).toEqual({ kind: 'wait', reason: 'premerge-pending' });
  });

  it('P2: premerge unknown parks ambiguous pre-merge', () => {
    const facts = baseFacts({ state: 'awaiting-premerge', head12: HEAD, acceptedHead12: HEAD, preMerge: 'unknown' });
    assertDecision(facts, record({}), decide(record({}), facts), {
      kind: 'park', reason: 'ambiguous', qualifier: 'pre-merge', parkedFrom: 'awaiting-premerge',
    });
  });

  it('P3: premerge passed enters the pre-merge exit', () => {
    const facts = baseFacts({ state: 'awaiting-premerge', head12: HEAD, acceptedHead12: HEAD, preMerge: 'passed' });
    assertDecision(facts, record({}), decide(record({}), facts), { kind: 'enter', to: 'opening-pr' });
  });

  it('P4: premerge failed enters fixing', () => {
    const facts = baseFacts({ state: 'awaiting-premerge', head12: HEAD, acceptedHead12: HEAD, preMerge: 'failed' });
    assertDecision(facts, record({}), decide(record({}), facts), { kind: 'enter', to: 'fixing' });
  });

  it('O1: with a PR number enters watching-ci', () => {
    const rec = record({ prNumber: 7 });
    const facts = baseFacts({ state: 'opening-pr', head12: HEAD, acceptedHead12: HEAD });
    assertDecision(facts, rec, decide(rec, facts), { kind: 'enter', to: 'watching-ci' });
  });

  it('O2: without a PR number opens the PR', () => {
    const facts = baseFacts({ state: 'opening-pr', head12: HEAD, acceptedHead12: HEAD, attempt: attemptFact() });
    expect(decide(record({}), facts)).toEqual({
      kind: 'act', step: 'open-pr', key: `${RUN_ID}/r0/open-pr/0@${HEAD}`, round: 0, seatIndex: 0, head12: HEAD, retry: null,
    });
  });

  it('H1: pushing without a PR is inconsistent', () => {
    const facts = baseFacts({ state: 'pushing', head12: HEAD, acceptedHead12: HEAD });
    expect(decide(record({ prNumber: 7 }), facts)).toEqual({ kind: 'wait', reason: 'facts-inconsistent' });
  });

  it('H2: pushing at the PR head enters watching-ci', () => {
    const rec = record({ prNumber: 7 });
    const facts = baseFacts({ state: 'pushing', head12: HEAD, acceptedHead12: HEAD, pr: { state: 'open', head12: HEAD } });
    assertDecision(facts, rec, decide(rec, facts), { kind: 'enter', to: 'watching-ci' });
  });

  it('H3: pushing behind the PR head pushes', () => {
    const rec = record({ prNumber: 7 });
    const facts = baseFacts({
      state: 'pushing', head12: HEAD, acceptedHead12: HEAD, pr: { state: 'open', head12: 'ffffffffffff' }, attempt: attemptFact(),
    });
    expect(decide(rec, facts)).toEqual({
      kind: 'act', step: 'push', key: `${RUN_ID}/r0/push/0@${HEAD}`, round: 0, seatIndex: 0, head12: HEAD, retry: null,
    });
  });

  it('W1: ci pending waits ci-pending', () => {
    const facts = baseFacts({ state: 'watching-ci', head12: HEAD, acceptedHead12: HEAD });
    expect(decide(record({}), facts)).toEqual({ kind: 'wait', reason: 'ci-pending' });
  });

  it('W2: ci unknown waits ci-unknown', () => {
    const facts = baseFacts({ state: 'watching-ci', head12: HEAD, acceptedHead12: HEAD, ci: 'unknown' });
    expect(decide(record({}), facts)).toEqual({ kind: 'wait', reason: 'ci-unknown' });
  });

  it('W3: ci passed enters merging', () => {
    const facts = baseFacts({ state: 'watching-ci', head12: HEAD, acceptedHead12: HEAD, ci: 'passed' });
    assertDecision(facts, record({}), decide(record({}), facts), { kind: 'enter', to: 'merging' });
  });

  it('W4: ci failed enters fixing, after round 2 parks ci-failed-no-rounds', () => {
    const failed = baseFacts({ state: 'watching-ci', head12: HEAD, acceptedHead12: HEAD, ci: 'failed' });
    assertDecision(failed, record({}), decide(record({}), failed), { kind: 'enter', to: 'fixing' });
    const rec = record({ round: 2, attemptIds: ['a1', 'a2', 'a3'] });
    const roundTwo = baseFacts({ state: 'watching-ci', head12: HEAD, acceptedHead12: HEAD, ci: 'failed' });
    assertDecision(roundTwo, rec, decide(rec, roundTwo), {
      kind: 'park', reason: 'ci-failed-no-rounds', qualifier: null, parkedFrom: 'watching-ci',
    });
  });
});

describe('merging state', () => {
  it('M1: merging without a PR is inconsistent', () => {
    const facts = baseFacts({ state: 'merging', head12: HEAD, acceptedHead12: HEAD });
    expect(decide(record({}), facts)).toEqual({ kind: 'wait', reason: 'facts-inconsistent' });
  });

  it('M2: merged at the head enters merged', () => {
    const facts = baseFacts({ state: 'merging', head12: HEAD, acceptedHead12: HEAD, pr: { state: 'merged', head12: HEAD } });
    assertDecision(facts, record({}), decide(record({}), facts), { kind: 'enter', to: 'merged' });
  });

  it('M3: merged at another head or closed parks ambiguous merge', () => {
    const otherHead = baseFacts({ state: 'merging', head12: HEAD, acceptedHead12: HEAD, pr: { state: 'merged', head12: 'ffffffffffff' } });
    assertDecision(otherHead, record({}), decide(record({}), otherHead), {
      kind: 'park', reason: 'ambiguous', qualifier: 'merge', parkedFrom: 'merging',
    });
    const closed = baseFacts({ state: 'merging', head12: HEAD, acceptedHead12: HEAD, pr: { state: 'closed', head12: 'ffffffffffff' } });
    assertDecision(closed, record({}), decide(record({}), closed), {
      kind: 'park', reason: 'ambiguous', qualifier: 'merge', parkedFrom: 'merging',
    });
  });

  it('M4: a one-way door parks one-way-door', () => {
    const facts = baseFacts({
      state: 'merging', head12: HEAD, acceptedHead12: HEAD, pr: { state: 'open', head12: HEAD }, merge: { oneWayDoor: true, branchBehind: false, trainFree: true, policyGrant: true },
    });
    assertDecision(facts, record({}), decide(record({}), facts), {
      kind: 'park', reason: 'one-way-door', qualifier: null, parkedFrom: 'merging',
    });
  });

  it('M5: a behind branch parks branch-behind', () => {
    const facts = baseFacts({
      state: 'merging', head12: HEAD, acceptedHead12: HEAD, pr: { state: 'open', head12: HEAD }, merge: { oneWayDoor: false, branchBehind: true, trainFree: true, policyGrant: true },
    });
    assertDecision(facts, record({}), decide(record({}), facts), {
      kind: 'park', reason: 'branch-behind', qualifier: null, parkedFrom: 'merging',
    });
  });

  it('M6: without a policy grant parks owner-merge', () => {
    const facts = baseFacts({
      state: 'merging', head12: HEAD, acceptedHead12: HEAD, pr: { state: 'open', head12: HEAD }, merge: { oneWayDoor: false, branchBehind: false, trainFree: true, policyGrant: false },
    });
    assertDecision(facts, record({}), decide(record({}), facts), {
      kind: 'park', reason: 'owner-merge', qualifier: null, parkedFrom: 'merging',
    });
  });

  it('M7: without a free train waits merge-train', () => {
    const facts = baseFacts({
      state: 'merging', head12: HEAD, acceptedHead12: HEAD, pr: { state: 'open', head12: HEAD }, merge: { oneWayDoor: false, branchBehind: false, trainFree: false, policyGrant: true },
    });
    expect(decide(record({}), facts)).toEqual({ kind: 'wait', reason: 'merge-train' });
  });

  it('M8: otherwise acts merge', () => {
    const facts = baseFacts({ state: 'merging', head12: HEAD, acceptedHead12: HEAD, pr: { state: 'open', head12: HEAD }, attempt: attemptFact() });
    expect(decide(record({}), facts)).toEqual({
      kind: 'act', step: 'merge', key: `${RUN_ID}/r0/merge/0@${HEAD}`, round: 0, seatIndex: 0, head12: HEAD, retry: null,
    });
  });
});

describe('rounds across the run', () => {
  it('a failed first gate enters fixing', () => {
    const facts = baseFacts({ state: 'gating', gate: 'failed' });
    assertDecision(facts, record({}), decide(record({}), facts), { kind: 'enter', to: 'fixing' });
  });

  it('fixing with a collected prior attempt prepares round 1', () => {
    const rec = record({ attemptIds: ['attempt-example-1'] });
    const facts = baseFacts({
      state: 'fixing',
      attempt: attemptFact({ phase: 'collected', collection: { commits: 1, manifest: 'sealed' } }),
    });
    expect(decide(rec, facts)).toEqual({
      kind: 'act', step: 'prepare', key: `${RUN_ID}/r1/prepare/0/a2`, round: 1, seatIndex: 0, head12: null, retry: null,
    });
  });

  it('fixing with a prepared round-1 attempt dispatches round 1', () => {
    const rec = record({ attemptIds: ['attempt-example-1', 'attempt-example-2'] });
    const facts = baseFacts({
      state: 'fixing',
      attempt: attemptFact({ attemptId: 'attempt-example-2', round: 1, phase: 'prepared' }),
    });
    expect(decide(rec, facts)).toEqual({
      kind: 'act', step: 'dispatch', key: `${RUN_ID}/r1/dispatch/0/a2`, round: 1, seatIndex: 0, head12: null, retry: null,
    });
  });

  it('at round 2 a failed code review parks blocker-after-round-2', () => {
    const rec = record({ round: 2, attemptIds: ['a1', 'a2', 'a3'] });
    const facts = reviewFacts('code-review', { verdict: 'failed' });
    assertDecision(facts, rec, decide(rec, facts), {
      kind: 'park', reason: 'blocker-after-round-2', qualifier: null, parkedFrom: 'code-review',
    });
  });

  it('failed CI at round 2 parks ci-failed-no-rounds', () => {
    const rec = record({ round: 2, attemptIds: ['a1', 'a2', 'a3'] });
    const facts = baseFacts({ state: 'watching-ci', head12: HEAD, acceptedHead12: HEAD, ci: 'failed' });
    assertDecision(facts, rec, decide(rec, facts), {
      kind: 'park', reason: 'ci-failed-no-rounds', qualifier: null, parkedFrom: 'watching-ci',
    });
  });
});

describe('stop retries', () => {
  it('G4d stop retry follows stopsIssued', () => {
    const zero = baseFacts({ state: 'running', stopMode: 'force', attempt: attemptFact() });
    expect(decide(record({}), zero)).toEqual({
      kind: 'act', step: 'stop', key: `${RUN_ID}/r0/stop/0`, round: 0, seatIndex: 0, head12: null, retry: null,
    });
    const three = baseFacts({ state: 'running', stopMode: 'force', attempt: attemptFact({ stopsIssued: 3 }) });
    expect(decide(record({}), three)).toEqual({
      kind: 'act', step: 'stop', key: `${RUN_ID}/r0/stop/0/retry3`, round: 0, seatIndex: 0, head12: null, retry: 3,
    });
    const ten = baseFacts({ state: 'running', stopMode: 'force', attempt: attemptFact({ stopsIssued: 10 }) });
    expect(decide(record({}), ten)).toEqual({ kind: 'wait', reason: 'stop-unconfirmed' });
  });

  it('U5 exhausted parks ambiguous stop', () => {
    const facts = baseFacts({
      state: 'running',
      attempt: attemptFact({ deadlineIso: '2026-10-27T09:00:00.000Z', stopsIssued: 10 }),
    });
    assertDecision(facts, record({}), decide(record({}), facts), {
      kind: 'park', reason: 'ambiguous', qualifier: 'stop', parkedFrom: 'running',
    });
  });
});

describe('inconsistent input never throws', () => {
  it('a rejected nowIso is inconsistent', () => {
    expect(decide(record({}), baseFacts(), 'soon')).toEqual({ kind: 'wait', reason: 'facts-inconsistent' });
  });

  it('a step needing a head with a null head is inconsistent', () => {
    const facts = baseFacts({ state: 'gating', gate: 'none', head12: null, attempt: attemptFact() });
    expect(decide(record({}), facts)).toEqual({ kind: 'wait', reason: 'facts-inconsistent' });
  });

  it('a state needing an attempt with none is inconsistent', () => {
    const facts = baseFacts({ state: 'running', attempt: null });
    expect(decide(record({}), facts)).toEqual({ kind: 'wait', reason: 'facts-inconsistent' });
  });

  it('a throwing merge getter is inconsistent', () => {
    const facts = baseFacts({
      state: 'merging', head12: HEAD, acceptedHead12: HEAD, pr: { state: 'open', head12: HEAD },
    });
    Object.defineProperty(facts, 'merge', {
      get() {
        throw new Error('boom');
      },
    });
    expect(decide(record({}), facts)).toEqual({ kind: 'wait', reason: 'facts-inconsistent' });
  });
});

describe('laneRunAttemptPhaseOf', () => {
  it('maps every attempt state to a phase, and anything else to blocked', () => {
    expect(laneRunAttemptPhaseOf('intent-recorded')).toBe('prepared');
    expect(laneRunAttemptPhaseOf('dispatching')).toBe('dispatching');
    expect(laneRunAttemptPhaseOf('running')).toBe('running');
    expect(laneRunAttemptPhaseOf('reconciling')).toBe('running');
    expect(laneRunAttemptPhaseOf('blocked')).toBe('blocked');
    expect(laneRunAttemptPhaseOf('ended')).toBe('ended');
    expect(laneRunAttemptPhaseOf('collected')).toBe('collected');
    expect(laneRunAttemptPhaseOf('cancelled')).toBe('cancelled');
    for (const state of ATTEMPT_STATES) {
      expect(laneRunAttemptPhaseOf(state)).not.toBe(undefined);
    }
    expect(laneRunAttemptPhaseOf('XYZZY')).toBe('blocked');
    expect(laneRunAttemptPhaseOf(42)).toBe('blocked');
  });
});

describe('cancel and modes (plan §3.9.1)', () => {
  it('G4e cancels under the stop key in either mode', () => {
    for (const stopMode of ['force', 'graceful'] as const) {
      const facts = baseFacts({
        state: 'running', stopMode, attempt: attemptFact({ phase: 'prepared', dispatchResult: 'none' }),
      });
      expect(decide(record({}), facts)).toEqual({
        kind: 'cancel',
        key: `${RUN_ID}/r0/stop/0`,
        attemptId: 'attempt-example-1',
        round: 0,
        seatIndex: 0,
        retry: null,
      });
    }
  });

  it('G4e retry suffix follows stopsIssued and 10 waits stop-unconfirmed', () => {
    const two = baseFacts({
      state: 'running', stopMode: 'force', attempt: attemptFact({ phase: 'prepared', dispatchResult: 'none', stopsIssued: 2 }),
    });
    expect(decide(record({}), two)).toEqual({
      kind: 'cancel',
      key: `${RUN_ID}/r0/stop/0/retry2`,
      attemptId: 'attempt-example-1',
      round: 0,
      seatIndex: 0,
      retry: 2,
    });
    const ten = baseFacts({
      state: 'running', stopMode: 'force', attempt: attemptFact({ phase: 'prepared', dispatchResult: 'none', stopsIssued: 10 }),
    });
    expect(decide(record({}), ten)).toEqual({ kind: 'wait', reason: 'stop-unconfirmed' });
  });

  it('G4e cancels even when halted', () => {
    const facts = baseFacts({
      state: 'running', halted: true, stopMode: 'force', attempt: attemptFact({ phase: 'prepared', dispatchResult: 'none' }),
    });
    expect(decide(record({}), facts)).toEqual({
      kind: 'cancel',
      key: `${RUN_ID}/r0/stop/0`,
      attemptId: 'attempt-example-1',
      round: 0,
      seatIndex: 0,
      retry: null,
    });
  });

  it('G4e cancels a not-started dispatch too', () => {
    const facts = baseFacts({
      state: 'running', stopMode: 'force', attempt: attemptFact({ phase: 'prepared', dispatchResult: 'not-started' }),
    });
    expect(decide(record({}), facts)).toEqual({
      kind: 'cancel',
      key: `${RUN_ID}/r0/stop/0`,
      attemptId: 'attempt-example-1',
      round: 0,
      seatIndex: 0,
      retry: null,
    });
  });

  it('graceful with a started prepared attempt parks ambiguous dispatch, never acts stop', () => {
    const facts = baseFacts({
      state: 'running', stopMode: 'graceful', attempt: attemptFact({ phase: 'prepared' }),
    });
    assertDecision(facts, record({}), decide(record({}), facts), {
      kind: 'park', reason: 'ambiguous', qualifier: 'dispatch', parkedFrom: 'running',
    });
  });

  it('the same graceful prepared attempt waits while parked', () => {
    const rec = record({ parked: PARKED_UNCONFIRMED, parkCount: 1 });
    const facts = baseFacts({
      state: 'parked', stopMode: 'graceful', attempt: attemptFact({ phase: 'prepared' }),
    });
    expect(decide(rec, facts)).toEqual({ kind: 'wait', reason: 'parked' });
  });

  it('force with a started prepared attempt reconciles, never acts stop, in parked too', () => {
    const running = baseFacts({
      state: 'running', stopMode: 'force', attempt: attemptFact({ phase: 'prepared' }),
    });
    expect(decide(record({}), running)).toEqual({
      kind: 'reconcile', step: 'dispatch', key: `${RUN_ID}/r0/reconcile/0`,
    });
    const parkedRec = record({ parked: PARKED_BLOCKER, parkCount: 1 });
    const parked = baseFacts({
      state: 'parked', stopMode: 'force', attempt: attemptFact({ phase: 'prepared' }),
    });
    expect(decide(parkedRec, parked)).toEqual({
      kind: 'reconcile', step: 'dispatch', key: `${RUN_ID}/r0/reconcile/0`,
    });
  });

  it('the same force with halted parks halted', () => {
    const facts = baseFacts({
      state: 'running', halted: true, stopMode: 'force', attempt: attemptFact({ phase: 'prepared' }),
    });
    assertDecision(facts, record({}), decide(record({}), facts), {
      kind: 'park', reason: 'halted', qualifier: null, parkedFrom: 'running',
    });
  });

  it('a graceful drain collects, gates and ends stopped once the gate passes', () => {
    const rec = record({});
    const grace = { stopRequestedAtIso: '2026-10-27T09:16:00.000Z' };

    const s1 = baseFacts({ state: 'running', stopMode: 'graceful', attempt: attemptFact(), ...grace });
    expect(decide(rec, s1)).toEqual({ kind: 'wait', reason: 'stop-draining' });

    const s2 = baseFacts({ state: 'running', stopMode: 'graceful', attempt: attemptFact({ phase: 'ended' }), ...grace });
    assertDecision(s2, rec, decide(rec, s2), { kind: 'enter', to: 'collecting' });

    const s3 = baseFacts({ state: 'collecting', stopMode: 'graceful', attempt: attemptFact({ phase: 'collected', collection: null }), ...grace });
    expect(decide(rec, s3)).toEqual({
      kind: 'act', step: 'collect', key: `${RUN_ID}/r0/collect/0`, round: 0, seatIndex: 0, head12: null, retry: null,
    });

    const sealed = { commits: 2, manifest: 'sealed' as const };
    const s4 = baseFacts({ state: 'collecting', stopMode: 'graceful', attempt: attemptFact({ phase: 'collected', collection: sealed }), ...grace });
    assertDecision(s4, rec, decide(rec, s4), { kind: 'enter', to: 'gating' });

    const s5 = baseFacts({ state: 'gating', stopMode: 'graceful', attempt: attemptFact({ phase: 'collected', collection: sealed }), head12: HEAD, ...grace });
    expect(decide(rec, s5)).toEqual({
      kind: 'act', step: 'gate', key: `${RUN_ID}/r0/gate/0@${HEAD}`, round: 0, seatIndex: 0, head12: HEAD, retry: null,
    });

    const s6 = baseFacts({ state: 'gating', stopMode: 'graceful', attempt: attemptFact({ phase: 'collected', collection: sealed }), head12: HEAD, gate: 'pending', ...grace });
    expect(decide(rec, s6)).toEqual({ kind: 'wait', reason: 'gate-pending' });

    const s7 = baseFacts({ state: 'gating', stopMode: 'graceful', attempt: attemptFact({ phase: 'collected', collection: sealed }), head12: HEAD, gate: 'passed', ...grace });
    assertDecision(s7, rec, decide(rec, s7), { kind: 'enter', to: 'stopped' });
  });

  it('a decided failed or unknown gate ends the drain stopped, never fixing or ambiguous', () => {
    const rec = record({});
    const base: Partial<LaneRunFacts> = {
      state: 'gating',
      stopMode: 'graceful',
      head12: HEAD,
      attempt: attemptFact({ phase: 'collected', collection: { commits: 2, manifest: 'sealed' } }),
    };
    const failed = baseFacts({ ...base, gate: 'failed' });
    assertDecision(failed, rec, decide(rec, failed), { kind: 'enter', to: 'stopped' });
    const unknown = baseFacts({ ...base, gate: 'unknown' });
    assertDecision(unknown, rec, decide(rec, unknown), { kind: 'enter', to: 'stopped' });
  });

  it('a zero-commit collection ends the drain stopped, never preparing the next seat', () => {
    const rec = record({});
    const attempt = attemptFact({ phase: 'collected', collection: { commits: 0, manifest: 'sealed' } });
    const collecting = baseFacts({ state: 'collecting', stopMode: 'graceful', attempt });
    assertDecision(collecting, rec, decide(rec, collecting), { kind: 'enter', to: 'seat-failed' });
    const seatFailed = baseFacts({ state: 'seat-failed', stopMode: 'graceful', attempt });
    assertDecision(seatFailed, rec, decide(rec, seatFailed), { kind: 'enter', to: 'stopped' });
  });

  it('an unsealed collection parks, then the parked run enters stopped', () => {
    const attempt = attemptFact({ phase: 'collected', collection: { commits: 2, manifest: 'missing' } });
    const rec = record({});
    const collecting = baseFacts({ state: 'collecting', stopMode: 'graceful', attempt });
    assertDecision(collecting, rec, decide(rec, collecting), {
      kind: 'park', reason: 'artifacts-unsealed', qualifier: null, parkedFrom: 'collecting',
    });
    const parkedRec = record({
      parked: { reason: 'artifacts-unsealed', qualifier: null, parkedFrom: 'collecting', questionId: null },
      parkCount: 1,
    });
    const parked = baseFacts({ state: 'parked', stopMode: 'graceful', attempt });
    assertDecision(parked, parkedRec, decide(parkedRec, parked), { kind: 'enter', to: 'stopped' });
  });

  it('grace: the stop grace decides between stop-draining and stop-grace-exceeded', () => {
    const rec = record({});
    const attempt = attemptFact();
    const within = baseFacts({ state: 'running', stopMode: 'graceful', attempt, stopRequestedAtIso: '2026-10-27T09:16:00.000Z' });
    expect(decide(rec, within)).toEqual({ kind: 'wait', reason: 'stop-draining' });
    const exceeded = baseFacts({ state: 'running', stopMode: 'graceful', attempt, stopRequestedAtIso: '2026-10-27T09:15:00.000Z' });
    expect(decide(rec, exceeded)).toEqual({ kind: 'wait', reason: 'stop-grace-exceeded' });
    const none = baseFacts({ state: 'running', stopMode: 'graceful', attempt, stopRequestedAtIso: null });
    expect(decide(rec, none)).toEqual({ kind: 'wait', reason: 'stop-grace-exceeded' });
  });

  it('the run deadline still stops the attempt under a graceful stop', () => {
    const rec = record({});
    const facts = baseFacts({ state: 'running', stopMode: 'graceful', attempt: attemptFact({ deadlineIso: NOW }) });
    expect(decide(rec, facts)).toEqual({
      kind: 'act', step: 'stop', key: `${RUN_ID}/r0/stop/0`, round: 0, seatIndex: 0, head12: null, retry: null,
    });
  });

  it('a halt parks the drain and it continues once lifted', () => {
    const attempt = attemptFact({ phase: 'collected', collection: { commits: 2, manifest: 'sealed' } });
    const rec = record({});
    const halted = baseFacts({ state: 'gating', stopMode: 'graceful', halted: true, head12: HEAD, gate: 'none', attempt });
    assertDecision(halted, rec, decide(rec, halted), { kind: 'park', reason: 'halted', qualifier: null, parkedFrom: 'gating' });

    const parkedRec = record({
      parked: { reason: 'halted', qualifier: null, parkedFrom: 'gating', questionId: null },
      parkCount: 1,
    });
    const lifted = baseFacts({ state: 'parked', stopMode: 'graceful', halted: false, head12: HEAD, gate: 'none', attempt });
    assertDecision(lifted, parkedRec, decide(parkedRec, lifted), { kind: 'enter', to: 'gating' });

    const resumed = baseFacts({ state: 'gating', stopMode: 'graceful', halted: false, head12: HEAD, gate: 'none', attempt });
    expect(decide(rec, resumed)).toEqual({
      kind: 'act', step: 'gate', key: `${RUN_ID}/r0/gate/0@${HEAD}`, round: 0, seatIndex: 0, head12: HEAD, retry: null,
    });
  });

  it('a force stop escalates over the graceful drain', () => {
    const rec = record({});
    const facts = baseFacts({ state: 'running', stopMode: 'force', attempt: attemptFact() });
    expect(decide(rec, facts)).toEqual({
      kind: 'act', step: 'stop', key: `${RUN_ID}/r0/stop/0`, round: 0, seatIndex: 0, head12: null, retry: null,
    });
  });

  it.each(['brief-check', 'code-review', 'fixing', 'accepting', 'awaiting-premerge', 'opening-pr', 'watching-ci', 'merging'] as const)(
    'a graceful stop ends the collected attempt in %s as stopped',
    (state) => {
      const rec = record({});
      const facts = baseFacts({
        state,
        stopMode: 'graceful',
        attempt: attemptFact({ phase: 'collected', collection: { commits: 2, manifest: 'sealed' } }),
        head12: HEAD,
        acceptedHead12: HEAD,
      });
      assertDecision(facts, rec, decide(rec, facts), { kind: 'enter', to: 'stopped' });
    },
  );

  it('an ambiguous park with a live attempt stands under a graceful stop', () => {
    const rec = record({
      parked: { reason: 'ambiguous', qualifier: 'gate', parkedFrom: 'gating', questionId: null },
      parkCount: 1,
    });
    const facts = baseFacts({ state: 'parked', stopMode: 'graceful', attempt: attemptFact() });
    expect(decide(rec, facts)).toEqual({ kind: 'wait', reason: 'parked' });
  });

  it('force over graceful stops a running attempt', () => {
    const facts = baseFacts({ state: 'running', stopMode: 'force', attempt: attemptFact() });
    expect(decide(record({}), facts)).toEqual({
      kind: 'act', step: 'stop', key: `${RUN_ID}/r0/stop/0`, round: 0, seatIndex: 0, head12: null, retry: null,
    });
  });

  it('force stops a session-less dispatching attempt by worktree', () => {
    const facts = baseFacts({ state: 'running', stopMode: 'force', attempt: attemptFact({ phase: 'dispatching' }) });
    expect(decide(record({}), facts)).toEqual({
      kind: 'act', step: 'stop', key: `${RUN_ID}/r0/stop/0`, round: 0, seatIndex: 0, head12: null, retry: null,
    });
  });
});

describe('halt-marker exit (G4h)', () => {
  it('a halted park with a stop lifts to running, then the next call stops', () => {
    const rec = record({ parked: PARKED_HALTED, parkCount: 1 });
    const facts = baseFacts({
      state: 'parked', halted: false, stopMode: 'force', attempt: attemptFact(),
    });
    assertDecision(facts, rec, decide(rec, facts), { kind: 'enter', to: 'running' });

    const next = baseFacts({ state: 'running', stopMode: 'force', attempt: attemptFact() });
    expect(decide(record({}), next)).toEqual({
      kind: 'act', step: 'stop', key: `${RUN_ID}/r0/stop/0`, round: 0, seatIndex: 0, head12: null, retry: null,
    });
  });

  it('the same with halted true waits parked (G4b)', () => {
    const rec = record({ parked: PARKED_HALTED, parkCount: 1 });
    const facts = baseFacts({
      state: 'parked', halted: true, stopMode: 'force', attempt: attemptFact(),
    });
    expect(decide(rec, facts)).toEqual({ kind: 'wait', reason: 'parked' });
  });

  it('a plain halted park with no stop waits parked (G5)', () => {
    const rec = record({ parked: PARKED_HALTED, parkCount: 1 });
    const facts = baseFacts({ state: 'parked', halted: true });
    expect(decide(rec, facts)).toEqual({ kind: 'wait', reason: 'parked' });
  });
});

describe('merged before stopped (G3d)', () => {
  it('a landed merge ends merged under a graceful stop', () => {
    const rec = record({});
    const facts = baseFacts({
      state: 'merging', stopMode: 'graceful', head12: HEAD, acceptedHead12: HEAD, pr: { state: 'merged', head12: HEAD },
    });
    assertDecision(facts, rec, decide(rec, facts), { kind: 'enter', to: 'merged' });
  });

  it('a merge at another head parks ambiguous merge under a stop', () => {
    const facts = baseFacts({
      state: 'merging', stopMode: 'graceful', head12: HEAD, acceptedHead12: HEAD, pr: { state: 'merged', head12: 'ffffffffffff' },
    });
    assertDecision(facts, record({}), decide(record({}), facts), {
      kind: 'park', reason: 'ambiguous', qualifier: 'merge', parkedFrom: 'merging',
    });
  });

  it('an unread merge intent reconciles before any stop', () => {
    const rec = record({});
    const facts = baseFacts({
      state: 'merging',
      stopMode: 'graceful',
      head12: HEAD,
      acceptedHead12: HEAD,
      pr: { state: 'merged', head12: HEAD },
      pendingIntent: { key: `${RUN_ID}/r0/merge/0@${HEAD}`, step: 'merge', reconciliation: 'unread' },
    });
    expect(decide(rec, facts)).toEqual({ kind: 'reconcile', step: 'merge', key: `${RUN_ID}/r0/merge/0@${HEAD}` });
  });
});

describe('KF-1: a lost dispatching conduct is repaired, never re-prepared', () => {
  it('a ready run with a started, still-live attempt enters dispatching (not a second prepare)', () => {
    const rec = record({});
    const facts = baseFacts({
      state: 'ready',
      attempt: attemptFact({ phase: 'dispatching', dispatchResult: 'started' }),
    });
    assertDecision(facts, rec, decide(rec, facts), { kind: 'enter', to: 'dispatching' });
  });

  it('a seat-failed run with a started, still-live attempt enters dispatching (not a second prepare)', () => {
    const rec = record({});
    const facts = baseFacts({
      state: 'seat-failed',
      attempt: attemptFact({ phase: 'dispatching', dispatchResult: 'started' }),
    });
    assertDecision(facts, rec, decide(rec, facts), { kind: 'enter', to: 'dispatching' });
  });

  it('a fixing run with a started round+1 attempt enters dispatching (not a second prepare)', () => {
    const rec = record({ attemptIds: ['attempt-example-1', 'attempt-example-2'] });
    const facts = baseFacts({
      state: 'fixing',
      attempt: attemptFact({ attemptId: 'attempt-example-2', round: 1, phase: 'dispatching', dispatchResult: 'started' }),
    });
    assertDecision(facts, rec, decide(rec, facts), { kind: 'enter', to: 'dispatching' });
  });

  it('an ended or cancelled attempt never repairs: seat-failed prepares the retry, fixing waits', () => {
    const ended = baseFacts({
      state: 'seat-failed',
      attempt: attemptFact({ phase: 'ended', dispatchResult: 'started' }),
    });
    expect(decide(record({}), ended)).toEqual({
      kind: 'act', step: 'prepare', key: `${RUN_ID}/r0/prepare/0/a2`, round: 0, seatIndex: 0, head12: null, retry: null,
    });
    const cancelled = baseFacts({
      state: 'seat-failed',
      attempt: attemptFact({ phase: 'cancelled', dispatchResult: 'started' }),
    });
    expect(decide(record({}), cancelled)).toEqual({
      kind: 'act', step: 'prepare', key: `${RUN_ID}/r0/prepare/0/a2`, round: 0, seatIndex: 0, head12: null, retry: null,
    });
    const prior = baseFacts({ state: 'fixing', attempt: attemptFact({ phase: 'running', dispatchResult: 'started' }) });
    expect(decide(record({}), prior)).toEqual({ kind: 'wait', reason: 'prior-not-ended' });
  });
});

describe('KF-1: halt blocks the collect and gate reconcile (G3a under halt)', () => {
  const collectIntent = { key: `${RUN_ID}/r0/collect/0`, step: 'collect' as const, reconciliation: 'unread' as const };

  it('a pending collect intent under a halt takes the halt decision, not the reconcile', () => {
    const facts = baseFacts({
      state: 'collecting',
      halted: true,
      attempt: attemptFact({ phase: 'ended' }),
      pendingIntent: collectIntent,
    });
    expect(decide(record({}), facts)).toEqual({ kind: 'park', reason: 'halted', qualifier: null, parkedFrom: 'collecting' });
  });

  it('the same pending collect intent without a halt reconciles as today', () => {
    const facts = baseFacts({
      state: 'collecting',
      attempt: attemptFact({ phase: 'ended' }),
      pendingIntent: collectIntent,
    });
    expect(decide(record({}), facts)).toEqual({ kind: 'reconcile', step: 'collect', key: collectIntent.key });
  });

  it('a pending gate intent under a halt takes the halt decision, not the reconcile', () => {
    const facts = baseFacts({
      state: 'gating',
      halted: true,
      attempt: attemptFact({ phase: 'collected', collection: { commits: 1, manifest: 'sealed' } }),
      pendingIntent: { key: `${RUN_ID}/r0/gate/0@${HEAD}`, step: 'gate', reconciliation: 'unread' },
    });
    expect(decide(record({}), facts)).toEqual({ kind: 'park', reason: 'halted', qualifier: null, parkedFrom: 'gating' });
  });

  it('a pending dispatch intent under a halt is still reconciled', () => {
    const facts = baseFacts({
      state: 'ready',
      halted: true,
      attempt: attemptFact({ phase: 'dispatching', dispatchResult: 'started' }),
      pendingIntent: { key: `${RUN_ID}/r0/dispatch/0/a1`, step: 'dispatch', reconciliation: 'unread' },
    });
    expect(decide(record({}), facts)).toEqual({ kind: 'reconcile', step: 'dispatch', key: `${RUN_ID}/r0/dispatch/0/a1` });
  });
});

describe('decision legality', () => {
  it('every enter decision produced above is a legal transition', () => {
    expect(enterDecisions.length).toBeGreaterThan(0);
    for (const entry of enterDecisions) {
      expect(canEnterLaneRunState(entry.from, entry.to, entry.parkedFrom)).toBe(true);
    }
  });
});
