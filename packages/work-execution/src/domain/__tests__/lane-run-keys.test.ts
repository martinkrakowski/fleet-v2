import { describe, expect, it } from 'vitest';

import {
  buildLaneRunStepKey,
  head12Of,
  laneRunResumeKey,
  laneRunStopKey,
  parseLaneRunKey,
  requestKey,
} from '../lane-run-keys.js';
import type { LaneRunStepKeyParts } from '../lane-run-keys.js';
import { LANE_RUN_KEY_HEAD_RULE, LANE_RUN_KEY_STEPS } from '../lane-run-records.js';

const RUN_ID = 'run-01JB0000000000000000000000';
const HEAD12 = '0123456789ab';

const BASE_PARTS = {
  runId: RUN_ID,
  round: 1,
  step: 'gate',
  seatIndex: 0,
  head12: HEAD12,
  retry: null,
};

describe('key builders', () => {
  it('builds and parses the plan examples', () => {
    const dispatch = buildLaneRunStepKey({
      runId: RUN_ID, round: 0, step: 'dispatch', seatIndex: 0, head12: null, retry: null,
    });
    expect(dispatch).toEqual({ ok: true, key: `${RUN_ID}/r0/dispatch/0` });
    expect(parseLaneRunKey(`${RUN_ID}/r0/dispatch/0`)).toEqual({
      kind: 'step', runId: RUN_ID, round: 0, step: 'dispatch', seatIndex: 0, head12: null, retry: null,
    });

    const review = buildLaneRunStepKey({
      runId: RUN_ID, round: 1, step: 'code-review', seatIndex: 2, head12: HEAD12, retry: null,
    });
    expect(review).toEqual({ ok: true, key: `${RUN_ID}/r1/code-review/2@0123456789ab` });
    expect(parseLaneRunKey(`${RUN_ID}/r1/code-review/2@0123456789ab`)).toEqual({
      kind: 'step', runId: RUN_ID, round: 1, step: 'code-review', seatIndex: 2, head12: HEAD12, retry: null,
    });

    const parts: LaneRunStepKeyParts = {
      runId: RUN_ID, round: 1, step: 'code-review', seatIndex: 2, head12: HEAD12, retry: 1,
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
      head12: HEAD12,
      retry: 1,
    }));

    if (parsed === null || parsed.kind !== 'step') throw new Error('unreachable: parsed step key');
    const rebuilt = buildLaneRunStepKey(parsed);
    expect(rebuilt).toEqual(built);

    expect(laneRunStopKey(RUN_ID)).toEqual({ ok: true, key: `${RUN_ID}/stop@web` });
    expect(parseLaneRunKey(`${RUN_ID}/stop@web`)).toEqual({ kind: 'stop', runId: RUN_ID, via: 'web' });

    expect(laneRunResumeKey(RUN_ID, 3)).toEqual({ ok: true, key: `${RUN_ID}/park/3/resume@web` });
    expect(parseLaneRunKey(`${RUN_ID}/park/3/resume@web`)).toEqual({
      kind: 'resume', runId: RUN_ID, parkOrdinal: 3, via: 'web',
    });

    expect(requestKey('01JB0000000000000000000000')).toEqual({ ok: true, key: 'request/01JB0000000000000000000000' });
    expect(parseLaneRunKey('request/01JB0000000000000000000000')).toEqual({
      kind: 'request', requestId: '01JB0000000000000000000000',
    });
  });

  it.each(LANE_RUN_KEY_STEPS)('round-trips %s', (step) => {
    let heads: (string | null)[];
    const rule = LANE_RUN_KEY_HEAD_RULE[step];
    if (rule === 'optional') {
      heads = [null, HEAD12];
    } else if (rule === 'required') {
      heads = [HEAD12];
    } else {
      heads = [null];
    }
    for (const head12 of heads) {
      const parts = { runId: RUN_ID, round: 1, step, seatIndex: 2, head12, retry: null };
      const built = buildLaneRunStepKey(parts);
      expect(built.ok).toBe(true);
      if (!built.ok) continue;
      const parsed = parseLaneRunKey(built.key);
      expect(parsed).toEqual({ kind: 'step', ...parts });
      if (parsed === null || parsed.kind !== 'step') continue;
      const rebuilt = buildLaneRunStepKey({
        runId: parsed.runId,
        round: parsed.round,
        step: parsed.step,
        seatIndex: parsed.seatIndex,
        head12: parsed.head12,
        retry: parsed.retry,
      });
      expect(rebuilt).toEqual(built);
    }
  });

  const refusalRows: Array<[unknown, string]> = [
    [{ ...BASE_PARTS, runId: 'run-1' }, 'LaneRun key runId must be run- followed by a ULID'],
    [{ ...BASE_PARTS, round: -1 }, 'LaneRun key round must be 0, 1 or 2'],
    [{ ...BASE_PARTS, step: 'XYZZY' }, 'LaneRun key step is not a known step'],
    [{ ...BASE_PARTS, seatIndex: 1000 }, 'LaneRun key seatIndex must be an integer from 0 to 999'],
    [{ ...BASE_PARTS, head12: 'ABCDEF012345' }, 'LaneRun key head must be 12 lowercase hex characters'],
    [{ ...BASE_PARTS, step: 'dispatch', head12: HEAD12 }, 'LaneRun key head does not match its step'],
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
      runId: 'run-XYZZY', round: 1, step: 'gate', seatIndex: 0, head12: HEAD12, retry: null,
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
});

describe('parseLaneRunKey', () => {
  it.each([
    '',
    42,
    'x'.repeat(257),
    `${RUN_ID}/r3/gate/0@0123456789ab`,
    `${RUN_ID}/r1/gate/01@0123456789ab`,
    `${RUN_ID}/r1/gate/0`,
    `${RUN_ID}/r1/dispatch/0@0123456789ab`,
    `${RUN_ID}/r1/merge/0@0123456789ab/retry1`,
    `${RUN_ID}/r1/gate/0@0123456789ab/retry0`,
    `${RUN_ID}/stop@cli`,
    `${RUN_ID}/park/0/resume@web`,
    `${RUN_ID}/park/01/resume@web`,
    'request/not-a-ulid',
    'request/01JB0000000000000000000000/x',
    'run-1/r0/dispatch/0',
    `${RUN_ID}/r1/gate/0@0123456789ab/`,
    `${RUN_ID}/r1/gate/0 @0123456789ab`,
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
