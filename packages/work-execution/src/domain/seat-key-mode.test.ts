// Compatibility guard tests: a seat is only allowed under a key mode that
// covers it. Every hostile shape is a typed refusal; nothing is echoed.

import { types } from 'node:util';

import { describe, expect, it } from 'vitest';

import type { IsProxy } from '@fleet/shared';

import { SEAT_CATALOG_SEAT_BOUND, seatPlanFromCatalog, type SeatCatalog } from './seat-selection.js';
import { assertSeatAllowedForKeyMode, type SeatKeyModeResult } from './seat-key-mode.js';

const isProxy: IsProxy = types.isProxy;

function refusalOf(input: unknown, detector: IsProxy = isProxy): Extract<SeatKeyModeResult, { ok: false }> {
  const result = assertSeatAllowedForKeyMode(input, detector);
  if (result.ok) {
    throw new Error('expected a refusal, got ok');
  }
  return result;
}

function okFor(input: unknown, detector: IsProxy = isProxy): void {
  expect(assertSeatAllowedForKeyMode(input, detector)).toEqual({ ok: true });
}

const LISTED_SEAT_ID = 'opencode-a';
const KEYED_SEATS = ['opencode-a', 'opencode-b'];

function validInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    seatId: LISTED_SEAT_ID,
    keyMode: 'managed',
    keyedSeats: [...KEYED_SEATS],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Policy: allow-list is fail-closed
// ---------------------------------------------------------------------------

describe('assertSeatAllowedForKeyMode', () => {
  it('allows a listed seat under managed keyMode', () => {
    okFor(validInput({ keyMode: 'managed' }));
  });

  it('allows a listed seat under byok keyMode', () => {
    okFor(validInput({ keyMode: 'byok' }));
  });

  it('allows any seat under self-host keyMode, listed or not', () => {
    okFor(validInput({ keyMode: 'self-host', seatId: 'agy', keyedSeats: [] }));
    okFor(validInput({ keyMode: 'self-host', seatId: LISTED_SEAT_ID, keyedSeats: [] }));
  });

  it('refuses unlisted plan-quota seats under managed keyMode including empty keyedSeats', () => {
    for (const seatId of ['grok-cli', 'agy', 'claude-code']) {
      expect(refusalOf(validInput({ keyMode: 'managed', seatId, keyedSeats: [] }))).toEqual({
        ok: false,
        reason: 'personal-plan-seat',
      });
      expect(refusalOf(validInput({ keyMode: 'managed', seatId }))).toEqual({
        ok: false,
        reason: 'personal-plan-seat',
      });
    }
  });

  it('refuses unlisted plan-quota seats under byok keyMode', () => {
    for (const seatId of ['grok-cli', 'agy', 'claude-code']) {
      expect(refusalOf(validInput({ keyMode: 'byok', seatId, keyedSeats: [] }))).toEqual({
        ok: false,
        reason: 'personal-plan-seat',
      });
    }
  });

  it('refuses unlisted seats under managed even when the allow-list holds other seats', () => {
    expect(refusalOf(validInput({ keyMode: 'managed', seatId: 'claude-code', keyedSeats: ['opencode-b'] }))).toEqual({
      ok: false,
      reason: 'personal-plan-seat',
    });
  });

  // -------------------------------------------------------------------------
  // Real catalogue through seatPlanFromCatalog
  // -------------------------------------------------------------------------

  it('refuses every plan-quota seat from a SeatCatalog built with seatPlanFromCatalog under managed', () => {
    const CATALOG: SeatCatalog = {
      seats: [
        { id: 'grok-cli', tool: 'opencode', model: 'acme/grok-4.7' },
        { id: 'agy', tool: 'opencode', model: 'acme/glm-5.3' },
        { id: 'claude-code', tool: 'opencode', model: 'acme/argon-4' },
        { id: 'opencode-a', tool: 'opencode', model: 'acme/mercury-3' },
        { id: 'opencode-b', tool: 'opencode', model: 'acme/mercury-3', variant: 'low' },
      ],
      chains: {
        implementer: [{ seatId: 'grok-cli' }, { seatId: 'opencode-a' }],
        fix: [{ seatId: 'agy' }, { seatId: 'opencode-b', triggers: ['429'] }],
        reviewer: [{ seatId: 'claude-code' }],
      },
    };
    const built = seatPlanFromCatalog(CATALOG);
    if ('reason' in built) {
      throw new Error(`expected a plan, got reason: ${built.reason}`);
    }
    const planQuotaSeatIds = new Set(['grok-cli', 'agy', 'claude-code']);
    const keyedSeatIds = new Set(['opencode-a', 'opencode-b']);
    const roles = ['first-pass', 'fix', 'review'] as const;
    for (const role of roles) {
      for (const seat of built.plan[role]) {
        const input = {
          seatId: seat.id,
          keyMode: 'managed',
          keyedSeats: [...keyedSeatIds],
        };
        if (planQuotaSeatIds.has(seat.id)) {
          expect(refusalOf(input)).toEqual({ ok: false, reason: 'personal-plan-seat' });
        } else if (keyedSeatIds.has(seat.id)) {
          okFor(input);
        }
      }
    }
  });

  // -------------------------------------------------------------------------
  // Unknown key mode
  // -------------------------------------------------------------------------

  it('refuses unknown keyMode strings with unknown-key-mode', () => {
    for (const keyMode of ['enterprise', '']) {
      const result = refusalOf(validInput({ keyMode, keyedSeats: [LISTED_SEAT_ID] }));
      expect(result).toEqual({ ok: false, reason: 'unknown-key-mode' });
    }
  });

  it('refuses a non-string keyMode with malformed-input', () => {
    expect(refusalOf(validInput({ keyMode: 42, keyedSeats: [LISTED_SEAT_ID] }))).toEqual({
      ok: false,
      reason: 'malformed-input',
    });
  });

  // -------------------------------------------------------------------------
  // Untrimmed / empty strings
  // -------------------------------------------------------------------------

  it('refuses untrimmed seatId or keyedSeats entries with malformed-input', () => {
    expect(refusalOf(validInput({ seatId: ' agy' }))).toEqual({ ok: false, reason: 'malformed-input' });
    expect(refusalOf(validInput({ seatId: 'agy ' }))).toEqual({ ok: false, reason: 'malformed-input' });
    expect(refusalOf(validInput({ seatId: '' }))).toEqual({ ok: false, reason: 'malformed-input' });
    expect(refusalOf(validInput({ keyedSeats: ['agy ', LISTED_SEAT_ID] }))).toEqual({
      ok: false,
      reason: 'malformed-input',
    });
    expect(refusalOf(validInput({ keyedSeats: ['', LISTED_SEAT_ID] }))).toEqual({
      ok: false,
      reason: 'malformed-input',
    });
  });

  // -------------------------------------------------------------------------
  // Hostile inputs
  // -------------------------------------------------------------------------

  it('refuses null and undefined inputs with malformed-input', () => {
    expect(refusalOf(null)).toEqual({ ok: false, reason: 'malformed-input' });
    expect(refusalOf(undefined)).toEqual({ ok: false, reason: 'malformed-input' });
    expect(refusalOf(validInput({ keyedSeats: null as unknown as string[] }))).toEqual({
      ok: false,
      reason: 'malformed-input',
    });
  });

  it('refuses wrong primitives and non-array keyedSeats with malformed-input', () => {
    for (const input of [42, 'managed', true]) {
      expect(refusalOf(input)).toEqual({ ok: false, reason: 'malformed-input' });
    }
    expect(refusalOf(validInput({ keyedSeats: 'opencode-a' as unknown as string[] }))).toEqual({
      ok: false,
      reason: 'malformed-input',
    });
    expect(refusalOf(validInput({ seatId: 7 as unknown as string }))).toEqual({
      ok: false,
      reason: 'malformed-input',
    });
  });

  it('refuses sparse arrays with holes in keyedSeats', () => {
    const sparse: unknown[] = new Array(3);
    sparse[0] = LISTED_SEAT_ID;
    sparse[2] = 'opencode-b';
    expect(refusalOf(validInput({ keyedSeats: sparse }))).toEqual({ ok: false, reason: 'malformed-input' });
  });

  it('refuses getters on input and keyedSeats without invoking them', () => {
    let getterRan = false;
    const getterInput = {
      get seatId() {
        getterRan = true;
        return LISTED_SEAT_ID;
      },
      keyMode: 'managed',
      keyedSeats: [LISTED_SEAT_ID],
    };
    expect(refusalOf(getterInput)).toEqual({ ok: false, reason: 'malformed-input' });
    expect(getterRan).toBe(false);
    let arrayGetterRan = false;
    const arrayLike: unknown[] = [LISTED_SEAT_ID];
    Object.defineProperty(arrayLike, 1, {
      enumerable: true,
      get() {
        arrayGetterRan = true;
        return 'opencode-b';
      },
    });
    expect(refusalOf(validInput({ keyedSeats: arrayLike }))).toEqual({ ok: false, reason: 'malformed-input' });
    expect(arrayGetterRan).toBe(false);
  });

  it('refuses Proxy and revoked Proxy inputs via types.isProxy without running traps', () => {
    let trapRan = false;
    const hostile = new Proxy(
      { seatId: LISTED_SEAT_ID, keyMode: 'managed', keyedSeats: [LISTED_SEAT_ID] },
      {
        get() {
          trapRan = true;
          return LISTED_SEAT_ID;
        },
      },
    );
    expect(refusalOf(hostile)).toEqual({ ok: false, reason: 'malformed-input' });
    expect(trapRan).toBe(false);
    const { proxy: revoked, revoke } = Proxy.revocable(validInput(), {});
    revoke();
    expect(refusalOf(revoked)).toEqual({ ok: false, reason: 'malformed-input' });
    const { proxy: revokedSeats, revoke: revokeSeats } = Proxy.revocable([...KEYED_SEATS], {});
    revokeSeats();
    expect(refusalOf(validInput({ keyedSeats: revokedSeats as unknown as string[] }))).toEqual({
      ok: false,
      reason: 'malformed-input',
    });
  });

  it('refuses input when the isProxy detector throws or is not a function', () => {
    const throwing: IsProxy = () => {
      throw new Error('detector failure');
    };
    expect(refusalOf(validInput(), throwing)).toEqual({ ok: false, reason: 'malformed-input' });
    const notAFunction = 42 as unknown as IsProxy;
    expect(refusalOf(validInput(), notAFunction)).toEqual({ ok: false, reason: 'malformed-input' });
  });

  it('refuses array-like objects for keyedSeats', () => {
    const arrayLike = { 0: LISTED_SEAT_ID, length: 1 };
    expect(refusalOf(validInput({ keyedSeats: arrayLike as unknown as string[] }))).toEqual({
      ok: false,
      reason: 'malformed-input',
    });
  });

  it('refuses keyedSeats exceeding the array length bound and over-long ids', () => {
    const tooMany: string[] = new Array(SEAT_CATALOG_SEAT_BOUND + 1).fill(LISTED_SEAT_ID);
    expect(refusalOf(validInput({ keyedSeats: tooMany }))).toEqual({ ok: false, reason: 'malformed-input' });
    const tooLong = 'x'.repeat(129);
    expect(refusalOf(validInput({ seatId: tooLong }))).toEqual({ ok: false, reason: 'malformed-input' });
    expect(refusalOf(validInput({ keyedSeats: [tooLong] }))).toEqual({ ok: false, reason: 'malformed-input' });
  });

  it('refuses prototype-polluting keys and values', () => {
    expect(refusalOf(JSON.parse('{"__proto__": {}, "seatId": "opencode-a", "keyMode": "managed", "keyedSeats": []}'))).toEqual({
      ok: false,
      reason: 'malformed-input',
    });
    expect(refusalOf(JSON.parse('{"constructor": 1, "seatId": "opencode-a", "keyMode": "managed", "keyedSeats": []}'))).toEqual({
      ok: false,
      reason: 'malformed-input',
    });
    expect(refusalOf(validInput({ seatId: '__proto__' }))).toEqual({ ok: false, reason: 'malformed-input' });
    expect(refusalOf(validInput({ seatId: 'constructor' }))).toEqual({ ok: false, reason: 'malformed-input' });
    expect(refusalOf(validInput({ keyedSeats: ['prototype', LISTED_SEAT_ID] }))).toEqual({
      ok: false,
      reason: 'malformed-input',
    });
  });

  it('refuses missing or extra keys and untrimmed strings', () => {
    expect(refusalOf({ seatId: LISTED_SEAT_ID, keyMode: 'managed' })).toEqual({
      ok: false,
      reason: 'malformed-input',
    });
    expect(refusalOf({ keyMode: 'managed', keyedSeats: [LISTED_SEAT_ID] })).toEqual({
      ok: false,
      reason: 'malformed-input',
    });
    expect(refusalOf({ seatId: LISTED_SEAT_ID, keyedSeats: [LISTED_SEAT_ID] })).toEqual({
      ok: false,
      reason: 'malformed-input',
    });
    expect(refusalOf({ ...validInput(), extra: 1 })).toEqual({ ok: false, reason: 'malformed-input' });
  });

  // -------------------------------------------------------------------------
  // No echo
  // -------------------------------------------------------------------------

  it('never echoes seatId, keyMode, or keyedSeats entries into a refusal', () => {
    const seatId = 'grok-cli';
    const keyedSeats = ['opencode-a', 'opencode-b'];
    const refusals: SeatKeyModeResult[] = [
      refusalOf(validInput({ keyMode: 'managed', seatId, keyedSeats: [] })),
      refusalOf(validInput({ keyMode: 'enterprise', seatId, keyedSeats })),
      refusalOf(null),
      refusalOf(42),
      refusalOf(validInput({ keyedSeats: [{ 0: LISTED_SEAT_ID, length: 1 } as unknown as string[]] })),
    ];
    for (const refusal of refusals) {
      const text = JSON.stringify(refusal);
      expect(text).not.toContain(seatId);
      expect(text).not.toContain('managed');
      expect(text).not.toContain('enterprise');
      for (const entry of keyedSeats) {
        expect(text).not.toContain(entry);
      }
    }
  });
});
