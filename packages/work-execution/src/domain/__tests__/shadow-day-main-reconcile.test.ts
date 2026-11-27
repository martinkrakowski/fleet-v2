import { describe, expect, it } from 'vitest';

import {
  evaluateHandLands,
  SHADOW_MAIN_RECONCILE_MAX_COMMITS,
  SHADOW_MAIN_RECONCILE_MAX_REPORTED_SHAS,
  SHADOW_MAIN_RECONCILE_MAX_SHELL_MERGED_SHAS,
} from '../shadow-day-main-reconcile.js';

const SHA_A = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0';
const SHA_B = 'b0a9f8e7d6c5b4a39281706f5e4d3c2b1a09f8e7';
const SHA_C = 'f0e9d8c7b6a5f4e3d2c1b0a99887766554433221';
const DAY_START = '2026-11-26T00:00:00.000Z';
const DAY_END = '2026-11-27T00:00:00.000Z';

function commitIso(hour: number, minute = 0): string {
  return `2026-11-26T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00.000Z`;
}

function commit(sha: string, committedAtIso: string): Record<string, unknown> {
  return { sha, committedAtIso };
}

function dayInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    dayStartIso: DAY_START,
    dayEndIso: DAY_END,
    firstParentCommits: [],
    shellMergedShas: [],
    ...overrides,
  };
}

const OK = (handLands: number, handLandShas: readonly string[]) => ({ ok: true, handLands, handLandShas: [...handLandShas] });
const REFUSED = (reason: string) => ({ ok: false, reason });

describe('evaluateHandLands (SR4 hand-land break count)', () => {
  it('returns a valid zero for an empty real firstParentCommits array', () => {
    expect(evaluateHandLands(dayInput())).toEqual(OK(0, []));
  });

  it('counts hand-lands as commits inside [dayStart, dayEnd) whose sha has no shell merged event', () => {
    const input = dayInput({
      firstParentCommits: [commit(SHA_A, commitIso(10)), commit(SHA_B, commitIso(23, 59))],
      shellMergedShas: [SHA_B],
    });
    expect(evaluateHandLands(input)).toEqual(OK(1, [SHA_A]));
  });

  it('counts the exact dayStartIso boundary as inside the window and the exact dayEndIso boundary as outside', () => {
    const input = dayInput({
      firstParentCommits: [commit(SHA_A, DAY_START), commit(SHA_B, DAY_END), commit(SHA_C, DAY_END)],
    });
    expect(evaluateHandLands(input)).toEqual(OK(1, [SHA_A]));
  });

  it('reports at most 50 hand-land shas while still counting every hand-land', () => {
    const commits: Record<string, unknown>[] = [];
    const shas: string[] = [];
    for (let index = 0; index < 55; index += 1) {
      const sha = String(index).padStart(40, 'c');
      shas.push(sha);
      commits.push(commit(sha, commitIso(12)));
    }
    const evaluation = evaluateHandLands(dayInput({ firstParentCommits: commits }));
    expect(evaluation).toEqual({ ...OK(55, shas.slice(0, SHADOW_MAIN_RECONCILE_MAX_REPORTED_SHAS)) });
  });

  it('refuses null, undefined, primitive, and non-plain top-level input as invalid-input', () => {
    for (const input of [null, undefined, 7, 'x', true, [], () => {}]) {
      expect(evaluateHandLands(input)).toEqual(REFUSED('invalid-input'));
    }
  });

  it('refuses an input or commit record with an own getter without invoking it', () => {
    let inputCalls = 0;
    const getterInput: Record<string, unknown> = { ...dayInput() };
    Object.defineProperty(getterInput, 'firstParentCommits', {
      enumerable: true,
      get() {
        inputCalls += 1;
        return [];
      },
    });
    expect(evaluateHandLands(getterInput)).toEqual(REFUSED('invalid-input'));
    expect(inputCalls).toBe(0);

    let commitCalls = 0;
    const accessorCommit: Record<string, unknown> = {};
    Object.defineProperty(accessorCommit, 'sha', {
      enumerable: true,
      get() {
        commitCalls += 1;
        return SHA_A;
      },
    });
    accessorCommit.committedAtIso = commitIso(10);
    const commitList = [accessorCommit];
    const commitInput = dayInput({ firstParentCommits: commitList });
    expect(evaluateHandLands(commitInput)).toEqual(REFUSED('invalid-input'));
    expect(commitCalls).toBe(0);
  });

  it('refuses an accessor with an undefined getter and no setter on dayStartIso as invalid-input, not invalid-timestamp', () => {
    // A degenerate accessor (both accessors present but `undefined`, no
    // `value` field) must be refused at the snapshot, before any timestamp
    // check sees a copied `undefined` and misclassifies it.
    const accessorInput: Record<string, unknown> = {};
    Object.defineProperty(accessorInput, 'dayStartIso', { enumerable: true, get: undefined, configurable: true });
    accessorInput.dayEndIso = DAY_END;
    accessorInput.firstParentCommits = [];
    accessorInput.shellMergedShas = [];
    expect(evaluateHandLands(accessorInput)).toEqual(REFUSED('invalid-input'));

    // The same degenerate accessor on a commit record's `sha` is also
    // `invalid-input`, not `invalid-sha`.
    const accessorCommit: Record<string, unknown> = {};
    Object.defineProperty(accessorCommit, 'sha', { enumerable: true, get: undefined, configurable: true });
    accessorCommit.committedAtIso = commitIso(10);
    expect(evaluateHandLands(dayInput({ firstParentCommits: [accessorCommit] }))).toEqual(REFUSED('invalid-input'));

    // A Proxy descriptor trap reporting the same degenerate accessor is
    // refused too, and no `get` trap is ever consulted for the value.
    const proxied = new Proxy(dayInput() as Record<string, unknown>, {
      getOwnPropertyDescriptor(target, key) {
        if (key === 'dayEndIso') {
          return { enumerable: true, configurable: true, get: undefined, set: undefined };
        }
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    });
    expect(evaluateHandLands(proxied)).toEqual(REFUSED('invalid-input'));
  });

  it('refuses a revoked Proxy and a throwing-trap Proxy as invalid-input', () => {
    const revoked = Proxy.revocable(dayInput(), {});
    revoked.revoke();
    expect(evaluateHandLands(revoked.proxy)).toEqual(REFUSED('invalid-input'));

    const throwing = new Proxy(dayInput(), {
      ownKeys() {
        throw new Error('trap');
      },
    });
    expect(evaluateHandLands(throwing)).toEqual(REFUSED('invalid-input'));

    const throwingList = Proxy.revocable([commit(SHA_A, commitIso(10))], {});
    throwingList.revoke();
    const onList = dayInput({ firstParentCommits: throwingList.proxy });
    expect(evaluateHandLands(onList)).toEqual(REFUSED('invalid-input'));

    const throwingShell = new Proxy([SHA_A], {
      getOwnPropertyDescriptor() {
        throw new Error('trap');
      },
    });
    const onShell = dayInput({ shellMergedShas: throwingShell });
    expect(evaluateHandLands(onShell)).toEqual(REFUSED('invalid-input'));

    const throwingItem = [new Proxy(commit(SHA_A, commitIso(10)), {
      ownKeys() {
        throw new Error('trap');
      },
    })];
    const onItem = dayInput({ firstParentCommits: throwingItem });
    expect(evaluateHandLands(onItem)).toEqual(REFUSED('invalid-input'));
  });

  it('refuses non-array, array-like, sparse hole, and accessor-element lists as invalid-input', () => {
    expect(evaluateHandLands(dayInput({ firstParentCommits: 'nope' }))).toEqual(REFUSED('invalid-input'));
    expect(evaluateHandLands(dayInput({ shellMergedShas: { length: 1, 0: SHA_A } }))).toEqual(REFUSED('invalid-input'));

    const holey = new Array(3);
    holey[2] = SHA_A;
    expect(evaluateHandLands(dayInput({ shellMergedShas: holey }))).toEqual(REFUSED('invalid-input'));

    const accessorList: unknown[] = [];
    Object.defineProperty(accessorList, 0, {
      enumerable: true,
      get() {
        return commit(SHA_A, commitIso(10));
      },
    });
    accessorList.length = 1;
    expect(evaluateHandLands(dayInput({ firstParentCommits: accessorList }))).toEqual(REFUSED('invalid-input'));
  });

  it('refuses prototype-polluting keys, symbol keys, and unexpected keys as invalid-input', () => {
    const proto = dayInput();
    Object.defineProperty(proto, '__proto__', { enumerable: true, value: {} });
    expect(evaluateHandLands(proto)).toEqual(REFUSED('invalid-input'));

    const ctor = dayInput();
    Object.defineProperty(ctor, 'constructor', { enumerable: true, value: Object });
    expect(evaluateHandLands(ctor)).toEqual(REFUSED('invalid-input'));

    const prototypeKey = dayInput();
    Object.defineProperty(prototypeKey, 'prototype', { enumerable: true, value: {} });
    expect(evaluateHandLands(prototypeKey)).toEqual(REFUSED('invalid-input'));

    const symbolKey = dayInput();
    Object.defineProperty(symbolKey, Symbol('extra'), { value: 1, enumerable: true });
    expect(evaluateHandLands(symbolKey)).toEqual(REFUSED('invalid-input'));

    const hidden = dayInput();
    Object.defineProperty(hidden, 'extra', { value: 1, enumerable: false });
    expect(evaluateHandLands(hidden)).toEqual(REFUSED('invalid-input'));

    const extra = dayInput({ extra: 1 });
    expect(evaluateHandLands(extra)).toEqual(REFUSED('invalid-input'));

    const missing = dayInput();
    delete missing.dayEndIso;
    expect(evaluateHandLands(missing)).toEqual(REFUSED('invalid-input'));

    const commitCtor = commit(SHA_A, commitIso(10));
    Object.defineProperty(commitCtor, 'prototype', { enumerable: true, value: {} });
    expect(evaluateHandLands(dayInput({ firstParentCommits: [commitCtor] }))).toEqual(REFUSED('invalid-input'));
  });

  it('refuses an over-cap firstParentCommits array (> 10000) as invalid-input', () => {
    const huge = new Array(SHADOW_MAIN_RECONCILE_MAX_COMMITS + 1);
    huge.fill(commit(SHA_A, commitIso(10)));
    expect(evaluateHandLands(dayInput({ firstParentCommits: huge }))).toEqual(REFUSED('invalid-input'));

    const enormous: unknown[] = [];
    Object.defineProperty(enormous, 'length', { value: 2 ** 32 - 1 });
    expect(evaluateHandLands(dayInput({ firstParentCommits: enormous }))).toEqual(REFUSED('invalid-input'));
  });

  it('refuses an over-cap shellMergedShas array (> 100000) as invalid-input', () => {
    const shas: string[] = new Array(SHADOW_MAIN_RECONCILE_MAX_SHELL_MERGED_SHAS + 1).fill(SHA_A);
    expect(evaluateHandLands(dayInput({ shellMergedShas: shas }))).toEqual(REFUSED('invalid-input'));
  });

  it('refuses malformed or unzoned timestamps on dayStartIso, dayEndIso, or committedAtIso as invalid-timestamp', () => {
    const missingZone = dayInput({ dayStartIso: '2026-11-26T00:00:00' });
    expect(evaluateHandLands(missingZone)).toEqual(REFUSED('invalid-timestamp'));

    const notString = dayInput({ dayEndIso: 1234 });
    expect(evaluateHandLands(notString)).toEqual(REFUSED('invalid-timestamp'));

    const impossible = dayInput({ dayStartIso: '2026-02-30T00:00:00.000Z' });
    expect(evaluateHandLands(impossible)).toEqual(REFUSED('invalid-timestamp'));

    const badCommit = dayInput({ firstParentCommits: [commit(SHA_A, 'nope')] });
    expect(evaluateHandLands(badCommit)).toEqual(REFUSED('invalid-timestamp'));

    const unzonedCommit = dayInput({ firstParentCommits: [commit(SHA_A, '2026-11-26T10:00:00')] });
    expect(evaluateHandLands(unzonedCommit)).toEqual(REFUSED('invalid-timestamp'));
  });

  it('refuses an inverted window or a window longer than 25 hours as invalid-window', () => {
    const inverted = dayInput({ dayStartIso: DAY_END, dayEndIso: DAY_START });
    expect(evaluateHandLands(inverted)).toEqual(REFUSED('invalid-window'));

    const same = dayInput({ dayEndIso: DAY_START });
    expect(evaluateHandLands(same)).toEqual(REFUSED('invalid-window'));

    const tooLong = dayInput({ dayEndIso: '2026-11-28T02:00:00.000Z' });
    expect(evaluateHandLands(tooLong)).toEqual(REFUSED('invalid-window'));
  });

  it('refuses non-40-hex, uppercase, or non-string shas in commits or shellMergedShas as invalid-sha', () => {
    const shortCommit = dayInput({ firstParentCommits: [commit('abc', commitIso(10))] });
    expect(evaluateHandLands(shortCommit)).toEqual(REFUSED('invalid-sha'));

    const upperCommit = dayInput({ firstParentCommits: [commit(SHA_A.toUpperCase(), commitIso(10))] });
    expect(evaluateHandLands(upperCommit)).toEqual(REFUSED('invalid-sha'));

    const numberCommit = dayInput({ firstParentCommits: [{ sha: 40, committedAtIso: commitIso(10) }] });
    expect(evaluateHandLands(numberCommit)).toEqual(REFUSED('invalid-sha'));

    const upperShell = dayInput({ shellMergedShas: [SHA_B.toUpperCase()] });
    expect(evaluateHandLands(upperShell)).toEqual(REFUSED('invalid-sha'));

    const numberShell = dayInput({ shellMergedShas: [42] });
    expect(evaluateHandLands(numberShell)).toEqual(REFUSED('invalid-sha'));
  });
});
