// Lane SH15a: tests for the pure shadow attestation ledger. Each refusal code
// has a titled test, and the hostile-input cases name the input they refuse.
// Lane SH15b: tests for the one-time S2, S3, S10 and S11 evaluator.
import { describe, expect, it } from 'vitest';

import { MAX_REVISION } from '../shadow-evidence-ledger.js';
import {
  SHADOW_ATTESTATION_FACTS,
  SHADOW_ATTESTATION_SCHEMA_VERSION,
  SHADOW_ONE_TIME_CRITERIA,
  SHADOW_ONE_TIME_MAX_PATH_LENGTH,
  SHADOW_ONE_TIME_MAX_TESTS,
  SHADOW_ONE_TIME_REQUIREMENTS,
  evaluateShadowOneTimeCriteria,
  parseShadowAttestationCommandInput,
  readShadowAttestations,
  recordShadowAttestation,
  type ShadowAttestationCommandInputParse,
  type ShadowAttestationLedger,
  type ShadowAttestationRead,
  type ShadowAttestationWrite,
} from '../shadow-attestations.js';

const DIGEST = 'a'.repeat(64);
const OTHER_DIGEST = 'b'.repeat(64);
const RECORDED_AT = '2026-02-03T00:00:00Z';
const LATER = '2026-02-04T12:00:00Z';
const RELEASE_SHA = 'c'.repeat(40);
const OTHER_RELEASE_SHA = 'd'.repeat(40);
const D1 = '2026-02-01';
const D2 = '2026-02-02';
const FORGE = 's2-forge-error-backoff';
const CANARY = 's2-canary-parks';
const WAKE = 's3-wake-after-outage';

/** A secret-shaped string built at runtime so the source contains no secret literal. */
const SECRET_TEXT = `sk-${'a'.repeat(24)}`;

function rawAttestation(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    fact: FORGE,
    observedDay: D1,
    releaseSha: RELEASE_SHA,
    reason: 'ok',
    digest: DIGEST,
    recordedAtIso: RECORDED_AT,
    ...overrides,
  };
}

function ledgerWith(attestations: unknown, revision: unknown = 1): Record<string, unknown> {
  return { schemaVersion: SHADOW_ATTESTATION_SCHEMA_VERSION, revision, attestations };
}

function requireLedger(result: ShadowAttestationWrite): ShadowAttestationLedger {
  if (!result.ok) {
    throw new Error('expected a recorded ledger');
  }
  return result.ledger;
}

function expectReadFailure(raw: unknown, reason: 'unknown-version' | 'invalid-ledger'): void {
  expect(readShadowAttestations(raw)).toEqual({ ok: false, reason });
}

function expectWriteFailure(ledger: unknown, input: unknown, reason: 'invalid-ledger' | 'invalid-input'): void {
  expect(recordShadowAttestation(ledger, input)).toEqual({ ok: false, reason });
}

function expectNoSecretEcho(result: ShadowAttestationRead | ShadowAttestationWrite): void {
  expect(JSON.stringify(result).includes('sk-')).toBe(false);
}

/** Plant an enumerable getter. The returned function reports how many times it ran. */
function plantGetter(target: object, key: string, value: unknown): () => number {
  let calls = 0;
  Object.defineProperty(target, key, {
    enumerable: true,
    configurable: true,
    get() {
      calls += 1;
      return value;
    },
  });
  return () => calls;
}

/**
 * A dense array one longer than `SHADOW_ATTESTATION_FACTS`. Index 1 is an
 * enumerable getter. Index 0 counts `getPrototypeOf`: element reads use
 * property descriptors, so that getter stays 0 even when the array is walked,
 * and this counter stays 0 only when the length cap returns first.
 */
function overCapAttestations(): {
  readonly attestations: unknown[];
  readonly getterCalls: () => number;
  readonly elementReads: () => number;
} {
  let elementReads = 0;
  const attestations: unknown[] = [
    new Proxy(rawAttestation(), {
      getPrototypeOf(target) {
        elementReads += 1;
        return Reflect.getPrototypeOf(target);
      },
    }),
  ];
  const limit = SHADOW_ATTESTATION_FACTS.length + 1;
  for (let index = attestations.length; index < limit; index += 1) {
    attestations.push(rawAttestation());
  }
  const getterCalls = plantGetter(attestations, '1', rawAttestation());
  return { attestations, getterCalls, elementReads: () => elementReads };
}

function pollutedAttestation(key: string): unknown {
  return JSON.parse(
    `{"fact":"${FORGE}","observedDay":"${D1}","releaseSha":null,"reason":"ok","digest":"${DIGEST}","recordedAtIso":"${RECORDED_AT}","${key}":{"polluted":true}}`,
  );
}

describe('shadow attestation ledger (SH15a)', () => {
  describe('readShadowAttestations', () => {
    it('round-trips recordShadowAttestation from null through readShadowAttestations', () => {
      const recorded = requireLedger(recordShadowAttestation(null, rawAttestation()));
      expect(recorded.revision).toBe(1);
      expect(recorded.schemaVersion).toBe(SHADOW_ATTESTATION_SCHEMA_VERSION);
      expect(readShadowAttestations(recorded)).toEqual({ ok: true, ledger: recorded });
    });

    it('reads an absent schemaVersion as the current version', () => {
      const item = rawAttestation();
      expect(readShadowAttestations({ revision: 1, attestations: [item] })).toEqual({
        ok: true,
        ledger: { schemaVersion: SHADOW_ATTESTATION_SCHEMA_VERSION, revision: 1, attestations: [item] },
      });
    });

    it('accepts an empty attestation list', () => {
      expect(readShadowAttestations(ledgerWith([]))).toEqual({
        ok: true,
        ledger: { schemaVersion: SHADOW_ATTESTATION_SCHEMA_VERSION, revision: 1, attestations: [] },
      });
    });

    it('accepts a null release sha', () => {
      const read = readShadowAttestations(ledgerWith([rawAttestation({ releaseSha: null })]));
      expect(read.ok).toBe(true);
      if (!read.ok) {
        throw new Error('expected ok');
      }
      expect(read.ledger.attestations[0].releaseSha).toBeNull();
    });

    it('accepts a revision equal to MAX_REVISION', () => {
      const read = readShadowAttestations(ledgerWith([], MAX_REVISION));
      expect(read.ok).toBe(true);
      if (!read.ok) {
        throw new Error('expected ok');
      }
      expect(read.ledger.revision).toBe(MAX_REVISION);
    });

    it('is not an identity echo: readShadowAttestations returns a fresh ledger', () => {
      const recorded = requireLedger(recordShadowAttestation(null, rawAttestation()));
      const read = readShadowAttestations(recorded);
      if (!read.ok) {
        throw new Error('expected ok');
      }
      expect(read.ledger).toEqual(recorded);
      expect(read.ledger).not.toBe(recorded);
      expect(read.ledger.attestations).not.toBe(recorded.attestations);
      expect(read.ledger.attestations[0]).not.toBe(recorded.attestations[0]);
    });

    it('is not satisfiable by a constant: different ledgers read differently', () => {
      const forge = requireLedger(recordShadowAttestation(null, rawAttestation({ fact: FORGE })));
      const wake = requireLedger(recordShadowAttestation(null, rawAttestation({ fact: WAKE })));
      const readForge = readShadowAttestations(forge);
      const readWake = readShadowAttestations(wake);
      expect(readForge).toEqual({ ok: true, ledger: forge });
      expect(readWake).toEqual({ ok: true, ledger: wake });
      expect(readForge).not.toEqual(readWake);
    });

    it('refuses a schema version above the current one with unknown-version', () => {
      expectReadFailure({ schemaVersion: 2, revision: 'nope', attestations: 'nope' }, 'unknown-version');
    });

    it('refuses a schema version of 0 with invalid-ledger', () => {
      expectReadFailure({ schemaVersion: 0, revision: 1, attestations: [] }, 'invalid-ledger');
    });

    it('refuses a fractional schema version with invalid-ledger', () => {
      expectReadFailure({ schemaVersion: 1.5, revision: 1, attestations: [] }, 'invalid-ledger');
    });

    it('refuses a string schema version with invalid-ledger', () => {
      expectReadFailure({ schemaVersion: '2', revision: 1, attestations: [] }, 'invalid-ledger');
    });

    it('refuses a negative schema version with invalid-ledger', () => {
      expectReadFailure({ schemaVersion: -1, revision: 1, attestations: [] }, 'invalid-ledger');
    });

    it('refuses null with invalid-ledger', () => {
      expectReadFailure(null, 'invalid-ledger');
    });

    it('refuses undefined with invalid-ledger', () => {
      expectReadFailure(undefined, 'invalid-ledger');
    });

    it('refuses a number where the ledger record is due with invalid-ledger', () => {
      expectReadFailure(7, 'invalid-ledger');
    });

    it('refuses a number where a string is due (reason) with invalid-ledger', () => {
      expectReadFailure(ledgerWith([rawAttestation({ reason: 1 })]), 'invalid-ledger');
    });

    it('refuses a string where the attestations list is due with invalid-ledger', () => {
      expectReadFailure(ledgerWith(FORGE), 'invalid-ledger');
    });

    it('refuses a string where the revision number is due with invalid-ledger', () => {
      expectReadFailure(ledgerWith([], '1'), 'invalid-ledger');
    });

    it('refuses a non-iterable object where the attestations list is due with invalid-ledger', () => {
      let calls = 0;
      const list: Record<string, unknown> = {};
      Object.defineProperty(list, 'fact', {
        enumerable: true,
        get() {
          calls += 1;
          return FORGE;
        },
      });
      expectReadFailure(ledgerWith(list), 'invalid-ledger');
      expect(calls).toBe(0);
    });

    it('refuses an attestations array with a hole with invalid-ledger', () => {
      const item = rawAttestation();
      const calls = plantGetter(item, 'reason', 'ok');
      const attestations: unknown[] = [item];
      attestations.length = 2;
      expectReadFailure(ledgerWith(attestations), 'invalid-ledger');
      expect(calls()).toBe(0);
    });

    it('refuses an array-like object where the attestations list is due with invalid-ledger', () => {
      const arrayLike: Record<string, unknown> = { length: 1 };
      const calls = plantGetter(arrayLike, '0', rawAttestation());
      expectReadFailure(ledgerWith(arrayLike), 'invalid-ledger');
      expect(calls()).toBe(0);
    });

    it('refuses an enormous sparse length (2**32 - 1) before any traversal with invalid-ledger', () => {
      const sparse: unknown[] = [];
      Object.defineProperty(sparse, 'length', { value: 2 ** 32 - 1 });
      const calls = plantGetter(sparse, '0', rawAttestation());
      expectReadFailure(ledgerWith(sparse), 'invalid-ledger');
      expect(calls()).toBe(0);
    });

    it('never runs a getter on the root and refuses it with invalid-ledger', () => {
      const raw = ledgerWith([rawAttestation()]);
      const calls = plantGetter(raw, 'revision', 1);
      expectReadFailure(raw, 'invalid-ledger');
      expect(calls()).toBe(0);
    });

    it('never runs a getter on an attestation item and refuses it with invalid-ledger', () => {
      const item = rawAttestation();
      const calls = plantGetter(item, 'reason', 'ok');
      expectReadFailure(ledgerWith([item]), 'invalid-ledger');
      expect(calls()).toBe(0);
    });

    it('never runs a getter planted as an extra enumerable property on the attestations array', () => {
      const attestations = [rawAttestation()];
      const calls = plantGetter(attestations, 'extra', 1);
      expectReadFailure(ledgerWith(attestations), 'invalid-ledger');
      expect(calls()).toBe(0);
    });

    it('refuses a symbol own key on the attestations array with invalid-ledger', () => {
      const attestations: unknown[] = [rawAttestation()];
      Object.defineProperty(attestations, Symbol('tag'), { value: 1, enumerable: false, configurable: true });
      expectReadFailure(ledgerWith(attestations), 'invalid-ledger');
    });

    it('refuses a non-enumerable extra own key on the attestations array with invalid-ledger', () => {
      const attestations: unknown[] = [rawAttestation()];
      Object.defineProperty(attestations, 'hidden', { value: 1, enumerable: false, configurable: true, writable: true });
      expectReadFailure(ledgerWith(attestations), 'invalid-ledger');
    });

    it('refuses the whole attestations list when an accessor element is present (invalid-ledger)', () => {
      const attestations: unknown[] = [rawAttestation()];
      const calls = plantGetter(attestations, '0', rawAttestation());
      expectReadFailure(ledgerWith(attestations), 'invalid-ledger');
      expect(calls()).toBe(0);
    });

    it('a Proxy over a valid ledger yields exactly the plain data and runs no get trap', () => {
      const recorded = requireLedger(recordShadowAttestation(null, rawAttestation()));
      const plain = readShadowAttestations(recorded);
      expect(readShadowAttestations(new Proxy(recorded, {}))).toEqual(plain);
      let gets = 0;
      const counted = new Proxy(recorded, {
        get(target, property, receiver) {
          gets += 1;
          return Reflect.get(target, property, receiver);
        },
      });
      expect(readShadowAttestations(counted)).toEqual(plain);
      expect(gets).toBe(0);
    });

    it('refuses an Array subclass attestations list holding valid entries with invalid-ledger', () => {
      class Sub extends Array<Record<string, unknown>> {}
      const attestations = Sub.from([rawAttestation()]);
      expect(attestations).toBeInstanceOf(Sub);
      expect(attestations).toHaveLength(1);
      expectReadFailure(ledgerWith(attestations), 'invalid-ledger');
    });

    it('refuses a null-prototype attestations array holding valid entries with invalid-ledger', () => {
      const attestations = Object.setPrototypeOf([rawAttestation()], null);
      expect(Object.getPrototypeOf(attestations)).toBeNull();
      expect(attestations).toHaveLength(1);
      expectReadFailure(ledgerWith(attestations), 'invalid-ledger');
    });

    it('a Proxy over a valid attestations array yields exactly the plain data and runs no get trap', () => {
      const valid = [rawAttestation()];
      const plain = readShadowAttestations(ledgerWith(valid));
      expect(readShadowAttestations(ledgerWith(new Proxy([...valid], {})))).toEqual(plain);
      let gets = 0;
      const counted = new Proxy([...valid], {
        get(target, property, receiver) {
          gets += 1;
          return Reflect.get(target, property, receiver);
        },
      });
      expect(readShadowAttestations(ledgerWith(counted))).toEqual(plain);
      expect(gets).toBe(0);
    });

    it('refuses a Proxy whose ownKeys trap throws with invalid-ledger', () => {
      const proxy = new Proxy(ledgerWith([]), {
        ownKeys() {
          throw new Error('trap');
        },
      });
      expectReadFailure(proxy, 'invalid-ledger');
    });

    it('refuses a prototype-polluting __proto__ key produced by JSON.parse with invalid-ledger', () => {
      expectReadFailure(ledgerWith([pollutedAttestation('__proto__')]), 'invalid-ledger');
      expect(Object.getOwnPropertyDescriptor(Object.prototype, 'polluted')).toBeUndefined();
    });

    it('refuses a prototype-polluting constructor key produced by JSON.parse with invalid-ledger', () => {
      expectReadFailure(ledgerWith([pollutedAttestation('constructor')]), 'invalid-ledger');
    });

    it('refuses a prototype-polluting prototype key produced by JSON.parse with invalid-ledger', () => {
      expectReadFailure(ledgerWith([pollutedAttestation('prototype')]), 'invalid-ledger');
    });

    it('refuses a secret-shaped reason with invalid-ledger', () => {
      const result = readShadowAttestations(ledgerWith([rawAttestation({ reason: SECRET_TEXT })]));
      expect(result).toEqual({ ok: false, reason: 'invalid-ledger' });
      expectNoSecretEcho(result);
    });

    it('refuses a secret-shaped observedDay with invalid-ledger', () => {
      const result = readShadowAttestations(ledgerWith([rawAttestation({ observedDay: SECRET_TEXT })]));
      expect(result).toEqual({ ok: false, reason: 'invalid-ledger' });
      expectNoSecretEcho(result);
    });

    it('refuses two attestations of the same fact with invalid-ledger', () => {
      expectReadFailure(
        ledgerWith([
          rawAttestation({ observedDay: D1 }),
          rawAttestation({ observedDay: D2, digest: OTHER_DIGEST }),
        ]),
        'invalid-ledger',
      );
    });

    it('refuses attestations that are not ordered as SHADOW_ATTESTATION_FACTS with invalid-ledger', () => {
      expectReadFailure(
        ledgerWith([
          rawAttestation({ fact: WAKE, observedDay: D1 }),
          rawAttestation({ fact: FORGE, observedDay: D2 }),
        ]),
        'invalid-ledger',
      );
    });

    it('refuses an unknown fact with invalid-ledger', () => {
      expectReadFailure(ledgerWith([rawAttestation({ fact: 's4-not-a-fact' })]), 'invalid-ledger');
    });

    it('refuses a calendar-invalid observedDay with invalid-ledger', () => {
      expectReadFailure(ledgerWith([rawAttestation({ observedDay: '2026-02-29' })]), 'invalid-ledger');
    });

    it('refuses an uppercase reason with invalid-ledger', () => {
      expectReadFailure(ledgerWith([rawAttestation({ reason: 'OK' })]), 'invalid-ledger');
    });

    it('refuses a digest that is not 64 lowercase hex characters with invalid-ledger', () => {
      expectReadFailure(ledgerWith([rawAttestation({ digest: 'A'.repeat(64) })]), 'invalid-ledger');
    });

    it('refuses a release sha of the wrong shape with invalid-ledger', () => {
      expectReadFailure(ledgerWith([rawAttestation({ releaseSha: 'g'.repeat(40) })]), 'invalid-ledger');
    });

    it('refuses a naive recordedAtIso with invalid-ledger', () => {
      expectReadFailure(ledgerWith([rawAttestation({ recordedAtIso: '2026-02-03T00:00:00' })]), 'invalid-ledger');
    });

    it('refuses a calendar-invalid recordedAtIso with invalid-ledger', () => {
      expectReadFailure(ledgerWith([rawAttestation({ recordedAtIso: '2026-02-30T00:00:00Z' })]), 'invalid-ledger');
    });

    it('refuses an attestation with an extra key with invalid-ledger', () => {
      expectReadFailure(ledgerWith([{ ...rawAttestation(), extra: true }]), 'invalid-ledger');
    });

    it('reads an attestation that carries a well-formed operationDigest', () => {
      const read = readShadowAttestations(ledgerWith([rawAttestation({ operationDigest: OTHER_DIGEST })]));
      expect(read.ok).toBe(true);
      if (!read.ok) {
        throw new Error('expected ok');
      }
      expect(read.ledger.attestations[0]?.operationDigest).toBe(OTHER_DIGEST);
    });

    it('refuses a malformed operationDigest with invalid-ledger', () => {
      expectReadFailure(ledgerWith([rawAttestation({ operationDigest: 'nothex' })]), 'invalid-ledger');
    });

    it('refuses an attestation missing a key with invalid-ledger', () => {
      const item = rawAttestation();
      delete item.digest;
      expectReadFailure(ledgerWith([item]), 'invalid-ledger');
    });

    it('refuses an extra root key with invalid-ledger', () => {
      expectReadFailure({ ...ledgerWith([]), extra: true }, 'invalid-ledger');
    });

    it('refuses a record missing the attestations key with invalid-ledger', () => {
      expectReadFailure({ schemaVersion: SHADOW_ATTESTATION_SCHEMA_VERSION, revision: 1 }, 'invalid-ledger');
    });

    it('refuses revision 0 with invalid-ledger', () => {
      expectReadFailure(ledgerWith([], 0), 'invalid-ledger');
    });

    it('refuses a revision above MAX_REVISION with invalid-ledger', () => {
      expectReadFailure(ledgerWith([], MAX_REVISION + 1), 'invalid-ledger');
    });

    it('refuses more attestations than SHADOW_ATTESTATION_FACTS.length with invalid-ledger', () => {
      const first = rawAttestation();
      const calls = plantGetter(first, 'reason', 'ok');
      expectReadFailure(
        ledgerWith([first, rawAttestation(), rawAttestation(), rawAttestation()]),
        'invalid-ledger',
      );
      expect(calls()).toBe(0);
    });

    it('refuses an attestations array over the cap before any element is read with invalid-ledger', () => {
      const over = overCapAttestations();
      expect(over.attestations.length).toBe(SHADOW_ATTESTATION_FACTS.length + 1);
      expect(Object.keys(over.attestations)).toHaveLength(over.attestations.length);
      expectReadFailure(ledgerWith(over.attestations), 'invalid-ledger');
      expect(over.getterCalls()).toBe(0);
      expect(over.elementReads()).toBe(0);
    });
  });

  describe('recordShadowAttestation', () => {
    it('keeps the first observation when the same fact is recorded again with a different day', () => {
      const first = requireLedger(recordShadowAttestation(null, rawAttestation()));
      const before = JSON.stringify(first);
      const again = recordShadowAttestation(
        first,
        rawAttestation({
          observedDay: D2,
          releaseSha: OTHER_RELEASE_SHA,
          reason: 'later',
          digest: OTHER_DIGEST,
          recordedAtIso: LATER,
        }),
      );
      expect(again).toEqual({ ok: true, ledger: first, changed: false });
      expect(JSON.stringify(first)).toBe(before);
      if (!again.ok) {
        throw new Error('expected ok');
      }
      expect(again.ledger).not.toBe(first);
      expect(again.ledger.attestations[0]).not.toBe(first.attestations[0]);
      expect(again.ledger.revision).toBe(first.revision);
      expect(again.ledger.attestations[0].observedDay).toBe(D1);
      expect(again.ledger.attestations[0].digest).toBe(DIGEST);
      expect(again.ledger.attestations[0].releaseSha).toBe(RELEASE_SHA);
      expect(again.ledger.attestations[0].reason).toBe('ok');
      expect(again.ledger.attestations[0].recordedAtIso).toBe(RECORDED_AT);
    });

    it('orders facts by SHADOW_ATTESTATION_FACTS when a later fact is recorded first', () => {
      const wake = requireLedger(recordShadowAttestation(null, rawAttestation({ fact: WAKE, observedDay: D1 })));
      const both = recordShadowAttestation(wake, rawAttestation({ fact: FORGE, observedDay: D2 }));
      if (!both.ok) {
        throw new Error('expected ok');
      }
      expect(both.changed).toBe(true);
      expect(both.ledger.revision).toBe(2);
      expect(both.ledger.attestations.map((item) => item.fact)).toEqual([FORGE, WAKE]);
      expect(both.ledger.attestations[1]).not.toBe(wake.attestations[0]);
      expect(wake.attestations).toHaveLength(1);
      const all = recordShadowAttestation(
        both.ledger,
        rawAttestation({ fact: CANARY, observedDay: D2, digest: OTHER_DIGEST }),
      );
      if (!all.ok) {
        throw new Error('expected ok');
      }
      expect(all.changed).toBe(true);
      expect(all.ledger.revision).toBe(3);
      expect(all.ledger.attestations.map((item) => item.fact)).toEqual([...SHADOW_ATTESTATION_FACTS]);
      expect(all.ledger.attestations[0].observedDay).toBe(D2);
      expect(all.ledger.attestations[2].observedDay).toBe(D1);
      expect(readShadowAttestations(all.ledger)).toEqual({ ok: true, ledger: all.ledger });
    });

    it('is not satisfiable by a constant: recording different facts yields different ledgers', () => {
      const forge = recordShadowAttestation(null, rawAttestation({ fact: FORGE }));
      const wake = recordShadowAttestation(null, rawAttestation({ fact: WAKE }));
      expect(forge.ok).toBe(true);
      expect(wake.ok).toBe(true);
      if (!forge.ok || !wake.ok) {
        throw new Error('expected ok');
      }
      expect(forge.changed).toBe(true);
      expect(wake.changed).toBe(true);
      expect(forge.ledger).not.toEqual(wake.ledger);
    });

    it('is not an identity echo: recordShadowAttestation returns a fresh ledger', () => {
      const input = rawAttestation();
      const recorded = recordShadowAttestation(null, input);
      if (!recorded.ok) {
        throw new Error('expected ok');
      }
      expect(recorded.ledger).not.toBe(input);
      expect(recorded.ledger.attestations[0]).not.toBe(input);
      const nextInput = rawAttestation({ fact: WAKE, observedDay: D2 });
      const next = recordShadowAttestation(recorded.ledger, nextInput);
      if (!next.ok) {
        throw new Error('expected ok');
      }
      expect(next.ledger).not.toBe(recorded.ledger);
      expect(next.ledger).not.toBe(nextInput);
      expect(next.ledger.attestations[0]).not.toBe(recorded.ledger.attestations[0]);
    });

    it('does not mutate either argument when inserting or when the fact is already recorded', () => {
      const stored = requireLedger(recordShadowAttestation(null, rawAttestation()));
      const before = JSON.stringify(stored);
      const inserted = rawAttestation({ fact: WAKE, observedDay: D2 });
      const insertedBefore = JSON.stringify(inserted);
      expect(recordShadowAttestation(stored, inserted).ok).toBe(true);
      expect(JSON.stringify(stored)).toBe(before);
      expect(JSON.stringify(inserted)).toBe(insertedBefore);
      const repeat = rawAttestation({ observedDay: D2, digest: OTHER_DIGEST });
      const repeatBefore = JSON.stringify(repeat);
      expect(recordShadowAttestation(stored, repeat)).toEqual({ ok: true, ledger: stored, changed: false });
      expect(JSON.stringify(stored)).toBe(before);
      expect(JSON.stringify(repeat)).toBe(repeatBefore);
    });

    it('refuses a non-null invalid ledger with invalid-ledger', () => {
      expectWriteFailure({ nope: true }, rawAttestation(), 'invalid-ledger');
    });

    it('refuses an invalid ledger before it reports an invalid input', () => {
      expectWriteFailure({ nope: true }, null, 'invalid-ledger');
    });

    it('refuses a ledger whose schema version is above the current one with invalid-ledger', () => {
      const stored = requireLedger(recordShadowAttestation(null, rawAttestation()));
      const newer = { ...stored, schemaVersion: 2 };
      expectWriteFailure(newer, rawAttestation({ fact: WAKE, observedDay: D2 }), 'invalid-ledger');
    });

    it('refuses an explicit revision of 0 with invalid-ledger', () => {
      expectWriteFailure({ schemaVersion: 1, revision: 0, attestations: [] }, rawAttestation(), 'invalid-ledger');
    });

    it('refuses a malformed attestation with invalid-input', () => {
      const stored = requireLedger(recordShadowAttestation(null, rawAttestation()));
      const before = JSON.stringify(stored);
      expectWriteFailure(stored, { fact: FORGE }, 'invalid-input');
      expect(JSON.stringify(stored)).toBe(before);
    });

    it('refuses null input with invalid-input', () => {
      expectWriteFailure(null, null, 'invalid-input');
    });

    it('refuses undefined input with invalid-input', () => {
      expectWriteFailure(null, undefined, 'invalid-input');
    });

    it('refuses an undefined ledger with invalid-ledger', () => {
      expectWriteFailure(undefined, rawAttestation(), 'invalid-ledger');
    });

    it('refuses a number where the input record is due with invalid-input', () => {
      expectWriteFailure(null, 5, 'invalid-input');
    });

    it('refuses a number where a string is due (reason) with invalid-input', () => {
      expectWriteFailure(null, rawAttestation({ reason: 1 }), 'invalid-input');
    });

    it('refuses a string where the attestations list is due with invalid-ledger', () => {
      expectWriteFailure(ledgerWith(FORGE), rawAttestation({ fact: WAKE, observedDay: D2 }), 'invalid-ledger');
    });

    it('refuses a non-iterable object where the attestations list is due with invalid-ledger', () => {
      let calls = 0;
      const list: Record<string, unknown> = {};
      Object.defineProperty(list, 'fact', {
        enumerable: true,
        get() {
          calls += 1;
          return FORGE;
        },
      });
      expectWriteFailure(ledgerWith(list), rawAttestation(), 'invalid-ledger');
      expect(calls).toBe(0);
    });

    it('refuses an attestations array with a hole with invalid-ledger', () => {
      const item = rawAttestation();
      const calls = plantGetter(item, 'reason', 'ok');
      const attestations: unknown[] = [item];
      attestations.length = 2;
      expectWriteFailure(ledgerWith(attestations), rawAttestation({ fact: WAKE }), 'invalid-ledger');
      expect(calls()).toBe(0);
    });

    it('refuses an array-like object where the attestations list is due with invalid-ledger', () => {
      const arrayLike: Record<string, unknown> = { length: 1 };
      const calls = plantGetter(arrayLike, '0', rawAttestation());
      expectWriteFailure(ledgerWith(arrayLike), rawAttestation(), 'invalid-ledger');
      expect(calls()).toBe(0);
    });

    it('refuses an enormous sparse length (2**32 - 1) before any traversal with invalid-ledger', () => {
      const sparse: unknown[] = [];
      Object.defineProperty(sparse, 'length', { value: 2 ** 32 - 1 });
      const calls = plantGetter(sparse, '0', rawAttestation());
      expectWriteFailure(ledgerWith(sparse), rawAttestation(), 'invalid-ledger');
      expect(calls()).toBe(0);
    });

    it('refuses a stored ledger whose attestations array is over the cap before any element is read with invalid-ledger', () => {
      const over = overCapAttestations();
      expect(over.attestations.length).toBe(SHADOW_ATTESTATION_FACTS.length + 1);
      expect(Object.keys(over.attestations)).toHaveLength(over.attestations.length);
      expectWriteFailure(
        ledgerWith(over.attestations),
        rawAttestation({ fact: WAKE, observedDay: D2 }),
        'invalid-ledger',
      );
      expect(over.getterCalls()).toBe(0);
      expect(over.elementReads()).toBe(0);
    });

    it('never runs a getter on the ledger root and refuses it with invalid-ledger', () => {
      const raw = ledgerWith([rawAttestation()]);
      const calls = plantGetter(raw, 'revision', 1);
      expectWriteFailure(raw, rawAttestation({ fact: WAKE, observedDay: D2 }), 'invalid-ledger');
      expect(calls()).toBe(0);
    });

    it('never runs a getter on the attestation input and refuses it with invalid-input', () => {
      const input = rawAttestation();
      const calls = plantGetter(input, 'reason', 'ok');
      expectWriteFailure(null, input, 'invalid-input');
      expect(calls()).toBe(0);
    });

    it('a Proxy over a valid attestation yields exactly the plain data and runs no get trap', () => {
      const input = rawAttestation();
      const plain = recordShadowAttestation(null, input);
      expect(recordShadowAttestation(null, new Proxy(input, {}))).toEqual(plain);
      let gets = 0;
      const counted = new Proxy(input, {
        get(target, property, receiver) {
          gets += 1;
          return Reflect.get(target, property, receiver);
        },
      });
      expect(recordShadowAttestation(null, counted)).toEqual(plain);
      expect(gets).toBe(0);
    });

    it('a Proxy over a valid stored ledger yields exactly the plain record result and runs no get trap', () => {
      const stored = requireLedger(recordShadowAttestation(null, rawAttestation()));
      const input = rawAttestation({ fact: WAKE, observedDay: D2 });
      const plain = recordShadowAttestation(stored, input);
      expect(recordShadowAttestation(new Proxy(stored, {}), input)).toEqual(plain);
      let gets = 0;
      const counted = new Proxy(stored, {
        get(target, property, receiver) {
          gets += 1;
          return Reflect.get(target, property, receiver);
        },
      });
      expect(recordShadowAttestation(counted, input)).toEqual(plain);
      expect(gets).toBe(0);
    });

    it('refuses a Proxy whose ownKeys trap throws with invalid-input', () => {
      const proxy = new Proxy(rawAttestation(), {
        ownKeys() {
          throw new Error('trap');
        },
      });
      expectWriteFailure(null, proxy, 'invalid-input');
    });

    it('refuses a prototype-polluting __proto__ key produced by JSON.parse with invalid-input', () => {
      const result = recordShadowAttestation(null, pollutedAttestation('__proto__'));
      expect(result).toEqual({ ok: false, reason: 'invalid-input' });
      expect(Object.getOwnPropertyDescriptor(Object.prototype, 'polluted')).toBeUndefined();
    });

    it('refuses a prototype-polluting constructor key produced by JSON.parse with invalid-input', () => {
      expectWriteFailure(null, pollutedAttestation('constructor'), 'invalid-input');
    });

    it('refuses a prototype-polluting prototype key produced by JSON.parse with invalid-input', () => {
      expectWriteFailure(null, pollutedAttestation('prototype'), 'invalid-input');
    });

    it('refuses a secret-shaped reason with invalid-input', () => {
      const result = recordShadowAttestation(null, rawAttestation({ reason: SECRET_TEXT }));
      expect(result).toEqual({ ok: false, reason: 'invalid-input' });
      expectNoSecretEcho(result);
    });

    it('refuses a secret-shaped observedDay with invalid-input', () => {
      const result = recordShadowAttestation(null, rawAttestation({ observedDay: SECRET_TEXT }));
      expect(result).toEqual({ ok: false, reason: 'invalid-input' });
      expectNoSecretEcho(result);
    });

    it('refuses an unknown fact with invalid-input', () => {
      expectWriteFailure(null, rawAttestation({ fact: 's4-not-a-fact' }), 'invalid-input');
    });

    it('refuses an attestation with an extra key with invalid-input', () => {
      expectWriteFailure(null, { ...rawAttestation(), extra: true }, 'invalid-input');
    });

    it('records an attestation that carries an operationDigest', () => {
      const stored = requireLedger(recordShadowAttestation(null, rawAttestation({ operationDigest: OTHER_DIGEST })));
      expect(stored.attestations[0]?.operationDigest).toBe(OTHER_DIGEST);
    });

    it('refuses a malformed operationDigest with invalid-input', () => {
      expectWriteFailure(null, rawAttestation({ operationDigest: 'nothex' }), 'invalid-input');
    });

    it('refuses a new fact when the revision is already at MAX_REVISION with invalid-ledger', () => {
      const stored = requireLedger(recordShadowAttestation(null, rawAttestation()));
      const atCap = { ...stored, revision: MAX_REVISION };
      const before = JSON.stringify(atCap);
      expectWriteFailure(atCap, rawAttestation({ fact: WAKE, observedDay: D2 }), 'invalid-ledger');
      expect(JSON.stringify(atCap)).toBe(before);
    });

    it('keeps a sticky re-record at the revision cap without bumping', () => {
      const stored = requireLedger(recordShadowAttestation(null, rawAttestation()));
      const atCap = { ...stored, revision: MAX_REVISION };
      const again = recordShadowAttestation(atCap, rawAttestation({ observedDay: D2, digest: OTHER_DIGEST }));
      expect(again.ok).toBe(true);
      if (!again.ok) {
        throw new Error('expected ok');
      }
      expect(again.changed).toBe(false);
      expect(again.ledger.revision).toBe(MAX_REVISION);
      expect(again.ledger.attestations[0].observedDay).toBe(D1);
      expect(again.ledger).not.toBe(atCap);
      expect(atCap.revision).toBe(MAX_REVISION);
    });
  });
});

const S2_TEST = 'apps/cli/src/__tests__/e2e/shadow-park-reasons.e2e.test.ts';
const S10_TEST = 'apps/cli/src/__tests__/e2e/shadow-kill-recovery.e2e.test.ts';
const S11_TEST = 'packages/work-execution/src/domain/__tests__/shadow-brief-corpus.test.ts';
const DAY = D2;
const D3 = '2026-02-03';

const PRESENT = ['pass', 'one-time-evidence-present'] as const;
const ABSENT = ['fail', 'required-test-absent'] as const;
const QUARANTINED = ['fail', 'required-test-quarantined'] as const;
const TEST_UNREADABLE = ['unknown', 'release-test-unreadable'] as const;
const UNPINNED = ['unknown', 'release-unpinned'] as const;
const TREE_UNREADABLE = ['unknown', 'release-tree-unreadable'] as const;
const UNREPORTED = ['unknown', 'release-test-unreported'] as const;
const NOT_YET = ['unknown', 'not-yet-observed'] as const;
const LEDGER_UNREADABLE = ['unknown', 'attestations-unreadable'] as const;
const INVALID = ['unknown', 'invalid-input'] as const;

type CriterionCode = readonly ['pass' | 'fail' | 'unknown', string];

function releaseTest(path: string, present = true, quarantined: boolean | null = false): Record<string, unknown> {
  return { path, present, quarantined };
}

function presentTests(): Record<string, unknown>[] {
  return [releaseTest(S2_TEST), releaseTest(S10_TEST), releaseTest(S11_TEST)];
}

function ledgerOf(
  facts: readonly { readonly fact: string; readonly observedDay?: string; readonly releaseSha?: string | null }[],
): ShadowAttestationLedger {
  let current: ShadowAttestationLedger | null = null;
  for (const fact of facts) {
    current = requireLedger(
      recordShadowAttestation(
        current,
        rawAttestation({
          fact: fact.fact,
          observedDay: fact.observedDay ?? D1,
          releaseSha: fact.releaseSha === undefined ? RELEASE_SHA : fact.releaseSha,
        }),
      ),
    );
  }
  if (current === null) {
    throw new Error('expected attestations');
  }
  return current;
}

/** Forge and canary on D1, wake on the evaluation day itself, so both `<` and `=` count. */
function factsOnOrBeforeDay(): ShadowAttestationLedger {
  return ledgerOf([
    { fact: FORGE, observedDay: D1 },
    { fact: CANARY, observedDay: D1 },
    { fact: WAKE, observedDay: DAY },
  ]);
}

function passingInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    day: DAY,
    releaseSha: RELEASE_SHA,
    attestations: factsOnOrBeforeDay(),
    releaseTests: presentTests(),
    ...overrides,
  };
}

function paddedTests(count: number): Record<string, unknown>[] {
  const tests = presentTests();
  for (let index = tests.length; index < count; index += 1) {
    tests.push(releaseTest(`packages/work-execution/src/domain/__tests__/extra-${index}.test.ts`));
  }
  return tests;
}

function expectCodes(
  input: unknown,
  codes: { readonly S2: CriterionCode; readonly S3: CriterionCode; readonly S10: CriterionCode; readonly S11: CriterionCode },
): void {
  expect(evaluateShadowOneTimeCriteria(input)).toEqual({
    S2: { status: codes.S2[0], reason: codes.S2[1] },
    S3: { status: codes.S3[0], reason: codes.S3[1] },
    S10: { status: codes.S10[0], reason: codes.S10[1] },
    S11: { status: codes.S11[0], reason: codes.S11[1] },
  });
}

function expectInvalidInput(input: unknown): void {
  expectCodes(input, { S2: INVALID, S3: INVALID, S10: INVALID, S11: INVALID });
}

function expectUnreadableAttestations(input: unknown): void {
  expectCodes(input, {
    S2: LEDGER_UNREADABLE,
    S3: LEDGER_UNREADABLE,
    S10: LEDGER_UNREADABLE,
    S11: LEDGER_UNREADABLE,
  });
}

function pollutedEvaluation(key: string): unknown {
  const json = JSON.stringify(passingInput());
  return JSON.parse(`${json.slice(0, -1)},"${key}":{"polluted":true}}`);
}

describe('evaluateShadowOneTimeCriteria (SH15b)', () => {
  it('passes all four when every required test is present and not quarantined and every fact is attested on or before the day', () => {
    const result = evaluateShadowOneTimeCriteria(passingInput());
    expect(result).toEqual({
      S2: { status: 'pass', reason: 'one-time-evidence-present' },
      S3: { status: 'pass', reason: 'one-time-evidence-present' },
      S10: { status: 'pass', reason: 'one-time-evidence-present' },
      S11: { status: 'pass', reason: 'one-time-evidence-present' },
    });
    expect(Object.isFrozen(result.S2)).toBe(true);
  });

  it('fails S2 with required-test-absent when its test is absent', () => {
    expectCodes(passingInput({ releaseTests: [releaseTest(S2_TEST, false), releaseTest(S10_TEST), releaseTest(S11_TEST)] }), {
      S2: ABSENT,
      S3: PRESENT,
      S10: PRESENT,
      S11: PRESENT,
    });
  });

  it('fails S10 with required-test-quarantined when its test is quarantined', () => {
    expectCodes(
      passingInput({ releaseTests: [releaseTest(S2_TEST), releaseTest(S10_TEST, true, true), releaseTest(S11_TEST)] }),
      { S2: PRESENT, S3: PRESENT, S10: QUARANTINED, S11: PRESENT },
    );
  });

  it('S11 with quarantined null is unknown/release-test-unreadable', () => {
    expectCodes(
      passingInput({ releaseTests: [releaseTest(S2_TEST), releaseTest(S10_TEST), releaseTest(S11_TEST, true, null)] }),
      { S2: PRESENT, S3: PRESENT, S10: PRESENT, S11: TEST_UNREADABLE },
    );
  });

  it('releaseSha null yields unknown/release-unpinned for S2, S10 and S11 while S3 passes', () => {
    expectCodes(passingInput({ releaseSha: null }), {
      S2: UNPINNED,
      S3: PRESENT,
      S10: UNPINNED,
      S11: UNPINNED,
    });
  });

  it('releaseTests null yields unknown/release-tree-unreadable for the three test-bound criteria', () => {
    expectCodes(passingInput({ releaseTests: null }), {
      S2: TREE_UNREADABLE,
      S3: PRESENT,
      S10: TREE_UNREADABLE,
      S11: TREE_UNREADABLE,
    });
  });

  it('a null releaseSha and a null releaseTests yield release-unpinned, which outranks release-tree-unreadable', () => {
    expectCodes(passingInput({ releaseSha: null, releaseTests: null }), {
      S2: UNPINNED,
      S3: PRESENT,
      S10: UNPINNED,
      S11: UNPINNED,
    });
  });

  it('an S3 attestation dated the next day is unknown/not-yet-observed', () => {
    expectCodes(
      passingInput({
        attestations: ledgerOf([
          { fact: FORGE, observedDay: D1 },
          { fact: CANARY, observedDay: D1 },
          { fact: WAKE, observedDay: D3 },
        ]),
      }),
      { S2: PRESENT, S3: NOT_YET, S10: PRESENT, S11: PRESENT },
    );
  });

  it('an S3 attestation under another release sha still passes', () => {
    expectCodes(
      passingInput({
        attestations: ledgerOf([
          { fact: FORGE, observedDay: D1 },
          { fact: CANARY, observedDay: D1 },
          { fact: WAKE, observedDay: D1, releaseSha: OTHER_RELEASE_SHA },
        ]),
      }),
      { S2: PRESENT, S3: PRESENT, S10: PRESENT, S11: PRESENT },
    );
  });

  it('S2 is unknown/not-yet-observed when only one of its two facts is attested', () => {
    expectCodes(
      passingInput({
        attestations: ledgerOf([
          { fact: FORGE, observedDay: D1 },
          { fact: WAKE, observedDay: DAY },
        ]),
      }),
      { S2: NOT_YET, S3: PRESENT, S10: PRESENT, S11: PRESENT },
    );
  });

  it('S2 with its test absent and its facts missing is fail/required-test-absent', () => {
    expectCodes(
      passingInput({
        attestations: ledgerOf([{ fact: WAKE, observedDay: DAY }]),
        releaseTests: [releaseTest(S2_TEST, false), releaseTest(S10_TEST), releaseTest(S11_TEST)],
      }),
      { S2: ABSENT, S3: PRESENT, S10: PRESENT, S11: PRESENT },
    );
  });

  it('S2 absent while the release is unpinned is fail/required-test-absent, which wins over release-unpinned', () => {
    expectCodes(
      passingInput({
        releaseSha: null,
        releaseTests: [releaseTest(S2_TEST, false), releaseTest(S10_TEST), releaseTest(S11_TEST)],
      }),
      { S2: ABSENT, S3: PRESENT, S10: UNPINNED, S11: UNPINNED },
    );
  });

  it('S2 with present false and quarantined true is fail/required-test-absent', () => {
    expectCodes(
      passingInput({ releaseTests: [releaseTest(S2_TEST, false, true), releaseTest(S10_TEST), releaseTest(S11_TEST)] }),
      { S2: ABSENT, S3: PRESENT, S10: PRESENT, S11: PRESENT },
    );
  });

  it('S2 quarantined with its facts missing is fail/required-test-quarantined', () => {
    expectCodes(
      passingInput({
        attestations: ledgerOf([{ fact: WAKE, observedDay: DAY }]),
        releaseTests: [releaseTest(S2_TEST, true, true), releaseTest(S10_TEST), releaseTest(S11_TEST)],
      }),
      { S2: QUARANTINED, S3: PRESENT, S10: PRESENT, S11: PRESENT },
    );
  });

  it('a store absent (attestations null) yields not-yet-observed for S2 and S3', () => {
    expectCodes(passingInput({ attestations: null }), {
      S2: NOT_YET,
      S3: NOT_YET,
      S10: PRESENT,
      S11: PRESENT,
    });
  });

  it('a malformed ledger is unknown/attestations-unreadable for all four', () => {
    expectUnreadableAttestations(passingInput({ attestations: { nope: true } }));
  });

  it('a number where the attestation ledger is due is unknown/attestations-unreadable', () => {
    expectUnreadableAttestations(passingInput({ attestations: 1 }));
  });

  it('a required test path not reported is unknown/release-test-unreported', () => {
    expectCodes(passingInput({ releaseTests: [releaseTest(S10_TEST), releaseTest(S11_TEST)] }), {
      S2: UNREPORTED,
      S3: PRESENT,
      S10: PRESENT,
      S11: PRESENT,
    });
  });

  it('more than SHADOW_ONE_TIME_MAX_TESTS release tests is unknown/invalid-input', () => {
    expect(paddedTests(SHADOW_ONE_TIME_MAX_TESTS + 1)).toHaveLength(SHADOW_ONE_TIME_MAX_TESTS + 1);
    expectInvalidInput(passingInput({ releaseTests: paddedTests(SHADOW_ONE_TIME_MAX_TESTS + 1) }));
  });

  it('exactly SHADOW_ONE_TIME_MAX_TESTS release tests is accepted when the required paths are reported', () => {
    expect(paddedTests(SHADOW_ONE_TIME_MAX_TESTS)).toHaveLength(SHADOW_ONE_TIME_MAX_TESTS);
    expectCodes(passingInput({ releaseTests: paddedTests(SHADOW_ONE_TIME_MAX_TESTS) }), {
      S2: PRESENT,
      S3: PRESENT,
      S10: PRESENT,
      S11: PRESENT,
    });
  });

  it('refuses duplicate release-test paths with invalid-input', () => {
    expectInvalidInput(
      passingInput({
        releaseTests: [releaseTest(S2_TEST), releaseTest(S2_TEST), releaseTest(S10_TEST), releaseTest(S11_TEST)],
      }),
    );
  });

  it('refuses a calendar-invalid day with invalid-input', () => {
    expectInvalidInput(passingInput({ day: '2026-02-31' }));
  });

  it('refuses a release sha of the wrong shape with invalid-input', () => {
    expectInvalidInput(passingInput({ releaseSha: 'z'.repeat(40) }));
  });

  it('refuses input missing attestations with invalid-input', () => {
    const input = passingInput();
    delete input.attestations;
    expectInvalidInput(input);
  });

  it('refuses input missing releaseTests with invalid-input', () => {
    const input = passingInput();
    delete input.releaseTests;
    expectInvalidInput(input);
  });

  it('refuses a secret-shaped release-test path with invalid-input and does not echo it', () => {
    const result = evaluateShadowOneTimeCriteria(
      passingInput({ releaseTests: [releaseTest(SECRET_TEXT), releaseTest(S10_TEST), releaseTest(S11_TEST)] }),
    );
    expect(result).toEqual({
      S2: { status: 'unknown', reason: 'invalid-input' },
      S3: { status: 'unknown', reason: 'invalid-input' },
      S10: { status: 'unknown', reason: 'invalid-input' },
      S11: { status: 'unknown', reason: 'invalid-input' },
    });
    expect(JSON.stringify(result).includes('sk-')).toBe(false);
  });

  it('a release-test path over SHADOW_ONE_TIME_MAX_PATH_LENGTH is invalid-input and is not echoed', () => {
    const overCapPath = `${S2_TEST}${'x'.repeat(SHADOW_ONE_TIME_MAX_PATH_LENGTH + 1 - S2_TEST.length)}`;
    expect(overCapPath.length).toBe(SHADOW_ONE_TIME_MAX_PATH_LENGTH + 1);
    const input = passingInput({
      releaseTests: [releaseTest(overCapPath), releaseTest(S10_TEST), releaseTest(S11_TEST)],
    });
    expectCodes(input, { S2: INVALID, S3: INVALID, S10: INVALID, S11: INVALID });
    expect(JSON.stringify(evaluateShadowOneTimeCriteria(input)).includes(overCapPath)).toBe(false);
  });

  it('a release-test path of exactly SHADOW_ONE_TIME_MAX_PATH_LENGTH is accepted as an extra entry', () => {
    const cappedPath = `${S2_TEST}${'x'.repeat(SHADOW_ONE_TIME_MAX_PATH_LENGTH - S2_TEST.length)}`;
    expect(cappedPath.length).toBe(SHADOW_ONE_TIME_MAX_PATH_LENGTH);
    expectCodes(passingInput({ releaseTests: [releaseTest(cappedPath), ...presentTests()] }), {
      S2: PRESENT,
      S3: PRESENT,
      S10: PRESENT,
      S11: PRESENT,
    });
  });

  it('SHADOW_ONE_TIME_REQUIREMENTS is frozen and names exactly the reserved paths', () => {
    expect(SHADOW_ONE_TIME_CRITERIA).toEqual(['S2', 'S3', 'S10', 'S11']);
    expect(SHADOW_ONE_TIME_MAX_TESTS).toBe(16);
    expect(Object.isFrozen(SHADOW_ONE_TIME_REQUIREMENTS)).toBe(true);
    for (const criterion of SHADOW_ONE_TIME_CRITERIA) {
      expect(Object.isFrozen(SHADOW_ONE_TIME_REQUIREMENTS[criterion])).toBe(true);
      expect(Object.isFrozen(SHADOW_ONE_TIME_REQUIREMENTS[criterion].tests)).toBe(true);
      expect(Object.isFrozen(SHADOW_ONE_TIME_REQUIREMENTS[criterion].facts)).toBe(true);
    }
    expect(SHADOW_ONE_TIME_REQUIREMENTS.S2.tests).toEqual([S2_TEST]);
    expect(SHADOW_ONE_TIME_REQUIREMENTS.S2.facts).toEqual([FORGE, CANARY]);
    expect(SHADOW_ONE_TIME_REQUIREMENTS.S3.tests).toEqual([]);
    expect(SHADOW_ONE_TIME_REQUIREMENTS.S3.facts).toEqual([WAKE]);
    expect(SHADOW_ONE_TIME_REQUIREMENTS.S10.tests).toEqual([S10_TEST]);
    expect(SHADOW_ONE_TIME_REQUIREMENTS.S10.facts).toEqual([]);
    expect(SHADOW_ONE_TIME_REQUIREMENTS.S11.tests).toEqual([S11_TEST]);
    expect(SHADOW_ONE_TIME_REQUIREMENTS.S11.facts).toEqual([]);
  });

  it('SHADOW_ONE_TIME_CRITERIA is frozen', () => {
    expect(Object.isFrozen(SHADOW_ONE_TIME_CRITERIA)).toBe(true);
  });

  it('a criterion that is not evaluated is never pass', () => {
    // The frozen export cannot be emptied, so the skip is exercised through
    // the iterator protocol instead: the loop still runs the module's own
    // entry point, but visits every criterion except S3. The frozen export
    // itself is never mutated.
    const skip = 'S3';
    const originalIterator = Array.prototype[Symbol.iterator];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the protocol hook is deliberately any-shaped
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the protocol hook is deliberately any-shaped
    Array.prototype[Symbol.iterator] = function* (this: any): Generator<any, undefined, any> {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the protocol hook is deliberately any-shaped
      const items: Iterator<any> = originalIterator.call(this);
      let skipping = true;
      for (let next = items.next(); !next.done; next = items.next()) {
        if (skipping && this === SHADOW_ONE_TIME_CRITERIA && next.value === skip) {
          skipping = false;
          continue;
        }
        yield next.value;
      }
    };
    let result: ReturnType<typeof evaluateShadowOneTimeCriteria>;
    try {
      result = evaluateShadowOneTimeCriteria(passingInput());
    } finally {
      Array.prototype[Symbol.iterator] = originalIterator;
    }
    expect(Object.isFrozen(SHADOW_ONE_TIME_CRITERIA)).toBe(true);
    expect(SHADOW_ONE_TIME_CRITERIA).toEqual(['S2', 'S3', 'S10', 'S11']);
    expect(result.S2).toEqual({ status: 'pass', reason: 'one-time-evidence-present' });
    expect(result.S3.status).not.toBe('pass');
    expect(result.S10).toEqual({ status: 'pass', reason: 'one-time-evidence-present' });
    expect(result.S11).toEqual({ status: 'pass', reason: 'one-time-evidence-present' });
  });

  it('is not satisfiable by a constant verdict', () => {
    const passing = evaluateShadowOneTimeCriteria(passingInput());
    const failing = evaluateShadowOneTimeCriteria(
      passingInput({ releaseTests: [releaseTest(S2_TEST, false), releaseTest(S10_TEST), releaseTest(S11_TEST)] }),
    );
    expect(passing.S2).toEqual({ status: 'pass', reason: 'one-time-evidence-present' });
    expect(failing.S2).toEqual({ status: 'fail', reason: 'required-test-absent' });
    expect(passing).not.toEqual(failing);
  });

  it('is not an identity echo of the input', () => {
    const input = passingInput();
    const result = evaluateShadowOneTimeCriteria(input);
    expect(result).not.toBe(input);
    expect(result).not.toEqual(input);
    const encoded = JSON.stringify(result);
    expect(encoded.includes(RELEASE_SHA)).toBe(false);
    expect(encoded.includes(DAY)).toBe(false);
    expect(encoded.includes(S2_TEST)).toBe(false);
    expect(encoded.includes(DIGEST)).toBe(false);
    expect(result.S2).toEqual({ status: 'pass', reason: 'one-time-evidence-present' });
  });

  it('refuses null with invalid-input', () => {
    expectInvalidInput(null);
  });

  it('refuses undefined with invalid-input', () => {
    expectInvalidInput(undefined);
  });

  it('refuses a number where a string is due (day and releaseSha) with invalid-input', () => {
    expectInvalidInput(passingInput({ day: 20260202 }));
    expectInvalidInput(passingInput({ releaseSha: 1 }));
  });

  it('refuses a string where the releaseTests list is due with invalid-input', () => {
    expectInvalidInput(passingInput({ releaseTests: S2_TEST }));
  });

  it('refuses a non-iterable object where the releaseTests list is due with invalid-input', () => {
    let calls = 0;
    const list: Record<string, unknown> = {};
    Object.defineProperty(list, 'path', {
      enumerable: true,
      get() {
        calls += 1;
        return S2_TEST;
      },
    });
    expectInvalidInput(passingInput({ releaseTests: list }));
    expect(calls).toBe(0);
  });

  it('refuses a releaseTests array with a hole with invalid-input', () => {
    const kept = releaseTest(S2_TEST);
    const calls = plantGetter(kept, 'present', true);
    const tests: unknown[] = [kept, releaseTest(S10_TEST), releaseTest(S11_TEST)];
    delete tests[1];
    expectInvalidInput(passingInput({ releaseTests: tests }));
    expect(calls()).toBe(0);
  });

  it('refuses an array-like object where the releaseTests list is due with invalid-input', () => {
    const arrayLike: Record<string, unknown> = { length: 1 };
    const calls = plantGetter(arrayLike, '0', releaseTest(S2_TEST));
    expectInvalidInput(passingInput({ releaseTests: arrayLike }));
    expect(calls()).toBe(0);
  });

  it('refuses an enormous sparse length (2**32 - 1) before any traversal with invalid-input', () => {
    const sparse: unknown[] = [];
    Object.defineProperty(sparse, 'length', { value: 2 ** 32 - 1 });
    const calls = plantGetter(sparse, '0', releaseTest(S2_TEST));
    expectInvalidInput(passingInput({ releaseTests: sparse }));
    expect(calls()).toBe(0);
  });

  it('never runs a getter on the root and refuses it with invalid-input', () => {
    const input = passingInput();
    const calls = plantGetter(input, 'day', DAY);
    expectInvalidInput(input);
    expect(calls()).toBe(0);
  });

  it('never runs a getter on a release-test item and refuses it with invalid-input', () => {
    const item = releaseTest(S2_TEST);
    const calls = plantGetter(item, 'present', true);
    expectInvalidInput(passingInput({ releaseTests: [item, releaseTest(S10_TEST), releaseTest(S11_TEST)] }));
    expect(calls()).toBe(0);
  });

  it('never runs a getter on the attestations ledger and returns attestations-unreadable', () => {
    const ledger = factsOnOrBeforeDay();
    const calls = plantGetter(ledger, 'revision', ledger.revision);
    expectUnreadableAttestations(passingInput({ attestations: ledger }));
    expect(calls()).toBe(0);
  });

  it('a Proxy over a valid input yields exactly the plain data and runs no get trap', () => {
    const input = passingInput();
    const plain = evaluateShadowOneTimeCriteria(input);
    expect(evaluateShadowOneTimeCriteria(new Proxy(input, {}))).toEqual(plain);
    let gets = 0;
    const counted = new Proxy(input, {
      get(target, property, receiver) {
        gets += 1;
        return Reflect.get(target, property, receiver);
      },
    });
    expect(evaluateShadowOneTimeCriteria(counted)).toEqual(plain);
    expect(gets).toBe(0);
  });

  it('refuses a Proxy whose ownKeys trap throws with invalid-input', () => {
    const proxy = new Proxy(passingInput(), {
      ownKeys() {
        throw new Error('trap');
      },
    });
    expectInvalidInput(proxy);
  });

  it('refuses a prototype-polluting __proto__ key produced by JSON.parse with invalid-input', () => {
    expectInvalidInput(pollutedEvaluation('__proto__'));
    expect(Object.getOwnPropertyDescriptor(Object.prototype, 'polluted')).toBeUndefined();
  });

  it('refuses a prototype-polluting constructor key produced by JSON.parse with invalid-input', () => {
    expectInvalidInput(pollutedEvaluation('constructor'));
    expect(Object.getOwnPropertyDescriptor(Object.prototype, 'polluted')).toBeUndefined();
  });

  it('refuses a prototype-polluting prototype key produced by JSON.parse with invalid-input', () => {
    expectInvalidInput(pollutedEvaluation('prototype'));
    expect(Object.getOwnPropertyDescriptor(Object.prototype, 'polluted')).toBeUndefined();
  });
});

// Lane AT1: hostile-input tests for `parseShadowAttestationCommandInput`.
// Every case asserts the specific refusal code, never merely that nothing
// threw.
describe('parseShadowAttestationCommandInput hostile input (AT1)', () => {
  const VALID: Record<string, unknown> = {
    fact: 's2-forge-error-backoff',
    note: 'verified',
    expectedRevision: 0,
    operationId: 'op-1',
    authority: 'ops-lead-7',
  };

  function validParse(raw: unknown): ShadowAttestationCommandInputParse {
    return parseShadowAttestationCommandInput(raw);
  }

  it('accepts the valid command input and echoes none of it back', () => {
    const parsed = validParse(VALID);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value).toEqual({
      fact: 's2-forge-error-backoff',
      note: 'verified',
      expectedRevision: 0,
      operationId: 'op-1',
      authority: 'ops-lead-7',
    });
    expect(parsed.value).not.toBe(VALID);
  });

  it('refuses null with invalid-input', () => {
    expect(validParse(null)).toEqual({ ok: false, reason: 'invalid-input' });
  });

  it('refuses undefined with invalid-input', () => {
    expect(validParse(undefined)).toEqual({ ok: false, reason: 'invalid-input' });
  });

  it('refuses a wrong primitive (a number where the command object is due) with invalid-input', () => {
    expect(validParse(7)).toEqual({ ok: false, reason: 'invalid-input' });
    expect(validParse(baseInputWith({ note: 42 }))).toEqual({ ok: false, reason: 'invalid-input' });
    expect(validParse(baseInputWith({ expectedRevision: '0' }))).toEqual({ ok: false, reason: 'invalid-input' });
  });

  it('refuses a non-iterable object where a list is due (an array root) with invalid-input', () => {
    expect(validParse([VALID])).toEqual({ ok: false, reason: 'invalid-input' });
  });

  it('refuses a sparse array root (a hole) with invalid-input', () => {
    const sparse: unknown[] = new Array(3);
    sparse[1] = VALID;
    expect(validParse(sparse)).toEqual({ ok: false, reason: 'invalid-input' });
  });

  it('refuses an array-like object with invalid-input', () => {
    expect(validParse({ length: 1, 0: VALID })).toEqual({ ok: false, reason: 'invalid-input' });
  });

  it('refuses an enormous sparse length before any traversal with invalid-input', () => {
    const enormous: unknown[] = [];
    Object.defineProperty(enormous, 'length', { value: 2 ** 32 - 1 });
    expect(validParse(enormous)).toEqual({ ok: false, reason: 'invalid-input' });
  });

  it('never runs a getter on the root or on a value (the counter stays 0)', () => {
    let calls = 0;
    const input: Record<string, unknown> = {
      ...VALID,
      get note(): string {
        calls += 1;
        return 'never';
      },
    };
    const parsed = validParse(input);
    expect(parsed).toEqual({ ok: false, reason: 'invalid-input' });
    expect(calls).toBe(0);
  });

  it('accepts a Proxy over a valid input as exactly the plain data, with no get trap run', () => {
    let getTraps = 0;
    const proxy = new Proxy({ ...VALID }, {
      get(target, key, receiver) {
        getTraps += 1;
        return Reflect.get(target, key, receiver);
      },
    });
    const parsed = validParse(proxy);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.fact).toBe('s2-forge-error-backoff');
    expect(getTraps).toBe(0);
  });

  it('refuses prototype-polluting constructor and prototype keys produced by JSON.parse with invalid-input', () => {
    for (const key of ['__proto__', 'constructor', 'prototype']) {
      const raw = JSON.parse(`{"${key}":{"polluted":true},"fact":"s2-forge-error-backoff","note":"n","expectedRevision":0,"operationId":"op-1","authority":"a"}`);
      expect(validParse(raw)).toEqual({ ok: false, reason: 'invalid-input' });
    }
    expect(Object.getOwnPropertyDescriptor(Object.prototype, 'polluted')).toBeUndefined();
  });

  it('refuses a missing optional field only when a present one is malformed, and an over-cap note with invalid-input', () => {
    expect(validParse(baseInputWith({ note: 'x'.repeat(513) }))).toEqual({ ok: false, reason: 'invalid-input' });
    expect(validParse(baseInputWith({ evidence: '' }))).toEqual({ ok: false, reason: 'invalid-input' });
    expect(validParse(baseInputWith({ evidence: 'x'.repeat(257) }))).toEqual({ ok: false, reason: 'invalid-input' });
    expect(validParse(baseInputWith({ authority: 'x'.repeat(129) }))).toEqual({ ok: false, reason: 'invalid-input' });
    expect(validParse(baseInputWith({ operationId: 'x'.repeat(65) }))).toEqual({ ok: false, reason: 'invalid-input' });
    expect(validParse(baseInputWith({ expectedRevision: 1.5 }))).toEqual({ ok: false, reason: 'invalid-input' });
    expect(validParse(baseInputWith({ nowIso: '2026-06-15T00:00:00Z' }))).toEqual({ ok: false, reason: 'invalid-input' });
  });

  it('refuses a present evidence key holding undefined with invalid-input', () => {
    expect(validParse(baseInputWith({ evidence: undefined }))).toEqual({ ok: false, reason: 'invalid-input' });
  });

  it('refuses an object with more own keys than the capped key set before any traversal with invalid-input', () => {
    // Nine own keys against a capped key set of eight: the count is read
    // first, so no field is ever snapshotted.
    const oversized: Record<string, unknown> = { ...VALID, extraA: 1, extraB: 2, extraC: 3, extraD: 4 };
    expect(validParse(oversized)).toEqual({ ok: false, reason: 'invalid-input' });
  });

  it('refuses an unknown fact id with unknown-fact', () => {
    expect(validParse(baseInputWith({ fact: 's9-unknown-fact' }))).toEqual({ ok: false, reason: 'unknown-fact' });
  });

  it('refuses a non-string fact with invalid-input, not unknown-fact', () => {
    expect(validParse(baseInputWith({ fact: 7 }))).toEqual({ ok: false, reason: 'invalid-input' });
    expect(validParse(baseInputWith({ fact: null }))).toEqual({ ok: false, reason: 'invalid-input' });
  });

  it('refuses secret-shaped note, evidence and authority with secret-shaped', () => {
    expect(validParse(baseInputWith({ note: SECRET_TEXT }))).toEqual({ ok: false, reason: 'secret-shaped' });
    expect(validParse(baseInputWith({ evidence: SECRET_TEXT }))).toEqual({ ok: false, reason: 'secret-shaped' });
    expect(validParse(baseInputWith({ authority: SECRET_TEXT }))).toEqual({ ok: false, reason: 'secret-shaped' });
  });

  it('is not a constant verdict: different inputs give different typed results', () => {
    // A parser that always returned { ok: false, reason: 'invalid-input' }
    // would fail the valid case; one that always refused with one code would
    // fail the unknown-fact and secret-shaped cases above.
    expect(validParse(VALID).ok).toBe(true);
    expect(validParse(baseInputWith({ fact: 'nope' }))).toEqual({ ok: false, reason: 'unknown-fact' });
    expect(validParse(baseInputWith({ note: SECRET_TEXT }))).toEqual({ ok: false, reason: 'secret-shaped' });
  });

  it('is not an identity echo: the parsed value is a fresh, typed structure', () => {
    const parsed = validParse(VALID);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value).not.toBe(VALID);
    expect(Object.keys(parsed.value).sort()).toEqual(['authority', 'expectedRevision', 'fact', 'note', 'operationId']);
    expect('deadlineIso' in parsed.value).toBe(false);
  });
});

function baseInputWith(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    fact: 's2-forge-error-backoff',
    note: 'verified',
    expectedRevision: 0,
    operationId: 'op-1',
    authority: 'ops-lead-7',
    ...overrides,
  };
}
