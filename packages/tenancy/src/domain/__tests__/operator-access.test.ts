import { readFileSync } from 'node:fs';
import { types } from 'node:util';

import { describe, expect, it } from 'vitest';

import {
  MAX_OPERATOR_REASON_LENGTH,
  OPERATOR_ACCESS_MAX_DURATION_MS,
  decideOperatorAccess,
  parseOperatorAccessGrant,
} from '../operator-access.js';

const isProxy = types.isProxy;
const SOURCE = readFileSync(new URL('../operator-access.ts', import.meta.url), 'utf8');

const GRANTED = '2026-11-26T12:00:00.000Z';
const EXPIRES = '2026-11-26T14:00:00.000Z';
const SECRET_REASON = 'op-test-1';

function grant(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    actor: 'operator@example.com',
    organizationId: 'org-a',
    reason: SECRET_REASON,
    grantedAtIso: GRANTED,
    expiresAtIso: EXPIRES,
    ...overrides,
  };
}

function envelope(
  nowIso: string,
  overrides: Record<string, unknown> = {},
  grantOverrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return { grant: grant(grantOverrides), organizationId: 'org-a', nowIso, ...overrides };
}

/** A three-slot array whose middle slot is a hole. */
function holey(value: unknown): unknown[] {
  const out: unknown[] = new Array(3);
  out[0] = value;
  out[2] = value;
  return out;
}

const decide = (input: unknown) => decideOperatorAccess(input, isProxy);
const parse = (raw: unknown) => parseOperatorAccessGrant(raw, isProxy);

function expectRefused(result: ReturnType<typeof decide>, reason: string) {
  expect(result.outcome).toBe('refused');
  if (result.outcome === 'refused') {
    expect(result.reason).toBe(reason);
    expect(result.audit.reason).toBe(reason);
  }
  const text = JSON.stringify(result);
  expect(text).not.toContain(SECRET_REASON);
}

/** A Proxy whose every trap throws: nothing may invoke it. */
function throwingProxy(): object {
  return new Proxy(
    {},
    {
      get() {
        throw new Error('trap');
      },
      ownKeys() {
        throw new Error('trap');
      },
      getOwnPropertyDescriptor() {
        throw new Error('trap');
      },
      getPrototypeOf() {
        throw new Error('trap');
      },
    },
  );
}

let getterRan = false;

function hostileValues(valid: Record<string, unknown>): Array<[string, unknown]> {
  getterRan = false;
  const withGetter = { ...valid };
  Object.defineProperty(withGetter, 'reason', {
    enumerable: true,
    get() {
      getterRan = true;
      return 'x';
    },
  });
  const withSymbol = { ...valid };
  Object.defineProperty(withSymbol, Symbol('s'), { value: 1, enumerable: true });
  const withProto = { ...valid };
  Object.defineProperty(withProto, '__proto__', { value: 1, enumerable: true });
  const out: Array<[string, unknown]> = [
    ['null', null],
    ['undefined', undefined],
    ['number', 5],
    ['string', 'text'],
    ['array', [valid]],
    ['hole', holey(valid)],
    ['array-like', { ...valid, length: 5 }],
    ['non-plain prototype', Object.create({ inherited: 1 })],
    ['class instance', new (class Hostile {})()],
    ['getter', withGetter],
    ['proxy', new Proxy({ ...valid }, {})],
    ['throwing proxy', throwingProxy()],
    ['symbol key', withSymbol],
    ['own __proto__', withProto],
    ['constructor key', { ...valid, constructor: 1 }],
    ['prototype key', { ...valid, prototype: 1 }],
    ['extra key', { ...valid, extra: 1 }],
    ['oversized string', { ...valid, reason: 'x'.repeat(5000) }],
  ];
  return out;
}

describe('operator-access module purity', () => {
  it('contains no clock, randomness, process, or Node imports in operator-access.ts', () => {
    expect(SOURCE).not.toMatch(/Date\.now|new Date\(|Math\.random|performance\.now|process\.|require\(/);
    expect(SOURCE).not.toMatch(/from ['"]node:/);
    expect(SOURCE).not.toMatch(/from ['"](?:fs|path|child_process|http|https|net|crypto)['"]/);
    expect(SOURCE).not.toMatch(/console\./);
  });
});

describe('parseOperatorAccessGrant', () => {
  it('parses a valid grant into a frozen copy', () => {
    const raw = grant();
    const result = parse(raw);
    expect(result.outcome).toBe('parsed');
    if (result.outcome === 'parsed') {
      expect(result.grant).toEqual(raw);
      expect(Object.isFrozen(result.grant)).toBe(true);
      expect(result.grant).not.toBe(raw);
    }
  });

  it('refuses hostile raw grant shapes (null, undefined, primitive, array, hole, array-like, non-plain prototype, getter, Proxy, polluting keys, extra/missing keys) as invalid-grant without invoking getters', () => {
    for (const [name, value] of hostileValues(grant())) {
      expect(parse(value), name).toEqual({ outcome: 'refused', reason: 'invalid-grant' });
    }
    expect(getterRan).toBe(false);
    const missing = Object.fromEntries(Object.entries(grant()).filter(([key]) => key !== 'organizationId'));
    expect(parse(missing)).toEqual({ outcome: 'refused', reason: 'invalid-grant' });
    expect(parse(grant({ reason: undefined }))).toEqual({ outcome: 'refused', reason: 'invalid-grant' });
  });

  it('refuses non-function or throwing isProxy detector without throwing', () => {
    for (const detector of [undefined, null, 5, {}, 'x']) {
      expect(parseOperatorAccessGrant(grant(), detector as never)).toEqual({
        outcome: 'refused',
        reason: 'invalid-grant',
      });
      expectRefused(decideOperatorAccess(envelope('2026-11-26T13:00:00Z'), detector as never), 'invalid-input');
    }
    const throwing = () => {
      throw new Error('detector failed');
    };
    expect(parseOperatorAccessGrant(grant(), throwing)).toEqual({ outcome: 'refused', reason: 'invalid-grant' });
    const decided = decideOperatorAccess(envelope('2026-11-26T13:00:00Z'), throwing);
    expectRefused(decided, 'invalid-input');
    expect(JSON.stringify(decided)).not.toContain('detector failed');
  });

  it('refuses invalid actor, organizationId, empty/oversized/control-char reason, and invalid timestamps as invalid-grant', () => {
    const bad: Array<Record<string, unknown>> = [
      grant({ actor: '' }),
      grant({ actor: 'has space' }),
      grant({ actor: 'a'.repeat(129) }),
      grant({ actor: 5 }),
      grant({ actor: 'operator@example.com\n' }),
      grant({ organizationId: 'org-a\n' }),
      grant({ organizationId: '' }),
      grant({ organizationId: 'Upper' }),
      grant({ organizationId: 'a'.repeat(64) }),
      grant({ organizationId: 5 }),
      grant({ reason: '' }),
      grant({ reason: 'x'.repeat(MAX_OPERATOR_REASON_LENGTH + 1) }),
      grant({ reason: 'line\nbreak' }),
      grant({ reason: 'bell\u0007' }),
      grant({ reason: 5 }),
      grant({ grantedAtIso: '2026-11-26T12:00:00' }),
      grant({ grantedAtIso: '2026-02-31T12:00:00Z' }),
      grant({ expiresAtIso: 'tomorrow' }),
      grant({ expiresAtIso: '2026-13-01T00:00:00Z' }),
      grant({ expiresAtIso: 5 }),
    ];
    for (const raw of bad) {
      expect(parse(raw)).toEqual({ outcome: 'refused', reason: 'invalid-grant' });
    }
    // The longest allowed reason is accepted.
    expect(parse(grant({ reason: 'x'.repeat(MAX_OPERATOR_REASON_LENGTH) })).outcome).toBe('parsed');
  });

  it('refuses grant whose expiry is at or before grantedAtIso or exceeds 4 hours (including 5-hour grant) as invalid-grant', () => {
    const refused = { outcome: 'refused', reason: 'invalid-grant' };
    expect(parse(grant({ expiresAtIso: GRANTED }))).toEqual(refused);
    expect(parse(grant({ expiresAtIso: '2026-11-26T11:59:59.999Z' }))).toEqual(refused);
    expect(parse(grant({ expiresAtIso: '2026-11-26T12:00:00.000000001Z' })).outcome).toBe('parsed');
    expect(OPERATOR_ACCESS_MAX_DURATION_MS).toBe(4 * 60 * 60 * 1000);
    expect(parse(grant({ expiresAtIso: '2026-11-26T17:00:00.000Z' }))).toEqual(refused);
    expect(parse(grant({ expiresAtIso: '2026-11-26T16:00:00.001Z' }))).toEqual(refused);
    expect(parse(grant({ expiresAtIso: '2026-11-26T16:00:00.000000001Z' }))).toEqual(refused);
    expect(parse(grant({ expiresAtIso: '2026-11-26T16:00:00.000Z' })).outcome).toBe('parsed');
    // The same instant written with an offset counts the same duration.
    expect(parse(grant({ expiresAtIso: '2026-11-26T17:00:00.000+01:00' })).outcome).toBe('parsed');
    expect(parse(grant({ expiresAtIso: '2026-11-26T18:00:00.000+01:00' }))).toEqual(refused);
    // Sub-millisecond digits of the grant move the exact four-hour boundary.
    expect(
      parse(grant({ grantedAtIso: '2026-11-26T12:00:00.000000500Z', expiresAtIso: '2026-11-26T16:00:00.000000500Z' }))
        .outcome,
    ).toBe('parsed');
    expect(
      parse(grant({ grantedAtIso: '2026-11-26T12:00:00.000000500Z', expiresAtIso: '2026-11-26T16:00:00.000000501Z' })),
    ).toEqual(refused);
  });
});

describe('decideOperatorAccess', () => {
  it('allows at grantedAtIso and before expiresAtIso, and refuses at exact expiresAtIso and after as expired', () => {
    const atStart = decide(envelope(GRANTED));
    expect(atStart.outcome).toBe('allowed');
    const justBefore = decide(envelope('2026-11-26T13:59:59.999999999Z'));
    expect(justBefore.outcome).toBe('allowed');
    if (justBefore.outcome === 'allowed') {
      expect(justBefore.actor).toBe('operator@example.com');
      expect(justBefore.organizationId).toBe('org-a');
    }
    expectRefused(decide(envelope(EXPIRES)), 'expired');
    expectRefused(decide(envelope('2026-11-26T14:00:00.000000001Z')), 'expired');
    expectRefused(decide(envelope('2027-01-01T00:00:00Z')), 'expired');
    // Offsets are compared as instants.
    expect(decide(envelope('2026-11-26T14:30:00.000+01:00')).outcome).toBe('allowed');
    expectRefused(decide(envelope('2026-11-26T15:00:00.000+01:00')), 'expired');
  });

  it('refuses access before grantedAtIso as not-yet-valid', () => {
    expectRefused(decide(envelope('2026-11-26T11:59:59.999Z')), 'not-yet-valid');
    expectRefused(decide(envelope('2026-11-26T11:59:59.999999999Z')), 'not-yet-valid');
    expectRefused(decide(envelope('2020-01-01T00:00:00Z')), 'not-yet-valid');
  });

  it('refuses a valid grant for org A when evaluated against org B as wrong-organization and records requested org and grant actor in audit', () => {
    const result = decide(envelope('2026-11-26T13:00:00Z', { organizationId: 'org-b' }));
    expectRefused(result, 'wrong-organization');
    expect(result.audit).toEqual({
      actor: 'operator@example.com',
      organizationId: 'org-b',
      reason: 'wrong-organization',
      atIso: '2026-11-26T13:00:00Z',
    });
  });

  it('emits one audit row per decision and never echoes grant reason or rejected values in any refusal', () => {
    const nowIso = '2026-11-26T13:00:00Z';
    const allowed = decide(envelope(nowIso));
    expect(allowed.audit).toEqual({
      actor: 'operator@example.com',
      organizationId: 'org-a',
      reason: SECRET_REASON,
      atIso: nowIso,
    });
    expect(Object.isFrozen(allowed)).toBe(true);
    expect(Object.isFrozen(allowed.audit)).toBe(true);

    const refusals: Array<[ReturnType<typeof decide>, OperatorAccessRow]> = [
      [
        decide(envelope('2026-11-26T11:00:00Z')),
        { actor: 'operator@example.com', organizationId: 'org-a', reason: 'not-yet-valid', atIso: '2026-11-26T11:00:00Z' },
      ],
      [
        decide(envelope('2026-11-26T15:00:00Z')),
        { actor: 'operator@example.com', organizationId: 'org-a', reason: 'expired', atIso: '2026-11-26T15:00:00Z' },
      ],
      [
        decide(envelope(nowIso, {}, { actor: 'bad actor' })),
        { actor: 'unknown', organizationId: 'org-a', reason: 'invalid-grant', atIso: nowIso },
      ],
      [
        decide({ organizationId: 'org-a', nowIso }),
        { actor: 'unknown', organizationId: 'org-a', reason: 'invalid-grant', atIso: nowIso },
      ],
      [
        decide(envelope('not-a-time')),
        { actor: 'unknown', organizationId: 'org-a', reason: 'invalid-input', atIso: 'unknown' },
      ],
      [
        decide(envelope(nowIso, { organizationId: 'BAD' })),
        { actor: 'unknown', organizationId: 'unknown', reason: 'invalid-input', atIso: nowIso },
      ],
      [decide(null), { actor: 'unknown', organizationId: 'unknown', reason: 'invalid-input', atIso: 'unknown' }],
    ];
    for (const [result, row] of refusals) {
      expect(result.outcome).toBe('refused');
      expect(result.audit).toEqual(row);
      expect(Object.isFrozen(result)).toBe(true);
      expect(Object.isFrozen(result.audit)).toBe(true);
      expect(JSON.stringify(result)).not.toContain(SECRET_REASON);
      expect(JSON.stringify(result)).not.toContain('bad actor');
      expect(JSON.stringify(result)).not.toContain('BAD');
    }
  });

  it('refuses hostile input envelopes, invalid organizationId, and invalid nowIso as invalid-input', () => {
    const valid = envelope('2026-11-26T13:00:00Z');
    for (const [name, value] of hostileValues(valid)) {
      // A hostile `reason` key does not exist on the envelope; it is an extra key there.
      const result = decide(value);
      expect(result.outcome, name).toBe('refused');
      expect(['invalid-input', 'invalid-grant'], name).toContain((result as { reason: string }).reason);
    }
    expect(getterRan).toBe(false);
    for (const [name, value] of [
      ['null', null],
      ['undefined', undefined],
      ['number', 7],
      ['array', []],
      ['array-like', { ...valid, length: 3 }],
      ['proxy', new Proxy({ ...valid }, {})],
      ['throwing proxy', throwingProxy()],
      ['constructor key', { ...valid, constructor: 1 }],
      ['prototype key', { ...valid, prototype: 1 }],
      ['extra key', { ...valid, extra: 1 }],
      ['missing nowIso', { grant: grant(), organizationId: 'org-a' }],
      ['missing organizationId', { grant: grant(), nowIso: '2026-11-26T13:00:00Z' }],
      ['own undefined nowIso', { ...valid, nowIso: undefined }],
      ['bad organizationId', { ...valid, organizationId: 'Not Valid' }],
      ['non-string organizationId', { ...valid, organizationId: 5 }],
      ['unzoned nowIso', { ...valid, nowIso: '2026-11-26T13:00:00' }],
      ['calendar-invalid nowIso', { ...valid, nowIso: '2026-02-30T13:00:00Z' }],
      ['non-string nowIso', { ...valid, nowIso: 5 }],
    ] as Array<[string, unknown]>) {
      expectRefused(decide(value), 'invalid-input');
      expect(name.length).toBeGreaterThan(0);
    }
    const withProto = { ...valid };
    Object.defineProperty(withProto, '__proto__', { value: 1, enumerable: true });
    expectRefused(decide(withProto), 'invalid-input');
    const sparse = holey(valid);
    expectRefused(decide(sparse), 'invalid-input');
  });

  it('refuses hostile grant inside decideOperatorAccess (including getter, Proxy, hole, and polluting key) as invalid-grant', () => {
    const nowIso = '2026-11-26T13:00:00Z';
    let getterRan = false;
    const getterGrant = grant();
    Object.defineProperty(getterGrant, 'actor', {
      enumerable: true,
      get() {
        getterRan = true;
        return 'operator@example.com';
      },
    });
    const protoGrant = grant();
    Object.defineProperty(protoGrant, '__proto__', { value: 1, enumerable: true });
    const symbolGrant = grant();
    Object.defineProperty(symbolGrant, Symbol('s'), { value: 1, enumerable: true });
    const hostileGrants: unknown[] = [
      null,
      undefined,
      7,
      'text',
      [grant()],
      holey(grant()),
      { ...grant(), length: 5 },
      Object.create({ inherited: 1 }),
      getterGrant,
      new Proxy(grant(), {}),
      throwingProxy(),
      protoGrant,
      symbolGrant,
      { ...grant(), constructor: 1 },
      { ...grant(), prototype: 1 },
      { ...grant(), extra: 1 },
      grant({ actor: undefined }),
    ];
    for (const hostile of hostileGrants) {
      expectRefused(decide({ grant: hostile, organizationId: 'org-a', nowIso }), 'invalid-grant');
    }
    expect(getterRan).toBe(false);
    // A missing grant key is a missing grant, not a hostile envelope.
    expectRefused(decide({ organizationId: 'org-a', nowIso }), 'invalid-grant');
  });
});

interface OperatorAccessRow {
  readonly actor: string;
  readonly organizationId: string;
  readonly reason: string;
  readonly atIso: string;
}
