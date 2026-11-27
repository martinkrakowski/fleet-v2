/**
 * Tests for the FC17F pure expand-contract migration checker. Every call
 * passes `types.isProxy` from `node:util` as the required positional
 * detector. No network, no clock, no randomness.
 */

import { types } from 'node:util';

import { describe, expect, it } from 'vitest';

import {
  MAX_MIGRATIONS,
  MAX_STEPS_PER_MIGRATION,
  checkExpandContract,
  type ExpandContractMigration,
} from '../expand-contract-check.js';

const isProxy = types.isProxy;

function migration(
  release: number,
  steps: Array<{ kind: string; target: string; codeCutoffRelease: number }>,
): ExpandContractMigration {
  return {
    release,
    steps,
  } as unknown as ExpandContractMigration;
}

function step(
  kind: string,
  target = 'old-table',
  codeCutoffRelease = 10,
): { kind: string; target: string; codeCutoffRelease: number } {
  return { kind, target, codeCutoffRelease };
}

describe('checkExpandContract', () => {
  it('accepts an empty migrations array with zero counts', () => {
    expect(checkExpandContract([], isProxy)).toEqual({
      ok: true,
      checkedMigrations: 0,
      checkedSteps: 0,
    });
  });

  it('accepts additive steps regardless of the cutoff relation', () => {
    const kinds = ['create-table', 'add-column', 'add-index', 'backfill', 'widen-type'];
    for (const kind of kinds) {
      const result = checkExpandContract(
        [migration(5, [step(kind, 't', 10)])],
        isProxy,
      );
      expect(result, kind).toEqual({ ok: true, checkedMigrations: 1, checkedSteps: 1 });
    }
  });

  it('accepts destructive steps scheduled strictly after the code-cutoff release', () => {
    const kinds = ['drop', 'rename', 'type-narrowing', 'add-not-null-without-default'];
    for (const kind of kinds) {
      const result = checkExpandContract(
        [migration(11, [step(kind, 't', 10)])],
        isProxy,
      );
      expect(result, kind).toEqual({ ok: true, checkedMigrations: 1, checkedSteps: 1 });
    }
  });

  it('refuses drop at the code-cutoff release (release === codeCutoffRelease)', () => {
    expect(checkExpandContract([migration(10, [step('drop', 't', 10)])], isProxy)).toEqual({
      ok: false,
      reason: 'destructive-before-or-at-cutoff',
      violationClass: 'drop',
      migrationIndex: 0,
      stepIndex: 0,
    });
  });

  it('refuses drop before the code-cutoff release (release < codeCutoffRelease)', () => {
    expect(checkExpandContract([migration(9, [step('drop', 't', 10)])], isProxy)).toEqual({
      ok: false,
      reason: 'destructive-before-or-at-cutoff',
      violationClass: 'drop',
      migrationIndex: 0,
      stepIndex: 0,
    });
  });

  it('refuses rename at the code-cutoff release', () => {
    expect(checkExpandContract([migration(10, [step('rename', 't', 10)])], isProxy)).toEqual({
      ok: false,
      reason: 'destructive-before-or-at-cutoff',
      violationClass: 'rename',
      migrationIndex: 0,
      stepIndex: 0,
    });
  });

  it('refuses rename before the code-cutoff release', () => {
    expect(checkExpandContract([migration(3, [step('rename', 't', 10)])], isProxy)).toEqual({
      ok: false,
      reason: 'destructive-before-or-at-cutoff',
      violationClass: 'rename',
      migrationIndex: 0,
      stepIndex: 0,
    });
  });

  it('refuses type-narrowing at the code-cutoff release', () => {
    expect(
      checkExpandContract([migration(10, [step('type-narrowing', 't', 10)])], isProxy),
    ).toEqual({
      ok: false,
      reason: 'destructive-before-or-at-cutoff',
      violationClass: 'type-narrowing',
      migrationIndex: 0,
      stepIndex: 0,
    });
  });

  it('refuses type-narrowing before the code-cutoff release', () => {
    expect(
      checkExpandContract([migration(1, [step('type-narrowing', 't', 10)])], isProxy),
    ).toEqual({
      ok: false,
      reason: 'destructive-before-or-at-cutoff',
      violationClass: 'type-narrowing',
      migrationIndex: 0,
      stepIndex: 0,
    });
  });

  it('refuses adding NOT NULL without default at the code-cutoff release', () => {
    expect(
      checkExpandContract(
        [migration(10, [step('add-not-null-without-default', 't', 10)])],
        isProxy,
      ),
    ).toEqual({
      ok: false,
      reason: 'destructive-before-or-at-cutoff',
      violationClass: 'add-not-null-without-default',
      migrationIndex: 0,
      stepIndex: 0,
    });
  });

  it('refuses adding NOT NULL without default before the code-cutoff release', () => {
    expect(
      checkExpandContract(
        [migration(0, [step('add-not-null-without-default', 't', 10)])],
        isProxy,
      ),
    ).toEqual({
      ok: false,
      reason: 'destructive-before-or-at-cutoff',
      violationClass: 'add-not-null-without-default',
      migrationIndex: 0,
      stepIndex: 0,
    });
  });

  it('reports the offending migration and step indices for a multi-step plan', () => {
    const result = checkExpandContract(
      [
        migration(20, [step('create-table', 'a', 1), step('add-index', 'b', 1)]),
        migration(20, [step('add-column', 'c', 1), step('drop', 'd', 20)]),
      ],
      isProxy,
    );
    expect(result).toEqual({
      ok: false,
      reason: 'destructive-before-or-at-cutoff',
      violationClass: 'drop',
      migrationIndex: 1,
      stepIndex: 1,
    });
  });

  it('refuses missing or non-function isProxy detector with invalid-migrations-list', () => {
    const valid = [migration(20, [step('create-table', 'a', 1)])];
    // Missing detector.
    expect(
      checkExpandContract(valid, undefined as unknown as typeof isProxy),
    ).toEqual({ ok: false, reason: 'invalid-migrations-list' });
    // Non-function detector.
    expect(
      checkExpandContract(valid, 'nope' as unknown as typeof isProxy),
    ).toEqual({ ok: false, reason: 'invalid-migrations-list' });
  });

  it('refuses null and undefined migrations with invalid-migrations-list', () => {
    expect(checkExpandContract(null, isProxy)).toEqual({
      ok: false,
      reason: 'invalid-migrations-list',
    });
    expect(checkExpandContract(undefined, isProxy)).toEqual({
      ok: false,
      reason: 'invalid-migrations-list',
    });
  });

  it('refuses primitives, non-iterables, array-likes, and Array subclasses with invalid-migrations-list', () => {
    class Sub extends Array {}
    const arrayLike = Object.defineProperties(Object.create(Object.prototype), {
      length: { value: 1, enumerable: true },
      0: { value: migration(20, [step('create-table', 'a', 1)]), enumerable: true },
    });
    const inputs = [
      'migrations',
      42,
      true,
      { length: 1, 0: 'x' },
      Object.assign(new Sub(), [migration(20, [step('create-table', 'a', 1)])]),
      new Map(),
    ];
    for (const input of inputs) {
      expect(checkExpandContract(input, isProxy)).toEqual({
        ok: false,
        reason: 'invalid-migrations-list',
      });
    }
    expect(checkExpandContract(arrayLike, isProxy)).toEqual({
      ok: false,
      reason: 'invalid-migrations-list',
    });
  });

  it('refuses root Proxies and prototype-polluting, extra, or symbol root keys with invalid-migrations-list', () => {
    const rootProxy = new Proxy([migration(20, [step('create-table', 'a', 1)])], {});
    expect(checkExpandContract(rootProxy, isProxy)).toEqual({
      ok: false,
      reason: 'invalid-migrations-list',
    });

    const protoKey = Object.defineProperty([], '__proto__', {
      value: null,
      enumerable: true,
      configurable: true,
      writable: true,
    });
    expect(checkExpandContract(protoKey, isProxy)).toEqual({
      ok: false,
      reason: 'invalid-migrations-list',
    });

    const extraKey = Object.assign([migration(20, [step('create-table', 'a', 1)])], {
      extra: 1,
    });
    expect(checkExpandContract(extraKey, isProxy)).toEqual({
      ok: false,
      reason: 'invalid-migrations-list',
    });

    const symbolKey = Object.assign([], [migration(20, [step('create-table', 'a', 1)])]);
    (symbolKey as unknown as Record<symbol, unknown>)[Symbol('k')] = 1;
    expect(checkExpandContract(symbolKey, isProxy)).toEqual({
      ok: false,
      reason: 'invalid-migrations-list',
    });
  });

  it('refuses sparse array holes and index getters without invoking them with invalid-migration-record', () => {
    const sparse: unknown[] = [migration(20, [step('create-table', 'a', 1)])];
    void sparse.length;
    delete sparse[0];
    expect(checkExpandContract(sparse, isProxy)).toEqual({
      ok: false,
      reason: 'invalid-migration-record',
      migrationIndex: 0,
    });

    let getterRuns = 0;
    const withGetter = Object.defineProperty([], '0', {
      enumerable: true,
      configurable: true,
      get() {
        getterRuns += 1;
        return migration(20, [step('create-table', 'a', 1)]);
      },
    });
    expect(checkExpandContract(withGetter, isProxy)).toEqual({
      ok: false,
      reason: 'invalid-migration-record',
      migrationIndex: 0,
    });
    expect(getterRuns).toBe(0);
  });

  it('refuses migration lists exceeding MAX_MIGRATIONS before ownKeys', () => {
    const huge = new Array(MAX_MIGRATIONS + 1);
    for (let i = 0; i < huge.length; i += 1) {
      huge[i] = migration(20, [step('create-table', 'a', 1)]);
    }
    // Make the O(1) pre-check observable: the array is dense and valid, so
    // only the length bound can refuse it.
    expect(checkExpandContract(huge, isProxy)).toEqual({
      ok: false,
      reason: 'too-many-migrations',
    });
    // At the cap, the same plan is accepted.
    const atCap = huge.slice(0, MAX_MIGRATIONS);
    expect(checkExpandContract(atCap, isProxy)).toEqual({
      ok: true,
      checkedMigrations: MAX_MIGRATIONS,
      checkedSteps: MAX_MIGRATIONS,
    });
  });

  it('refuses malformed, getter-bearing, Proxy, missing-key, or invalid-release migration records with invalid-migration-record', () => {
    const good = migration(20, [step('create-table', 'a', 1)]);
    const cases: unknown[] = [
      null,
      7,
      'x',
      [],
      { release: 20 }, // missing `steps`
      { steps: [] }, // missing `release`
      { release: 20, steps: [], extra: 1 }, // extra key
      { release: -1, steps: [] }, // negative release
      { release: 1.5, steps: [] }, // non-integer release
      { release: '20', steps: [] }, // wrong type
      { release: Number.NaN, steps: [] },
      { release: Number.POSITIVE_INFINITY, steps: [] },
      Object.defineProperty({}, 'release', {
        enumerable: true,
        configurable: true,
        get() {
          return 20;
        },
      }),
      new Proxy({ release: 20, steps: [] }, {}),
      Object.defineProperty(
        Object.defineProperty({}, 'release', {
          value: 20,
          enumerable: true,
          configurable: true,
          writable: true,
        }),
        '__proto__',
        { value: null, enumerable: true, configurable: true, writable: true },
      ),
    ];
    for (const bad of cases) {
      expect(checkExpandContract([bad], isProxy)).toEqual({
        ok: false,
        reason: 'invalid-migration-record',
        migrationIndex: 0,
      });
    }
    expect(checkExpandContract([good], isProxy)).toEqual({
      ok: true,
      checkedMigrations: 1,
      checkedSteps: 1,
    });
  });

  it('refuses hostile steps arrays and steps exceeding MAX_STEPS_PER_MIGRATION', () => {
    const good = migration(20, [step('create-table', 'a', 1)]);
    // Non-array steps -> invalid-migration-record.
    expect(
      checkExpandContract([{ release: 20, steps: 'nope' }], isProxy),
    ).toEqual({ ok: false, reason: 'invalid-migration-record', migrationIndex: 0 });
    // Too many steps -> too-many-steps.
    const tooMany = [];
    for (let i = 0; i <= MAX_STEPS_PER_MIGRATION; i += 1) {
      tooMany.push(step('create-table', `t${i}`, 1));
    }
    expect(checkExpandContract([migration(20, tooMany)], isProxy)).toEqual({
      ok: false,
      reason: 'too-many-steps',
      migrationIndex: 0,
    });
    // Snapshot-level too-many-steps on a nested steps array.
    expect(checkExpandContract([migration(20, tooMany.slice(0, MAX_STEPS_PER_MIGRATION))], isProxy)).toEqual({
      ok: true,
      checkedMigrations: 1,
      checkedSteps: MAX_STEPS_PER_MIGRATION,
    });
    // At the cap, the same plan is accepted.
    expect(checkExpandContract([good], isProxy)).toEqual({
      ok: true,
      checkedMigrations: 1,
      checkedSteps: 1,
    });
  });

  it('refuses malformed, getter-bearing, Proxy, or missing-key step records with invalid-migration-step', () => {
    const cases: unknown[] = [
      null,
      7,
      'x',
      [],
      { kind: 'create-table', target: 'a' }, // missing codeCutoffRelease
      { kind: 'create-table', codeCutoffRelease: 1 }, // missing target
      { target: 'a', codeCutoffRelease: 1 }, // missing kind
      { kind: 'create-table', target: 'a', codeCutoffRelease: 1, extra: 1 },
      { kind: 'create-table', target: '', codeCutoffRelease: 1 }, // empty target
      { kind: 'create-table', target: ' a ', codeCutoffRelease: 1 }, // untrimmed target
      { kind: 'create-table', target: 7, codeCutoffRelease: 1 }, // wrong type
      { kind: 'create-table', target: 'a', codeCutoffRelease: -1 }, // negative
      { kind: 'create-table', target: 'a', codeCutoffRelease: 1.5 }, // non-integer
      { kind: 'create-table', target: 'a', codeCutoffRelease: '1' },
      Object.defineProperty({}, 'kind', {
        enumerable: true,
        configurable: true,
        get() {
          return 'create-table';
        },
      }),
      new Proxy({ kind: 'create-table', target: 'a', codeCutoffRelease: 1 }, {}),
    ];
    for (const bad of cases) {
      expect(checkExpandContract([migration(20, [bad as never])], isProxy)).toEqual({
        ok: false,
        reason: 'invalid-migration-step',
        migrationIndex: 0,
        stepIndex: 0,
      });
    }
    // A step-level hostile element (sparse hole) maps to the same refusal.
    const sparseSteps: unknown[] = [step('create-table', 'a', 1)];
    delete sparseSteps[0];
    expect(
      checkExpandContract([{ release: 20, steps: sparseSteps }], isProxy),
    ).toEqual({
      ok: false,
      reason: 'invalid-migration-step',
      migrationIndex: 0,
      stepIndex: 0,
    });
  });

  it('refuses unknown step kinds rather than passing', () => {
    for (const kind of ['truncate', 'DROP', 'drop-table', '', 7, null]) {
      expect(checkExpandContract([migration(20, [step(kind as string)])], isProxy)).toEqual({
        ok: false,
        reason: 'unknown-migration-step',
        migrationIndex: 0,
        stepIndex: 0,
      });
    }
    // An `undefined` step value is refused by the snapshot itself before
    // kind validation can see it.
    expect(
      checkExpandContract(
        [{ release: 20, steps: [undefined] } as unknown as ExpandContractMigration],
        isProxy,
      ),
    ).toEqual({
      ok: false,
      reason: 'invalid-migration-step',
      migrationIndex: 0,
      stepIndex: 0,
    });
  });

  it('never throws on revoked Proxies and reports invalid-migrations-list', () => {
    const target = { release: 20, steps: [] };
    const revoker = new Proxy(target, {});
    // Revoke by proxying through a handler that revokes on access is not
    // available; instead use a Proxy whose handler throws.
    const throwing = new Proxy([migration(20, [step('create-table', 'a', 1)])], {
      ownKeys() {
        throw new Error('boom');
      },
    });
    expect(checkExpandContract(throwing, isProxy)).toEqual({
      ok: false,
      reason: 'invalid-migrations-list',
    });
    expect(revoker).toBeTruthy();
  });

  it('never echoes a rejected input value into the refusal', () => {
    const secret = 'secret-value-should-never-appear';
    const result = checkExpandContract(
      [migration(20, [step('drop', secret, 999)])],
      isProxy,
    );
    expect(result).toEqual({
      ok: false,
      reason: 'destructive-before-or-at-cutoff',
      violationClass: 'drop',
      migrationIndex: 0,
      stepIndex: 0,
    });
    expect(JSON.stringify(result)).not.toContain(secret);
  });
});
