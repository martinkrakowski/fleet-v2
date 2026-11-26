import { describe, expect, it, vi } from 'vitest';

import { authorityEventForStop } from '../authority-event-mapping.js';

/** A ULID-shaped identifier built at runtime, never a literal. */
function ulid(seed: number): string {
  return `${seed % 10}` + 'A'.repeat(25);
}

/** A valid actor: letters and dots only, built at runtime. */
function actor(seed: string): string {
  return `op.${seed}`;
}

/** A zoned ISO time, built at runtime from parts. */
function atIso(day: number): string {
  return `2026-01-${`${day}`.padStart(2, '0')}T12:00:00Z`;
}

/** A valid mapper input with exactly the four own keys. */
function validInput(): Record<string, unknown> {
  return {
    eventId: `stop:${ulid(1)}/stop@cli`,
    actor: actor('lane'),
    organizationId: null,
    atIso: atIso(2),
  };
}

function inputWith(overrides: Record<string, unknown>): Record<string, unknown> {
  return { ...validInput(), ...overrides };
}

describe('authorityEventForStop', () => {
  it('maps a valid stop input to a frozen event with exactly the seven supplier keys', () => {
    const result = authorityEventForStop(validInput());
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.event.eventId).toBe(`stop:${ulid(1)}/stop@cli`);
    expect(result.event.kind).toBe('stop');
    expect(result.event.actor).toBe(actor('lane'));
    expect(result.event.organizationId).toBeNull();
    expect(result.event.atIso).toBe(atIso(2));
    expect(result.event.beforeRevision).toBeNull();
    expect(result.event.afterRevision).toBeNull();
    expect(Object.keys(result.event).sort()).toEqual([
      'actor',
      'afterRevision',
      'atIso',
      'beforeRevision',
      'eventId',
      'kind',
      'organizationId',
    ]);
    expect(Object.isFrozen(result.event)).toBe(true);
  });

  it('maps a non-null organizationId through unchanged', () => {
    const organizationId = 'org-x'.slice(0, 5);
    const result = authorityEventForStop(inputWith({ organizationId }));
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.event.organizationId).toBe(organizationId);
  });

  it('refuses null and undefined mapper inputs without throwing', () => {
    expect(authorityEventForStop(null)).toEqual({ ok: false, reason: 'invalid-input' });
    expect(authorityEventForStop(undefined)).toEqual({ ok: false, reason: 'invalid-input' });
  });

  it('refuses wrong primitive mapper inputs', () => {
    expect(authorityEventForStop(0)).toEqual({ ok: false, reason: 'invalid-input' });
    expect(authorityEventForStop(1.5)).toEqual({ ok: false, reason: 'invalid-input' });
    expect(authorityEventForStop(false)).toEqual({ ok: false, reason: 'invalid-input' });
    expect(authorityEventForStop('plain text')).toEqual({ ok: false, reason: 'invalid-input' });
    expect(authorityEventForStop(Symbol('s'))).toEqual({ ok: false, reason: 'invalid-input' });
    expect(authorityEventForStop(10n)).toEqual({ ok: false, reason: 'invalid-input' });
  });

  it('refuses non-iterable, array-like, sparse hole, and oversized length inputs', () => {
    // A dense array is not a plain record object.
    expect(authorityEventForStop([validInput()])).toEqual({ ok: false, reason: 'invalid-input' });
    // A sparse array is refused before any element is read.
    const sparse: unknown[] = [];
    sparse[2] = validInput();
    expect(authorityEventForStop(sparse)).toEqual({ ok: false, reason: 'invalid-input' });
    // An array-like plain object carries `length` and index keys: extra keys.
    const arrayLike = { ...validInput(), length: 1, 0: 'a' };
    expect(authorityEventForStop(arrayLike)).toEqual({ ok: false, reason: 'invalid-input' });
    // A non-plain-object collection with an enormous length is refused.
    const enormous = Object.assign(Object.create(Array.prototype), validInput(), { length: Number.MAX_SAFE_INTEGER });
    expect(authorityEventForStop(enormous)).toEqual({ ok: false, reason: 'invalid-input' });
  });

  it('refuses getter property without invoking it', () => {
    let getterRan = false;
    const input = Object.defineProperties({}, {
      eventId: { value: `stop:${ulid(1)}/stop@cli`, enumerable: true },
      actor: {
        get() {
          getterRan = true;
          return actor('lane');
        },
        enumerable: true,
      },
      organizationId: { value: null, enumerable: true },
      atIso: { value: atIso(2), enumerable: true },
    });
    expect(authorityEventForStop(input)).toEqual({ ok: false, reason: 'invalid-input' });
    expect(getterRan).toBe(false);
  });

  it('refuses revoked and throwing Proxy inputs without throwing', () => {
    const { proxy, revoke } = Proxy.revocable(validInput(), {});
    revoke();
    expect(authorityEventForStop(proxy)).toEqual({ ok: false, reason: 'invalid-input' });

    const throwing = new Proxy(validInput(), {
      ownKeys() {
        throw new Error('trap');
      },
    });
    expect(authorityEventForStop(throwing)).toEqual({ ok: false, reason: 'invalid-input' });
  });

  it('refuses prototype-polluting keys and extra keys', () => {
    // JSON.parse is the one way an own `__proto__` key reaches an object.
    const protoKey = JSON.parse(`{"__proto__":1,"eventId":"x","actor":"y","organizationId":null,"atIso":"z"}`);
    expect(authorityEventForStop(protoKey)).toEqual({ ok: false, reason: 'invalid-input' });
    const constructorKey = JSON.parse(`{"constructor":1,"eventId":"x","actor":"y","organizationId":null,"atIso":"z"}`);
    expect(authorityEventForStop(constructorKey)).toEqual({ ok: false, reason: 'invalid-input' });
    const prototypeKey = JSON.parse(`{"prototype":1,"eventId":"x","actor":"y","organizationId":null,"atIso":"z"}`);
    expect(authorityEventForStop(prototypeKey)).toEqual({ ok: false, reason: 'invalid-input' });
    expect(authorityEventForStop(inputWith({ extra: 1 }))).toEqual({ ok: false, reason: 'invalid-input' });
    // A symbol key is refused too.
    const symbolKeyed = { ...validInput(), [Symbol('s')]: 1 };
    expect(authorityEventForStop(symbolKeyed)).toEqual({ ok: false, reason: 'invalid-input' });
  });

  it('refuses malformed records missing required fields', () => {
    for (const key of ['eventId', 'actor', 'organizationId', 'atIso']) {
      const missing = validInput();
      delete missing[key];
      expect(authorityEventForStop(missing)).toEqual({ ok: false, reason: 'invalid-input' });
    }
    expect(authorityEventForStop(inputWith({ eventId: 7 }))).toEqual({ ok: false, reason: 'invalid-input' });
    expect(authorityEventForStop(inputWith({ actor: 7 }))).toEqual({ ok: false, reason: 'invalid-input' });
    expect(authorityEventForStop(inputWith({ organizationId: 7 }))).toEqual({ ok: false, reason: 'invalid-input' });
    expect(authorityEventForStop(inputWith({ atIso: 7 }))).toEqual({ ok: false, reason: 'invalid-input' });
  });

  it('refuses invalid actor, organizationId, atIso, or oversized fields without echoing input', () => {
    // An actor containing `:` violates the actor pattern.
    expect(authorityEventForStop(inputWith({ actor: `${actor('lane')}:extra` }))).toEqual({
      ok: false,
      reason: 'invalid-actor',
    });
    // A control character in the actor violates the actor pattern.
    expect(authorityEventForStop(inputWith({ actor: `bad\n${actor('lane')}` }))).toEqual({
      ok: false,
      reason: 'invalid-actor',
    });
    // An oversized or control-character organizationId.
    expect(authorityEventForStop(inputWith({ organizationId: 'o'.repeat(129) }))).toEqual({
      ok: false,
      reason: 'invalid-organization-id',
    });
    expect(authorityEventForStop(inputWith({ organizationId: 'bad\u0007org' }))).toEqual({
      ok: false,
      reason: 'invalid-organization-id',
    });
    // An atIso without a zone, or garbage.
    expect(authorityEventForStop(inputWith({ atIso: '2026-01-02T12:00:00' }))).toEqual({
      ok: false,
      reason: 'invalid-at-iso',
    });
    expect(authorityEventForStop(inputWith({ atIso: 'not-a-time' }))).toEqual({
      ok: false,
      reason: 'invalid-at-iso',
    });
    // An oversized eventId, and one carrying a control character.
    expect(authorityEventForStop(inputWith({ eventId: `stop:${'k'.repeat(200)}` }))).toEqual({
      ok: false,
      reason: 'invalid-event-id',
    });
    expect(authorityEventForStop(inputWith({ eventId: `stop:\u0007${ulid(1)}` }))).toEqual({
      ok: false,
      reason: 'invalid-event-id',
    });
    // No refusal ever echoes the supplied value back.
    for (const bad of [inputWith({ actor: `${actor('lane')}:extra` }), inputWith({ eventId: `stop:${'k'.repeat(200)}` })]) {
      const result = authorityEventForStop(bad);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(JSON.stringify(result)).not.toContain(':extra');
        expect(JSON.stringify(result)).not.toContain('k'.repeat(200));
      }
    }
  });

  it('refuses an empty eventId, actor or organizationId string', () => {
    expect(authorityEventForStop(inputWith({ eventId: '' }))).toEqual({ ok: false, reason: 'invalid-event-id' });
    expect(authorityEventForStop(inputWith({ actor: '' }))).toEqual({ ok: false, reason: 'invalid-actor' });
    expect(authorityEventForStop(inputWith({ organizationId: '' }))).toEqual({
      ok: false,
      reason: 'invalid-organization-id',
    });
  });

  it('never reads a clock while mapping', () => {
    const now = vi.spyOn(Date, 'now');
    try {
      authorityEventForStop(validInput());
      authorityEventForStop(null);
      authorityEventForStop(inputWith({ atIso: 'not-a-time' }));
      expect(now).not.toHaveBeenCalled();
    } finally {
      now.mockRestore();
    }
  });
});
