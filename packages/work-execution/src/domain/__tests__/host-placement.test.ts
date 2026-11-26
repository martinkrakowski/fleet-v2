import { describe, expect, it } from 'vitest';

import {
  decideHostPlacement,
  MAX_PLACEMENT_HOSTS,
  type HostPlacementDecision,
} from '../host-placement.js';

/** A deep-frozen plain host candidate built at runtime from neutral parts. */
function host(
  hostId: string,
  maxSlots: number,
  usedSlots: number,
  schedulable: boolean,
): Record<string, unknown> {
  return Object.freeze({
    hostId: 'host-' + hostId,
    maxSlots,
    usedSlots,
    schedulable,
  });
}

/** A deep-frozen plain request built at runtime. */
function request(runId: string, preferredHostId?: string): Record<string, unknown> {
  const record: Record<string, unknown> = { runId: 'run-' + runId };
  if (preferredHostId !== undefined) {
    record.preferredHostId = 'host-' + preferredHostId;
  }
  return Object.freeze(record);
}

function deepFreezeAll(value: unknown): unknown {
  if (value !== null && typeof value === 'object') {
    Object.freeze(value);
    for (const key of Object.keys(value)) {
      deepFreezeAll((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}

function place(hosts: readonly Record<string, unknown>[], req: Record<string, unknown>): HostPlacementDecision {
  const frozenHosts = Object.freeze([...hosts].map(deepFreezeAll));
  return decideHostPlacement(frozenHosts, deepFreezeAll(req));
}

/** A host that has room and is schedulable, named by suffix. */
const FREE_A = () => host('a', 4, 1, true);

describe('decideHostPlacement', () => {
  it('places on the eligible host with most free slots and breaks ties by hostId ascending', () => {
    // host-b has more free slots: 5 free vs 2 free.
    const result = place([host('a', 4, 2, true), host('b', 8, 3, true)], request('1'));
    expect(result).toEqual({ outcome: 'placed', hostId: 'host-b' });
    // Equal free slots: tie broken by hostId ascending (host-a wins over host-b).
    const tied = place([host('b', 4, 1, true), host('a', 4, 1, true)], request('1'));
    expect(tied).toEqual({ outcome: 'placed', hostId: 'host-a' });
  });

  it('places on preferredHostId when eligible even if another host has more free slots', () => {
    const result = place([host('a', 4, 0, true), host('b', 64, 0, true)], request('1', 'a'));
    expect(result).toEqual({ outcome: 'placed', hostId: 'host-a' });
  });

  it('ignores preferredHostId when unschedulable or full and selects best eligible host', () => {
    // Preferred host is not schedulable: preference ignored, best eligible wins.
    const unschedulable = place(
      [host('p', 8, 0, false), host('a', 4, 0, true)],
      request('1', 'p'),
    );
    expect(unschedulable).toEqual({ outcome: 'placed', hostId: 'host-a' });
    // Preferred host is full: preference ignored, best eligible wins.
    const full = place(
      [host('p', 2, 2, true), host('a', 4, 0, true)],
      request('1', 'p'),
    );
    expect(full).toEqual({ outcome: 'placed', hostId: 'host-a' });
    // Preferred host is absent: normal selection.
    const absent = place([host('a', 4, 0, true), host('b', 4, 0, true)], request('1', 'zz'));
    expect(absent).toEqual({ outcome: 'placed', hostId: 'host-a' });
  });

  it('produces identical placement regardless of hosts input order and never mutates deep-frozen inputs', () => {
    const hosts1 = [host('a', 4, 1, true), host('b', 6, 1, true), host('c', 3, 0, true)];
    const hosts2 = [host('c', 3, 0, true), host('b', 6, 1, true), host('a', 4, 1, true)];
    expect(place(hosts1, request('1'))).toEqual(place(hosts2, request('1')));
    // The inputs are still frozen and structurally unchanged after the call.
    expect(Object.isFrozen(hosts1[0])).toBe(true);
    expect(hosts1[0]).toEqual({ hostId: 'host-a', maxSlots: 4, usedSlots: 1, schedulable: true });
  });

  it('parked result carries no hostId and no slot-bearing or reservation field', () => {
    const result = place([], request('1'));
    expect(result).toEqual({ outcome: 'parked', reason: 'no-capacity' });
    if (result.outcome === 'parked') {
      expect(Object.keys(result).sort()).toEqual(['outcome', 'reason']);
      expect('hostId' in result).toBe(false);
      expect('slot' in result).toBe(false);
      expect('reservation' in result).toBe(false);
    }
  });

  it('parks as no-capacity on empty host list with no hostId or slot-bearing field', () => {
    expect(place([], request('1'))).toEqual({ outcome: 'parked', reason: 'no-capacity' });
  });

  it('parks as no-capacity when all hosts are full or unschedulable even if preferred', () => {
    const full = place([host('a', 2, 2, true), host('b', 1, 1, true)], request('1', 'a'));
    expect(full).toEqual({ outcome: 'parked', reason: 'no-capacity' });
    const unschedulable = place([host('a', 4, 0, false), host('b', 4, 4, true)], request('1', 'a'));
    expect(unschedulable).toEqual({ outcome: 'parked', reason: 'no-capacity' });
    // maxSlots 0 with usedSlots 0 is never eligible either.
    const zero = place([host('a', 0, 0, true)], request('1', 'a'));
    expect(zero).toEqual({ outcome: 'parked', reason: 'no-capacity' });
  });

  it('refuses non-array, null, undefined, primitive, array-like, sparse, getter-bearing, or Proxy hosts', () => {
    const req = request('1');
    expect(decideHostPlacement(null, req)).toEqual({ outcome: 'refused', reason: 'hosts:invalid' });
    expect(decideHostPlacement(undefined, req)).toEqual({ outcome: 'refused', reason: 'hosts:invalid' });
    expect(decideHostPlacement(42, req)).toEqual({ outcome: 'refused', reason: 'hosts:invalid' });
    expect(decideHostPlacement('hosts', req)).toEqual({ outcome: 'refused', reason: 'hosts:invalid' });
    // Plain object is not an array.
    expect(decideHostPlacement({}, req)).toEqual({ outcome: 'refused', reason: 'hosts:invalid' });
    // Array-like: length own property but not an Array.
    expect(decideHostPlacement({ length: 1, 0: FREE_A() }, req)).toEqual({
      outcome: 'refused',
      reason: 'hosts:invalid',
    });
    // Sparse array: a hole is not an own enumerable data property.
    const sparse: unknown[] = new Array(2);
    sparse[0] = FREE_A();
    expect(decideHostPlacement(sparse, req)).toEqual({ outcome: 'refused', reason: 'hosts:invalid' });
    // Accessor length.
    const getterLength: unknown = { get length() { return 1; }, 0: FREE_A() };
    expect(decideHostPlacement(getterLength, req)).toEqual({ outcome: 'refused', reason: 'hosts:invalid' });
    // Array with a symbol key.
    const symbolKeyed: unknown[] = [FREE_A()];
    (symbolKeyed as unknown as Record<symbol, unknown>)[Symbol('extra')] = true;
    expect(decideHostPlacement(symbolKeyed, req)).toEqual({ outcome: 'refused', reason: 'hosts:invalid' });
    // Array with an extra named property.
    const extraProp = [FREE_A()] as unknown[] & { extra?: unknown };
    extraProp.extra = true;
    expect(decideHostPlacement(extraProp, req)).toEqual({ outcome: 'refused', reason: 'hosts:invalid' });
    // Revoked Proxy: throws on any descriptor read, mapped to typed refusal.
    const revocable = Proxy.revocable([FREE_A()], {});
    revocable.revoke();
    expect(decideHostPlacement(revocable.proxy, req)).toEqual({ outcome: 'refused', reason: 'hosts:invalid' });
  });

  it('refuses hosts exceeding 1000 entries in O(1) length check', () => {
    // A genuinely long array whose length exceeds the cap, refused without
    // any per-element work.
    const long = new Array(MAX_PLACEMENT_HOSTS + 1);
    expect(decideHostPlacement(long, request('1'))).toEqual({
      outcome: 'refused',
      reason: 'hosts:too-many-entries',
    });
    // An array length of exactly the cap is not refused as too many (its
    // entries are then validated per the dense-array rules).
    const capped = new Array(MAX_PLACEMENT_HOSTS);
    expect(decideHostPlacement(capped, request('1'))).toEqual({
      outcome: 'refused',
      reason: 'hosts:invalid',
    });
    // A length reading near the 2**32 - 1 boundary is refused in O(1).
    const hugeLength = Object.defineProperty([], 'length', { value: 2 ** 32 - 2 });
    expect(decideHostPlacement(hugeLength, request('1'))).toEqual({
      outcome: 'refused',
      reason: 'hosts:too-many-entries',
    });
  });

  it('refuses malformed, non-plain, getter-bearing (never invoked), prototype-polluting, extra-key, or Proxy host entry', () => {
    const req = request('1');
    const expectInvalidRecord = (entry: unknown) => {
      expect(decideHostPlacement([entry], req)).toEqual({
        outcome: 'refused',
        reason: 'hosts[0]:invalid-record',
      });
    };
    expectInvalidRecord(null);
    expectInvalidRecord(undefined);
    expectInvalidRecord(7);
    expectInvalidRecord('host');
    // Non-plain prototype.
    class HostShape { hostId = 'host-a'; maxSlots = 1; usedSlots = 0; schedulable = true; }
    expectInvalidRecord(new HostShape());
    // Missing key.
    expectInvalidRecord({ hostId: 'host-a', maxSlots: 1, usedSlots: 0 });
    // Unknown extra key.
    expectInvalidRecord({ hostId: 'host-a', maxSlots: 1, usedSlots: 0, schedulable: true, extra: 1 });
    // Getter: never invoked — a throwing getter must still be refused, not thrown from.
    let getterRan = false;
    expectInvalidRecord({
      hostId: 'host-a',
      maxSlots: 1,
      usedSlots: 0,
      get schedulable() { getterRan = true; return true; },
    });
    expect(getterRan).toBe(false);
    // Prototype-polluting key.
    expectInvalidRecord({
      hostId: 'host-a',
      maxSlots: 1,
      usedSlots: 0,
      schedulable: true,
      __proto__: { polluted: true },
    });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expectInvalidRecord({ hostId: 'host-a', maxSlots: 1, usedSlots: 0, schedulable: true, constructor: null });
    expectInvalidRecord({ hostId: 'host-a', maxSlots: 1, usedSlots: 0, schedulable: true, prototype: null });
    // Symbol key.
    const symbolEntry = { hostId: 'host-a', maxSlots: 1, usedSlots: 0, schedulable: true };
    (symbolEntry as Record<symbol, unknown>)[Symbol('s')] = 1;
    expectInvalidRecord(symbolEntry);
    // Revoked Proxy entry.
    const revocable = Proxy.revocable(FREE_A(), {});
    revocable.revoke();
    expectInvalidRecord(revocable.proxy);
    // Index naming: a bad second entry is named hosts[1], not hosts[0].
    expect(decideHostPlacement([FREE_A(), null], req)).toEqual({
      outcome: 'refused',
      reason: 'hosts[1]:invalid-record',
    });
  });

  it('refuses invalid or empty hostId without echoing value', () => {
    const req = request('1');
    expect(decideHostPlacement([{ hostId: '', maxSlots: 1, usedSlots: 0, schedulable: true }], req)).toEqual({
      outcome: 'refused',
      reason: 'hosts[0].hostId:invalid',
    });
    expect(decideHostPlacement([{ hostId: '   ', maxSlots: 1, usedSlots: 0, schedulable: true }], req)).toEqual({
      outcome: 'refused',
      reason: 'hosts[0].hostId:invalid',
    });
    expect(decideHostPlacement([{ hostId: ' padded ', maxSlots: 1, usedSlots: 0, schedulable: true }], req)).toEqual({
      outcome: 'refused',
      reason: 'hosts[0].hostId:invalid',
    });
    expect(decideHostPlacement([{ hostId: 42, maxSlots: 1, usedSlots: 0, schedulable: true }], req)).toEqual({
      outcome: 'refused',
      reason: 'hosts[0].hostId:invalid',
    });
    // The refusal reason never carries the rejected value. The value is
    // built at runtime and is invalid because it is not trimmed.
    const badHostId = ' secret' + 'value ';
    const result = decideHostPlacement([{ hostId: badHostId, maxSlots: 1, usedSlots: 0, schedulable: true }], req);
    expect(result.outcome).toBe('refused');
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  it('refuses duplicate hostId', () => {
    const result = place([host('a', 4, 0, true), host('a', 8, 0, true)], request('1'));
    expect(result).toEqual({ outcome: 'refused', reason: 'hosts.hostId:duplicate' });
  });

  it('refuses negative, non-integer, or over-max slot counts', () => {
    const req = request('1');
    expect(decideHostPlacement([host('a', -1, 0, true)], req)).toEqual({
      outcome: 'refused',
      reason: 'hosts[0].maxSlots:invalid',
    });
    expect(decideHostPlacement([host('a', 1.5, 0, true)], req)).toEqual({
      outcome: 'refused',
      reason: 'hosts[0].maxSlots:invalid',
    });
    expect(decideHostPlacement([host('a', '4' as unknown as number, 0, true)], req)).toEqual({
      outcome: 'refused',
      reason: 'hosts[0].maxSlots:invalid',
    });
    expect(decideHostPlacement([host('a', 4, -1, true)], req)).toEqual({
      outcome: 'refused',
      reason: 'hosts[0].usedSlots:invalid',
    });
    expect(decideHostPlacement([host('a', 4, 0.5, true)], req)).toEqual({
      outcome: 'refused',
      reason: 'hosts[0].usedSlots:invalid',
    });
    expect(decideHostPlacement([host('a', 2, 3, true)], req)).toEqual({
      outcome: 'refused',
      reason: 'hosts[0].usedSlots:exceeds-maxSlots',
    });
  });

  it('refuses non-boolean schedulable', () => {
    const req = request('1');
    expect(decideHostPlacement([{ hostId: 'host-a', maxSlots: 1, usedSlots: 0, schedulable: 'yes' }], req)).toEqual({
      outcome: 'refused',
      reason: 'hosts[0].schedulable:invalid',
    });
    expect(decideHostPlacement([{ hostId: 'host-a', maxSlots: 1, usedSlots: 0, schedulable: 1 }], req)).toEqual({
      outcome: 'refused',
      reason: 'hosts[0].schedulable:invalid',
    });
  });

  it('refuses malformed, getter-bearing, prototype-polluting, extra-key, or Proxy request', () => {
    const hosts = [FREE_A()];
    const expectInvalid = (req: unknown) => {
      expect(decideHostPlacement(hosts, req)).toEqual({
        outcome: 'refused',
        reason: 'request:invalid',
      });
    };
    expectInvalid(null);
    expectInvalid(undefined);
    expectInvalid('run-1');
    expectInvalid([]);
    class ReqShape { runId = 'run-1'; }
    expectInvalid(new ReqShape());
    // Unknown extra key.
    expectInvalid({ runId: 'run-1', extra: true });
    // Getter on runId: never invoked.
    let getterRan = false;
    expectInvalid({ get runId() { getterRan = true; return 'run-1'; } });
    expect(getterRan).toBe(false);
    // Prototype-polluting key.
    expectInvalid({ runId: 'run-1', __proto__: { polluted: true } });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    // Symbol key.
    const symbolRequest = { runId: 'run-1' };
    (symbolRequest as Record<symbol, unknown>)[Symbol('s')] = 1;
    expectInvalid(symbolRequest);
    // Revoked Proxy.
    const revocable = Proxy.revocable({ runId: 'run-1' }, {});
    revocable.revoke();
    expectInvalid(revocable.proxy);
  });

  it('refuses invalid runId or preferredHostId', () => {
    const hosts = [FREE_A()];
    expect(decideHostPlacement(hosts, {})).toEqual({
      outcome: 'refused',
      reason: 'request.runId:invalid',
    });
    expect(decideHostPlacement(hosts, { runId: '   ' })).toEqual({
      outcome: 'refused',
      reason: 'request.runId:invalid',
    });
    expect(decideHostPlacement(hosts, { runId: 42 })).toEqual({
      outcome: 'refused',
      reason: 'request.runId:invalid',
    });
    expect(decideHostPlacement(hosts, { runId: 'run-1', preferredHostId: '' })).toEqual({
      outcome: 'refused',
      reason: 'request.preferredHostId:invalid',
    });
    expect(decideHostPlacement(hosts, { runId: 'run-1', preferredHostId: ' padded ' })).toEqual({
      outcome: 'refused',
      reason: 'request.preferredHostId:invalid',
    });
    expect(decideHostPlacement(hosts, { runId: 'run-1', preferredHostId: null })).toEqual({
      outcome: 'refused',
      reason: 'request.preferredHostId:invalid',
    });
  });
});
