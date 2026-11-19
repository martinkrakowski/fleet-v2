import { readFileSync } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';

import {
  CUTOVER_RETIREMENT_SCRIPTS,
  CUTOVER_ROLLBACK_WINDOW_MS,
  CUTOVER_RECORD_SCHEMA_VERSION,
  CUTOVER_SHADOW_CRITERIA,
  CUTOVER_SHADOW_MIN_MERGES,
  RETIREMENT_LEDGER_MAX_TEXT_BYTES,
  canonicalCutoverRetirePayload,
  canonicalCutoverRollbackPayload,
  canonicalCutoverSwitchPayload,
  cutoverJournalKey,
  isWithinCutoverRollbackWindow,
  readCutoverRecord,
  readCutoverShadowEvidence,
  readRetirementLedger,
} from '../cutover-records.js';

const DIGEST = 'a'.repeat(64);
const SWITCHED = '2026-11-01T10:00:00.000Z';
const LATER = '2026-11-02T10:00:00.000Z';
const NOW = '2026-11-05T12:00:00.000Z';
const DAY_MS = 86_400_000;

function shadow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    revision: 1,
    state: 'shadow',
    updatedAtIso: SWITCHED,
    switchedAtIso: null,
    rolledBackAtIso: null,
    retiredAtIso: null,
    relaunchPlanDigest: null,
    trainPauseSetByCutover: false,
    ...overrides,
  };
}

function switched(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return shadow({
    state: 'switched',
    switchedAtIso: SWITCHED,
    relaunchPlanDigest: DIGEST,
    trainPauseSetByCutover: true,
    ...overrides,
  });
}

describe('readCutoverRecord', () => {
  it('reads an absent schemaVersion as 1 and accepts an explicit 1', () => {
    const absent = readCutoverRecord(shadow());
    expect(absent).toEqual({ ok: true, record: { schemaVersion: CUTOVER_RECORD_SCHEMA_VERSION, ...shadow() } });
    expect(readCutoverRecord(shadow({ schemaVersion: 1 })).ok).toBe(true);
  });

  it('reports a newer schemaVersion as unknown-version and garbage versions as invalid', () => {
    expect(readCutoverRecord(shadow({ schemaVersion: 2 }))).toEqual({ ok: false, reason: 'unknown-version' });
    expect(readCutoverRecord(shadow({ schemaVersion: 99 }))).toEqual({ ok: false, reason: 'unknown-version' });
    for (const bad of [0, -1, 1.5, '1', null, true]) {
      expect(readCutoverRecord(shadow({ schemaVersion: bad }))).toEqual({ ok: false, reason: 'invalid-record' });
    }
  });

  it('refuses non-records, getters, extra keys, symbols and non-plain prototypes without throwing', () => {
    for (const bad of [null, undefined, 'str', 7, [], new Array(2), new Date(), Object.create({ revision: 1 })]) {
      expect(readCutoverRecord(bad)).toEqual({ ok: false, reason: 'invalid-record' });
    }
    const withGetter = shadow();
    Object.defineProperty(withGetter, 'revision', {
      enumerable: true,
      get() {
        throw new Error('boom');
      },
    });
    expect(readCutoverRecord(withGetter).ok).toBe(false);
    expect(readCutoverRecord(shadow({ extra: 1 })).ok).toBe(false);
    expect(readCutoverRecord({ ...shadow(), [Symbol('x')]: 1 }).ok).toBe(false);
    const missing = shadow();
    delete missing.state;
    expect(readCutoverRecord(missing).ok).toBe(false);
  });

  it('refuses wrong-typed and out-of-range fields', () => {
    for (const overrides of [
      { revision: 0 },
      { revision: 1.5 },
      { revision: 1_000_000_001 },
      { revision: '1' },
      { state: 'unknown' },
      { updatedAtIso: 'yesterday' },
      { updatedAtIso: '2026-02-31T10:00:00.000Z' },
      { trainPauseSetByCutover: 'no' },
      { relaunchPlanDigest: 'A'.repeat(64) },
      { relaunchPlanDigest: 'a'.repeat(63) },
    ]) {
      expect(readCutoverRecord(shadow(overrides))).toEqual({ ok: false, reason: 'invalid-record' });
    }
  });

  it('enforces the state consistency rules', () => {
    expect(readCutoverRecord(shadow({ switchedAtIso: SWITCHED })).ok).toBe(false);
    expect(readCutoverRecord(shadow({ trainPauseSetByCutover: true })).ok).toBe(false);
    expect(readCutoverRecord(shadow({ relaunchPlanDigest: DIGEST })).ok).toBe(false);

    expect(readCutoverRecord(switched()).ok).toBe(true);
    expect(readCutoverRecord(switched({ relaunchPlanDigest: null })).ok).toBe(false);
    expect(readCutoverRecord(switched({ switchedAtIso: null })).ok).toBe(false);
    expect(readCutoverRecord(switched({ rolledBackAtIso: LATER })).ok).toBe(false);

    const rolledBack = switched({ state: 'rolled-back', rolledBackAtIso: LATER, trainPauseSetByCutover: false });
    expect(readCutoverRecord(rolledBack).ok).toBe(true);
    expect(readCutoverRecord({ ...rolledBack, trainPauseSetByCutover: true }).ok).toBe(false);
    expect(readCutoverRecord({ ...rolledBack, rolledBackAtIso: null }).ok).toBe(false);
    expect(readCutoverRecord({ ...rolledBack, retiredAtIso: LATER }).ok).toBe(false);
    expect(readCutoverRecord({ ...rolledBack, rolledBackAtIso: '2026-10-31T10:00:00.000Z' }).ok).toBe(false);

    const retired = switched({ state: 'retired', retiredAtIso: LATER, trainPauseSetByCutover: false });
    expect(readCutoverRecord(retired).ok).toBe(true);
    expect(readCutoverRecord({ ...retired, rolledBackAtIso: LATER }).ok).toBe(false);
    expect(readCutoverRecord({ ...retired, retiredAtIso: '2026-10-31T10:00:00.000Z' }).ok).toBe(false);
    expect(readCutoverRecord({ ...retired, trainPauseSetByCutover: true }).ok).toBe(false);
  });

  it('refuses secret-shaped and oversized strings from both registries', () => {
    const legacy = 'gh' + 'p_' + 'x'.repeat(28);
    const fineGrained = 'github' + '_pat_' + 'y'.repeat(28);
    for (const field of ['state', 'updatedAtIso', 'switchedAtIso', 'relaunchPlanDigest']) {
      for (const text of [legacy, fineGrained, 'z'.repeat(65)]) {
        expect(readCutoverRecord(switched({ [field]: text }))).toEqual({ ok: false, reason: 'invalid-record' });
      }
    }
  });

  it('never echoes input values in its result', () => {
    const text = JSON.stringify(readCutoverRecord(shadow({ state: 'sentinel-state' })));
    expect(text).not.toContain('sentinel-state');
  });
});

describe('cutoverJournalKey', () => {
  it('builds the keyed name for a valid move and revision', () => {
    expect(cutoverJournalKey('rollback', 1)).toBe('cutover/rollback@1');
    expect(cutoverJournalKey('switch', 0)).toBe('cutover/switch@0');
    expect(cutoverJournalKey('retire', 1_000_000_000)).toBe('cutover/retire@1000000000');
  });

  it('returns null for an unknown move or a revision outside the range', () => {
    expect(cutoverJournalKey('status' as 'rollback', 1)).toBeNull();
    expect(cutoverJournalKey('bogus' as 'rollback', 1)).toBeNull();
    for (const revision of [-1, 1.5, 1_000_000_001, Number.NaN, Infinity, '1' as unknown as number]) {
      expect(cutoverJournalKey('rollback', revision)).toBeNull();
    }
  });
});

describe('isWithinCutoverRollbackWindow', () => {
  const switchedMs = Date.parse(SWITCHED);

  it('is true inside the window and false at exactly 14 days', () => {
    expect(isWithinCutoverRollbackWindow(SWITCHED, SWITCHED)).toBe(true);
    expect(isWithinCutoverRollbackWindow(SWITCHED, new Date(switchedMs + CUTOVER_ROLLBACK_WINDOW_MS - 1).toISOString())).toBe(true);
    expect(isWithinCutoverRollbackWindow(SWITCHED, new Date(switchedMs + CUTOVER_ROLLBACK_WINDOW_MS).toISOString())).toBe(false);
    expect(isWithinCutoverRollbackWindow(SWITCHED, new Date(switchedMs + CUTOVER_ROLLBACK_WINDOW_MS + 1).toISOString())).toBe(false);
  });

  it('is null for an invalid time or a clock before the switch', () => {
    expect(isWithinCutoverRollbackWindow('nope', SWITCHED)).toBeNull();
    expect(isWithinCutoverRollbackWindow(SWITCHED, 'nope')).toBeNull();
    expect(isWithinCutoverRollbackWindow(SWITCHED, new Date(switchedMs - 1).toISOString())).toBeNull();
  });
});

describe('canonicalCutoverRollbackPayload', () => {
  it('is the deterministic F129 payload', () => {
    expect(canonicalCutoverRollbackPayload({ expectedRevision: 3, operationId: 'op-1' })).toBe(
      '{"move":"rollback","expectedRevision":3,"operationId":"op-1"}',
    );
  });
});

describe('canonicalCutoverSwitchPayload and canonicalCutoverRetirePayload', () => {
  it('are the deterministic F129 payloads in a fixed key order', () => {
    expect(canonicalCutoverSwitchPayload({ expectedRevision: 0, operationId: 'op-1', relaunchPlanDigest: DIGEST })).toBe(
      `{"move":"switch","expectedRevision":0,"operationId":"op-1","relaunchPlanDigest":"${DIGEST}"}`,
    );
    expect(canonicalCutoverRetirePayload({ expectedRevision: 2, operationId: 'op-1' })).toBe(
      '{"move":"retire","expectedRevision":2,"operationId":"op-1"}',
    );
  });

  it('puts trainPausedBefore last in the switch payload, and leaves it out when it is not given', () => {
    const base = { expectedRevision: 0, operationId: 'op-1', relaunchPlanDigest: DIGEST };
    const fourKeys = `{"move":"switch","expectedRevision":0,"operationId":"op-1","relaunchPlanDigest":"${DIGEST}"}`;
    expect(canonicalCutoverSwitchPayload({ ...base, trainPausedBefore: true })).toBe(
      `${fourKeys.slice(0, -1)},"trainPausedBefore":true}`,
    );
    expect(canonicalCutoverSwitchPayload({ ...base, trainPausedBefore: false })).toBe(
      `${fourKeys.slice(0, -1)},"trainPausedBefore":false}`,
    );
    expect(canonicalCutoverSwitchPayload({ ...base, trainPausedBefore: undefined })).toBe(fourKeys);
    expect(canonicalCutoverSwitchPayload(base)).toBe(fourKeys);
  });
});

describe('readCutoverShadowEvidence', () => {
  const ALL_FAILED = { ok: false, reason: 'invalid-evidence', failed: [...CUTOVER_SHADOW_CRITERIA] };

  function passVerdicts(): Record<string, string> {
    const verdicts: Record<string, string> = {};
    for (const id of CUTOVER_SHADOW_CRITERIA) verdicts[id] = 'pass';
    return verdicts;
  }

  function evidence(nowIso: string, mutate?: (root: Record<string, unknown>) => void, merges: number = CUTOVER_SHADOW_MIN_MERGES): unknown {
    const base = Date.parse(nowIso);
    const root: Record<string, unknown> = {
      days: [0].map((back) => ({
        day: new Date(base - back * DAY_MS).toISOString().slice(0, 10),
        verdicts: passVerdicts(),
      })),
    };
    mutate?.(root);
    root.merges = merges;
    return root;
  }

  /** A document with a valid merge count, so the hostile `days` under test is what the validator reaches. */
  const docWith = (days: unknown): unknown => ({ days, merges: CUTOVER_SHADOW_MIN_MERGES });

  const onlyFailed = (...ids: string[]) => ({ ok: false, reason: 'invalid-evidence', failed: ids });

  /** Valid evidence with criterion `id` of day `dayIndex` redefined as an own enumerable property. */
  function withVerdict(dayIndex: number, id: string, descriptor: PropertyDescriptor): unknown {
    return evidence(NOW, (root) => {
      const days = root.days as Array<{ verdicts: Record<string, unknown> }>;
      Object.defineProperty(days[dayIndex].verdicts, id, { enumerable: true, ...descriptor });
    });
  }

  it('accepts a single all-pass day', () => {
    expect(readCutoverShadowEvidence(evidence(NOW), NOW)).toEqual({ ok: true });
    // The day may equal the UTC date of nowIso but not follow it.
    expect(readCutoverShadowEvidence(evidence('2026-11-05T00:00:00.000Z'), NOW)).toEqual({ ok: true });
    expect(readCutoverShadowEvidence(evidence(NOW, undefined, CUTOVER_SHADOW_MIN_MERGES + 1), NOW)).toEqual({ ok: true });
  });

  it('accepts S1-S12 passing with no S13 present', () => {
    // SH23: S13 left the shadow window for the retirement gate, so the twelve
    // passing criteria alone — with no S13 key at all — are enough.
    expect(Object.keys(passVerdicts())).toEqual([...CUTOVER_SHADOW_CRITERIA]);
    expect(Object.keys(passVerdicts())).not.toContain('S13');
    expect(readCutoverShadowEvidence(evidence(NOW), NOW)).toEqual({ ok: true });
  });

  it('refuses a day carrying an S13 verdict as unknown and never reads its descriptor', () => {
    const calls = { s13: 0 };
    const withS13Getter = evidence(NOW, (root) => {
      const record = (root.days as { day: string; verdicts: Record<string, unknown> }[])[0];
      Object.defineProperty(record.verdicts, 'S13', {
        enumerable: true,
        configurable: true,
        get() {
          calls.s13 += 1;
          return 'pass';
        },
      });
    });
    expect(readCutoverShadowEvidence(withS13Getter, NOW)).toEqual(ALL_FAILED);
    expect(calls.s13).toBe(0);
    // A plain data `S13` entry is refused the same way: an unknown verdict key.
    const withPlainS13 = evidence(NOW, (root) => {
      (root.days as { day: string; verdicts: Record<string, unknown> }[])[0].verdicts.S13 = 'pass';
    });
    expect(readCutoverShadowEvidence(withPlainS13, NOW)).toEqual(ALL_FAILED);
    // The fixture is live: read directly, the getter does answer.
    void (withS13Getter as { days: { verdicts: Record<string, unknown> }[] }).days[0].verdicts.S13;
    expect(calls.s13).toBe(1);
  });

  it('refuses shadow evidence with fewer merges than the minimum, or an unusable merge count', () => {
    for (const merges of [CUTOVER_SHADOW_MIN_MERGES - 1, 0, -1, 1.5, '20', null, Number.NaN, Infinity]) {
      expect({ merges, verdict: readCutoverShadowEvidence(evidence(NOW, undefined, merges as number), NOW) }).toEqual({
        merges,
        verdict: ALL_FAILED,
      });
    }
    const withoutMerges = evidence(NOW);
    delete (withoutMerges as Record<string, unknown>).merges;
    expect(readCutoverShadowEvidence(withoutMerges, NOW)).toEqual(ALL_FAILED);
    // A second, unexpected key is refused as before.
    expect(readCutoverShadowEvidence({ ...(evidence(NOW) as Record<string, unknown>), extra: 1 }, NOW)).toEqual(ALL_FAILED);
  });

  it('bounds a day string by its UTF-16 length before encoding it, and by its byte length after', () => {
    const withDay = (day: string): unknown =>
      evidence(NOW, (root) => {
        (root.days as Array<{ day: string }>)[0].day = day;
      });
    const encode = vi.spyOn(TextEncoder.prototype, 'encode');
    /** The verdict for `day` in the first record, and the byte length of each encoding of it. */
    const probe = (day: string): { verdict: unknown; encodedBytes: number[] } => {
      encode.mockClear();
      const verdict = readCutoverShadowEvidence(withDay(day), NOW);
      const encodedBytes = encode.mock.calls.flatMap((call, index) =>
        call[0] === day ? [(encode.mock.results[index].value as Uint8Array).length] : [],
      );
      return { verdict, encodedBytes };
    };
    try {
      // Exactly the limit passes the length bound and is measured (the date pattern then refuses it).
      expect(probe('a'.repeat(64))).toEqual({ verdict: ALL_FAILED, encodedBytes: [64] });
      // One over the limit, and a multi-megabyte string, are refused without being encoded.
      expect(probe('a'.repeat(65))).toEqual({ verdict: ALL_FAILED, encodedBytes: [] });
      expect(probe('a'.repeat(4 * 1024 * 1024))).toEqual({ verdict: ALL_FAILED, encodedBytes: [] });
      // Within the UTF-16 length but over the byte limit: still measured, still refused.
      expect(probe('\u00e9'.repeat(64))).toEqual({ verdict: ALL_FAILED, encodedBytes: [128] });
      expect(probe('\u{1F600}'.repeat(32))).toEqual({ verdict: ALL_FAILED, encodedBytes: [128] });
    } finally {
      encode.mockRestore();
    }
  });

  it('names only S4 when that verdict is unknown', () => {
    expect(readCutoverShadowEvidence(withVerdict(0, 'S4', { value: 'unknown' }), NOW)).toEqual(onlyFailed('S4'));
  });

  it('refuses a future, wrong-length or non-calendar day with every criterion named', () => {
    const base = Date.parse(NOW);
    type DayRecord = { day: string; verdicts: Record<string, unknown> };
    const future = evidence(NOW, (root) => {
      const days = root.days as DayRecord[];
      days[0] = { day: new Date(base + DAY_MS).toISOString().slice(0, 10), verdicts: passVerdicts() };
    });
    expect(readCutoverShadowEvidence(future, NOW)).toEqual(ALL_FAILED);
    const empty = evidence(NOW, (root) => {
      root.days = [];
    });
    expect(readCutoverShadowEvidence(empty, NOW)).toEqual(ALL_FAILED);
    const twoDays = evidence(NOW, (root) => {
      const days = root.days as DayRecord[];
      root.days = [days[0], days[0]];
    });
    expect(readCutoverShadowEvidence(twoDays, NOW)).toEqual(ALL_FAILED);
    const nonCalendar = evidence(NOW, (root) => {
      const days = root.days as DayRecord[];
      days[0] = { day: '2026-02-31', verdicts: passVerdicts() };
    });
    expect(readCutoverShadowEvidence(nonCalendar, NOW)).toEqual(ALL_FAILED);
    expect(readCutoverShadowEvidence(evidence(NOW), 'not-a-time')).toEqual(ALL_FAILED);
  });

  it('refuses null, undefined, a non-iterable, an array hole, a wrong primitive, a getter, a Proxy, an array-like with enormous length, and a prototype-polluting key, without throwing', () => {
    const base = Date.parse(NOW);
    const day = (back: number): string => new Date(base - back * DAY_MS).toISOString().slice(0, 10);

    expect(readCutoverShadowEvidence(null, NOW)).toEqual(ALL_FAILED);
    expect(readCutoverShadowEvidence(undefined, NOW)).toEqual(ALL_FAILED);
    expect(readCutoverShadowEvidence('evidence', NOW)).toEqual(ALL_FAILED);
    expect(readCutoverShadowEvidence(docWith('nope'), NOW)).toEqual(ALL_FAILED);
    expect(readCutoverShadowEvidence(docWith(7), NOW)).toEqual(ALL_FAILED);

    const holed = [ { day: day(2), verdicts: passVerdicts() } ];
    holed.length = 3; // holes at indices 1 and 2
    expect(readCutoverShadowEvidence(docWith(holed), NOW)).toEqual(ALL_FAILED);

    expect(readCutoverShadowEvidence(withVerdict(0, 'S7', { value: 7 }), NOW)).toEqual(onlyFailed('S7'));
    expect(readCutoverShadowEvidence(withVerdict(0, 'S2', { value: true }), NOW)).toEqual(onlyFailed('S2'));

    const throwingRoot: Record<string, unknown> = {};
    Object.defineProperty(throwingRoot, 'merges', { enumerable: true, value: CUTOVER_SHADOW_MIN_MERGES });
    Object.defineProperty(throwingRoot, 'days', {
      enumerable: true,
      get() {
        throw new Error('boom');
      },
    });
    expect(readCutoverShadowEvidence(throwingRoot, NOW)).toEqual(ALL_FAILED);
    expect(
      readCutoverShadowEvidence(
        withVerdict(0, 'S9', {
          get() {
            throw new Error('boom');
          },
        }),
        NOW,
      ),
    ).toEqual(onlyFailed('S9'));

    // A verdict getter that yields an uncloneable value, or throws a
    // DataCloneError itself, must stay unread and name only its own
    // criterion. A serializer probe that runs before the bounds would meet
    // these getters and mistake their failure for a stand-in refusal, naming
    // every criterion instead.
    expect(
      readCutoverShadowEvidence(
        withVerdict(0, 'S5', {
          get() {
            return () => 1; // a function cannot be cloned
          },
        }),
        NOW,
      ),
    ).toEqual(onlyFailed('S5'));
    expect(
      readCutoverShadowEvidence(
        withVerdict(0, 'S6', {
          get() {
            throw new DOMException('unread', 'DataCloneError');
          },
        }),
        NOW,
      ),
    ).toEqual(onlyFailed('S6'));

    expect(readCutoverShadowEvidence(docWith(new Proxy({}, {})), NOW)).toEqual(ALL_FAILED);
    expect(
      readCutoverShadowEvidence(
        evidence(NOW, (root) => {
          const days = root.days as Array<unknown>;
          days[0] = new Proxy({}, {});
        }),
        NOW,
      ),
    ).toEqual(ALL_FAILED);

    const enormous = { length: 1_000_000_000, '0': { day: day(2), verdicts: passVerdicts() } };
    expect(readCutoverShadowEvidence(docWith(enormous), NOW)).toEqual(ALL_FAILED);
    const longArray = [ { day: day(2), verdicts: passVerdicts() }, { day: day(1), verdicts: passVerdicts() }, { day: day(0), verdicts: passVerdicts() }, { day: day(0), verdicts: passVerdicts() } ];
    expect(readCutoverShadowEvidence(docWith(longArray), NOW)).toEqual(ALL_FAILED);

    const pollutingVerdicts = passVerdicts();
    (pollutingVerdicts as unknown as Record<string, string>)['constructor'] = 'pass';
    expect(readCutoverShadowEvidence(docWith([ { day: day(2), verdicts: pollutingVerdicts }, { day: day(1), verdicts: passVerdicts() }, { day: day(0), verdicts: passVerdicts() } ]), NOW)).toEqual(ALL_FAILED);
    // A literal own `__proto__` key must be built with defineProperty: an assignment only retargets the prototype.
    const protoVerdicts = passVerdicts();
    Object.defineProperty(protoVerdicts, '__proto__', { enumerable: true, value: 'pass' });
    expect(readCutoverShadowEvidence(docWith([ { day: day(2), verdicts: protoVerdicts }, { day: day(1), verdicts: passVerdicts() }, { day: day(0), verdicts: passVerdicts() } ]), NOW)).toEqual(ALL_FAILED);
    const protoRoot = evidence(NOW) as Record<string, unknown>;
    Object.defineProperty(protoRoot, '__proto__', { enumerable: true, value: {} });
    expect(readCutoverShadowEvidence(protoRoot, NOW)).toEqual(ALL_FAILED);
  });

  it('refuses a transparent Proxy standing in for days, for a day record, or for the whole document, before any result is built', () => {
    // A transparent Proxy answers Array.isArray, getPrototypeOf and every
    // descriptor read exactly as its target would, so the validator must
    // refuse it before accepting the document.
    const validDays = (evidence(NOW) as { days: object[] }).days;
    expect(readCutoverShadowEvidence(docWith(new Proxy(validDays, {})), NOW)).toEqual(ALL_FAILED);

    const dayRecord = validDays[0];
    expect(
      readCutoverShadowEvidence(docWith([new Proxy(dayRecord, {})]), NOW),
    ).toEqual(ALL_FAILED);

    expect(readCutoverShadowEvidence(new Proxy(evidence(NOW) as object, {}), NOW)).toEqual(ALL_FAILED);
  });

  /** Every Proxy trap name; a handler built from this list sees whatever the validator does to the Proxy. */
  const TRAPS = [
    'apply', 'construct', 'defineProperty', 'deleteProperty', 'get', 'getOwnPropertyDescriptor', 'getPrototypeOf',
    'has', 'isExtensible', 'ownKeys', 'preventExtensions', 'set', 'setPrototypeOf',
  ] as const;
  type AnyFunction = (...args: unknown[]) => unknown;

  /** A Proxy that forwards every operation to `target` and appends the trap's name to `calls`. */
  function recordingProxy<T extends object>(target: T, calls: string[]): T {
    const handler: Record<string, AnyFunction> = {};
    for (const trap of TRAPS) {
      handler[trap] = (...args) => {
        calls.push(trap);
        return (Reflect as unknown as Record<string, AnyFunction>)[trap](...args);
      };
    }
    return new Proxy(target, handler as ProxyHandler<T>);
  }

  /** A Proxy whose every trap throws. */
  function throwingProxy<T extends object>(target: T): T {
    const handler: Record<string, AnyFunction> = {};
    for (const trap of TRAPS) {
      handler[trap] = () => {
        throw new Error('trap');
      };
    }
    return new Proxy(target, handler as ProxyHandler<T>);
  }

  function revokedProxy<T extends object>(target: T): T {
    const { proxy, revoke } = Proxy.revocable(target, {});
    revoke();
    return proxy;
  }

  type DayRecord = { day: string; verdicts: Record<string, string> };
  type Stand = <T extends object>(target: T) => T;

  /** Valid evidence with `stand` put in place of the root, of `days`, of the first day record, or of its verdicts. */
  function standIn(position: 'root' | 'days' | 'day' | 'verdicts', stand: Stand): unknown {
    const root = evidence(NOW) as { days: DayRecord[]; merges: number };
    if (position === 'root') return stand(root);
    if (position === 'days') root.days = stand(root.days);
    if (position === 'day') root.days[0] = stand(root.days[0]);
    if (position === 'verdicts') root.days[0].verdicts = stand(root.days[0].verdicts);
    return root;
  }

  it('refuses a recording Proxy for days after at most 4 trap calls and for verdicts after at most 14, and never fires a get trap', () => {
    // The Proxy forwards every operation to valid data, so only the final serializer probe can
    // refuse it. Before that the walk may look at it through a constant number of traps fixed by
    // the permitted key lists: one prototype read, one key list and one descriptor read per
    // permitted key (`length`, `0` for days; the twelve criteria for verdicts).
    const limits = { days: 4, verdicts: 14 } as const;
    for (const position of ['days', 'verdicts'] as const) {
      const calls: string[] = [];
      const result = readCutoverShadowEvidence(standIn(position, (target) => recordingProxy(target, calls)), NOW);
      expect({ position, result }).toEqual({ position, result: ALL_FAILED });
      expect(calls.length).toBeGreaterThan(0);
      expect(calls.length).toBeLessThanOrEqual(limits[position]);
      expect(calls.filter((trap) => trap === 'get')).toEqual([]);
      expect(calls.filter((trap) => !['getPrototypeOf', 'ownKeys', 'getOwnPropertyDescriptor'].includes(trap))).toEqual([]);
    }
  });

  it('refuses a recording Proxy for the root or for a day record without firing a get trap', () => {
    for (const position of ['root', 'day'] as const) {
      const calls: string[] = [];
      const result = readCutoverShadowEvidence(standIn(position, (target) => recordingProxy(target, calls)), NOW);
      expect({ position, result }).toEqual({ position, result: ALL_FAILED });
      expect(calls.filter((trap) => trap === 'get')).toEqual([]);
    }
  });

  it('returns the typed refusal, never a throw, for a throwing-trap Proxy and for a revoked Proxy as the root, days, a day record or the verdicts', () => {
    for (const position of ['root', 'days', 'day', 'verdicts'] as const) {
      for (const [label, stand] of [['throwing', throwingProxy], ['revoked', revokedProxy]] as const) {
        const input = standIn(position, stand);
        let result: unknown = 'threw';
        expect(() => {
          result = readCutoverShadowEvidence(input, NOW);
        }).not.toThrow();
        expect({ position, label, result }).toEqual({ position, label, result: ALL_FAILED });
      }
    }
  });

  it('refuses an index getter, a day getter and a verdict getter inside a real days array, and invokes none of them', () => {
    // Each getter would answer the valid value it replaced, so a validator that ran one would
    // accept the document: only reading the descriptor, never the value, refuses it.
    const calls = { index: 0, day: 0, verdict: 0 };

    const indexGetter = evidence(NOW, (root) => {
      const days = root.days as DayRecord[];
      const first = days[0];
      Object.defineProperty(days, '0', {
        enumerable: true,
        configurable: true,
        get() {
          calls.index += 1;
          return first;
        },
      });
    });
    expect(Array.isArray((indexGetter as { days: unknown }).days)).toBe(true);
    expect(readCutoverShadowEvidence(indexGetter, NOW)).toEqual(ALL_FAILED);

    const dayGetter = evidence(NOW, (root) => {
      const record = (root.days as DayRecord[])[0];
      const value = record.day;
      Object.defineProperty(record, 'day', {
        enumerable: true,
        configurable: true,
        get() {
          calls.day += 1;
          return value;
        },
      });
    });
    expect(readCutoverShadowEvidence(dayGetter, NOW)).toEqual(ALL_FAILED);

    const verdictGetter = withVerdict(0, 'S3', {
      configurable: true,
      get() {
        calls.verdict += 1;
        return 'pass';
      },
    });
    expect(readCutoverShadowEvidence(verdictGetter, NOW)).toEqual(onlyFailed('S3'));

    expect(calls).toEqual({ index: 0, day: 0, verdict: 0 });
    // The fixtures are live: read directly, each getter does answer.
    void (indexGetter as { days: unknown[] }).days[0];
    void (dayGetter as { days: DayRecord[] }).days[0].day;
    void (verdictGetter as { days: DayRecord[] }).days[0].verdicts.S3;
    expect(calls).toEqual({ index: 1, day: 1, verdict: 1 });
  });

  it('refuses a document padded with thousands of extra keys after a constant number of descriptor reads', async () => {
    const padded: Record<string, unknown> = evidence(NOW) as Record<string, unknown>;
    for (let i = 0; i < 5000; i += 1) {
      padded[`padding${i}`] = i;
    }
    const descriptorReads = vi.spyOn(Object, 'getOwnPropertyDescriptor');
    try {
      expect(readCutoverShadowEvidence(padded, NOW)).toEqual(ALL_FAILED);
      expect(descriptorReads.mock.calls.length).toBeLessThan(20);
    } finally {
      descriptorReads.mockRestore();
    }
  });

  it('never echoes input values in its result', () => {
    const text = JSON.stringify(readCutoverShadowEvidence({ days: 'sentinel-days', merges: CUTOVER_SHADOW_MIN_MERGES }, NOW));
    expect(text).not.toContain('sentinel-days');
  });
});

const RETIREMENT_INVALID = { ok: false, reason: 'invalid-ledger' } as const;

/** A complete ledger over the pinned §1 scripts, every row verified. */
function verifiedRows(): Array<{ script: string; verified: boolean; evidenceLink: string }> {
  return CUTOVER_RETIREMENT_SCRIPTS.map((script, index) => ({
    script,
    verified: true,
    evidenceLink: `evidence/retirement-${index}.md`,
  }));
}

function ledger(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { schemaVersion: 1, rows: verifiedRows(), ...overrides };
}

function rowOverrides(index: number, overrides: Record<string, unknown>): unknown[] {
  const rows = verifiedRows();
  rows[index] = { ...rows[index], ...overrides };
  return rows;
}

/** Replace row `index` with a getter whose value is the original field value. */
function withRowGetter(index: number, key: string, calls: { count: number }): unknown[] {
  const rows = verifiedRows();
  const value = (rows[index] as Record<string, unknown>)[key];
  const target = rows[index] as Record<string, unknown>;
  Object.defineProperty(target, key, {
    enumerable: true,
    configurable: true,
    get() {
      calls.count += 1;
      return value;
    },
  });
  return rows;
}

describe('CUTOVER_RETIREMENT_SCRIPTS', () => {
  it('matches the §1 Train and Lane table Script column in the cutover plan, in exact membership and order', () => {
    const plan = readFileSync(
      new URL('../../../../../docs/planning/2026-11-03_cutover-plan.md', import.meta.url),
      'utf8',
    );
    const inventoryStart = plan.indexOf('## 1. Inventory');
    const inventoryEnd = plan.indexOf('## 2. Gaps', inventoryStart);
    expect(inventoryStart).toBeGreaterThan(0);
    expect(inventoryEnd).toBeGreaterThan(inventoryStart);
    const tableScripts = plan
      .slice(inventoryStart, inventoryEnd)
      .split('\n')
      .map((line) => /^\| `([^`]+)`/.exec(line)?.[1])
      .filter((script): script is string => script !== undefined && /^(train|lane)\//.test(script));
    expect(tableScripts.length).toBe(68);
    expect([...CUTOVER_RETIREMENT_SCRIPTS]).toEqual(tableScripts);
  });
});

describe('readRetirementLedger', () => {
  it('reads a complete verified ledger and always builds a fresh result object', () => {
    const raw = ledger();
    const result = readRetirementLedger(raw);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.ledger.schemaVersion).toBe(1);
    expect(result.ledger.rows).toEqual(verifiedRows());
    // An identity echo of the input would fail these: the ledger is freshly built.
    expect(result.ledger).not.toBe(raw);
    expect(result.ledger.rows).not.toBe(raw.rows);
    expect(result.ledger.rows[0]).not.toBe((raw.rows as unknown[])[0]);
    (raw.rows as unknown[])[0] = { script: 'mutated', verified: true, evidenceLink: 'x' };
    expect(JSON.stringify(result.ledger.rows[0])).not.toContain('mutated');
    // A reader returning a constant verdict would fail these: the ok verdict is
    // distinct from every refusal code the same input family produces.
    expect(readRetirementLedger(ledger({ rows: [] }))).toEqual({ ok: false, reason: 'empty-ledger' });
    expect(readRetirementLedger(ledger({ schemaVersion: 2 }))).toEqual({ ok: false, reason: 'unknown-version' });
    expect(readRetirementLedger(ledger({ rows: rowOverrides(0, { verified: false }) }))).toEqual({
      ok: false,
      reason: 'row-unverified',
    });
  });

  it('refuses null as invalid-ledger', () => {
    expect(readRetirementLedger(null)).toEqual(RETIREMENT_INVALID);
  });

  it('refuses undefined as invalid-ledger', () => {
    expect(readRetirementLedger(undefined)).toEqual(RETIREMENT_INVALID);
  });

  it('refuses a wrong primitive (a number, a string, a boolean) as invalid-ledger', () => {
    expect(readRetirementLedger(42)).toEqual(RETIREMENT_INVALID);
    expect(readRetirementLedger('str')).toEqual(RETIREMENT_INVALID);
    expect(readRetirementLedger(true)).toEqual(RETIREMENT_INVALID);
  });

  it('refuses a non-array object where the rows list is due as invalid-ledger', () => {
    expect(readRetirementLedger(ledger({ rows: { length: 68, 0: verifiedRows()[0] } }))).toEqual(RETIREMENT_INVALID);
    expect(readRetirementLedger(ledger({ rows: {} }))).toEqual(RETIREMENT_INVALID);
  });

  it('refuses a sparse rows array (an array hole) as invalid-ledger', () => {
    const rows = verifiedRows();
    delete (rows[3] as unknown as { script?: string }).script;
    const sparse = new Array(68);
    for (let i = 0; i < 68; i += 1) {
      if (i !== 3) sparse[i] = rows[i];
    }
    expect(readRetirementLedger(ledger({ rows: sparse }))).toEqual(RETIREMENT_INVALID);
  });

  it('refuses an array-like object standing in for rows as invalid-ledger', () => {
    const arrayLike = Object.assign(Object.create(null), { length: 68, 0: verifiedRows()[0], 1: verifiedRows()[1] });
    expect(readRetirementLedger(ledger({ rows: arrayLike }))).toEqual(RETIREMENT_INVALID);
  });

  it('refuses an enormous rows length (2**32 - 1) before any traversal as invalid-ledger', () => {
    const rows = [] as unknown[];
    Object.defineProperty(rows, 'length', { value: 2 ** 32 - 1 });
    const descriptorReads = vi.spyOn(Object, 'getOwnPropertyDescriptor');
    try {
      expect(readRetirementLedger(ledger({ rows }))).toEqual(RETIREMENT_INVALID);
      // The bound is settled before any descriptor walk over the rows.
      expect(descriptorReads.mock.calls.length).toBeLessThan(10);
    } finally {
      descriptorReads.mockRestore();
    }
  });

  it('refuses rows longer than RETIREMENT_LEDGER_MAX_ROWS as invalid-ledger', () => {
    expect(readRetirementLedger(ledger({ rows: new Array(256 + 1) }))).toEqual(RETIREMENT_INVALID);
  });

  it('refuses a getter on the root and on a row item, and never invokes either', () => {
    const calls = { count: 0 };
    const rootWithGetter = ledger() as Record<string, unknown>;
    const rowsValue = rootWithGetter.rows;
    Object.defineProperty(rootWithGetter, 'rows', {
      enumerable: true,
      configurable: true,
      get() {
        calls.count += 1;
        return rowsValue;
      },
    });
    expect(readRetirementLedger(rootWithGetter)).toEqual(RETIREMENT_INVALID);
    expect(readRetirementLedger(ledger({ rows: withRowGetter(0, 'script', calls) }))).toEqual(RETIREMENT_INVALID);
    expect(readRetirementLedger(ledger({ rows: withRowGetter(1, 'verified', calls) }))).toEqual(RETIREMENT_INVALID);
    expect(calls.count).toBe(0);
  });

  it('refuses a transparent Proxy over a valid ledger as invalid-ledger, without firing a get trap', () => {
    const TRAPS = [
      'apply', 'construct', 'defineProperty', 'deleteProperty', 'get', 'getOwnPropertyDescriptor', 'getPrototypeOf',
      'has', 'isExtensible', 'ownKeys', 'preventExtensions', 'set', 'setPrototypeOf',
    ] as const;
    const calls: string[] = [];
    const handler: Record<string, (...args: unknown[]) => unknown> = {};
    for (const trap of TRAPS) {
      handler[trap] = (...args) => {
        calls.push(trap);
        return (Reflect as unknown as Record<string, (...args: unknown[]) => unknown>)[trap](...args);
      };
    }
    const proxy = new Proxy(ledger() as object, handler as ProxyHandler<object>);
    expect(readRetirementLedger(proxy)).toEqual(RETIREMENT_INVALID);
    expect(calls.filter((trap) => trap === 'get')).toEqual([]);
  });

  it('refuses a prototype-polluting own key produced by JSON.parse as invalid-ledger', () => {
    const rows = JSON.stringify(verifiedRows());
    for (const key of ['__proto__', 'constructor', 'prototype']) {
      const parsed = JSON.parse(`{"rows":${rows},"${key}":{}}`);
      expect(readRetirementLedger(parsed)).toEqual(RETIREMENT_INVALID);
    }
  });

  it('refuses missing, extra and wrong-typed row keys as invalid-ledger', () => {
    const missingKey = verifiedRows();
    delete (missingKey[0] as { evidenceLink?: string }).evidenceLink;
    expect(readRetirementLedger(ledger({ rows: missingKey }))).toEqual(RETIREMENT_INVALID);
    expect(readRetirementLedger(ledger({ rows: rowOverrides(0, { evidenceLink: undefined }) }))).toEqual(
      RETIREMENT_INVALID,
    );
    expect(readRetirementLedger(ledger({ rows: rowOverrides(0, { extra: 1 }) }))).toEqual(RETIREMENT_INVALID);
    expect(readRetirementLedger(ledger({ rows: rowOverrides(0, { verified: 'yes' }) }))).toEqual(RETIREMENT_INVALID);
    expect(readRetirementLedger(ledger({ rows: rowOverrides(0, { script: 7 }) }))).toEqual(RETIREMENT_INVALID);
    expect(readRetirementLedger(ledger({ rows: rowOverrides(0, { evidenceLink: 7 }) }))).toEqual(RETIREMENT_INVALID);
  });

  it('refuses text exceeding RETIREMENT_LEDGER_MAX_TEXT_BYTES as invalid-ledger', () => {
    const longLink = 'e'.repeat(RETIREMENT_LEDGER_MAX_TEXT_BYTES + 1);
    expect(readRetirementLedger(ledger({ rows: rowOverrides(0, { evidenceLink: longLink }) }))).toEqual(
      RETIREMENT_INVALID,
    );
    // A script is pinned, so an over-long pinned name cannot exist; an over-long
    // non-pinned name is still refused as invalid-ledger by the byte bound.
    const longScript = 't'.repeat(RETIREMENT_LEDGER_MAX_TEXT_BYTES + 1);
    expect(readRetirementLedger(ledger({ rows: rowOverrides(0, { script: longScript }) }))).toEqual(RETIREMENT_INVALID);
    // An astral-plane string sits at the UTF-16 bound but exceeds the UTF-8 byte bound.
    const astral = '\u{1F600}'.repeat(RETIREMENT_LEDGER_MAX_TEXT_BYTES / 2);
    expect(readRetirementLedger(ledger({ rows: rowOverrides(0, { evidenceLink: astral }) }))).toEqual(
      RETIREMENT_INVALID,
    );
  });

  it('refuses duplicate script as invalid-ledger', () => {
    const rows = verifiedRows();
    const duplicate = { ...rows[0], evidenceLink: 'other.md' };
    rows.splice(1, 1, duplicate);
    expect(readRetirementLedger(ledger({ rows }))).toEqual(RETIREMENT_INVALID);
  });

  it('refuses missing or extra script row as invalid-ledger', () => {
    // Missing: a pinned script never appears.
    const missing = verifiedRows().slice(1);
    expect(readRetirementLedger(ledger({ rows: missing }))).toEqual(RETIREMENT_INVALID);
    // Extra: an unknown script replaces a pinned one.
    expect(readRetirementLedger(ledger({ rows: rowOverrides(0, { script: 'lane/not-pinned.sh' }) }))).toEqual(
      RETIREMENT_INVALID,
    );
  });

  it('reports newer schemaVersion as unknown-version', () => {
    expect(readRetirementLedger(ledger({ schemaVersion: 2 }))).toEqual({ ok: false, reason: 'unknown-version' });
    expect(readRetirementLedger(ledger({ schemaVersion: 99 }))).toEqual({ ok: false, reason: 'unknown-version' });
    for (const bad of [0, -1, 1.5, '1', null, true]) {
      expect(readRetirementLedger(ledger({ schemaVersion: bad }))).toEqual(RETIREMENT_INVALID);
    }
  });

  it('refuses empty rows array as empty-ledger', () => {
    expect(readRetirementLedger(ledger({ rows: [] }))).toEqual({ ok: false, reason: 'empty-ledger' });
  });

  it('refuses unverified row or blank evidenceLink as row-unverified', () => {
    expect(readRetirementLedger(ledger({ rows: rowOverrides(0, { verified: false }) }))).toEqual({
      ok: false,
      reason: 'row-unverified',
    });
    expect(readRetirementLedger(ledger({ rows: rowOverrides(0, { evidenceLink: '   ' }) }))).toEqual({
      ok: false,
      reason: 'row-unverified',
    });
    expect(readRetirementLedger(ledger({ rows: rowOverrides(0, { evidenceLink: '' }) }))).toEqual({
      ok: false,
      reason: 'row-unverified',
    });
  });

  it('refuses secret-shaped script or evidenceLink as secret-shaped', () => {
    expect(
      readRetirementLedger(ledger({ rows: rowOverrides(0, { script: 'lane/ghp_ABCDEF0123456789abcdefghij.sh' }) })),
    ).toEqual({ ok: false, reason: 'secret-shaped' });
    expect(
      readRetirementLedger(ledger({ rows: rowOverrides(0, { evidenceLink: 'evidence/ghp_ABCDEF0123456789abcdefghij' }) })),
    ).toEqual({ ok: false, reason: 'secret-shaped' });
  });
});
