import { describe, expect, it } from 'vitest';

import { LaneRun } from '../entities/LaneRun.js';
import type { LaneRunRecord } from '../lane-run-records.js';
import {
  LANE_RUN_RESUMABLE_STATES,
  LANE_RUN_STATES,
  LANE_RUN_TERMINAL_STATES,
} from '../value-objects/LaneRunState.vo.js';
import type { LaneRunStateValue } from '../value-objects/LaneRunState.vo.js';
import {
  LANE_RUN_DRAIN_STATES,
  LANE_RUN_DRAIN_STEPS,
  LANE_RUN_EXITS,
  LANE_RUN_HEAD_CHANGE_STATES,
  afterLaneRunAcceptance,
  afterLaneRunFailure,
  afterLaneRunPreMergePass,
  canEnterLaneRunState,
  checkLaneRunResume,
  implementerRoleFor,
  laneRunDrainContinues,
  laneRunHaltLiftExit,
  laneRunHeadChanged,
  laneRunRoundsLeft,
  laneRunStopEffect,
  strongerStopMode,
  workOrderReleaseFor,
} from '../lane-run-transitions.js';

const RUN_ID = 'run-01JB0000000000000000000000';
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

function record(overrides: Record<string, unknown>): LaneRunRecord {
  const result = LaneRun.create({ ...BASE_RECORD, ...overrides });
  expect(result.success).toBe(true);
  if (!result.success) {
    throw new Error('fixture must be a valid LaneRun record');
  }
  return result.value.toRecord();
}

const PARKED_UNCONFIRMED = { reason: 'stop-unconfirmed', qualifier: null, parkedFrom: 'gating', questionId: null };
const PARKED_REFUSED = { reason: 'stop-refused', qualifier: 'runner-refused', parkedFrom: 'gating', questionId: null };
const PARKED_BLOCKER = { reason: 'blocker-after-round-2', qualifier: null, parkedFrom: 'gating', questionId: null };
const PARKED_ONE_WAY = { reason: 'one-way-door', qualifier: null, parkedFrom: 'gating', questionId: null };
const PARKED_HALTED = { reason: 'halted', qualifier: null, parkedFrom: 'gating', questionId: null };

const EXPECTED_EXITS: Record<LaneRunStateValue, readonly LaneRunStateValue[]> = {
  ready: ['dispatching'],
  dispatching: ['running', 'seat-failed'],
  running: ['collecting', 'seat-failed'],
  'seat-failed': ['dispatching'],
  collecting: ['gating', 'seat-failed'],
  gating: ['brief-check', 'fixing'],
  'brief-check': ['code-review', 'fixing'],
  'code-review': ['accepting', 'fixing'],
  fixing: ['dispatching'],
  accepting: ['awaiting-premerge', 'opening-pr', 'pushing'],
  'awaiting-premerge': ['opening-pr', 'pushing', 'fixing', 'gating'],
  'opening-pr': ['watching-ci', 'gating'],
  pushing: ['watching-ci', 'gating'],
  'watching-ci': ['merging', 'fixing', 'gating'],
  merging: ['merged', 'gating'],
  merged: [],
  stopped: [],
  parked: [],
};

const FALSE_EXIT: Record<LaneRunStateValue, LaneRunStateValue> = {
  ready: 'gating',
  dispatching: 'collecting',
  running: 'merging',
  'seat-failed': 'running',
  collecting: 'running',
  gating: 'accepting',
  'brief-check': 'gating',
  'code-review': 'gating',
  fixing: 'running',
  accepting: 'gating',
  'awaiting-premerge': 'merged',
  'opening-pr': 'merging',
  pushing: 'merging',
  'watching-ci': 'pushing',
  merging: 'fixing',
  merged: 'gating',
  stopped: 'gating',
  parked: 'gating',
};

describe('LaneRun exits', () => {
  it.each(LANE_RUN_STATES)('%s exits match the table and each listed exit is legal', (state) => {
    expect(LANE_RUN_EXITS[state]).toEqual(EXPECTED_EXITS[state]);
    for (const exit of LANE_RUN_EXITS[state]) {
      expect(canEnterLaneRunState(state, exit)).toBe(true);
    }
    expect(canEnterLaneRunState(state, FALSE_EXIT[state])).toBe(false);
  });

  it('universal exits apply to every non-terminal state', () => {
    for (const state of LANE_RUN_STATES) {
      if ((LANE_RUN_TERMINAL_STATES as readonly LaneRunStateValue[]).includes(state)) {
        continue;
      }
      expect(canEnterLaneRunState(state, 'stopped')).toBe(true);
    }
    for (const state of LANE_RUN_RESUMABLE_STATES) {
      expect(canEnterLaneRunState(state, 'parked')).toBe(true);
    }
    expect(canEnterLaneRunState('parked', 'parked')).toBe(false);
    expect(canEnterLaneRunState('merged', 'stopped')).toBe(false);
    expect(canEnterLaneRunState('stopped', 'parked')).toBe(false);
    expect(canEnterLaneRunState('merged', 'gating')).toBe(false);
  });

  it('a park returns only to its recorded parkedFrom', () => {
    expect(canEnterLaneRunState('parked', 'gating', 'gating')).toBe(true);
    expect(canEnterLaneRunState('parked', 'merging', 'gating')).toBe(false);
    expect(canEnterLaneRunState('parked', 'gating')).toBe(false);
    expect(canEnterLaneRunState('parked', 'stopped')).toBe(true);
  });

  it('the owner-merge park enters merged by itself (CT-2a)', () => {
    expect(canEnterLaneRunState('parked', 'merged', 'merging')).toBe(true);
    expect(canEnterLaneRunState('parked', 'merged')).toBe(true);
    // The exception opens nothing from a terminal state.
    expect(canEnterLaneRunState('stopped', 'merged')).toBe(false);
    expect(canEnterLaneRunState('merged', 'merged')).toBe(false);
  });

  it('unknown strings are refused', () => {
    expect(canEnterLaneRunState('nope', 'ready')).toBe(false);
    expect(canEnterLaneRunState('ready', 'nope')).toBe(false);
  });
});

describe('rounds and roles', () => {
  it('a first-pass failure enters fixing with the next round', () => {
    expect(afterLaneRunFailure(0, 'gate')).toEqual({ kind: 'enter', to: 'fixing', nextRound: 1 });
    expect(afterLaneRunFailure(1, 'code-review')).toEqual({ kind: 'enter', to: 'fixing', nextRound: 2 });
    expect(afterLaneRunFailure(1, 'ci')).toEqual({ kind: 'enter', to: 'fixing', nextRound: 2 });
  });

  it('a failure after round 2 parks', () => {
    expect(afterLaneRunFailure(2, 'gate')).toEqual({ kind: 'park', reason: 'blocker-after-round-2' });
    expect(afterLaneRunFailure(2, 'brief-check')).toEqual({ kind: 'park', reason: 'blocker-after-round-2' });
    expect(afterLaneRunFailure(2, 'code-review')).toEqual({ kind: 'park', reason: 'blocker-after-round-2' });
    expect(afterLaneRunFailure(2, 'pre-merge')).toEqual({ kind: 'park', reason: 'blocker-after-round-2' });
    expect(afterLaneRunFailure(2, 'ci')).toEqual({ kind: 'park', reason: 'ci-failed-no-rounds' });
    expect(afterLaneRunFailure(3, 'gate')).toEqual({ kind: 'park', reason: 'blocker-after-round-2' });
    expect(afterLaneRunFailure(-1, 'gate')).toEqual({ kind: 'park', reason: 'blocker-after-round-2' });
  });

  it('rounds left holds until round 2', () => {
    expect(laneRunRoundsLeft(0)).toBe(true);
    expect(laneRunRoundsLeft(1)).toBe(true);
    expect(laneRunRoundsLeft(2)).toBe(false);
  });

  it('the implementer role follows state and round', () => {
    expect(implementerRoleFor(0, 'ready')).toBe('first-pass');
    expect(implementerRoleFor(0, 'seat-failed')).toBe('first-pass');
    expect(implementerRoleFor(0, 'fixing')).toBe('fix');
    expect(implementerRoleFor(1, 'seat-failed')).toBe('fix');
  });
});

describe('acceptance and head change', () => {
  it('acceptance exits follow tier and PR presence', () => {
    expect(afterLaneRunAcceptance(2, null)).toBe('awaiting-premerge');
    expect(afterLaneRunAcceptance(2, 7)).toBe('awaiting-premerge');
    expect(afterLaneRunAcceptance(1, null)).toBe('opening-pr');
    expect(afterLaneRunAcceptance(1, 7)).toBe('pushing');
    expect(afterLaneRunPreMergePass(null)).toBe('opening-pr');
    expect(afterLaneRunPreMergePass(7)).toBe('pushing');
  });

  it('head change counts only in the post-acceptance states with two differing heads', () => {
    for (const state of LANE_RUN_HEAD_CHANGE_STATES) {
      expect(laneRunHeadChanged(state, 'a'.repeat(12), 'b'.repeat(12))).toBe(true);
      expect(laneRunHeadChanged(state, 'a'.repeat(12), 'a'.repeat(12))).toBe(false);
      expect(laneRunHeadChanged(state, null, 'b'.repeat(12))).toBe(false);
      expect(laneRunHeadChanged(state, 'a'.repeat(12), null)).toBe(false);
    }
    expect(laneRunHeadChanged('accepting', 'a'.repeat(12), 'b'.repeat(12))).toBe(false);
    expect(laneRunHeadChanged('gating', 'a'.repeat(12), 'b'.repeat(12))).toBe(false);
  });

  it('head change needs two 12-hex lowercase heads, never any two different strings', () => {
    const [state] = LANE_RUN_HEAD_CHANGE_STATES;
    expect(laneRunHeadChanged(state, 'not-a-head!!', 'also-bad!!!!')).toBe(false);
    expect(laneRunHeadChanged(state, 'abc', 'abcdef123456')).toBe(false);
    expect(laneRunHeadChanged(state, 'ABCDEF123456', 'abcdef123456')).toBe(false);
    expect(laneRunHeadChanged(state, 'abcdef1234567', 'abcdef123456')).toBe(false);
    expect(laneRunHeadChanged(state, 123456789012 as unknown as string, 'abcdef123456')).toBe(false);
    expect(laneRunHeadChanged(state, 'abcdef123456', '0123456789ab')).toBe(true);
  });
});

describe('run-stop mapping', () => {
  const UNCONFIRMED = {
    run: 'parked',
    reason: 'stop-unconfirmed',
    qualifier: null,
    capacity: 'held',
    attention: 'stop-unconfirmed',
    retryStop: true,
  };

  it('terminated releases capacity only when the result confirms it', () => {
    expect(laneRunStopEffect({ outcome: 'terminated', capacityReleased: true })).toEqual({
      run: 'stopped', capacity: 'released', attention: null,
    });
    expect(laneRunStopEffect({ outcome: 'terminated', capacityReleased: false })).toEqual({
      run: 'stopped', capacity: 'held', attention: 'slot-held',
    });
  });

  it('cancelled releases capacity only when the result confirms it', () => {
    expect(laneRunStopEffect({ outcome: 'cancelled', capacityReleased: true })).toEqual({
      run: 'stopped', capacity: 'released', attention: null,
    });
    expect(laneRunStopEffect({ outcome: 'cancelled', capacityReleased: false })).toEqual({
      run: 'stopped', capacity: 'held', attention: 'slot-held',
    });
  });

  it('still-running and unknown park as stop-unconfirmed', () => {
    expect(laneRunStopEffect({ outcome: 'still-running' })).toEqual(UNCONFIRMED);
    expect(laneRunStopEffect({ outcome: 'unknown' })).toEqual(UNCONFIRMED);
  });

  it('refused parks as stop-refused with the refusal kind', () => {
    expect(laneRunStopEffect({ outcome: 'refused', refusal: 'runner-refused' })).toEqual({
      run: 'parked',
      reason: 'stop-refused',
      qualifier: 'runner-refused',
      capacity: 'held',
      attention: 'stop-refused',
      retryStop: false,
    });
  });

  it('malformed outcomes read as the unknown effect and never echo input', () => {
    expect(laneRunStopEffect(null)).toEqual(UNCONFIRMED);
    expect(laneRunStopEffect({ outcome: 'terminated' })).toEqual(UNCONFIRMED);
    const malformed = laneRunStopEffect({ outcome: 'refused', refusal: 'XYZZY' });
    expect(malformed).toEqual(UNCONFIRMED);
    expect(JSON.stringify(malformed)).not.toContain('XYZZY');
  });
});

describe('resume refusals', () => {
  it('refuses a stopped run even with a matching revision and a park', () => {
    const rec = record({ parked: PARKED_UNCONFIRMED, parkCount: 1 });
    expect(
      checkLaneRunResume({ record: rec, state: 'stopped', stopMode: null, expectedRevision: rec.revision }),
    ).toEqual({ ok: false, reason: 'run-stopped' });
  });

  it('refuses a stale revision', () => {
    const rec = record({});
    expect(
      checkLaneRunResume({ record: rec, state: 'parked', stopMode: null, expectedRevision: rec.revision + 1 }),
    ).toEqual({ ok: false, reason: 'stale-revision' });
  });

  it('refuses a ready run that is not parked', () => {
    const rec = record({});
    expect(
      checkLaneRunResume({ record: rec, state: 'ready', stopMode: null, expectedRevision: rec.revision }),
    ).toEqual({ ok: false, reason: 'not-parked' });
  });

  it('refuses a stop-unconfirmed park', () => {
    const rec = record({ parked: PARKED_UNCONFIRMED, parkCount: 1 });
    expect(
      checkLaneRunResume({ record: rec, state: 'parked', stopMode: null, expectedRevision: rec.revision }),
    ).toEqual({ ok: false, reason: 'stop-pending' });
  });

  it('refuses a fix-no-progress park: a resume would re-collect the same head and park again (KF-21c)', () => {
    const rec = record({
      parked: { reason: 'fix-no-progress', qualifier: null, parkedFrom: 'collecting', questionId: null },
      parkCount: 1,
    });
    expect(
      checkLaneRunResume({ record: rec, state: 'parked', stopMode: null, expectedRevision: rec.revision }),
    ).toEqual({ ok: false, reason: 'fix-no-progress' });
  });

  it('refuses a stop-refused park', () => {
    const rec = record({ parked: PARKED_REFUSED, parkCount: 1 });
    expect(
      checkLaneRunResume({ record: rec, state: 'parked', stopMode: null, expectedRevision: rec.revision }),
    ).toEqual({ ok: false, reason: 'stop-pending' });
  });

  it('refuses a park while a graceful stop is pending', () => {
    const rec = record({ parked: PARKED_BLOCKER, parkCount: 1 });
    expect(
      checkLaneRunResume({ record: rec, state: 'parked', stopMode: 'graceful', expectedRevision: rec.revision }),
    ).toEqual({ ok: false, reason: 'stop-pending' });
  });

  it('refuses a park while a force stop is pending', () => {
    const rec = record({ parked: PARKED_BLOCKER, parkCount: 1 });
    expect(
      checkLaneRunResume({ record: rec, state: 'parked', stopMode: 'force', expectedRevision: rec.revision }),
    ).toEqual({ ok: false, reason: 'stop-pending' });
  });

  it('refuses a running run with a pending stop before not-parked', () => {
    const rec = record({});
    expect(
      checkLaneRunResume({ record: rec, state: 'running', stopMode: 'graceful', expectedRevision: rec.revision }),
    ).toEqual({ ok: false, reason: 'stop-pending' });
  });

  it('refuses a one-way-door park', () => {
    const rec = record({ parked: PARKED_ONE_WAY, parkCount: 1 });
    expect(
      checkLaneRunResume({ record: rec, state: 'parked', stopMode: null, expectedRevision: rec.revision }),
    ).toEqual({ ok: false, reason: 'one-way-door' });
  });

  it('succeeds for a halted park from gating', () => {
    const rec = record({ parked: PARKED_HALTED, parkCount: 1 });
    expect(
      checkLaneRunResume({ record: rec, state: 'parked', stopMode: null, expectedRevision: rec.revision }),
    ).toEqual({ ok: true, to: 'gating' });
  });
});

describe('stop modes', () => {
  it('force wins over graceful, graceful beats null, null stays null', () => {
    expect(strongerStopMode(null, null)).toBe(null);
    expect(strongerStopMode(null, 'graceful')).toBe('graceful');
    expect(strongerStopMode('graceful', null)).toBe('graceful');
    expect(strongerStopMode('graceful', 'graceful')).toBe('graceful');
    expect(strongerStopMode('graceful', 'force')).toBe('force');
    expect(strongerStopMode('force', 'graceful')).toBe('force');
    expect(strongerStopMode('force', null)).toBe('force');
    expect(strongerStopMode(null, 'force')).toBe('force');
    expect(strongerStopMode('force', 'force')).toBe('force');
  });

  it('an unknown stop mode reads as null', () => {
    expect(strongerStopMode('XYZZY' as never, null)).toBe(null);
  });
});

describe('graceful drain', () => {
  it('continues in dispatching, running and collecting for any gate', () => {
    for (const state of ['dispatching', 'running', 'collecting'] as const) {
      for (const gate of ['none', 'pending', 'passed', 'failed', 'unknown'] as const) {
        expect(laneRunDrainContinues(state, gate)).toBe(true);
      }
    }
  });

  it('gating continues only while the gate is undecided', () => {
    expect(laneRunDrainContinues('gating', 'none')).toBe(true);
    expect(laneRunDrainContinues('gating', 'pending')).toBe(true);
    expect(laneRunDrainContinues('gating', 'passed')).toBe(false);
    expect(laneRunDrainContinues('gating', 'failed')).toBe(false);
    expect(laneRunDrainContinues('gating', 'unknown')).toBe(false);
  });

  it('never continues in any other state or unknown strings', () => {
    const others = LANE_RUN_STATES.filter((state) => !(LANE_RUN_DRAIN_STATES as readonly LaneRunStateValue[]).includes(state));
    for (const state of others) {
      expect(laneRunDrainContinues(state, 'none')).toBe(false);
    }
    expect(laneRunDrainContinues('nope', 'none')).toBe(false);
  });

  it('drain constants match the plan', () => {
    expect(LANE_RUN_DRAIN_STATES).toEqual(['dispatching', 'running', 'collecting', 'gating']);
    expect(LANE_RUN_DRAIN_STEPS).toEqual(['collect', 'gate']);
  });
});

describe('halt-marker exit', () => {
  it('lifts a halted park with a stop pending', () => {
    const rec = record({ parked: PARKED_HALTED, parkCount: 1 });
    expect(laneRunHaltLiftExit({ record: rec, state: 'parked', halted: false, stopMode: 'graceful' })).toBe('gating');
    expect(laneRunHaltLiftExit({ record: rec, state: 'parked', halted: false, stopMode: 'force' })).toBe('gating');
  });

  it('does not lift while halted or without a stop', () => {
    const rec = record({ parked: PARKED_HALTED, parkCount: 1 });
    expect(laneRunHaltLiftExit({ record: rec, state: 'parked', halted: true, stopMode: 'graceful' })).toBe(null);
    expect(laneRunHaltLiftExit({ record: rec, state: 'parked', halted: false, stopMode: null })).toBe(null);
  });

  it('does not lift a non-halted park or a non-parked state', () => {
    const blocker = record({ parked: PARKED_BLOCKER, parkCount: 1 });
    expect(laneRunHaltLiftExit({ record: blocker, state: 'parked', halted: false, stopMode: 'force' })).toBe(null);
    const running = record({});
    expect(laneRunHaltLiftExit({ record: running, state: 'running', halted: false, stopMode: 'force' })).toBe(null);
  });

  it('is independent of resume for the same graceful record', () => {
    const rec = record({ parked: PARKED_HALTED, parkCount: 1 });
    expect(laneRunHaltLiftExit({ record: rec, state: 'parked', halted: false, stopMode: 'graceful' })).toBe('gating');
    expect(
      checkLaneRunResume({ record: rec, state: 'parked', stopMode: 'graceful', expectedRevision: rec.revision }),
    ).toEqual({ ok: false, reason: 'stop-pending' });
  });
});

describe('work order release at a terminal transition (KF-36a)', () => {
  const ACTIVE = 'ready-to-merge' as const;

  it('a merged run releases a non-terminal work order as merged', () => {
    expect(workOrderReleaseFor({ runEnds: 'merged', workOrderState: ACTIVE, slotHeld: false, otherRunActive: false })).toBe('merged');
  });

  it('a stopped run releases a non-terminal work order as stopped', () => {
    expect(workOrderReleaseFor({ runEnds: 'stopped', workOrderState: ACTIVE, slotHeld: false, otherRunActive: false })).toBe('stopped');
  });

  it('a stopped run with a held slot fails closed (null)', () => {
    expect(workOrderReleaseFor({ runEnds: 'stopped', workOrderState: ACTIVE, slotHeld: true, otherRunActive: false })).toBe(null);
  });

  it('a held slot does NOT block a merged release (the paths are on main)', () => {
    expect(workOrderReleaseFor({ runEnds: 'merged', workOrderState: ACTIVE, slotHeld: true, otherRunActive: false })).toBe('merged');
  });

  it('never overwrites one terminal state with the other', () => {
    expect(workOrderReleaseFor({ runEnds: 'stopped', workOrderState: 'merged', slotHeld: false, otherRunActive: false })).toBe(null);
    expect(workOrderReleaseFor({ runEnds: 'merged', workOrderState: 'stopped', slotHeld: false, otherRunActive: false })).toBe(null);
    expect(workOrderReleaseFor({ runEnds: 'merged', workOrderState: 'merged', slotHeld: false, otherRunActive: false })).toBe(null);
    expect(workOrderReleaseFor({ runEnds: 'stopped', workOrderState: 'stopped', slotHeld: false, otherRunActive: false })).toBe(null);
  });

  it('another non-terminal run on the same work order blocks both ends', () => {
    expect(workOrderReleaseFor({ runEnds: 'merged', workOrderState: ACTIVE, slotHeld: false, otherRunActive: true })).toBe(null);
    expect(workOrderReleaseFor({ runEnds: 'stopped', workOrderState: ACTIVE, slotHeld: false, otherRunActive: true })).toBe(null);
  });
});
