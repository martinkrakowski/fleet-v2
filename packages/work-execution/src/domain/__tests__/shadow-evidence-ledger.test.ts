// Lane SH1: tests for the pure shadow-evidence ledger and evidence composer.
// Every refusal code from the brief gets a titled test; the end-to-end tests
// compose with `composeCutoverShadowEvidence` and feed the result straight
// into the existing `readCutoverShadowEvidence`.
import { describe, expect, it } from 'vitest';

import { CUTOVER_SHADOW_CRITERIA, readCutoverShadowEvidence, type CutoverShadowCriterion } from '../cutover-records.js';
import {
  composeCutoverShadowEvidence,
  recordShadowVerdicts,
  readShadowLedger,
  SHADOW_LEDGER_MAX_DAYS,
  type ShadowCriterionVerdict,
  type ShadowLedger,
  type ShadowVerdictsInput,
} from '../shadow-evidence-ledger.js';

const DIGEST = 'a'.repeat(64);
const OTHER_DIGEST = 'b'.repeat(64);
const RECORDED_AT = '2026-02-03T00:00:00Z';
const RELEASE_SHA = 'c'.repeat(40);
const OTHER_RELEASE_SHA = 'd'.repeat(40);
const D1 = '2026-02-01';
const D2 = '2026-02-02';
const D3 = '2026-02-03';
const NOW = `${D3}T23:59:59Z`;
const DAY_MS = 86_400_000;

/** A secret-shaped reason that still matches the reason code pattern. */
const SECRET_REASON = `sk-${'a'.repeat(24)}`;

function passVerdict(overrides: Partial<ShadowCriterionVerdict> = {}): ShadowCriterionVerdict {
  return { verdict: 'pass', reason: 'ok', digest: DIGEST, recordedAtIso: RECORDED_AT, ...overrides };
}

function allPassVerdicts(): Record<CutoverShadowCriterion, ShadowCriterionVerdict> {
  const verdicts = {} as Record<CutoverShadowCriterion, ShadowCriterionVerdict>;
  for (const criterion of CUTOVER_SHADOW_CRITERIA) {
    verdicts[criterion] = passVerdict();
  }
  return verdicts;
}

/** Verdicts for every criterion except `missing`. */
function verdictsMissing(missing: CutoverShadowCriterion): Partial<Record<CutoverShadowCriterion, ShadowCriterionVerdict>> {
  const verdicts = allPassVerdicts();
  const copy: Partial<Record<CutoverShadowCriterion, ShadowCriterionVerdict>> = { ...verdicts };
  delete copy[missing];
  return copy;
}

function dayInput(
  day: string,
  merges: number | undefined,
  verdicts: Partial<Record<CutoverShadowCriterion, ShadowCriterionVerdict>> = allPassVerdicts(),
  releaseSha: string | null = RELEASE_SHA,
): ShadowVerdictsInput {
  return { day, releaseSha, mergesCompared: merges, verdicts };
}

/** Fold the day inputs into a ledger with `recordShadowVerdicts`, starting from nothing. */
function buildLedger(days: readonly ShadowVerdictsInput[]): ShadowLedger {
  let ledger: unknown = null;
  for (const input of days) {
    const result = recordShadowVerdicts(ledger, input);
    if (!result.ok) {
      throw new Error(`buildLedger day ${input.day} refused: ${result.reason}`);
    }
    ledger = result.ledger;
  }
  return ledger as ShadowLedger;
}

function dateOn(offset: number): string {
  return new Date(Date.UTC(2026, 0, 1) + offset * DAY_MS).toISOString().slice(0, 10);
}

function readFailure(raw: unknown, reason: 'unknown-version' | 'invalid-ledger'): void {
  expect(readShadowLedger(raw)).toEqual({ ok: false, reason });
}

describe('shadow evidence ledger (SH1)', () => {
  describe('readShadowLedger', () => {
    it('round-trips a ledger built with recordShadowVerdicts', () => {
      const ledger = buildLedger([dayInput(D1, 7), dayInput(D2, 7), dayInput(D3, 6)]);
      const read = readShadowLedger(ledger);
      expect(read).toEqual({ ok: true, ledger });
    });

    it('returns a fresh structure, never the input reference (no identity echo)', () => {
      const ledger = buildLedger([dayInput(D1, 7)]);
      const read = readShadowLedger(ledger);
      if (!read.ok) {
        throw new Error('expected ok');
      }
      expect(read.ledger).not.toBe(ledger);
      expect(read.ledger.days[0]).not.toBe(ledger.days[0]);
      expect(read.ledger.days[0].verdicts.S1).not.toBe(ledger.days[0].verdicts.S1);
    });

    it('is not satisfiable by a constant: different ledgers read differently', () => {
      const one = buildLedger([dayInput(D1, 7)]);
      const two = buildLedger([dayInput(D1, 7), dayInput(D2, 3)]);
      expect(readShadowLedger(one)).toEqual({ ok: true, ledger: one });
      expect(readShadowLedger(two)).toEqual({ ok: true, ledger: two });
      expect(readShadowLedger(one)).not.toEqual(readShadowLedger(two));
    });

    it('refuses a schema version above the current one with unknown-version', () => {
      const ledger = { ...buildLedger([dayInput(D1, 7)]), schemaVersion: 2 };
      readFailure(ledger, 'unknown-version');
    });

    it('refuses a schema version of 0 with invalid-ledger', () => {
      const ledger = { ...buildLedger([dayInput(D1, 7)]), schemaVersion: 0 };
      readFailure(ledger, 'invalid-ledger');
    });

    it('refuses a fractional schema version with invalid-ledger', () => {
      const ledger = { ...buildLedger([dayInput(D1, 7)]), schemaVersion: 1.5 };
      readFailure(ledger, 'invalid-ledger');
    });

    it('refuses a string schema version with invalid-ledger', () => {
      const ledger = { ...buildLedger([dayInput(D1, 7)]), schemaVersion: '2' };
      readFailure(ledger, 'invalid-ledger');
    });

    it('refuses a negative schema version with invalid-ledger', () => {
      const ledger = { ...buildLedger([dayInput(D1, 7)]), schemaVersion: -1 };
      readFailure(ledger, 'invalid-ledger');
    });

    it('refuses null with invalid-ledger', () => {
      readFailure(null, 'invalid-ledger');
    });

    it('refuses undefined with invalid-ledger', () => {
      readFailure(undefined, 'invalid-ledger');
    });

    it('refuses a number where the record is due with invalid-ledger', () => {
      readFailure(7, 'invalid-ledger');
    });

    it('refuses a record missing the days key with invalid-ledger', () => {
      readFailure({ revision: 1 }, 'invalid-ledger');
    });

    it('refuses a record with an extra root key with invalid-ledger', () => {
      const ledger = { ...buildLedger([dayInput(D1, 7)]), extra: true };
      readFailure(ledger, 'invalid-ledger');
    });

    it('refuses revision 0 with invalid-ledger', () => {
      readFailure({ revision: 0, days: [] }, 'invalid-ledger');
    });

    it('refuses a non-integer revision with invalid-ledger', () => {
      readFailure({ revision: 1.5, days: [] }, 'invalid-ledger');
    });

    it('refuses a revision above one billion with invalid-ledger', () => {
      readFailure({ revision: 1_000_000_001, days: [] }, 'invalid-ledger');
    });

    it('refuses an array-like object where the days list is due with invalid-ledger', () => {
      readFailure({ revision: 1, days: { length: 1, 0: { day: D1, releaseSha: null, mergesCompared: null, verdicts: {} } } }, 'invalid-ledger');
    });

    it('refuses a days array with a hole (sparse array) with invalid-ledger', () => {
      const sparse: unknown[] = new Array(2);
      sparse[1] = { day: D2, releaseSha: null, mergesCompared: null, verdicts: {} };
      readFailure({ revision: 1, days: sparse }, 'invalid-ledger');
    });

    it('refuses an enormous sparse length before any traversal with invalid-ledger', () => {
      const sparse: unknown[] = [];
      Object.defineProperty(sparse, 'length', { value: 2 ** 32 - 1 });
      readFailure({ revision: 1, days: sparse }, 'invalid-ledger');
    });

    it('refuses more than 31 days with invalid-ledger', () => {
      const days = Array.from({ length: SHADOW_LEDGER_MAX_DAYS + 1 }, (_, index) => ({
        day: dateOn(index),
        releaseSha: null,
        mergesCompared: null,
        verdicts: {},
      }));
      readFailure({ revision: 1, days }, 'invalid-ledger');
    });

    it('refuses non-ascending days with invalid-ledger', () => {
      readFailure({ revision: 1, days: [{ day: D2, releaseSha: null, mergesCompared: null, verdicts: {} }, { day: D1, releaseSha: null, mergesCompared: null, verdicts: {} }] }, 'invalid-ledger');
    });

    it('refuses equal consecutive days with invalid-ledger', () => {
      readFailure({ revision: 1, days: [{ day: D1, releaseSha: null, mergesCompared: null, verdicts: {} }, { day: D1, releaseSha: null, mergesCompared: null, verdicts: {} }] }, 'invalid-ledger');
    });

    it('refuses a calendar-invalid date with invalid-ledger', () => {
      readFailure({ revision: 1, days: [{ day: '2026-02-30', releaseSha: null, mergesCompared: null, verdicts: {} }] }, 'invalid-ledger');
    });

    it('refuses a day record with an extra key with invalid-ledger', () => {
      const ledger = buildLedger([dayInput(D1, 7)]);
      const day = ledger.days[0] as unknown as Record<string, unknown>;
      readFailure({ revision: 1, days: [{ ...day, extra: true }] }, 'invalid-ledger');
    });

    it('refuses a verdict value missing a key with invalid-ledger', () => {
      const day = { day: D1, releaseSha: null, mergesCompared: null, verdicts: { S1: { verdict: 'pass', reason: 'ok', digest: DIGEST } } };
      readFailure({ revision: 1, days: [day] }, 'invalid-ledger');
    });

    it('refuses a verdict with a bad digest with invalid-ledger', () => {
      const day = { day: D1, releaseSha: null, mergesCompared: null, verdicts: { S1: passVerdict({ digest: 'zz' }) } };
      readFailure({ revision: 1, days: [day] }, 'invalid-ledger');
    });

    it('refuses a verdict with an uppercase reason with invalid-ledger', () => {
      const day = { day: D1, releaseSha: null, mergesCompared: null, verdicts: { S1: passVerdict({ reason: 'OK' }) } };
      readFailure({ revision: 1, days: [day] }, 'invalid-ledger');
    });

    it('refuses a secret-shaped reason string anywhere with invalid-ledger', () => {
      const day = { day: D1, releaseSha: null, mergesCompared: null, verdicts: { S1: passVerdict({ reason: SECRET_REASON }) } };
      readFailure({ revision: 1, days: [day] }, 'invalid-ledger');
    });

    it('refuses a naive (non-zoned) recordedAtIso with invalid-ledger', () => {
      const day = { day: D1, releaseSha: null, mergesCompared: null, verdicts: { S1: passVerdict({ recordedAtIso: '2026-02-03T00:00:00' }) } };
      readFailure({ revision: 1, days: [day] }, 'invalid-ledger');
    });

    it('refuses a negative mergesCompared with invalid-ledger', () => {
      const day = { day: D1, releaseSha: null, mergesCompared: -1, verdicts: allPassVerdicts() };
      readFailure({ revision: 1, days: [day] }, 'invalid-ledger');
    });

    it('refuses a mergesCompared above the per-day cap with invalid-ledger', () => {
      const day = { day: D1, releaseSha: null, mergesCompared: 10_001, verdicts: allPassVerdicts() };
      readFailure({ revision: 1, days: [day] }, 'invalid-ledger');
    });

    it('refuses non-null mergesCompared without an S1 verdict with invalid-ledger', () => {
      const day = { day: D1, releaseSha: null, mergesCompared: 7, verdicts: verdictsMissing('S1') };
      readFailure({ revision: 1, days: [day] }, 'invalid-ledger');
    });

    it('refuses a release sha of the wrong shape with invalid-ledger', () => {
      readFailure({ revision: 1, days: [{ day: D1, releaseSha: 'abc', mergesCompared: null, verdicts: {} }] }, 'invalid-ledger');
    });

    it('refuses a prototype-polluting verdicts key produced by JSON.parse with invalid-ledger', () => {
      const day = JSON.parse(`{"day":"${D1}","releaseSha":null,"mergesCompared":null,"verdicts":{"__proto__":{"verdict":"pass","reason":"ok","digest":"${DIGEST}","recordedAtIso":"${RECORDED_AT}"}}}`);
      readFailure({ revision: 1, days: [day] }, 'invalid-ledger');
    });

    it('a Proxy over a valid ledger yields exactly the plain data, running no get trap', () => {
      // Fix-round note: the brief's hostile-input rule allows either outcome
      // for a transparent Proxy — refused, or an exact match to the plain
      // data — as long as no `get` trap ever runs. This used to be refused
      // only because `structuredClone` (removed by the finding-1 fix above)
      // throws on any Proxy exotic object; every read here now goes through
      // `Object.getOwnPropertyDescriptor`/`Reflect.ownKeys`, so the Proxy is
      // indistinguishable from its target and the result matches it exactly.
      const ledger = buildLedger([dayInput(D1, 7)]);
      const traps = { get: 0 };
      const proxy = new Proxy(ledger as unknown as object, {
        get(target, property, receiver) {
          traps.get += 1;
          return Reflect.get(target, property, receiver);
        },
      });
      expect(readShadowLedger(proxy)).toEqual({ ok: true, ledger });
      expect(traps.get).toBe(0);
    });

    it('never runs a getter on the root (call counter stays 0)', () => {
      const ledger = { ...buildLedger([dayInput(D1, 7)]) };
      const counter = { calls: 0 };
      Object.defineProperty(ledger, 'revision', {
        enumerable: true,
        get() {
          counter.calls += 1;
          return 1;
        },
      });
      readFailure(ledger, 'invalid-ledger');
      expect(counter.calls).toBe(0);
    });

    it('never runs a getter on a verdict item (call counter stays 0)', () => {
      const verdict = passVerdict();
      const counter = { calls: 0 };
      Object.defineProperty(verdict, 'reason', {
        enumerable: true,
        get() {
          counter.calls += 1;
          return 'ok';
        },
      });
      const day = { day: D1, releaseSha: null, mergesCompared: null, verdicts: { S1: verdict } };
      readFailure({ revision: 1, days: [day] }, 'invalid-ledger');
      expect(counter.calls).toBe(0);
    });

    it('never runs a getter planted as an extra enumerable property on the days array', () => {
      // Fix-round proof (break-and-restore, reasoned rather than re-run): the
      // earlier code validated `days` only through its length and per-index
      // descriptor reads, then called `structuredClone(raw)` on the whole,
      // still-untrusted root object as a Proxy probe. `structuredClone` walks
      // every enumerable own property of every nested object and array to
      // clone it — including one neither the length check nor the per-index
      // loop below ever names — so it would have read this `extra` getter's
      // value and the counter would have left 0 and become 1. The fix removes
      // the clone of untrusted input entirely and instead refuses any `days`
      // array whose own enumerable key count exceeds its `length` (this
      // `extra` key does), so the getter is never reached in the first place.
      let counter = 0;
      const days: unknown[] = [
        { day: D1, releaseSha: null, mergesCompared: null, verdicts: {} },
        { day: D2, releaseSha: null, mergesCompared: null, verdicts: {} },
      ];
      Object.defineProperty(days, 'extra', {
        enumerable: true,
        configurable: true,
        get() {
          counter += 1;
          return 1;
        },
      });
      readFailure({ revision: 1, days }, 'invalid-ledger');
      expect(counter).toBe(0);
    });
  });

  describe('recordShadowVerdicts', () => {
    it('records three days and reports the revision climbing and changed true', () => {
      const first = recordShadowVerdicts(null, dayInput(D1, 7));
      if (!first.ok) {
        throw new Error('expected ok');
      }
      expect(first.changed).toBe(true);
      expect(first.ledger.revision).toBe(1);
      const second = recordShadowVerdicts(first.ledger, dayInput(D2, 7));
      if (!second.ok) {
        throw new Error('expected ok');
      }
      expect(second.ledger.revision).toBe(2);
      expect(second.ledger.days.map((day) => day.day)).toEqual([D1, D2]);
    });

    it('is idempotent: an equal re-record changes nothing and bumps no revision', () => {
      const ledger = buildLedger([dayInput(D1, 7)]);
      const again = recordShadowVerdicts(ledger, dayInput(D1, 7));
      expect(again).toEqual({ ok: true, ledger: { ...ledger, revision: ledger.revision }, changed: false });
      expect(again.ok && again.ledger.revision).toBe(ledger.revision);
    });

    it('keeps the recorded verdict (including recordedAtIso) when a re-record matches on verdict, reason and digest', () => {
      const ledger = buildLedger([{ ...dayInput(D1, 7), verdicts: { S1: passVerdict() } }]);
      const reRecorded = recordShadowVerdicts(ledger, {
        day: D1,
        releaseSha: RELEASE_SHA,
        verdicts: { S1: passVerdict({ recordedAtIso: '2026-02-04T12:00:00Z' }) },
      });
      expect(reRecorded).toEqual({ ok: true, ledger: { ...ledger, revision: ledger.revision }, changed: false });
      expect(reRecorded.ok && reRecorded.ledger.days[0].verdicts.S1?.recordedAtIso).toBe(RECORDED_AT);
    });

    it('refuses a Proxy over the input whose ownKeys trap throws with invalid-input', () => {
      const proxy = new Proxy(dayInput(D1, 7) as unknown as object, {
        ownKeys() {
          throw new Error('trap');
        },
      });
      expect(recordShadowVerdicts(null, proxy)).toEqual({ ok: false, reason: 'invalid-input' });
    });

    it('refuses a real change on a ledger at the revision cap with invalid-ledger', () => {
      const ledger = buildLedger([dayInput(D1, 7)]);
      const atCap = { ...ledger, revision: 1_000_000_000 };
      expect(recordShadowVerdicts(atCap, dayInput(D2, 7))).toEqual({ ok: false, reason: 'invalid-ledger' });
    });

    it('allows an idempotent no-op on a ledger at the revision cap (changed false, revision kept)', () => {
      const ledger = buildLedger([dayInput(D1, 7)]);
      const atCap = { ...ledger, revision: 1_000_000_000 };
      expect(recordShadowVerdicts(atCap, dayInput(D1, 7))).toEqual({
        ok: true,
        ledger: { ...atCap, revision: 1_000_000_000 },
        changed: false,
      });
    });

    it('returns a fresh structure, never mutating the ledger or input arguments', () => {
      const ledger = buildLedger([dayInput(D1, 7)]);
      const before = JSON.stringify(ledger);
      const input = dayInput(D2, 7);
      const inputBefore = JSON.stringify(input);
      const result = recordShadowVerdicts(ledger, input);
      if (!result.ok) {
        throw new Error('expected ok');
      }
      expect(result.ledger).not.toBe(ledger);
      expect(JSON.stringify(ledger)).toBe(before);
      expect(JSON.stringify(input)).toBe(inputBefore);
    });

    it('refuses a null input with invalid-input', () => {
      expect(recordShadowVerdicts(null, null)).toEqual({ ok: false, reason: 'invalid-input' });
    });

    it('refuses an undefined input with invalid-input', () => {
      expect(recordShadowVerdicts(null, undefined)).toEqual({ ok: false, reason: 'invalid-input' });
    });

    it('refuses a number where the input record is due with invalid-input', () => {
      expect(recordShadowVerdicts(null, 5)).toEqual({ ok: false, reason: 'invalid-input' });
    });

    it('refuses an input missing the verdicts key with invalid-input', () => {
      expect(recordShadowVerdicts(null, { day: D1, releaseSha: null })).toEqual({ ok: false, reason: 'invalid-input' });
    });

    it('refuses an input with an extra key with invalid-input', () => {
      expect(recordShadowVerdicts(null, { ...dayInput(D1, 7), extra: true })).toEqual({ ok: false, reason: 'invalid-input' });
    });

    it('refuses a malformed day date with invalid-input', () => {
      expect(recordShadowVerdicts(null, dayInput('2026-02-30', undefined))).toEqual({ ok: false, reason: 'invalid-input' });
    });

    it('refuses a bad release sha with invalid-input', () => {
      expect(recordShadowVerdicts(null, dayInput(D1, undefined, allPassVerdicts(), 'short'))).toEqual({ ok: false, reason: 'invalid-input' });
    });

    it('refuses a negative mergesCompared with invalid-input', () => {
      expect(recordShadowVerdicts(null, dayInput(D1, -1))).toEqual({ ok: false, reason: 'invalid-input' });
    });

    it('refuses a mergesCompared above the per-day cap with invalid-input', () => {
      expect(recordShadowVerdicts(null, dayInput(D1, 10_001))).toEqual({ ok: false, reason: 'invalid-input' });
    });

    it('refuses a mergesCompared without an S1 verdict on a new day with invalid-input', () => {
      expect(recordShadowVerdicts(null, dayInput(D1, 7, verdictsMissing('S1')))).toEqual({ ok: false, reason: 'invalid-input' });
    });

    it('refuses a verdicts array where the verdicts record is due with invalid-input', () => {
      expect(recordShadowVerdicts(null, dayInput(D1, undefined, [] as unknown as Partial<Record<CutoverShadowCriterion, ShadowCriterionVerdict>>))).toEqual({ ok: false, reason: 'invalid-input' });
    });

    it('refuses a verdicts record with an unknown criterion with invalid-input', () => {
      const verdicts = { ...allPassVerdicts(), S99: passVerdict() };
      expect(recordShadowVerdicts(null, dayInput(D1, undefined, verdicts))).toEqual({ ok: false, reason: 'invalid-input' });
    });

    it('never runs a getter on the input day field (call counter stays 0)', () => {
      const input = { ...dayInput(D1, 7) };
      const counter = { calls: 0 };
      Object.defineProperty(input, 'day', {
        enumerable: true,
        get() {
          counter.calls += 1;
          return D1;
        },
      });
      expect(recordShadowVerdicts(null, input)).toEqual({ ok: false, reason: 'invalid-input' });
      expect(counter.calls).toBe(0);
    });

    it('refuses an input whose mergesCompared is an accessor, never reading it as absent', () => {
      let counter = 0;
      const input: Record<string, unknown> = {
        day: D1,
        releaseSha: null,
        verdicts: { S1: passVerdict() },
      };
      Object.defineProperty(input, 'mergesCompared', {
        enumerable: true,
        configurable: true,
        get() {
          counter += 1;
          return 7;
        },
      });
      expect(recordShadowVerdicts(null, input)).toEqual({ ok: false, reason: 'invalid-input' });
      expect(counter).toBe(0);
    });

    it('refuses a new day sorting before the last stored day with day-out-of-order', () => {
      const ledger = buildLedger([dayInput(D2, 7)]);
      expect(recordShadowVerdicts(ledger, dayInput(D1, 7))).toEqual({ ok: false, reason: 'day-out-of-order' });
    });

    it('does not let a two-digit year sort after the following century (Date.UTC quirk)', () => {
      // `Date.UTC`/the multi-argument `Date` constructor treat a year of 0-99
      // as 1900-1999. With that quirk still in the day-serial computation,
      // '0099-12-31' would compute as if it were 1999-12-31 and so sort AFTER
      // '0100-01-01' (year 100, outside the special-cased range and so
      // unaffected): the second call below would have been wrongly refused
      // as day-out-of-order. Fixed by computing the serial with
      // `setUTCFullYear`, which carries no such special case.
      const first = recordShadowVerdicts(null, dayInput('0099-12-31', 7));
      if (!first.ok) {
        throw new Error(`expected ok, got ${first.reason}`);
      }
      const second = recordShadowVerdicts(first.ledger, dayInput('0100-01-01', 7));
      expect(second).toEqual({ ok: true, ledger: expect.objectContaining({ revision: 2 }), changed: true });
    });

    it('refuses a differing re-record of a recorded criterion with verdict-conflict', () => {
      const ledger = buildLedger([dayInput(D1, 7)]);
      const before = JSON.stringify(ledger);
      const verdicts = allPassVerdicts();
      verdicts.S4 = passVerdict({ reason: 'different' });
      expect(recordShadowVerdicts(ledger, dayInput(D1, undefined, verdicts))).toEqual({ ok: false, reason: 'verdict-conflict' });
      expect(JSON.stringify(ledger)).toBe(before);
    });

    it('refuses a differing digest re-record with verdict-conflict', () => {
      const ledger = buildLedger([dayInput(D1, 7)]);
      const verdicts = allPassVerdicts();
      verdicts.S4 = passVerdict({ digest: OTHER_DIGEST });
      expect(recordShadowVerdicts(ledger, dayInput(D1, undefined, verdicts))).toEqual({ ok: false, reason: 'verdict-conflict' });
    });

    it('refuses a differing verdict flag re-record with verdict-conflict', () => {
      const ledger = buildLedger([dayInput(D1, 7)]);
      const verdicts = allPassVerdicts();
      verdicts.S4 = passVerdict({ verdict: 'fail' });
      expect(recordShadowVerdicts(ledger, dayInput(D1, undefined, verdicts))).toEqual({ ok: false, reason: 'verdict-conflict' });
    });

    it('refuses a different release sha once one is recorded with release-conflict', () => {
      const ledger = buildLedger([dayInput(D1, 7)]);
      expect(recordShadowVerdicts(ledger, dayInput(D1, undefined, allPassVerdicts(), OTHER_RELEASE_SHA))).toEqual({ ok: false, reason: 'release-conflict' });
    });

    it('refuses a null release sha once a non-null one is recorded with release-conflict', () => {
      const ledger = buildLedger([dayInput(D1, 7)]);
      expect(recordShadowVerdicts(ledger, dayInput(D1, undefined, allPassVerdicts(), null))).toEqual({ ok: false, reason: 'release-conflict' });
    });

    it('refuses a different non-null mergesCompared once one is recorded with merges-conflict', () => {
      const ledger = buildLedger([dayInput(D1, 7)]);
      expect(recordShadowVerdicts(ledger, dayInput(D1, 8))).toEqual({ ok: false, reason: 'merges-conflict' });
    });

    it('accepts a mergesCompared set from null to a value on a later call', () => {
      const first = recordShadowVerdicts(null, dayInput(D1, undefined));
      if (!first.ok) {
        throw new Error('expected ok');
      }
      expect(first.ledger.days[0].mergesCompared).toBeNull();
      const second = recordShadowVerdicts(first.ledger, dayInput(D1, 7));
      expect(second.ok && second.ledger.days[0].mergesCompared).toBe(7);
      expect(second.ok && second.changed).toBe(true);
    });

    it('accepts a release sha set from null to a value on a later call', () => {
      const first = recordShadowVerdicts(null, dayInput(D1, 7, allPassVerdicts(), null));
      if (!first.ok) {
        throw new Error('expected ok');
      }
      const second = recordShadowVerdicts(first.ledger, dayInput(D1, 7, allPassVerdicts(), RELEASE_SHA));
      expect(second.ok && second.ledger.days[0].releaseSha).toBe(RELEASE_SHA);
    });

    it('merges new criteria into an existing day without dropping recorded ones', () => {
      const first = recordShadowVerdicts(null, dayInput(D1, 7, verdictsMissing('S13')));
      if (!first.ok) {
        throw new Error('expected ok');
      }
      const second = recordShadowVerdicts(first.ledger, { ...dayInput(D1, 7), verdicts: { S13: passVerdict() } });
      expect(second.ok && Object.keys(second.ledger.days[0].verdicts).length).toBe(13);
    });

    it('refuses a non-null invalid ledger argument with invalid-ledger', () => {
      expect(recordShadowVerdicts({ nope: true }, dayInput(D1, 7))).toEqual({ ok: false, reason: 'invalid-ledger' });
    });

    it('prunes to the newest 31 days, dropping the oldest first, on a real change', () => {
      let ledger: unknown = null;
      for (let offset = 0; offset <= SHADOW_LEDGER_MAX_DAYS; offset += 1) {
        const result = recordShadowVerdicts(ledger, dayInput(dateOn(offset), 1));
        if (!result.ok) {
          throw new Error(`unexpected refusal: ${result.reason}`);
        }
        ledger = result.ledger;
      }
      const read = readShadowLedger(ledger);
      if (!read.ok) {
        throw new Error('expected the pruned ledger to still read');
      }
      expect(read.ledger.days.length).toBe(SHADOW_LEDGER_MAX_DAYS);
      expect(read.ledger.days[0].day).toBe(dateOn(1));
      expect(read.ledger.days[SHADOW_LEDGER_MAX_DAYS - 1].day).toBe(dateOn(SHADOW_LEDGER_MAX_DAYS));
    });
  });

  describe('composeCutoverShadowEvidence', () => {
    function threeDays(merges: [number, number, number], day2Verdicts = allPassVerdicts(), thirdDay = D3): ShadowLedger {
      return buildLedger([
        dayInput(D1, merges[0]),
        dayInput(D2, merges[1], day2Verdicts),
        dayInput(thirdDay, merges[2]),
      ]);
    }

    it('composes the newest three days with only the recorded criteria, unpadded', () => {
      const full = buildLedger([dayInput(D1, 7), dayInput(D2, 7), dayInput(D3, 6)]);
      const composedFull = composeCutoverShadowEvidence(full, NOW, { requireSingleRelease: false });
      if (composedFull.status !== 'ok') {
        throw new Error('expected ok');
      }
      expect(Object.keys(composedFull.evidence.days[0].verdicts).length).toBe(13);
      const partial = buildLedger([dayInput(D1, 7), dayInput(D2, 7), { ...dayInput(D3, undefined), verdicts: { S1: passVerdict() } }]);
      const composedPartial = composeCutoverShadowEvidence(partial, NOW, { requireSingleRelease: false });
      if (composedPartial.status !== 'ok') {
        throw new Error('expected ok');
      }
      expect(Object.keys(composedPartial.evidence.days[2].verdicts)).toEqual(['S1']);
    });

    it('treats a null mergesCompared as 0 in the sum', () => {
      const ledger = buildLedger([dayInput(D1, 7), dayInput(D2, 13), dayInput(D3, undefined)]);
      const composed = composeCutoverShadowEvidence(ledger, NOW, { requireSingleRelease: false });
      expect(composed.status === 'ok' && composed.evidence.merges).toBe(20);
    });

    it('returns freshly built objects, never a reference into the ledger', () => {
      const ledger = threeDays([7, 7, 6]);
      const composed = composeCutoverShadowEvidence(ledger, NOW, { requireSingleRelease: false });
      if (composed.status !== 'ok') {
        throw new Error('expected ok');
      }
      expect(composed.evidence.days[0].verdicts).not.toBe((ledger.days[0].verdicts as unknown) as object);
    });

    it('refuses a null ledger with no-ledger', () => {
      expect(composeCutoverShadowEvidence(null, NOW, { requireSingleRelease: false })).toEqual({ status: 'absent', reason: 'no-ledger' });
    });

    it('refuses an invalid ledger with invalid-ledger', () => {
      expect(composeCutoverShadowEvidence({ revision: 0, days: [] }, NOW, { requireSingleRelease: false })).toEqual({ status: 'absent', reason: 'invalid-ledger' });
    });

    it('refuses a number clock with invalid-clock', () => {
      const ledger = threeDays([7, 7, 6]);
      expect(composeCutoverShadowEvidence(ledger, 42, { requireSingleRelease: false })).toEqual({ status: 'absent', reason: 'invalid-clock' });
    });

    it('refuses a naive (non-zoned) clock with invalid-clock', () => {
      const ledger = threeDays([7, 7, 6]);
      expect(composeCutoverShadowEvidence(ledger, `${D3}T23:59:59`, { requireSingleRelease: false })).toEqual({ status: 'absent', reason: 'invalid-clock' });
    });

    it('refuses missing options with invalid-options', () => {
      const ledger = threeDays([7, 7, 6]);
      expect(composeCutoverShadowEvidence(ledger, NOW, null)).toEqual({ status: 'absent', reason: 'invalid-options' });
    });

    it('refuses options with an extra key with invalid-options', () => {
      const ledger = threeDays([7, 7, 6]);
      expect(composeCutoverShadowEvidence(ledger, NOW, { requireSingleRelease: false, extra: true })).toEqual({ status: 'absent', reason: 'invalid-options' });
    });

    it('refuses options whose requireSingleRelease is not a boolean with invalid-options', () => {
      const ledger = threeDays([7, 7, 6]);
      expect(composeCutoverShadowEvidence(ledger, NOW, { requireSingleRelease: 'no' })).toEqual({ status: 'absent', reason: 'invalid-options' });
    });

    it('refuses a Proxy over the options whose ownKeys trap throws with invalid-options', () => {
      const ledger = threeDays([7, 7, 6]);
      const proxy = new Proxy({ requireSingleRelease: false }, {
        ownKeys() {
          throw new Error('trap');
        },
      });
      expect(composeCutoverShadowEvidence(ledger, NOW, proxy)).toEqual({ status: 'absent', reason: 'invalid-options' });
    });

    it('refuses fewer than three stored days with too-few-days', () => {
      const ledger = buildLedger([dayInput(D1, 7), dayInput(D2, 7)]);
      expect(composeCutoverShadowEvidence(ledger, NOW, { requireSingleRelease: false })).toEqual({ status: 'absent', reason: 'too-few-days' });
    });

    it('refuses a ledger not updated within the last day with stale', () => {
      const ledger = threeDays([7, 7, 6]);
      const late = new Date(Date.parse(NOW) + 3 * DAY_MS).toISOString();
      expect(composeCutoverShadowEvidence(ledger, late, { requireSingleRelease: false })).toEqual({ status: 'absent', reason: 'stale' });
    });

    it('accepts a clock exactly one UTC day after the newest day (not stale)', () => {
      const ledger = threeDays([7, 7, 6]);
      const nextDay = new Date(Date.parse(NOW) + DAY_MS).toISOString();
      expect(composeCutoverShadowEvidence(ledger, nextDay, { requireSingleRelease: false }).status).toBe('ok');
    });

    it('refuses differing release shas under requireSingleRelease with release-changed', () => {
      const changed = buildLedger([dayInput(D1, 7), dayInput(D2, 7), dayInput(D3, 6, allPassVerdicts(), OTHER_RELEASE_SHA)]);
      expect(composeCutoverShadowEvidence(changed, NOW, { requireSingleRelease: true })).toEqual({ status: 'absent', reason: 'release-changed' });
    });

    it('refuses a null release sha under requireSingleRelease with release-changed', () => {
      const nulled = buildLedger([dayInput(D1, 7, allPassVerdicts(), null), dayInput(D2, 7), dayInput(D3, 6)]);
      expect(composeCutoverShadowEvidence(nulled, NOW, { requireSingleRelease: true })).toEqual({ status: 'absent', reason: 'release-changed' });
    });

    it('accepts equal release shas under requireSingleRelease', () => {
      const ledger = threeDays([7, 7, 6]);
      expect(composeCutoverShadowEvidence(ledger, NOW, { requireSingleRelease: true }).status).toBe('ok');
    });
  });

  describe('end-to-end with readCutoverShadowEvidence', () => {
    function feed(ledger: ShadowLedger, now = NOW): ReturnType<typeof readCutoverShadowEvidence> {
      const composed = composeCutoverShadowEvidence(ledger, now, { requireSingleRelease: false });
      if (composed.status !== 'ok') {
        throw new Error(`expected a composed evidence, got ${composed.reason}`);
      }
      return readCutoverShadowEvidence(composed.evidence, now);
    }

    it('(a) three consecutive all-pass days with merges 7, 7, 6 are accepted', () => {
      const ledger = buildLedger([dayInput(D1, 7), dayInput(D2, 7), dayInput(D3, 6)]);
      expect(feed(ledger)).toEqual({ ok: true });
    });

    it('(b) merges summing to 19 instead of 20 report every criterion failed', () => {
      const ledger = buildLedger([dayInput(D1, 6), dayInput(D2, 6), dayInput(D3, 7)]);
      const result = feed(ledger);
      expect(result).toEqual({ ok: false, reason: 'invalid-evidence', failed: [...CUTOVER_SHADOW_CRITERIA] });
    });

    it('(c) a never-recorded S7 on one day is the only failed criterion', () => {
      const ledger = buildLedger([dayInput(D1, 7), dayInput(D2, 7, verdictsMissing('S7')), dayInput(D3, 6)]);
      const result = feed(ledger);
      expect(result).toEqual({ ok: false, reason: 'invalid-evidence', failed: ['S7'] });
    });

    it('(d) a calendar gap between the three days reports every criterion failed', () => {
      const ledger = buildLedger([dayInput(D1, 7), dayInput(D2, 7), dayInput('2026-02-04', 6)]);
      const result = feed(ledger, '2026-02-04T12:00:00Z');
      expect(result).toEqual({ ok: false, reason: 'invalid-evidence', failed: [...CUTOVER_SHADOW_CRITERIA] });
    });

    it('(e) a failing S4 on the middle day is the only failed criterion', () => {
      const verdicts = allPassVerdicts();
      verdicts.S4 = passVerdict({ verdict: 'fail', reason: 'drift' });
      const ledger = buildLedger([dayInput(D1, 7), dayInput(D2, 7, verdicts), dayInput(D3, 6)]);
      const result = feed(ledger);
      expect(result).toEqual({ ok: false, reason: 'invalid-evidence', failed: ['S4'] });
    });
  });
});
