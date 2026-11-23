// Unit and hostile-input tests for `readJournalPullRequestRef` and
// `runnerMinutesOf`. Every refusal asserts a typed result, never a throw, and
// no getter of an untrusted input ever runs.
import { describe, expect, it } from 'vitest';
import { readJournalPullRequestRef, runnerMinutesOf } from '../execution-records.js';

const ACTIONS = ['dispatch', 'reconcile', 'stop', 'collect', 'forge', 'accept'] as const;
const NON_FORGE_ACTIONS = ['dispatch', 'reconcile', 'stop', 'collect', 'accept'] as const;

const validForge = { repository: 'owner/repo', number: 7 };

// Assembled from inert pieces so no secret-shaped literal appears in this file.
const secretShapedRepository = ['sk', '-', 'x9y8z7'.repeat(4)].join('');

describe('readJournalPullRequestRef: absent pullRequest', () => {
  it("returns { kind: 'absent' } for undefined on every one of the six actions", () => {
    for (const action of ACTIONS) {
      expect(readJournalPullRequestRef(action, undefined), action).toEqual({ kind: 'absent' });
    }
  });
});

describe('readJournalPullRequestRef: value on a non-forge action', () => {
  it("returns { kind: 'invalid' } for a well-formed ref on each non-'forge' action", () => {
    for (const action of NON_FORGE_ACTIONS) {
      expect(readJournalPullRequestRef(action, { ...validForge }), action).toEqual({ kind: 'invalid' });
    }
  });
});

describe('readJournalPullRequestRef: valid forge entries', () => {
  it("returns { kind: 'valid' } with a frozen ref whose copy does not track the input", () => {
    const input = { repository: 'owner/repo', number: 7 };
    const result = readJournalPullRequestRef('forge', input);
    expect(result).toEqual({ kind: 'valid', ref: { repository: 'owner/repo', number: 7 } });
    expect(Object.isFrozen(result.kind === 'valid' ? result.ref : null)).toBe(true);
    input.repository = 'other/repo';
    input.number = 9;
    expect(result).toEqual({ kind: 'valid', ref: { repository: 'owner/repo', number: 7 } });
  });

  it('accepts a null-prototype object with the exact two keys', () => {
    const input = Object.assign(Object.create(null), validForge);
    const result = readJournalPullRequestRef('forge', input);
    expect(result).toEqual({ kind: 'valid', ref: { repository: 'owner/repo', number: 7 } });
  });

  it('accepts the boundary number 999_999_999', () => {
    const result = readJournalPullRequestRef('forge', { repository: 'owner/repo', number: 999_999_999 });
    expect(result).toEqual({ kind: 'valid', ref: { repository: 'owner/repo', number: 999_999_999 } });
  });

  it('reads through a Proxy without invoking its get trap', () => {
    let getTrapCalls = 0;
    const proxy = new Proxy({ ...validForge }, {
      get(target, key, receiver) {
        getTrapCalls += 1;
        return Reflect.get(target, key, receiver);
      },
    });
    const result = readJournalPullRequestRef('forge', proxy);
    expect(result).toEqual({ kind: 'valid', ref: { repository: 'owner/repo', number: 7 } });
    expect(getTrapCalls).toBe(0);
  });
});

describe('readJournalPullRequestRef: non-objects and non-plain prototypes', () => {
  it("returns { kind: 'invalid' } for null, arrays, primitives, exotic objects and inherited prototypes", () => {
    const cases: readonly [string, unknown][] = [
      ['null', null],
      ['array', []],
      ['string', 'owner/repo'],
      ['number', 42],
      ['boolean', true],
      ['Date instance', new Date()],
      ['custom class instance', new (class {})()],
      ['object inheriting from a non-Object.prototype parent', Object.create({ ...validForge })],
    ];
    for (const [name, value] of cases) {
      expect(readJournalPullRequestRef('forge', value), name).toEqual({ kind: 'invalid' });
    }
  });
});

describe('readJournalPullRequestRef: key-set refusals', () => {
  it("returns { kind: 'invalid' } for a missing key, an extra key, a symbol key, a non-enumerable key and an array-like", () => {
    const withOwnProtoKey = {} as Record<PropertyKey, unknown>;
    Object.defineProperty(withOwnProtoKey, '__proto__', { enumerable: true, value: {} });
    withOwnProtoKey.repository = 'owner/repo';
    withOwnProtoKey.number = 7;

    const nonEnumerableNumber = { repository: 'owner/repo' } as { repository: string; number?: number };
    Object.defineProperty(nonEnumerableNumber, 'number', { enumerable: false, value: 7 });

    const cases: readonly [string, unknown][] = [
      ['repository only', { repository: 'owner/repo' }],
      ['number only', { number: 7 }],
      ['extra key', { repository: 'owner/repo', number: 7, extra: 1 }],
      ['own prototype-polluting __proto__ key', withOwnProtoKey],
      ['extra symbol key', { ...validForge, [Symbol('k')]: 1 }],
      ['non-enumerable number', nonEnumerableNumber],
      ['array-like', { 0: 'a', 1: 'b', length: 2 }],
    ];
    for (const [name, value] of cases) {
      expect(readJournalPullRequestRef('forge', value), name).toEqual({ kind: 'invalid' });
    }
  });
});

describe('readJournalPullRequestRef: getters never run', () => {
  it("returns { kind: 'invalid' } for accessor properties and leaves the spy count at 0", () => {
    let repositoryGetterCalls = 0;
    let numberGetterCalls = 0;
    const withRepositoryGetter = {
      get repository() {
        repositoryGetterCalls += 1;
        return 'owner/repo';
      },
      number: 7,
    };
    const withNumberGetter = {
      repository: 'owner/repo',
      get number() {
        numberGetterCalls += 1;
        return 7;
      },
    };
    expect(readJournalPullRequestRef('forge', withRepositoryGetter)).toEqual({ kind: 'invalid' });
    expect(readJournalPullRequestRef('forge', withNumberGetter)).toEqual({ kind: 'invalid' });
    expect(repositoryGetterCalls).toBe(0);
    expect(numberGetterCalls).toBe(0);
  });

  it('rejects a getter that throws without invoking it and without throwing', () => {
    const throwingGetter = {
      get repository(): string {
        throw new Error('getter ran');
      },
      number: 7,
    };
    expect(readJournalPullRequestRef('forge', throwingGetter)).toEqual({ kind: 'invalid' });
  });
});

describe('readJournalPullRequestRef: malformed repository', () => {
  it("returns { kind: 'invalid' } for an empty, spaced, over-segmented, non-string or secret-shaped repository", () => {
    const cases: readonly [string, unknown][] = [
      ['empty string', ''],
      ['internal space', 'owner repo'],
      ['three path segments', 'owner/repo/extra'],
      ['non-string number', 123],
      ['secret-shaped string assembled at runtime', secretShapedRepository],
    ];
    for (const [name, repository] of cases) {
      expect(readJournalPullRequestRef('forge', { repository, number: 7 }), name).toEqual({ kind: 'invalid' });
    }
  });
});

describe('readJournalPullRequestRef: number bounds', () => {
  it("returns { kind: 'invalid' } for zero, negatives, non-integers, non-finite, non-safe and out-of-range numbers", () => {
    const cases: readonly [string, unknown][] = [
      ['zero', 0],
      ['negative one', -1],
      ['fractional', 1.5],
      ['NaN', NaN],
      ['Infinity', Infinity],
      ['-Infinity', -Infinity],
      ['beyond MAX_SAFE_INTEGER', Number.MAX_SAFE_INTEGER + 1],
      ['above the 999_999_999 bound', 1_000_000_000],
      ['string digit', '7'],
    ];
    for (const [name, number] of cases) {
      expect(readJournalPullRequestRef('forge', { repository: 'owner/repo', number }), name).toEqual({
        kind: 'invalid',
      });
    }
  });
});

describe('runnerMinutesOf', () => {
  it('returns null for null wallSeconds', () => {
    expect(runnerMinutesOf(null)).toBeNull();
  });

  it('returns 0 for 0 seconds and 1 for both 1 and 60 seconds', () => {
    expect(runnerMinutesOf(0)).toBe(0);
    expect(runnerMinutesOf(1)).toBe(1);
    expect(runnerMinutesOf(60)).toBe(1);
  });

  it('rounds 61 seconds up to 2 minutes', () => {
    expect(runnerMinutesOf(61)).toBe(2);
  });

  it('returns null for non-finite wallSeconds', () => {
    expect(runnerMinutesOf(Infinity)).toBeNull();
    expect(runnerMinutesOf(-Infinity)).toBeNull();
    expect(runnerMinutesOf(NaN)).toBeNull();
  });

  it('returns null when the ceiling exceeds MAX_SAFE_INTEGER', () => {
    expect(runnerMinutesOf(Number.MAX_SAFE_INTEGER * 60 + 60)).toBeNull();
  });

  it('returns the ceiling for negative values, including the -0 result for -30 seconds', () => {
    expect(Object.is(runnerMinutesOf(-30), -0)).toBe(true);
    expect(runnerMinutesOf(-61)).toBe(-1);
  });
});
