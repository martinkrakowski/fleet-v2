// KEY1c — `buildPreSignShadowImportPlan` hostile-input battery.
/**
 * The pre-sign planner takes `unknown` at its boundary and never throws: a
 * getter never runs (root or nested repository), a Proxy `get` trap is never
 * invoked, arrays and array-like objects are refused before any indexing, and
 * every refusal is a typed result carrying a named error code. Nothing here
 * dispatches or touches the network.
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_PRE_SIGN_DECISION_REVISION,
  SHADOW_IMPORT_GRANT_MAX_TTL_DAYS,
  buildPreSignShadowImportPlan,
  shadowImportDigestPayload,
} from './coordination-records.js';

const NOW_ISO = '2026-11-19T00:00:00.000Z';
const DAY_MS = 86_400_000;

function validInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    actionScope: 'merge:import-shadow',
    repository: { owner: 'octo', repo: 'repo' },
    expiresAtIso: '2026-11-20T00:00:00.000Z',
    nowIso: NOW_ISO,
    projectId: 'proj-1',
    ...overrides,
  };
}

describe('buildPreSignShadowImportPlan hostile inputs', () => {
  it('refuses null with pre-sign-not-object', () => {
    expect(buildPreSignShadowImportPlan(null)).toEqual({ ok: false, code: 'pre-sign-not-object' });
  });

  it('refuses undefined with pre-sign-not-object', () => {
    expect(buildPreSignShadowImportPlan(undefined)).toEqual({ ok: false, code: 'pre-sign-not-object' });
  });

  it('refuses a wrong primitive (a number where an object is due) with pre-sign-not-object', () => {
    expect(buildPreSignShadowImportPlan(7)).toEqual({ ok: false, code: 'pre-sign-not-object' });
  });

  it('refuses a string where an object is due with pre-sign-not-object', () => {
    expect(buildPreSignShadowImportPlan('merge:import-shadow')).toEqual({
      ok: false,
      code: 'pre-sign-not-object',
    });
  });

  it('refuses an array with pre-sign-not-object', () => {
    expect(buildPreSignShadowImportPlan([validInput()])).toEqual({
      ok: false,
      code: 'pre-sign-not-object',
    });
  });

  it('refuses a sparse array (an array hole) with pre-sign-not-object', () => {
    const sparse: unknown[] = [];
    sparse[10] = validInput();
    expect(buildPreSignShadowImportPlan(sparse)).toEqual({ ok: false, code: 'pre-sign-not-object' });
  });

  it('refuses an enormous sparse array (length 2**32 - 1) before any traversal', () => {
    const enormous: unknown[] = [];
    Object.defineProperty(enormous, 'length', { value: 2 ** 32 - 1 });
    expect(buildPreSignShadowImportPlan(enormous)).toEqual({
      ok: false,
      code: 'pre-sign-not-object',
    });
  });

  it('refuses an array-like object ({ length: 1, 0: ... }) with pre-sign-not-object', () => {
    expect(buildPreSignShadowImportPlan({ length: 1, 0: validInput() })).toEqual({
      ok: false,
      code: 'pre-sign-not-object',
    });
  });

  it('refuses an array-like object with more keys than the cap as pre-sign-not-object, not pre-sign-unexpected-key', () => {
    // An own `length` key is an array-like carrier: it is refused as a
    // non-object BEFORE the unexpected-key check runs, even when the key
    // count alone would exceed `MAX_PRE_SIGN_KEYS`.
    expect(buildPreSignShadowImportPlan({ length: 1, a: 1, b: 2, c: 3, d: 4, e: 5, f: 6 })).toEqual({
      ok: false,
      code: 'pre-sign-not-object',
    });
  });

  it('refuses a non-plain prototype (a class instance) with pre-sign-not-object', () => {
    class Seed {}
    expect(buildPreSignShadowImportPlan(new Seed())).toEqual({
      ok: false,
      code: 'pre-sign-not-object',
    });
  });

  it('refuses a getter on the root without ever running it (pre-sign-accessor-forbidden)', () => {
    let calls = 0;
    const input = {
      ...validInput(),
      get projectId(): string {
        calls += 1;
        return 'proj-1';
      },
    };
    expect(buildPreSignShadowImportPlan(input)).toEqual({
      ok: false,
      code: 'pre-sign-accessor-forbidden',
    });
    expect(calls).toBe(0);
  });

  it('refuses a getter on the nested repository without ever running it (pre-sign-accessor-forbidden)', () => {
    let calls = 0;
    const input = validInput({
      repository: {
        owner: 'octo',
        repo: 'repo',
        get extra(): string {
          calls += 1;
          return 'x';
        },
      },
    });
    expect(buildPreSignShadowImportPlan(input)).toEqual({
      ok: false,
      code: 'pre-sign-accessor-forbidden',
    });
    expect(calls).toBe(0);
  });

  it('accepts a Proxy over a valid input as exactly the plain data, with no get trap run', () => {
    let getTraps = 0;
    const proxied = new Proxy(validInput(), {
      get(target, key, receiver) {
        getTraps += 1;
        return Reflect.get(target, key, receiver);
      },
    });
    const result = buildPreSignShadowImportPlan(proxied);
    expect(result.ok).toBe(true);
    expect(getTraps).toBe(0);
    if (result.ok) {
      expect(result.value.repository).toEqual({ owner: 'octo', repo: 'repo' });
      expect(result.value.projectId).toBe('proj-1');
    }
  });

  it.each(['__proto__', 'constructor', 'prototype'])(
    'refuses a prototype-polluting own key (%s) produced by JSON.parse with pre-sign-forbidden-key',
    (key) => {
      const polluted = JSON.parse(
        JSON.stringify(
          validInput({ [key]: { injected: true } }),
        ),
      ) as Record<string, unknown>;
      if (key === '__proto__') {
        // JSON.parse makes `__proto__` an own data property; `constructor` and
        // `prototype` arrive as ordinary own keys too.
        polluted[key] = { injected: true };
      }
      expect(buildPreSignShadowImportPlan(polluted)).toEqual({
        ok: false,
        code: 'pre-sign-forbidden-key',
      });
    },
  );

  it('refuses an extra own key with pre-sign-unexpected-key', () => {
    expect(buildPreSignShadowImportPlan(validInput({ extra: 1 }))).toEqual({
      ok: false,
      code: 'pre-sign-unexpected-key',
    });
  });

  it('refuses a missing own key with pre-sign-unexpected-key', () => {
    const missing = validInput();
    delete missing['projectId'];
    expect(buildPreSignShadowImportPlan(missing)).toEqual({
      ok: false,
      code: 'pre-sign-unexpected-key',
    });
  });

  it('refuses a symbol own key with pre-sign-unexpected-key', () => {
    const input = validInput() as Record<PropertyKey, unknown>;
    input[Symbol('s')] = 1;
    expect(buildPreSignShadowImportPlan(input)).toEqual({
      ok: false,
      code: 'pre-sign-unexpected-key',
    });
  });

  it('refuses a non-enumerable own key with pre-sign-unexpected-key', () => {
    const input = validInput();
    Object.defineProperty(input, 'projectId', { enumerable: false, value: 'proj-1' });
    expect(buildPreSignShadowImportPlan(input)).toEqual({
      ok: false,
      code: 'pre-sign-unexpected-key',
    });
  });

  it('refuses a non-shadow actionScope with pre-sign-unsupported-scope', () => {
    expect(buildPreSignShadowImportPlan(validInput({ actionScope: 'merge:import' }))).toEqual({
      ok: false,
      code: 'pre-sign-unsupported-scope',
    });
  });

  it('refuses a malformed repository with the underlying grant code', () => {
    expect(
      buildPreSignShadowImportPlan(validInput({ repository: { owner: 'octo/x', repo: 'repo' } })),
    ).toEqual({ ok: false, code: 'shadow-import-grant-invalid-repository' });
  });

  it('refuses a malformed expiresAtIso with the underlying grant code', () => {
    expect(buildPreSignShadowImportPlan(validInput({ expiresAtIso: 'not-a-date' }))).toEqual({
      ok: false,
      code: 'shadow-import-grant-invalid-expiry',
    });
  });

  it('refuses an invalid nowIso with pre-sign-invalid-now', () => {
    expect(buildPreSignShadowImportPlan(validInput({ nowIso: 'garbage' }))).toEqual({
      ok: false,
      code: 'pre-sign-invalid-now',
    });
  });

  it('refuses a locale date nowIso (11/19/2026) with pre-sign-invalid-now: only strict ISO-8601 UTC parses', () => {
    // A bare finite `Date.parse` would accept `'11/19/2026'`; the planner uses
    // the strict `parseShadowImportExpiry` validator instead, so it refuses.
    expect(buildPreSignShadowImportPlan(validInput({ nowIso: '11/19/2026' }))).toEqual({
      ok: false,
      code: 'pre-sign-invalid-now',
    });
  });

  it('refuses a revoked Proxy without ever throwing', () => {
    const { proxy, revoke } = Proxy.revocable(validInput(), {});
    revoke();
    let outcome: { ok: boolean; code?: string };
    try {
      const result = buildPreSignShadowImportPlan(proxy);
      outcome = { ok: result.ok, code: result.ok ? undefined : result.code };
    } catch (thrown) {
      outcome = { ok: true, code: `threw ${String(thrown)}` };
    }
    expect(outcome.ok).toBe(false);
    expect(outcome.code === 'pre-sign-not-object' || outcome.code === 'pre-sign-invalid-input').toBe(
      true,
    );
  });

  it('refuses an expiry at or before now with pre-sign-expired', () => {
    expect(
      buildPreSignShadowImportPlan(validInput({ expiresAtIso: '2026-11-19T00:00:00.000Z' })),
    ).toEqual({ ok: false, code: 'pre-sign-expired' });
  });

  it('accepts an expiry exactly 30 days after now and refuses 30 days + 1 ms', () => {
    const boundary = new Date(Date.parse(NOW_ISO) + SHADOW_IMPORT_GRANT_MAX_TTL_DAYS * DAY_MS);
    const okInput = validInput({ expiresAtIso: boundary.toISOString() });
    expect(buildPreSignShadowImportPlan(okInput).ok).toBe(true);
    const exceeded = validInput({
      expiresAtIso: new Date(boundary.getTime() + 1).toISOString(),
    });
    expect(buildPreSignShadowImportPlan(exceeded)).toEqual({
      ok: false,
      code: 'pre-sign-ttl-exceeded',
    });
  });

  it.each([
    ' proj-1',
    'proj-1 ',
    ' proj-1 ',
    '',
    'p'.repeat(257),
    'proj\u00001',
  ])('refuses the invalid projectId %j with pre-sign-invalid-project', (projectId) => {
    expect(buildPreSignShadowImportPlan(validInput({ projectId }))).toEqual({
      ok: false,
      code: 'pre-sign-invalid-project',
    });
  });

  it('refuses an invalid decisionRevision with pre-sign-invalid-revision', () => {
    expect(buildPreSignShadowImportPlan(validInput({ decisionRevision: 'r'.repeat(257) }))).toEqual({
      ok: false,
      code: 'pre-sign-invalid-revision',
    });
    expect(buildPreSignShadowImportPlan(validInput({ decisionRevision: '1\n' }))).toEqual({
      ok: false,
      code: 'pre-sign-invalid-revision',
    });
  });

  it('defaults the decisionRevision when omitted and honours a supplied one', () => {
    const omitted = buildPreSignShadowImportPlan(validInput());
    expect(omitted.ok).toBe(true);
    if (omitted.ok) {
      expect(omitted.value.decisionRevision).toBe(DEFAULT_PRE_SIGN_DECISION_REVISION);
    }
    const supplied = buildPreSignShadowImportPlan(validInput({ decisionRevision: '2' }));
    expect(supplied.ok).toBe(true);
    if (supplied.ok) {
      expect(supplied.value.decisionRevision).toBe('2');
    }
  });

  it('is not satisfiable by a constant verdict: a valid plan carries the derived digest payload', () => {
    const result = buildPreSignShadowImportPlan(validInput());
    expect(result.ok).toBe(true);
    if (result.ok) {
      const expectedPayload = shadowImportDigestPayload({
        repository: { owner: 'octo', repo: 'repo' },
        expiresAtIso: '2026-11-20T00:00:00.000Z',
      });
      expect(expectedPayload.ok).toBe(true);
      if (expectedPayload.ok) {
        expect(result.value.digestPayload).toBe(expectedPayload.value);
      }      expect(result.value.repository).toEqual({ owner: 'octo', repo: 'repo' });
      expect(result.value.nowIso).toBe(NOW_ISO);
    }
  });

  it('is not satisfiable by an identity echo: the result is a normalized plan, never the input', () => {
    const input = validInput({ repository: { owner: 'octo', repo: 'repo' } });
    const result = buildPreSignShadowImportPlan(input);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).not.toBe(input);
      expect('actionScope' in result.value).toBe(false);
      expect('nowIso' in (result.value as unknown as Record<string, unknown>)).toBe(true);
    }
  });
});
