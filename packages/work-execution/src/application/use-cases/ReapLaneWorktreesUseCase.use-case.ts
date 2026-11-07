// @generated use-case scaffold — refined for EX-2b, reworked for C2'.
/**
 * ReapLaneWorktreesUseCase: on the operator's explicit request, list or
 * remove the clean worktree of every finished lane run. A candidate is a run
 * whose journal state is `merged` or `stopped`, whose work order is `merged`
 * or `stopped`, whose every attempt is `cancelled` or `collected`, and none
 * of whose attempts holds a reservation. Anything else is skipped with a
 * reason and never touched.
 *
 * C2': removal goes through `WorkspacePort.inspectWorktreeForRemoval` and
 * `WorkspacePort.removeWorktree`, one run at a time — destructive writes,
 * never parallel. `removeWorktree` is gated on the attempt's sealed artifact
 * manifest: an uncollected or tampered worktree is refused unless the
 * operator passes `forceUnsealed`, and even then the removal consumes a
 * scoped, one-way owner approval (`ActionAuthorizationPort`) and still runs
 * every clean, unlocked, in-progress and bounded-activity check inside the
 * adapter. The branch `fleet/<runId>` is the record of the run and is kept:
 * no branch command is ever issued. A dry run calls no removal and reports
 * the candidates as `removed` with a null tip.
 *
 * Every outbound store, journal, profile, workspace, artifact and
 * authorization call is guarded by a deadline (`storeCallTimeoutMs`) and a
 * `try/catch`: an unreadable read is a typed refusal, never a throw, never a
 * silent skip, and never a guessed empty answer.
 */

import { LANE_DIFF_SECRET_PATTERNS, containsSecretShape } from '@fleet/shared';
import type { ActionJournalEntryRecord, AttemptRecord, AttemptRunnerRecord, WorkOrderRecord } from '../../domain/execution-records.js';
import { attemptManifestCoordinates } from '../../domain/artifact-manifest.js';
import { readLaneRunRecord } from '../../domain/entities/LaneRun.js';
import { WorkOrder } from '../../domain/entities/WorkOrder.js';
import {
  readActionJournalEntryRecord,
  readAttemptRecord,
  readCapacityReservationRecord,
} from '../../domain/execution-record-readers.js';
import { isCalendarDateTime, snapshotPlainDataRecord } from '../../domain/plain-record-reads.js';
import {
  laneRunJournalState,
  readLaneRunJournalEntry,
  type LaneRunJournalEntryRecord,
} from '../../domain/lane-run-journal.js';
import { LANE_RUN_ID_PATTERN, type LaneRunRecord } from '../../domain/lane-run-records.js';
import { LANE_RUN_TERMINAL_STATES } from '../../domain/value-objects/LaneRunState.vo.js';
import type { LaneRunStateValue } from '../../domain/value-objects/LaneRunState.vo.js';
import type { ActionAuthorizationPort } from '../ports/out/ActionAuthorizationPort.out-port.js';
import type { AttemptArtifactPort, VerifyArtifactManifestRequest } from '../ports/out/AttemptArtifactPort.out-port.js';
import type { AttemptRepositoryPort } from '../ports/out/AttemptRepositoryPort.out-port.js';
import type { ExecutionJournalPort } from '../ports/out/ExecutionJournalPort.out-port.js';
import type { LaneRunRepositoryPort } from '../ports/out/LaneRunRepositoryPort.out-port.js';
import type { ProjectProfileReadPort } from '../ports/out/ProjectProfileReadPort.out-port.js';
import type { RunnerForAttemptPort } from '../ports/out/RunnerForAttemptPort.out-port.js';
import type { WorkOrderRepositoryPort } from '../ports/out/WorkOrderRepositoryPort.out-port.js';
import type { WorkspacePort } from '../ports/out/WorkspacePort.out-port.js';
import { conductedRunnerOf } from './advance-lane-run/conducted-host.js';
import { simpleDeterministicHexDigest } from './PrepareBriefPackageUseCase.use-case.js';
import { journalsForRuns, type RunJournalRunReads } from './run-journal-reads.js';
import type {
  ReapLaneWorktreesPort,
  ReapLaneWorktreesRequest,
  ReapLaneWorktreesResult,
  ReapWorktreeJournalFailureEntry,
} from '../ports/in/ReapLaneWorktreesPort.in-port.js';

/** The reads and writes the reap needs; narrowed so composition supplies only what it has. */
export interface ReapLaneWorktreesDependencies {
  readonly workOrderRepo: Pick<WorkOrderRepositoryPort, 'findWorkOrderById'>;
  readonly attemptRepo: Pick<AttemptRepositoryPort, 'listAttemptsByWorkOrder'>;
  readonly runRepo: Pick<LaneRunRepositoryPort, 'list'>;
  readonly runJournal: RunJournalRunReads;
  readonly executionJournal: Pick<
    ExecutionJournalPort,
    'listActiveReservations' | 'appendJournalEntry' | 'listJournalEntriesForAttempt'
  >;
  /** Absent: any candidate that needs a clone is refused `not-configured`. */
  readonly profileRead?: ProjectProfileReadPort;
  /**
   * C2'. Absent (or without `inspectWorktreeForRemoval` / `removeWorktree`):
   * a removal is refused `not-configured`.
   */
  readonly workspace?: Pick<WorkspacePort, 'inspectWorktreeForRemoval' | 'removeWorktree'>;
  /** C2': the fail-closed artifact-manifest check for `--force-unsealed`. */
  readonly attemptArtifact?: Pick<AttemptArtifactPort, 'checkArtifactManifestForRemoval'>;
  /** C2': the scoped owner approval for `--force-unsealed`. */
  readonly actionAuthorization?: Pick<ActionAuthorizationPort, 'authorizeUnsealedWorktreeRemoval'>;
  /**
   * C2': Required. Absent at runtime (an untyped caller): every removal
   * candidate is refused `not-configured`; nothing is removed.
   */
  readonly runnerForAttempt: RunnerForAttemptPort;
  /** F129: infrastructure digest of the one-way intent; the pure fallback is used when absent. */
  readonly computeDigest?: (content: string) => string;
  /** Clock override; production uses the system clock. */
  readonly now?: () => string;
  /** C2': the deadline of one outbound store/journal/workspace call. Default 15 s. */
  readonly storeCallTimeoutMs?: number;
}

/** The default deadline of one outbound call. */
const DEFAULT_STORE_CALL_TIMEOUT_MS = 15_000;

/** The largest number of runs one reap pass scans; more is a refusal. */
const MAX_RUNS_PER_REAP = 4_096;

/** The largest number of attempts one work order may list before its runs are refused. */
const MAX_ATTEMPTS_PER_WORK_ORDER = 4_096;

/** The largest run-journal entry list one run may carry before it is refused. */
const MAX_RUN_JOURNAL_ENTRIES = 4_096;

/** The largest action-journal entry list one attempt may carry before its run is refused. */
const MAX_ATTEMPT_JOURNAL_ENTRIES = 4_096;

/** The largest reservation list one reap pass reads. */
const MAX_RESERVATIONS_PER_REAP = 4_096;

/** The longest filesystem path a stored or answered record may carry. */
const MAX_PATH_CHARS = 4_096;

/** A git object id as the workspace answers it. */
const COMMIT_HEX_RE = /^[0-9a-f]{40,64}$/;

/** Every refusal `WorkspacePort.removeWorktree` declares; any other reason is unknown. */
const DECLARED_REMOVE_REFUSALS: ReadonlySet<string> = new Set([
  'invalid-request',
  'path-refused',
  'not-a-linked-worktree',
  'head-moved',
  'branch-mismatch',
  'detached',
  'dirty',
  'locked',
  'busy',
  'git-refused',
  'artifacts not collected',
  'artifacts changed since collection',
]);

const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The marker a completed removal journal entry carries (keyed idempotence). */
function removalCompletedMarker(runId: string): string {
  return `branch ${branchForRun(runId)} kept at `;
}

/** The id prefix every crash-recoverable unsealed-removal intent entry of an attempt carries. */
function unsealedIntentPrefix(attemptId: string): string {
  return `${attemptId}:collect:reap-unsealed-intent:`;
}

/** The id of the crash-recoverable unsealed-removal intent entry. */
function unsealedIntentEntryId(attemptId: string, runId: string): string {
  return `${unsealedIntentPrefix(attemptId)}${runId}`;
}

/** The request digest an intent entry records in its detail (F129). */
const INTENT_DIGEST_RE = /(?:^|;\s*)requestDigest=([0-9a-f]{64})(?:$|;)/;

/** Every field the one-way `--force-unsealed` intent binds to. */
export interface UnsealedRemovalDigestInput {
  readonly attemptId: string;
  readonly expectedHeadSha: string;
  readonly projectId: string;
  readonly repositoryRoot: string;
  readonly runId: string;
  readonly worktreePath: string;
  readonly worktreeRoot: string;
}

/** F129: the full request digest of a one-way unsealed-removal intent. */
export function unsealedRemovalRequestDigest(
  fields: UnsealedRemovalDigestInput,
  computeDigest: (content: string) => string = simpleDeterministicHexDigest,
): string {
  return computeDigest(
    JSON.stringify({
      action: 'reap-unsealed-worktree',
      attemptId: fields.attemptId,
      expectedHeadSha: fields.expectedHeadSha,
      forceUnsealed: true,
      projectId: fields.projectId,
      repositoryRoot: fields.repositoryRoot,
      runId: fields.runId,
      worktreePath: fields.worktreePath,
      worktreeRoot: fields.worktreeRoot,
    }),
  );
}

/** The deadline guard: the call's own answer, or a throw when it runs past `timeoutMs`. */
class StoreCallTimeoutError extends Error {}

async function withBudget<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new StoreCallTimeoutError('store call exceeded its budget')), timeoutMs);
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

function isTerminalRun(state: LaneRunStateValue): boolean {
  return (LANE_RUN_TERMINAL_STATES as readonly LaneRunStateValue[]).includes(state);
}

function isTerminalWorkOrder(state: WorkOrderRecord['state']): boolean {
  return state === 'merged' || state === 'stopped';
}

/** The branch of a run's worktree (K7-D7): `fleet/<runId>`. */
function branchForRun(runId: string): string {
  return 'fleet/' + runId;
}

export class ReapLaneWorktreesUseCase implements ReapLaneWorktreesPort {
  constructor(private readonly deps?: ReapLaneWorktreesDependencies) {}

  async execute(input: unknown): Promise<ReapLaneWorktreesResult> {
    if (!this.deps) {
      throw new Error('Not implemented: ReapLaneWorktreesUseCase');
    }
    // Fail safe: a missing input is a dry run, so the pinned EX-2b defaulting
    // (`execute(null)` is a dry run) stays exact. A primitive or an unreadable
    // input is a typed refusal, and only an explicit `dryRun: false` removes.
    if (input === null || input === undefined) {
      return this.reapLaneWorktrees({ dryRun: true });
    }
    let snap: Record<string, unknown> | null;
    try {
      snap = snapshotPlainDataRecord(input);
    } catch {
      return { outcome: 'refused', reason: 'invalid-request' };
    }
    if (snap === null) {
      return { outcome: 'refused', reason: 'invalid-request' };
    }
    const dryRun = snap['dryRun'] !== false;
    return this.reapLaneWorktrees({ ...snap, dryRun } as unknown as ReapLaneWorktreesRequest);
  }

  async reapLaneWorktrees(request: ReapLaneWorktreesRequest): Promise<ReapLaneWorktreesResult> {
    if (!this.deps) {
      throw new Error('Not implemented: ReapLaneWorktreesUseCase');
    }
    const validation = validateReapRequest(request);
    if (validation === 'invalid-request') {
      return { outcome: 'refused', reason: 'invalid-request' };
    }
    // The validated snapshot is what `reap` reads: the original request is
    // never read again after validation, so a stateful proxy cannot change a
    // field (for example, `dryRun`) between the validation and the reap.
    try {
      return await this.reap(this.deps, validation.snap as unknown as ReapLaneWorktreesRequest);
    } catch {
      // The request was validated above, so no failure after it is an invalid request.
      return { outcome: 'unknown', reason: 'store-unreadable' };
    }
  }

  private async reap(
    deps: ReapLaneWorktreesDependencies,
    request: ReapLaneWorktreesRequest,
  ): Promise<ReapLaneWorktreesResult> {
    const dryRun = request.dryRun;
    const forceUnsealed = request.forceUnsealed === true;
    let nowIso: string;
    try {
      const clock: unknown = request.nowIso ?? deps.now?.() ?? new Date().toISOString();
      if (typeof clock !== 'string' || clock.length > 64 || !isCalendarDateTime(clock)) {
        return { outcome: 'unknown', reason: 'store-unreadable' };
      }
      nowIso = clock;
    } catch {
      return { outcome: 'unknown', reason: 'store-unreadable' };
    }
    const budget = deps.storeCallTimeoutMs ?? DEFAULT_STORE_CALL_TIMEOUT_MS;

    // Top-level reads are deadline-guarded and fail closed: an unreadable
    // store is `unknown`, never an empty scan.
    const refused: { readonly runId: string; readonly reason: string }[] = [];
    let runs: LaneRunRecord[];
    try {
      const listed: unknown = await withBudget(deps.runRepo.list(), budget);
      if (!Array.isArray(listed)) {
        return { outcome: 'unknown', reason: 'store-unreadable' };
      }
      const listedLength = Object.getOwnPropertyDescriptor(listed, 'length')?.value as unknown;
      if (typeof listedLength !== 'number' || !Number.isSafeInteger(listedLength) || listedLength < 0) {
        return { outcome: 'unknown', reason: 'store-unreadable' };
      }
      if (listedLength > MAX_RUNS_PER_REAP) {
        return { outcome: 'refused', reason: 'invalid-request' };
      }
      // A run whose record is malformed but whose id is readable is refused
      // `record-malformed` and the scan goes on; a duplicate run id is
      // ambiguous, so every record of it is refused. An entry with no
      // readable run id leaves the list unidentifiable.
      const validByRunId = new Map<string, LaneRunRecord>();
      const malformedRunIds = new Set<string>();
      for (let index = 0; index < listedLength; index += 1) {
        if (!Object.hasOwn(listed, index)) {
          continue;
        }
        const descriptor = Object.getOwnPropertyDescriptor(listed, index);
        if (descriptor === undefined || descriptor.get !== undefined || descriptor.set !== undefined) {
          return { outcome: 'unknown', reason: 'store-unreadable' };
        }
        const validated = readLaneRunRecord(descriptor.value);
        if (validated.ok) {
          if (validByRunId.has(validated.record.runId)) {
            malformedRunIds.add(validated.record.runId);
          } else {
            validByRunId.set(validated.record.runId, validated.record);
          }
          continue;
        }
        const runId = readSafeRunId(descriptor.value);
        if (runId === null) {
          return { outcome: 'unknown', reason: 'store-unreadable' };
        }
        malformedRunIds.add(runId);
      }
      runs = [...validByRunId.values()].filter((run) => !malformedRunIds.has(run.runId));
      for (const runId of malformedRunIds) {
        refused.push({ runId, reason: 'record-malformed' });
      }
    } catch {
      return { outcome: 'unknown', reason: 'store-unreadable' };
    }
    let entriesByRun: ReadonlyMap<string, unknown>;
    try {
      entriesByRun = await withBudget(
        journalsForRuns(deps.runJournal, runs.map((run) => run.runId)),
        budget,
      );
      if (!(entriesByRun instanceof Map)) {
        return { outcome: 'unknown', reason: 'store-unreadable' };
      }
    } catch {
      return { outcome: 'unknown', reason: 'store-unreadable' };
    }
    let heldAttemptIds: ReadonlySet<string>;
    try {
      const reservations: unknown = await withBudget(deps.executionJournal.listActiveReservations(), budget);
      const dense = readDenseArray(reservations, MAX_RESERVATIONS_PER_REAP);
      if (dense.kind !== 'ok') {
        return { outcome: 'unknown', reason: 'store-unreadable' };
      }
      const held = new Set<string>();
      for (const item of dense.items) {
        const read = readCapacityReservationRecord(item);
        if (!read.ok) {
          return { outcome: 'unknown', reason: 'store-unreadable' };
        }
        if (read.record.held) {
          held.add(read.record.attemptId);
        }
      }
      heldAttemptIds = held;
    } catch {
      return { outcome: 'unknown', reason: 'store-unreadable' };
    }

    const removed: { readonly runId: string; readonly branchTip: string | null }[] = [];
    const alreadyRemoved: { readonly runId: string }[] = [];
    const skipped: { readonly runId: string; readonly reason: string }[] = [];
    const journalFailed: ReapWorktreeJournalFailureEntry[] = [];

    const workOrderCache = new Map<string, unknown>();
    const attemptsCache = new Map<string, unknown>();
    const findWorkOrder = async (workOrderId: string): Promise<unknown> => {
      if (workOrderCache.has(workOrderId)) {
        return workOrderCache.get(workOrderId);
      }
      const record: unknown = await withBudget(deps.workOrderRepo.findWorkOrderById(workOrderId), budget);
      workOrderCache.set(workOrderId, record);
      return record;
    };
    const listAttempts = async (workOrderId: string): Promise<unknown> => {
      if (attemptsCache.has(workOrderId)) {
        return attemptsCache.get(workOrderId);
      }
      const records: unknown = await withBudget(deps.attemptRepo.listAttemptsByWorkOrder(workOrderId), budget);
      attemptsCache.set(workOrderId, records);
      return records;
    };

    for (const run of runs) {
      try {
        const evaluation = await evaluateRunCandidate({
          deps,
          run,
          heldAttemptIds,
          findWorkOrder,
          listAttempts,
          entriesByRun,
          budget,
          skipped,
          refused,
        });
        if (evaluation.outcome !== 'candidate') {
          continue;
        }
        await reapCandidateWorktree({
          deps,
          run,
          latestAttempt: evaluation.latestAttempt,
          workOrder: evaluation.workOrder,
          clone: evaluation.clone,
          recordedHost: evaluation.recordedHost,
          dryRun,
          forceUnsealed,
          nowIso,
          budget,
          removed,
          alreadyRemoved,
          refused,
          journalFailed,
        });
      } catch {
        // No single run may abort the pass or discard what the others reported.
        refused.push({ runId: run.runId, reason: 'unknown' });
      }
    }

    const byRunId = (a: { readonly runId: string }, b: { readonly runId: string }): number =>
      byCodeUnit(a.runId, b.runId);
    removed.sort(byRunId);
    alreadyRemoved.sort(byRunId);
    refused.sort(byRunId);
    skipped.sort(byRunId);
    journalFailed.sort(byRunId);

    return { outcome: 'reaped', dryRun, removed, alreadyRemoved, refused, skipped, journalFailed };
  }
}

/** True when `value` is a plain object (never an array, never null). */
function isRecordObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) {
      return true;
    }
  }
  return false;
}

/** A bounded identifier: no path separator, control character or secret shape. Never throws. */
function isSafeIdentifier(value: unknown, maxLen = 256): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= maxLen &&
    !value.includes('/') &&
    !value.includes('\\') &&
    !hasControlCharacter(value) &&
    !containsSecretShape(value) &&
    !LANE_DIFF_SECRET_PATTERNS.some((pattern) => pattern.regex.test(value))
  );
}

/** A bounded absolute path with no NUL. Never throws. */
function isSafeAbsolutePath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.startsWith('/') &&
    value.length <= MAX_PATH_CHARS &&
    !value.includes('\0')
  );
}

type DenseArrayRead =
  | { readonly kind: 'ok'; readonly items: readonly unknown[] }
  | { readonly kind: 'not-array' }
  | { readonly kind: 'malformed' };

/**
 * The elements of a dense array read through own data descriptors, so no
 * getter runs. A sparse hole, an accessor, an extra array property, a length
 * past `maxLen` or a throwing Proxy trap is `malformed`; a non-array is
 * `not-array`. Never throws.
 */
function readDenseArray(value: unknown, maxLen: number): DenseArrayRead {
  try {
    if (!Array.isArray(value)) {
      return { kind: 'not-array' };
    }
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
    if (
      lengthDescriptor === undefined ||
      lengthDescriptor.get !== undefined ||
      lengthDescriptor.set !== undefined
    ) {
      return { kind: 'malformed' };
    }
    const length: unknown = lengthDescriptor.value;
    if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0 || length > maxLen) {
      return { kind: 'malformed' };
    }
    if (Reflect.ownKeys(value).length !== length + 1) {
      return { kind: 'malformed' };
    }
    const items: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, index);
      if (
        descriptor === undefined ||
        !descriptor.enumerable ||
        descriptor.get !== undefined ||
        descriptor.set !== undefined
      ) {
        return { kind: 'malformed' };
      }
      items.push(descriptor.value);
    }
    return { kind: 'ok', items };
  } catch {
    return { kind: 'malformed' };
  }
}

/** The run id of a record that failed validation, only when it is a well-formed run id. */
function readSafeRunId(raw: unknown): string | null {
  try {
    if (!isRecordObject(raw)) {
      return null;
    }
    const descriptor = Object.getOwnPropertyDescriptor(raw, 'runId');
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      descriptor.get !== undefined ||
      descriptor.set !== undefined ||
      typeof descriptor.value !== 'string' ||
      !LANE_RUN_ID_PATTERN.test(descriptor.value)
    ) {
      return null;
    }
    return descriptor.value;
  } catch {
    return null;
  }
}

/** A fresh, validated work order whose id is the one asked for; null on anything malformed. */
function readValidWorkOrder(raw: unknown, expectedId: string): WorkOrderRecord | null {
  try {
    const snap = snapshotPlainDataRecord(raw);
    if (
      snap === null ||
      snap['id'] !== expectedId ||
      !isSafeIdentifier(snap['projectId']) ||
      readDenseArray(snap['ownedPaths'], 4_096).kind !== 'ok' ||
      readDenseArray(snap['prerequisiteWorkOrderIds'], 4_096).kind !== 'ok'
    ) {
      return null;
    }
    return WorkOrder.fromRecord(snap as unknown as WorkOrderRecord).toRecord();
  } catch {
    return null;
  }
}

/**
 * A fresh, validated attempt of the work order asked for; null on anything
 * malformed. Partial or corrupt manifest coordinates are malformed: they are
 * never read as sealed and never as uncollected.
 */
function readValidAttemptForWorkOrder(raw: unknown, expectedWorkOrderId: string): AttemptRecord | null {
  try {
    const parsed = readAttemptRecord(raw);
    if (!parsed.ok) {
      return null;
    }
    const record = parsed.record;
    if (record.workOrderId !== expectedWorkOrderId || !isSafeAbsolutePath(record.worktreePath)) {
      return null;
    }
    const artifacts = record.artifacts;
    if (
      artifacts !== null &&
      (artifacts.manifestPath !== undefined || artifacts.manifestSha256 !== undefined) &&
      attemptManifestCoordinates(artifacts).kind !== 'sealed'
    ) {
      return null;
    }
    return record;
  } catch {
    return null;
  }
}

type ProfileCloneRead =
  | { readonly kind: 'clone'; readonly clone: CloneRecord }
  | { readonly kind: 'no-clone' }
  | { readonly kind: 'malformed' };

/** The clone a profile records for a host: none for a null profile or an absent host, malformed otherwise. */
function readProfileClone(rawProfile: unknown, hostName: string): ProfileCloneRead {
  if (rawProfile === null) {
    return { kind: 'no-clone' };
  }
  try {
    const profileSnap = snapshotPlainDataRecord(rawProfile);
    if (profileSnap === null) {
      return { kind: 'malformed' };
    }
    const clonesSnap = snapshotPlainDataRecord(profileSnap['clones']);
    if (clonesSnap === null) {
      return { kind: 'malformed' };
    }
    if (!Object.hasOwn(clonesSnap, hostName) || clonesSnap[hostName] === undefined) {
      return { kind: 'no-clone' };
    }
    const cloneSnap = snapshotPlainDataRecord(clonesSnap[hostName]);
    if (
      cloneSnap === null ||
      !isSafeAbsolutePath(cloneSnap['path']) ||
      !isSafeAbsolutePath(cloneSnap['worktreeRoot'])
    ) {
      return { kind: 'malformed' };
    }
    return { kind: 'clone', clone: { path: cloneSnap['path'], worktreeRoot: cloneSnap['worktreeRoot'] } };
  } catch {
    return { kind: 'malformed' };
  }
}

/** The result of validating a reap request: the validated snapshot or a refusal. */
type ReapRequestValidation = { readonly snap: Record<string, unknown> } | 'invalid-request';

/**
 * C2': the strict runtime-input guard. A null, a non-object, an unreadable
 * (throwing-getter) request, a missing or non-boolean `dryRun`, a non-boolean
 * `forceUnsealed` or a malformed `nowIso` is refused; a missing `nowIso` is
 * fine (the clock answers). The single validated snapshot is returned so the
 * caller never re-reads the original request (a stateful proxy could return
 * different field values, such as `dryRun`, across reads).
 */
function validateReapRequest(input: unknown): ReapRequestValidation {
  let snap: Record<string, unknown> | null;
  try {
    snap = snapshotPlainDataRecord(input);
  } catch {
    return 'invalid-request';
  }
  if (snap === null) {
    return 'invalid-request';
  }
  if (typeof snap['dryRun'] !== 'boolean') {
    return 'invalid-request';
  }
  const forceUnsealed = snap['forceUnsealed'];
  if (forceUnsealed !== undefined && typeof forceUnsealed !== 'boolean') {
    return 'invalid-request';
  }
  const nowIso = snap['nowIso'];
  if (
    nowIso !== undefined &&
    (typeof nowIso !== 'string' || nowIso.length > 64 || !isCalendarDateTime(nowIso))
  ) {
    return 'invalid-request';
  }
  return { snap };
}

/** A project-profile clone: the clone root and the worktree root it manages. */
type CloneRecord = { readonly path: string; readonly worktreeRoot: string };

/** One run's eligibility decision; a candidate carries what removal needs. */
type RunCandidateEvaluation =
  | {
      readonly outcome: 'candidate';
      readonly latestAttempt: AttemptRecord;
      readonly workOrder: WorkOrderRecord;
      readonly clone: CloneRecord;
      readonly recordedHost: AttemptRunnerRecord;
    }
  | { readonly outcome: 'skipped' }
  | { readonly outcome: 'refused' };

interface EvaluateRunCandidateParams {
  readonly deps: ReapLaneWorktreesDependencies;
  readonly run: LaneRunRecord;
  readonly heldAttemptIds: ReadonlySet<string>;
  /** The raw repository answer: every record is validated per run. */
  readonly findWorkOrder: (workOrderId: string) => Promise<unknown>;
  readonly listAttempts: (workOrderId: string) => Promise<unknown>;
  readonly entriesByRun: ReadonlyMap<string, unknown>;
  readonly budget: number;
  readonly skipped: { readonly runId: string; readonly reason: string }[];
  readonly refused: { readonly runId: string; readonly reason: string }[];
}

/**
 * Decide one run's eligibility and, for a candidate, return its latest attempt,
 * work order, clone and recorded host. Non-candidates push their own skip or
 * refusal entry. Every outbound read is deadline-guarded: an unreadable read
 * is a per-run refusal (`unknown`) and the scan continues — never a skip,
 * never a guessed empty answer.
 */
async function evaluateRunCandidate(
  params: EvaluateRunCandidateParams,
): Promise<RunCandidateEvaluation> {
  const {
    deps,
    run,
    heldAttemptIds,
    findWorkOrder,
    listAttempts,
    entriesByRun,
    budget,
    skipped,
    refused,
  } = params;
  const rawEntries = entriesByRun.has(run.runId) ? entriesByRun.get(run.runId) : [];
  if (!Array.isArray(rawEntries)) {
    refused.push({ runId: run.runId, reason: 'unknown' });
    return { outcome: 'refused' };
  }
  const denseEntries = readDenseArray(rawEntries, MAX_RUN_JOURNAL_ENTRIES);
  if (denseEntries.kind !== 'ok') {
    refused.push({ runId: run.runId, reason: 'record-malformed' });
    return { outcome: 'refused' };
  }
  const runJournalEntries: LaneRunJournalEntryRecord[] = [];
  for (const item of denseEntries.items) {
    const entryRead = readLaneRunJournalEntry(item);
    if (!entryRead.ok) {
      refused.push({ runId: run.runId, reason: 'record-malformed' });
      return { outcome: 'refused' };
    }
    runJournalEntries.push(entryRead.entry);
  }
  const state = laneRunJournalState(runJournalEntries, run.runId);
  if (!isTerminalRun(state)) {
    skipped.push({ runId: run.runId, reason: 'run-not-terminal' });
    return { outcome: 'skipped' };
  }

  let rawWorkOrder: unknown;
  try {
    rawWorkOrder = await findWorkOrder(run.workOrderId);
  } catch {
    refused.push({ runId: run.runId, reason: 'unknown' });
    return { outcome: 'refused' };
  }
  if (rawWorkOrder === null) {
    skipped.push({ runId: run.runId, reason: 'work-order-active' });
    return { outcome: 'skipped' };
  }
  const workOrder = readValidWorkOrder(rawWorkOrder, run.workOrderId);
  if (workOrder === null) {
    refused.push({ runId: run.runId, reason: 'record-malformed' });
    return { outcome: 'refused' };
  }
  if (!isTerminalWorkOrder(workOrder.state)) {
    skipped.push({ runId: run.runId, reason: 'work-order-active' });
    return { outcome: 'skipped' };
  }

  // The run's attempts: every id the run records, in the run's own order.
  // Every attempt the work order lists is validated, not only the run's own:
  // fix attempts share the worktree, so a corrupt sibling is never bypassed.
  let rawAttempts: unknown;
  try {
    rawAttempts = await listAttempts(run.workOrderId);
  } catch {
    refused.push({ runId: run.runId, reason: 'unknown' });
    return { outcome: 'refused' };
  }
  const denseAttempts = readDenseArray(rawAttempts, MAX_ATTEMPTS_PER_WORK_ORDER);
  if (denseAttempts.kind !== 'ok') {
    refused.push({ runId: run.runId, reason: denseAttempts.kind === 'not-array' ? 'unknown' : 'record-malformed' });
    return { outcome: 'refused' };
  }
  const runAttempts: AttemptRecord[] = [];
  const attemptsById = new Map<string, AttemptRecord>();
  for (const item of denseAttempts.items) {
    const attempt = readValidAttemptForWorkOrder(item, run.workOrderId);
    if (attempt === null || attemptsById.has(attempt.id)) {
      refused.push({ runId: run.runId, reason: 'record-malformed' });
      return { outcome: 'refused' };
    }
    attemptsById.set(attempt.id, attempt);
  }
  let missingAttempt = false;
  for (const attemptId of run.attemptIds) {
    const attempt = attemptsById.get(attemptId);
    if (attempt === undefined) {
      missingAttempt = true;
      break;
    }
    runAttempts.push(attempt);
  }
  // A run records an attempt the store does not have: it cannot be proven
  // cancelled or collected, so it is never a candidate.
  if (missingAttempt) {
    skipped.push({ runId: run.runId, reason: 'attempt-live' });
    return { outcome: 'skipped' };
  }
  if (runAttempts.some((attempt) => attempt.state !== 'cancelled' && attempt.state !== 'collected')) {
    skipped.push({ runId: run.runId, reason: 'attempt-live' });
    return { outcome: 'skipped' };
  }
  if (runAttempts.some((attempt) => heldAttemptIds.has(attempt.id))) {
    skipped.push({ runId: run.runId, reason: 'slot-held' });
    return { outcome: 'skipped' };
  }

  const latestAttempt = runAttempts[runAttempts.length - 1];
  if (latestAttempt === undefined) {
    // No attempt, no worktree to remove.
    skipped.push({ runId: run.runId, reason: 'no-recorded-host' });
    return { outcome: 'skipped' };
  }
  const recordedHost = conductedRunnerOf(latestAttempt);
  if (recordedHost === null) {
    skipped.push({ runId: run.runId, reason: 'no-recorded-host' });
    return { outcome: 'skipped' };
  }

  if (deps.profileRead === undefined) {
    refused.push({ runId: run.runId, reason: 'not-configured' });
    return { outcome: 'refused' };
  }
  let profile: unknown;
  try {
    profile = await withBudget(deps.profileRead.readProjectProfile(workOrder.projectId), budget);
  } catch {
    refused.push({ runId: run.runId, reason: 'unknown' });
    return { outcome: 'refused' };
  }
  const cloneRead = readProfileClone(profile, recordedHost.hostName ?? '');
  if (cloneRead.kind === 'no-clone') {
    skipped.push({ runId: run.runId, reason: 'no-clone' });
    return { outcome: 'skipped' };
  }
  if (cloneRead.kind === 'malformed') {
    refused.push({ runId: run.runId, reason: 'record-malformed' });
    return { outcome: 'refused' };
  }

  return { outcome: 'candidate', latestAttempt, workOrder, clone: cloneRead.clone, recordedHost };
}

interface ReapCandidateWorktreeParams {
  readonly deps: ReapLaneWorktreesDependencies;
  readonly run: LaneRunRecord;
  readonly latestAttempt: AttemptRecord;
  readonly workOrder: WorkOrderRecord;
  readonly clone: CloneRecord;
  readonly recordedHost: AttemptRunnerRecord;
  readonly dryRun: boolean;
  readonly forceUnsealed: boolean;
  readonly nowIso: string;
  readonly budget: number;
  readonly removed: { readonly runId: string; readonly branchTip: string | null }[];
  readonly alreadyRemoved: { readonly runId: string }[];
  readonly refused: { readonly runId: string; readonly reason: string }[];
  readonly journalFailed: ReapWorktreeJournalFailureEntry[];
}

/**
 * Remove one candidate's sealed worktree and report the outcome (C2'). A
 * failed post-removal journal append never aborts the scan: the removal stays
 * in `removed` and the failure is reported in `journalFailed`. Keyed
 * idempotence: a completed removal journal entry reports `alreadyRemoved`
 * without re-acting, so a repeat reap never fails on an already-reaped
 * attempt. For `--force-unsealed` the clean/unlocked/idle pre-check runs
 * before any owner approval is consumed, so a dirty worktree never burns a
 * signed grant.
 */
async function reapCandidateWorktree(params: ReapCandidateWorktreeParams): Promise<void> {
  const {
    deps,
    run,
    latestAttempt,
    clone,
    recordedHost,
    dryRun,
    forceUnsealed,
    nowIso,
    budget,
    removed,
    alreadyRemoved,
    refused,
    journalFailed,
  } = params;
  if (dryRun) {
    removed.push({ runId: run.runId, branchTip: null });
    return;
  }

  // Keyed idempotence first: a repeat reap of an already-reaped attempt is
  // `alreadyRemoved`, never a second removal and never a manifest refusal.
  let rawPrior: unknown;
  try {
    rawPrior = await withBudget(
      deps.executionJournal.listJournalEntriesForAttempt(latestAttempt.id),
      budget,
    );
  } catch {
    refused.push({ runId: run.runId, reason: 'unknown' });
    return;
  }
  const densePrior = readDenseArray(rawPrior, MAX_ATTEMPT_JOURNAL_ENTRIES);
  if (densePrior.kind !== 'ok') {
    refused.push({ runId: run.runId, reason: densePrior.kind === 'not-array' ? 'unknown' : 'record-malformed' });
    return;
  }
  // A malformed journal entry could be a completed removal or an intent this
  // reap cannot see: refuse before any inspection, approval or removal.
  const priorEntries: ActionJournalEntryRecord[] = [];
  for (const item of densePrior.items) {
    const entryRead = readActionJournalEntryRecord(item);
    if (!entryRead.ok) {
      refused.push({ runId: run.runId, reason: 'record-malformed' });
      return;
    }
    priorEntries.push(entryRead.record);
  }
  const completedMarker = removalCompletedMarker(run.runId);
  if (
    priorEntries.some(
      (entry) =>
        isRecordObject(entry) &&
        entry['action'] === 'collect' &&
        entry['status'] === 'completed' &&
        typeof entry['detail'] === 'string' &&
        (entry['detail'] as string).includes(completedMarker),
    )
  ) {
    alreadyRemoved.push({ runId: run.runId });
    return;
  }

  const workspace = deps.workspace;
  if (
    workspace?.inspectWorktreeForRemoval === undefined ||
    workspace.removeWorktree === undefined
  ) {
    refused.push({ runId: run.runId, reason: 'not-configured' });
    return;
  }

  // The facts, read under the caller's hold; an unreadable read is unknown.
  let rawInspect: unknown;
  try {
    rawInspect = await withBudget(
      workspace.inspectWorktreeForRemoval.call(workspace, {
        repositoryRoot: clone.path,
        worktreePath: latestAttempt.worktreePath,
        defaultRef: 'origin/main',
        recordedHost,
      }),
      budget,
    );
  } catch {
    refused.push({ runId: run.runId, reason: 'unknown' });
    return;
  }
  const inspect = readInspectResult(rawInspect);
  if (inspect.kind === 'unknown') {
    refused.push({ runId: run.runId, reason: 'unknown' });
    return;
  }
  if (inspect.kind === 'not-a-linked-worktree') {
    // Not listed at all: the worktree is already gone.
    alreadyRemoved.push({ runId: run.runId });
    return;
  }
  const facts = inspect.facts;
  if (facts.branch === null) {
    refused.push({ runId: run.runId, reason: 'detached' });
    return;
  }
  if (facts.branch !== branchForRun(run.runId)) {
    refused.push({ runId: run.runId, reason: 'branch-mismatch' });
    return;
  }
  if (facts.status.tracked + facts.status.untracked + facts.status.unmerged > 0) {
    refused.push({ runId: run.runId, reason: 'dirty' });
    return;
  }
  if (facts.locked !== false) {
    refused.push({ runId: run.runId, reason: 'locked' });
    return;
  }
  if (
    facts.head === null ||
    facts.inProgressOperations.length > 0 ||
    facts.lastActivity.unknown ||
    facts.lastActivity.iso === null
  ) {
    refused.push({ runId: run.runId, reason: 'busy' });
    return;
  }

  // C2': the runner must prove the worktree idle before any approval is
  // consumed or any removal runs; unprovable liveness is never idle.
  const runnerForAttempt: unknown = deps.runnerForAttempt;
  const resolveRunner =
    typeof runnerForAttempt === 'object' &&
    runnerForAttempt !== null &&
    typeof (runnerForAttempt as RunnerForAttemptPort).runnerForAttempt === 'function'
      ? (runnerForAttempt as RunnerForAttemptPort)
      : undefined;
  if (resolveRunner === undefined) {
    refused.push({ runId: run.runId, reason: 'not-configured' });
    return;
  }
  const liveness = await worktreeRunnerLiveness(resolveRunner, latestAttempt, recordedHost, budget);
  if (liveness !== 'idle') {
    refused.push({ runId: run.runId, reason: liveness });
    return;
  }

  // C2': where the sealed manifest lives, read from the attempt's record.
  const coords = attemptManifestCoordinates(latestAttempt.artifacts);
  let manifest: RemoveWorktreeManifestInput;
  let approvalReference: string | undefined;
  if (forceUnsealed) {
    if (coords.kind === 'sealed') {
      // A genuinely sealed worktree needs no owner approval: verify it first.
      const check = deps.attemptArtifact?.checkArtifactManifestForRemoval;
      if (check === undefined) {
        refused.push({ runId: run.runId, reason: 'unknown' });
        return;
      }
      let rawVerdict: unknown;
      const request: VerifyArtifactManifestRequest = {
        attemptId: latestAttempt.id,
        worktreePath: latestAttempt.worktreePath,
        manifestPath: coords.manifestPath,
        expectedManifestSha256: coords.expectedManifestSha256,
        recordedHost,
      };
      try {
        rawVerdict = await withBudget(check.call(deps.attemptArtifact as object, request), budget);
      } catch {
        refused.push({ runId: run.runId, reason: 'unknown' });
        return;
      }
      const verdictOutcome = readOutcomeOf(rawVerdict);
      if (verdictOutcome === 'sealed') {
        manifest = {
          kind: 'sealed',
          attemptId: latestAttempt.id,
          manifestPath: coords.manifestPath,
          expectedManifestSha256: coords.expectedManifestSha256,
        };
      } else if (verdictOutcome !== 'missing' && verdictOutcome !== 'mismatch') {
        // An unreadable, unknown or unrecognised verdict is never a reason to ask for approval.
        refused.push({ runId: run.runId, reason: 'unknown' });
        return;
      } else {
        // Missing or mismatched: fall through to the unsealed authorization.
        const unsealed = await authorizeUnsealedRemoval(params, priorEntries, facts.head);
        if (unsealed.outcome === 'refused') {
          refused.push({ runId: run.runId, reason: unsealed.reason });
          return;
        }
        manifest = unsealed.manifest;
        approvalReference = unsealed.approvalReference;
      }
    } else {
      const unsealed = await authorizeUnsealedRemoval(params, priorEntries, facts.head);
      if (unsealed.outcome === 'refused') {
        refused.push({ runId: run.runId, reason: unsealed.reason });
        return;
      }
      manifest = unsealed.manifest;
      approvalReference = unsealed.approvalReference;
    }
  } else if (coords.kind === 'sealed') {
    manifest = {
      kind: 'sealed',
      attemptId: latestAttempt.id,
      manifestPath: coords.manifestPath,
      expectedManifestSha256: coords.expectedManifestSha256,
    };
  } else {
    manifest = { kind: 'uncollected' };
  }

  // The call keeps the workspace as its receiver: extracting the method
  // would lose `this`, and the adapter reads `this.options`.
  let rawResult: unknown;
  try {
    rawResult = await withBudget(
      workspace.removeWorktree.call(workspace, {
        repositoryRoot: clone.path,
        worktreeRoot: clone.worktreeRoot,
        worktreePath: latestAttempt.worktreePath,
        expectedHead: facts.head,
        expectedBranch: branchForRun(run.runId),
        expectedLastActivityIso: facts.lastActivity.iso,
        recordedHost,
        manifest,
      }),
      budget,
    );
  } catch {
    // A call cut short before the removal (or after it, ambiguously) leaves
    // state the next reap pass completes: reported unknown, never a guess.
    refused.push({ runId: run.runId, reason: 'unknown' });
    return;
  }
  const result = readRemoveResult(rawResult);
  if (result.kind === 'removed') {
    const failureReason = await recordRemovalJournalEntry(
      deps,
      latestAttempt,
      run.runId,
      nowIso,
      result.branchTip,
      budget,
      approvalReference,
    );
    if (failureReason !== null) {
      journalFailed.push({
        runId: run.runId,
        attemptId: latestAttempt.id,
        branchTip: result.branchTip,
        reason: failureReason,
      });
    }
    removed.push({ runId: run.runId, branchTip: result.branchTip });
  } else if (result.kind === 'refused') {
    refused.push({ runId: run.runId, reason: result.reason });
  } else {
    // `partial`, `unknown` or an unrecognised answer: the worktree may or may
    // not be removed. Reported as refused so the exit code says unresolved.
    refused.push({ runId: run.runId, reason: 'unknown' });
  }
}

/** The `outcome` of an adapter answer, or null when it is not a readable plain record. */
function readOutcomeOf(raw: unknown): unknown {
  try {
    const snap = snapshotPlainDataRecord(raw);
    return snap === null ? null : snap['outcome'];
  } catch {
    return null;
  }
}

type ValidatedRemovalFacts = {
  readonly head: string | null;
  readonly branch: string | null;
  readonly status: { readonly tracked: number; readonly untracked: number; readonly unmerged: number };
  readonly locked: boolean;
  readonly inProgressOperations: readonly unknown[];
  readonly lastActivity: { readonly iso: string | null; readonly unknown: boolean };
};

type InspectRead =
  | { readonly kind: 'inspected'; readonly facts: ValidatedRemovalFacts }
  | { readonly kind: 'not-a-linked-worktree' }
  | { readonly kind: 'unknown' };

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * The inspection answer as validated facts. Anything but a well-formed
 * `inspected` answer, or a `not-a-linked-worktree` refusal, is `unknown`:
 * a hostile or malformed answer is never read as clean, idle or empty.
 */
function readInspectResult(raw: unknown): InspectRead {
  try {
    const snap = snapshotPlainDataRecord(raw);
    if (snap === null) {
      return { kind: 'unknown' };
    }
    if (snap['outcome'] === 'refused') {
      return snap['reason'] === 'not-a-linked-worktree'
        ? { kind: 'not-a-linked-worktree' }
        : { kind: 'unknown' };
    }
    if (snap['outcome'] !== 'inspected') {
      return { kind: 'unknown' };
    }
    const facts = snapshotPlainDataRecord(snap['facts']);
    const status = facts === null ? null : snapshotPlainDataRecord(facts['status']);
    const lastActivity = facts === null ? null : snapshotPlainDataRecord(facts['lastActivity']);
    if (facts === null || status === null || lastActivity === null) {
      return { kind: 'unknown' };
    }
    const operations = readDenseArray(facts['inProgressOperations'], 4_096);
    const { head, branch, locked } = facts;
    const { tracked, untracked, unmerged } = status;
    const { iso, unknown } = lastActivity;
    if (
      operations.kind !== 'ok' ||
      typeof locked !== 'boolean' ||
      (branch !== null && typeof branch !== 'string') ||
      (head !== null && (typeof head !== 'string' || !COMMIT_HEX_RE.test(head))) ||
      !isNonNegativeSafeInteger(tracked) ||
      !isNonNegativeSafeInteger(untracked) ||
      !isNonNegativeSafeInteger(unmerged) ||
      typeof unknown !== 'boolean' ||
      (iso !== null && typeof iso !== 'string')
    ) {
      return { kind: 'unknown' };
    }
    return {
      kind: 'inspected',
      facts: {
        head: head as string | null,
        branch: branch as string | null,
        status: { tracked, untracked, unmerged },
        locked,
        inProgressOperations: operations.items,
        lastActivity: { iso: iso as string | null, unknown },
      },
    };
  } catch {
    return { kind: 'unknown' };
  }
}

type RemoveRead =
  | { readonly kind: 'removed'; readonly branchTip: string }
  | { readonly kind: 'refused'; readonly reason: string }
  | { readonly kind: 'unknown' };

/** The removal answer: only a declared refusal or a removal with a real tip is reported as such. */
function readRemoveResult(raw: unknown): RemoveRead {
  try {
    const snap = snapshotPlainDataRecord(raw);
    if (snap === null) {
      return { kind: 'unknown' };
    }
    const { outcome, branchTip, reason } = snap;
    if (outcome === 'removed' && typeof branchTip === 'string' && COMMIT_HEX_RE.test(branchTip)) {
      return { kind: 'removed', branchTip };
    }
    if (outcome === 'refused' && typeof reason === 'string' && DECLARED_REMOVE_REFUSALS.has(reason)) {
      return { kind: 'refused', reason };
    }
    return { kind: 'unknown' };
  } catch {
    return { kind: 'unknown' };
  }
}

/**
 * Ask the attempt's recorded runner what runs in its worktree. Only an
 * explicit `idle` is `idle`; `running` is `busy`; a missing runner, a missing
 * inspect method, a throw, a timeout or any other answer is `unknown`.
 */
async function worktreeRunnerLiveness(
  runnerForAttempt: RunnerForAttemptPort,
  attempt: AttemptRecord,
  recordedHost: AttemptRunnerRecord,
  budget: number,
): Promise<'idle' | 'busy' | 'unknown'> {
  let state: unknown;
  try {
    const selection: unknown = runnerForAttempt.runnerForAttempt({ runner: recordedHost });
    if (!isRecordObject(selection) || selection['ok'] !== true) {
      return 'unknown';
    }
    const runner = selection['runner'];
    if (typeof runner !== 'object' || runner === null) {
      return 'unknown';
    }
    const inspect = (runner as { inspectWorktreeRun?: unknown }).inspectWorktreeRun;
    if (typeof inspect !== 'function') {
      return 'unknown';
    }
    // Called on the runner: the production adapters read `this`.
    state = await withBudget(
      inspect.call(runner, {
        attemptId: attempt.id,
        worktreePath: attempt.worktreePath,
        runner: recordedHost,
      }) as Promise<unknown>,
      budget,
    );
  } catch {
    return 'unknown';
  }
  // A hostile runner response can be a Proxy with a throwing
  // `getPrototypeOf` trap or a throwing `state` getter, so the post-try reads
  // are guarded too: a non-plain or unreadable state is `unknown`.
  try {
    if (!isRecordObject(state)) {
      return 'unknown';
    }
    if (state['state'] === 'running') {
      return 'busy';
    }
    return state['state'] === 'idle' ? 'idle' : 'unknown';
  } catch {
    return 'unknown';
  }
}

/** The manifest coordinates handed to `removeWorktree` (mirrors the port type). */
type RemoveWorktreeManifestInput = Parameters<NonNullable<WorkspacePort['removeWorktree']>>[0]['manifest'];

type UnsealedAuthorizationOutcome =
  | {
      readonly outcome: 'authorized';
      readonly manifest: RemoveWorktreeManifestInput;
      readonly approvalReference: string;
    }
  | { readonly outcome: 'refused'; readonly reason: string };

/**
 * C2': the `--force-unsealed` authorization path. Records a
 * crash-recoverable intent journal entry before asking, then consumes a
 * scoped one-way owner approval; the recorded approval reference travels into
 * the removal request (which re-runs every git and activity guard) and into
 * the completed journal entry. A blocked or unknown authorization consumes
 * nothing and removes nothing.
 */
async function authorizeUnsealedRemoval(
  params: ReapCandidateWorktreeParams,
  priorEntries: readonly ActionJournalEntryRecord[],
  expectedHeadSha: string,
): Promise<UnsealedAuthorizationOutcome> {
  const { deps, run, latestAttempt, workOrder, clone, nowIso, budget } = params;
  const authorize = deps.actionAuthorization?.authorizeUnsealedWorktreeRemoval;
  if (authorize === undefined) {
    return { outcome: 'refused', reason: 'not-configured' };
  }
  const intentId = unsealedIntentEntryId(latestAttempt.id, run.runId);
  const requestDigest = unsealedRemovalRequestDigest(
    {
      attemptId: latestAttempt.id,
      expectedHeadSha,
      projectId: workOrder.projectId,
      repositoryRoot: clone.path,
      runId: run.runId,
      worktreePath: latestAttempt.worktreePath,
      worktreeRoot: clone.worktreeRoot,
    },
    deps.computeDigest ?? simpleDeterministicHexDigest,
  );
  if (!/^[0-9a-f]{64}$/.test(requestDigest)) {
    return { outcome: 'refused', reason: 'unknown' };
  }
  // F129: any prior intent of this attempt must be exactly this request;
  // a retry under a changed id or coordinate is refused before any write.
  const intentPrefix = unsealedIntentPrefix(latestAttempt.id);
  const priorIntents = priorEntries.filter(
    (entry) =>
      isRecordObject(entry) &&
      ((typeof entry['id'] === 'string' && entry['id'].startsWith(intentPrefix)) ||
        (entry['action'] === 'collect' &&
          entry['status'] === 'intent-recorded' &&
          typeof entry['detail'] === 'string' &&
          entry['detail'].startsWith('Authorizing unsealed worktree removal'))),
  );
  if (priorIntents.length > 0) {
    const prior = priorIntents[0];
    const priorDetail = isRecordObject(prior) ? prior['detail'] : undefined;
    if (
      priorIntents.length !== 1 ||
      !isRecordObject(prior) ||
      prior['id'] !== intentId ||
      typeof priorDetail !== 'string' ||
      INTENT_DIGEST_RE.exec(priorDetail)?.[1] !== requestDigest
    ) {
      return { outcome: 'refused', reason: 'intent-digest-mismatch' };
    }
  } else {
    try {
      await withBudget(
        deps.executionJournal.appendJournalEntry({
          id: intentId,
          attemptId: latestAttempt.id,
          workOrderId: latestAttempt.workOrderId,
          action: 'collect',
          baseCommit: latestAttempt.baseCommit,
          recordedAtIso: nowIso,
          status: 'intent-recorded',
          sessionId: null,
          detail:
            `Authorizing unsealed worktree removal for attempt ${latestAttempt.id} ` +
            `on branch ${branchForRun(run.runId)}; requestDigest=${requestDigest}`,
        }),
        budget,
      );
    } catch {
      return { outcome: 'refused', reason: 'unknown' };
    }
  }
  let rawAnswer: unknown;
  try {
    rawAnswer = await withBudget(
      authorize.call(deps.actionAuthorization as object, {
        projectId: workOrder.projectId,
        runId: run.runId,
        attemptId: latestAttempt.id,
        worktreePath: latestAttempt.worktreePath,
        expectedHeadSha,
        nowIso,
      }),
      budget,
    );
  } catch {
    return { outcome: 'refused', reason: 'unknown' };
  }
  let answer: Record<string, unknown> | null;
  try {
    answer = snapshotPlainDataRecord(rawAnswer);
  } catch {
    answer = null;
  }
  if (answer === null) {
    return { outcome: 'refused', reason: 'unknown' };
  }
  if (answer['outcome'] === 'blocked') {
    return { outcome: 'refused', reason: 'unapproved-force-unsealed' };
  }
  const approvalReference = answer['approvalReference'];
  if (answer['outcome'] !== 'approved' || !isSafeIdentifier(approvalReference)) {
    return { outcome: 'refused', reason: 'unknown' };
  }
  return {
    outcome: 'authorized',
    manifest: {
      kind: 'force-unsealed',
      attemptId: latestAttempt.id,
      approvalReference,
    },
    approvalReference,
  };
}

/**
 * Append one `collect` journal entry on the latest attempt recording the
 * removal, the kept branch's tip and — when the removal was force-unsealed —
 * the consumed approval reference. The worktree path is never written into
 * `detail`. On any failure the primary append is retried as a best-effort
 * `ambiguous` entry carrying the sanitised failure reason, and the reason is
 * returned so the caller can report the removal in `journalFailed`; never
 * throws.
 */
async function recordRemovalJournalEntry(
  deps: ReapLaneWorktreesDependencies,
  attempt: AttemptRecord,
  runId: string,
  nowIso: string,
  branchTip: string,
  budget: number,
  approvalReference?: string,
): Promise<string | null> {
  const detail =
    `Removed the lane worktree for attempt ${attempt.id}; ` +
    `branch ${branchForRun(runId)} kept at ${branchTip}` +
    (approvalReference !== undefined ? `; approvalRef=${approvalReference}` : '');
  try {
    const rawEntries: unknown = await withBudget(
      deps.executionJournal.listJournalEntriesForAttempt(attempt.id),
      budget,
    );
    const dense = readDenseArray(rawEntries, MAX_ATTEMPT_JOURNAL_ENTRIES);
    if (dense.kind !== 'ok') {
      throw new Error('journal entries unreadable');
    }
    const listed: Record<string, unknown>[] = [];
    for (const item of dense.items) {
      const snap = snapshotPlainDataRecord(item);
      if (snap === null) {
        throw new Error('journal entries unreadable');
      }
      listed.push(snap);
    }
    const intentPrefix = unsealedIntentPrefix(attempt.id);
    // Intent entries never consume a sequence number, so the completed id
    // stays `${attempt.id}:collect:${nonIntentCount + 1}` — `1` for a plain
    // sealed removal. A retry that would collide falls back to a keyed id.
    const nonIntentCount = listed.filter(
      (entry) => !(typeof entry['id'] === 'string' && entry['id'].startsWith(intentPrefix)),
    ).length;
    let id = `${attempt.id}:collect:${nonIntentCount + 1}`;
    if (listed.some((entry) => entry['id'] === id)) {
      id = `${attempt.id}:collect:completed:${runId}`;
    }
    await withBudget(
      deps.executionJournal.appendJournalEntry({
        id,
        attemptId: attempt.id,
        workOrderId: attempt.workOrderId,
        action: 'collect',
        baseCommit: attempt.baseCommit,
        recordedAtIso: nowIso,
        status: 'completed',
        sessionId: null,
        detail,
      }),
      budget,
    );
    return null;
  } catch (error) {
    const reason = sanitizeJournalFailureReason(error);
    // Best-effort fallback: record the failed append as ambiguous evidence.
    try {
      await withBudget(
        deps.executionJournal.appendJournalEntry({
          id: `${attempt.id}:collect:reap-journal-failed:${runId}:${nowIso}`,
          attemptId: attempt.id,
          workOrderId: attempt.workOrderId,
          action: 'collect',
          baseCommit: attempt.baseCommit,
          recordedAtIso: nowIso,
          status: 'ambiguous',
          sessionId: null,
          detail:
            `Removed the lane worktree for attempt ${attempt.id} ` +
            `(branch ${branchForRun(runId)} kept at ${branchTip}); ` +
            `journal append failed: ${reason}`,
        }),
        budget,
      );
    } catch {
      // Even the fallback append failed; the failure still surfaces via `journalFailed`.
    }
    return reason;
  }
}

/**
 * A safe, non-secret reason for a failed journal append: the trimmed error
 * message, or `journal-append-failed` when there is none, redacted when it
 * matches a secret shape, a lane-diff secret pattern or carries a filesystem
 * path, and capped at 500 characters.
 */
function sanitizeJournalFailureReason(error: unknown): string {
  const message =
    error instanceof Error && error.message.trim().length > 0
      ? error.message.trim()
      : 'journal-append-failed';
  const carriesPath = message.includes('/') || message.includes('\\');
  if (
    containsSecretShape(message) ||
    LANE_DIFF_SECRET_PATTERNS.some((pattern) => pattern.regex.test(message)) ||
    carriesPath
  ) {
    return 'journal-append-failed (redacted)';
  }
  return message.slice(0, 500);
}
