/**
 * FC8H: pure seal-then-gate receipt minting and the attempt-token append
 * scope guard.
 *
 * `mintGateReceiptFromVmExit` mints a verification receipt HOST-SIDE from a
 * host-side VM exit observation verified against an independent host-side
 * freshness and seal source. It never trusts a caller-controlled `fresh`
 * boolean (any `fresh` key is refused as an unexpected key) and never trusts
 * anything the attempt itself reported: freshness, identity binding and the
 * seal nonce all come from the host-owned source, and an already-consumed VM
 * can never mint again.
 *
 * `authorizeAttemptTokenAppend` proves the negative scope guards: an
 * attempt-scoped token can never append a verification receipt, a usage row
 * or an authorization grant, whatever its scopes claim; the one allowed
 * attempt-scoped target is `candidate-note`.
 *
 * Domain-only: no Node builtins, no clock, no randomness, no I/O, no
 * `console`. Hostile inputs are read exactly once per parameter through the
 * shared `snapshotPlainData` (one pass, zero Proxy traps, zero getters),
 * bounded by this unit's own exported limits, so no getter and no Proxy
 * `get` trap ever runs. No rejected input value is ever echoed into a
 * refusal, an error or a log: every refusal reason is a fixed constant.
 */

import {
  containsSecretShape,
  snapshotPlainData,
  type IsProxy,
  type PlainDataLimits,
} from '@fleet/shared';

import type {
  AttemptEnvironmentState,
} from './attempt-environment.js';

/**
 * Snapshot bounds for the host-side VM exit observation: 1 root object + 5
 * flat string/number fields = 6 nodes <= 16; no array may appear
 * (`maxArrayLength: 0`), fields are flat (`maxDepth: 2` covers the root plus
 * its fields), and no field string exceeds 256 characters.
 */
export const VM_OBSERVATION_LIMITS: PlainDataLimits = Object.freeze({
  maxDepth: 2,
  maxKeys: 8,
  maxArrayLength: 0,
  maxNodes: 16,
  maxStringLength: 256,
});

/**
 * Snapshot bounds for the host-side freshness and seal source: 1 root + 4
 * fields + 1 environmentState + 5 of its fields + 1 consumedVmIds array +
 * at most 64 entries = 76 nodes <= 128; arrays are bounded by
 * `maxArrayLength: 64`, and the deepest values sit two levels under the root
 * (`maxDepth: 3`).
 */
export const FRESHNESS_SOURCE_LIMITS: PlainDataLimits = Object.freeze({
  maxDepth: 3,
  maxKeys: 8,
  maxArrayLength: 64,
  maxNodes: 128,
  maxStringLength: 512,
});

/**
 * Snapshot bounds for an attempt-scoped token: 1 root + 4 fields + 1 scopes
 * array + at most 16 entries = 22 nodes <= 64; scopes are bounded by
 * `maxArrayLength: 16` and no string exceeds 256 characters.
 */
export const ATTEMPT_TOKEN_LIMITS: PlainDataLimits = Object.freeze({
  maxDepth: 3,
  maxKeys: 8,
  maxArrayLength: 16,
  maxNodes: 64,
  maxStringLength: 256,
});

/** The host-side observation of one sealed VM's gate exit.
 *
 * There is NO `fresh` boolean field on this type and none is accepted at
 * runtime: any caller supplying a `fresh` key (or any other attempt-reported
 * field) is refused with `'invalid-input'` as an unexpected key. Freshness is
 * proven against the host-owned source, never asserted by the caller.
 */
export interface HostVmExitObservation {
  readonly vmId: string;
  readonly attemptId: string;
  readonly sealedDigest: string;
  readonly gateExit: number;
  readonly sealNonce: string;
}

/** The independent host-side freshness and seal source the observation is
 * verified against. Everything here is host-owned state: the sealed
 * environment record, the expected sealed digest and the host's current seal
 * nonce, plus the VM ids already consumed (replayed) on the host.
 */
export interface HostVmFreshnessSource {
  readonly environmentState: AttemptEnvironmentState;
  readonly expectedSealedDigest: string;
  readonly expectedSealNonce: string;
  readonly consumedVmIds: readonly string[];
}

/** The receipt's result: the two passing/failing values of
 * `EvidenceResultValue` (`packages/evidence-and-acceptance`), inlined as a
 * literal union because the domain layer may not import across bounded
 * contexts (`hexagen arch validate`). It stays equal to
 * `Extract<EvidenceResultValue, 'pass' | 'fail'>`.
 */
export type MintedGateReceiptResultValue = 'pass' | 'fail';

/** A minted verification receipt: bound to the attempt, the VM, the sealed
 * tree digest and the observed gate exit, always host-authoritative.
 */
export interface MintedVmGateReceipt {
  readonly attemptId: string;
  readonly vmId: string;
  readonly sealedDigest: string;
  readonly exitCode: number;
  readonly result: MintedGateReceiptResultValue;
  readonly source: 'fresh-vm-exit';
  readonly authoritative: true;
}

/** Every typed refusal reason the mint can return. */
export type MintGateReceiptRefusalReason =
  | 'invalid-input'
  | 'invalid-vm-id'
  | 'invalid-attempt-id'
  | 'invalid-sealed-digest'
  | 'invalid-gate-exit'
  | 'invalid-seal-nonce'
  | 'invalid-freshness-source'
  | 'vm-not-sealed'
  | 'stale-vm'
  | 'vm-identity-mismatch'
  | 'digest-mismatch';

/** Typed outcome: a minted receipt, or a fixed refusal reason that echoes no input. */
export type MintGateReceiptResult =
  | { readonly ok: true; readonly receipt: MintedVmGateReceipt }
  | { readonly ok: false; readonly reason: MintGateReceiptRefusalReason };

/** The record kinds an append may name. `receipt` covers
 * `VerificationReceiptRecord`, `usage-row` covers `LaneUsageLogRow`, `grant`
 * covers `AuthorizedActionKind` / `ForgeCredentialPermission`, and
 * `candidate-note` is the one allowed attempt-scoped target.
 */
export type RecordAppendKind = 'receipt' | 'usage-row' | 'grant' | 'candidate-note';

export const RECORD_APPEND_KINDS: readonly RecordAppendKind[] = Object.freeze([
  'receipt',
  'usage-row',
  'grant',
  'candidate-note',
] as const);

const RECORD_APPEND_KIND_SET: ReadonlySet<string> = new Set(RECORD_APPEND_KINDS);

/** An attempt-scoped token: valid only inside one attempt on one VM. */
export interface AttemptScopedToken {
  readonly kind: 'attempt-scoped';
  readonly attemptId: string;
  readonly vmId: string;
  readonly scopes: readonly string[];
}

/** Every typed refusal reason the append check can return. */
export type AttemptTokenAppendRefusalReason =
  | 'invalid-input'
  | 'attempt-token-cannot-append-receipt'
  | 'attempt-token-cannot-append-usage-row'
  | 'attempt-token-cannot-append-grant'
  | 'missing-candidate-note-scope';

/** Typed outcome of the append scope check. */
export type AttemptTokenAppendDecision =
  | {
    readonly ok: true;
    readonly allowed: true;
    readonly targetKind: 'candidate-note';
    readonly attemptId: string;
    readonly vmId: string;
  }
  | { readonly ok: false; readonly reason: AttemptTokenAppendRefusalReason };

const OBSERVATION_REQUIRED_KEYS: readonly string[] = [
  'vmId',
  'attemptId',
  'sealedDigest',
  'gateExit',
  'sealNonce',
];

const OBSERVATION_REQUIRED_KEY_SET: ReadonlySet<string> = new Set(OBSERVATION_REQUIRED_KEYS);

/** Field-specific refusal for a snapshot refusal on (or under) each named field. */
const OBSERVATION_FIELD_REFUSALS: ReadonlyMap<string, MintGateReceiptRefusalReason> = new Map([
  ['vmId', 'invalid-vm-id'],
  ['attemptId', 'invalid-attempt-id'],
  ['sealedDigest', 'invalid-sealed-digest'],
  ['gateExit', 'invalid-gate-exit'],
  ['sealNonce', 'invalid-seal-nonce'],
]);

const OBSERVATION_MISSING_REFUSALS: readonly (readonly [string, MintGateReceiptRefusalReason])[] = [
  ['vmId', 'invalid-vm-id'],
  ['attemptId', 'invalid-attempt-id'],
  ['sealedDigest', 'invalid-sealed-digest'],
  ['gateExit', 'invalid-gate-exit'],
  ['sealNonce', 'invalid-seal-nonce'],
];

const FRESHNESS_REQUIRED_KEYS: ReadonlySet<string> = new Set([
  'environmentState',
  'expectedSealedDigest',
  'expectedSealNonce',
  'consumedVmIds',
]);

const ENVIRONMENT_STATE_REQUIRED_KEYS: ReadonlySet<string> = new Set([
  'status',
  'attemptId',
  'environmentId',
  'isolation',
  'worktreeRef',
]);

const TOKEN_REQUIRED_KEYS: ReadonlySet<string> = new Set(['kind', 'attemptId', 'vmId', 'scopes']);

const POLLUTING_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

const ENVIRONMENT_STATUSES: ReadonlySet<string> = new Set([
  'none',
  'created',
  'loaded',
  'sealed',
  'destroyed',
  'failed',
]);

const ENVIRONMENT_ISOLATIONS: ReadonlySet<string> = new Set(['microvm', 'user-space-kernel']);

const SEALED_STATUS = 'sealed';

const HEX64_PATTERN = /^[0-9a-f]{64}$/;
const BOUNDED_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const MAX_BOUNDED_ID_LENGTH = 128;
const MAX_WORKTREE_REF_LENGTH = 512;
const MAX_CONSUMED_VM_IDS = 64;
const MAX_GATE_EXIT = 255;
const MAX_SCOPES = 16;
const MAX_SCOPE_LENGTH = 64;

/** A fresh refusal per failure path: a shared mutable instance could be
 * reassigned by a caller and poison later refusals.
 */
function refusedMint(reason: MintGateReceiptRefusalReason): MintGateReceiptResult {
  return Object.freeze({ ok: false as const, reason });
}

function refusedTokenAppend(reason: AttemptTokenAppendRefusalReason): AttemptTokenAppendDecision {
  return Object.freeze({ ok: false as const, reason });
}

/** True when the string carries a C0 control character (0x00–0x1f) or DEL (0x7f). */
function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) {
      return true;
    }
  }
  return false;
}

/** True when any `/` or `\` separated path segment is exactly `..`, so the
 * reference climbs out of its worktree root. Callers length-check the string
 * (1..512) first, so this is O(length) bounded by one split over at most 512
 * characters.
 */
function hasParentPathSegment(value: string): boolean {
  return value.split(/[\\/]/).some((segment) => segment === '..');
}

/** A bounded 1..128 id: `[A-Za-z0-9._:-]{1,128}` (which already excludes
 * control characters) that carries no secret shape. O(length).
 */
function isBoundedId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length >= 1 &&
    value.length <= MAX_BOUNDED_ID_LENGTH &&
    BOUNDED_ID_PATTERN.test(value) &&
    !containsSecretShape(value)
  );
}

/**
 * 64 lowercase hex characters. O(64).
 */
function isHex64(value: unknown): value is string {
  return typeof value === 'string' && HEX64_PATTERN.test(value);
}

/** A non-null, non-array object (the snapshot already proved plainness). */
function isPlainNonArrayObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Whether a snapped object carries exactly `required` as its own keys: no
 * polluting key (`__proto__`, `constructor`, `prototype` — the snapshot
 * copies an own `__proto__` key as data, so it is checked here explicitly),
 * no extra key, and therefore no missing required key (key counts are equal
 * and every key is in the required set). O(own keys): one enumeration.
 */
function hasExactKeys(record: Record<string, unknown>, required: ReadonlySet<string>): boolean {
  const keys = Reflect.ownKeys(record);
  if (keys.length !== required.size) {
    return false;
  }
  for (const key of keys) {
    if (typeof key !== 'string' || POLLUTING_KEYS.has(key) || !required.has(key)) {
      return false;
    }
  }
  return true;
}

/**
 * Map a hostObservation snapshot refusal to its typed reason using the FC8H
 * path table: an accessor, Proxy or other refusal on a named field maps to
 * that field's specific reason; a root-level Proxy (`path === null`) or any
 * unlisted path (such as `fresh: NaN`, `fresh: undefined`, a getter on
 * `fresh`, or a prototype-polluting key holding `undefined`) falls back to
 * `'invalid-input'`. A throwing detector (`detector-threw`) is the caller's
 * broken `isProxy`, never a field's fault, and falls back to
 * `'invalid-input'` too. O(1): five fixed prefix comparisons.
 */
function mapObservationSnapshotPath(
  reason: string,
  path: string | null,
): MintGateReceiptRefusalReason {
  if (reason === 'detector-threw') {
    return 'invalid-input';
  }
  if (path !== null) {
    for (const [field, fieldReason] of OBSERVATION_FIELD_REFUSALS) {
      if (path === field || path.startsWith(`${field}.`)) {
        return fieldReason;
      }
    }
  }
  return 'invalid-input';
}

/**
 * Validate one host observation field that must be a bounded 1..128 id with
 * no secret shape; the caller supplies the field's own refusal reason so the
 * mapping stays in one table.
 */
function refuseUnlessBoundedId(
  value: unknown,
  reason: MintGateReceiptRefusalReason,
): MintGateReceiptRefusalReason | null {
  return isBoundedId(value) ? null : reason;
}

/**
 * Pure, synchronous, deterministic mint of a host-side verification receipt.
 * `isProxy` is a required positional detector (production:
 * `types.isProxy` from `node:util`); it is never a field of an options
 * object, and the snapshot refuses function values.
 *
 * Cost bound: O(own keys) over the `VM_OBSERVATION_LIMITS`-bounded
 * observation (6 nodes, 5 keys) and the `FRESHNESS_SOURCE_LIMITS`-bounded
 * freshness source (76 nodes, at most 64 consumed ids), one snapshot pass
 * per parameter, then O(1) comparisons — never a getter, never a Proxy
 * trap. Never throws and never echoes a rejected input value.
 */
export function mintGateReceiptFromVmExit(
  hostObservation: unknown,
  freshnessSource: unknown,
  isProxy: IsProxy,
): MintGateReceiptResult {
  // A revoked or lying Proxy that throws anywhere along the read path is
  // mapped to the typed refusal of the parameter being read; a Proxy that
  // lies consistently in every trap is the accepted residual.
  let stage: 'observation' | 'freshness' = 'observation';
  try {
    // ---- hostObservation: one bounded snapshot, then pure checks ----
    const observationSnap = snapshotPlainData(hostObservation, isProxy, VM_OBSERVATION_LIMITS);
    if (!observationSnap.ok) {
      return refusedMint(mapObservationSnapshotPath(observationSnap.reason, observationSnap.path));
    }
    const observation = observationSnap.value;
    if (!isPlainNonArrayObject(observation)) {
      return refusedMint('invalid-input');
    }
    // One enumeration: a polluting key, an unexpected key (including `fresh`
    // or any attempt-reported field) is 'invalid-input'; a missing required
    // key carries its field-specific reason.
    for (const key of Reflect.ownKeys(observation)) {
      if (typeof key !== 'string' || POLLUTING_KEYS.has(key) || !OBSERVATION_REQUIRED_KEY_SET.has(key)) {
        return refusedMint('invalid-input');
      }
    }
    for (const [field, reason] of OBSERVATION_MISSING_REFUSALS) {
      if (!Object.hasOwn(observation, field)) {
        return refusedMint(reason);
      }
    }
    const sealedDigest = observation['sealedDigest'];
    if (!isHex64(sealedDigest)) {
      return refusedMint('invalid-sealed-digest');
    }
    const vmIdRefusal = refuseUnlessBoundedId(observation['vmId'], 'invalid-vm-id');
    if (vmIdRefusal !== null) {
      return refusedMint(vmIdRefusal);
    }
    const attemptIdRefusal = refuseUnlessBoundedId(observation['attemptId'], 'invalid-attempt-id');
    if (attemptIdRefusal !== null) {
      return refusedMint(attemptIdRefusal);
    }
    const sealNonceRefusal = refuseUnlessBoundedId(observation['sealNonce'], 'invalid-seal-nonce');
    if (sealNonceRefusal !== null) {
      return refusedMint(sealNonceRefusal);
    }
    const vmId = observation['vmId'] as string;
    const attemptId = observation['attemptId'] as string;
    const sealNonce = observation['sealNonce'] as string;
    const gateExit = observation['gateExit'];
    if (
      typeof gateExit !== 'number' ||
      !Number.isSafeInteger(gateExit) ||
      Object.is(gateExit, -0) ||
      gateExit < 0 ||
      gateExit > MAX_GATE_EXIT
    ) {
      return refusedMint('invalid-gate-exit');
    }

    // ---- freshnessSource: one bounded snapshot, then pure checks ----
    stage = 'freshness';
    const freshnessSnap = snapshotPlainData(freshnessSource, isProxy, FRESHNESS_SOURCE_LIMITS);
    if (!freshnessSnap.ok) {
      // Any refusal on any path (root, nested, or an unlisted fallback such
      // as `fresh: NaN`) is the same refusal: the source is unusable.
      return refusedMint('invalid-freshness-source');
    }
    const freshness = freshnessSnap.value;
    if (!isPlainNonArrayObject(freshness) || !hasExactKeys(freshness, FRESHNESS_REQUIRED_KEYS)) {
      return refusedMint('invalid-freshness-source');
    }
    const environmentState = freshness['environmentState'];
    if (
      !isPlainNonArrayObject(environmentState) ||
      !hasExactKeys(environmentState, ENVIRONMENT_STATE_REQUIRED_KEYS)
    ) {
      return refusedMint('invalid-freshness-source');
    }
    const status = environmentState['status'];
    if (typeof status !== 'string' || !ENVIRONMENT_STATUSES.has(status)) {
      return refusedMint('invalid-freshness-source');
    }
    // Fail closed: only a sealed environment ever mints a receipt.
    if (status !== SEALED_STATUS) {
      return refusedMint('vm-not-sealed');
    }
    const isolation = environmentState['isolation'];
    if (typeof isolation !== 'string' || !ENVIRONMENT_ISOLATIONS.has(isolation)) {
      return refusedMint('invalid-freshness-source');
    }
    const worktreeRef = environmentState['worktreeRef'];
    if (
      typeof worktreeRef !== 'string' ||
      worktreeRef.length < 1 ||
      worktreeRef.length > MAX_WORKTREE_REF_LENGTH ||
      hasControlCharacter(worktreeRef) ||
      containsSecretShape(worktreeRef) ||
      // A worktree reference is relative: an absolute host path (POSIX root,
      // a backslash root or a drive letter) or a `..` path segment would let
      // malformed host state escape the worktree, so both fail closed.
      /^(?:[\\/]|[A-Za-z]:)/.test(worktreeRef) ||
      hasParentPathSegment(worktreeRef)
    ) {
      return refusedMint('invalid-freshness-source');
    }
    if (!isBoundedId(environmentState['attemptId']) || !isBoundedId(environmentState['environmentId'])) {
      return refusedMint('invalid-freshness-source');
    }
    if (!isHex64(freshness['expectedSealedDigest'])) {
      return refusedMint('invalid-freshness-source');
    }
    if (!isBoundedId(freshness['expectedSealNonce'])) {
      return refusedMint('invalid-freshness-source');
    }
    const consumedVmIds = freshness['consumedVmIds'];
    if (!Array.isArray(consumedVmIds) || consumedVmIds.length > MAX_CONSUMED_VM_IDS) {
      return refusedMint('invalid-freshness-source');
    }
    for (const entry of consumedVmIds) {
      if (!isBoundedId(entry)) {
        return refusedMint('invalid-freshness-source');
      }
    }

    // ---- host-side freshness and binding invariants, in order ----
    // 1. The observed VM and attempt must be the sealed environment's own.
    if (environmentState['environmentId'] !== vmId || environmentState['attemptId'] !== attemptId) {
      return refusedMint('vm-identity-mismatch');
    }
    // 2. A previously consumed (replayed) VM can never mint again.
    if (consumedVmIds.includes(vmId)) {
      return refusedMint('stale-vm');
    }
    // 3. A stale or fabricated observation without the host's current seal
    //    nonce is refused as stale too.
    if (sealNonce !== freshness['expectedSealNonce']) {
      return refusedMint('stale-vm');
    }
    // 4. The observed sealed digest must match the host's expectation.
    if (sealedDigest !== freshness['expectedSealedDigest']) {
      return refusedMint('digest-mismatch');
    }

    const result: MintedGateReceiptResultValue = gateExit === 0 ? 'pass' : 'fail';
    return Object.freeze({
      ok: true as const,
      receipt: Object.freeze({
        attemptId,
        vmId,
        sealedDigest,
        exitCode: gateExit,
        result,
        source: 'fresh-vm-exit',
        authoritative: true,
      }),
    });
  } catch {
    return refusedMint(stage === 'observation' ? 'invalid-input' : 'invalid-freshness-source');
  }
}

/**
 * A valid scope entry: a bounded non-empty string with no control character
 * and no secret shape. Scope entries are names, not authorities: whatever
 * they claim, the append decision below is made by the target kind, never by
 * the scopes (so forged `'receipt'`, `'*'` or grant/permission values can
 * never widen an attempt-scoped token). O(length).
 */
function isValidScopeEntry(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length >= 1 &&
    value.length <= MAX_SCOPE_LENGTH &&
    !hasControlCharacter(value) &&
    !containsSecretShape(value)
  );
}

/**
 * Pure, synchronous, deterministic negative scope guard for appending a
 * record with an attempt-scoped token. `targetKind` is validated first, then
 * `token` is read exactly once through `snapshotPlainData` bounded by
 * `ATTEMPT_TOKEN_LIMITS`.
 *
 * Cost bound: O(own keys) over the `ATTEMPT_TOKEN_LIMITS`-bounded token
 * (22 nodes, at most 16 scopes) plus one linear scan of the bounded scopes
 * array; never a getter, never a Proxy trap. Never throws and never echoes a
 * rejected input value.
 */
export function authorizeAttemptTokenAppend(
  token: unknown,
  targetKind: unknown,
  isProxy: IsProxy,
): AttemptTokenAppendDecision {
  if (typeof targetKind !== 'string' || !RECORD_APPEND_KIND_SET.has(targetKind)) {
    return refusedTokenAppend('invalid-input');
  }
  try {
    const tokenSnap = snapshotPlainData(token, isProxy, ATTEMPT_TOKEN_LIMITS);
    if (!tokenSnap.ok) {
      // Any refusal on any path is the same refusal: the token is unusable.
      return refusedTokenAppend('invalid-input');
    }
    const value = tokenSnap.value;
    if (!isPlainNonArrayObject(value) || !hasExactKeys(value, TOKEN_REQUIRED_KEYS)) {
      return refusedTokenAppend('invalid-input');
    }
    if (value['kind'] !== 'attempt-scoped') {
      return refusedTokenAppend('invalid-input');
    }
    if (!isBoundedId(value['attemptId']) || !isBoundedId(value['vmId'])) {
      return refusedTokenAppend('invalid-input');
    }
    const scopes = value['scopes'];
    if (!Array.isArray(scopes) || scopes.length > MAX_SCOPES) {
      return refusedTokenAppend('invalid-input');
    }
    for (const scope of scopes) {
      if (!isValidScopeEntry(scope)) {
        return refusedTokenAppend('invalid-input');
      }
    }
    // The negative scope guard: an attempt-scoped token can never append a
    // verification receipt, a usage row or an authorization grant, whatever
    // its scopes claim (forged `'receipt'`, `'usage-row'`, `'grant'`, `'*'`,
    // `AuthorizedActionKind` or `ForgeCredentialPermission` values included).
    if (targetKind === 'receipt') {
      return refusedTokenAppend('attempt-token-cannot-append-receipt');
    }
    if (targetKind === 'usage-row') {
      return refusedTokenAppend('attempt-token-cannot-append-usage-row');
    }
    if (targetKind === 'grant') {
      return refusedTokenAppend('attempt-token-cannot-append-grant');
    }
    // The one allowed attempt-scoped target, gated on the scope being present.
    const attemptId = value['attemptId'] as string;
    const vmId = value['vmId'] as string;
    if (scopes.includes('candidate-note')) {
      return Object.freeze({
        ok: true as const,
        allowed: true as const,
        targetKind: 'candidate-note' as const,
        attemptId,
        vmId,
      });
    }
    return refusedTokenAppend('missing-candidate-note-scope');
  } catch {
    // A revoked or lying Proxy that throws anywhere along the read path is
    // mapped to the typed refusal; a Proxy that lies consistently in every
    // trap is the accepted residual.
    return refusedTokenAppend('invalid-input');
  }
}
