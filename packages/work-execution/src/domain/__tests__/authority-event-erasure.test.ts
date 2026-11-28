/**
 * FC12H behaviour and hostile-input tests for the per-organisation erasure
 * module: `pseudonymiseActors` and `verifyEventChain` over chained authority
 * events. Every function takes `unknown`, never throws, and every refusal is
 * the typed reason — an unknown shape is never an implicit pass. Each test
 * title states what it asserts; the body proves it.
 */

import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';
import { types } from 'node:util';

import {
  buildChainedEvent,
  MAX_ERASURE_EVENTS,
  pseudonymiseActors,
  verifyEventChain,
  type ChainedEventInput,
  type Sha256HexFn,
} from '../authority-event-erasure.js';

/** A real SHA-256 helper: 64 lowercase hex characters per call. */
function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** A revoked Proxy throws on every trap, including [[GetPrototypeOf]]. */
function revokedProxy(): unknown {
  const { proxy, revoke } = Proxy.revocable({}, {});
  revoke();
  return proxy;
}

/** A Proxy whose traps record that they were reached (they never must be). */
function countingTrapProxy(): { proxy: unknown; traps: { get: number; ownKeys: number; getOwnPropertyDescriptor: number } } {
  const traps = { get: 0, ownKeys: 0, getOwnPropertyDescriptor: 0 };
  const proxy: unknown = new Proxy(
    { length: 1, 0: {} },
    {
      get() {
        traps.get += 1;
        return undefined;
      },
      ownKeys() {
        traps.ownKeys += 1;
        return Reflect.ownKeys({});
      },
      getOwnPropertyDescriptor(t, prop) {
        traps.getOwnPropertyDescriptor += 1;
        return Reflect.getOwnPropertyDescriptor(t, prop);
      },
    },
  );
  return { proxy, traps };
}
function baseInput(overrides: Partial<ChainedEventInput> = {}): ChainedEventInput {
  return {
    eventId: 'evt-1',
    kind: 'dispatch',
    actor: 'agent-7',
    organizationId: 'org-a',
    atIso: '2026-01-01T00:00:00.000Z',
    beforeRevision: null,
    afterRevision: null,
    ...overrides,
  };
}

/** Builds one organisation's chain, linking each event to the organisation's last hash. */
function chainOf(
  inputs: ChainedEventInput[],
  lastHashByOrg: Map<string | null, string> = new Map(),
): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const input of inputs) {
    const previousHash = lastHashByOrg.get(input.organizationId) ?? null;
    const built = buildChainedEvent(input, previousHash, sha256);
    if (!built.ok) {
      throw new Error(`chainOf: unexpected refusal ${built.reason}`);
    }
    const { hash, previousHash: link } = built.event;
    out.push({ ...input, previousHash: link, hash });
    lastHashByOrg.set(input.organizationId, hash);
  }
  return out;
}

function interleavedChain(): Record<string, unknown>[] {
  const lastHashByOrg = new Map<string | null, string>();
  return [
    ...chainOf([baseInput({ eventId: 'a1' }), baseInput({ eventId: 'a2' })], lastHashByOrg),
    ...chainOf([baseInput({ eventId: 'b1', organizationId: 'org-b', kind: 'stop' })], lastHashByOrg),
    ...chainOf(
      [baseInput({ eventId: 'n1', organizationId: null, kind: 'grant', beforeRevision: null, afterRevision: null })],
      lastHashByOrg,
    ),
    ...chainOf([baseInput({ eventId: 'a3', kind: 'merge' })], lastHashByOrg),
  ];
}

describe('verifyEventChain', () => {
  it('accepts a valid per-organisation chain built with buildChainedEvent, counting its events', () => {
    const events = interleavedChain();
    expect(verifyEventChain(events, sha256, types.isProxy)).toEqual({ ok: true, count: events.length });
  });

  it('accepts an empty event list with count 0', () => {
    expect(verifyEventChain([], sha256, types.isProxy)).toEqual({ ok: true, count: 0 });
  });

  it('refuses a chain with a mismatched previousHash (broken-chain at the offending index)', () => {
    const events = chainOf([baseInput({ eventId: 'a1' }), baseInput({ eventId: 'a2' })]);
    events[1] = { ...events[1], previousHash: null };
    expect(verifyEventChain(events, sha256, types.isProxy)).toEqual({ ok: false, reason: 'broken-chain', index: 1 });
  });

  it('refuses a chain when any event field is tampered after hashing (hash-mismatch at that index)', () => {
    const events = chainOf([baseInput({ eventId: 'a1' }), baseInput({ eventId: 'a2' })]);
    events[1] = { ...events[1], actor: 'agent-8' };
    expect(verifyEventChain(events, sha256, types.isProxy)).toEqual({ ok: false, reason: 'hash-mismatch', index: 1 });
  });

  it('refuses null and undefined events without throwing', () => {
    for (const events of [null, undefined]) {
      expect(verifyEventChain(events, sha256, types.isProxy)).toEqual({ ok: false, reason: 'invalid-events' });
    }
  });

  it('refuses primitives, non-iterables, array-likes, and non-plain roots as events', () => {
    const cases: unknown[] = [0, true, 'str', 10n, Symbol('s'), {}, { length: 1, 0: {} }, new Date()];
    class Sub extends Array {}
    cases.push(Object.setPrototypeOf([], Sub.prototype));
    for (const events of cases) {
      expect(verifyEventChain(events, sha256, types.isProxy)).toEqual({ ok: false, reason: 'invalid-events' });
    }
  });

  it('refuses nested non-plain or unsupported values inside events as hostile-input, and plain nested objects as invalid-event-record', () => {
    const withNestedDate = [{ ...chainOf([baseInput()])[0], extra: new Date() }];
    expect(verifyEventChain(withNestedDate, sha256, types.isProxy)).toEqual({ ok: false, reason: 'hostile-input' });
    const nestedObject = chainOf([baseInput()]);
    (nestedObject[0] as Record<string, unknown>).beforeRevision = { nested: true };
    expect(verifyEventChain(nestedObject, sha256, types.isProxy)).toEqual({
      ok: false,
      reason: 'invalid-event-record',
      index: 0,
    });
  });

  it('refuses sparse arrays with holes without reading elements', () => {
    const sparse: unknown[] = [chainOf([baseInput()])[0]];
    sparse.push(undefined);
    delete sparse[1];
    expect(verifyEventChain(sparse, sha256, types.isProxy)).toEqual({ ok: false, reason: 'hostile-input' });
  });

  it('refuses an events array exceeding MAX_ERASURE_EVENTS without scanning elements', () => {
    const big = new Array(MAX_ERASURE_EVENTS + 1).fill({});
    expect(verifyEventChain(big, sha256, types.isProxy)).toEqual({ ok: false, reason: 'too-many-events' });
  });

  it('refuses own getters on events or elements without invoking them', () => {
    let getterRuns = 0;
    const withGetter = Object.defineProperty(chainOf([baseInput()]), '0', {
      get() {
        getterRuns += 1;
        return {};
      },
      enumerable: true,
      configurable: true,
    });
    expect(verifyEventChain(withGetter, sha256, types.isProxy)).toEqual({ ok: false, reason: 'hostile-input' });
    expect(getterRuns).toBe(0);
    const fieldGetter: Record<string, unknown> = chainOf([baseInput()])[0];
    Object.defineProperty(fieldGetter, 'actor', {
      get() {
        getterRuns += 1;
        return 'agent-7';
      },
      enumerable: true,
      configurable: true,
    });
    expect(verifyEventChain([fieldGetter], sha256, types.isProxy)).toEqual({ ok: false, reason: 'hostile-input' });
    expect(getterRuns).toBe(0);
  });

  it('refuses Proxy and revoked Proxy inputs without running traps', () => {
    const counted = countingTrapProxy();
    expect(verifyEventChain(counted.proxy, sha256, types.isProxy)).toEqual({ ok: false, reason: 'hostile-input' });
    expect(counted.traps).toEqual({ get: 0, ownKeys: 0, getOwnPropertyDescriptor: 0 });
    expect(verifyEventChain(revokedProxy(), sha256, types.isProxy)).toEqual({ ok: false, reason: 'hostile-input' });
  });

  it('refuses prototype-polluting own keys on event records', () => {
    const events = chainOf([baseInput()]);
    const polluted = Object.defineProperty({}, '__proto__', { value: {}, enumerable: true, configurable: true });
    Object.assign(polluted, events[0]);
    expect(verifyEventChain([polluted], sha256, types.isProxy)).toEqual({
      ok: false,
      reason: 'prototype-polluting-key',
      index: 0,
    });
  });

  it('refuses malformed event records with missing, extra, or invalid fields', () => {
    const good = chainOf([baseInput()])[0];
    const missing = { ...good } as Record<string, unknown>;
    delete missing.hash;
    const extra = { ...good, extra: 1 };
    const badKind = { ...good, kind: 'unknown-kind' };
    const badActor = { ...good, actor: 'bad actor!' };
    const badAt = { ...good, atIso: 'not-a-date' };
    const badHash = { ...good, hash: 'zz' };
    const badPrevious = { ...good, previousHash: 'nothex' };
    const badOrg = { ...good, organizationId: 7 };
    const badRevision = { ...good, beforeRevision: '' };
    for (const bad of [missing, extra, badKind, badActor, badAt, badHash, badPrevious, badOrg, badRevision]) {
      expect(verifyEventChain([bad], sha256, types.isProxy)).toEqual({
        ok: false,
        reason: 'invalid-event-record',
        index: 0,
      });
    }
  });

  it('refuses missing, throwing, or malformed-digest hasher', () => {
    const events = chainOf([baseInput()]);
    expect(verifyEventChain(events, undefined as never, types.isProxy)).toEqual({ ok: false, reason: 'invalid-hasher' });
    expect(verifyEventChain(events, () => 'nothex', types.isProxy)).toEqual({ ok: false, reason: 'invalid-hasher' });
    expect(
      verifyEventChain([], () => {
        throw new Error('boom');
      }, types.isProxy),
    ).toEqual({ ok: false, reason: 'invalid-hasher' });
  });

  it('reports invalid-hasher, not hash-mismatch, when a hasher passing the canary fails while hashing an event', () => {
    const events = chainOf([baseInput()]);
    let calls = 0;
    const flakyHasher: Sha256HexFn = (text: string) => {
      calls += 1;
      if (calls <= 1) return sha256(text); // the empty-string canary
      throw new Error('boom');
    };
    expect(verifyEventChain(events, flakyHasher, types.isProxy)).toEqual({
      ok: false,
      reason: 'invalid-hasher',
      index: 0,
    });
    let malformedCalls = 0;
    const malformedHasher: Sha256HexFn = (text: string) => {
      malformedCalls += 1;
      return malformedCalls <= 1 ? sha256(text) : 'nothex';
    };
    expect(verifyEventChain(events, malformedHasher, types.isProxy)).toEqual({
      ok: false,
      reason: 'invalid-hasher',
      index: 0,
    });
  });

  it('refuses missing or throwing isProxy detector', () => {
    const events = chainOf([baseInput()]);
    expect(verifyEventChain(events, sha256, undefined as never)).toEqual({ ok: false, reason: 'invalid-detector' });
    expect(
      verifyEventChain(events, sha256, () => {
        throw new Error('boom');
      }),
    ).toEqual({ ok: false, reason: 'invalid-detector' });
  });
});

describe('pseudonymiseActors', () => {
  it('maps the same actor to the same placeholder within one organisation and to different placeholders across organisations', () => {
    const events = [
      ...chainOf([baseInput({ eventId: 'a1', actor: 'agent-7' }), baseInput({ eventId: 'a2', actor: 'agent-7' })]),
      ...chainOf([baseInput({ eventId: 'b1', actor: 'agent-7', organizationId: 'org-b' })]),
    ];
    const result = pseudonymiseActors(events, 'org-a', 'salt-1', sha256, types.isProxy);
    if (!result.ok) {
      throw new Error(`unexpected refusal: ${result.reason}`);
    }
    const a1 = result.events[0];
    const a2 = result.events[1];
    const b1 = result.events[2];
    expect(a1.actor).toBe(a2.actor);
    expect(a1.actor).toMatch(/^anon-[0-9a-f]{32}$/);
    expect(b1.actor).toBe('agent-7');
    // Deterministic: the placeholder is a pure function of (organizationId, salt, actor).
    const again = pseudonymiseActors(events, 'org-a', 'salt-1', sha256, types.isProxy);
    if (!again.ok) {
      throw new Error(`unexpected refusal: ${again.reason}`);
    }
    expect(again.events[0].actor).toBe(a1.actor);
    const otherOrg = pseudonymiseActors(events, 'org-b', 'salt-1', sha256, types.isProxy);
    if (!otherOrg.ok) {
      throw new Error(`unexpected refusal: ${otherOrg.reason}`);
    }
    expect(otherOrg.events[2].actor).toMatch(/^anon-[0-9a-f]{32}$/);
    expect(otherOrg.events[2].actor).not.toBe(a1.actor);
  });

  it('recomputes per-organisation hashes in order so verifyEventChain passes after pseudonymiseActors on interleaved multi-org streams, counting only that organisation', () => {
    const events = interleavedChain();
    const result = pseudonymiseActors(events, 'org-a', 'salt-1', sha256, types.isProxy);
    if (!result.ok) {
      throw new Error(`unexpected refusal: ${result.reason}`);
    }
    expect(result.pseudonymisedCount).toBe(3);
    expect(verifyEventChain(result.events, sha256, types.isProxy)).toEqual({ ok: true, count: result.events.length });
    // The other organisations' events are untouched byte-for-byte.
    expect(result.events[2]).toEqual(events[2]);
    expect(result.events[3]).toEqual(events[3]);
  });

  it('leaves other organisations events untouched byte-for-byte, including the null organisation', () => {
    const events = interleavedChain();
    const result = pseudonymiseActors(events, 'org-a', 'salt-1', sha256, types.isProxy);
    if (!result.ok) {
      throw new Error(`unexpected refusal: ${result.reason}`);
    }
    expect(result.events[2]).toEqual(events[2]);
    expect(result.events[3]).toEqual(events[3]);
    expect(result.events[2]).not.toBe(events[2]);
    // Erasing one organisation verifies the whole incoming stream first: a
    // stream where every event is foreign is accepted but changes nothing.
    const foreign = pseudonymiseActors(events, 'org-z', 'salt-1', sha256, types.isProxy);
    if (!foreign.ok) {
      throw new Error(`unexpected refusal: ${foreign.reason}`);
    }
    expect(foreign.pseudonymisedCount).toBe(0);
    expect(foreign.events).toEqual(events);
    expect(verifyEventChain(foreign.events, sha256, types.isProxy)).toEqual({ ok: true, count: events.length });
  });

  it('fails verifyEventChain when any field of one event in the chain is tampered, and refuses tampered input before erasure', () => {
    const events = chainOf([baseInput({ eventId: 'a1' }), baseInput({ eventId: 'a2' })]);
    events[0] = { ...events[0], atIso: '2026-01-02T00:00:00.000Z' };
    expect(verifyEventChain(events, sha256, types.isProxy)).toEqual({ ok: false, reason: 'hash-mismatch', index: 0 });
    expect(pseudonymiseActors(events, 'org-a', 'salt-1', sha256, types.isProxy)).toEqual({
      ok: false,
      reason: 'hash-mismatch',
      index: 0,
    });
  });

  it('refuses invalid or empty organizationId in pseudonymiseActors', () => {
    const events = chainOf([baseInput()]);
    for (const organizationId of [undefined, null, 7, '', 'x'.repeat(129), 'bad\u0000id']) {
      expect(pseudonymiseActors(events, organizationId, 'salt', sha256, types.isProxy)).toEqual({
        ok: false,
        reason: 'invalid-organization-id',
      });
    }
  });

  it('refuses invalid or empty salt in pseudonymiseActors', () => {
    const events = chainOf([baseInput()]);
    for (const salt of [undefined, null, 7, '', 'x'.repeat(257), 'bad\u0007salt']) {
      expect(pseudonymiseActors(events, 'org-a', salt, sha256, types.isProxy)).toEqual({
        ok: false,
        reason: 'invalid-salt',
      });
    }
  });

  it('refuses the same hostile events shapes as verifyEventChain (too many, hostile, malformed, wrong root)', () => {
    expect(pseudonymiseActors(null, 'org-a', 'salt', sha256, types.isProxy)).toEqual({ ok: false, reason: 'invalid-events' });
    expect(pseudonymiseActors('str', 'org-a', 'salt', sha256, types.isProxy)).toEqual({ ok: false, reason: 'invalid-events' });
    expect(pseudonymiseActors(new Array(MAX_ERASURE_EVENTS + 1).fill({}), 'org-a', 'salt', sha256, types.isProxy)).toEqual({
      ok: false,
      reason: 'too-many-events',
    });
    const sparse: unknown[] = [chainOf([baseInput()])[0]];
    sparse.push(undefined);
    delete sparse[1];
    expect(pseudonymiseActors(sparse, 'org-a', 'salt', sha256, types.isProxy)).toEqual({ ok: false, reason: 'hostile-input' });
    const missing = { ...chainOf([baseInput()])[0] } as Record<string, unknown>;
    delete missing.hash;
    expect(pseudonymiseActors([missing], 'org-a', 'salt', sha256, types.isProxy)).toEqual({
      ok: false,
      reason: 'invalid-event-record',
      index: 0,
    });
  });
});
