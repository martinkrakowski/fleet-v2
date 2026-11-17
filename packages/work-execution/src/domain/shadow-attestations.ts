// Lane SH15a: the pure shadow attestation ledger. One-time facts (S2 forge
// backoff, S2 canary parks, S3 wake after outage) are recorded once and stay
// recorded. The day ledger is not reused. Pure: no filesystem, no subprocess,
// no clock. Never throws, never echoes an input value; every exported
// function takes `unknown` at its boundary and returns a typed refusal.

import { isZonedIsoDateTime } from './conductor-halt.js';
import { readExactPlainRecord, readPlainRecordWithOptionalKeys } from './plain-record-reads.js';
import { INITIAL_RECORD_SCHEMA_VERSION, readRecordSchemaVersion } from './record-schema-version.js';
import {
  DAY_PATTERN,
  MAX_REVISION,
  SHADOW_DIGEST_PATTERN,
  SHADOW_REASON_PATTERN,
  SHADOW_RELEASE_SHA_PATTERN,
  dayNumber,
  isSecretShaped,
  isVersionAboveCurrent,
} from './shadow-evidence-ledger.js';

export const SHADOW_ATTESTATION_SCHEMA_VERSION = INITIAL_RECORD_SCHEMA_VERSION;

export const SHADOW_ATTESTATION_FACTS = [
  's2-forge-error-backoff',
  's2-canary-parks',
  's3-wake-after-outage',
] as const;

export type ShadowAttestationFact = (typeof SHADOW_ATTESTATION_FACTS)[number];

export interface ShadowAttestation {
  readonly fact: ShadowAttestationFact;
  readonly observedDay: string;
  readonly releaseSha: string | null;
  readonly reason: string;
  readonly digest: string;
  readonly recordedAtIso: string;
}

export interface ShadowAttestationLedger {
  readonly schemaVersion: number;
  readonly revision: number;
  readonly attestations: readonly ShadowAttestation[];
}

export type ShadowAttestationRead =
  | { readonly ok: true; readonly ledger: ShadowAttestationLedger }
  | { readonly ok: false; readonly reason: 'unknown-version' | 'invalid-ledger' };

export type ShadowAttestationWrite =
  | { readonly ok: true; readonly ledger: ShadowAttestationLedger; readonly changed: boolean }
  | { readonly ok: false; readonly reason: 'invalid-ledger' | 'invalid-input' };

const LEDGER_REQUIRED_KEYS: readonly string[] = ['revision', 'attestations'];
const LEDGER_OPTIONAL_KEYS: readonly string[] = ['schemaVersion'];
const ATTESTATION_KEYS: readonly string[] = [
  'fact',
  'observedDay',
  'releaseSha',
  'reason',
  'digest',
  'recordedAtIso',
];

const INVALID_LEDGER: ShadowAttestationRead = { ok: false, reason: 'invalid-ledger' };
const UNKNOWN_VERSION: ShadowAttestationRead = { ok: false, reason: 'unknown-version' };
const INVALID_LEDGER_WRITE: ShadowAttestationWrite = { ok: false, reason: 'invalid-ledger' };
const INVALID_INPUT_WRITE: ShadowAttestationWrite = { ok: false, reason: 'invalid-input' };

interface BoundedAttestations {
  readonly array: readonly unknown[];
  readonly length: number;
}

/**
 * Read a persisted attestation ledger. Own data properties only: every value
 * comes from its own property descriptor, so no getter ever runs. Success
 * returns a fresh structure built field by field. A Proxy stand-in is refused
 * by the shape checks or yields exactly the plain data, because every read
 * goes through `Object.getOwnPropertyDescriptor` and `Reflect.ownKeys`, never
 * a `get` trap. Cost: linear in the capped input. The cap is the named
 * constant `SHADOW_ATTESTATION_FACTS.length`; revision is bounded by the
 * named constant `MAX_REVISION`. An oversized or non-dense `attestations`
 * array is refused from its own `length` before any element is traversed.
 * Never throws, never echoes the input.
 */
export function readShadowAttestations(raw: unknown): ShadowAttestationRead {
  try {
    return readAttestationLedger(raw);
  } catch {
    return INVALID_LEDGER;
  }
}

/**
 * Record one attestation. `ledger === null` means nothing stored yet
 * (revision 0, no attestations); any other invalid ledger is
 * `invalid-ledger`. A malformed attestation is `invalid-input`. The first
 * observation of a fact is kept: recording that fact again changes nothing,
 * whatever the new day, release or digest, and returns a fresh copy. A new
 * fact is inserted in `SHADOW_ATTESTATION_FACTS` order and the revision bumps
 * by one. A bump past `MAX_REVISION` is `invalid-ledger`. Cost: linear in the
 * capped ledger plus the capped input. The cap is the named constant
 * `SHADOW_ATTESTATION_FACTS.length`. Refusal paths leave the arguments
 * untouched. Never throws, never echoes an input value, always returns a
 * fresh structure.
 */
export function recordShadowAttestation(ledger: unknown, input: unknown): ShadowAttestationWrite {
  const existing = readExistingLedger(ledger);
  if (existing === null) {
    return INVALID_LEDGER_WRITE;
  }
  const parsed = parseAttestationInput(input);
  if (parsed === null) {
    return INVALID_INPUT_WRITE;
  }
  return writeAttestation(existing, parsed);
}

function readAttestationLedger(raw: unknown): ShadowAttestationRead {
  const version = readRecordSchemaVersion(raw, SHADOW_ATTESTATION_SCHEMA_VERSION);
  if (!version.ok) {
    // Same split as the day ledger. isVersionAboveCurrent compares against
    // SHADOW_LEDGER_SCHEMA_VERSION, which equals this schema version: both
    // are INITIAL_RECORD_SCHEMA_VERSION.
    return version.reason === 'unknown-schema-version' && isVersionAboveCurrent(raw)
      ? UNKNOWN_VERSION
      : INVALID_LEDGER;
  }
  const snapshot = readPlainRecordWithOptionalKeys(raw, LEDGER_REQUIRED_KEYS, LEDGER_OPTIONAL_KEYS);
  if (snapshot === null) {
    return INVALID_LEDGER;
  }
  const revision = readRevision(snapshot.revision);
  if (revision === null) {
    return INVALID_LEDGER;
  }
  const attestations = readAttestationList(snapshot.attestations);
  if (attestations === null) {
    return INVALID_LEDGER;
  }
  return {
    ok: true,
    ledger: { schemaVersion: SHADOW_ATTESTATION_SCHEMA_VERSION, revision, attestations },
  };
}

function readExistingLedger(ledger: unknown): ShadowAttestationLedger | null {
  if (ledger === null) {
    return emptyLedger();
  }
  const read = readShadowAttestations(ledger);
  return read.ok ? read.ledger : null;
}

function emptyLedger(): ShadowAttestationLedger {
  return { schemaVersion: SHADOW_ATTESTATION_SCHEMA_VERSION, revision: 0, attestations: [] };
}

function parseAttestationInput(input: unknown): ShadowAttestation | null {
  try {
    return readAttestation(input);
  } catch {
    return null;
  }
}

function writeAttestation(existing: ShadowAttestationLedger, parsed: ShadowAttestation): ShadowAttestationWrite {
  if (hasFact(existing, parsed.fact)) {
    return { ok: true, ledger: copyLedger(existing), changed: false };
  }
  if (existing.revision + 1 > MAX_REVISION) {
    return INVALID_LEDGER_WRITE;
  }
  return {
    ok: true,
    ledger: {
      schemaVersion: SHADOW_ATTESTATION_SCHEMA_VERSION,
      revision: existing.revision + 1,
      attestations: insertInFactOrder(existing.attestations, parsed),
    },
    changed: true,
  };
}

function hasFact(ledger: ShadowAttestationLedger, fact: ShadowAttestationFact): boolean {
  return ledger.attestations.some((item) => item.fact === fact);
}

function insertInFactOrder(
  existing: readonly ShadowAttestation[],
  parsed: ShadowAttestation,
): readonly ShadowAttestation[] {
  const incoming = factIndex(parsed.fact) ?? SHADOW_ATTESTATION_FACTS.length;
  const copied = existing.map(copyAttestation);
  const insertAt = indexAfterSmallerFacts(copied, incoming);
  return [...copied.slice(0, insertAt), copyAttestation(parsed), ...copied.slice(insertAt)];
}

function indexAfterSmallerFacts(attestations: readonly ShadowAttestation[], incoming: number): number {
  for (let index = 0; index < attestations.length; index += 1) {
    const order = factIndex(attestations[index].fact);
    if (order !== null && order > incoming) {
      return index;
    }
  }
  return attestations.length;
}

function copyLedger(ledger: ShadowAttestationLedger): ShadowAttestationLedger {
  return {
    schemaVersion: SHADOW_ATTESTATION_SCHEMA_VERSION,
    revision: ledger.revision,
    attestations: ledger.attestations.map(copyAttestation),
  };
}

function copyAttestation(attestation: ShadowAttestation): ShadowAttestation {
  return {
    fact: attestation.fact,
    observedDay: attestation.observedDay,
    releaseSha: attestation.releaseSha,
    reason: attestation.reason,
    digest: attestation.digest,
    recordedAtIso: attestation.recordedAtIso,
  };
}

function readRevision(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > MAX_REVISION) {
    return null;
  }
  return value;
}

function readAttestationList(value: unknown): readonly ShadowAttestation[] | null {
  const bounded = readBoundedAttestations(value);
  if (bounded === null) {
    return null;
  }
  return collectAttestations(bounded);
}

/**
 * A real, dense array of at most `SHADOW_ATTESTATION_FACTS.length` elements,
 * or null. The length comes from its own descriptor and is refused before
 * `Object.keys` when it is over the cap, so an enormous sparse length is
 * never traversed. Cost: linear in the number of own keys, which the cap
 * bounds.
 */
function readBoundedAttestations(value: unknown): BoundedAttestations | null {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    return null;
  }
  const length = ownArrayLength(value);
  if (length === null || Object.keys(value).length !== length) {
    return null;
  }
  return { array: value, length };
}

function ownArrayLength(value: readonly unknown[]): number | null {
  const descriptor = Object.getOwnPropertyDescriptor(value, 'length');
  if (descriptor === undefined || descriptor.get !== undefined) {
    return null;
  }
  const length: unknown = descriptor.value;
  if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0) {
    return null;
  }
  if (length > SHADOW_ATTESTATION_FACTS.length) {
    return null;
  }
  return length;
}

function ownAttestationElement(array: readonly unknown[], index: number): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(array, String(index));
  if (descriptor === undefined || descriptor.get !== undefined || !('value' in descriptor)) {
    return undefined;
  }
  return descriptor.value;
}

function collectAttestations(bounded: BoundedAttestations): readonly ShadowAttestation[] | null {
  const attestations: ShadowAttestation[] = [];
  let previousIndex = -1;
  for (let index = 0; index < bounded.length; index += 1) {
    const next = readNextAttestation(ownAttestationElement(bounded.array, index), previousIndex);
    if (next === null) {
      return null;
    }
    previousIndex = next.factIndex;
    attestations.push(next.attestation);
  }
  return attestations;
}

function readNextAttestation(
  raw: unknown,
  previousIndex: number,
): { readonly attestation: ShadowAttestation; readonly factIndex: number } | null {
  const attestation = readAttestation(raw);
  if (attestation === null) {
    return null;
  }
  const index = factIndex(attestation.fact);
  if (index === null || index <= previousIndex) {
    return null;
  }
  return { attestation, factIndex: index };
}

function readAttestation(raw: unknown): ShadowAttestation | null {
  const snapshot = readExactPlainRecord(raw, ATTESTATION_KEYS);
  if (snapshot === null) {
    return null;
  }
  return attestationFromSnapshot(snapshot);
}

function attestationFromSnapshot(snapshot: Record<string, unknown>): ShadowAttestation | null {
  const fact = readFact(snapshot.fact);
  const observedDay = readObservedDay(snapshot.observedDay);
  const release = readReleaseSha(snapshot.releaseSha);
  const reason = readReason(snapshot.reason);
  const digest = readDigest(snapshot.digest);
  const recordedAtIso = readRecordedAt(snapshot.recordedAtIso);
  if (
    fact === null ||
    observedDay === null ||
    release === null ||
    reason === null ||
    digest === null ||
    recordedAtIso === null
  ) {
    return null;
  }
  return {
    fact,
    observedDay,
    releaseSha: release.releaseSha,
    reason,
    digest,
    recordedAtIso,
  };
}

function readFact(value: unknown): ShadowAttestationFact | null {
  if (typeof value !== 'string') {
    return null;
  }
  if (isSecretShaped(value) || !isFact(value)) {
    return null;
  }
  return value;
}

function isFact(value: string): value is ShadowAttestationFact {
  return factIndex(value) !== null;
}

function factIndex(fact: string): number | null {
  for (let index = 0; index < SHADOW_ATTESTATION_FACTS.length; index += 1) {
    if (SHADOW_ATTESTATION_FACTS[index] === fact) {
      return index;
    }
  }
  return null;
}

function readObservedDay(value: unknown): string | null {
  if (typeof value !== 'string' || !DAY_PATTERN.test(value)) {
    return null;
  }
  if (dayNumber(value) === null) {
    return null;
  }
  if (isSecretShaped(value)) {
    return null;
  }
  return value;
}

function readReleaseSha(value: unknown): { readonly releaseSha: string | null } | null {
  if (value === null) {
    return { releaseSha: null };
  }
  const releaseSha = readMatchingString(value, SHADOW_RELEASE_SHA_PATTERN);
  if (releaseSha === null) {
    return null;
  }
  return { releaseSha };
}

function readReason(value: unknown): string | null {
  return readMatchingString(value, SHADOW_REASON_PATTERN);
}

function readDigest(value: unknown): string | null {
  return readMatchingString(value, SHADOW_DIGEST_PATTERN);
}

function readRecordedAt(value: unknown): string | null {
  if (!isZonedIsoDateTime(value)) {
    return null;
  }
  if (isSecretShaped(value)) {
    return null;
  }
  return value;
}

function readMatchingString(value: unknown, pattern: RegExp): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  if (!pattern.test(value) || isSecretShaped(value)) {
    return null;
  }
  return value;
}
