// Lane SH15a: the pure shadow attestation ledger. One-time facts (S2 forge
// backoff, S2 canary parks, S3 wake after outage) are recorded once and stay
// recorded. The day ledger is not reused.
// Lane SH15b: the pure one-time criteria evaluator. S2, S3, S10 and S11 are
// judged from the day's release-tree test facts plus that sticky ledger.
// Pure: no filesystem, no subprocess, no clock. Never throws, never echoes an
// input value; every exported function takes `unknown` at its boundary and
// returns a typed refusal.

import { isZonedIsoDateTime } from './conductor-halt.js';
import {
  readBoundedDenseArray,
  readExactPlainRecord,
  readPlainRecordWithOptionalKeys,
  snapshotPlainDataRecord,
} from './plain-record-reads.js';
import {
  INITIAL_RECORD_SCHEMA_VERSION,
  isPlainRecordObject,
  readRecordSchemaVersion,
} from './record-schema-version.js';
import {
  DAY_PATTERN,
  MAX_REVISION,
  SHADOW_DIGEST_PATTERN,
  SHADOW_REASON_PATTERN,
  SHADOW_RELEASE_SHA_PATTERN,
  dayNumber,
  isSecretShaped,
  isVersionAboveCurrent,
  type ShadowCriterionEvaluation,
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
  /**
   * The digest of the operation id that attested this fact (absent in records
   * written before this field existed). Crash recovery is bound to it: only
   * the operation that wrote the record may complete its own crashed intent
   * as `recovered`; any other operation takes the normal attest path.
   */
  readonly operationDigest?: string;
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
const ATTESTATION_OPTIONAL_KEYS: readonly string[] = ['operationDigest'];

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
    ...(attestation.operationDigest === undefined ? {} : { operationDigest: attestation.operationDigest }),
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

/** The attestation list, capped at `SHADOW_ATTESTATION_FACTS.length`; the accepted `O(K)` engine bound of `Reflect.ownKeys` is paid inside `readBoundedDenseArray` after its `O(1)` pre-gate. */
function readBoundedAttestations(value: unknown): BoundedAttestations | null {
  return readBoundedDenseArray(value, SHADOW_ATTESTATION_FACTS.length);
}

function collectAttestations(bounded: BoundedAttestations): readonly ShadowAttestation[] | null {
  const attestations: ShadowAttestation[] = [];
  let previousIndex = -1;
  for (let index = 0; index < bounded.length; index += 1) {
    const next = readNextAttestation(bounded.array[index], previousIndex);
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
  const snapshot = readPlainRecordWithOptionalKeys(raw, ATTESTATION_KEYS, ATTESTATION_OPTIONAL_KEYS);
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
  // The operation binding is optional (records written before it existed lack
  // it); a present but malformed one refuses, and an enumerable getter on it
  // reads as `undefined`, which refuses too.
  const operationDigest = Object.hasOwn(snapshot, 'operationDigest') ? readDigest(snapshot.operationDigest) : undefined;
  if (
    fact === null ||
    observedDay === null ||
    release === null ||
    reason === null ||
    digest === null ||
    recordedAtIso === null ||
    operationDigest === null
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
    ...(operationDigest === undefined ? {} : { operationDigest }),
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

/** Frozen so a caller cannot empty it and skip criteria; `evaluateAll` also fails closed below. */
export const SHADOW_ONE_TIME_CRITERIA = Object.freeze(['S2', 'S3', 'S10', 'S11'] as const);

type ShadowOneTimeCriterion = (typeof SHADOW_ONE_TIME_CRITERIA)[number];

interface ShadowOneTimeRequirement {
  readonly tests: readonly string[];
  readonly facts: readonly string[];
}

/**
 * Test paths reserved for the S2a (DT14 park-reason e2e), S10 (kill -9 e2e)
 * and S11 (golden brief corpus) units, which must create exactly these files;
 * until they exist the criteria fail as `required-test-absent`.
 */
export const SHADOW_ONE_TIME_REQUIREMENTS: Readonly<Record<ShadowOneTimeCriterion, ShadowOneTimeRequirement>> =
  Object.freeze({
    S2: Object.freeze({
      tests: Object.freeze(['apps/cli/src/__tests__/e2e/shadow-park-reasons.e2e.test.ts']),
      facts: Object.freeze(['s2-forge-error-backoff', 's2-canary-parks']),
    }),
    S3: Object.freeze({
      tests: Object.freeze<readonly string[]>([]),
      facts: Object.freeze(['s3-wake-after-outage']),
    }),
    S10: Object.freeze({
      tests: Object.freeze(['apps/cli/src/__tests__/e2e/shadow-kill-recovery.e2e.test.ts']),
      facts: Object.freeze<readonly string[]>([]),
    }),
    S11: Object.freeze({
      tests: Object.freeze(['packages/work-execution/src/domain/__tests__/shadow-brief-corpus.test.ts']),
      facts: Object.freeze<readonly string[]>([]),
    }),
  });

/** Release-tree reports above this count are refused before any element is read. */
export const SHADOW_ONE_TIME_MAX_TESTS = 16;

/** A release-test path longer than this many characters is refused from the
 * string's own `length` before its shape is judged. */
export const SHADOW_ONE_TIME_MAX_PATH_LENGTH = 256;

export interface ShadowReleaseTestFact {
  readonly path: string;
  readonly present: boolean;
  readonly quarantined: boolean | null;
}

const ONE_TIME_INPUT_KEYS: readonly string[] = ['day', 'releaseSha', 'attestations', 'releaseTests'];
const RELEASE_TEST_KEYS: readonly string[] = ['path', 'present', 'quarantined'];

// Shared verdict objects, frozen at declaration so a caller cannot flip one
// result into a later call's result. Lower rank wins: any fail beats any
// unknown, `required-test-absent` beats `required-test-quarantined`, and the
// unknown codes follow the order in `bindingVerdict` / `reportVerdict`.
const ABSENT_RANK = 0;
const QUARANTINE_RANK = 1;
const UNPINNED_RANK = 2;
const TREE_UNREADABLE_RANK = 3;
const UNREPORTED_RANK = 4;
const TEST_UNREADABLE_RANK = 5;
const NOT_YET_RANK = 6;
const PRESENT_RANK = 7;

const INVALID_INPUT: ShadowCriterionEvaluation = Object.freeze({ status: 'unknown', reason: 'invalid-input' });
/** Fail-closed seed: a criterion the loop never visits must never report pass. */
const NOT_EVALUATED: ShadowCriterionEvaluation = Object.freeze({ status: 'unknown', reason: 'not-evaluated' });
const ATTESTATIONS_UNREADABLE: ShadowCriterionEvaluation = Object.freeze({
  status: 'unknown',
  reason: 'attestations-unreadable',
});
const RELEASE_UNPINNED: ShadowCriterionEvaluation = Object.freeze({ status: 'unknown', reason: 'release-unpinned' });
const RELEASE_TREE_UNREADABLE: ShadowCriterionEvaluation = Object.freeze({
  status: 'unknown',
  reason: 'release-tree-unreadable',
});
const RELEASE_TEST_UNREPORTED: ShadowCriterionEvaluation = Object.freeze({
  status: 'unknown',
  reason: 'release-test-unreported',
});
const TEST_ABSENT: ShadowCriterionEvaluation = Object.freeze({ status: 'fail', reason: 'required-test-absent' });
const TEST_QUARANTINED: ShadowCriterionEvaluation = Object.freeze({
  status: 'fail',
  reason: 'required-test-quarantined',
});
const TEST_UNREADABLE: ShadowCriterionEvaluation = Object.freeze({
  status: 'unknown',
  reason: 'release-test-unreadable',
});
const NOT_YET_OBSERVED: ShadowCriterionEvaluation = Object.freeze({ status: 'unknown', reason: 'not-yet-observed' });
const EVIDENCE_PRESENT: ShadowCriterionEvaluation = Object.freeze({
  status: 'pass',
  reason: 'one-time-evidence-present',
});

const UNKNOWN_RANK: Readonly<Record<string, number>> = Object.freeze({
  'release-unpinned': UNPINNED_RANK,
  'release-tree-unreadable': TREE_UNREADABLE_RANK,
  'release-test-unreported': UNREPORTED_RANK,
  'release-test-unreadable': TEST_UNREADABLE_RANK,
  'not-yet-observed': NOT_YET_RANK,
});

type ShadowOneTimeEvaluations = Readonly<Record<ShadowOneTimeCriterion, ShadowCriterionEvaluation>>;

interface OneTimeFacts {
  readonly daySerial: number;
  readonly releaseSha: string | null;
  readonly attestations: readonly ShadowAttestation[] | null;
  readonly tests: ReadonlyMap<string, ShadowReleaseTestFact> | null;
}

type FieldRead<T> = { readonly ok: true; readonly value: T } | { readonly ok: false };

/**
 * Evaluate S2, S3, S10 and S11 for one day. Test facts are bound to the day's
 * pinned release sha. An attestation counts on every later day regardless of
 * the release it was observed under (`observedDay` compared with `dayNumber`).
 * `attestations === null` means the store is absent. `releaseTests === null`
 * means the release tree could not be read. A fail beats any unknown.
 * Cost: an `O(1)` length/prototype pre-gate, then the accepted `O(K)` engine
 * bound of `Reflect.ownKeys` (where `K` is the target's own-property count),
 * then `O(cap)` element traversal. The caps are the named constants
 * `SHADOW_ONE_TIME_MAX_TESTS` (refused from the array's own `length` before
 * any element is traversed), `SHADOW_ONE_TIME_MAX_PATH_LENGTH` (refused from
 * a path string's own `length` before its shape is judged) and
 * `SHADOW_ATTESTATION_FACTS.length` (inside `readShadowAttestations`). Own
 * data properties only, so no getter ever
 * runs. A Proxy stand-in is refused by the shape checks or yields exactly
 * the plain data, because every read goes through
 * `Object.getOwnPropertyDescriptor` and `Reflect.ownKeys`, never a `get`
 * trap. Never throws, never echoes an input value.
 */
export function evaluateShadowOneTimeCriteria(input: unknown): ShadowOneTimeEvaluations {
  try {
    return evaluateOneTime(input);
  } catch {
    return everyCriterion(INVALID_INPUT);
  }
}

/** The four evaluations, or one shared refusal. Cost: linear in the capped input. */
function evaluateOneTime(input: unknown): ShadowOneTimeEvaluations {
  const snapshot = readExactPlainRecord(input, ONE_TIME_INPUT_KEYS);
  if (snapshot === null) {
    return everyCriterion(INVALID_INPUT);
  }
  const fields = readOneTimeFields(snapshot);
  if (fields === null) {
    return everyCriterion(INVALID_INPUT);
  }
  const attestations = readAttestationField(snapshot.attestations);
  if (!attestations.ok) {
    return everyCriterion(ATTESTATIONS_UNREADABLE);
  }
  return evaluateAll({ ...fields, attestations: attestations.value });
}

/** The same verdict on every criterion. Cost: O(1). */
function everyCriterion(verdict: ShadowCriterionEvaluation): ShadowOneTimeEvaluations {
  return { S2: verdict, S3: verdict, S10: verdict, S11: verdict };
}

/**
 * Day, release sha and release tests, or null when any shape is invalid.
 * Cost: linear in `SHADOW_ONE_TIME_MAX_TESTS`.
 */
function readOneTimeFields(snapshot: Record<string, unknown>): Omit<OneTimeFacts, 'attestations'> | null {
  const daySerial = readDaySerial(snapshot.day);
  const release = readReleaseSha(snapshot.releaseSha);
  const tests = readReleaseTestField(snapshot.releaseTests);
  if (daySerial === null || release === null || !tests.ok) {
    return null;
  }
  return { daySerial, releaseSha: release.releaseSha, tests: tests.value };
}

/** A real calendar day serial, or null. Cost: linear in the day string. */
function readDaySerial(value: unknown): number | null {
  if (typeof value !== 'string' || !DAY_PATTERN.test(value) || isSecretShaped(value)) {
    return null;
  }
  return dayNumber(value);
}

/**
 * `null` is an absent store. Anything `readShadowAttestations` refuses is
 * unreadable. Cost: linear in `SHADOW_ATTESTATION_FACTS.length`.
 */
function readAttestationField(value: unknown): FieldRead<readonly ShadowAttestation[] | null> {
  if (value === null) {
    return { ok: true, value: null };
  }
  const read = readShadowAttestations(value);
  if (!read.ok) {
    return { ok: false };
  }
  return { ok: true, value: read.ledger.attestations };
}

/**
 * `null` means the release tree could not be read. An over-cap, sparse,
 * non-array or ill-shaped list is refused. Cost: an `O(1)` length/prototype
 * pre-gate, then the accepted `O(K)` engine bound of `Reflect.ownKeys`
 * (where `K` is the target's own-property count), then `O(cap)` element
 * traversal with cap `SHADOW_ONE_TIME_MAX_TESTS`; an over-cap length is
 * refused before any element is read.
 */
function readReleaseTestField(value: unknown): FieldRead<ReadonlyMap<string, ShadowReleaseTestFact> | null> {
  if (value === null) {
    return { ok: true, value: null };
  }
  const bounded = readBoundedDenseArray(value, SHADOW_ONE_TIME_MAX_TESTS);
  if (bounded === null) {
    return { ok: false };
  }
  return collectReleaseTests(bounded);
}

/** One map of path to fact, or a refusal when an element or a duplicate path is invalid. Cost: linear in the cap. */
function collectReleaseTests(bounded: BoundedAttestations): FieldRead<ReadonlyMap<string, ShadowReleaseTestFact>> {
  const tests = new Map<string, ShadowReleaseTestFact>();
  for (let index = 0; index < bounded.length; index += 1) {
    const fact = readReleaseTest(bounded.array[index]);
    if (fact === null || tests.has(fact.path)) {
      return { ok: false };
    }
    tests.set(fact.path, fact);
  }
  return { ok: true, value: tests };
}

/** One release-test fact, or null. Cost: linear in the path string. */
function readReleaseTest(raw: unknown): ShadowReleaseTestFact | null {
  const snapshot = readExactPlainRecord(raw, RELEASE_TEST_KEYS);
  if (snapshot === null) {
    return null;
  }
  return releaseTestFromSnapshot(snapshot);
}

/** The three fields, or null when a field has the wrong shape. Cost: linear in the path string. */
function releaseTestFromSnapshot(snapshot: Record<string, unknown>): ShadowReleaseTestFact | null {
  const path = readTestPath(snapshot.path);
  const present = snapshot.present;
  const quarantined = snapshot.quarantined;
  if (path === null || typeof present !== 'boolean' || !isQuarantineFlag(quarantined)) {
    return null;
  }
  return { path, present, quarantined };
}

/** `quarantined` is a boolean or null. Cost: O(1). */
function isQuarantineFlag(value: unknown): value is boolean | null {
  return value === null || typeof value === 'boolean';
}

/** A non-empty path within `SHADOW_ONE_TIME_MAX_PATH_LENGTH` that carries no
 * secret shape, or null. Cost: linear in the path string, and an over-cap
 * path is refused from its own `length` before `isSecretShaped` runs. */
function readTestPath(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > SHADOW_ONE_TIME_MAX_PATH_LENGTH) {
    return null;
  }
  if (isSecretShaped(value)) {
    return null;
  }
  return value;
}

/** Each criterion from its requirement row. Cost: linear in the capped input. */
function evaluateAll(facts: OneTimeFacts): ShadowOneTimeEvaluations {
  const evaluations: Record<ShadowOneTimeCriterion, ShadowCriterionEvaluation> = {
    S2: NOT_EVALUATED,
    S3: NOT_EVALUATED,
    S10: NOT_EVALUATED,
    S11: NOT_EVALUATED,
  };
  for (const criterion of SHADOW_ONE_TIME_CRITERIA) {
    evaluations[criterion] = evaluateCriterion(SHADOW_ONE_TIME_REQUIREMENTS[criterion], facts);
  }
  return evaluations;
}

/** The worse of the criterion's test verdict and its fact verdict. Cost: linear in the capped input. */
function evaluateCriterion(requirement: ShadowOneTimeRequirement, facts: OneTimeFacts): ShadowCriterionEvaluation {
  return worse(evaluateTests(requirement.tests, facts), evaluateFacts(requirement.facts, facts));
}

/** The worst required-test verdict, or pass when the criterion has no tests. Cost: linear in the row. */
function evaluateTests(paths: readonly string[], facts: OneTimeFacts): ShadowCriterionEvaluation {
  let verdict: ShadowCriterionEvaluation = EVIDENCE_PRESENT;
  for (const path of paths) {
    verdict = worse(verdict, evaluateTest(path, facts));
  }
  return verdict;
}

/** Binding and report are both computed so a fail is not hidden by an earlier unknown. Cost: O(1). */
function evaluateTest(path: string, facts: OneTimeFacts): ShadowCriterionEvaluation {
  return worse(reportVerdict(facts.tests, path), bindingVerdict(facts));
}

/** Unknowns that apply before a report is trusted. Cost: O(1). */
function bindingVerdict(facts: OneTimeFacts): ShadowCriterionEvaluation {
  if (facts.releaseSha === null) {
    return RELEASE_UNPINNED;
  }
  if (facts.tests === null) {
    return RELEASE_TREE_UNREADABLE;
  }
  return EVIDENCE_PRESENT;
}

/** The reported test, or pass when the tree itself was unreadable. Cost: O(1). */
function reportVerdict(
  tests: ReadonlyMap<string, ShadowReleaseTestFact> | null,
  path: string,
): ShadowCriterionEvaluation {
  if (tests === null) {
    return EVIDENCE_PRESENT;
  }
  const reported = tests.get(path);
  if (reported === undefined) {
    return RELEASE_TEST_UNREPORTED;
  }
  return judgeReported(reported);
}

/** Absent beats quarantined; a null quarantine flag is unreadable only when the file is present. Cost: O(1). */
function judgeReported(reported: ShadowReleaseTestFact): ShadowCriterionEvaluation {
  if (!reported.present) {
    return TEST_ABSENT;
  }
  if (reported.quarantined === true) {
    return TEST_QUARANTINED;
  }
  if (reported.quarantined === null) {
    return TEST_UNREADABLE;
  }
  return EVIDENCE_PRESENT;
}

/** Not-yet-observed when any required fact has no attestation on or before the day. Cost: linear in the capped ledger. */
function evaluateFacts(required: readonly string[], facts: OneTimeFacts): ShadowCriterionEvaluation {
  for (const fact of required) {
    if (!observedByDay(fact, facts.attestations, facts.daySerial)) {
      return NOT_YET_OBSERVED;
    }
  }
  return EVIDENCE_PRESENT;
}

/** True when `fact` was attested on or before `daySerial`, under any release. Cost: linear in the capped ledger. */
function observedByDay(fact: string, attestations: readonly ShadowAttestation[] | null, daySerial: number): boolean {
  if (attestations === null) {
    return false;
  }
  for (const attestation of attestations) {
    if (matchesObservedFact(attestation, fact, daySerial)) {
      return true;
    }
  }
  return false;
}

/** The fact matches and its observed day is on or before the evaluation day. Cost: O(1). */
function matchesObservedFact(attestation: ShadowAttestation, fact: string, daySerial: number): boolean {
  return attestation.fact === fact && observedOnOrBefore(attestation.observedDay, daySerial);
}

/** `dayNumber` comparison; a day the ledger already accepted cannot fail it. Cost: O(1). */
function observedOnOrBefore(observedDay: string, daySerial: number): boolean {
  const observed = dayNumber(observedDay);
  return observed !== null && observed <= daySerial;
}

/** The lower-ranked verdict. Cost: O(1). */
function worse(left: ShadowCriterionEvaluation, right: ShadowCriterionEvaluation): ShadowCriterionEvaluation {
  return verdictRank(left) <= verdictRank(right) ? left : right;
}

/** Fail, then unknown, then pass. Cost: O(1). */
function verdictRank(verdict: ShadowCriterionEvaluation): number {
  if (verdict.status === 'pass') {
    return PRESENT_RANK;
  }
  if (verdict.status === 'fail') {
    return failRank(verdict.reason);
  }
  return UNKNOWN_RANK[verdict.reason] ?? NOT_YET_RANK;
}

/** `required-test-absent` outranks `required-test-quarantined`. Cost: O(1). */
function failRank(reason: string): number {
  if (reason === 'required-test-absent') {
    return ABSENT_RANK;
  }
  return QUARANTINE_RANK;
}

// Lane AT1: the command-input boundary for `cutover shadow attest`. The
// operator's flags arrive as one unknown; this parser is the pure gate the
// use case (and, transitively, the CLI) shares. It validates shape and
// bounds only — the use case owns the ledger, journal and clock semantics.

/** `note` is bounded so the hashed digest stays over a bounded input. */
export const MAX_ATTESTATION_NOTE_LENGTH = 512;
/** `evidence` is optional and bounded. */
export const MAX_ATTESTATION_EVIDENCE_LENGTH = 256;
/** `authority` is a bounded label; it is hashed, never stored. */
export const MAX_ATTESTATION_AUTHORITY_LENGTH = 128;
/** `operationId` becomes the journal key segment `cutover/attest@<operationId>`, so it respects `CUTOVER_KEY`'s 64-char SEGMENT. */
export const MAX_ATTESTATION_OPERATION_ID_LENGTH = 64;
/** `deadlineIso` is bounded so a malformed or oversized deadline is refused at the boundary. */
export const MAX_ATTESTATION_DEADLINE_LENGTH = 64;

const ATTESTATION_OPERATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** The keys `cutover shadow attest` accepts. No `nowIso`: the daemon clock supplies the timestamp, so a fact cannot be backdated. A present `deadlineIso` must be a bounded zoned ISO instant. */
const COMMAND_KEYS: readonly string[] = ['fact', 'note', 'evidence', 'expectedRevision', 'operationId', 'authority', 'deadlineIso'];
const COMMAND_REQUIRED_KEYS: readonly string[] = ['fact', 'note', 'expectedRevision', 'operationId'];

export interface ShadowAttestationCommandInput {
  readonly fact: ShadowAttestationFact;
  readonly note: string;
  readonly evidence?: string;
  /** Safe integer in `[0, MAX_REVISION]`. */
  readonly expectedRevision: number;
  readonly operationId: string;
  /** The caller's label. Absent or blank reads as `''`; the use case refuses `authority-required`. */
  readonly authority: string;
  /** The caller's deadline, validated here; absent when the request carries none. */
  readonly deadlineIso?: string;
}

export type ShadowAttestationCommandInputParse =
  | { readonly ok: true; readonly value: ShadowAttestationCommandInput }
  | { readonly ok: false; readonly reason: 'invalid-input' | 'unknown-fact' | 'secret-shaped' };

const COMMAND_INVALID: ShadowAttestationCommandInputParse = { ok: false, reason: 'invalid-input' };

/**
 * Parse one `cutover shadow attest` request. Own enumerable data properties
 * only, read through `snapshotPlainDataRecord` (`Reflect.ownKeys` plus each
 * key's own descriptor), so no getter ever runs and a Proxy stand-in either
 * is refused by the plain-record checks or yields exactly the result of the
 * plain data it wraps. `__proto__`, `constructor` and `prototype` own keys
 * are outside `COMMAND_KEYS` and refused. A non-plain object (including an
 * array, a class instance or a Proxy whose prototype is not
 * `Object.prototype`) and every over-cap string are refused before any field
 * is traversed. Cost: an `O(1)` length/prototype pre-gate, then the
 * accepted `O(K)` engine bound of `Object.keys`/`Reflect.ownKeys` (where `K`
 * is the target's own-property count), then a walk capped by the named
 * constants `MAX_ATTESTATION_NOTE_LENGTH`, `MAX_ATTESTATION_EVIDENCE_LENGTH`,
 * `MAX_ATTESTATION_AUTHORITY_LENGTH`, `MAX_ATTESTATION_OPERATION_ID_LENGTH`,
 * `MAX_ATTESTATION_DEADLINE_LENGTH` and `MAX_REVISION`, with the key set
 * capped at `COMMAND_KEYS.length` — the key count is read before any field is
 * traversed, so an oversized object is refused without snapshotting a single
 * field. Never throws, never echoes an input value.
 */
export function parseShadowAttestationCommandInput(raw: unknown): ShadowAttestationCommandInputParse {
  try {
    return parseCommandInput(raw);
  } catch {
    return COMMAND_INVALID;
  }
}

function parseCommandInput(raw: unknown): ShadowAttestationCommandInputParse {
  const snapshot = snapshotCommandRecord(raw);
  if (snapshot === null) {
    return COMMAND_INVALID;
  }
  const fact = readCommandFact(snapshot['fact']);
  if (!fact.ok) {
    return fact as ShadowAttestationCommandInputParse;
  }
  const note = readBoundedCommandText(snapshot['note'], MAX_ATTESTATION_NOTE_LENGTH);
  if (!note.ok) {
    return note as ShadowAttestationCommandInputParse;
  }
  const evidence = readOptionalEvidence(snapshot);
  if (!evidence.ok) {
    return evidence as ShadowAttestationCommandInputParse;
  }
  const authority = readOptionalAuthority(snapshot);
  if (!authority.ok) {
    return authority;
  }
  const expectedRevision = readExpectedRevision(snapshot['expectedRevision']);
  if (!expectedRevision.ok) {
    return COMMAND_INVALID;
  }
  const operationId = readOperationId(snapshot['operationId']);
  if (!operationId.ok) {
    return COMMAND_INVALID;
  }
  const deadlineIso = readDeadlineIso(snapshot['deadlineIso']);
  if (!deadlineIso.ok) {
    return COMMAND_INVALID;
  }
  return {
    ok: true,
    value: {
      fact: fact.value as ShadowAttestationFact,
      note: note.value,
      ...(evidence.value === undefined ? {} : { evidence: evidence.value }),
      expectedRevision: expectedRevision.value,
      operationId: operationId.value,
      authority: authority.value,
      ...(deadlineIso.value === undefined ? {} : { deadlineIso: deadlineIso.value }),
    },
  };
}

/**
 * The plain-data snapshot every field read below consumes. The key count is
 * read before any traversal: once the cheap plain-record shape check passes,
 * an object carrying more own enumerable keys than the capped key set is
 * refused without snapshotting a single field. The accepted `O(K)` engine
 * bound of `Object.keys`/`Reflect.ownKeys` (where `K` is the target's
 * own-property count) is paid on this single enumeration, capped at
 * `COMMAND_KEYS.length` + the symbol/extra-key refusal inside
 * `snapshotPlainDataRecord`. Every own key must sit inside `COMMAND_KEYS`
 * (so `__proto__`, `constructor` and `prototype` own keys are refused) and
 * every required key must be present. Returns `null` for anything that is
 * not a plain record within the caps.
 */
function snapshotCommandRecord(raw: unknown): Record<string, unknown> | null {
  if (!isPlainRecordObject(raw) || Object.keys(raw).length > COMMAND_KEYS.length) {
    return null;
  }
  const snapshot = snapshotPlainDataRecord(raw);
  if (snapshot === null) {
    return null;
  }
  const keys = Object.keys(snapshot);
  if (keys.length > COMMAND_KEYS.length) {
    return null;
  }
  for (const key of keys) {
    if (!COMMAND_KEYS.includes(key)) {
      return null;
    }
  }
  for (const key of COMMAND_REQUIRED_KEYS) {
    if (!Object.hasOwn(snapshot, key)) {
      return null;
    }
  }
  return snapshot;
}

/** A read that yields a value possibly absent. */
type OptionalCommandFieldRead =
  | { readonly ok: true; readonly value: string | undefined }
  | { readonly ok: false; readonly reason: 'invalid-input' | 'secret-shaped' | 'unknown-fact' };

/**
 * A present `evidence` key must carry a non-empty string: an own
 * `evidence: undefined` is a present key with no value, not an absent one.
 * Cost: linear in `MAX_ATTESTATION_EVIDENCE_LENGTH`.
 */
function readOptionalEvidence(snapshot: Record<string, unknown>): OptionalCommandFieldRead {
  if (!Object.hasOwn(snapshot, 'evidence')) {
    return { ok: true, value: undefined };
  }
  const read = readBoundedCommandText(snapshot['evidence'], MAX_ATTESTATION_EVIDENCE_LENGTH);
  if (!read.ok) {
    return read;
  }
  return { ok: true, value: read.value };
}

/**
 * Authority is checked for shape here, but a missing or blank value passes
 * through as `''`: the use case owns the `authority-required` refusal, so
 * the CLI can hand the flag through and still get the typed exit-1 refusal
 * rather than a usage error. Cost: linear in `MAX_ATTESTATION_AUTHORITY_LENGTH`.
 */
function readOptionalAuthority(snapshot: Record<string, unknown>): CommandFieldRead {
  if (snapshot['authority'] === undefined) {
    return { ok: true, value: '' };
  }
  return readBoundedCommandText(snapshot['authority'], MAX_ATTESTATION_AUTHORITY_LENGTH);
}

/** A safe non-negative integer within `MAX_REVISION`. Cost: O(1). */
function readExpectedRevision(value: unknown): { readonly ok: true; readonly value: number } | { readonly ok: false } {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > MAX_REVISION
  ) {
    return { ok: false };
  }
  return { ok: true, value };
}

/** A string matching `ATTESTATION_OPERATION_ID_PATTERN`. Cost: O(1). */
function readOperationId(value: unknown): { readonly ok: true; readonly value: string } | { readonly ok: false } {
  if (typeof value !== 'string' || !ATTESTATION_OPERATION_ID_PATTERN.test(value)) {
    return { ok: false };
  }
  return { ok: true, value };
}

/**
 * The optional deadline, validated here so the use case never has to reach
 * back into the raw request object: every field it reads comes from this
 * snapshot, so no getter or Proxy `get` trap can run after parsing. Cost:
 * O(1) beyond the `MAX_ATTESTATION_DEADLINE_LENGTH` bound.
 */
function readDeadlineIso(value: unknown): { readonly ok: true; readonly value: string | undefined } | { readonly ok: false } {
  if (value === undefined) {
    return { ok: true, value: undefined };
  }
  if (
    typeof value !== 'string' ||
    value.length > MAX_ATTESTATION_DEADLINE_LENGTH ||
    !isZonedIsoDateTime(value)
  ) {
    return { ok: false };
  }
  return { ok: true, value };
}

type CommandFieldRead =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly reason: 'invalid-input' | 'secret-shaped' | 'unknown-fact' };

/**
 * The fact id. A non-string value is malformed (`invalid-input`); a string
 * that is not one of `SHADOW_ATTESTATION_FACTS` is `unknown-fact`. Cost: O(1).
 */
function readCommandFact(value: unknown): CommandFieldRead {
  if (typeof value !== 'string') {
    return { ok: false, reason: 'invalid-input' };
  }
  if (factIndex(value) === null) {
    return { ok: false, reason: 'unknown-fact' };
  }
  return { ok: true, value };
}

/** A non-empty string within `cap` that carries no secret shape. Cost: linear in the capped string. */
function readBoundedCommandText(value: unknown, cap: number): CommandFieldRead {
  if (typeof value !== 'string' || value.length === 0 || value.length > cap) {
    return { ok: false, reason: 'invalid-input' };
  }
  if (isSecretShaped(value)) {
    return { ok: false, reason: 'secret-shaped' };
  }
  return { ok: true, value };
}
