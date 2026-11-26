/**
 * FC17D hostile-input and behaviour tests for the pure scoped-halt decider:
 * every function takes `unknown`, never throws, and every refusal is the
 * typed reason — a malformed or hostile read is never an implicit pass, and
 * the dispatch gate always fails closed to `true` (halted).
 */

import { types } from 'node:util';
import { describe, expect, it } from 'vitest';

import {
  MAX_SCOPED_HALTS,
  decideHaltRequest,
  decideScopedHalt,
  isDispatchHalted,
} from '../scoped-halt.js';

/** A revoked Proxy throws on every trap, including [[GetPrototypeOf]]. */
function revokedProxy(): unknown {
  const { proxy, revoke } = Proxy.revocable({}, {});
  revoke();
  return proxy;
}

/**
 * Every call passes the trusted `types.isProxy` detector explicitly: the
 * deciders have no permissive default, so a snapshot can never be taken
 * without one.
 */
function haltRequest(input: unknown) {
  return decideHaltRequest(input, types.isProxy);
}

function scopedHalt(input: unknown) {
  return decideScopedHalt(input, types.isProxy);
}

function dispatchHalted(halts: unknown, target: unknown): boolean {
  return isDispatchHalted(halts, target, types.isProxy);
}

const ORG_A = 'org-a-1111';
const ORG_B = 'org-b-2222';
const CELL_1 = 'cell-1-3333';
const CELL_2 = 'cell-2-4444';

function orgEntry(halted: boolean, imposedBy: 'org-admin' | 'operator' = 'operator'): unknown {
  return { scope: 'org', id: ORG_A, halted, imposedBy };
}

function cellEntry(cellId: string, halted: boolean): unknown {
  return { scope: 'cell', id: cellId, halted, imposedBy: 'operator' };
}

function globalEntry(halted: boolean): unknown {
  return { scope: 'global', halted, imposedBy: 'operator' };
}

function orgAdminRequest(overrides: {
  scope?: string;
  id?: string | undefined;
  halted?: boolean;
  confirmGlobalLift?: boolean;
  omitId?: boolean;
}): Record<string, unknown> {
  return {
    actorKind: 'org-admin',
    actorOrganizationId: ORG_A,
    requested: {
      scope: overrides.scope ?? 'org',
      ...(overrides.omitId ? {} : overrides.id === undefined ? { id: ORG_A } : { id: overrides.id }),
      halted: overrides.halted ?? true,
      ...(overrides.confirmGlobalLift === undefined ? {} : { confirmGlobalLift: overrides.confirmGlobalLift }),
    },
    halts: [],
  };
}

function operatorRequest(overrides: {
  scope?: string;
  id?: string;
  halted?: boolean;
  confirmGlobalLift?: boolean;
  omitId?: boolean;
}): Record<string, unknown> {
  return {
    actorKind: 'operator',
    requested: {
      scope: overrides.scope ?? 'org',
      ...(overrides.omitId ? {} : { id: overrides.id ?? ORG_A }),
      halted: overrides.halted ?? true,
      ...(overrides.confirmGlobalLift === undefined ? {} : { confirmGlobalLift: overrides.confirmGlobalLift }),
    },
    halts: [],
  };
}

const TARGET_A = { organizationId: ORG_A, cellId: CELL_1 };
const TARGET_B = { organizationId: ORG_B, cellId: CELL_2 };

describe('decideHaltRequest', () => {
  it('refuses revoked Proxy and Proxy detected by types.isProxy without echoing ids', () => {
    const hostile = () => ({
      actorKind: 'org-admin',
      actorOrganizationId: ORG_A,
      requested: { scope: 'org', id: ORG_A, halted: true },
      halts: [],
    });
    const seen = JSON.stringify(haltRequest(revokedProxy()));
    expect(seen).not.toContain(ORG_A);
    const proxied = new Proxy(hostile(), {});
    expect(types.isProxy(proxied)).toBe(true);
    const result = haltRequest(proxied);
    expect(result).toEqual({ ok: false, reason: 'invalid-input' });
    expect(JSON.stringify(result)).not.toContain(ORG_A);
  });

  it('fails closed when no detector is supplied: a non-function or omitted isProxy refuses or reports halted', () => {
    const clean = () => ({
      actorKind: 'org-admin',
      actorOrganizationId: ORG_A,
      requested: { scope: 'org', id: ORG_A, halted: true },
      halts: [],
    });
    // A JS caller bypassing the required-parameter type passes undefined.
    expect(decideHaltRequest(clean(), undefined as never)).toEqual({
      ok: false,
      reason: 'invalid-input',
    });
    expect(decideScopedHalt(clean(), undefined as never)).toEqual({
      ok: false,
      reason: 'invalid-input',
      dispatchHalted: true,
    });
    expect(isDispatchHalted([orgEntry(true)], TARGET_A, undefined as never)).toBe(true);
    expect(isDispatchHalted([orgEntry(true)], TARGET_A, () => true)).toBe(true);
    // Even a permissive constant detector cannot hide the halt itself: with
    // the trusted detector the same input halts dispatch by content.
    expect(dispatchHalted([orgEntry(true)], TARGET_A)).toBe(true);
  });

  it('refuses null, undefined, primitives, non-iterables, array-likes, and wrong prototypes', () => {
    for (const bad of [null, undefined, 7, 'x', true, { length: 1, 0: 2 }, () => 1, new Date(), Object.setPrototypeOf({}, Array.prototype)]) {
      expect(haltRequest(bad)).toEqual({ ok: false, reason: 'invalid-input' });
    }
  });

  it('refuses halts array exceeding 1000 entries by failing closed to halted true and invalid-halts', () => {
    const many: unknown[] = Array.from({ length: MAX_SCOPED_HALTS + 1 }, () => orgEntry(true));
    expect(dispatchHalted(many, TARGET_A)).toBe(true);
    const request = orgAdminRequest({});
    (request as Record<string, unknown>).halts = many;
    expect(haltRequest(request)).toEqual({ ok: false, reason: 'invalid-halts' });
  });

  it('refuses sparse halts array with holes by failing closed to halted true', () => {
    const sparse: unknown[] = [orgEntry(true), orgEntry(false)];
    delete sparse[1];
    expect(dispatchHalted(sparse, TARGET_A)).toBe(true);
    const request = orgAdminRequest({});
    (request as Record<string, unknown>).halts = sparse;
    expect(haltRequest(request)).toEqual({ ok: false, reason: 'invalid-halts' });
  });

  it('refuses getter properties without invoking them', () => {
    let getterRuns = 0;
    const entry = Object.defineProperty({ scope: 'org', id: ORG_A, halted: true, imposedBy: 'operator' }, 'halted', {
      get() {
        getterRuns += 1;
        return false;
      },
      enumerable: true,
      configurable: true,
    });
    expect(dispatchHalted([entry], TARGET_A)).toBe(true);
    expect(getterRuns).toBe(0);
    const request = orgAdminRequest({});
    (request as Record<string, unknown>).halts = [entry];
    expect(haltRequest(request)).toEqual({ ok: false, reason: 'invalid-halts' });
    expect(getterRuns).toBe(0);
  });

  it('refuses prototype-polluting, symbol, and extra unknown keys', () => {
    const polluting: Record<string, unknown> = { scope: 'org', id: ORG_A, halted: true, imposedBy: 'operator' };
    Object.defineProperty(polluting, '__proto__', { value: null, enumerable: true, configurable: true });
    expect(dispatchHalted([polluting], TARGET_A)).toBe(true);
    const withSymbol: Record<string, unknown> = { scope: 'org', id: ORG_A, halted: true, imposedBy: 'operator' };
    const symbolKey = Symbol('extra');
    Object.defineProperty(withSymbol, symbolKey, { value: 1, enumerable: true, configurable: true });
    expect(dispatchHalted([withSymbol], TARGET_A)).toBe(true);
    const extra = { scope: 'org', id: ORG_A, halted: true, imposedBy: 'operator', note: 'extra' };
    expect(dispatchHalted([extra], TARGET_A)).toBe(true);
    const rootExtra = { ...orgAdminRequest({}), extra: 1 };
    expect(haltRequest(rootExtra)).toEqual({ ok: false, reason: 'invalid-input' });
    const requestedExtra = orgAdminRequest({});
    (requestedExtra as Record<string, unknown>).requested = {
      scope: 'org', id: ORG_A, halted: true, note: 'extra',
    };
    expect(haltRequest(requestedExtra)).toEqual({ ok: false, reason: 'invalid-request' });
  });

  it('refuses malformed actor, actorOrganizationId, requested, halts, and target with exact path reasons and fail-closed dispatchHalted', () => {
    // Root null and root refusals map to invalid-input.
    expect(scopedHalt(null)).toEqual({ ok: false, reason: 'invalid-input', dispatchHalted: true });
    // Missing actorKind: its own field's reason.
    const noActor = { requested: { scope: 'org', id: ORG_A, halted: true }, halts: [orgEntry(true)] };
    expect(haltRequest(noActor)).toEqual({ ok: false, reason: 'invalid-actor' });
    expect(scopedHalt(noActor)).toEqual({ ok: false, reason: 'invalid-actor', dispatchHalted: true });
    expect(haltRequest({})).toEqual({ ok: false, reason: 'invalid-actor' });
    // Bad actorKind value.
    const badActor = { ...noActor, actorKind: 'root' };
    expect(haltRequest(badActor)).toEqual({ ok: false, reason: 'invalid-actor' });
    // Missing actorOrganizationId for org-admin.
    const noActorOrg = {
      actorKind: 'org-admin',
      requested: { scope: 'org', id: ORG_A, halted: true },
      halts: [],
    };
    expect(haltRequest(noActorOrg)).toEqual({ ok: false, reason: 'invalid-actor-organization' });
    // actorOrganizationId present for operator.
    const operatorWithOrg = {
      ...operatorRequest({}),
      actorOrganizationId: ORG_A,
    };
    expect(haltRequest(operatorWithOrg)).toEqual({ ok: false, reason: 'invalid-actor-organization' });
    // Blank actorOrganizationId.
    const blankOrg = {
      actorKind: 'org-admin',
      actorOrganizationId: '  ',
      requested: { scope: 'org', id: ORG_A, halted: true },
      halts: [],
    };
    expect(haltRequest(blankOrg)).toEqual({ ok: false, reason: 'invalid-actor-organization' });
    // Missing requested, bad scope, missing halted, bad id shape.
    expect(haltRequest({ actorKind: 'operator', halts: [] })).toEqual({ ok: false, reason: 'invalid-request' });
    const badScope = orgAdminRequest({ scope: 'zone' });
    expect(haltRequest(badScope)).toEqual({ ok: false, reason: 'invalid-request' });
    const noHalted = orgAdminRequest({});
    (noHalted as Record<string, unknown>).requested = { scope: 'org', id: ORG_A };
    expect(haltRequest(noHalted)).toEqual({ ok: false, reason: 'invalid-request' });
    const globalWithId = orgAdminRequest({ scope: 'global', id: ORG_A });
    expect(haltRequest(globalWithId)).toEqual({ ok: false, reason: 'invalid-request' });
    // Missing halts: its own field's reason.
    const noHalts = {
      actorKind: 'operator',
      requested: { scope: 'org', id: ORG_A, halted: true },
    };
    expect(haltRequest(noHalts)).toEqual({ ok: false, reason: 'invalid-halts' });
    // Non-array halts and missing imposedBy.
    expect(haltRequest({ actorKind: 'operator', requested: { scope: 'org', id: ORG_A, halted: true }, halts: 'nope' })).toEqual({ ok: false, reason: 'invalid-halts' });
    const noImposedBy = { scope: 'org', id: ORG_A, halted: true };
    expect(haltRequest({ actorKind: 'operator', requested: { scope: 'org', id: ORG_A, halted: true }, halts: [noImposedBy] })).toEqual({ ok: false, reason: 'invalid-halts' });
    // decideScopedHalt target: missing, malformed, blank, extra key — invalid-target, dispatchHalted true.
    expect(scopedHalt({ actorKind: 'operator', requested: { scope: 'org', id: ORG_A, halted: true }, halts: [orgEntry(true)] })).toEqual({ ok: false, reason: 'invalid-target', dispatchHalted: true });
    const blankTarget = {
      actorKind: 'operator',
      requested: { scope: 'org', id: ORG_A, halted: true },
      halts: [],
      target: { organizationId: ORG_A, cellId: '' },
    };
    expect(scopedHalt(blankTarget)).toEqual({ ok: false, reason: 'invalid-target', dispatchHalted: true });
    // A getter inside requested is a snapshot refusal at 'requested...' with dispatchHalted true.
    let getterRuns = 0;
    const requestedWithGetter = Object.defineProperty(
      { scope: 'org', id: ORG_A, halted: true },
      'halted',
      {
        get() {
          getterRuns += 1;
          return false;
        },
        enumerable: true,
        configurable: true,
      },
    );
    const scopedGetterRequest = {
      actorKind: 'operator',
      requested: requestedWithGetter,
      halts: [],
      target: TARGET_A,
    };
    expect(scopedHalt(scopedGetterRequest)).toEqual({ ok: false, reason: 'invalid-request', dispatchHalted: true });
    expect(getterRuns).toBe(0);
    // A clean input with a refused permission reports the evaluated dispatch state, not fail-closed.
    const refusedWithCleanState = {
      actorKind: 'org-admin',
      actorOrganizationId: ORG_A,
      requested: { scope: 'global', halted: true },
      halts: [globalEntry(true)],
      target: TARGET_A,
    };
    expect(scopedHalt(refusedWithCleanState)).toEqual({ ok: false, reason: 'not-permitted', dispatchHalted: true });
    const refusedIdle = {
      ...refusedWithCleanState,
      halts: [],
      target: TARGET_A,
    };
    expect(scopedHalt(refusedIdle)).toEqual({ ok: false, reason: 'not-permitted', dispatchHalted: false });
  });

  it('org-admin cannot halt or lift a cell, global, or another org', () => {
    expect(haltRequest(orgAdminRequest({ scope: 'cell', id: CELL_1 }))).toEqual({ ok: false, reason: 'not-permitted' });
    expect(haltRequest(orgAdminRequest({ scope: 'global', omitId: true }))).toEqual({ ok: false, reason: 'not-permitted' });
    expect(haltRequest(orgAdminRequest({ scope: 'org', id: ORG_B }))).toEqual({ ok: false, reason: 'not-permitted' });
    expect(haltRequest(orgAdminRequest({ scope: 'cell', id: CELL_1, halted: false }))).toEqual({ ok: false, reason: 'not-permitted' });
  });

  it('org-admin cannot lift an operator-imposed halt on its own org', () => {
    const lifting = orgAdminRequest({ halted: false });
    (lifting as Record<string, unknown>).halts = [orgEntry(true, 'operator')];
    expect(haltRequest(lifting)).toEqual({ ok: false, reason: 'not-permitted' });
    // But it can lift its own org-admin-imposed halt.
    const ownLift = orgAdminRequest({ halted: false });
    (ownLift as Record<string, unknown>).halts = [orgEntry(true, 'org-admin')];
    expect(haltRequest(ownLift)).toEqual({
      ok: true,
      scope: 'org',
      id: ORG_A,
      halted: false,
      imposedBy: 'org-admin',
    });
  });

  it('operator global lift requires confirmGlobalLift true', () => {
    const lift = operatorRequest({ scope: 'global', omitId: true, halted: false });
    expect(haltRequest(lift)).toEqual({ ok: false, reason: 'global-lift-confirmation-required' });
    expect(haltRequest({ ...lift, requested: { scope: 'global', halted: false, confirmGlobalLift: 'yes' } })).toEqual({ ok: false, reason: 'invalid-request' });
    expect(haltRequest({ ...lift, requested: { scope: 'global', halted: false, confirmGlobalLift: true } })).toEqual({
      ok: true,
      scope: 'global',
      halted: false,
      imposedBy: 'operator',
    });
  });

  it('operator can halt and lift org, cell, and global when confirmed', () => {
    expect(haltRequest(operatorRequest({ scope: 'org', id: ORG_A, halted: true }))).toEqual({
      ok: true, scope: 'org', id: ORG_A, halted: true, imposedBy: 'operator',
    });
    expect(haltRequest(operatorRequest({ scope: 'org', id: ORG_A, halted: false }))).toEqual({
      ok: true, scope: 'org', id: ORG_A, halted: false, imposedBy: 'operator',
    });
    expect(haltRequest(operatorRequest({ scope: 'cell', id: CELL_1, halted: true }))).toEqual({
      ok: true, scope: 'cell', id: CELL_1, halted: true, imposedBy: 'operator',
    });
    expect(haltRequest(operatorRequest({ scope: 'cell', id: CELL_1, halted: false }))).toEqual({
      ok: true, scope: 'cell', id: CELL_1, halted: false, imposedBy: 'operator',
    });
    expect(haltRequest(operatorRequest({ scope: 'global', omitId: true, halted: true }))).toEqual({
      ok: true, scope: 'global', halted: true, imposedBy: 'operator',
    });
    expect(haltRequest(operatorRequest({ scope: 'global', omitId: true, halted: false, confirmGlobalLift: true }))).toEqual({
      ok: true, scope: 'global', halted: false, imposedBy: 'operator',
    });
    // A global permit result omits id entirely.
    const globalPermit = haltRequest(operatorRequest({ scope: 'global', omitId: true, halted: true }));
    expect(Object.hasOwn(globalPermit, 'id')).toBe(false);
  });

  it('reports both a permitted request and the evaluated dispatch state (decideScopedHalt)', () => {
    const request = {
      actorKind: 'operator',
      requested: { scope: 'cell', id: CELL_1, halted: true },
      halts: [globalEntry(true)],
      target: TARGET_A,
    };
    expect(scopedHalt(request)).toEqual({
      ok: true,
      requestDecision: { scope: 'cell', id: CELL_1, halted: true, imposedBy: 'operator' },
      dispatchHalted: true,
    });
    const idle = { ...request, halts: [] };
    expect(scopedHalt(idle)).toEqual({
      ok: true,
      requestDecision: { scope: 'cell', id: CELL_1, halted: true, imposedBy: 'operator' },
      dispatchHalted: false,
    });
  });
});

describe('isDispatchHalted', () => {
  it('org halt blocks only its own org and never another org', () => {
    expect(dispatchHalted([orgEntry(true)], TARGET_A)).toBe(true);
    expect(dispatchHalted([orgEntry(true)], TARGET_B)).toBe(false);
    expect(dispatchHalted([orgEntry(true), orgEntry(false)], TARGET_A)).toBe(true);
    expect(dispatchHalted([{ scope: 'org', id: ORG_B, halted: true, imposedBy: 'operator' }], TARGET_A)).toBe(false);
  });

  it('cell halt blocks every org in that cell and not other cells', () => {
    expect(dispatchHalted([cellEntry(CELL_1, true)], { organizationId: ORG_A, cellId: CELL_1 })).toBe(true);
    expect(dispatchHalted([cellEntry(CELL_1, true)], { organizationId: ORG_B, cellId: CELL_1 })).toBe(true);
    expect(dispatchHalted([cellEntry(CELL_1, true)], TARGET_B)).toBe(false);
    expect(dispatchHalted([cellEntry(CELL_1, false)], TARGET_A)).toBe(false);
  });

  it('global halt blocks all targets', () => {
    expect(dispatchHalted([globalEntry(true)], TARGET_A)).toBe(true);
    expect(dispatchHalted([globalEntry(true)], TARGET_B)).toBe(true);
    expect(dispatchHalted([{ scope: 'global', halted: false, imposedBy: 'operator' }], TARGET_A)).toBe(false);
  });

  it('duplicate or contradictory entries for one scope resolve to halted when any says halted', () => {
    expect(dispatchHalted([orgEntry(false), orgEntry(true)], TARGET_A)).toBe(true);
    expect(dispatchHalted([globalEntry(false), globalEntry(true)], TARGET_B)).toBe(true);
    expect(dispatchHalted([cellEntry(CELL_1, false), cellEntry(CELL_1, true)], TARGET_A)).toBe(true);
    expect(dispatchHalted([orgEntry(false), orgEntry(false)], TARGET_A)).toBe(false);
  });

  it('refuses malformed targets by failing closed to halted true', () => {
    for (const badTarget of [null, undefined, 7, {}, { organizationId: ORG_A }, { organizationId: ORG_A, cellId: CELL_1, extra: 1 }, { organizationId: ORG_A, cellId: 5 }]) {
      expect(dispatchHalted([orgEntry(true)], badTarget)).toBe(true);
    }
    expect(dispatchHalted('nope', TARGET_A)).toBe(true);
    expect(dispatchHalted([orgEntry(true)], revokedProxy())).toBe(true);
    expect(dispatchHalted(revokedProxy(), TARGET_A)).toBe(true);
  });
});
