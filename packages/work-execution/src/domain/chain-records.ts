/**
 * The ChainRecord v1 (lane CO7): one record per (repository, chain) that says
 * a chain `chain/<name>` was asked for from `main` at a recorded commit and
 * how that start ended. Versioned from its first commit (Q5b): an absent
 * `schemaVersion` reads as 1, any other present value is refused. Pure: no
 * clock, no hashing, no I/O, no ids minted here; never throws and never echoes
 * an input value, so every reason is a fixed code.
 */

import { containsSecretShape } from '@fleet/shared';
import { parseBaseBranch } from './base-branch.js';
import { isZonedIsoDateTime } from './conductor-halt.js';
import { readExactPlainRecord, readPlainRecordWithOptionalKeys } from './plain-record-reads.js';
import { readRecordSchemaVersion } from './record-schema-version.js';

export const CHAIN_RECORD_SCHEMA_VERSION = 1 as const;

export const CHAIN_RECORD_STATES = ['intent-recorded', 'started', 'refused'] as const;
export type ChainRecordState = (typeof CHAIN_RECORD_STATES)[number];

export interface ChainRepositoryRef {
  readonly owner: string;
  readonly repo: string;
}

export interface ChainRecord {
  readonly schemaVersion: typeof CHAIN_RECORD_SCHEMA_VERSION;
  readonly repository: ChainRepositoryRef;
  /** The bare name, without `chain/`. */
  readonly chainName: string;
  /** `chain/<chainName>`. */
  readonly branchName: string;
  /** The source of the branch; always `main` in v1. */
  readonly sourceBranch: 'main';
  /** 40 lowercase hex: the commit of `main` the chain branch starts at. */
  readonly expectedHeadSha: string;
  /** The keyed intent id: one per chain start. */
  readonly actionKey: string;
  readonly state: ChainRecordState;
  /** A fixed code, never an echoed input; set only when the start was refused. */
  readonly reason: string | null;
  /** Supplied by the caller; never read from a clock. */
  readonly createdAtIso: string;
  /** Compare-and-set counter: 1 at the intent, plus one per outcome or pin. */
  readonly revision: number;
  /**
   * The chain tip the combined pre-merge review was started for (lane CO9).
   * Absent or null: no review was started. Additive: the record stays version 1,
   * and a record stored without it reads as no pin (`reviewPinOf`).
   */
  readonly reviewPin?: ChainReviewPin | null;
  /**
   * The last chain refresh (lane CO8): the keyed intent `chain-refresh/<name>@<main12>`
   * and its outcome. `in-flight` means the intent is recorded and the merge has not
   * completed; the terminal outcomes are `merged`, `up-to-date`, `conflict` and
   * `branch-gone`. Absent or null: no refresh was attempted. Additive: the record
   * stays version 1, and a record stored without it reads as no refresh
   * (`chainRefreshOf`).
   */
  readonly refresh?: ChainRefreshEntry | null;
  /**
   * The landing-blocking mark a conflict sets (lane CO8): `chain-refresh-conflict`
   * or null. A merge never clears it; an outcome of `merged` or `up-to-date` does.
   */
  readonly conflictMark?: typeof CHAIN_REFRESH_CONFLICT_MARK | null;
}

/** The pin the combined review is bound to: one per chain record, never overwritten by another. */
export interface ChainReviewPin {
  /** 40 lowercase hex: the chain tip the review covers. */
  readonly headSha: string;
  /** The review request id, derived from the chain name and the head. */
  readonly requestId: string;
  /** `chain-review/<chainName>@<head12>`. */
  readonly key: string;
  readonly pinnedAtIso: string;
}

/** The terminal refresh outcomes (lane CO8); `in-flight` is the recorded-intent state before one. */
export const CHAIN_REFRESH_TERMINAL_OUTCOMES = ['merged', 'up-to-date', 'conflict', 'branch-gone'] as const;
export type ChainRefreshTerminalOutcome = (typeof CHAIN_REFRESH_TERMINAL_OUTCOMES)[number];
export const CHAIN_REFRESH_OUTCOMES = [...CHAIN_REFRESH_TERMINAL_OUTCOMES, 'in-flight'] as const;
export type ChainRefreshOutcome = (typeof CHAIN_REFRESH_OUTCOMES)[number];

/** The conflict mark a `conflict` refresh outcome sets (blocks landing; lane CO8). */
export const CHAIN_REFRESH_CONFLICT_MARK = 'chain-refresh-conflict' as const;

/** One chain-refresh intent and its outcome: the key, the main head it merged, and how it ended. */
export interface ChainRefreshEntry {
  /** `chain-refresh/<chainName>@<main12>`. */
  readonly key: string;
  /** 40 lowercase hex: the `main` head the refresh merged. */
  readonly mainSha: string;
  readonly outcome: ChainRefreshOutcome;
  readonly updatedAtIso: string;
}

const REVIEW_PIN_REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const REVIEW_PIN_KEYS: readonly string[] = ['headSha', 'requestId', 'key', 'pinnedAtIso'];

/** The review key of a chain at a head: `chain-review/<name>@<head12>`. */
export function chainReviewKeyOf(chainName: string, headSha: string): string {
  return `chain-review/${chainName}@${headSha.slice(0, 12)}`;
}

/** The review request id of a chain at a head: `chain-review:<name>:<head12>`; the pin's requestId must equal it. */
export function chainReviewRequestIdOf(chainName: string, headSha: string): string {
  return `chain-review:${chainName}:${headSha.slice(0, 12)}`;
}

const CHAIN_REFRESH_PREFIX = 'chain-refresh/';
const HEX12_PATTERN = /^[0-9a-f]{12}$/;

/** The refresh key of a chain at a main head: `chain-refresh/<name>@<main12>`; null for invalid inputs. */
export function chainRefreshKey(chainName: string, mainSha: string): string | null {
  if (parseChainName(chainName) === undefined || !isChainCommitSha(mainSha)) {
    return null;
  }
  return `${CHAIN_REFRESH_PREFIX}${chainName}@${mainSha.slice(0, 12)}`;
}

/** True for a keyed chain-refresh intent id `chain-refresh/<name>@<main12>`. */
export function isChainRefreshKey(value: unknown): value is string {
  if (typeof value !== 'string') {
    return false;
  }
  const at = value.lastIndexOf('@');
  if (at <= CHAIN_REFRESH_PREFIX.length || !value.startsWith(CHAIN_REFRESH_PREFIX)) {
    return false;
  }
  const name = value.slice(CHAIN_REFRESH_PREFIX.length, at);
  const sha12 = value.slice(at + 1);
  if (!HEX12_PATTERN.test(sha12)) {
    return false;
  }
  return parseChainName(name) !== undefined;
}

const HEX40_PATTERN = /^[0-9a-f]{40}$/;
const SEGMENT_PATTERN = /^[A-Za-z0-9_.-]{1,100}$/;
const REASON_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const ACTION_KEY_MAX_BYTES = 256;
const CHAIN_NAME_MAX_LENGTH = 200;

/** The bare chain name when `value` is one valid under the CB-D1 pattern; otherwise undefined. */
export function parseChainName(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > CHAIN_NAME_MAX_LENGTH) {
    return undefined;
  }
  if (value.includes('/')) {
    return undefined;
  }
  return parseBaseBranch(`chain/${value}`) === undefined ? undefined : value;
}

/** A 40-lowercase-hex commit id. */
export function isChainCommitSha(value: unknown): value is string {
  return typeof value === 'string' && HEX40_PATTERN.test(value);
}

/** A non-empty keyed-intent id of at most 256 bytes without a secret shape. */
export function isChainActionKey(value: unknown): value is string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > ACTION_KEY_MAX_BYTES) {
    return false;
  }
  if (new TextEncoder().encode(value).byteLength > ACTION_KEY_MAX_BYTES) {
    return false;
  }
  return !containsSecretShape(value);
}

/** A repository reference built from its own data properties only; undefined when invalid. */
export function parseChainRepository(value: unknown): ChainRepositoryRef | undefined {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return undefined;
    }
    const owner = Object.getOwnPropertyDescriptor(value, 'owner')?.value;
    const repo = Object.getOwnPropertyDescriptor(value, 'repo')?.value;
    if (typeof owner !== 'string' || typeof repo !== 'string') {
      return undefined;
    }
    if (!SEGMENT_PATTERN.test(owner) || !SEGMENT_PATTERN.test(repo)) {
      return undefined;
    }
    if (owner === '.' || owner === '..' || repo === '.' || repo === '..') {
      return undefined;
    }
    return Object.freeze({ owner, repo });
  } catch {
    return undefined;
  }
}

/** True for a fixed reason code (lowercase words and dashes). */
export function isChainReasonCode(value: unknown): value is string {
  return typeof value === 'string' && REASON_PATTERN.test(value);
}

export interface CreateChainRecordInput {
  readonly repository: ChainRepositoryRef;
  readonly chainName: string;
  readonly expectedHeadSha: string;
  readonly actionKey: string;
  readonly createdAtIso: string;
}

export type CreateChainRecordFailure =
  | 'invalid-repository'
  | 'invalid-chain-name'
  | 'invalid-expected-head'
  | 'invalid-action-key'
  | 'invalid-created-at';

export type CreateChainRecordResult =
  | { readonly ok: true; readonly record: ChainRecord }
  | { readonly ok: false; readonly reason: CreateChainRecordFailure };

/** A new record in state `intent-recorded`, revision 1; never throws. */
export function createChainRecord(input: CreateChainRecordInput): CreateChainRecordResult {
  try {
    const own = (key: string): unknown =>
      typeof input === 'object' && input !== null ? Object.getOwnPropertyDescriptor(input, key)?.value : undefined;
    const repository = parseChainRepository(own('repository'));
    if (repository === undefined) {
      return { ok: false, reason: 'invalid-repository' };
    }
    const chainName = parseChainName(own('chainName'));
    if (chainName === undefined) {
      return { ok: false, reason: 'invalid-chain-name' };
    }
    const expectedHeadSha = own('expectedHeadSha');
    if (!isChainCommitSha(expectedHeadSha)) {
      return { ok: false, reason: 'invalid-expected-head' };
    }
    const actionKey = own('actionKey');
    if (!isChainActionKey(actionKey)) {
      return { ok: false, reason: 'invalid-action-key' };
    }
    const createdAtIso = own('createdAtIso');
    if (!isZonedIsoDateTime(createdAtIso)) {
      return { ok: false, reason: 'invalid-created-at' };
    }
    return {
      ok: true,
      record: Object.freeze({
        schemaVersion: CHAIN_RECORD_SCHEMA_VERSION,
        repository,
        chainName,
        branchName: `chain/${chainName}`,
        sourceBranch: 'main' as const,
        expectedHeadSha,
        actionKey,
        state: 'intent-recorded' as const,
        reason: null,
        createdAtIso,
        revision: 1,
        refresh: null,
        conflictMark: null,
      }),
    };
  } catch {
    return { ok: false, reason: 'invalid-chain-name' };
  }
}

const REQUIRED_KEYS: readonly string[] = [
  'repository', 'chainName', 'branchName', 'sourceBranch', 'expectedHeadSha', 'actionKey', 'state',
  'reason', 'createdAtIso', 'revision',
];
const OPTIONAL_KEYS: readonly string[] = ['schemaVersion', 'reviewPin', 'refresh', 'conflictMark'];

export type ChainRecordReadResult =
  | { readonly ok: true; readonly record: ChainRecord }
  | { readonly ok: false; readonly reason: 'unknown-schema-version' | 'malformed' };

const MALFORMED: ChainRecordReadResult = { ok: false, reason: 'malformed' };

/** Decode a stored record; an absent `schemaVersion` reads as 1; never throws, never runs a getter. */
export function readChainRecord(input: unknown): ChainRecordReadResult {
  try {
    const version = readRecordSchemaVersion(input, CHAIN_RECORD_SCHEMA_VERSION);
    if (!version.ok) {
      return version.reason === 'unknown-schema-version' ? version : MALFORMED;
    }
    const snapshot = readPlainRecordWithOptionalKeys(input, REQUIRED_KEYS, OPTIONAL_KEYS);
    if (snapshot === null) {
      return MALFORMED;
    }
    const repository = parseChainRepository(snapshot.repository);
    const chainName = parseChainName(snapshot.chainName);
    if (repository === undefined || chainName === undefined) {
      return MALFORMED;
    }
    const { branchName, sourceBranch, expectedHeadSha, actionKey, state, reason, createdAtIso, revision } = snapshot;
    if (branchName !== `chain/${chainName}` || sourceBranch !== 'main') {
      return MALFORMED;
    }
    if (!isChainCommitSha(expectedHeadSha) || !isChainActionKey(actionKey) || !isZonedIsoDateTime(createdAtIso)) {
      return MALFORMED;
    }
    if (!CHAIN_RECORD_STATES.includes(state as ChainRecordState)) {
      return MALFORMED;
    }
    if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 1) {
      return MALFORMED;
    }
    const refused = state === 'refused';
    if (refused ? !isChainReasonCode(reason) : reason !== null) {
      return MALFORMED;
    }
    const reviewPin = readChainReviewPin(snapshot.reviewPin, chainName);
    if (reviewPin === undefined) {
      return MALFORMED;
    }
    const refresh = readChainRefresh(snapshot.refresh, chainName);
    if (refresh === undefined) {
      return MALFORMED;
    }
    const conflictMark = readConflictMark(snapshot.conflictMark);
    if (conflictMark === undefined) {
      return MALFORMED;
    }
    return {
      ok: true,
      record: Object.freeze({
        schemaVersion: CHAIN_RECORD_SCHEMA_VERSION,
        repository,
        chainName,
        branchName,
        sourceBranch: 'main' as const,
        expectedHeadSha,
        actionKey,
        state: state as ChainRecordState,
        reason: reason as string | null,
        createdAtIso,
        revision,
        // Omitted when there is no pin, so a record stored without one reads exactly as before.
        ...(reviewPin === null ? {} : { reviewPin }),
        // The refresh fields are always emitted: the writer always stores both (lane CO8).
        refresh: refresh === null ? null : refresh,
        conflictMark: conflictMark === null ? null : conflictMark,
      }),
    };
  } catch {
    return MALFORMED;
  }
}

/**
 * A stored review pin: null when absent (or stored as null), the frozen pin when
 * well formed for this chain, undefined when present but malformed. The key must
 * be exactly the one the chain name and head give.
 */
function readChainReviewPin(value: unknown, chainName: string): ChainReviewPin | null | undefined {
  if (value === undefined || value === null) {
    return null;
  }
  const snapshot = readExactPlainRecord(value, REVIEW_PIN_KEYS);
  if (snapshot === null) {
    return undefined;
  }
  const { headSha, requestId, key, pinnedAtIso } = snapshot;
  if (
    !isChainCommitSha(headSha) ||
    typeof requestId !== 'string' ||
    !REVIEW_PIN_REQUEST_ID_PATTERN.test(requestId) ||
    requestId !== chainReviewRequestIdOf(chainName, headSha) ||
    key !== chainReviewKeyOf(chainName, headSha) ||
    !isChainActionKey(key) ||
    !isZonedIsoDateTime(pinnedAtIso)
  ) {
    return undefined;
  }
  return Object.freeze({ headSha, requestId, key, pinnedAtIso });
}

const REFRESH_KEYS: readonly string[] = ['key', 'mainSha', 'outcome', 'updatedAtIso'];

/**
 * A stored refresh entry: null when absent (or stored as null), the frozen entry
 * when well formed for this chain, undefined when present but malformed. The key
 * must be exactly the one the chain name and main head give.
 */
function readChainRefresh(value: unknown, chainName: string): ChainRefreshEntry | null | undefined {
  if (value === undefined || value === null) {
    return null;
  }
  const snapshot = readExactPlainRecord(value, REFRESH_KEYS);
  if (snapshot === null) {
    return undefined;
  }
  const { key, mainSha: storedSha, outcome, updatedAtIso } = snapshot;
  if (typeof storedSha !== 'string' || !isChainCommitSha(storedSha)) {
    return undefined;
  }
  if (
    key !== chainRefreshKey(chainName, storedSha) ||
    !CHAIN_REFRESH_OUTCOMES.includes(outcome as ChainRefreshOutcome) ||
    !isZonedIsoDateTime(updatedAtIso)
  ) {
    return undefined;
  }
  return Object.freeze({
    key: key as string,
    mainSha: storedSha,
    outcome: outcome as ChainRefreshOutcome,
    updatedAtIso: updatedAtIso as string,
  });
}

/** A stored conflict mark: null when absent (or stored as null), the mark when exact, undefined when malformed. */
function readConflictMark(value: unknown): typeof CHAIN_REFRESH_CONFLICT_MARK | null | undefined {
  if (value === undefined || value === null) {
    return null;
  }
  return value === CHAIN_REFRESH_CONFLICT_MARK ? CHAIN_REFRESH_CONFLICT_MARK : undefined;
}

/** The record's review pin; a record without one (every CO7 record) has none. */
export function reviewPinOf(record: ChainRecord): ChainReviewPin | null {
  return record.reviewPin ?? null;
}

/**
 * The record with its review pin set (pinned at `atIso`) and revision advanced
 * by one; the pin is not validated here, `readChainRecord` is the gate.
 */
export function applyChainReviewPin(record: ChainRecord, pin: ChainReviewPin, atIso: string): ChainRecord {
  return Object.freeze({
    ...record,
    reviewPin: Object.freeze({ headSha: pin.headSha, requestId: pin.requestId, key: pin.key, pinnedAtIso: atIso }),
    revision: record.revision + 1,
  });
}

/** The record's refresh entry; a record without one (every CO7 record) has none. */
export function chainRefreshOf(record: ChainRecord): ChainRefreshEntry | null {
  return record.refresh ?? null;
}

/** The record's conflict mark; a record without one (every CO7 record) has none. */
export function conflictMarkOf(record: ChainRecord): typeof CHAIN_REFRESH_CONFLICT_MARK | null {
  return record.conflictMark ?? null;
}

/**
 * The record with its refresh intent recorded (`in-flight` under the key at the
 * main head) and revision advanced by one; the conflict mark is untouched.
 * Never throws; never echoes an input value.
 */
export function applyChainRefreshIntent(
  record: ChainRecord,
  intent: { readonly key: string; readonly mainSha: string; readonly atIso: string },
): ChainRecord {
  return Object.freeze({
    ...record,
    refresh: Object.freeze({
      key: intent.key,
      mainSha: intent.mainSha,
      outcome: 'in-flight' as const,
      updatedAtIso: intent.atIso,
    }),
    conflictMark: record.conflictMark ?? null,
    revision: record.revision + 1,
  });
}

/**
 * The record with its refresh outcome recorded and revision advanced by one:
 * `conflict` sets the conflict mark, `merged` and `up-to-date` clear it, and
 * `branch-gone` leaves it unchanged. Never throws; never echoes an input value.
 */
export function applyChainRefreshOutcome(
  record: ChainRecord,
  outcome: ChainRefreshTerminalOutcome,
  atIso: string,
): ChainRecord {
  const prior = record.refresh ?? null;
  const conflictMark =
    outcome === 'conflict'
      ? CHAIN_REFRESH_CONFLICT_MARK
      : outcome === 'branch-gone'
        ? (record.conflictMark ?? null)
        : null;
  return Object.freeze({
    ...record,
    refresh: Object.freeze({
      key: prior?.key ?? '',
      mainSha: prior?.mainSha ?? '',
      outcome,
      updatedAtIso: atIso,
    }),
    conflictMark,
    revision: record.revision + 1,
  });
}

/** The record after its outcome: state and reason set, revision advanced by one. */
export function applyChainOutcome(
  record: ChainRecord,
  outcome: { readonly state: 'started' | 'refused'; readonly reason: string | null },
): ChainRecord {
  return Object.freeze({
    ...record,
    state: outcome.state,
    reason: outcome.state === 'started' ? null : outcome.reason,
    revision: record.revision + 1,
  });
}

export type ChainBranchObservation =
  | { readonly kind: 'branch-found'; readonly headSha: string }
  | { readonly kind: 'branch-absent' }
  | { readonly kind: 'unavailable' };

export interface ChainStartVerdict {
  readonly state: 'started' | 'refused' | 'unknown';
  readonly reason: string | null;
}

/**
 * The one rule that turns an observed branch into a verdict. A branch at the
 * expected commit is started; at another commit it refuses; an absent or
 * unreadable branch, or a head that is not a commit id, is unknown, never a guess.
 */
export function decideChainStart(observed: ChainBranchObservation, expectedHeadSha: string): ChainStartVerdict {
  const unknown: ChainStartVerdict = { state: 'unknown', reason: 'unresolved' };
  try {
    if (observed.kind !== 'branch-found' || !isChainCommitSha(expectedHeadSha)) {
      return unknown;
    }
    if (!isChainCommitSha(observed.headSha)) {
      return unknown;
    }
    if (observed.headSha === expectedHeadSha) {
      return { state: 'started', reason: null };
    }
    return { state: 'refused', reason: 'branch-exists-at-other-commit' };
  } catch {
    return unknown;
  }
}
