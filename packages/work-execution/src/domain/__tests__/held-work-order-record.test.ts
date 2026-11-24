import { beforeEach, describe, expect, it } from 'vitest';
import { validateHeldWorkOrderRecord, type HeldWorkOrderRecord } from '../held-work-order.js';

const RECORD_KEYS = [
  'version',
  'stage',
  'intentId',
  'workOrderId',
  'requestDigest',
  'briefRequestRef',
  'blockerKind',
  'blockerId',
  'pathCode',
  'heldAtIso',
] as const;

function makeValidRecord(overrides?: Partial<HeldWorkOrderRecord>): HeldWorkOrderRecord {
  return {
    version: 1,
    stage: 'intent',
    intentId: 'hold-intent-01',
    workOrderId: 'wo-1',
    requestDigest: 'a'.repeat(64),
    briefRequestRef: 'brief-req-01',
    blockerKind: 'open-pr',
    blockerId: '42',
    pathCode: 'path-0123456789ab',
    heldAtIso: '2026-11-07T10:00:00.000Z',
    ...overrides,
  };
}

describe('validateHeldWorkOrderRecord', () => {
  // Every refusal below must be a refusal of THIS validator, not of a stub that
  // returns null for everything: before each test the valid intent and held
  // records are required to be accepted, so an always-null validator fails
  // every test in this file, and an identity validator fails every refusal.
  beforeEach(() => {
    expect(validateHeldWorkOrderRecord(makeValidRecord())).not.toBeNull();
    expect(
      validateHeldWorkOrderRecord(
        makeValidRecord({ stage: 'held', blockerKind: 'active-work-order', blockerId: 'wo-99', briefRequestRef: null }),
      ),
    ).not.toBeNull();
  });

  it('returns a fresh HeldWorkOrderRecord with exact fields for valid intent and held records', () => {
    const intent = makeValidRecord();
    const intentResult = validateHeldWorkOrderRecord(intent);
    expect(intentResult).not.toBeNull();
    expect(intentResult).not.toBe(intent);
    expect(Object.keys(intentResult ?? {}).sort()).toEqual([...RECORD_KEYS].sort());
    expect(intentResult).toEqual({
      version: 1,
      stage: 'intent',
      intentId: 'hold-intent-01',
      workOrderId: 'wo-1',
      requestDigest: 'a'.repeat(64),
      briefRequestRef: 'brief-req-01',
      blockerKind: 'open-pr',
      blockerId: '42',
      pathCode: 'path-0123456789ab',
      heldAtIso: '2026-11-07T10:00:00.000Z',
    });

    const held = makeValidRecord({
      stage: 'held',
      blockerKind: 'active-work-order',
      blockerId: 'wo-99',
      briefRequestRef: null,
    });
    const heldResult = validateHeldWorkOrderRecord(held);
    expect(heldResult).not.toBeNull();
    expect(heldResult).not.toBe(held);
    expect(Object.keys(heldResult ?? {}).sort()).toEqual([...RECORD_KEYS].sort());
    expect(heldResult).toEqual(held);
  });

  it('returns null when version is not 1', () => {
    expect(validateHeldWorkOrderRecord(makeValidRecord({ version: 2 as unknown as 1 }))).toBeNull();
    expect(validateHeldWorkOrderRecord(makeValidRecord({ version: 0 as unknown as 1 }))).toBeNull();
    expect(validateHeldWorkOrderRecord(makeValidRecord({ version: '1' as unknown as 1 }))).toBeNull();
  });

  it('returns null when stage is neither intent nor held', () => {
    expect(validateHeldWorkOrderRecord(makeValidRecord({ stage: 'released' as 'intent' }))).toBeNull();
    expect(validateHeldWorkOrderRecord(makeValidRecord({ stage: '' as 'intent' }))).toBeNull();
    expect(validateHeldWorkOrderRecord(makeValidRecord({ stage: 1 as unknown as 'intent' }))).toBeNull();
  });

  it('returns null when intentId fails HOLD_INTENT_ID_PATTERN', () => {
    expect(validateHeldWorkOrderRecord(makeValidRecord({ intentId: '' }))).toBeNull();
    expect(validateHeldWorkOrderRecord(makeValidRecord({ intentId: '.bad' }))).toBeNull();
    expect(validateHeldWorkOrderRecord(makeValidRecord({ intentId: '../bad' }))).toBeNull();
    expect(validateHeldWorkOrderRecord(makeValidRecord({ intentId: 'a/b' }))).toBeNull();
    expect(validateHeldWorkOrderRecord(makeValidRecord({ intentId: 'x'.repeat(129) }))).toBeNull();
  });

  it('returns null when intentId contains a secret-shaped token', () => {
    expect(validateHeldWorkOrderRecord(makeValidRecord({ intentId: 'ghp_' + 'a'.repeat(36) }))).toBeNull();
  });

  it('returns null when workOrderId is invalid or secret-shaped', () => {
    expect(validateHeldWorkOrderRecord(makeValidRecord({ workOrderId: '' }))).toBeNull();
    expect(validateHeldWorkOrderRecord(makeValidRecord({ workOrderId: '.bad' }))).toBeNull();
    expect(validateHeldWorkOrderRecord(makeValidRecord({ workOrderId: 'a/b' }))).toBeNull();
    expect(validateHeldWorkOrderRecord(makeValidRecord({ workOrderId: 'x'.repeat(129) }))).toBeNull();
    expect(validateHeldWorkOrderRecord(makeValidRecord({ workOrderId: 'ghp_' + 'a'.repeat(36) }))).toBeNull();
  });

  it('returns null when requestDigest is not 64 lowercase hex characters', () => {
    expect(validateHeldWorkOrderRecord(makeValidRecord({ requestDigest: 'A'.repeat(64) }))).toBeNull();
    expect(validateHeldWorkOrderRecord(makeValidRecord({ requestDigest: 'a'.repeat(63) }))).toBeNull();
    expect(validateHeldWorkOrderRecord(makeValidRecord({ requestDigest: 'a'.repeat(65) }))).toBeNull();
    expect(validateHeldWorkOrderRecord(makeValidRecord({ requestDigest: 'g'.repeat(64) }))).toBeNull();
  });

  it('returns null when pathCode does not match path-<12 hex>', () => {
    expect(validateHeldWorkOrderRecord(makeValidRecord({ pathCode: 'path-' + 'A'.repeat(12) }))).toBeNull();
    expect(validateHeldWorkOrderRecord(makeValidRecord({ pathCode: 'path-' + 'a'.repeat(11) }))).toBeNull();
    expect(validateHeldWorkOrderRecord(makeValidRecord({ pathCode: 'path-' + 'a'.repeat(13) }))).toBeNull();
    expect(validateHeldWorkOrderRecord(makeValidRecord({ pathCode: 'other-' + 'a'.repeat(12) }))).toBeNull();
  });

  it('returns null when heldAtIso is not canonical UTC ISO-8601', () => {
    expect(validateHeldWorkOrderRecord(makeValidRecord({ heldAtIso: '2026-11-07' }))).toBeNull();
    expect(validateHeldWorkOrderRecord(makeValidRecord({ heldAtIso: '2026-11-07T10:00:00Z' }))).toBeNull();
    expect(validateHeldWorkOrderRecord(makeValidRecord({ heldAtIso: '2026-11-07T10:00:00+00:00' }))).toBeNull();
  });

  it('returns null when briefRequestRef is blank, dot-segment, or secret-shaped', () => {
    expect(validateHeldWorkOrderRecord(makeValidRecord({ briefRequestRef: '' }))).toBeNull();
    expect(validateHeldWorkOrderRecord(makeValidRecord({ briefRequestRef: '   ' }))).toBeNull();
    expect(validateHeldWorkOrderRecord(makeValidRecord({ briefRequestRef: '.' }))).toBeNull();
    expect(validateHeldWorkOrderRecord(makeValidRecord({ briefRequestRef: '..' }))).toBeNull();
    expect(validateHeldWorkOrderRecord(makeValidRecord({ briefRequestRef: '../x' }))).toBeNull();
    expect(validateHeldWorkOrderRecord(makeValidRecord({ briefRequestRef: 'ghp_' + 'a'.repeat(36) }))).toBeNull();
  });

  it('returns null when blockerKind is open-pr and blockerId is 0, 1000000000, or 01', () => {
    expect(validateHeldWorkOrderRecord(makeValidRecord({ blockerId: '0' }))).toBeNull();
    expect(validateHeldWorkOrderRecord(makeValidRecord({ blockerId: '1000000000' }))).toBeNull();
    expect(validateHeldWorkOrderRecord(makeValidRecord({ blockerId: '01' }))).toBeNull();
  });

  it('returns null when blockerKind is active-work-order with an invalid token or unknown kind', () => {
    const held = { blockerKind: 'active-work-order' as const, briefRequestRef: null };
    expect(validateHeldWorkOrderRecord(makeValidRecord({ ...held, blockerId: '' }))).toBeNull();
    expect(validateHeldWorkOrderRecord(makeValidRecord({ ...held, blockerId: '.bad' }))).toBeNull();
    expect(validateHeldWorkOrderRecord(makeValidRecord({ ...held, blockerId: 'a/b' }))).toBeNull();
    expect(
      validateHeldWorkOrderRecord(makeValidRecord({ ...held, blockerId: 'ghp_' + 'a'.repeat(36) })),
    ).toBeNull();
    expect(validateHeldWorkOrderRecord(makeValidRecord({ blockerKind: 'unknown' as 'open-pr' }))).toBeNull();
  });

  it('returns null when record has an extra key or missing key', () => {
    expect(validateHeldWorkOrderRecord({ ...makeValidRecord(), extra: true })).toBeNull();
    const missing = { ...makeValidRecord() } as Record<string, unknown>;
    delete missing.heldAtIso;
    expect(validateHeldWorkOrderRecord(missing)).toBeNull();
  });

  it('returns null when record has a prototype-polluting __proto__ own key or symbol key', () => {
    const protoKey = makeValidRecord() as unknown as Record<string, unknown>;
    delete protoKey.version;
    Object.defineProperty(protoKey, '__proto__', { value: 1, enumerable: true });
    expect(validateHeldWorkOrderRecord(protoKey)).toBeNull();

    const symbolKey = makeValidRecord() as unknown as Record<string, unknown>;
    Object.defineProperty(symbolKey, Symbol('extra'), { value: 1, enumerable: true });
    expect(validateHeldWorkOrderRecord(symbolKey)).toBeNull();
  });

  it('returns null without invoking any getter on a getter-bearing record', () => {
    const throwing = { ...makeValidRecord() } as Record<string, unknown>;
    Object.defineProperty(throwing, 'workOrderId', {
      enumerable: true,
      get() {
        throw new Error('getter must never run');
      },
    });
    expect(validateHeldWorkOrderRecord(throwing)).toBeNull();

    let called = 0;
    const counted = { ...makeValidRecord() } as Record<string, unknown>;
    Object.defineProperty(counted, 'workOrderId', {
      enumerable: true,
      get() {
        called += 1;
        return 'wo-1';
      },
    });
    expect(validateHeldWorkOrderRecord(counted)).toBeNull();
    expect(called).toBe(0);
  });

  it('returns null without throwing when a Proxy reports a wrong key set with a plain prototype, or when a trap throws or the Proxy is revoked', () => {
    const throwingOwnKeys = new Proxy({ ...makeValidRecord() }, {
      ownKeys() {
        throw new Error('hostile ownKeys trap');
      },
    });
    expect(validateHeldWorkOrderRecord(throwingOwnKeys)).toBeNull();

    const throwingDescriptor = new Proxy({ ...makeValidRecord() }, {
      getOwnPropertyDescriptor() {
        throw new Error('hostile descriptor trap');
      },
    });
    expect(validateHeldWorkOrderRecord(throwingDescriptor)).toBeNull();

    // A Proxy whose traps disagree with its target (the consistently-lying
    // Proxy is the accepted residual and is not claimed here): `get` answers every read with the same wrong value, `has`
    // denies every key, `ownKeys` reports a wrong key set, the descriptor
    // trap reports a wrong descriptor, and the prototype trap answers a plain
    // prototype so the plain-record gate passes and the `ownKeys` lie is the
    // refusal reason. Every value is read through its own property descriptor
    // after the exact-key-set check, so the `get` trap is never invoked and
    // the `ownKeys` lie is caught by that exact-key-set refusal — proven by the
    // call counter staying at zero and the whole proxy being refused with
    // null instead of the lie leaking through any single honest trap.
    let getCalls = 0;
    const lyingEverywhere = new Proxy({ ...makeValidRecord() }, {
      get() {
        getCalls += 1;
        return 'the same lie for every key';
      },
      has() {
        return false;
      },
      ownKeys() {
        return ['length', 'extra'];
      },
      getOwnPropertyDescriptor() {
        return { enumerable: true, configurable: true, value: 'a descriptor lie' };
      },
      getPrototypeOf() {
        return Object.prototype;
      },
    });
    expect(validateHeldWorkOrderRecord(lyingEverywhere)).toBeNull();
    expect(getCalls).toBe(0);

    const { proxy: revoked, revoke: revokeProxy } = Proxy.revocable({ ...makeValidRecord() }, {});
    revokeProxy();
    expect(validateHeldWorkOrderRecord(revoked)).toBeNull();
  });

  it('returns null when given an array (empty, populated, holed, or of enormous length) or an array-like object', () => {
    expect(validateHeldWorkOrderRecord([])).toBeNull();
    expect(validateHeldWorkOrderRecord(Object.assign([], makeValidRecord()))).toBeNull();
    expect(validateHeldWorkOrderRecord({ length: 10 })).toBeNull();

    // A holed array: index 1 is absent between two present indices, so the
    // array is sparse. The refusal is an O(1) `Array.isArray` check before
    // any key enumeration, so neither the hole nor the length is ever read.
    const holed: unknown[] = [makeValidRecord(), makeValidRecord()];
    delete holed[1];
    expect(validateHeldWorkOrderRecord(holed)).toBeNull();

    // An enormous length: a real array whose length is near `2**32 - 1`, and
    // an array-like carrying the same enormous length. Both are refused by
    // the same O(1) array/prototype gate; nothing enumerates the length.
    const enormous = Object.assign([], makeValidRecord()) as unknown[];
    Object.defineProperty(enormous, 'length', { value: 2 ** 32 - 2 });
    expect(validateHeldWorkOrderRecord(enormous)).toBeNull();
    expect(validateHeldWorkOrderRecord({ length: 2 ** 32 - 2 })).toBeNull();
  });

  it('returns null when given null, undefined, or a wrong primitive', () => {
    expect(validateHeldWorkOrderRecord(null)).toBeNull();
    expect(validateHeldWorkOrderRecord(undefined)).toBeNull();
    expect(validateHeldWorkOrderRecord('text')).toBeNull();
    expect(validateHeldWorkOrderRecord(42)).toBeNull();
    expect(validateHeldWorkOrderRecord(true)).toBeNull();
  });
});
