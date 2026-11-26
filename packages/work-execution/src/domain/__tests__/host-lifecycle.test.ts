/**
 * FC8E2 hostile-input tests for `decideHostLifecycleAction`: every refusal is
 * the exact typed result, no getter ever runs, and a revoked `Proxy` never
 * throws out of the decider.
 */

import { describe, expect, it } from 'vitest';

import { decideHostLifecycleAction } from '../host-lifecycle.js';

/** A revoked Proxy throws on every trap, including [[GetPrototypeOf]]. */
function revokedProxy(): unknown {
  const { proxy, revoke } = Proxy.revocable({}, {});
  revoke();
  return proxy;
}

/** An object whose `state` key is a getter that would throw if it ever ran. */
function objectWithThrowingStateGetter(): unknown {
  return {
    get state(): never {
      throw new Error('getter must never run');
    },
  };
}

/** An object whose `state` is a getter placed on the prototype. */
function protoWithThrowingStateGetter(): unknown {
  const base = { get state(): never {
    throw new Error('getter must never run');
  } };
  return Object.create(base) as object;
}

describe('decideHostLifecycleAction', () => {
  it('returns a schedule action for a ready host whose desired state is schedule', () => {
    expect(decideHostLifecycleAction({ state: 'ready' }, 'schedule')).toEqual({ ok: true, action: 'schedule' });
  });

  it('returns a transition action for each of the three legal forward transitions', () => {
    expect(decideHostLifecycleAction({ state: 'provisioning' }, 'ready')).toEqual({
      ok: true,
      action: 'transition',
      from: 'provisioning',
      to: 'ready',
    });
    expect(decideHostLifecycleAction({ state: 'ready' }, 'draining')).toEqual({
      ok: true,
      action: 'transition',
      from: 'ready',
      to: 'draining',
    });
    expect(decideHostLifecycleAction({ state: 'draining' }, 'terminated')).toEqual({
      ok: true,
      action: 'transition',
      from: 'draining',
      to: 'terminated',
    });
  });

  it('refuses scheduling a draining, provisioning, or terminated host', () => {
    for (const state of ['provisioning', 'draining', 'terminated'] as const) {
      expect(decideHostLifecycleAction({ state }, 'schedule')).toEqual({ ok: false, reason: 'not-schedulable' });
    }
  });

  it('refuses all transitions out of terminated with terminated', () => {
    for (const desired of ['ready', 'draining', 'terminated'] as const) {
      expect(decideHostLifecycleAction({ state: 'terminated' }, desired)).toEqual({
        ok: false,
        reason: 'terminated',
      });
    }
  });

  it('refuses same-state and illegal state transitions with illegal-transition', () => {
    expect(decideHostLifecycleAction({ state: 'ready' }, 'ready')).toEqual({ ok: false, reason: 'illegal-transition' });
    expect(decideHostLifecycleAction({ state: 'draining' }, 'draining')).toEqual({
      ok: false,
      reason: 'illegal-transition',
    });
    expect(decideHostLifecycleAction({ state: 'ready' }, 'terminated')).toEqual({
      ok: false,
      reason: 'illegal-transition',
    });
    expect(decideHostLifecycleAction({ state: 'draining' }, 'ready')).toEqual({
      ok: false,
      reason: 'illegal-transition',
    });
    expect(decideHostLifecycleAction({ state: 'provisioning' }, 'draining')).toEqual({
      ok: false,
      reason: 'illegal-transition',
    });
    expect(decideHostLifecycleAction({ state: 'provisioning' }, 'terminated')).toEqual({
      ok: false,
      reason: 'illegal-transition',
    });
  });

  it('refuses hostile or unknown host and desired inputs with invalid-request without running getters', () => {
    const invalidHosts: readonly unknown[] = [
      null,
      undefined,
      7,
      'ready',
      true,
      [],
      ['state'],
      Object.create(null) as object, // array-like hole free but no state key
      revokedProxy(),
      objectWithThrowingStateGetter(),
      protoWithThrowingStateGetter(),
      { state: 'ready', extra: 1 }, // extra key
      JSON.parse('{"state":"ready","__proto__":{}}') as object, // own __proto__ key
      new Proxy({ state: 'ready' }, { getOwnPropertyDescriptor() {
        throw new Error('trap');
      } }),
    ];
    for (const host of invalidHosts) {
      expect(decideHostLifecycleAction(host, 'ready')).toEqual({ ok: false, reason: 'invalid-request' });
    }
    // Missing `state` key on a plain object.
    expect(decideHostLifecycleAction({}, 'ready')).toEqual({ ok: false, reason: 'invalid-request' });
    // Prototype-polluting keys in place of a data key.
    expect(decideHostLifecycleAction({ state: 'ready', constructor: 1 }, 'ready')).toEqual({
      ok: false,
      reason: 'invalid-request',
    });
    expect(decideHostLifecycleAction({ state: 'ready', prototype: 1 }, 'ready')).toEqual({
      ok: false,
      reason: 'invalid-request',
    });
    // Unknown state value.
    expect(decideHostLifecycleAction({ state: 'floating' }, 'ready')).toEqual({
      ok: false,
      reason: 'invalid-request',
    });
    expect(decideHostLifecycleAction({ state: null }, 'ready')).toEqual({ ok: false, reason: 'invalid-request' });
    // Unknown or hostile desired values.
    for (const desired of [null, undefined, 'fly', 3, {}, ['ready']]) {
      expect(decideHostLifecycleAction({ state: 'ready' }, desired)).toEqual({
        ok: false,
        reason: 'invalid-request',
      });
    }
    // `desired` is validated before `host` is read: a revoked Proxy as host
    // stays a typed refusal even with an unknown desired.
    expect(decideHostLifecycleAction(revokedProxy(), 'unknown')).toEqual({ ok: false, reason: 'invalid-request' });
  });
});
