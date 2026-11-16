import { describe, expect, it, vi } from 'vitest';

import {
  CUTOVER_ROLLBACK_WINDOW_MS,
  CUTOVER_RECORD_SCHEMA_VERSION,
  CUTOVER_SHADOW_CRITERIA,
  CUTOVER_SHADOW_MIN_MERGES,
  canonicalCutoverRetirePayload,
  canonicalCutoverRollbackPayload,
  canonicalCutoverSwitchPayload,
  cutoverJournalKey,
  isWithinCutoverRollbackWindow,
  readCutoverRecord,
  readCutoverShadowEvidence,
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
      days: [2, 1, 0].map((back) => ({
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

  it('accepts three consecutive pass days', () => {
    expect(readCutoverShadowEvidence(evidence(NOW), NOW)).toEqual({ ok: true });
    // The last day may equal the UTC date of nowIso but not follow it.
    expect(readCutoverShadowEvidence(evidence('2026-11-05T00:00:00.000Z'), NOW)).toEqual({ ok: true });
    expect(readCutoverShadowEvidence(evidence(NOW, undefined, CUTOVER_SHADOW_MIN_MERGES + 1), NOW)).toEqual({ ok: true });
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

  it('names only S4 when that verdict is unknown', () => {
    expect(readCutoverShadowEvidence(withVerdict(2, 'S4', { value: 'unknown' }), NOW)).toEqual(onlyFailed('S4'));
  });

  it('refuses a future, gapped, duplicate or non-calendar day with every criterion named', () => {
    const base = Date.parse(NOW);
    type DayRecord = { day: string; verdicts: Record<string, unknown> };
    const future = evidence(NOW, (root) => {
      const days = root.days as DayRecord[];
      days[2] = { day: new Date(base + DAY_MS).toISOString().slice(0, 10), verdicts: passVerdicts() };
    });
    expect(readCutoverShadowEvidence(future, NOW)).toEqual(ALL_FAILED);
    const gapped = evidence(NOW, (root) => {
      const days = root.days as DayRecord[];
      days[1] = { day: new Date(base - 5 * DAY_MS).toISOString().slice(0, 10), verdicts: passVerdicts() };
    });
    expect(readCutoverShadowEvidence(gapped, NOW)).toEqual(ALL_FAILED);
    const duplicate = evidence(NOW, (root) => {
      const days = root.days as DayRecord[];
      days[1] = { ...days[2] };
    });
    expect(readCutoverShadowEvidence(duplicate, NOW)).toEqual(ALL_FAILED);
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

    expect(readCutoverShadowEvidence(withVerdict(1, 'S7', { value: 7 }), NOW)).toEqual(onlyFailed('S7'));
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
        withVerdict(2, 'S6', {
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
      readCutoverShadowEvidence(docWith([new Proxy(dayRecord, {}), validDays[1], validDays[2]]), NOW),
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

  it('refuses a recording Proxy for days after at most 6 trap calls and for verdicts after at most 15, and never fires a get trap', () => {
    // The Proxy forwards every operation to valid data, so only the final serializer probe can
    // refuse it. Before that the walk may look at it through a constant number of traps fixed by
    // the permitted key lists: one prototype read, one key list and one descriptor read per
    // permitted key (`length`, `0`, `1`, `2` for days; the thirteen criteria for verdicts).
    const limits = { days: 6, verdicts: 15 } as const;
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
      const record = (root.days as DayRecord[])[1];
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

    const verdictGetter = withVerdict(2, 'S3', {
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
    void (dayGetter as { days: DayRecord[] }).days[1].day;
    void (verdictGetter as { days: DayRecord[] }).days[2].verdicts.S3;
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
