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
import { readPlainRecordWithOptionalKeys } from './plain-record-reads.js';
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
  /** Compare-and-set counter: 1 at the intent, plus one per outcome. */
  readonly revision: number;
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
const OPTIONAL_KEYS: readonly string[] = ['schemaVersion'];

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
      }),
    };
  } catch {
    return MALFORMED;
  }
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
