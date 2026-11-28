import { describe, expect, it } from 'vitest';

import {
  SHADOW_MAIN_RECONCILE_MAX_COMMITS,
  SHADOW_MAIN_RECONCILE_MAX_SHELL_MERGED_SHAS,
  evaluateHandLands,
} from '../shadow-day-main-reconcile.js';

const DAY = '2026-11-10';
const SHA_A = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0';
const SHA_B = 'b0a9f8e7d6c5b4a39281706f5e4d3c2b1a09f8e7';
const SHA_C = 'f0e9d8c7b6a5f4e3d2c1b0a99887766554433221';
const SHA_D = '00112233445566778899aabbccddeeff00112233';

const INVALID_INPUT = { ok: false, reason: 'invalid-input' };
const INVALID_TIMESTAMP = { ok: false, reason: 'invalid-timestamp' };
const INVALID_WINDOW = { ok: false, reason: 'invalid-window' };
const INVALID_SHA = { ok: false, reason: 'invalid-sha' };

function inDayIso(minutes: number): string {
  const hour = String(Math.floor(minutes / 60)).padStart(2, '0');
  const minute = String(minutes % 60).padStart(2, '0');
  return `${DAY}T${hour}:${minute}:00.000Z`;
}

function commit(sha: unknown, minutes: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { sha, committedAtIso: inDayIso(minutes), ...overrides };
}

function input(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    dayStartIso: `${DAY}T00:00:00.000Z`,
    dayEndIso: '2026-11-11T00:00:00.000Z',
    firstParentCommits: [],
    shellMergedShas: [],
    ...overrides,
  };
}

describe('evaluateHandLands', () => {
  it('counts zero hand-lands for an empty firstParentCommits array, the valid zero', () => {
    expect(evaluateHandLands(input({ firstParentCommits: [] }))).toEqual({ ok: true, handLands: 0, handLandShas: [] });
  });

  it('counts zero hand-lands when every in-window commit has a matching shell merged sha', () => {
    const result = evaluateHandLands(
      input({
        firstParentCommits: [commit(SHA_A, 600), commit(SHA_B, 700)],
        shellMergedShas: [SHA_A, SHA_B],
      }),
    );
    expect(result).toEqual({ ok: true, handLands: 0, handLandShas: [] });
  });

  it('counts every hand-land inside [dayStart, dayEnd) with no shell merged match and reports its sha', () => {
    const result = evaluateHandLands(
      input({
        firstParentCommits: [commit(SHA_A, 600), commit(SHA_B, 700)],
        shellMergedShas: [SHA_A],
      }),
    );
    expect(result).toEqual({ ok: true, handLands: 1, handLandShas: [SHA_B] });
  });

  it('excludes a commit at the exact dayEndIso boundary and includes one at the exact dayStartIso boundary', () => {
    const result = evaluateHandLands(
      input({
        firstParentCommits: [
          commit(SHA_A, 0, { committedAtIso: '2026-11-11T00:00:00.000Z' }),
          commit(SHA_B, 0),
          commit(SHA_C, 0, { committedAtIso: '2026-11-11T01:00:00.000Z' }),
        ],
      }),
    );
    // SHA_B sits exactly at dayStart (included, half-open); SHA_A at dayEnd
    // and SHA_C beyond it are excluded, so only SHA_B is a hand-land.
    expect(result).toEqual({ ok: true, handLands: 1, handLandShas: [SHA_B] });
  });

  it('excludes commits outside [dayStart, dayEnd) from the count entirely', () => {
    const result = evaluateHandLands(
      input({
        dayStartIso: `${DAY}T10:00:00.000Z`,
        dayEndIso: `${DAY}T12:00:00.000Z`,
        firstParentCommits: [commit(SHA_A, 9 * 60), commit(SHA_B, 13 * 60), commit(SHA_C, 10 * 60), commit(SHA_D, 12 * 60)],
      }),
    );
    // Only SHA_C at exactly 10:00 (dayStart, included) is in the window;
    // SHA_A before it, SHA_D at exactly dayEnd and SHA_B after are outside.
    expect(result).toEqual({ ok: true, handLands: 1, handLandShas: [SHA_C] });
  });

  it('caps handLandShas at 50 entries while still counting all 55 hand-lands', () => {
    const commits = Array.from({ length: 55 }, (_, index) => {
      const sha = index.toString(16).padStart(2, '0').repeat(20);
      return commit(sha, index + 1);
    });
    const result = evaluateHandLands(input({ firstParentCommits: commits }));
    const expectedShas = Array.from({ length: 50 }, (_, i) => i.toString(16).padStart(2, '0').repeat(20));
    expect(result).toEqual({ ok: true, handLands: 55, handLandShas: expectedShas });
  });

  it('refuses null, undefined, primitive, and non-plain top-level input as invalid-input', () => {
    expect(evaluateHandLands(null)).toEqual(INVALID_INPUT);
    expect(evaluateHandLands(undefined)).toEqual(INVALID_INPUT);
    expect(evaluateHandLands(7)).toEqual(INVALID_INPUT);
    expect(evaluateHandLands('not an object')).toEqual(INVALID_INPUT);
    expect(evaluateHandLands([])).toEqual(INVALID_INPUT);
    expect(evaluateHandLands(new Date())).toEqual(INVALID_INPUT);
    expect(evaluateHandLands(Object.create(null))).toEqual(INVALID_INPUT);
  });

  it('refuses an input or commit record with an own getter without invoking it', () => {
    let inputCalls = 0;
    const getterInput: Record<string, unknown> = {
      dayStartIso: `${DAY}T00:00:00.000Z`,
      dayEndIso: '2026-11-11T00:00:00.000Z',
      firstParentCommits: [],
      shellMergedShas: [],
    };
    Object.defineProperty(getterInput, 'firstParentCommits', {
      enumerable: true,
      get() {
        inputCalls += 1;
        return [];
      },
    });
    expect(evaluateHandLands(getterInput)).toEqual(INVALID_INPUT);
    expect(inputCalls).toBe(0);

    let commitCalls = 0;
    const getterCommit: Record<string, unknown> = commit(SHA_A, 600);
    Object.defineProperty(getterCommit, 'committedAtIso', {
      enumerable: true,
      get() {
        commitCalls += 1;
        return inDayIso(600);
      },
    });
    expect(evaluateHandLands(input({ firstParentCommits: [getterCommit] }))).toEqual(INVALID_INPUT);
    expect(commitCalls).toBe(0);
  });

  it('refuses a revoked Proxy and a throwing-trap Proxy as invalid-input', () => {
    const { revoke, proxy } = Proxy.revocable(input(), {});
    revoke();
    expect(evaluateHandLands(proxy)).toEqual(INVALID_INPUT);

    const throwingTrap = new Proxy(input(), {
      getOwnPropertyDescriptor() {
        throw new Error('trap');
      },
    });
    expect(evaluateHandLands(throwingTrap)).toEqual(INVALID_INPUT);

    // The same two stand-ins on the list arguments and on a commit item.
    const { revoke: revokeList, proxy: proxyList } = Proxy.revocable([commit(SHA_A, 600)], {});
    revokeList();
    expect(evaluateHandLands(input({ firstParentCommits: proxyList }))).toEqual(INVALID_INPUT);
    expect(evaluateHandLands(input({ shellMergedShas: proxyList }))).toEqual(INVALID_INPUT);
    expect(
      evaluateHandLands(
        input({
          firstParentCommits: [
            new Proxy(commit(SHA_A, 600), {
              getOwnPropertyDescriptor() {
                throw new Error('trap');
              },
            }),
          ],
        }),
      ),
    ).toEqual(INVALID_INPUT);
  });

  it('refuses non-array, array-like, sparse hole, and accessor-element lists as invalid-input', () => {
    expect(evaluateHandLands(input({ firstParentCommits: 'nope' }))).toEqual(INVALID_INPUT);
    expect(evaluateHandLands(input({ shellMergedShas: {} }))).toEqual(INVALID_INPUT);
    expect(evaluateHandLands(input({ firstParentCommits: { length: 1, 0: commit(SHA_A, 600) } }))).toEqual(INVALID_INPUT);
    expect(evaluateHandLands(input({ shellMergedShas: { length: 1, 0: SHA_A } }))).toEqual(INVALID_INPUT);

    const holed: Array<unknown> = [commit(SHA_A, 600)];
    holed.length = 3;
    expect(evaluateHandLands(input({ firstParentCommits: holed }))).toEqual(INVALID_INPUT);

    const holedShas: Array<unknown> = [SHA_A];
    holedShas.length = 2;
    expect(evaluateHandLands(input({ shellMergedShas: holedShas }))).toEqual(INVALID_INPUT);

    let calls = 0;
    const accessorList: unknown[] = [];
    Object.defineProperty(accessorList, 0, {
      enumerable: true,
      get() {
        calls += 1;
        return commit(SHA_A, 600);
      },
    });
    accessorList.length = 1;
    expect(evaluateHandLands(input({ firstParentCommits: accessorList }))).toEqual(INVALID_INPUT);
    expect(calls).toBe(0);
  });

  it('refuses prototype-polluting keys, symbol keys, and unexpected keys as invalid-input', () => {
    const polluted: Record<string, unknown> = input();
    Object.defineProperty(polluted, '__proto__', { value: {}, enumerable: true, writable: true, configurable: true });
    expect(evaluateHandLands(polluted)).toEqual(INVALID_INPUT);

    const constructorKeyed: Record<string, unknown> = input();
    Object.defineProperty(constructorKeyed, 'constructor', { value: 1, enumerable: true });
    expect(evaluateHandLands(constructorKeyed)).toEqual(INVALID_INPUT);

    const prototypeKeyed: Record<string, unknown> = input();
    Object.defineProperty(prototypeKeyed, 'prototype', { value: 1, enumerable: true });
    expect(evaluateHandLands(prototypeKeyed)).toEqual(INVALID_INPUT);

    const symbolKeyed = input();
    Object.defineProperty(symbolKeyed, Symbol('extra'), { value: 1, enumerable: true });
    expect(evaluateHandLands(symbolKeyed)).toEqual(INVALID_INPUT);

    const nonEnumerableKeyed = input();
    Object.defineProperty(nonEnumerableKeyed, 'extra', { value: 1, enumerable: false });
    expect(evaluateHandLands(nonEnumerableKeyed)).toEqual(INVALID_INPUT);

    expect(evaluateHandLands(input({ extra: 1 }))).toEqual(INVALID_INPUT);
    expect(evaluateHandLands({ dayStartIso: `${DAY}T00:00:00.000Z`, dayEndIso: `${DAY}T24:00:00.000Z` })).toEqual(INVALID_INPUT);

    const pollutedCommit: Record<string, unknown> = commit(SHA_A, 600);
    Object.defineProperty(pollutedCommit, 'constructor', { value: 1, enumerable: true });
    expect(evaluateHandLands(input({ firstParentCommits: [pollutedCommit] }))).toEqual(INVALID_INPUT);

    expect(evaluateHandLands(input({ firstParentCommits: [{ sha: SHA_A }] }))).toEqual(INVALID_INPUT);
    expect(evaluateHandLands(input({ firstParentCommits: [commit(SHA_A, 600, { extra: 1 })] }))).toEqual(INVALID_INPUT);
  });

  it('refuses an over-cap firstParentCommits array (> 10000) as invalid-input', () => {
    expect(SHADOW_MAIN_RECONCILE_MAX_COMMITS).toBe(10_000);
    expect(evaluateHandLands(input({ firstParentCommits: new Array(SHADOW_MAIN_RECONCILE_MAX_COMMITS + 1).fill(commit(SHA_A, 600)) }))).toEqual(INVALID_INPUT);
  });

  it('refuses an over-cap shellMergedShas array (> 100000) as invalid-input', () => {
    expect(SHADOW_MAIN_RECONCILE_MAX_SHELL_MERGED_SHAS).toBe(100_000);
    expect(evaluateHandLands(input({ shellMergedShas: new Array(SHADOW_MAIN_RECONCILE_MAX_SHELL_MERGED_SHAS + 1).fill(SHA_A) }))).toEqual(INVALID_INPUT);
  });

  it('refuses malformed or unzoned timestamps on dayStartIso, dayEndIso, or committedAtIso as invalid-timestamp', () => {
    expect(evaluateHandLands(input({ dayStartIso: 7 }))).toEqual(INVALID_TIMESTAMP);
    expect(evaluateHandLands(input({ dayEndIso: 'not a timestamp' }))).toEqual(INVALID_TIMESTAMP);
    expect(evaluateHandLands(input({ dayStartIso: `${DAY}T00:00:00` }))).toEqual(INVALID_TIMESTAMP);
    expect(evaluateHandLands(input({ dayStartIso: '2026-02-30T00:00:00Z' }))).toEqual(INVALID_TIMESTAMP);
    expect(evaluateHandLands(input({ dayEndIso: `${DAY}T25:00:00.000Z` }))).toEqual(INVALID_TIMESTAMP);
    expect(
      evaluateHandLands(
        input({ firstParentCommits: [commit(SHA_A, 600, { committedAtIso: `${DAY}T10:00:00` })] }),
      ),
    ).toEqual(INVALID_TIMESTAMP);
    expect(
      evaluateHandLands(input({ firstParentCommits: [commit(SHA_A, 600, { committedAtIso: '2026-02-30T00:00:00Z' })] })),
    ).toEqual(INVALID_TIMESTAMP);
  });

  it('refuses an inverted window or a window longer than 24 hours as invalid-window', () => {
    expect(
      evaluateHandLands(input({ dayStartIso: `${DAY}T12:00:00.000Z`, dayEndIso: `${DAY}T12:00:00.000Z` })),
    ).toEqual(INVALID_WINDOW);
    expect(
      evaluateHandLands(input({ dayStartIso: `${DAY}T12:00:00.000Z`, dayEndIso: `${DAY}T11:00:00.000Z` })),
    ).toEqual(INVALID_WINDOW);
    // 24h + 1ms: past the cap.
    expect(
      evaluateHandLands(input({ dayStartIso: `${DAY}T00:00:00.000Z`, dayEndIso: '2026-11-11T00:00:00.001Z' })),
    ).toEqual(INVALID_WINDOW);
    // The reviewer's case: a 25-hour window could pull a commit at 00:30Z on
    // Nov 11 into the Nov 10 count, so it is refused outright.
    expect(
      evaluateHandLands(input({ dayStartIso: `${DAY}T00:00:00.000Z`, dayEndIso: '2026-11-11T01:00:00.000Z' })),
    ).toEqual(INVALID_WINDOW);
    // Exactly one UTC day is the accepted maximum.
    expect(
      evaluateHandLands(input({ dayStartIso: `${DAY}T00:00:00.000Z`, dayEndIso: '2026-11-11T00:00:00.000Z' })),
    ).toEqual({ ok: true, handLands: 0, handLandShas: [] });
  });

  it('refuses non-40-hex, uppercase, or non-string shas in commits or shellMergedShas as invalid-sha', () => {
    expect(evaluateHandLands(input({ shellMergedShas: ['nothex'] }))).toEqual(INVALID_SHA);
    expect(evaluateHandLands(input({ shellMergedShas: [SHA_A.toUpperCase()] }))).toEqual(INVALID_SHA);
    expect(evaluateHandLands(input({ shellMergedShas: [7] }))).toEqual(INVALID_SHA);
    expect(evaluateHandLands(input({ shellMergedShas: [SHA_A.slice(1)] }))).toEqual(INVALID_SHA);
    expect(evaluateHandLands(input({ firstParentCommits: [commit('nothex', 600)] }))).toEqual(INVALID_SHA);
    expect(evaluateHandLands(input({ firstParentCommits: [commit(SHA_A.toUpperCase(), 600)] }))).toEqual(INVALID_SHA);
    expect(evaluateHandLands(input({ firstParentCommits: [commit(null, 600)] }))).toEqual(INVALID_SHA);
  });

  it('returns frozen evaluation objects, so callers cannot mutate a result', () => {
    const result = evaluateHandLands(input({ firstParentCommits: [commit(SHA_A, 600)] }));
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen((result as { handLandShas: readonly string[] }).handLandShas)).toBe(true);
    expect(Object.isFrozen(evaluateHandLands(null))).toBe(true);
  });
});
