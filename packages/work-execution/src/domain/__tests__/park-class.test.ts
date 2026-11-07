// PT1a: the park class, computed when a park is raised and stored on the park record.
import { describe, expect, it } from 'vitest';

import { LaneRun } from '../entities/LaneRun.js';
import { classifyPark, isOwnedPath, parkClassOf, parseParkClass, LANE_RUN_PARK_CLASSES } from '../park-class.js';

/** Shapes copied from `.fleet/state/lane-runs.json`: ids, codes and owned-path shapes only. */
const OWNED = [
  'packages/work-execution/src/domain/park-class.ts',
  'packages/work-execution/src/application/use-cases/advance-lane-run',
  'apps/cli/src/conductor.ts',
];

const BASE_RUN = {
  version: 1,
  runId: 'run-01M63WPH4GMF2CA3NQ7JAM4HS1',
  workOrderId: 'wo-fleet-v2-sr1c-dedupe-2026-10-29',
  tier: 2,
  seatPlanRef: 'a'.repeat(64),
  cursors: { 'first-pass': 0, fix: null, review: null },
  round: 0,
  attemptIds: ['attempt-01M64PT1PX2MAZVQDYAYMZ7WNB'],
  prNumber: null,
  parkCount: 1,
  lease: null,
  revision: 3,
  runPolicyRevision: 'policy:conductor@7844746b0277',
  schemaVersion: 1,
};

describe('classifyPark (PT1a)', () => {
  it('transport-busy: the review seat was unavailable, or a review step is ambiguous', () => {
    expect(classifyPark({ reason: 'review-seat-unavailable', qualifier: null, parkedFrom: 'code-review' })).toBe('transport-busy');
    expect(classifyPark({ reason: 'ambiguous', qualifier: 'code-review', parkedFrom: 'code-review' })).toBe('transport-busy');
    expect(classifyPark({ reason: 'ambiguous', qualifier: 'brief-check', parkedFrom: 'brief-check' })).toBe('transport-busy');
  });

  it('minor-only-fail: every unresolved finding is minor or nit', () => {
    expect(
      classifyPark({
        reason: 'blocker-after-round-2',
        qualifier: null,
        parkedFrom: 'code-review',
        findingSeverities: ['minor', 'nit', 'minor'],
      }),
    ).toBe('minor-only-fail');
  });

  it('gate-outside-owned: the failing gate file is outside the work order owned paths', () => {
    const input = {
      reason: 'blocker-after-round-2' as const,
      qualifier: null,
      parkedFrom: 'gating' as const,
      ownedPaths: OWNED,
    };
    expect(classifyPark({ ...input, gateFailingFile: 'packages/evidence-and-acceptance/src/domain/failing-file.ts' })).toBe(
      'gate-outside-owned',
    );
    // Inside the owned paths (a file, a directory prefix): not gate-outside-owned.
    expect(classifyPark({ ...input, gateFailingFile: 'apps/cli/src/conductor.ts' })).toBe('other');
    expect(
      classifyPark({ ...input, gateFailingFile: 'packages/work-execution/src/application/use-cases/advance-lane-run/step-context.ts' }),
    ).toBe('other');
    // A prefix that is not a path boundary is outside.
    expect(classifyPark({ ...input, gateFailingFile: 'apps/cli/src/conductor.tsx' })).toBe('gate-outside-owned');
  });

  it('blocker: a blocker or major finding is unresolved after round 2', () => {
    expect(
      classifyPark({
        reason: 'blocker-after-round-2',
        qualifier: null,
        parkedFrom: 'code-review',
        findingSeverities: ['minor', 'major'],
      }),
    ).toBe('blocker');
    expect(
      classifyPark({
        reason: 'acceptance-rejected',
        qualifier: null,
        parkedFrom: 'accepting',
        findingSeverities: ['blocker'],
      }),
    ).toBe('blocker');
  });

  it('step-refused: only a refused prepare or dispatch step', () => {
    expect(classifyPark({ reason: 'step-refused', qualifier: 'prepare', parkedFrom: 'fixing' })).toBe('step-refused');
    expect(classifyPark({ reason: 'step-refused', qualifier: 'dispatch', parkedFrom: 'ready' })).toBe('step-refused');
    expect(classifyPark({ reason: 'step-refused', qualifier: 'merge-enqueue', parkedFrom: 'merging' })).toBe('other');
  });

  it('other: anything unrecognised or unknown stays other, never a guess', () => {
    expect(classifyPark({ reason: 'halted', qualifier: null, parkedFrom: 'ready' })).toBe('other');
    expect(classifyPark({ reason: 'owner-merge', qualifier: null, parkedFrom: 'merging' })).toBe('other');
    // A blocker park whose findings were unread, and a gate park with no failing file or no owned paths.
    expect(classifyPark({ reason: 'blocker-after-round-2', qualifier: null, parkedFrom: 'code-review', findingSeverities: null })).toBe('other');
    expect(
      classifyPark({ reason: 'blocker-after-round-2', qualifier: null, parkedFrom: 'gating', gateFailingFile: null, ownedPaths: OWNED }),
    ).toBe('other');
    expect(
      classifyPark({ reason: 'blocker-after-round-2', qualifier: null, parkedFrom: 'gating', gateFailingFile: 'a/b.ts', ownedPaths: null }),
    ).toBe('other');
    expect(classifyPark({ reason: 'not-a-reason', qualifier: null, parkedFrom: 'ready' })).toBe('other');
  });

  it('never throws on a hostile input', () => {
    const hostile = {
      get reason(): string {
        throw new Error('boom');
      },
    } as unknown as Parameters<typeof classifyPark>[0];
    expect(classifyPark(hostile)).toBe('other');
  });
});

describe('park class on the record (PT1a)', () => {
  it('parseParkClass accepts exactly the declared classes', () => {
    for (const parkClass of LANE_RUN_PARK_CLASSES) {
      expect(parseParkClass(parkClass)).toBe(parkClass);
    }
    for (const value of ['', 'Blocker', 'unknown', 7, null, undefined, {}]) {
      expect(parseParkClass(value)).toBeUndefined();
    }
  });

  it('an old park record without class loads and reads as other', () => {
    const old = { reason: 'step-refused', qualifier: 'prepare', parkedFrom: 'fixing', questionId: null };
    const loaded = LaneRun.create({ ...BASE_RUN, parked: old });
    expect(loaded.success).toBe(true);
    if (!loaded.success) {
      return;
    }
    const parked = loaded.value.toRecord().parked;
    expect(parked).not.toBeNull();
    expect(parked !== null && 'class' in parked).toBe(false);
    expect(parkClassOf(parked)).toBe('other');
  });

  it('a stored class round-trips, and an undeclared class is refused', () => {
    const parked = { reason: 'step-refused', qualifier: 'prepare', parkedFrom: 'fixing', questionId: null, class: 'step-refused' };
    const loaded = LaneRun.create({ ...BASE_RUN, parked });
    expect(loaded.success).toBe(true);
    if (loaded.success) {
      expect(parkClassOf(loaded.value.toRecord().parked)).toBe('step-refused');
    }
    const bad = LaneRun.create({ ...BASE_RUN, parked: { ...parked, class: 'whatever' } });
    expect(bad.success).toBe(false);
  });

  it('parkClassOf reads only an own data property of a record, never a getter', () => {
    expect(parkClassOf(null)).toBe('other');
    expect(parkClassOf(undefined)).toBe('other');
    expect(parkClassOf({ class: 'blocker' })).toBe('blocker');
    expect(parkClassOf({ class: 'nope' })).toBe('other');
    const getter = {
      get class(): string {
        throw new Error('boom');
      },
    };
    expect(parkClassOf(getter)).toBe('other');
  });
});

describe('isOwnedPath (PT1a)', () => {
  it('matches a file or a directory prefix at a path boundary, with or without a trailing slash', () => {
    expect(isOwnedPath('a/b/c.ts', ['a/b/c.ts'])).toBe(true);
    expect(isOwnedPath('a/b/c.ts', ['a/b'])).toBe(true);
    expect(isOwnedPath('a/b/c.ts', ['a/b/'])).toBe(true);
    expect(isOwnedPath('a/bc/c.ts', ['a/b'])).toBe(false);
    expect(isOwnedPath('a/b/c.ts', [''])).toBe(false);
    expect(isOwnedPath('a/b/c.ts', [])).toBe(false);
  });
});
