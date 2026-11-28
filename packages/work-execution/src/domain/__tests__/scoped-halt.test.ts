/**
 * FC17.7 hostile-input and behaviour tests for the scoped halt decider:
 * every function takes `unknown`, reads untrusted data once through
 * `snapshotPlainData`, never throws, and every refusal is the typed reason —
 * hostile shapes fail closed to `dispatchHalted: true`, never to a pass.
 */

import { describe, expect, it } from 'vitest';
import { types } from 'node:util';

import type { IsProxy } from '@fleet/shared';

/** The production detector predicate, exactly as infrastructure passes it. */
const detector: IsProxy = types.isProxy as IsProxy;

import {
  decideHaltRequest,
  decideScopedHalt,
  isDispatchHalted,
  MAX_SCOPED_HALTS,
} from '../scoped-halt.js';

/** A revoked Proxy throws on every trap, including [[GetPrototypeOf]]. */
function revokedProxy(): unknown {
  const { proxy, revoke } = Proxy.revocable({}, {});
  revoke();
  return proxy;
}

/** A transparent Proxy whose `ownKeys` trap records that it was reached. */
function transparentProxyWithOwnKeysFlag(inner: unknown, reached: { ownKeys: boolean }): unknown {
  return new Proxy(inner as object, {
    ownKeys() {
      reached.ownKeys = true;
      return Reflect.ownKeys(inner as object);
    },
  });
}

function entry(scope: 'org' | 'cell' | 'global', id: string | null, halted: boolean, imposedBy: 'org-admin' | 'operator'): unknown {
  return id === null ? { scope, halted, imposedBy } : { scope, id, halted, imposedBy };
}

function validRoot(fields: Record<string, unknown>): unknown {
  return { ...fields };
}

describe('decideHaltRequest hostile inputs', () => {
  it('refuses revoked Proxy and Proxy detected by types.isProxy without echoing ids', () => {
    expect(decideHaltRequest(revokedProxy(), detector)).toEqual({ ok: false, reason: 'invalid-input' });
    // A transparent Proxy over a valid input is refused O(1) before key
    // enumeration, and the refusal carries nothing but the typed reason.
    const reached = { ownKeys: false };
    const inner = validRoot({
      actorKind: 'operator',
      requested: { scope: 'org', id: 'secret-org', halted: true },
      halts: [],
    });
    expect(decideHaltRequest(transparentProxyWithOwnKeysFlag(inner, reached), detector)).toEqual({
      ok: false,
      reason: 'invalid-input',
    });
    // Same detector, a Proxy inside `requested`: refused with the request reason.
    const reachedRequested = { ownKeys: false };
    const proxyRequested = transparentProxyWithOwnKeysFlag(
      { scope: 'org', id: 'secret-org', halted: true },
      reachedRequested,
    );
    expect(
      decideHaltRequest(validRoot({ actorKind: 'operator', requested: proxyRequested, halts: [] }), detector),
    ).toEqual({ ok: false, reason: 'invalid-request' });
  });

  it('refuses null, undefined, primitives, non-iterables, array-likes, and wrong prototypes', () => {
    for (const bad of [null, undefined, 7, 'x', true, { length: 1, 0: {} }, () => 1]) {
      expect(decideHaltRequest(bad, detector)).toEqual({ ok: false, reason: 'invalid-input' });
      expect(decideScopedHalt(bad, detector)).toEqual({ ok: false, reason: 'invalid-input', dispatchHalted: true });
    }
    class Sub extends Array {}
    const subArray = Object.setPrototypeOf([entry('org', 'org1', true, 'operator')], Sub.prototype);
    expect(decideHaltRequest(validRoot({ actorKind: 'operator', requested: { scope: 'org', id: 'o', halted: true }, halts: subArray }), detector)).toEqual({
      ok: false,
      reason: 'invalid-halts',
    });
    // An array-like `halts` is never an implicit pass.
    const arrayLike = validRoot({ actorKind: 'operator', requested: { scope: 'org', id: 'o', halted: true }, halts: { length: 1, 0: entry('org', 'o', true, 'operator') } });
    expect(decideHaltRequest(arrayLike, detector)).toEqual({ ok: false, reason: 'invalid-halts' });
    expect(decideScopedHalt(arrayLike, detector)).toEqual({ ok: false, reason: 'invalid-halts', dispatchHalted: true });
  });

  it('refuses prototype-polluting, symbol, and extra unknown keys', () => {
    const symbol = Symbol('key');
    const withSymbol: Record<string | symbol, unknown> = { actorKind: 'operator' };
    withSymbol[symbol] = 1;
    withSymbol['requested'] = { scope: 'org', id: 'o', halted: true };
    withSymbol['halts'] = [];
    expect(decideHaltRequest(withSymbol, detector)).toEqual({ ok: false, reason: 'invalid-input' });
    // Own enumerable `constructor` and `__proto__` keys at root and inside a
    // `halts` entry are refused, never accepted.
    const polluting = validRoot({
      actorKind: 'operator',
      requested: { scope: 'org', id: 'o', halted: true },
      halts: [],
    });
    Object.defineProperty(polluting, 'constructor', { value: 1, enumerable: true, configurable: true });
    expect(decideHaltRequest(polluting, detector)).toEqual({ ok: false, reason: 'invalid-input' });
    const pollutingEntry = validRoot({
      actorKind: 'operator',
      requested: { scope: 'org', id: 'o', halted: true },
      halts: [entry('org', 'o', true, 'operator')],
    });
    Object.defineProperty((pollutingEntry as Record<string, unknown>)['halts'] as object, '__proto__', {
      value: 1,
      enumerable: true,
      configurable: true,
    });
    expect(decideHaltRequest(pollutingEntry, detector)).toEqual({ ok: false, reason: 'invalid-halts' });
    // Extra unknown keys: root, requested and target each take their own reason.
    expect(decideHaltRequest(validRoot({ actorKind: 'operator', note: 'extra', requested: { scope: 'org', id: 'o', halted: true }, halts: [] }), detector)).toEqual({
      ok: false,
      reason: 'invalid-input',
    });
    expect(decideHaltRequest(validRoot({ actorKind: 'operator', requested: { scope: 'org', id: 'o', halted: true, note: 'extra' }, halts: [] }), detector)).toEqual({
      ok: false,
      reason: 'invalid-request',
    });
  });

  it('refuses getter properties without invoking them', () => {
    let getterRuns = 0;
    const withGetter = validRoot({
      actorKind: 'operator',
      requested: { scope: 'org', id: 'org-1', halted: true },
      halts: [],
    });
    Object.defineProperty((withGetter as Record<string, unknown>)['requested'] as object, 'id', {
      get() {
        getterRuns += 1;
        return 'org-1';
      },
      enumerable: true,
      configurable: true,
    });
    expect(decideHaltRequest(withGetter, detector)).toEqual({ ok: false, reason: 'invalid-request' });
    expect(decideScopedHalt(withGetter, detector)).toEqual({ ok: false, reason: 'invalid-request', dispatchHalted: true });
    expect(getterRuns).toBe(0);
    // A getter inside a halt entry fails closed to halted true.
    let entryGetterRuns = 0;
    const haltWithGetter = Object.defineProperty({}, '0', {
      get() {
        entryGetterRuns += 1;
        return entry('org', 'o', true, 'operator');
      },
      enumerable: true,
      configurable: true,
    });
    expect(isDispatchHalted(haltWithGetter, { organizationId: 'o', cellId: 'c' }, detector)).toBe(true);
    expect(entryGetterRuns).toBe(0);
  });

  it('refuses malformed actor, actorOrganizationId, requested, halts, and target with exact path reasons and fail-closed dispatchHalted', () => {
    const requested = { scope: 'org', id: 'org1', halted: true };
    // Missing and invalid actorKind.
    expect(decideHaltRequest(validRoot({ requested, halts: [] }), detector)).toEqual({ ok: false, reason: 'invalid-actor' });
    expect(decideHaltRequest(validRoot({ actorKind: 'driver', requested, halts: [] }), detector)).toEqual({ ok: false, reason: 'invalid-actor' });
    expect(decideScopedHalt(validRoot({ requested, halts: [] }), detector)).toEqual({ ok: false, reason: 'invalid-actor', dispatchHalted: true });
    // actorOrganizationId: missing for org-admin, present for operator, blank.
    expect(decideHaltRequest(validRoot({ actorKind: 'org-admin', requested, halts: [] }), detector)).toEqual({ ok: false, reason: 'invalid-actor-organization' });
    expect(decideHaltRequest(validRoot({ actorKind: 'operator', actorOrganizationId: 'org1', requested, halts: [] }), detector)).toEqual({
      ok: false,
      reason: 'invalid-actor-organization',
    });
    expect(decideHaltRequest(validRoot({ actorKind: 'org-admin', actorOrganizationId: '   ', requested, halts: [] }), detector)).toEqual({
      ok: false,
      reason: 'invalid-actor-organization',
    });
    // requested: missing halted, bad scope, id for global, missing id for org.
    expect(decideHaltRequest(validRoot({ actorKind: 'operator', requested: { scope: 'org', id: 'org1' }, halts: [] }), detector)).toEqual({ ok: false, reason: 'invalid-request' });
    expect(decideHaltRequest(validRoot({ actorKind: 'operator', requested: { scope: 'planet', id: 'x', halted: true }, halts: [] }), detector)).toEqual({ ok: false, reason: 'invalid-request' });
    expect(decideHaltRequest(validRoot({ actorKind: 'operator', requested: { scope: 'global', id: 'org1', halted: true }, halts: [] }), detector)).toEqual({ ok: false, reason: 'invalid-request' });
    expect(decideHaltRequest(validRoot({ actorKind: 'operator', requested: { scope: 'org', halted: true }, halts: [] }), detector)).toEqual({ ok: false, reason: 'invalid-request' });
    // halts: missing, non-array, entry missing imposedBy, entry with a bad scope.
    const operator = validRoot({ actorKind: 'operator', requested });
    expect(decideHaltRequest(operator, detector)).toEqual({ ok: false, reason: 'invalid-halts' });
    expect(decideHaltRequest(validRoot({ actorKind: 'operator', requested, halts: 'no' }), detector)).toEqual({ ok: false, reason: 'invalid-halts' });
    expect(decideHaltRequest(validRoot({ actorKind: 'operator', requested, halts: [{ scope: 'org', id: 'org1', halted: true }] }), detector)).toEqual({
      ok: false,
      reason: 'invalid-halts',
    });
    expect(decideScopedHalt(validRoot({ actorKind: 'operator', requested, halts: [{ scope: 'planet', id: 'x', halted: true, imposedBy: 'operator' }] }), detector)).toEqual({
      ok: false,
      reason: 'invalid-halts',
      dispatchHalted: true,
    });
    // target: missing and blank values.
    const targetRoot = validRoot({ actorKind: 'org-admin', actorOrganizationId: 'org1', requested, halts: [] });
    expect(decideScopedHalt(targetRoot, detector)).toEqual({ ok: false, reason: 'invalid-target', dispatchHalted: true });
    expect(
      decideScopedHalt(validRoot({ actorKind: 'org-admin', actorOrganizationId: 'org1', requested, halts: [], target: { organizationId: 'org1', cellId: '  ' } }), detector),
    ).toEqual({ ok: false, reason: 'invalid-target', dispatchHalted: true });
    // Blank actorOrganizationId with valid halts/target: non-structural reason,
    // so dispatchHalted carries the evaluated state.
    const blankActor = validRoot({ actorKind: 'org-admin', actorOrganizationId: '', requested, halts: [], target: { organizationId: 'org1', cellId: 'cell1' } });
    expect(decideScopedHalt(blankActor, detector)).toEqual({ ok: false, reason: 'invalid-actor-organization', dispatchHalted: false });
  });
});

describe('decideHaltRequest permissions', () => {
  it('operator can halt and lift org, cell, and global when confirmed', () => {
    const halts = [entry('global', null, true, 'operator')];
    expect(decideHaltRequest(validRoot({ actorKind: 'operator', requested: { scope: 'org', id: 'org1', halted: true }, halts }), detector)).toEqual({
      ok: true,
      scope: 'org',
      id: 'org1',
      halted: true,
      imposedBy: 'operator',
    });
    expect(decideHaltRequest(validRoot({ actorKind: 'operator', requested: { scope: 'cell', id: 'cell1', halted: true }, halts }), detector)).toEqual({
      ok: true,
      scope: 'cell',
      id: 'cell1',
      halted: true,
      imposedBy: 'operator',
    });
    expect(decideHaltRequest(validRoot({ actorKind: 'operator', requested: { scope: 'global', halted: true }, halts }), detector)).toEqual({
      ok: true,
      scope: 'global',
      halted: true,
      imposedBy: 'operator',
    });
    // Lifting its own org-admin-imposed org halt is a permit, with no id for global.
    const ownHalt = [entry('org', 'org1', true, 'org-admin')];
    expect(decideHaltRequest(validRoot({ actorKind: 'operator', requested: { scope: 'global', halted: false, confirmGlobalLift: true }, halts: ownHalt }), detector)).toEqual({
      ok: true,
      scope: 'global',
      halted: false,
      imposedBy: 'operator',
    });
  });

  it('org-admin cannot halt or lift a cell, global, or another org', () => {
    const base = { actorKind: 'org-admin', actorOrganizationId: 'org1', halts: [] as unknown[] };
    expect(decideHaltRequest(validRoot({ ...base, requested: { scope: 'cell', id: 'cell1', halted: true } }), detector)).toEqual({ ok: false, reason: 'not-permitted' });
    expect(decideHaltRequest(validRoot({ ...base, requested: { scope: 'global', halted: true } }), detector)).toEqual({ ok: false, reason: 'not-permitted' });
    expect(decideHaltRequest(validRoot({ ...base, requested: { scope: 'org', id: 'org2', halted: true } }), detector)).toEqual({ ok: false, reason: 'not-permitted' });
  });

  it('org-admin cannot lift an operator-imposed halt on its own org', () => {
    const input = validRoot({
      actorKind: 'org-admin',
      actorOrganizationId: 'org1',
      requested: { scope: 'org', id: 'org1', halted: false },
      halts: [entry('org', 'org1', true, 'operator')],
    });
    expect(decideHaltRequest(input, detector)).toEqual({ ok: false, reason: 'not-permitted' });
  });

  it('operator global lift requires confirmGlobalLift true', () => {
    for (const confirm of [undefined, false]) {
      const requested = confirm === undefined
        ? { scope: 'global', halted: false }
        : { scope: 'global', halted: false, confirmGlobalLift: false };
      const input = validRoot({
        actorKind: 'operator',
        requested,
        halts: [entry('global', null, true, 'operator')],
      });
      expect(decideHaltRequest(input, detector)).toEqual({ ok: false, reason: 'global-lift-confirmation-required' });
      const decision = decideScopedHalt(
        validRoot({ ...input as Record<string, unknown>, target: { organizationId: 'org1', cellId: 'cell1' } }),
        detector,
      );
      expect(decision).toEqual({ ok: false, reason: 'global-lift-confirmation-required', dispatchHalted: true });
    }
  });
});

describe('isDispatchHalted', () => {
  const org1 = { organizationId: 'org1', cellId: 'cell1' };
  const org2 = { organizationId: 'org2', cellId: 'cell1' };
  const otherCell = { organizationId: 'org1', cellId: 'cell2' };

  it('org halt blocks only its own org and never another org', () => {
    const halts = [entry('org', 'org1', true, 'operator')];
    expect(isDispatchHalted(halts, org1, detector)).toBe(true);
    expect(isDispatchHalted(halts, org2, detector)).toBe(false);
  });

  it('cell halt blocks every org in that cell and not other cells', () => {
    const halts = [entry('cell', 'cell1', true, 'operator')];
    expect(isDispatchHalted(halts, org1, detector)).toBe(true);
    expect(isDispatchHalted(halts, org2, detector)).toBe(true);
    expect(isDispatchHalted(halts, otherCell, detector)).toBe(false);
  });

  it('global halt blocks all targets', () => {
    const halts = [entry('global', null, true, 'operator')];
    expect(isDispatchHalted(halts, org1, detector)).toBe(true);
    expect(isDispatchHalted(halts, org2, detector)).toBe(true);
    expect(isDispatchHalted(halts, otherCell, detector)).toBe(true);
  });

  it('duplicate or contradictory entries for one scope resolve to halted when any says halted', () => {
    const halts = [
      entry('org', 'org1', false, 'org-admin'),
      entry('org', 'org1', true, 'org-admin'),
      entry('org', 'org1', false, 'operator'),
    ];
    expect(isDispatchHalted(halts, org1, detector)).toBe(true);
  });

  it('reads not-halted entries as clear, and a lift entry alone never blocks', () => {
    expect(isDispatchHalted([entry('global', null, false, 'operator')], org1, detector)).toBe(false);
    expect(isDispatchHalted([], org1, detector)).toBe(false);
  });

  it('refuses halts array exceeding 1000 entries by failing closed to halted true and invalid-halts', () => {
    const halts = Array.from({ length: MAX_SCOPED_HALTS + 1 }, () => entry('org', 'org1', true, 'operator'));
    expect(isDispatchHalted(halts, org1, detector)).toBe(true);
    const root = validRoot({ actorKind: 'operator', requested: { scope: 'org', id: 'org1', halted: true }, halts });
    expect(decideHaltRequest(root, detector)).toEqual({ ok: false, reason: 'invalid-halts' });
    expect(
      decideScopedHalt(validRoot({ ...root as Record<string, unknown>, target: org1 }), detector),
    ).toEqual({ ok: false, reason: 'invalid-halts', dispatchHalted: true });
    // An O(1) length bound: even a lying length far past 2**32 - 1 is refused
    // before enumerating a single key.
    const lying = new Proxy([], {
      getOwnPropertyDescriptor(t, prop) {
        const descriptor = Reflect.getOwnPropertyDescriptor(t, prop);
        if (prop === 'length' && descriptor !== undefined) {
          return { ...descriptor, value: 2 ** 32 - 1 };
        }
        return descriptor;
      },
    });
    expect(isDispatchHalted(lying, org1, detector)).toBe(true);
  });

  it('refuses sparse halts array with holes by failing closed to halted true', () => {
    const halts: unknown[] = [entry('org', 'org1', true, 'operator')];
    halts.length = 2;
    expect(isDispatchHalted(halts, org1, detector)).toBe(true);
    expect(decideHaltRequest(validRoot({ actorKind: 'operator', requested: { scope: 'org', id: 'org1', halted: true }, halts }), detector)).toEqual({
      ok: false,
      reason: 'invalid-halts',
    });
  });
});

describe('decideScopedHalt permit and target hostile shapes', () => {
  const requested = { scope: 'org', id: 'org1', halted: true };
  const target = { organizationId: 'org1', cellId: 'cell1' };

  it('permits a valid request and reports the evaluated dispatch state alongside the decision', () => {
    expect(
      decideScopedHalt(validRoot({ actorKind: 'org-admin', actorOrganizationId: 'org1', requested, halts: [], target }), detector),
    ).toEqual({
      ok: true,
      requestDecision: { scope: 'org', id: 'org1', halted: true, imposedBy: 'org-admin' },
      dispatchHalted: false,
    });
    expect(
      decideScopedHalt(
        validRoot({ actorKind: 'operator', requested: { scope: 'global', halted: true }, halts: [entry('cell', 'cell1', true, 'operator')], target }),
        detector,
      ),
    ).toEqual({ ok: true, requestDecision: { scope: 'global', halted: true, imposedBy: 'operator' }, dispatchHalted: true });
  });

  it('refuses a target with an extra key, an own polluting key, a symbol key, or a non-enumerable key by failing closed', () => {
    const base = { actorKind: 'operator', requested, halts: [] as unknown[] };
    const withExtra = { ...target, note: 'extra' };
    expect(decideScopedHalt(validRoot({ ...base, target: withExtra }), detector)).toEqual({ ok: false, reason: 'invalid-target', dispatchHalted: true });
    const withProto = { ...target };
    Object.defineProperty(withProto, '__proto__', { value: 1, enumerable: true, configurable: true });
    expect(decideScopedHalt(validRoot({ ...base, target: withProto }), detector)).toEqual({ ok: false, reason: 'invalid-target', dispatchHalted: true });
    const withSymbol: Record<string | symbol, unknown> = { ...target };
    withSymbol[Symbol('k')] = 1;
    expect(decideScopedHalt(validRoot({ ...base, target: withSymbol }), detector)).toEqual({ ok: false, reason: 'invalid-target', dispatchHalted: true });
    const hidden = { ...target };
    Object.defineProperty(hidden, 'hidden', { value: 1, enumerable: false, configurable: true });
    expect(decideScopedHalt(validRoot({ ...base, target: hidden }), detector)).toEqual({ ok: false, reason: 'invalid-target', dispatchHalted: true });
    // The standalone check fails closed on the same shapes.
    expect(isDispatchHalted([], withExtra, detector)).toBe(true);
    expect(isDispatchHalted([], withProto, detector)).toBe(true);
    expect(isDispatchHalted([], withSymbol, detector)).toBe(true);
    expect(isDispatchHalted([], hidden, detector)).toBe(true);
  });

  it('refuses a halt entry with a symbol key, a non-enumerable key, or an extra key by failing closed to halted true', () => {
    const symbolEntry: Record<string | symbol, unknown> = { scope: 'org', id: 'org9', halted: false, imposedBy: 'operator' };
    symbolEntry[Symbol('k')] = 1;
    const hiddenEntry = { scope: 'org', id: 'org9', halted: false, imposedBy: 'operator' };
    Object.defineProperty(hiddenEntry, 'hidden', { value: 1, enumerable: false, configurable: true });
    const extraEntry = { scope: 'org', id: 'org9', halted: false, imposedBy: 'operator', note: 'x' };
    for (const bad of [symbolEntry, hiddenEntry, extraEntry]) {
      expect(isDispatchHalted([bad], target, detector)).toBe(true);
      expect(decideHaltRequest(validRoot({ actorKind: 'operator', requested, halts: [bad] }), detector)).toEqual({ ok: false, reason: 'invalid-halts' });
    }
  });

  it('refuses a Proxy nested in halts or target using the detector, failing closed', () => {
    const proxiedTarget = new Proxy({ ...target }, {});
    expect(isDispatchHalted([], proxiedTarget, detector)).toBe(true);
    const proxiedEntry = new Proxy(entry('org', 'org9', false, 'operator') as object, {});
    expect(isDispatchHalted([proxiedEntry], target, detector)).toBe(true);
    expect(decideScopedHalt(validRoot({ actorKind: 'operator', requested, halts: [], target: proxiedTarget }), detector)).toEqual({
      ok: false,
      reason: 'invalid-target',
      dispatchHalted: true,
    });
  });
});
