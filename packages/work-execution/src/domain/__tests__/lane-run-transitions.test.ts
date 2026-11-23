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
  LANE_RUN_REVIEWS_IN_FLIGHT,
  afterLaneRunAcceptance,
  afterLaneRunFailure,
  afterLaneRunPreMergePass,
  canEnterLaneRunState,
  checkLaneRunResume,
  checkParkEscalation,
  implementerRoleFor,
  laneRunBranchBehindExit,
  laneRunDrainContinues,
  laneRunHaltLiftExit,
  laneRunHeadChanged,
  laneRunMergeHold,
  laneRunRoundsLeft,
  laneRunStopEffect,
  strongerStopMode,
  workOrderReleaseFor,
} from '../lane-run-transitions.js';
import {
  DEFAULT_PREMERGE_MODE,
  effectivePremergeHold,
  normalizePremergeMode,
  PREMERGE_MODES,
} from '../lane-run-transitions.js';
import { PARK_ESCALATION_HISTORY_MAX } from '../park-escalation.js';

const PARKED_FIX_NO_PROGRESS = {
  reason: 'fix-no-progress',
  qualifier: null,
  parkedFrom: 'collecting',
  questionId: null,
};

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
  ready: ['dispatching', 'collecting'],
  dispatching: ['running', 'seat-failed'],
  running: ['collecting', 'seat-failed'],
  'seat-failed': ['dispatching'],
  collecting: ['gating', 'seat-failed'],
  gating: ['brief-check', 'fixing'],
  'brief-check': ['code-review', 'fixing'],
  'code-review': ['accepting', 'fixing'],
  fixing: ['dispatching'],
  accepting: ['awaiting-premerge', 'opening-pr', 'pushing', 'fixing'],
  'awaiting-premerge': ['opening-pr', 'pushing', 'fixing', 'gating', 'merged'],
  'opening-pr': ['watching-ci', 'gating'],
  pushing: ['watching-ci', 'gating'],
  'watching-ci': ['merging', 'fixing', 'gating', 'merged'],
  merging: ['merged', 'fixing', 'watching-ci', 'gating'],
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
  'awaiting-premerge': 'collecting',
  'opening-pr': 'merging',
  pushing: 'merging',
  'watching-ci': 'pushing',
  merging: 'running',
  merged: 'gating',
  stopped: 'gating',
  parked: 'gating',
};

describe('LaneRun exits', () => {
  it.each(LANE_RUN_STATES)('%s exits match the table and each listed exit is legal', (state) => {
    expect(LANE_RUN_EXITS[state]).toEqual(EXPECTED_EXITS[state]);
    for (const exit of LANE_RUN_EXITS[state]) {
      // `ready → collecting` is the adopted run's entry only (CO28); every other exit needs no provenance.
      expect(canEnterLaneRunState(state, exit, null, false, 'adopted')).toBe(true);
      if (!(state === 'ready' && exit === 'collecting')) {
        expect(canEnterLaneRunState(state, exit)).toBe(true);
      }
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

  it('a settled open-pr park may enter watching-ci (R4a)', () => {
    expect(canEnterLaneRunState('parked', 'watching-ci', 'opening-pr', true)).toBe(true);
    expect(canEnterLaneRunState('parked', 'watching-ci', 'opening-pr')).toBe(false);
    expect(canEnterLaneRunState('parked', 'gating', 'opening-pr', true)).toBe(false);
    expect(canEnterLaneRunState('parked', 'opening-pr', 'opening-pr', true)).toBe(true);
    expect(canEnterLaneRunState('parked', 'merged', 'opening-pr')).toBe(true);
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

describe('speed-plan rows (KS1: D19, D20, D22, D24)', () => {
  it('merging row: a pre-merge finding enters fixing and a forge branch update enters watching-ci', () => {
    expect(LANE_RUN_EXITS.merging).toEqual(['merged', 'fixing', 'watching-ci', 'gating']);
    expect(canEnterLaneRunState('merging', 'fixing')).toBe(true);
    expect(canEnterLaneRunState('merging', 'watching-ci')).toBe(true);
    expect(canEnterLaneRunState('merging', 'parked')).toBe(true);
    expect(canEnterLaneRunState('merging', 'running')).toBe(false);
    expect(canEnterLaneRunState('merging', 'accepting')).toBe(false);
  });

  it('accepting row: with the hold in merging every tier takes the PR exit; the default is unchanged', () => {
    expect(afterLaneRunAcceptance(2, null, 'merging')).toBe('opening-pr');
    expect(afterLaneRunAcceptance(2, 7, 'merging')).toBe('pushing');
    expect(afterLaneRunAcceptance(1, null, 'merging')).toBe('opening-pr');
    expect(afterLaneRunAcceptance(1, 7, 'merging')).toBe('pushing');
    expect(afterLaneRunAcceptance(2, null, 'awaiting-premerge')).toBe('awaiting-premerge');
    expect(afterLaneRunAcceptance(2, 7)).toBe('awaiting-premerge');
    for (const prNumber of [null, 7]) {
      expect(canEnterLaneRunState('accepting', afterLaneRunAcceptance(2, prNumber, 'merging'))).toBe(true);
    }
  });

  it('AR1: the review-blocked acceptance rejection leaves accepting into fixing', () => {
    expect(LANE_RUN_EXITS.accepting).toContain('fixing');
    expect(canEnterLaneRunState('accepting', 'fixing')).toBe(true);
  });

  it('merge hold: Tier 1 is released at once; Tier 2 follows its receipt at the head; unknown tier or receipt parks', () => {
    expect(laneRunMergeHold(1, 'none', 0)).toEqual({ kind: 'released', status: 'success' });
    expect(laneRunMergeHold(2, 'passed', 0)).toEqual({ kind: 'released', status: 'success' });
    expect(laneRunMergeHold(2, 'none', 0)).toEqual({ kind: 'wait', status: 'pending' });
    expect(laneRunMergeHold(2, 'failed', 0)).toEqual({
      kind: 'fail', status: 'failure', outcome: { kind: 'enter', to: 'fixing', nextRound: 1 },
    });
    expect(laneRunMergeHold(2, 'failed', 2)).toEqual({
      kind: 'fail', status: 'failure', outcome: { kind: 'park', reason: 'blocker-after-round-2' },
    });
    const ambiguous = { kind: 'park', status: null, reason: 'ambiguous', qualifier: 'pre-merge' };
    expect(laneRunMergeHold(2, 'unknown', 0)).toEqual(ambiguous);
    expect(laneRunMergeHold(2, 'XYZZY' as never, 0)).toEqual(ambiguous);
    expect(laneRunMergeHold('XYZZY' as never, 'passed', 0)).toEqual(ambiguous);
    expect(laneRunMergeHold(1, 'failed', 0)).toEqual({ kind: 'released', status: 'success' });
    // The hold's fix round is a legal exit of the merging row.
    const failed = laneRunMergeHold(2, 'failed', 1);
    if (failed.kind !== 'fail' || failed.outcome.kind !== 'enter') {
      throw new Error('expected a fix round');
    }
    expect(canEnterLaneRunState('merging', failed.outcome.to)).toBe(true);
  });

  describe('normalizePremergeMode and effectivePremergeHold (AP1)', () => {
    it('the mode literals and the default are the fail-closed set', () => {
      expect(PREMERGE_MODES).toEqual(['human-gate', 'auto-attest']);
      expect(DEFAULT_PREMERGE_MODE).toBe('human-gate');
    });

    it('normalizePremergeMode: only the exact literal auto-attest enables attestation; everything else fails closed', () => {
      expect(normalizePremergeMode('auto-attest')).toBe('auto-attest');
      for (const hostile of [
        'human-gate',
        undefined,
        null,
        '',
        'AUTO-ATTEST',
        'auto',
        true,
        false,
        0,
        1,
        {},
        [],
        ['auto-attest'],
        { mode: 'auto-attest' },
      ]) {
        expect(normalizePremergeMode(hostile)).toBe('human-gate');
      }
      expect(normalizePremergeMode('x'.repeat(100_000))).toBe('human-gate');
    });

    it('effectivePremergeHold: Tier 2 released stays released only under auto-attest, else downgrades to wait', () => {
      const released = { kind: 'released', status: 'success' } as const;
      expect(effectivePremergeHold(released, 2, 'auto-attest')).toEqual(released);
      expect(effectivePremergeHold(released, 2, 'human-gate')).toEqual({ kind: 'wait', status: 'pending' });
      expect(effectivePremergeHold(released, 2, undefined)).toEqual({ kind: 'wait', status: 'pending' });
      expect(effectivePremergeHold(released, 2, 'invalid')).toEqual({ kind: 'wait', status: 'pending' });
      expect(effectivePremergeHold(released, 2)).toEqual({ kind: 'wait', status: 'pending' });
    });

    it('effectivePremergeHold: Tier 1 released is unaffected by the mode in both directions', () => {
      const released = { kind: 'released', status: 'success' } as const;
      expect(effectivePremergeHold(released, 1, 'human-gate')).toEqual(released);
      expect(effectivePremergeHold(released, 1, 'auto-attest')).toEqual(released);
      expect(effectivePremergeHold(released, 1, undefined)).toEqual(released);
    });

    it('effectivePremergeHold: fail and park holds pass through unchanged in both modes', () => {
      const fail = {
        kind: 'fail', status: 'failure', outcome: { kind: 'enter', to: 'fixing', nextRound: 2 },
      } as const;
      const park = { kind: 'park', status: null, reason: 'ambiguous', qualifier: 'pre-merge' } as const;
      for (const mode of ['human-gate', 'auto-attest', undefined] as const) {
        expect(effectivePremergeHold(fail, 2, mode)).toEqual(fail);
        expect(effectivePremergeHold(park, 2, mode)).toEqual(park);
      }
    });
  });

  it('branch-behind exit: a queue never parks; strict updates the branch or parks on an overlap', () => {
    expect(laneRunBranchBehindExit({ mergePath: 'queue', branchBehind: true, overlapOnMain: true })).toEqual({ kind: 'proceed' });
    expect(laneRunBranchBehindExit({ mergePath: 'strict', branchBehind: true, overlapOnMain: false }))
      .toEqual({ kind: 'update-branch', to: 'watching-ci' });
    expect(laneRunBranchBehindExit({ mergePath: 'strict', branchBehind: true, overlapOnMain: true }))
      .toEqual({ kind: 'park', reason: 'branch-behind' });
    expect(laneRunBranchBehindExit({ mergePath: 'strict', branchBehind: false, overlapOnMain: true }))
      .toEqual({ kind: 'park', reason: 'branch-behind' });
    expect(laneRunBranchBehindExit({ mergePath: 'strict', branchBehind: false, overlapOnMain: false })).toEqual({ kind: 'proceed' });
    expect(laneRunBranchBehindExit({ mergePath: 'XYZZY' as never, branchBehind: true, overlapOnMain: false }))
      .toEqual({ kind: 'update-branch', to: 'watching-ci' });
    expect(canEnterLaneRunState('merging', 'watching-ci')).toBe(true);
  });

  it('gating row: reviews in flight are the two review steps, and a graceful drain never starts one', () => {
    expect(LANE_RUN_REVIEWS_IN_FLIGHT).toEqual({ from: 'gating', steps: ['brief-check', 'code-review'] });
    expect(LANE_RUN_EXITS.gating).toEqual(['brief-check', 'fixing']);
    for (const step of LANE_RUN_REVIEWS_IN_FLIGHT.steps) {
      expect(LANE_RUN_DRAIN_STEPS).not.toContain(step);
    }
  });
});

describe('park escalation (CE1)', () => {
  const DIRTY = { trackedFilesChanged: 2 };

  it('an escalated park may enter fixing while a plain park may not', () => {
    expect(canEnterLaneRunState('parked', 'fixing', 'collecting')).toBe(false);
    expect(canEnterLaneRunState('parked', 'fixing', null, false, undefined, true)).toBe(true);
    // The exception opens nothing else and nothing from a non-parked state.
    expect(canEnterLaneRunState('parked', 'gating', null, false, undefined, true)).toBe(false);
    expect(canEnterLaneRunState('gating', 'fixing', null, false, undefined, true)).toBe(true);
    expect(canEnterLaneRunState('merged', 'fixing', null, false, undefined, true)).toBe(false);
  });

  it('escalates a fix-no-progress park with a dirty worktree and a clean history', () => {
    const rec = record({ parked: PARKED_FIX_NO_PROGRESS, parkCount: 1 });
    expect(
      checkParkEscalation({
        record: rec, state: 'parked', stopMode: null, expectedRevision: rec.revision, history: [], dirtyWorktree: DIRTY,
      }),
    ).toEqual({ ok: true, to: 'fixing', mode: 'commit-pending', journalReasonCode: 'park-escalated', journalDetail: 'commit-pending' });
  });

  it('returns malformed-input for hostile or malformed transition inputs', () => {
    const rec = record({ parked: PARKED_FIX_NO_PROGRESS, parkCount: 1 });
    const base: Record<string, unknown> = {
      record: rec, state: 'parked', stopMode: null, expectedRevision: rec.revision, history: [], dirtyWorktree: DIRTY,
    };
    // a missing required key and an extra key are refused
    const withoutHistory = { ...base } as Record<string, unknown>;
    delete withoutHistory.history;
    expect(checkParkEscalation(withoutHistory as never)).toEqual({ ok: false, reason: 'malformed-input' });
    expect(checkParkEscalation({ ...base, extra: 1 } as never)).toEqual({ ok: false, reason: 'malformed-input' });
    // non-plain record / bad revision / unknown state
    expect(checkParkEscalation({ ...base, record: [] } as never)).toEqual({ ok: false, reason: 'malformed-input' });
    expect(checkParkEscalation({ ...base, record: Object.create(null) } as never)).toEqual({ ok: false, reason: 'malformed-input' });
    expect(checkParkEscalation({ ...base, record: { ...rec, revision: 1.5 } } as never)).toEqual({ ok: false, reason: 'malformed-input' });
    expect(checkParkEscalation({ ...base, record: { ...rec, revision: '1' } } as never)).toEqual({ ok: false, reason: 'malformed-input' });
    expect(checkParkEscalation({ ...base, state: 'XYZZY' } as never)).toEqual({ ok: false, reason: 'malformed-input' });
    expect(checkParkEscalation({ ...base, state: 7 } as never)).toEqual({ ok: false, reason: 'malformed-input' });

    // a throwing getter on the record's revision is refused, never thrown
    const throwingRecord: Record<string, unknown> = { ...rec };
    Object.defineProperty(throwingRecord, 'revision', { enumerable: true, get() { throw new Error('boom'); } });
    expect(checkParkEscalation({ ...base, record: throwingRecord } as never)).toEqual({ ok: false, reason: 'malformed-input' });

    // a Proxy with a non-plain prototype on the input is refused via the shared reader
    const traps: string[] = [];
    expect(
      checkParkEscalation(new Proxy(base, {
        getPrototypeOf() { traps.push('getPrototypeOf'); return Array.prototype; },
        get(t, k) { traps.push('get'); return Reflect.get(t, k); },
      }) as never),
    ).toEqual({ ok: false, reason: 'malformed-input' });
    expect(traps).toEqual(['getPrototypeOf']);
  });

  it('refuses stopped run with run-stopped before revision or park checks', () => {
    const rec = record({ parked: PARKED_FIX_NO_PROGRESS, parkCount: 1 });
    // Even a stale revision and a dirty worktree lose to run-stopped.
    expect(
      checkParkEscalation({
        record: rec, state: 'stopped', stopMode: 'force', expectedRevision: rec.revision + 5, history: [], dirtyWorktree: DIRTY,
      }),
    ).toEqual({ ok: false, reason: 'run-stopped' });
  });

  it('refuses mismatched expectedRevision with stale-revision', () => {
    const rec = record({ parked: PARKED_FIX_NO_PROGRESS, parkCount: 1 });
    expect(
      checkParkEscalation({
        record: rec, state: 'parked', stopMode: null, expectedRevision: rec.revision + 1, history: [], dirtyWorktree: DIRTY,
      }),
    ).toEqual({ ok: false, reason: 'stale-revision' });
  });

  it('refuses pending stopMode with stop-pending', () => {
    const rec = record({ parked: PARKED_FIX_NO_PROGRESS, parkCount: 1 });
    for (const stopMode of ['graceful', 'force'] as const) {
      expect(
        checkParkEscalation({
          record: rec, state: 'parked', stopMode, expectedRevision: rec.revision, history: [], dirtyWorktree: DIRTY,
        }),
      ).toEqual({ ok: false, reason: 'stop-pending' });
    }
  });

  it('refuses non-parked state or null parked record with not-parked', () => {
    const rec = record({});
    expect(
      checkParkEscalation({
        record: rec, state: 'running', stopMode: null, expectedRevision: rec.revision, history: [], dirtyWorktree: DIRTY,
      }),
    ).toEqual({ ok: false, reason: 'not-parked' });
    expect(
      checkParkEscalation({
        record: rec, state: 'parked', stopMode: null, expectedRevision: rec.revision, history: [], dirtyWorktree: DIRTY,
      }),
    ).toEqual({ ok: false, reason: 'not-parked' });
  });

  it('refuses stop-unconfirmed and stop-refused parks with stop-pending', () => {
    for (const parked of [PARKED_UNCONFIRMED, PARKED_REFUSED]) {
      const rec = record({ parked, parkCount: 1 });
      expect(
        checkParkEscalation({
          record: rec, state: 'parked', stopMode: null, expectedRevision: rec.revision, history: [], dirtyWorktree: DIRTY,
        }),
      ).toEqual({ ok: false, reason: 'stop-pending' });
    }
  });

  it('refuses one-way-door park with one-way-door', () => {
    const rec = record({ parked: PARKED_ONE_WAY, parkCount: 1 });
    expect(
      checkParkEscalation({
        record: rec, state: 'parked', stopMode: null, expectedRevision: rec.revision, history: [], dirtyWorktree: DIRTY,
      }),
    ).toEqual({ ok: false, reason: 'one-way-door' });
  });

  it('propagates decideParkEscalation stay-parked reasons as typed transition refusals', () => {
    // not fix-no-progress
    const blocker = record({ parked: PARKED_BLOCKER, parkCount: 1 });
    expect(
      checkParkEscalation({
        record: blocker, state: 'parked', stopMode: null, expectedRevision: blocker.revision, history: [], dirtyWorktree: DIRTY,
      }),
    ).toEqual({ ok: false, reason: 'park-reason-not-escalatable' });
    // missing fact
    const rec = record({ parked: PARKED_FIX_NO_PROGRESS, parkCount: 1 });
    expect(
      checkParkEscalation({ record: rec, state: 'parked', stopMode: null, expectedRevision: rec.revision, history: [] }),
    ).toEqual({ ok: false, reason: 'missing-dirty-worktree-fact' });
    // clean worktree
    expect(
      checkParkEscalation({
        record: rec, state: 'parked', stopMode: null, expectedRevision: rec.revision, history: [], dirtyWorktree: { trackedFilesChanged: 0 },
      }),
    ).toEqual({ ok: false, reason: 'worktree-clean' });
    // already escalated
    expect(
      checkParkEscalation({
        record: rec, state: 'parked', stopMode: null, expectedRevision: rec.revision,
        history: [{ reasonCode: 'park-escalated', detail: 'commit-pending' }], dirtyWorktree: DIRTY,
      }),
    ).toEqual({ ok: false, reason: 'already-escalated' });
    // malformed history (array holes)
    const sparse: unknown[] = new Array(PARK_ESCALATION_HISTORY_MAX - 1);
    sparse[0] = { reasonCode: 'gate-failed' };
    expect(
      checkParkEscalation({
        record: rec, state: 'parked', stopMode: null, expectedRevision: rec.revision, history: sparse, dirtyWorktree: DIRTY,
      }),
    ).toEqual({ ok: false, reason: 'malformed-history' });
    // history too long
    expect(
      checkParkEscalation({
        record: rec, state: 'parked', stopMode: null, expectedRevision: rec.revision,
        history: new Array(PARK_ESCALATION_HISTORY_MAX + 1).fill({ reasonCode: 'gate-failed' }), dirtyWorktree: DIRTY,
      }),
    ).toEqual({ ok: false, reason: 'history-too-long' });
  });
});
