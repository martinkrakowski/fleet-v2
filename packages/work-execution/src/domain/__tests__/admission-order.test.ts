/**
 * FC8B tests: the pure fair-admission decider `decideFairAdmission`. Every
 * test title states what its body asserts. Inputs are deep-frozen to prove
 * zero mutation; hostile shapes (null, array-likes, holes, getters, Proxies,
 * enormous lengths, prototype-polluting keys) are refused with typed
 * reasons. All id- and key-shaped strings are built at runtime.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { decideFairAdmission } from '../admission-order.js';

/** A fixed decision instant; never a clock read. */
const NOW_ISO = '2026-11-24T12:00:00Z';

/** Build a zoned ISO timestamp `minutes` after a fixed base instant. */
function isoAt(minutes: number): string {
  const base = Date.UTC(2026, 10, 24, 10, 0, 0);
  return new Date(base + minutes * 60_000).toISOString();
}

/** Recursively freeze every own data property of every nested object or array. */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const key of Object.getOwnPropertyNames(value)) {
      // Only data properties are walked: a hostile getter is never read
      // here, so its refusal stays the decider's job.
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor !== undefined && 'value' in descriptor) {
        deepFreeze(descriptor.value);
      }
    }
    Object.freeze(value);
  }
  return value;
}

/** A waiting run with a runtime-built id and a queued instant. */
function waitingRun(index: number, queuedMinutes: number) {
  return { runId: 'run-' + index.toString(10), queuedAtIso: isoAt(queuedMinutes) };
}

/** One repository queue with runtime-built name. */
function repo(name: string, maxConcurrent: number, running: number, waiting: readonly unknown[]) {
  return { repository: name, maxConcurrent, running, waiting };
}

/** One group with runtime-built id. */
function group(id: string, groupCap: number, running: number, repositories: readonly unknown[]) {
  return { groupId: id, groupCap, running, repositories };
}

interface RawInput {
  groups: unknown;
  lastServedAtIso: Record<string, string | null>;
  freeSlots: number;
  nowIso: string;
}

/** A full input, deep-frozen for the zero-mutation proof. */
function frozenInput(raw: RawInput): unknown {
  return deepFreeze({ ...raw, nowIso: NOW_ISO });
}

describe('FC8B: decideFairAdmission admits fairly across groups', () => {
  it('alternates admissions between two equal groups under six free slots, never twice consecutively from one group', () => {
    const alpha = [0, 1, 2, 3, 4].map((i) => waitingRun(100 + i, i));
    const beta = [0, 1, 2, 3, 4].map((i) => waitingRun(200 + i, i));
    const input = frozenInput({
      groups: [
        group('alpha', 10, 0, [repo('repo-alpha', 10, 0, alpha)]),
        group('beta', 10, 0, [repo('repo-beta', 10, 0, beta)]),
      ],
      lastServedAtIso: {},
      freeSlots: 6,
      nowIso: NOW_ISO,
    });
    const result = decideFairAdmission(input);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.admit).toEqual([
      { runId: 'run-100', groupId: 'alpha', repository: 'repo-alpha' },
      { runId: 'run-200', groupId: 'beta', repository: 'repo-beta' },
      { runId: 'run-101', groupId: 'alpha', repository: 'repo-alpha' },
      { runId: 'run-201', groupId: 'beta', repository: 'repo-beta' },
      { runId: 'run-102', groupId: 'alpha', repository: 'repo-alpha' },
      { runId: 'run-202', groupId: 'beta', repository: 'repo-beta' },
    ]);
    for (let i = 1; i < result.admit.length; i += 1) {
      expect(result.admit[i].groupId).not.toBe(result.admit[i - 1].groupId);
    }
    expect(result.parked).toEqual([
      { runId: 'run-103', reason: 'no-capacity' },
      { runId: 'run-104', reason: 'no-capacity' },
      { runId: 'run-203', reason: 'no-capacity' },
      { runId: 'run-204', reason: 'no-capacity' },
    ]);
  });

  it('orders waiting runs within one repository by oldest queuedAt with runId breaking ties', () => {
    const runs = [waitingRun(3, 20), waitingRun(2, 10), waitingRun(9, 10), waitingRun(1, 30)];
    const input = frozenInput({
      groups: [group('g', 10, 0, [repo('r', 10, 0, runs)])],
      lastServedAtIso: {},
      freeSlots: 3,
      nowIso: NOW_ISO,
    });
    const result = decideFairAdmission(input);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    // Oldest first (minute 10); the tie at minute 10 goes to 'run-2' by
    // code-unit order before 'run-9'.
    expect(result.admit.map((entry) => entry.runId)).toEqual(['run-2', 'run-9', 'run-3']);
  });

  it('serves groups in lastServedAtIso order with null first, then oldest, ties by groupId', () => {
    const input = frozenInput({
      groups: [
        group('g-b', 5, 0, [repo('r-b', 5, 0, [waitingRun(1, 5)])]),
        group('g-a', 5, 0, [repo('r-a', 5, 0, [waitingRun(2, 5)])]),
        group('g-c', 5, 0, [repo('r-c', 5, 0, [waitingRun(3, 5)])]),
      ],
      lastServedAtIso: { 'g-b': isoAt(60), 'g-a': isoAt(30), 'g-c': null },
      freeSlots: 2,
      nowIso: NOW_ISO,
    });
    const result = decideFairAdmission(input);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    // 'g-c' served null comes first, then 'g-a' (served 30 minutes ago),
    // then 'g-b' (served 60 minutes ago) — only two free slots.
    expect(result.admit.map((entry) => entry.groupId)).toEqual(['g-c', 'g-a']);
  });

  it('round-robins repositories within one group by their oldest waiting run', () => {
    const input = frozenInput({
      groups: [
        group('g', 10, 0, [
          repo('r-late', 10, 0, [waitingRun(1, 40)]),
          repo('r-early', 10, 0, [waitingRun(2, 5)]),
        ]),
      ],
      lastServedAtIso: {},
      freeSlots: 2,
      nowIso: NOW_ISO,
    });
    const result = decideFairAdmission(input);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    // 'r-early' holds the oldest run and goes first, then the cursor
    // advances to 'r-late': one admission per repository.
    expect(result.admit.map((entry) => entry.repository)).toEqual(['r-early', 'r-late']);
  });
});

describe('FC8B: decideFairAdmission honours group, repository, and slot caps', () => {
  it('parks every run of a group whose groupCap is exhausted with reason group-cap', () => {
    const input = frozenInput({
      groups: [
        group('full', 2, 2, [repo('r', 10, 0, [waitingRun(1, 5), waitingRun(2, 6)])]),
        group('open', 10, 0, [repo('r2', 10, 0, [waitingRun(3, 7)])]),
      ],
      lastServedAtIso: {},
      freeSlots: 5,
      nowIso: NOW_ISO,
    });
    const result = decideFairAdmission(input);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.admit.map((entry) => entry.groupId)).toEqual(['open']);
    expect(result.parked).toEqual([{ runId: 'run-1', reason: 'group-cap' }, { runId: 'run-2', reason: 'group-cap' }]);
  });

  it('parks every run of a repository whose maxConcurrent is exhausted with reason repository-cap', () => {
    const input = frozenInput({
      groups: [
        group('g', 10, 0, [
          repo('r-full', 1, 1, [waitingRun(1, 5)]),
          repo('r-open', 10, 0, [waitingRun(2, 6)]),
        ]),
      ],
      lastServedAtIso: {},
      freeSlots: 5,
      nowIso: NOW_ISO,
    });
    const result = decideFairAdmission(input);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.admit.map((entry) => entry.repository)).toEqual(['r-open']);
    expect(result.parked).toEqual([{ runId: 'run-1', reason: 'repository-cap' }]);
  });

  it('parks all waiting runs with matching reason when capacity or slots are zero', () => {
    const zeroSlots = decideFairAdmission(
      frozenInput({
        groups: [
          group('g1', 10, 0, [repo('r', 10, 0, [waitingRun(1, 5)])]),
          group('g2', 0, 0, [repo('r2', 10, 0, [waitingRun(2, 6)])]),
        ],
        lastServedAtIso: {},
        freeSlots: 0,
        nowIso: NOW_ISO,
      }),
    );
    expect(zeroSlots).toEqual({
      ok: true,
      admit: [],
      // With no free slots the budget ran out for 'g1', while the zero-cap
      // scope 'g2' still reports its own cap reason.
      parked: [
        { runId: 'run-1', reason: 'no-capacity' },
        { runId: 'run-2', reason: 'group-cap' },
      ],
    });

    const zeroRepo = decideFairAdmission(
      frozenInput({
        groups: [group('g', 10, 0, [repo('r', 0, 0, [waitingRun(1, 5)])])],
        lastServedAtIso: {},
        freeSlots: 3,
        nowIso: NOW_ISO,
      }),
    );
    expect(zeroRepo).toEqual({ ok: true, admit: [], parked: [{ runId: 'run-1', reason: 'repository-cap' }] });
  });

  it('never admits more than freeSlots and never exceeds groupCap or maxConcurrent', () => {
    const input = frozenInput({
      groups: [
        group('g1', 2, 1, [repo('r1', 1, 0, [waitingRun(1, 1), waitingRun(2, 2), waitingRun(3, 3)])]),
        group('g2', 1, 0, [repo('r2', 2, 1, [waitingRun(4, 4), waitingRun(5, 5)])]),
      ],
      lastServedAtIso: {},
      freeSlots: 10,
      nowIso: NOW_ISO,
    });
    const result = decideFairAdmission(input);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.admit.length).toBeLessThanOrEqual(10);
    const g1Admits = result.admit.filter((entry) => entry.groupId === 'g1').length;
    const g2Admits = result.admit.filter((entry) => entry.groupId === 'g2').length;
    expect(g1Admits).toBeLessThanOrEqual(1); // groupCap 2 minus running 1
    expect(g1Admits).toBeLessThanOrEqual(1); // repo r1 maxConcurrent 1
    expect(g2Admits).toBeLessThanOrEqual(1); // groupCap 1
    expect(g1Admits + g2Admits).toBe(2);
  });
});

describe('FC8B: decideFairAdmission is deterministic under input permutation', () => {
  it('yields identical admit and parked lists when groups, repositories, and waiting arrays are shuffled', () => {
    const makeRuns = (offset: number) =>
      [0, 1, 2, 3].map((i) => waitingRun(offset + i, (i * 7) % 4));
    const ordered = frozenInput({
      groups: [
        group('g1', 4, 0, [repo('r1a', 3, 0, makeRuns(10)), repo('r1b', 3, 0, makeRuns(20))]),
        group('g2', 4, 0, [repo('r2a', 3, 0, makeRuns(30))]),
      ],
      lastServedAtIso: { 'g1': isoAt(20), 'g2': isoAt(40) },
      freeSlots: 5,
      nowIso: NOW_ISO,
    });
    const shuffled = frozenInput({
      groups: [
        group('g2', 4, 0, [repo('r2a', 3, 0, [...makeRuns(30)].reverse())]),
        group('g1', 4, 0, [repo('r1b', 3, 0, [...makeRuns(20)].reverse()), repo('r1a', 3, 0, [...makeRuns(10)].reverse())]),
      ],
      lastServedAtIso: { 'g1': isoAt(20), 'g2': isoAt(40) },
      freeSlots: 5,
      nowIso: NOW_ISO,
    });
    const a = decideFairAdmission(ordered);
    const b = decideFairAdmission(shuffled);
    expect(a).toEqual(b);
  });
});

describe('FC8B: the N = 3 fairness proof', () => {
  /** One generated group in the property input. */
  interface GeneratedGroup {
    readonly groupCap: number;
    readonly running: number;
    readonly repos: { readonly maxConcurrent: number; readonly running: number; readonly minutes: number[] }[];
  }

  const generatedInputArb: fc.Arbitrary<{
    readonly groups: readonly GeneratedGroup[];
    readonly served: readonly (number | null)[];
    readonly freeSlots: number;
  }> = fc
    .array(
      // `running` never exceeds its own cap so the cap invariant is exact.
      fc.integer({ min: 0, max: 8 }).chain((groupCap) =>
        fc.record({
          groupCap: fc.constant(groupCap),
          running: fc.integer({ min: 0, max: groupCap }),
          repos: fc.array(
            fc.integer({ min: 0, max: 4 }).chain((maxConcurrent) =>
              fc.record({
                maxConcurrent: fc.constant(maxConcurrent),
                running: fc.integer({ min: 0, max: maxConcurrent }),
                minutes: fc.array(fc.integer({ min: 0, max: 45 }), { minLength: 0, maxLength: 4 }),
              }),
            ),
            { minLength: 1, maxLength: 3 },
          ),
        }),
      ),
      { minLength: 1, maxLength: 4 },
    )
    .chain((groups) =>
      fc.tuple(
        fc.constant(groups),
        fc.array(fc.option(fc.integer({ min: 0, max: 120 }), { nil: null }), {
          minLength: groups.length,
          maxLength: groups.length,
        }),
        fc.integer({ min: 0, max: 12 }),
      ),
    )
    .map(([groups, served, freeSlots]) => ({ groups, served, freeSlots }));

  it('no group receives three consecutive admissions while another group still has an admissible waiting run', () => {
    fc.assert(
      fc.property(generatedInputArb, ({ groups, served, freeSlots }) => {
        // Structured view kept beside the input so the admissibility check
        // needs no casts.
        const structure = groups.map((g, gi) => ({
          groupId: 'g' + gi.toString(10),
          groupCap: g.groupCap,
          running: g.running,
          repos: g.repos.map((r, ri) => ({
            repository: 'r' + ri.toString(10),
            maxConcurrent: r.maxConcurrent,
            running: r.running,
            runIds: r.minutes.map((_, ki) => 'run-' + gi.toString(10) + '-' + ri.toString(10) + '-' + ki.toString(10)),
          })),
        }));
        const input = deepFreeze({
          groups: groups.map((g, gi) => ({
            groupId: 'g' + gi.toString(10),
            groupCap: g.groupCap,
            running: g.running,
            repositories: g.repos.map((r, ri) => ({
              repository: 'r' + ri.toString(10),
              maxConcurrent: r.maxConcurrent,
              running: r.running,
              waiting: r.minutes.map((m, ki) => ({
                runId: 'run-' + gi.toString(10) + '-' + ri.toString(10) + '-' + ki.toString(10),
                queuedAtIso: isoAt(m),
              })),
            })),
          })),
          lastServedAtIso: Object.fromEntries(
            groups.map((_, gi) => [
              'g' + gi.toString(10),
              served[gi] === null ? null : isoAt(served[gi] as number),
            ]),
          ),
          freeSlots,
          nowIso: NOW_ISO,
        });
        const result = decideFairAdmission(input);
        expect(result.ok).toBe(true);
        if (!result.ok) {
          return;
        }
        expect(result.admit.length).toBeLessThanOrEqual(freeSlots);
        const admittedByGroup = new Map<string, number>();
        const admittedByRepo = new Map<string, number>();
        for (const entry of result.admit) {
          admittedByGroup.set(entry.groupId, (admittedByGroup.get(entry.groupId) ?? 0) + 1);
          const repoKey = entry.groupId + '|' + entry.repository;
          admittedByRepo.set(repoKey, (admittedByRepo.get(repoKey) ?? 0) + 1);
        }
        // Caps never exceeded.
        for (const g of structure) {
          expect(g.running + (admittedByGroup.get(g.groupId) ?? 0)).toBeLessThanOrEqual(g.groupCap);
          for (const r of g.repos) {
            expect(r.running + (admittedByRepo.get(g.groupId + '|' + r.repository) ?? 0)).toBeLessThanOrEqual(r.maxConcurrent);
          }
        }
        // N = 3: a run of three consecutive admissions from one group is
        // only allowed when no OTHER group still holds an admissible
        // waiting run (remaining group cap, repo cap, and waiting runs).
        const parkedIds = new Set(result.parked.map((p) => p.runId));
        const otherGroupAdmissible = (groupId: string): boolean => {
          for (const g of structure) {
            if (g.groupId === groupId || g.running + (admittedByGroup.get(g.groupId) ?? 0) >= g.groupCap) {
              continue;
            }
            for (const r of g.repos) {
              if (r.running + (admittedByRepo.get(g.groupId + '|' + r.repository) ?? 0) >= r.maxConcurrent) {
                continue;
              }
              if (r.runIds.some((runId) => parkedIds.has(runId))) {
                return true;
              }
            }
          }
          return false;
        };
        for (let i = 2; i < result.admit.length; i += 1) {
          if (
            result.admit[i].groupId === result.admit[i - 1].groupId &&
            result.admit[i].groupId === result.admit[i - 2].groupId
          ) {
            expect(otherGroupAdmissible(result.admit[i].groupId)).toBe(false);
          }
        }
      }),
      { numRuns: 200 },
    );
  });
});

describe('FC8B: decideFairAdmission refuses hostile inputs with typed reasons', () => {
  it('refuses null and undefined input with invalid-input', () => {
    expect(decideFairAdmission(null)).toEqual({ ok: false, reason: 'invalid-input' });
    expect(decideFairAdmission(undefined)).toEqual({ ok: false, reason: 'invalid-input' });
  });

  it('refuses wrong primitives and wrong top-level shapes with invalid-input', () => {
    expect(decideFairAdmission(7)).toEqual({ ok: false, reason: 'invalid-input' });
    expect(decideFairAdmission('nope')).toEqual({ ok: false, reason: 'invalid-input' });
    expect(decideFairAdmission(true)).toEqual({ ok: false, reason: 'invalid-input' });
    expect(decideFairAdmission([])).toEqual({ ok: false, reason: 'invalid-input' });
    expect(decideFairAdmission({})).toEqual({ ok: false, reason: 'invalid-input' });
    expect(decideFairAdmission({ groups: [], lastServedAtIso: {}, freeSlots: 1 })).toEqual({
      ok: false,
      reason: 'invalid-input',
    });
  });

  it('refuses non-array groups, repositories, waiting, and array-likes with invalid-input', () => {
    const nonArrayGroups = frozenInput({
      groups: { 0: group('g', 1, 0, []), length: 1 },
      lastServedAtIso: {},
      freeSlots: 1,
      nowIso: NOW_ISO,
    });
    expect(decideFairAdmission(nonArrayGroups)).toEqual({ ok: false, reason: 'invalid-input' });

    const setGroups = frozenInput({
      groups: new Set([group('g', 1, 0, [])]),
      lastServedAtIso: {},
      freeSlots: 1,
      nowIso: NOW_ISO,
    });
    expect(decideFairAdmission(setGroups)).toEqual({ ok: false, reason: 'invalid-input' });

    const arrayLikeRepos = frozenInput({
      groups: [group('g', 1, 0, [{ 0: repo('r', 1, 0, []), length: 1 } as unknown])],
      lastServedAtIso: {},
      freeSlots: 1,
      nowIso: NOW_ISO,
    });
    expect(decideFairAdmission(arrayLikeRepos)).toEqual({ ok: false, reason: 'invalid-input' });

    const arrayLikeWaiting = frozenInput({
      groups: [group('g', 1, 0, [repo('r', 1, 0, [{ 0: waitingRun(1, 5), length: 1 } as unknown])])],
      lastServedAtIso: {},
      freeSlots: 1,
      nowIso: NOW_ISO,
    });
    expect(decideFairAdmission(arrayLikeWaiting)).toEqual({ ok: false, reason: 'invalid-input' });
  });

  it('refuses sparse arrays with holes with invalid-input', () => {
    const holeyWaiting: unknown[] = new Array(2);
    holeyWaiting[1] = waitingRun(1, 5);
    const input = frozenInput({
      groups: [group('g', 1, 0, [repo('r', 1, 0, holeyWaiting)])],
      lastServedAtIso: {},
      freeSlots: 1,
      nowIso: NOW_ISO,
    });
    expect(decideFairAdmission(input)).toEqual({ ok: false, reason: 'invalid-input' });

    const holeyGroups: unknown[] = new Array(2);
    holeyGroups[1] = group('g', 1, 0, []);
    expect(
      decideFairAdmission(
        frozenInput({ groups: holeyGroups, lastServedAtIso: {}, freeSlots: 1, nowIso: NOW_ISO }),
      ),
    ).toEqual({ ok: false, reason: 'invalid-input' });
  });

  it('refuses throwing or spy getters without invoking them', () => {
    let calls = 0;
    const spyGetter = (): string => {
      calls += 1;
      return 'stolen';
    };
    const withTopGetter: Record<string, unknown> = {};
    Object.defineProperty(withTopGetter, 'groups', { enumerable: true, get: spyGetter });
    Object.defineProperty(withTopGetter, 'lastServedAtIso', { enumerable: true, value: {} });
    Object.defineProperty(withTopGetter, 'freeSlots', { enumerable: true, value: 1 });
    Object.defineProperty(withTopGetter, 'nowIso', { enumerable: true, value: NOW_ISO });
    expect(decideFairAdmission(withTopGetter)).toEqual({ ok: false, reason: 'invalid-input' });
    expect(calls).toBe(0);

    // A nested getter on a waiting run is equally dead.
    let nestedCalls = 0;
    const run: Record<string, unknown> = {};
    Object.defineProperty(run, 'runId', {
      enumerable: true,
      get: () => {
        nestedCalls += 1;
        throw new Error('never');
      },
    });
    Object.defineProperty(run, 'queuedAtIso', { enumerable: true, value: isoAt(5) });
    const nestedInput = frozenInput({
      groups: [group('g', 1, 0, [repo('r', 1, 0, [run])])],
      lastServedAtIso: {},
      freeSlots: 1,
      nowIso: NOW_ISO,
    });
    expect(decideFairAdmission(nestedInput)).toEqual({ ok: false, reason: 'invalid-input' });
    expect(nestedCalls).toBe(0);
  });

  it('refuses hostile Proxy inputs without invoking get traps', () => {
    let getTraps = 0;
    const target = {
      groups: [group('g', 1, 0, [repo('r', 1, 0, [waitingRun(1, 5)])])],
      lastServedAtIso: {},
      freeSlots: 1,
      nowIso: NOW_ISO,
    };
    const lying = new Proxy(target, {
      get(t, prop, receiver) {
        getTraps += 1;
        return Reflect.get(t, prop, receiver);
      },
      getOwnPropertyDescriptor() {
        throw new Error('trap');
      },
    });
    expect(decideFairAdmission(lying)).toEqual({ ok: false, reason: 'invalid-input' });
    expect(getTraps).toBe(0);

    // A revoked Proxy throws on every operation and must also be refused.
    const { proxy, revoke } = Proxy.revocable(
      { groups: [], lastServedAtIso: {}, freeSlots: 1, nowIso: NOW_ISO },
      {},
    );
    revoke();
    expect(decideFairAdmission(proxy)).toEqual({ ok: false, reason: 'invalid-input' });
  });

  it('refuses single arrays over the cap with invalid-input and totals over the budget with too-large', () => {
    // O(1) length gate: a 10_001-element groups array is refused before any
    // enumeration.
    const overCapGroups: unknown[] = new Array(10_001);
    overCapGroups[0] = group('g', 1, 0, []);
    expect(
      decideFairAdmission(
        frozenInput({ groups: overCapGroups, lastServedAtIso: {}, freeSlots: 1, nowIso: NOW_ISO }),
      ),
    ).toEqual({ ok: false, reason: 'invalid-input' });

    // An enormous length value is refused the same way.
    const hugeWaiting: unknown[] = [];
    Object.defineProperty(hugeWaiting, 'length', { value: 2 ** 32 - 2 });
    expect(
      decideFairAdmission(
        frozenInput({
          groups: [group('g', 1, 0, [repo('r', 1, 0, hugeWaiting)])],
          lastServedAtIso: {},
          freeSlots: 1,
          nowIso: NOW_ISO,
        }),
      ),
    ).toEqual({ ok: false, reason: 'invalid-input' });

    // 11 groups of 1_000 valid waiting runs each: every single array is
    // within its cap, but the total budget is exceeded -> too-large.
    const manyGroups = [];
    for (let gi = 0; gi < 11; gi += 1) {
      const runs = [];
      for (let ri = 0; ri < 1_000; ri += 1) {
        runs.push(waitingRun(gi * 1_000 + ri, ri % 60));
      }
      manyGroups.push(group('g' + gi.toString(10), 5, 0, [repo('r' + gi.toString(10), 5, 0, runs)]));
    }
    expect(
      decideFairAdmission(
        frozenInput({
          groups: manyGroups,
          lastServedAtIso: {},
          freeSlots: 1,
          nowIso: NOW_ISO,
        }),
      ),
    ).toEqual({ ok: false, reason: 'too-large' });
  });

  it('refuses a total over the budget by length pre-gate before copying the counted arrays', () => {
    // The review's exact shape: one group whose repositories array holds
    // 10_000 entries (each within the single-array cap) plus the group itself
    // is a 10_001-element total. The budget is checked against the peeked
    // length before `readBoundedDenseArray` copies any of the 10_000 entries.
    // The proof is a trap counter on a Proxy standing in for the repositories
    // array: the O(1) length peek reads exactly one descriptor, while a copy
    // would enumerate every key and descriptor. `deepFreeze` touches the
    // Proxy while preparing the input; the recorded count must grow by
    // exactly one during the decision itself, never by 10_001.
    const manyRepos = [];
    for (let ri = 0; ri < 10_000; ri += 1) {
      manyRepos.push(repo('r' + ri.toString(10), 1, 0, []));
    }
    let trapCount = 0;
    const { proxy, revoke } = Proxy.revocable(manyRepos, {
      getOwnPropertyDescriptor(t, key) {
        trapCount += 1;
        return Reflect.getOwnPropertyDescriptor(t, key);
      },
      ownKeys(t) {
        trapCount += 1;
        return Reflect.ownKeys(t);
      },
    });
    const input = frozenInput({
      groups: [group('g', 1, 0, proxy)],
      lastServedAtIso: {},
      freeSlots: 1,
      nowIso: NOW_ISO,
    });
    const trapsBeforeDecision = trapCount;
    expect(
      decideFairAdmission(input),
    ).toEqual({ ok: false, reason: 'too-large' });
    // Exactly one descriptor read: the O(1) length peek. No enumeration.
    expect(trapCount - trapsBeforeDecision).toBe(1);
    revoke();
  });

  it('never joins opaque group and repository keys, so distinct pairs cannot collide on a park reason', () => {
    // Old keying joined group + NUL + repository, so the pairs
    // ('a', 'b\u0000c') and ('a\u0000b', 'c') collided onto one key. One slot
    // is free: group 'a' takes it through repo 'b\u0000c'. Group 'a\u0000b' and
    // repo 'c' each have capacity but no slot left, so run-2 must park with
    // 'no-capacity'. With the joined key, repo 'c' reads the other pair's
    // count and wrongly reports 'repository-cap'.
    const nul = '\u0000';
    const result = decideFairAdmission(
      frozenInput({
        groups: [
          group('a', 2, 0, [repo('b' + nul + 'c', 1, 0, [waitingRun(1, 0)])]),
          group('a' + nul + 'b', 2, 0, [repo('c', 1, 0, [waitingRun(2, 1)])]),
        ],
        lastServedAtIso: {},
        freeSlots: 1,
        nowIso: NOW_ISO,
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.admit).toEqual([
      { runId: 'run-1', groupId: 'a', repository: 'b' + nul + 'c' },
    ]);
    expect(result.parked).toEqual([{ runId: 'run-2', reason: 'no-capacity' }]);
  });

  it('refuses negative, fractional, NaN, and Infinity numeric fields', () => {
    const badNumbers = [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY];
    for (const bad of badNumbers) {
      expect(
        decideFairAdmission({ groups: [], lastServedAtIso: {}, freeSlots: bad, nowIso: NOW_ISO }),
      ).toEqual({ ok: false, reason: 'invalid-input' });
      expect(
        decideFairAdmission({
          groups: [group('g', bad, 0, [])],
          lastServedAtIso: {},
          freeSlots: 1,
          nowIso: NOW_ISO,
        }),
      ).toEqual({ ok: false, reason: 'invalid-input' });
      expect(
        decideFairAdmission({
          groups: [group('g', 1, bad, [])],
          lastServedAtIso: {},
          freeSlots: 1,
          nowIso: NOW_ISO,
        }),
      ).toEqual({ ok: false, reason: 'invalid-input' });
      expect(
        decideFairAdmission({
          groups: [group('g', 1, 0, [repo('r', bad, 0, [])])],
          lastServedAtIso: {},
          freeSlots: 1,
          nowIso: NOW_ISO,
        }),
      ).toEqual({ ok: false, reason: 'invalid-input' });
      expect(
        decideFairAdmission({
          groups: [group('g', 1, 0, [repo('r', 1, bad, [])])],
          lastServedAtIso: {},
          freeSlots: 1,
          nowIso: NOW_ISO,
        }),
      ).toEqual({ ok: false, reason: 'invalid-input' });
    }
  });

  it('refuses unparseable timestamps and impossible calendar dates', () => {
    const badStamps = ['not-a-date', '2026-02-31T00:00:00Z', '2026-11-24T12:00:00'];
    for (const bad of badStamps) {
      expect(
        decideFairAdmission({ groups: [], lastServedAtIso: {}, freeSlots: 1, nowIso: bad }),
      ).toEqual({ ok: false, reason: 'invalid-input' });
      expect(
        decideFairAdmission({
          groups: [
            group('g', 1, 0, [
              repo('r', 1, 0, [{ runId: 'run-1', queuedAtIso: bad }]),
            ]),
          ],
          lastServedAtIso: {},
          freeSlots: 1,
          nowIso: NOW_ISO,
        }),
      ).toEqual({ ok: false, reason: 'invalid-input' });
      expect(
        decideFairAdmission({
          groups: [group('g', 1, 0, [repo('r', 1, 0, [waitingRun(1, 5)])])],
          lastServedAtIso: { 'g': bad },
          freeSlots: 1,
          nowIso: NOW_ISO,
        }),
      ).toEqual({ ok: false, reason: 'invalid-input' });
    }
    // A stamp later than nowIso is refused wherever it appears.
    const future = isoAt(150);
    expect(
      decideFairAdmission({
        groups: [group('g', 1, 0, [repo('r', 1, 0, [{ runId: 'run-1', queuedAtIso: future }])])],
        lastServedAtIso: {},
        freeSlots: 1,
        nowIso: NOW_ISO,
      }),
    ).toEqual({ ok: false, reason: 'invalid-input' });
    expect(
      decideFairAdmission({
        groups: [group('g', 1, 0, [repo('r', 1, 0, [waitingRun(1, 5)])])],
        lastServedAtIso: { 'g': future },
        freeSlots: 1,
        nowIso: NOW_ISO,
      }),
    ).toEqual({ ok: false, reason: 'invalid-input' });
  });

  it('refuses duplicate runId, groupId, and repository with their typed reasons', () => {
    expect(
      decideFairAdmission({
        groups: [
          group('g1', 1, 0, [repo('r1', 1, 0, [waitingRun(1, 5)])]),
          group('g2', 1, 0, [repo('r2', 1, 0, [waitingRun(1, 6)])]),
        ],
        lastServedAtIso: {},
        freeSlots: 2,
        nowIso: NOW_ISO,
      }),
    ).toEqual({ ok: false, reason: 'duplicate-run' });

    expect(
      decideFairAdmission({
        groups: [group('g1', 1, 0, []), group('g1', 1, 0, [])],
        lastServedAtIso: {},
        freeSlots: 1,
        nowIso: NOW_ISO,
      }),
    ).toEqual({ ok: false, reason: 'duplicate-group' });

    expect(
      decideFairAdmission({
        groups: [
          group('g1', 1, 0, [repo('r1', 1, 0, []), repo('r1', 1, 0, [])]),
        ],
        lastServedAtIso: {},
        freeSlots: 1,
        nowIso: NOW_ISO,
      }),
    ).toEqual({ ok: false, reason: 'duplicate-repository' });
  });

  it('handles constructor and __proto__ keys safely without prototype alteration', () => {
    // A group literally named `constructor` (built at runtime) is an
    // ordinary key: it can be served-ordered like any other group.
    const constructorId = 'con' + 'structor';
    const result = decideFairAdmission(
      frozenInput({
        groups: [
          group(constructorId, 1, 0, [repo('r', 1, 0, [waitingRun(1, 5)])]),
          group('g2', 1, 0, [repo('r2', 1, 0, [waitingRun(2, 6)])]),
        ],
        lastServedAtIso: { [constructorId]: isoAt(60) },
        freeSlots: 2,
        nowIso: NOW_ISO,
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    // 'g2' is unserved (null) so it goes first; 'constructor' second.
    expect(result.admit.map((entry) => entry.groupId)).toEqual(['g2', constructorId]);

    // A group named `__proto__` with no lastServed entry is an ordinary
    // value too; lookup never touches Object.prototype.
    const protoId = '__' + 'proto' + '__';
    const protoResult = decideFairAdmission(
      frozenInput({
        groups: [group(protoId, 1, 0, [repo('r', 1, 0, [waitingRun(1, 5)])])],
        lastServedAtIso: {},
        freeSlots: 1,
        nowIso: NOW_ISO,
      }),
    );
    expect(protoResult).toEqual({
      ok: true,
      admit: [{ runId: 'run-1', groupId: protoId, repository: 'r' }],
      parked: [],
    });

    // But an own `__proto__` key on lastServedAtIso is refused, and the
    // prototype stays untouched.
    const polluted = JSON.parse('{"__proto__": {"polluted": true}}') as Record<string, unknown>;
    expect(
      decideFairAdmission({
        groups: [group('g', 1, 0, [repo('r', 1, 0, [waitingRun(1, 5)])])],
        lastServedAtIso: polluted,
        freeSlots: 1,
        nowIso: NOW_ISO,
      }),
    ).toEqual({ ok: false, reason: 'invalid-input' });
    expect((Object.prototype as unknown as Record<string, unknown>).polluted).toBeUndefined();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('never mutates its deep-frozen input', () => {
    const input = frozenInput({
      groups: [
        group('g1', 2, 0, [repo('r1', 1, 0, [waitingRun(1, 5), waitingRun(2, 6)])]),
        group('g2', 2, 0, [repo('r2', 2, 0, [waitingRun(3, 7)])]),
      ],
      lastServedAtIso: { 'g1': isoAt(10) },
      freeSlots: 2,
      nowIso: NOW_ISO,
    });
    expect(Object.isFrozen(input)).toBe(true);
    const result = decideFairAdmission(input);
    expect(result.ok).toBe(true);
    // Freezing is total: any mutation attempt inside the decider would have
    // thrown in strict mode, and the input is still frozen throughout.
    expect(Object.isFrozen(input)).toBe(true);
    expect(Object.isFrozen((input as { groups: unknown[] }).groups[0])).toBe(true);
    expect(
      Object.isFrozen((input as { groups: { repositories: unknown[] }[] }).groups[0].repositories[0]),
    ).toBe(true);
  });
});
