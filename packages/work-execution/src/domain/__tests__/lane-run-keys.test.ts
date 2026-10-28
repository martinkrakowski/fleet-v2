import { describe, expect, it } from 'vitest';

import {
  buildLaneRunStepKey,
  head12Of,
  laneRunResumeKey,
  laneRunStopForceKey,
  laneRunStopKey,
  parseLaneRunKey,
  reaperRepairKey,
  REAPER_FINDING_KINDS,
  requestKey,
  stopModeOfKey,
} from '../lane-run-keys.js';
import type { LaneRunKeyVia, LaneRunStepKeyParts, ReaperFindingKind } from '../lane-run-keys.js';
import {
  LANE_RUN_KEY_ATTEMPT_RULE,
  LANE_RUN_KEY_HEAD_RULE,
  LANE_RUN_KEY_STEPS,
} from '../lane-run-records.js';

/**
 * Secret-shaped fakes are assembled at runtime from inert pieces so this file
 * never contains a credential-shaped literal; the scanner still recognises the
 * shape, which is the point under test.
 */
function fakeSecretShape(): string {
  return `gh${'p_'}${'A'.repeat(30)}`;
}

const RUN_ID = 'run-01JB0000000000000000000000';
const HEAD12 = '0123456789ab';

const BASE_PARTS: LaneRunStepKeyParts = {
  runId: RUN_ID,
  round: 1,
  step: 'gate',
  seatIndex: 0,
  attemptOrdinal: null,
  head12: HEAD12,
  retry: null,
};

describe('key builders', () => {
  it('builds and parses the plan examples', () => {
    const dispatch = buildLaneRunStepKey({
      runId: RUN_ID, round: 0, step: 'dispatch', seatIndex: 0, attemptOrdinal: 1, head12: null, retry: null,
    });
    expect(dispatch).toEqual({ ok: true, key: `${RUN_ID}/r0/dispatch/0/a1` });
    expect(parseLaneRunKey(`${RUN_ID}/r0/dispatch/0/a1`)).toEqual({
      kind: 'step', runId: RUN_ID, round: 0, step: 'dispatch', seatIndex: 0, attemptOrdinal: 1, head12: null, retry: null,
    });

    const review = buildLaneRunStepKey({
      runId: RUN_ID, round: 1, step: 'code-review', seatIndex: 2, attemptOrdinal: null, head12: HEAD12, retry: null,
    });
    expect(review).toEqual({ ok: true, key: `${RUN_ID}/r1/code-review/2@0123456789ab` });
    expect(parseLaneRunKey(`${RUN_ID}/r1/code-review/2@0123456789ab`)).toEqual({
      kind: 'step', runId: RUN_ID, round: 1, step: 'code-review', seatIndex: 2, attemptOrdinal: null, head12: HEAD12, retry: null,
    });

    const parts: LaneRunStepKeyParts = {
      runId: RUN_ID, round: 1, step: 'code-review', seatIndex: 2, attemptOrdinal: null, head12: HEAD12, retry: 1,
    };
    const built = buildLaneRunStepKey(parts);
    expect(built).toEqual({ ok: true, key: `${RUN_ID}/r1/code-review/2@0123456789ab/retry1` });

    // Round-trip verification: parse the built retry key back to its parts,
    // check them, and rebuild the identical key.
    if (!built.ok) throw new Error('unreachable: retry key must build');
    const parsed = parseLaneRunKey(built.key);
    expect(parsed).toEqual(expect.objectContaining({
      kind: 'step',
      runId: RUN_ID,
      round: 1,
      step: 'code-review',
      seatIndex: 2,
      attemptOrdinal: null,
      head12: HEAD12,
      retry: 1,
    }));

    if (parsed === null || parsed.kind !== 'step') throw new Error('unreachable: parsed step key');
    const rebuilt = buildLaneRunStepKey(parsed);
    expect(rebuilt).toEqual(built);

    expect(laneRunStopKey(RUN_ID)).toEqual({ ok: true, key: `${RUN_ID}/stop@web` });
    expect(parseLaneRunKey(`${RUN_ID}/stop@web`)).toEqual({
      kind: 'stop', runId: RUN_ID, via: 'web', mode: 'graceful',
    });

    expect(laneRunResumeKey(RUN_ID, 3)).toEqual({ ok: true, key: `${RUN_ID}/park/3/resume@web` });
    expect(parseLaneRunKey(`${RUN_ID}/park/3/resume@web`)).toEqual({
      kind: 'resume', runId: RUN_ID, parkOrdinal: 3, via: 'web',
    });

    expect(laneRunResumeKey(RUN_ID, 3, 'cli')).toEqual({ ok: true, key: `${RUN_ID}/park/3/resume@cli` });
    expect(parseLaneRunKey(`${RUN_ID}/park/3/resume@cli`)).toEqual({
      kind: 'resume', runId: RUN_ID, parkOrdinal: 3, via: 'cli',
    });

    expect(requestKey('01JB0000000000000000000000')).toEqual({ ok: true, key: 'request/01JB0000000000000000000000' });
    expect(parseLaneRunKey('request/01JB0000000000000000000000')).toEqual({
      kind: 'request', requestId: '01JB0000000000000000000000',
    });
  });

  it('requires attemptOrdinal 1..32 on prepare and dispatch and forbids it elsewhere', () => {
    for (const step of ['prepare', 'dispatch'] as const) {
      for (const attemptOrdinal of [1, 32]) {
        const parts: LaneRunStepKeyParts = {
          runId: RUN_ID,
          round: 0,
          step,
          seatIndex: 0,
          attemptOrdinal,
          head12: null,
          retry: null,
        };
        const built = buildLaneRunStepKey(parts);
        expect(built).toEqual({ ok: true, key: `${RUN_ID}/r0/${step}/0/a${attemptOrdinal}` });
        if (!built.ok) continue;
        const parsed = parseLaneRunKey(built.key);
        expect(parsed).toEqual({ kind: 'step', ...parts });
        if (parsed === null || parsed.kind !== 'step') continue;
        expect(buildLaneRunStepKey(parsed)).toEqual(built);
      }
      for (const bad of [null, 0, 33, 1.5, '1']) {
        const result = buildLaneRunStepKey({
          runId: RUN_ID,
          round: 0,
          step,
          seatIndex: 0,
          attemptOrdinal: bad as unknown as number,
          head12: null,
          retry: null,
        });
        expect(result.ok).toBe(false);
      }
    }

    for (const step of LANE_RUN_KEY_STEPS) {
      if (step === 'prepare' || step === 'dispatch') continue;
      const head12 = LANE_RUN_KEY_HEAD_RULE[step] === 'required' ? HEAD12 : null;
      const result = buildLaneRunStepKey({
        runId: RUN_ID,
        round: 1,
        step,
        seatIndex: 0,
        attemptOrdinal: 1,
        head12,
        retry: null,
      });
      expect(result).toEqual({
        ok: false,
        error: 'LaneRun key attemptOrdinal does not match its step',
      });
    }

    const first = buildLaneRunStepKey({
      runId: RUN_ID, round: 0, step: 'dispatch', seatIndex: 0, attemptOrdinal: 1, head12: null, retry: null,
    });
    const second = buildLaneRunStepKey({
      runId: RUN_ID, round: 0, step: 'dispatch', seatIndex: 0, attemptOrdinal: 2, head12: null, retry: null,
    });
    expect(first.ok && second.ok && first.key !== second.key).toBe(true);
  });

  it.each(LANE_RUN_KEY_STEPS)('round-trips %s', (step) => {
    const head12 = LANE_RUN_KEY_HEAD_RULE[step] === 'required' ? HEAD12 : null;
    const attemptOrdinal = LANE_RUN_KEY_ATTEMPT_RULE[step] === 'required' ? 1 : null;
    const parts: LaneRunStepKeyParts = {
      runId: RUN_ID,
      round: 1,
      step,
      seatIndex: 2,
      attemptOrdinal,
      head12,
      retry: null,
    };
    const built = buildLaneRunStepKey(parts);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const parsed = parseLaneRunKey(built.key);
    expect(parsed).toEqual({ kind: 'step', ...parts });
    if (parsed === null || parsed.kind !== 'step') return;
    const rebuilt = buildLaneRunStepKey({
      runId: parsed.runId,
      round: parsed.round,
      step: parsed.step,
      seatIndex: parsed.seatIndex,
      attemptOrdinal: parsed.attemptOrdinal,
      head12: parsed.head12,
      retry: parsed.retry,
    });
    expect(rebuilt).toEqual(built);
  });

  const refusalRows: Array<[unknown, string]> = [
    [{ ...BASE_PARTS, runId: 'run-1' }, 'LaneRun key runId must be run- followed by a ULID'],
    [{ ...BASE_PARTS, round: -1 }, 'LaneRun key round must be 0, 1 or 2'],
    [{ ...BASE_PARTS, step: 'XYZZY' }, 'LaneRun key step is not a known step'],
    [{ ...BASE_PARTS, seatIndex: 1000 }, 'LaneRun key seatIndex must be an integer from 0 to 999'],
    [{ ...BASE_PARTS, step: 'dispatch', attemptOrdinal: null, head12: null }, 'LaneRun key attemptOrdinal does not match its step'],
    [{ ...BASE_PARTS, step: 'dispatch', attemptOrdinal: 0, head12: null }, 'LaneRun key attemptOrdinal must be an integer from 1 to 32'],
    [{ ...BASE_PARTS, step: 'dispatch', attemptOrdinal: 33, head12: null }, 'LaneRun key attemptOrdinal must be an integer from 1 to 32'],
    [{ ...BASE_PARTS, step: 'dispatch', attemptOrdinal: 1.5, head12: null }, 'LaneRun key attemptOrdinal must be an integer from 1 to 32'],
    [{ ...BASE_PARTS, step: 'dispatch', attemptOrdinal: '1', head12: null }, 'LaneRun key attemptOrdinal must be an integer from 1 to 32'],
    [{ ...BASE_PARTS, attemptOrdinal: 1 }, 'LaneRun key attemptOrdinal does not match its step'],
    [{ ...BASE_PARTS, head12: 'ABCDEF012345' }, 'LaneRun key head must be 12 lowercase hex characters'],
    [{ ...BASE_PARTS, head12: 123456789012 }, 'LaneRun key head must be 12 lowercase hex characters'],
    [{ ...BASE_PARTS, step: 'dispatch', attemptOrdinal: 1, head12: HEAD12 }, 'LaneRun key head does not match its step'],
    [{ ...BASE_PARTS, step: 'park', head12: HEAD12 }, 'LaneRun key head does not match its step'],
    [{ ...BASE_PARTS, step: 'gate', head12: null }, 'LaneRun key head does not match its step'],
    [{ ...BASE_PARTS, retry: 0 }, 'LaneRun key retry must be an integer from 1 to 9'],
    [{ ...BASE_PARTS, step: 'merge', retry: 1 }, 'LaneRun key retry is not allowed for a one-way step'],
  ];

  it.each(refusalRows)('refuses step parts %j with %s', (parts, message) => {
    const result = buildLaneRunStepKey(parts as LaneRunStepKeyParts);
    expect(result).toEqual({ ok: false, error: message });
  });

  it('returns the invalid result without throwing for non-object input', () => {
    for (const input of [null, undefined, 42, []]) {
      const result = buildLaneRunStepKey(input as unknown as LaneRunStepKeyParts);
      expect(result.ok).toBe(false);
    }
  });

  it('never runs a throwing getter and never throws', () => {
    let getterRan = false;
    const hostile = {};
    Object.defineProperty(hostile, 'runId', {
      get() {
        getterRan = true;
        throw new Error('boom');
      },
      enumerable: true,
      configurable: true,
    });
    const result = buildLaneRunStepKey(hostile as LaneRunStepKeyParts);
    expect(getterRan).toBe(false);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).not.toContain('boom');
  });

  it('never throws when a Proxy get or getOwnPropertyDescriptor trap throws', () => {
    for (const trap of ['get', 'getOwnPropertyDescriptor'] as const) {
      let getTrapRan = false;
      const proxy = new Proxy(
        {},
        {
          [trap]() {
            if (trap === 'get') getTrapRan = true;
            throw new Error('boom');
          },
        },
      );
      const result = buildLaneRunStepKey(proxy as LaneRunStepKeyParts);
      // Values are read through property descriptors only, so a get trap never runs.
      expect(getTrapRan).toBe(false);
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.error).not.toContain('boom');
    }
  });

  it('refuses a bad park ordinal', () => {
    expect(laneRunResumeKey(RUN_ID, 0)).toEqual({
      ok: false,
      error: 'LaneRun key park ordinal must be an integer from 1 to 9999',
    });
  });

  it('refuses a bad request id', () => {
    expect(requestKey('not-a-ulid')).toEqual({ ok: false, error: 'LaneRun key requestId must be a ULID' });
  });

  it('never echoes hostile builder input', () => {
    const badRunId = buildLaneRunStepKey({
      runId: 'run-XYZZY', round: 1, step: 'gate', seatIndex: 0, attemptOrdinal: null, head12: HEAD12, retry: null,
    });
    expect(badRunId.ok).toBe(false);
    if (badRunId.ok) return;
    expect(badRunId.error).not.toContain('XYZZY');

    const badStep = buildLaneRunStepKey({
      ...BASE_PARTS,
      step: 'XYZZY',
    } as unknown as LaneRunStepKeyParts);
    expect(badStep.ok).toBe(false);
    if (badStep.ok) return;
    expect(badStep.error).not.toContain('XYZZY');
  });

  it('builds and parses every stop key with its mode', () => {
    expect(laneRunStopKey(RUN_ID)).toEqual({ ok: true, key: `${RUN_ID}/stop@web` });
    expect(laneRunStopKey(RUN_ID, 'web')).toEqual({ ok: true, key: `${RUN_ID}/stop@web` });
    expect(laneRunStopKey(RUN_ID, 'cli')).toEqual({ ok: true, key: `${RUN_ID}/stop@cli` });
    expect(laneRunStopForceKey(RUN_ID, 'web')).toEqual({ ok: true, key: `${RUN_ID}/stop-force@web` });
    expect(laneRunStopForceKey(RUN_ID, 'cli')).toEqual({ ok: true, key: `${RUN_ID}/stop-force@cli` });

    expect(parseLaneRunKey(`${RUN_ID}/stop@web`)).toEqual({
      kind: 'stop', runId: RUN_ID, via: 'web', mode: 'graceful',
    });
    expect(parseLaneRunKey(`${RUN_ID}/stop@cli`)).toEqual({
      kind: 'stop', runId: RUN_ID, via: 'cli', mode: 'graceful',
    });
    expect(parseLaneRunKey(`${RUN_ID}/stop-force@web`)).toEqual({
      kind: 'stop', runId: RUN_ID, via: 'web', mode: 'force',
    });
    expect(parseLaneRunKey(`${RUN_ID}/stop-force@cli`)).toEqual({
      kind: 'stop', runId: RUN_ID, via: 'cli', mode: 'force',
    });

    for (const key of [
      `${RUN_ID}/stop@web`,
      `${RUN_ID}/stop@cli`,
      `${RUN_ID}/stop-force@web`,
      `${RUN_ID}/stop-force@cli`,
    ]) {
      const parsed = parseLaneRunKey(key);
      if (parsed === null || parsed.kind !== 'stop') throw new Error('unreachable: parsed stop key');
      const rebuilt =
        parsed.mode === 'force'
          ? laneRunStopForceKey(parsed.runId, parsed.via)
          : laneRunStopKey(parsed.runId, parsed.via);
      expect(rebuilt).toEqual({ ok: true, key });
    }

    expect(stopModeOfKey(`${RUN_ID}/stop@web`)).toBe('graceful');
    expect(stopModeOfKey(`${RUN_ID}/stop@cli`)).toBe('graceful');
    expect(stopModeOfKey(`${RUN_ID}/stop-force@web`)).toBe('force');
    expect(stopModeOfKey(`${RUN_ID}/stop-force@cli`)).toBe('force');
    expect(stopModeOfKey(`${RUN_ID}/r1/gate/0@0123456789ab`)).toBeNull();
    expect(stopModeOfKey(`${RUN_ID}/park/1/resume@web`)).toBeNull();
    expect(stopModeOfKey(`${RUN_ID}/park/1/resume@cli`)).toBeNull();
    expect(stopModeOfKey(42)).toBeNull();
    expect(stopModeOfKey('')).toBeNull();
  });

  it('builds and parses reaper keys', () => {
    const attempt = reaperRepairKey('attempt-example-1', 'dead-attempt', '01JB0000000000000000000000');
    expect(attempt).toEqual({ ok: true, key: 'reaper/attempt-example-1/dead-attempt@01JB0000000000000000000000' });
    expect(parseLaneRunKey('reaper/attempt-example-1/dead-attempt@01JB0000000000000000000000')).toEqual({
      kind: 'reaper', subjectId: 'attempt-example-1', findingKind: 'dead-attempt', findingId: '01JB0000000000000000000000',
    });

    const wt = reaperRepairKey('wt-0123456789ab', 'orphan-worktree', '01JB0000000000000000000000');
    expect(wt).toEqual({ ok: true, key: 'reaper/wt-0123456789ab/orphan-worktree@01JB0000000000000000000000' });
    expect(parseLaneRunKey('reaper/wt-0123456789ab/orphan-worktree@01JB0000000000000000000000')).toEqual({
      kind: 'reaper', subjectId: 'wt-0123456789ab', findingKind: 'orphan-worktree', findingId: '01JB0000000000000000000000',
    });

    for (const kind of REAPER_FINDING_KINDS) {
      const built = reaperRepairKey('attempt-example-1', kind, '01JB0000000000000000000000');
      expect(built.ok).toBe(true);
      if (!built.ok) continue;
      const parsed = parseLaneRunKey(built.key);
      expect(parsed).toEqual({
        kind: 'reaper', subjectId: 'attempt-example-1', findingKind: kind, findingId: '01JB0000000000000000000000',
      });
    }
  });

  it('refuses invalid stop via, reaper subjects, kinds and finding ids', () => {
    expect(laneRunStopKey(RUN_ID, 'xyz' as LaneRunKeyVia)).toEqual({
      ok: false,
      error: 'LaneRun key via must be web or cli',
    });
    expect(laneRunStopForceKey(RUN_ID, 'xyz' as LaneRunKeyVia)).toEqual({
      ok: false,
      error: 'LaneRun key via must be web or cli',
    });

    const badSubjects = ['attempt/example', 'attempt@example', 'x'.repeat(129), ''];
    for (const subject of badSubjects) {
      expect(reaperRepairKey(subject, 'dead-attempt', '01JB0000000000000000000000')).toEqual({
        ok: false,
        error: 'LaneRun key reaper subject must be an id without / or @ of at most 128 characters',
      });
    }

    expect(reaperRepairKey(fakeSecretShape(), 'dead-attempt', '01JB0000000000000000000000')).toEqual({
      ok: false,
      error: 'LaneRun key reaper subject contains a secret-shaped value and was refused',
    });

    expect(reaperRepairKey('attempt-example-1', 'zombie' as ReaperFindingKind, '01JB0000000000000000000000')).toEqual({
      ok: false,
      error: 'LaneRun key reaper kind is not a known finding kind',
    });

    expect(reaperRepairKey('attempt-example-1', 'dead-attempt', 'not-a-ulid')).toEqual({
      ok: false,
      error: 'LaneRun key reaper findingId must be a ULID',
    });

    expect(laneRunStopKey(42 as unknown as string)).toEqual({
      ok: false,
      error: 'LaneRun key runId must be run- followed by a ULID',
    });
    expect(reaperRepairKey(42 as unknown as string, 'dead-attempt', '01JB0000000000000000000000').ok).toBe(false);
    expect(reaperRepairKey('attempt-example-1', 'dead-attempt', 42 as unknown as string).ok).toBe(false);
  });

  it('never echoes hostile stop or reaper input', () => {
    const badVia = laneRunStopKey(RUN_ID, 'XYZZY' as LaneRunKeyVia);
    expect(badVia.ok).toBe(false);
    if (badVia.ok) return;
    expect(badVia.error).not.toContain('XYZZY');

    const badSubject = reaperRepairKey('XYZZY/x', 'dead-attempt', '01JB0000000000000000000000');
    expect(badSubject.ok).toBe(false);
    if (badSubject.ok) return;
    expect(badSubject.error).not.toContain('XYZZY');

    const badKind = reaperRepairKey('attempt-example-1', 'XYZZY' as ReaperFindingKind, '01JB0000000000000000000000');
    expect(badKind.ok).toBe(false);
    if (badKind.ok) return;
    expect(badKind.error).not.toContain('XYZZY');
  });

  it('builds, parses and rebuilds reconcile step keys', () => {
    const base: LaneRunStepKeyParts = {
      runId: RUN_ID, round: 1, step: 'reconcile', seatIndex: 0, attemptOrdinal: null, head12: null, retry: null,
    };
    expect(buildLaneRunStepKey(base)).toEqual({ ok: true, key: `${RUN_ID}/r1/reconcile/0` });
    expect(buildLaneRunStepKey({ ...base, retry: 2 })).toEqual({ ok: true, key: `${RUN_ID}/r1/reconcile/0/retry2` });

    expect(parseLaneRunKey(`${RUN_ID}/r1/reconcile/0`)).toEqual({ kind: 'step', ...base });
    expect(parseLaneRunKey(`${RUN_ID}/r1/reconcile/0/retry2`)).toEqual({ kind: 'step', ...base, retry: 2 });

    const built = buildLaneRunStepKey({ ...base, retry: 2 });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const parsed = parseLaneRunKey(built.key);
    if (parsed === null || parsed.kind !== 'step') throw new Error('unreachable: parsed reconcile key');
    expect(buildLaneRunStepKey(parsed)).toEqual(built);

    expect(buildLaneRunStepKey({ ...base, head12: HEAD12 })).toEqual({
      ok: false,
      error: 'LaneRun key head does not match its step',
    });
    expect(buildLaneRunStepKey({ ...base, attemptOrdinal: 1 })).toEqual({
      ok: false,
      error: 'LaneRun key attemptOrdinal does not match its step',
    });
  });
});

describe('parseLaneRunKey', () => {
  it.each([
    '',
    42,
    'x'.repeat(257),
    `${RUN_ID}/r3/gate/0@0123456789ab`,
    `${RUN_ID}/r01/gate/0@0123456789ab`,
    `${RUN_ID}/r1/gate/01@0123456789ab`,
    `${RUN_ID}/r1/gate/0`,
    `${RUN_ID}/r1/gate/0@0123456789AB`,
    `${RUN_ID}/r1/gate/0@0123456789ab@0123456789ab`,
    `${RUN_ID}/r0/dispatch/0`,
    `${RUN_ID}/r0/dispatch/0/a01`,
    `${RUN_ID}/r0/dispatch/0/a0`,
    `${RUN_ID}/r0/dispatch/0/a33`,
    `${RUN_ID}/r1/dispatch/0@0123456789ab`,
    `${RUN_ID}/r1/dispatch/0/a1@0123456789ab`,
    `${RUN_ID}/r1/collect/0/a1`,
    `${RUN_ID}/r1/gate/0@0123456789ab/a1`,
    `${RUN_ID}/r1/park/0@0123456789ab`,
    `${RUN_ID}/r1/merge/0@0123456789ab/retry1`,
    `${RUN_ID}/r1/gate/0@0123456789ab/retry0`,
    `${RUN_ID}/park/0/resume@web`,
    `${RUN_ID}/park/01/resume@web`,
    `${RUN_ID}/park/1/extra/resume@web`,
    `${RUN_ID}/park/1/resume@web/extra`,
    `${RUN_ID}/park/1/resume@api`,
    'request/not-a-ulid',
    'request/01JB0000000000000000000000/x',
    'run-1/r0/dispatch/0',
    'run-1/r0/dispatch/0/a1',
    `${RUN_ID}/r1/gate/0@0123456789ab/`,
    `${RUN_ID}/r1/gate/0 @0123456789ab`,
    `${RUN_ID}/stop-force@xyz`,
    `${RUN_ID}/stop@`,
    `${RUN_ID}/stop-graceful@web`,
    `${RUN_ID}/stop@web@cli`,
    `${RUN_ID}/Stop@web`,
    'reaper/a/b/dead-attempt@01JB0000000000000000000000',
    'reaper/attempt-example-1/zombie@01JB0000000000000000000000',
    'reaper/attempt-example-1/dead-attempt@not-a-ulid',
    'reaper/attempt-example-1/dead-attempt',
    'reaper//dead-attempt@01JB0000000000000000000000',
    'Reaper/attempt-example-1/dead-attempt@01JB0000000000000000000000',
  ])('rejects %j', (key) => {
    expect(parseLaneRunKey(key)).toBeNull();
  });
});

describe('head12Of', () => {
  it('extracts the first 12 hex characters of a commit id', () => {
    expect(head12Of('0123456789abcdef0123456789abcdef01234567')).toBe('0123456789ab');
    expect(head12Of('a'.repeat(64))).toBe('a'.repeat(12));
    expect(head12Of('A'.repeat(40))).toBeNull();
    expect(head12Of('a'.repeat(39))).toBeNull();
    expect(head12Of(null)).toBeNull();
    expect(head12Of(42)).toBeNull();
  });
});
