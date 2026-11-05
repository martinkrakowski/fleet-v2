/**
 * Pure records for the warm worktree pool (KS4a, D35). No clock, no I/O, no
 * id minting from a random source: ids are deterministic strings.
 */

import { readRecordSchemaVersion } from './record-schema-version.js';
import { readExactPlainRecord } from './plain-record-reads.js';

export const WORKTREE_POOL_ENTRY_SCHEMA_VERSION = 1 as const;

export type WorktreePoolEntryState = 'warm' | 'taken';

/** One warm or taken worktree of a project's pool, versioned from its first commit. */
export interface WorktreePoolEntryRecord {
  readonly schemaVersion: 1;
  /** Deterministic id, e.g. `<projectId>#<n>`. */
  readonly entryId: string;
  readonly projectId: string;
  /** Absolute path of the warm worktree. */
  readonly worktreePath: string;
  /** 40 lowercase hex: the commit the worktree sits at. */
  readonly baseCommit: string;
  readonly state: WorktreePoolEntryState;
  /** Null while the entry is warm. */
  readonly takenByRunId: string | null;
  /** Bumped on every change; no clock. */
  readonly revision: number;
}

export type WorktreePoolEntryRead =
  | { readonly ok: true; readonly record: WorktreePoolEntryRecord }
  | {
      readonly ok: false;
      readonly reason: 'unknown-schema-version' | 'malformed';
      readonly error: string;
    };

const ENTRY_KEYS: readonly string[] = [
  'schemaVersion', 'entryId', 'projectId', 'worktreePath', 'baseCommit', 'state',
  'takenByRunId', 'revision',
];

const LEGACY_ENTRY_KEYS: readonly string[] = ENTRY_KEYS.filter((key) => key !== 'schemaVersion');

const MAX_FIELD_BYTES = 256;
const FIELD_ENCODER = new TextEncoder();

function byteLength(value: string): number {
  return FIELD_ENCODER.encode(value).byteLength;
}

/** 40 lowercase hex: a git object id the pool works at. */
export function isWorktreePoolBaseCommit(value: unknown): boolean {
  return typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);
}

export function isWorktreePoolEntryState(value: unknown): value is WorktreePoolEntryState {
  return value === 'warm' || value === 'taken';
}

function refusal(reason: 'unknown-schema-version' | 'malformed', error: string): WorktreePoolEntryRead {
  return { ok: false, reason, error };
}

/** A non-empty trimmed string within the byte budget the record accepts. */
function isShortString(value: unknown): value is string {
  if (typeof value !== 'string') {
    return false;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length !== value.length) {
    return false;
  }
  return byteLength(value) <= MAX_FIELD_BYTES;
}

function isAbsolutePosixPath(value: unknown): value is string {
  if (typeof value !== 'string' || !value.startsWith('/') || value.includes('\\') || value.includes('\0')) {
    return false;
  }
  return isShortString(value);
}

/** An id string is any short non-empty trimmed string (run ids are minted by callers). */
function isRunIdValue(value: unknown): boolean {
  return value === null || isShortString(value);
}

function readValidatedSnapshot(snapshot: Record<string, unknown>): WorktreePoolEntryRead {
  if (!isShortString(snapshot.entryId)) {
    return refusal('malformed', 'WorktreePoolEntry entryId must be a short non-empty trimmed string');
  }
  if (!isShortString(snapshot.projectId)) {
    return refusal('malformed', 'WorktreePoolEntry projectId must be a short non-empty trimmed string');
  }
  if (!isAbsolutePosixPath(snapshot.worktreePath)) {
    return refusal('malformed', 'WorktreePoolEntry worktreePath must be an absolute posix path');
  }
  if (!isWorktreePoolBaseCommit(snapshot.baseCommit)) {
    return refusal('malformed', 'WorktreePoolEntry baseCommit must be 40 lowercase hex');
  }
  if (!isWorktreePoolEntryState(snapshot.state)) {
    return refusal('malformed', 'WorktreePoolEntry state must be warm or taken');
  }
  if (!isRunIdValue(snapshot.takenByRunId)) {
    return refusal('malformed', 'WorktreePoolEntry takenByRunId must be null or an id string');
  }
  if (snapshot.state === 'warm' && snapshot.takenByRunId !== null) {
    return refusal('malformed', 'WorktreePoolEntry warm entries must not name a run');
  }
  const revision = snapshot.revision;
  if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0) {
    return refusal('malformed', 'WorktreePoolEntry revision must be a non-negative safe integer');
  }
  return {
    ok: true,
    record: Object.freeze({
      schemaVersion: 1,
      entryId: snapshot.entryId,
      projectId: snapshot.projectId,
      worktreePath: snapshot.worktreePath,
      baseCommit: snapshot.baseCommit as string,
      state: snapshot.state,
      takenByRunId: snapshot.takenByRunId as string | null,
      revision,
    }),
  };
}

/**
 * Read and validate one pool entry record without invoking any getter.
 * An absent `schemaVersion` reads as 1; a present value outside the accepted
 * window is refused as `unknown-schema-version`. Never throws.
 */
export function readWorktreePoolEntryRecord(input: unknown): WorktreePoolEntryRead {
  try {
    const version = readRecordSchemaVersion(input, WORKTREE_POOL_ENTRY_SCHEMA_VERSION);
    if (!version.ok) {
      return refusal(version.reason, 'WorktreePoolEntry schemaVersion is not accepted');
    }
    const keys = version.explicit ? ENTRY_KEYS : LEGACY_ENTRY_KEYS;
    const snapshot = readExactPlainRecord(input, keys);
    if (snapshot === null) {
      return refusal('malformed', 'WorktreePoolEntry must have exactly the v1 entry keys');
    }
    if (!version.explicit) {
      snapshot.schemaVersion = WORKTREE_POOL_ENTRY_SCHEMA_VERSION;
    }
    return readValidatedSnapshot(snapshot);
  } catch {
    return refusal('malformed', 'WorktreePoolEntry input could not be read');
  }
}
