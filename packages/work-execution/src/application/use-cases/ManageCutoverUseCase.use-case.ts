/**
 * ManageCutoverUseCase (lanes CO30a and CO30b): `status` reads the cutover
 * record and the stores a cutover depends on and writes nothing; `rollback`
 * pauses the daemon, lifts only the train pause the cutover itself set, and
 * saves the rolled-back record by compare-and-set; `switch` is the one-way
 * door, refused unless the shadow criteria evidence passes and every
 * precondition holds, then it sets the train pause and saves the switched
 * record; `retire` closes the record once the 14-day rollback window has
 * passed (it consults no grant: the window is the gate) and lifts a pause the
 * cutover itself set.
 *
 * A move is keyed `cutover/<move>@<expectedRevision>`: the intent carries a
 * digest of the full request and is checked on replay before any write, every
 * outbound call is deadline-guarded, and a pass cut short at any step is finished
 * by the next pass, with one exception: a switch or retire that crashed after
 * its record save but before its result append is not finished on replay. The
 * saved record no longer meets the move's precondition, so a replayed switch
 * answers `revision-conflict` and a replayed retire answers `not-switched`.
 * An unreadable or unknown-version store is `unknown`, never a
 * default. Nothing here echoes a path or a raw input value.
 */

import { containsSecretShape, LANE_DIFF_SECRET_PATTERNS } from '@fleet/shared';
import { isZonedIsoDateTime } from '../../domain/conductor-halt.js';
import {
  CUTOVER_RETIREMENT_SCRIPTS,
  CUTOVER_SHADOW_CRITERIA,
  MAX_CUTOVER_JOURNAL_ENTRIES,
  buildShadowParkJournalPayload,
  canonicalCutoverRetirePayload,
  canonicalCutoverRollbackPayload,
  canonicalCutoverSwitchPayload,
  checkCutoverJournalCapacity,
  cutoverJournalKey,
  cutoverShadowParkKey,
  isWithinCutoverRollbackWindow,
  readCutoverShadowEvidence,
  readCutoverShadowParkRecord,
  readRetirementLedger,
  type CutoverRecord,
  type CutoverShadowParkRecord,
} from '../../domain/cutover-records.js';
import { buildReleasedParkEntry } from '../../domain/merge-pass-transitions.js';
import { readMergeQueueEntryRecord, type MergeQueueEntryRecord } from '../../domain/merge-queue-records.js';
import { readBoundedDenseArray, snapshotPlainDataRecord } from '../../domain/plain-record-reads.js';
import type {
  ManageCutoverPort,
  ManageCutoverRefusalReason,
  ManageCutoverResult,
  ManageCutoverRetireRequest,
  ManageCutoverRollbackRequest,
  ManageCutoverStatusRequest,
  ManageCutoverSwitchRequest,
  ManageCutoverUnknownReason,
} from '../ports/in/ManageCutoverPort.in-port.js';
import type { CutoverJournalEntry, CutoverJournalPort } from '../ports/out/CutoverJournalPort.out-port.js';
import type {
  CutoverRecordReadResult,
  CutoverRecordRepositoryPort,
} from '../ports/out/CutoverRecordRepositoryPort.out-port.js';
import type { DaemonPausePort } from '../ports/out/DaemonPausePort.out-port.js';
import type { DaemonStatusPort } from '../ports/out/DaemonStatusPort.out-port.js';
import type { KillallTrainPausePort } from '../ports/out/KillallTrainPausePort.out-port.js';
import type { MergePolicyPort } from '../ports/out/MergePolicyPort.out-port.js';
import type { MergeQueueRepositoryPort } from '../ports/out/MergeQueueRepositoryPort.out-port.js';

export interface ManageCutoverDependencies {
  readonly cutoverRepo: CutoverRecordRepositoryPort;
  readonly cutoverJournal: CutoverJournalPort;
  readonly daemonStatus: Pick<DaemonStatusPort, 'read'>;
  /** A read-only handle, so `status` never quarantines a corrupt pause file. */
  readonly daemonPauseRead: Pick<DaemonPausePort, 'read'>;
  readonly daemonPause: DaemonPausePort;
  /** A read-only handle, so `status` never quarantines a corrupt train-pause file. */
  readonly trainPauseRead: Pick<KillallTrainPausePort, 'read'>;
  readonly trainPause: KillallTrainPausePort;
  readonly computeDigest: (text: string) => string;
  readonly mintEntryId: () => string;
  readonly nowIso: () => string;
  /**
   * CO30b, optional: the shadow-evidence document the switch move demands.
   * `apps/cli/src/composition.ts` binds it in durable-state mode and leaves
   * it `undefined` only in in-memory mode, where a missing reader is still a
   * refusal, never a pass.
   */
  readonly readShadowEvidence?: () => Promise<
    { readonly status: 'ok'; readonly evidence: unknown } | { readonly status: 'absent' } | { readonly status: 'unreadable' } | { readonly status: 'unknown-version' }
  >;
  /** CO30b, optional: how many lanes hold work no attempt record explains. */
  readonly countUnrecordedLanes?: () => Promise<
    | { readonly status: 'ok'; readonly unrecorded: number; readonly unknownListings: number }
    | { readonly status: 'unreadable' }
    | { readonly status: 'refused'; readonly reason: 'conductor-driver-live' }
  >;
  /**
   * BL14b, optional: the stored §1 cutover-plan retirement ledger the retire
   * move demands. The production runtime wires it only over durable state; a
   * missing reader is a refusal, never a pass.
   */
  readonly readRetirementLedger?: () => Promise<
    | { readonly status: 'ok'; readonly ledger: unknown }
    | { readonly status: 'absent' }
    | { readonly status: 'unreadable' }
    | { readonly status: 'unknown-version' }
  >;
  /**
   * SW2b2, optional: the read handle the switch lists the merge queue through.
   * Composition binds a read-only adapter over durable state so a switch never
   * reaches the writable queue through this seam; a missing reader is a
   * refusal, never a pass.
   */
  readonly mergeQueueRead?: Pick<MergeQueueRepositoryPort, 'listMergeEntries'>;
  /** SW2b2, optional: the writable handle that releases a shadow park back to `queued`. */
  readonly mergeQueue?: Pick<MergeQueueRepositoryPort, 'listMergeEntries' | 'applyMergeTransition'>;
  /** SW2b2, optional: the merge policy that names which repositories run under shadow. */
  readonly mergePolicy?: Pick<MergePolicyPort, 'readMergePolicy'>;
  /**
   * SW2b2, optional: the separate shadow-park journal (`shadow-park-journal.json`).
   * Never the cutover journal; a missing journal is a refusal, never a pass.
   */
  readonly shadowParkJournal?: CutoverJournalPort;
}

const MAX_REQUEST_KEYS = 8;
const MAX_STRING_LENGTH = 256;
const MAX_ISO_LENGTH = 64;
const MAX_REVISION = 1_000_000_000;
const OPERATION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const RELAUNCH_DIGEST = /^[0-9a-f]{64}$/;
const STATUS_KEYS: readonly string[] = ['move', 'nowIso', 'deadlineIso'];
const ROLLBACK_KEYS: readonly string[] = ['move', 'expectedRevision', 'operationId', 'nowIso', 'deadlineIso'];
const SWITCH_KEYS: readonly string[] = [
  'move', 'expectedRevision', 'operationId', 'relaunchPlanDigest', 'nowIso', 'deadlineIso',
];
const RETIRE_KEYS: readonly string[] = ['move', 'expectedRevision', 'operationId', 'nowIso', 'deadlineIso'];
/**
 * SW2b2: the deadline every shadow-park queue read and write carries when the
 * switch request itself names none. A queue call the request deadline cannot
 * bound still fails closed on this one.
 */
const DEFAULT_SWITCH_DEADLINE_MS = 60_000;
/** The most merge-policy repositories one switch reads before refusing. */
const MAX_MERGE_POLICY_REPOS = 500;
/** The most merge-queue entries one switch lists before refusing. */
const MAX_MERGE_QUEUE_ENTRIES = 10_000;
/** The most shadow-park journal entries one switch lists before refusing. */
const MAX_SHADOW_PARK_JOURNAL_ENTRIES = MAX_CUTOVER_JOURNAL_ENTRIES;

/** The release counts a completed switch reports (SW2b2). */
interface SwitchParkCounts {
  readonly releasedParks: number;
  readonly vetoHoldParks: number;
}

/**
 * One shadow-repo ordinary `parked` entry the switch plans to journal and
 * release, built entirely before any write so a planning refusal leaves the
 * journals and the queue untouched (SW2b2).
 */
interface PlannedShadowPark {
  readonly entry: MergeQueueEntryRecord;
  readonly parkKey: string;
  readonly record: CutoverShadowParkRecord;
  readonly priorDigest: string;
  readonly releasedRecord: MergeQueueEntryRecord;
  /** True once this pass found the park's intent already recorded in the shadow-park journal. */
  recordedIntent: boolean;
}

type ParsedRequest =
  | {
      readonly ok: true;
      readonly request:
        | ManageCutoverStatusRequest
        | ManageCutoverRollbackRequest
        | ManageCutoverSwitchRequest
        | ManageCutoverRetireRequest;
    }
  | { readonly ok: false; readonly reason: ManageCutoverRefusalReason };

/** The outcome of one guarded outbound call. */
type Guarded<T> =
  | { readonly kind: 'value'; readonly value: T }
  | { readonly kind: 'deadline' }
  | { readonly kind: 'threw' };

function refuse(reason: ManageCutoverRefusalReason): ManageCutoverResult {
  return { outcome: 'refused', reason };
}

/** A refusal that names the shadow criterion codes it failed; ids and codes only. */
function refuseWith(reason: ManageCutoverRefusalReason, failed: readonly string[]): ManageCutoverResult {
  return { outcome: 'refused', reason, failed };
}

function unknown(reason: ManageCutoverUnknownReason): ManageCutoverResult {
  return { outcome: 'unknown', reason };
}

function isSecretShaped(text: string): boolean {
  return containsSecretShape(text) || LANE_DIFF_SECRET_PATTERNS.some((pattern) => pattern.regex.test(text));
}

function isBoundedIso(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_ISO_LENGTH && isZonedIsoDateTime(value);
}

function normalizeIso(iso: string): string {
  return new Date(Date.parse(iso)).toISOString();
}

function parseRequest(input: unknown): ParsedRequest {
  const snapshot = snapshotPlainDataRecord(input);
  if (snapshot === null || Object.keys(snapshot).length > MAX_REQUEST_KEYS) {
    return { ok: false, reason: 'invalid-request' };
  }
  const values = Object.values(snapshot);
  if (values.some((value) => typeof value === 'string' && value.length > MAX_STRING_LENGTH)) {
    return { ok: false, reason: 'invalid-request' };
  }
  if (values.some((value) => typeof value === 'string' && isSecretShaped(value))) {
    return { ok: false, reason: 'secret-shaped' };
  }
  const { move } = snapshot;
  if (move === 'status') {
    return parseStatus(snapshot);
  }
  if (move === 'rollback') {
    return parseRollback(snapshot);
  }
  if (move === 'switch') {
    return parseSwitch(snapshot);
  }
  if (move === 'retire') {
    return parseRetire(snapshot);
  }
  return { ok: false, reason: 'invalid-request' };
}

function hasOnlyKeys(snapshot: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(snapshot).every((key) => allowed.includes(key));
}

function parseStatus(snapshot: Record<string, unknown>): ParsedRequest {
  const { nowIso, deadlineIso } = snapshot;
  if (
    !hasOnlyKeys(snapshot, STATUS_KEYS) ||
    (nowIso !== undefined && !isBoundedIso(nowIso)) ||
    (deadlineIso !== undefined && !isBoundedIso(deadlineIso))
  ) {
    return { ok: false, reason: 'invalid-request' };
  }
  return {
    ok: true,
    request: {
      move: 'status',
      ...(nowIso === undefined ? {} : { nowIso }),
      ...(deadlineIso === undefined ? {} : { deadlineIso }),
    },
  };
}

/** The fields every revisioned move carries: key set, revision floor, operation id and timestamps. */
function hasValidMoveFields(
  snapshot: Record<string, unknown>,
  allowedKeys: readonly string[],
  minRevision: number,
): boolean {
  const { expectedRevision, operationId, nowIso, deadlineIso } = snapshot;
  return (
    hasOnlyKeys(snapshot, allowedKeys) &&
    typeof expectedRevision === 'number' &&
    Number.isSafeInteger(expectedRevision) &&
    expectedRevision >= minRevision &&
    expectedRevision <= MAX_REVISION &&
    typeof operationId === 'string' &&
    OPERATION_ID.test(operationId) &&
    isBoundedIso(nowIso) &&
    (deadlineIso === undefined || isBoundedIso(deadlineIso))
  );
}

/** The request of a move whose fields `hasValidMoveFields` already proved, plus any `extra` fields. */
function moveRequestFrom(
  snapshot: Record<string, unknown>,
  move: 'rollback' | 'switch' | 'retire',
  extra: Record<string, unknown>,
): ParsedRequest {
  const { expectedRevision, operationId, nowIso, deadlineIso } = snapshot;
  return {
    ok: true,
    request: {
      move,
      expectedRevision,
      operationId,
      ...extra,
      nowIso,
      ...(deadlineIso === undefined ? {} : { deadlineIso }),
    },
  } as ParsedRequest;
}

function parseRollback(snapshot: Record<string, unknown>): ParsedRequest {
  if (!hasValidMoveFields(snapshot, ROLLBACK_KEYS, 1)) {
    return { ok: false, reason: 'invalid-request' };
  }
  return moveRequestFrom(snapshot, 'rollback', {});
}

/** Switch allows revision 0 (the one-way door runs on an unrecorded cutover); the digest is 64 lowercase hex. */
function parseSwitch(snapshot: Record<string, unknown>): ParsedRequest {
  const { relaunchPlanDigest } = snapshot;
  if (
    !hasValidMoveFields(snapshot, SWITCH_KEYS, 0) ||
    typeof relaunchPlanDigest !== 'string' ||
    !RELAUNCH_DIGEST.test(relaunchPlanDigest)
  ) {
    return { ok: false, reason: 'invalid-request' };
  }
  return moveRequestFrom(snapshot, 'switch', { relaunchPlanDigest });
}

/** Retire only follows a recorded switch, so its revision starts at 1. */
function parseRetire(snapshot: Record<string, unknown>): ParsedRequest {
  if (!hasValidMoveFields(snapshot, RETIRE_KEYS, 1)) {
    return { ok: false, reason: 'invalid-request' };
  }
  return moveRequestFrom(snapshot, 'retire', {});
}

/** A completed switch or retire result, keys in the order the shipped moves print them. */
function completedResult(
  kind: MoveKind,
  key: string,
  replayed: boolean,
  record: CutoverRecord,
  parkCounts: SwitchParkCounts = { releasedParks: 0, vetoHoldParks: 0 },
): ManageCutoverResult {
  return {
    outcome: 'completed',
    move: kind.move,
    key,
    replayed,
    state: kind.state,
    revision: record.revision,
    record,
    ...(kind.move === 'switch' ? { releasedParks: parkCounts.releasedParks, vetoHoldParks: parkCounts.vetoHoldParks } : {}),
  } as ManageCutoverResult;
}

/** Whether two validated shadow-park records name the same park, field for field (SW2b2). */
function sameShadowParkRecord(left: CutoverShadowParkRecord, right: CutoverShadowParkRecord): boolean {
  return (
    left.entryId === right.entryId &&
    left.repository.owner === right.repository.owner &&
    left.repository.repo === right.repository.repo &&
    left.pullRequest === right.pullRequest &&
    left.headOid === right.headOid &&
    left.reason === right.reason &&
    left.attempt === right.attempt &&
    left.notBeforeIso === right.notBeforeIso
  );
}

/**
 * What a switch pass knows about the train pause before it sets it: the digest its intent
 * carries, whether the train was already paused when the intent was appended, and whether this
 * pass found that intent (a replay) or appends it.
 */
interface SwitchIntentPlan {
  readonly digest: string;
  readonly trainPausedBefore: boolean;
  readonly replay: boolean;
}

/**
 * Whether the switched record credits the train pause to the cutover; rollback and retire lift
 * the pause only when it does.
 *  - `set` answered `changed`, on any pass: this move set the pause, so the cutover owns it.
 *  - `unchanged` on the pass that appended the intent: the pause was there before this move
 *    wrote anything, so it is someone else's and is never claimed.
 *  - `unchanged` on a replay: the pause is the cutover's unless the intent recorded that the
 *    train was already paused before the first pass.
 * Residual: a replay that gets `unchanged` cannot tell its earlier pass's pause from one an
 * operator set after the intent. A crash before `set` followed by an operator pause, and an
 * operator lift then re-pause, both leave such a pause recorded as the cutover's.
 */
function switchOwnsTrainPause(outcome: 'changed' | 'unchanged', plan: SwitchIntentPlan): boolean {
  if (outcome === 'changed') {
    return true;
  }
  if (!plan.replay) {
    return false;
  }
  return !plan.trainPausedBefore;
}

type MoveKind = { readonly move: 'switch'; readonly state: 'switched' } | { readonly move: 'retire'; readonly state: 'retired' };
const SWITCH_KIND: MoveKind = { move: 'switch', state: 'switched' };
const RETIRE_KIND: MoveKind = { move: 'retire', state: 'retired' };

export class ManageCutoverUseCase implements ManageCutoverPort {
  constructor(private readonly deps: ManageCutoverDependencies) {}

  async execute(request: unknown): Promise<ManageCutoverResult> {
    try {
      const parsed = parseRequest(request);
      if (!parsed.ok) {
        return refuse(parsed.reason);
      }
      switch (parsed.request.move) {
        case 'status':
          return await this.status(parsed.request);
        case 'rollback':
          return await this.rollback(parsed.request);
        case 'switch':
          return await this.switchMove(parsed.request);
        case 'retire':
          return await this.retireMove(parsed.request);
      }
    } catch {
      return refuse('invalid-request');
    }
  }

  /** True once `deadlineIso` is reached; an unusable clock counts as reached (fail closed). */
  private deadlineReached(deadlineIso: string | undefined): boolean {
    if (deadlineIso === undefined) {
      return false;
    }
    try {
      return !(Date.parse(this.deps.nowIso()) < Date.parse(deadlineIso));
    } catch {
      return true;
    }
  }

  /** Every outbound call goes through here: deadline first, then the call, never a throw. */
  private async guarded<T>(deadlineIso: string | undefined, call: () => Promise<T>): Promise<Guarded<T>> {
    if (this.deadlineReached(deadlineIso)) {
      return { kind: 'deadline' };
    }
    try {
      return { kind: 'value', value: await call() };
    } catch {
      return { kind: 'threw' };
    }
  }

  private async status(request: ManageCutoverStatusRequest): Promise<ManageCutoverResult> {
    const { deadlineIso } = request;
    const cutover = await this.readCutover(deadlineIso);
    if ('stop' in cutover) {
      return cutover.stop;
    }
    const { record } = cutover;

    const daemonStatus = await this.guarded(deadlineIso, () => this.deps.daemonStatus.read());
    if (daemonStatus.kind === 'deadline') return unknown('deadline-exceeded');
    if (daemonStatus.kind === 'threw') return unknown('daemon-status-unreadable');
    const statusRead = daemonStatus.value;
    if (statusRead.status !== 'ok' && statusRead.status !== 'missing') {
      return unknown('daemon-status-unreadable');
    }

    const daemonPause = await this.guarded(deadlineIso, () => this.deps.daemonPauseRead.read());
    if (daemonPause.kind === 'deadline') return unknown('deadline-exceeded');
    if (daemonPause.kind === 'threw') return unknown('daemon-pause-unreadable');
    const pauseState = daemonPause.value.state;
    if (pauseState !== 'paused' && pauseState !== 'clear') {
      return unknown('daemon-pause-unreadable');
    }

    const trainPause = await this.guarded(deadlineIso, () => this.deps.trainPauseRead.read());
    if (trainPause.kind === 'deadline') return unknown('deadline-exceeded');
    if (trainPause.kind === 'threw') return unknown('train-pause-unreadable');
    const trainState = trainPause.value.status;
    if (trainState !== 'paused' && trainState !== 'clear') {
      return unknown('train-pause-unreadable');
    }

    return {
      outcome: 'completed',
      move: 'status',
      state: record === null ? 'shadow' : record.state,
      revision: record === null ? 0 : record.revision,
      record,
      daemonStatus: statusRead.status === 'ok' ? 'present' : 'missing',
      daemonLastTickOutcome: statusRead.status === 'ok' ? (statusRead.record.exitCode === 0 ? 'ok' : 'failed') : null,
      daemonPause: pauseState,
      trainPause: trainState,
      withinRollbackWindow: this.withinWindow(record, request.nowIso),
    };
  }

  private withinWindow(record: CutoverRecord | null, requestNowIso: string | undefined): boolean | null {
    if (record === null || record.switchedAtIso === null) {
      return null;
    }
    try {
      return isWithinCutoverRollbackWindow(record.switchedAtIso, requestNowIso ?? this.deps.nowIso());
    } catch {
      return null;
    }
  }

  /** The stored record (null when known absent), or the `unknown` result for a read that proved neither. */
  private async readCutover(
    deadlineIso: string | undefined,
  ): Promise<{ readonly record: CutoverRecord | null } | { readonly stop: ManageCutoverResult }> {
    const read = await this.guarded(deadlineIso, () => this.deps.cutoverRepo.read({ deadlineIso }));
    if (read.kind === 'deadline') return { stop: unknown('deadline-exceeded') };
    if (read.kind === 'threw') return { stop: unknown('cutover-record-unreadable') };
    const result: CutoverRecordReadResult = read.value;
    if (result.status === 'ok') return { record: result.record };
    if (result.status === 'missing') return { record: null };
    return {
      stop: unknown(result.status === 'unknown-version' ? 'cutover-record-unknown-version' : 'cutover-record-unreadable'),
    };
  }

  private async rollback(request: ManageCutoverRollbackRequest): Promise<ManageCutoverResult> {
    const { expectedRevision, deadlineIso } = request;
    const key = cutoverJournalKey('rollback', expectedRevision);
    if (key === null) {
      return refuse('invalid-request');
    }
    const requestDigest = this.deps.computeDigest(
      canonicalCutoverRollbackPayload({ expectedRevision, operationId: request.operationId }),
    );

    const listed = await this.guarded(deadlineIso, () => this.deps.cutoverJournal.listByKeyPrefix(key));
    if (listed.kind === 'deadline') return unknown('deadline-exceeded');
    if (listed.kind === 'threw' || listed.value.outcome !== 'listed' || !Array.isArray(listed.value.entries)) {
      return unknown('journal-unreadable');
    }
    // A prefix match also lists `cutover/rollback@10` for `@1`; only the exact key is this move.
    const entries = listed.value.entries.filter((entry) => entry.key === key);
    const intentEntry = entries.find((entry) => entry.kind === 'intent');
    const finalEntry = entries.find((entry) => entry.kind === 'result' && entry.outcome !== 'ambiguous');

    if (intentEntry !== undefined && intentEntry.digest !== requestDigest) {
      return refuse('intent-digest-mismatch');
    }

    if (finalEntry !== undefined) {
      return this.replayFinal(finalEntry, key, deadlineIso);
    }

    const cutover = await this.readCutover(deadlineIso);
    if ('stop' in cutover) {
      return cutover.stop;
    }
    const { record } = cutover;
    const pausesFailure = await this.pausesReadFailure(deadlineIso);
    if (pausesFailure !== null) {
      return pausesFailure;
    }
    const normalizedNowIso = normalizeIso(request.nowIso);

    if (intentEntry === undefined) {
      const refusal = this.freshRefusal(record, request, normalizedNowIso);
      if (refusal !== null) {
        return refusal;
      }
      const intent = await this.guarded(deadlineIso, () =>
        this.deps.cutoverJournal.append({
          key,
          kind: 'intent',
          entryId: this.deps.mintEntryId(),
          recordedAtIso: normalizedNowIso,
          digest: requestDigest,
        }),
      );
      if (intent.kind === 'deadline') return unknown('deadline-exceeded');
      if (intent.kind === 'threw' || intent.value.outcome !== 'appended') {
        return unknown('journal-append-failed');
      }
    }

    const saved = await this.applyRollback(record, request, normalizedNowIso);
    if ('outcome' in saved) {
      return saved;
    }

    const result = await this.guarded(deadlineIso, () =>
      this.deps.cutoverJournal.append({
        key,
        kind: 'result',
        entryId: this.deps.mintEntryId(),
        recordedAtIso: saved.record.updatedAtIso,
        outcome: 'completed',
        reasonCode: 'rolled-back',
        digest: requestDigest,
      }),
    );
    if (result.kind === 'deadline') return unknown('deadline-exceeded');
    const appended =
      result.kind === 'value' &&
      (result.value.outcome === 'appended' || result.value.reason === 'result-after-final-result');
    if (!appended) {
      return unknown('journal-append-failed');
    }
    return {
      outcome: 'completed',
      move: 'rollback',
      key,
      replayed: false,
      state: 'rolled-back',
      revision: saved.record.revision,
      record: saved.record,
    };
  }

  /** A completed move returns its recorded outcome with no write; a refused one stays refused. */
  private async replayFinal(
    finalEntry: CutoverJournalEntry,
    key: string,
    deadlineIso: string | undefined,
  ): Promise<ManageCutoverResult> {
    if (finalEntry.outcome === 'refused') {
      return refuse('journal-refused');
    }
    const cutover = await this.readCutover(deadlineIso);
    if ('stop' in cutover) {
      return cutover.stop;
    }
    const read = cutover.record;
    if (read === null) {
      return unknown('cutover-record-unreadable');
    }
    if (read.state !== 'rolled-back') {
      return refuse('revision-conflict');
    }
    return {
      outcome: 'completed',
      move: 'rollback',
      key,
      replayed: true,
      state: 'rolled-back',
      revision: read.revision,
      record: read,
    };
  }

  /** Both pause stores must be readable before a rollback moves anything. */
  private async pausesReadFailure(deadlineIso: string | undefined): Promise<ManageCutoverResult | null> {
    const daemonPause = await this.guarded(deadlineIso, () => this.deps.daemonPauseRead.read());
    if (daemonPause.kind === 'deadline') return unknown('deadline-exceeded');
    if (daemonPause.kind === 'threw' || (daemonPause.value.state !== 'paused' && daemonPause.value.state !== 'clear')) {
      return unknown('daemon-pause-unreadable');
    }
    const trainPause = await this.guarded(deadlineIso, () => this.deps.trainPauseRead.read());
    if (trainPause.kind === 'deadline') return unknown('deadline-exceeded');
    if (trainPause.kind === 'threw' || (trainPause.value.status !== 'paused' && trainPause.value.status !== 'clear')) {
      return unknown('train-pause-unreadable');
    }
    return null;
  }

  /** The refusal for a rollback with no intent yet, decided before anything is recorded. */
  private freshRefusal(
    record: CutoverRecord | null,
    request: ManageCutoverRollbackRequest,
    normalizedNowIso: string,
  ): ManageCutoverResult | null {
    if (record === null) {
      return refuse('not-switched');
    }
    if (record.revision !== request.expectedRevision) {
      return refuse('revision-conflict');
    }
    if (record.state !== 'switched' || record.switchedAtIso === null) {
      return refuse('not-switched');
    }
    if (Date.parse(normalizedNowIso) < Date.parse(record.switchedAtIso)) {
      return refuse('invalid-clock');
    }
    return null;
  }

  /**
   * The crash-recoverable action sequence, for a fresh move and for a replay with a verified digest. Case A: the
   * record is still `switched`; case B: an earlier pass already saved the rolled-back record.
   */
  private async applyRollback(
    record: CutoverRecord | null,
    request: ManageCutoverRollbackRequest,
    normalizedNowIso: string,
  ): Promise<ManageCutoverResult | { readonly record: CutoverRecord }> {
    const { expectedRevision, deadlineIso } = request;
    if (record === null) {
      return refuse('revision-conflict');
    }
    const caseB = record.revision === expectedRevision + 1 && record.state === 'rolled-back';
    const caseA = record.revision === expectedRevision && record.state === 'switched' && record.switchedAtIso !== null;
    if (!caseA && !caseB) {
      return refuse('revision-conflict');
    }
    if (caseA && Date.parse(normalizedNowIso) < Date.parse(record.switchedAtIso as string)) {
      return refuse('invalid-clock');
    }

    const paused = await this.guarded(deadlineIso, () => this.deps.daemonPause.write(true, normalizedNowIso));
    if (paused.kind === 'deadline') return unknown('deadline-exceeded');
    if (paused.kind === 'threw' || !paused.value.ok) return unknown('daemon-pause-write-failed');
    if (caseB) {
      return { record };
    }

    if (record.trainPauseSetByCutover) {
      const lifted = await this.guarded(deadlineIso, () =>
        this.deps.trainPause.set({ paused: false, nowIso: normalizedNowIso }),
      );
      if (lifted.kind === 'deadline') return unknown('deadline-exceeded');
      if (lifted.kind === 'threw' || lifted.value.outcome === 'refused') return unknown('train-pause-write-failed');
    }

    const nextRecord: CutoverRecord = {
      schemaVersion: 1,
      revision: expectedRevision + 1,
      state: 'rolled-back',
      updatedAtIso: normalizedNowIso,
      switchedAtIso: record.switchedAtIso,
      rolledBackAtIso: normalizedNowIso,
      retiredAtIso: null,
      relaunchPlanDigest: record.relaunchPlanDigest,
      trainPauseSetByCutover: false,
    };
    const swapped = await this.guarded(deadlineIso, () =>
      this.deps.cutoverRepo.compareAndSet({ expectedRevision, next: nextRecord, deadlineIso }),
    );
    if (swapped.kind === 'deadline') return unknown('deadline-exceeded');
    if (swapped.kind === 'threw' || swapped.value.outcome === 'refused') return unknown('cutover-record-write-failed');
    if (swapped.value.outcome === 'conflict') return refuse('revision-conflict');
    return { record: swapped.value.record };
  }

  /**
   * The exact-key journal view of one move: the deadline and unreadable outcomes
   * are answered here, and only entries under the exact key survive the prefix
   * match (`cutover/switch@10` never collides with `cutover/switch@1`).
   */
  private async listMoveJournal(
    move: 'switch' | 'rollback' | 'retire',
    expectedRevision: number,
    deadlineIso: string | undefined,
  ):
    Promise<{ readonly intent: CutoverJournalEntry | null; readonly final: CutoverJournalEntry | null } | { readonly stop: ManageCutoverResult }> {
    const key = cutoverJournalKey(move, expectedRevision);
    if (key === null) {
      return { stop: refuse('invalid-request') };
    }
    const listed = await this.guarded(deadlineIso, () => this.deps.cutoverJournal.listByKeyPrefix(key));
    if (listed.kind === 'deadline') return { stop: unknown('deadline-exceeded') };
    if (listed.kind === 'threw' || listed.value.outcome !== 'listed' || !Array.isArray(listed.value.entries)) {
      return { stop: unknown('journal-unreadable') };
    }
    const entries = listed.value.entries.filter((entry) => entry.key === key);
    return {
      intent: entries.find((entry) => entry.kind === 'intent') ?? null,
      final: entries.find((entry) => entry.kind === 'result' && entry.outcome !== 'ambiguous') ?? null,
    };
  }

  /** The append that records one move's intent, deadline-guarded. */
  private async appendIntent(
    key: string,
    digest: string,
    normalizedNowIso: string,
    deadlineIso: string | undefined,
  ): Promise<ManageCutoverResult | null> {
    const intent = await this.guarded(deadlineIso, () =>
      this.deps.cutoverJournal.append({
        key,
        kind: 'intent',
        entryId: this.deps.mintEntryId(),
        recordedAtIso: normalizedNowIso,
        digest,
      }),
    );
    if (intent.kind === 'deadline') return unknown('deadline-exceeded');
    if (intent.kind === 'threw' || intent.value.outcome !== 'appended') {
      return unknown('journal-append-failed');
    }
    return null;
  }

  /** Appends the intent only when this exact move has none yet; a recorded intent is a retry. */
  private async appendIntentUnlessRecorded(
    recorded: CutoverJournalEntry | null,
    key: string,
    digest: string,
    normalizedNowIso: string,
    deadlineIso: string | undefined,
  ): Promise<ManageCutoverResult | null> {
    return recorded === null ? this.appendIntent(key, digest, normalizedNowIso, deadlineIso) : null;
  }

  /** The completed-result append shared by every move; a second final result is not a failure. */
  private async appendResult(
    key: string,
    digest: string,
    reasonCode: 'switched' | 'rolled-back' | 'retired',
    recordedAtIso: string,
    deadlineIso: string | undefined,
  ): Promise<ManageCutoverResult | null> {
    const result = await this.guarded(deadlineIso, () =>
      this.deps.cutoverJournal.append({
        key,
        kind: 'result',
        entryId: this.deps.mintEntryId(),
        recordedAtIso,
        outcome: 'completed',
        reasonCode,
        digest,
      }),
    );
    if (result.kind === 'deadline') return unknown('deadline-exceeded');
    const appended =
      result.kind === 'value' &&
      (result.value.outcome === 'appended' || result.value.reason === 'result-after-final-result');
    if (!appended) {
      return unknown('journal-append-failed');
    }
    return null;
  }

  private async switchMove(request: ManageCutoverSwitchRequest): Promise<ManageCutoverResult> {
    const { expectedRevision, deadlineIso, nowIso } = request;
    const key = cutoverJournalKey('switch', expectedRevision);
    if (key === null) {
      return refuse('invalid-request');
    }

    const journal = await this.listMoveJournal('switch', expectedRevision, deadlineIso);
    if ('stop' in journal) {
      return journal.stop;
    }
    const recorded = this.recordedSwitchIntent(journal.intent, request);
    if (recorded === 'mismatch') {
      return refuse('intent-digest-mismatch');
    }
    if (journal.final !== null) {
      return this.replaySwitchFinal(journal.final, key, deadlineIso);
    }

    const cutover = await this.readCutover(deadlineIso);
    if ('stop' in cutover) {
      return cutover.stop;
    }
    const { record } = cutover;

    // The state precondition runs on every pass, intent or not: only a final
    // journal result replays a stored record, so a stored non-`shadow` state
    // with an intent but no final result is still refused `not-shadow`.
    const precondition = this.switchStatePrecondition(record, expectedRevision);
    if (precondition !== null) {
      return precondition;
    }

    const preflight = await this.switchPreflight(request, deadlineIso);
    if ('outcome' in preflight) {
      return preflight;
    }
    // A recorded intent keeps the value its own pass read; this pass's read was only the
    // readability gate. With no intent yet, this pass's read is what the digest records.
    const plan = recorded ?? this.newSwitchIntent(request, preflight.trainPausedBefore);

    // The pause check is held through the switch: the preflight read alone does
    // not pin the marker, so it is re-read here, immediately before the write
    // phase (intent, train pause, record). A marker an operator cleared between
    // the preflight read and this recheck still refuses the move with zero
    // writes instead of letting the switch complete while daemon ticks run.
    const pauseStillHeld = await this.daemonPauseFailure(deadlineIso);
    if (pauseStillHeld !== null) {
      return pauseStillHeld;
    }

    const normalizedNowIso = normalizeIso(nowIso);

    // SW2b2: every shadow-park step between the preflight and the cutover
    // intent is read-only, so any refusal here leaves `cutover-journal.json`
    // untouched. Only after that intent is appended do the parks get their own
    // journal intents and their queue releases, and `applySwitch` runs last.
    const parks = await this.planShadowParks(deadlineIso);
    if ('outcome' in parks) {
      return parks;
    }

    const intentFailure = await this.appendIntentUnlessRecorded(
      journal.intent,
      key,
      plan.digest,
      normalizedNowIso,
      deadlineIso,
    );
    if (intentFailure !== null) {
      return intentFailure;
    }

    const released = await this.releaseShadowParks(parks.planned, normalizedNowIso, deadlineIso);
    if ('outcome' in released) {
      return released;
    }

    const saved = await this.applySwitch(record, request, plan, normalizedNowIso);
    if ('outcome' in saved) {
      return saved;
    }

    const resultFailure = await this.appendResult(key, plan.digest, 'switched', saved.record.updatedAtIso, deadlineIso);
    if (resultFailure !== null) {
      return resultFailure;
    }
    return this.completedMove(SWITCH_KIND, key, saved.record, {
      releasedParks: released.releasedParks,
      vetoHoldParks: parks.vetoHoldParks,
    });
  }

  /**
   * SW2b2: the read-only shadow-park phase of a switch, run after the
   * preflight (including the daemon-paused gate) and before the cutover
   * journal intent, so any refusal here leaves `cutover-journal.json`
   * untouched. It reads the merge policy, lists the queue, plans one park per
   * shadow-repo ordinary `parked` entry (a `veto-hold` is counted, never
   * released), matches every plan against the shadow-park journal already on
   * disk, and checks the journal capacity. Nothing writes.
   *
   * Cost bounds: the policy repositories and the queue listing are capped by
   * `readBoundedDenseArray` (`O(1)` pre-gate, accepted `O(K)` own-keys bound,
   * `O(cap)` descriptor loop); the per-entry record readers walk fixed-shape
   * plain data; the journal match is `O(planned * existing)` under the same
   * caps, so a switch plans at most `MAX_SHADOW_PARKS_PER_SWITCH` parks
   * against at most `MAX_SHADOW_PARK_JOURNAL_ENTRIES` entries.
   */
  private async planShadowParks(
    deadlineIso: string | undefined,
  ): Promise<ManageCutoverResult | { readonly planned: readonly PlannedShadowPark[]; readonly vetoHoldParks: number }> {
    // A request without a deadline still bounds every queue call: the default
    // is computed fresh on every pass, never cached.
    const effectiveDeadlineIso = new Date(Date.now() + DEFAULT_SWITCH_DEADLINE_MS).toISOString();

    if (this.deps.mergeQueue === undefined && this.deps.mergeQueueRead === undefined) {
      return refuse('merge-queue-absent');
    }
    if (this.deps.mergeQueue === undefined) {
      return refuse('merge-queue-absent');
    }
    if (this.deps.mergePolicy === undefined) {
      return refuse('merge-policy-absent');
    }
    if (this.deps.shadowParkJournal === undefined) {
      return refuse('park-journal-append-failed');
    }
    const mergeQueueReader = this.deps.mergeQueueRead ?? this.deps.mergeQueue;

    const policy = await this.guarded(deadlineIso, () => this.deps.mergePolicy!.readMergePolicy());
    if (policy.kind === 'deadline') return unknown('deadline-exceeded');
    if (policy.kind === 'threw' || policy.value.outcome !== 'known') return unknown('merge-policy-unreadable');
    const repositoryList = readBoundedDenseArray(policy.value.repositories, MAX_MERGE_POLICY_REPOS);
    if (repositoryList === null) return unknown('merge-policy-unreadable');
    const shadowRepos = new Set<string>();
    for (const repo of repositoryList.array) {
      const snapshot = snapshotPlainDataRecord(repo);
      if (
        snapshot === null ||
        typeof snapshot.repositoryKey !== 'string' ||
        typeof snapshot.shadow !== 'boolean'
      ) {
        return unknown('merge-policy-unreadable');
      }
      if (snapshot.shadow) {
        shadowRepos.add(snapshot.repositoryKey);
      }
    }

    const listed = await this.guarded(deadlineIso, () => mergeQueueReader.listMergeEntries({ deadlineIso: effectiveDeadlineIso }));
    if (listed.kind === 'deadline') return unknown('deadline-exceeded');
    if (listed.kind === 'threw') return unknown('merge-queue-unreadable');
    const queueEntries = readBoundedDenseArray(listed.value, MAX_MERGE_QUEUE_ENTRIES);
    if (queueEntries === null) return unknown('merge-queue-unreadable');
    const parked: MergeQueueEntryRecord[] = [];
    for (const element of queueEntries.array) {
      const read = readMergeQueueEntryRecord(element);
      if (!read.ok) return unknown('merge-queue-unreadable');
      if (shadowRepos.has(`${read.record.repository.owner}/${read.record.repository.repo}`) && read.record.state === 'parked') {
        parked.push(read.record);
      }
    }

    // A `veto-hold` on a shadow repository is never released by the switch; it is only counted.
    const vetoHoldParks = parked.filter((entry) => entry.reason === 'veto-hold').length;
    const planned: PlannedShadowPark[] = [];
    for (const entry of parked) {
      if (entry.reason === 'veto-hold') {
        continue;
      }
      const entryIdDigest = this.deps.computeDigest(entry.entryId).slice(0, 32);
      const keyRes = cutoverShadowParkKey(entryIdDigest, entry.revision);
      const payloadRes = buildShadowParkJournalPayload(entry);
      const releasedRes = buildReleasedParkEntry(entry);
      if (!keyRes.ok || !payloadRes.ok || !releasedRes.ok) {
        return refuse('invalid-park-record');
      }
      planned.push({
        entry,
        parkKey: keyRes.key,
        record: payloadRes.record,
        priorDigest: this.deps.computeDigest(payloadRes.canonicalPayload),
        releasedRecord: releasedRes.record,
        recordedIntent: false,
      });
    }

    const journalList = await this.guarded(deadlineIso, () => this.deps.shadowParkJournal!.listByKeyPrefix(''));
    if (journalList.kind === 'deadline') return unknown('deadline-exceeded');
    if (journalList.kind === 'threw' || journalList.value.outcome !== 'listed') return unknown('journal-unreadable');
    const existing = readBoundedDenseArray(journalList.value.entries, MAX_SHADOW_PARK_JOURNAL_ENTRIES);
    if (existing === null) return unknown('journal-unreadable');

    let newParksCount = 0;
    for (const park of planned) {
      const recorded = existing.array.find(
        (e) => (e as CutoverJournalEntry).key === park.parkKey && (e as CutoverJournalEntry).kind === 'intent',
      ) as CutoverJournalEntry | undefined;
      if (recorded === undefined) {
        newParksCount += 1;
        continue;
      }
      park.recordedIntent = true;
      const parkRead = readCutoverShadowParkRecord(recorded.shadowPark);
      if (!parkRead.ok || recorded.digest !== park.priorDigest || !sameShadowParkRecord(parkRead.record, park.record)) {
        return refuse('park-digest-mismatch');
      }
    }

    const capacity = checkCutoverJournalCapacity(existing.length, newParksCount);
    if (!capacity.ok) {
      // Both counts are proven non-negative safe integers, so the invalid-input
      // reason is unreachable here; every remaining reason is a typed refusal.
      if (capacity.reason === 'too-many-shadow-parks') return refuse('too-many-shadow-parks');
      if (capacity.reason === 'journal-capacity-exceeded') return refuse('journal-capacity-exceeded');
      return unknown('journal-unreadable');
    }
    return { planned, vetoHoldParks };
  }

  /**
   * SW2b2: the write phase of the shadow parks, run only after the cutover
   * journal intent is appended and before `applySwitch`. Each park still
   * missing its journal intent gets one in `shadow-park-journal.json`, then
   * every planned park is released back to `queued` by compare-and-set on its
   * revision — never dropped. An already-released entry (a crash between the
   * release and the record save) is no longer `parked`, so a replay skips it
   * and the resumed count stays exact.
   */
  private async releaseShadowParks(
    planned: readonly PlannedShadowPark[],
    normalizedNowIso: string,
    deadlineIso: string | undefined,
  ): Promise<ManageCutoverResult | { readonly releasedParks: number }> {
    const effectiveDeadlineIso = new Date(Date.now() + DEFAULT_SWITCH_DEADLINE_MS).toISOString();
    let releasedParks = 0;
    for (const park of planned) {
      if (!park.recordedIntent) {
        const appended = await this.guarded(deadlineIso, () =>
          this.deps.shadowParkJournal!.append({
            key: park.parkKey,
            kind: 'intent',
            entryId: this.deps.mintEntryId(),
            recordedAtIso: normalizedNowIso,
            digest: park.priorDigest,
            shadowPark: park.record,
          }),
        );
        if (appended.kind === 'deadline') return unknown('deadline-exceeded');
        if (appended.kind === 'threw' || appended.value.outcome === 'refused') {
          return refuse('park-journal-append-failed');
        }
      }
      const transition = await this.guarded(deadlineIso, () =>
        this.deps.mergeQueue!.applyMergeTransition({
          entryId: park.entry.entryId,
          expectedRevision: park.entry.revision,
          next: park.releasedRecord,
          successor: null,
          deadlineIso: effectiveDeadlineIso,
        }),
      );
      if (transition.kind === 'deadline') return unknown('deadline-exceeded');
      if (transition.kind === 'threw') return unknown('merge-queue-write-failed');
      if (transition.value.outcome === 'refused') {
        if (transition.value.reason === 'revision-conflict') {
          return refuse('park-release-conflict');
        }
        return unknown('merge-queue-write-failed');
      }
      releasedParks += 1;
    }
    return { releasedParks };
  }

  /** The digest a switch intent carries for one value of `trainPausedBefore` (none: the four-key payload). */
  private switchIntentDigest(request: ManageCutoverSwitchRequest, trainPausedBefore?: boolean): string {
    return this.deps.computeDigest(
      canonicalCutoverSwitchPayload({
        expectedRevision: request.expectedRevision,
        operationId: request.operationId,
        relaunchPlanDigest: request.relaunchPlanDigest,
        trainPausedBefore,
      }),
    );
  }

  /** The plan of the pass that appends the intent: its own train-pause read goes into the digest. */
  private newSwitchIntent(request: ManageCutoverSwitchRequest, trainPausedBefore: boolean): SwitchIntentPlan {
    return { digest: this.switchIntentDigest(request, trainPausedBefore), trainPausedBefore, replay: false };
  }

  /**
   * What a recorded intent says about this request: null when there is none, `mismatch` when its
   * digest is not this request's under any recorded value, else the value its pass recorded. The
   * journal intent has no field for `trainPausedBefore`, so the value is recovered by matching
   * the stored digest against the request's digest for `true`, for `false`, and for the four-key
   * payload of an intent written before the key existed. That last one reads as `true`: nothing
   * is known about the train then, so an `unchanged` pause is not claimed.
   */
  private recordedSwitchIntent(
    intent: CutoverJournalEntry | null,
    request: ManageCutoverSwitchRequest,
  ): SwitchIntentPlan | 'mismatch' | null {
    if (intent === null) {
      return null;
    }
    const candidates: readonly (readonly [boolean | undefined, boolean])[] = [
      [true, true],
      [false, false],
      [undefined, true],
    ];
    for (const [payloadValue, trainPausedBefore] of candidates) {
      const digest = this.switchIntentDigest(request, payloadValue);
      if (intent.digest === digest) {
        return { digest, trainPausedBefore, replay: true };
      }
    }
    return 'mismatch';
  }

  /**
   * The switch gates after the state precondition, in order: evidence, lane
   * coverage, daemon status, daemon pause, train pause. The train-pause read
   * runs on every pass and answers whether the train was already paused.
   */
  private async switchPreflight(
    request: ManageCutoverSwitchRequest,
    deadlineIso: string | undefined,
  ): Promise<ManageCutoverResult | { readonly trainPausedBefore: boolean }> {
    const failure =
      (await this.shadowEvidenceFailure(request, deadlineIso)) ??
      (await this.unrecordedLanesFailure(deadlineIso)) ??
      (await this.daemonStatusFailure(deadlineIso)) ??
      (await this.daemonPauseFailure(deadlineIso));
    return failure ?? this.readTrainPausedBefore(deadlineIso);
  }

  /** The record state a switch demands on every pass, before anything is recorded. */
  private switchStatePrecondition(record: CutoverRecord | null, expectedRevision: number): ManageCutoverResult | null {
    if (record === null) {
      return expectedRevision === 0 ? null : refuse('revision-conflict');
    }
    // The revision precondition governs every stored record, shadow or not:
    // a stored revision other than the expected one is a `revision-conflict`
    // even when the stored state is not `shadow`, so the revision is checked
    // before the not-shadow path.
    if (record.revision !== expectedRevision) {
      return refuse('revision-conflict');
    }
    if (record.state !== 'shadow') {
      return refuse('not-shadow');
    }
    return null;
  }

  /**
   * The shadow-evidence gate: a missing reader or an absent document is a
   * refusal naming every criterion, an unreadable or unknown-version reader is
   * `unknown`, and a document that fails any criterion is a refusal naming
   * exactly the failed ids.
   */
  private async shadowEvidenceFailure(
    request: ManageCutoverSwitchRequest,
    deadlineIso: string | undefined,
  ): Promise<ManageCutoverResult | null> {
    const reader = this.deps.readShadowEvidence;
    if (reader === undefined) {
      return refuseWith('shadow-evidence-absent', [...CUTOVER_SHADOW_CRITERIA]);
    }
    const read = await this.guarded(deadlineIso, reader);
    if (read.kind === 'deadline') return unknown('deadline-exceeded');
    if (read.kind === 'threw') return unknown('shadow-evidence-unreadable');
    if (read.value.status === 'unreadable') return unknown('shadow-evidence-unreadable');
    if (read.value.status === 'unknown-version') return unknown('shadow-evidence-unknown-version');
    if (read.value.status === 'absent') {
      return refuseWith('shadow-evidence-absent', [...CUTOVER_SHADOW_CRITERIA]);
    }
    const verdict = readCutoverShadowEvidence(read.value.evidence, request.nowIso);
    if (!verdict.ok) {
      return refuseWith('shadow-criteria-failed', verdict.failed);
    }
    return null;
  }

  /**
   * The BL14b retirement-ledger gate: a missing reader or an absent ledger is
   * a refusal, every outcome fails closed, and every failure is a typed result
   * written before any intent, record or pause write.
   */
  private async retirementLedgerFailure(deadlineIso: string | undefined): Promise<ManageCutoverResult | null> {
    const reader = this.deps.readRetirementLedger;
    if (reader === undefined) {
      return refuse('retirement-ledger-absent');
    }
    const read = await this.guarded(deadlineIso, reader);
    if (read.kind === 'deadline') return unknown('deadline-exceeded');
    // A read that starts before the deadline but completes after it must not
    // pass the gate: the deadline is rechecked against the clock once the
    // reader has returned, failing closed.
    if (this.deadlineReached(deadlineIso)) return unknown('deadline-exceeded');
    if (read.kind === 'threw') return unknown('retirement-ledger-unreadable');
    if (read.value.status === 'absent') return refuse('retirement-ledger-absent');
    if (read.value.status === 'unreadable') return unknown('retirement-ledger-unreadable');
    if (read.value.status === 'unknown-version') return unknown('retirement-ledger-unknown-version');
    const verdict = readRetirementLedger(read.value.ledger);
    if (!verdict.ok) {
      // Fail closed: every parser reason is a refusal or an unknown, never a
      // pass, and never a write.
      if (verdict.reason === 'unknown-version') return unknown('retirement-ledger-unknown-version');
      if (verdict.reason === 'empty-ledger' || verdict.reason === 'row-unverified') {
        return refuse('retirement-ledger-failed');
      }
      return unknown('retirement-ledger-unreadable');
    }
    // Retire proceeds only when the ledger read is ok AND every pinned §1
    // script carries a row with verified true. The parser already requires the
    // exact row set; this re-check fails closed if it ever did not.
    const verifiedScripts = new Set(
      verdict.ledger.rows.filter((row) => row.verified === true).map((row) => row.script),
    );
    if (CUTOVER_RETIREMENT_SCRIPTS.some((script) => !verifiedScripts.has(script))) {
      return refuse('retirement-ledger-failed');
    }
    return null;
  }

  /** Unknown lane coverage is never a pass: only an exact zero of unrecorded lanes proceeds. */
  private async unrecordedLanesFailure(deadlineIso: string | undefined): Promise<ManageCutoverResult | null> {
    const counter = this.deps.countUnrecordedLanes;
    if (counter === undefined) {
      return unknown('unrecorded-lanes-unknown');
    }
    const counted = await this.guarded(deadlineIso, counter);
    if (counted.kind === 'deadline') return unknown('deadline-exceeded');
    if (counted.kind === 'threw') return unknown('unrecorded-lanes-unknown');
    if (counted.value.status === 'refused') {
      return refuse(counted.value.reason);
    }
    if (counted.value.status !== 'ok') {
      return unknown('unrecorded-lanes-unknown');
    }
    if (counted.value.unknownListings > 0) {
      return unknown('unrecorded-lanes-unknown');
    }
    if (counted.value.unrecorded > 0) {
      return refuse('unrecorded-lanes');
    }
    return null;
  }

  /** A daemon status that is neither `ok` nor `missing` is unreadable; a failed last tick still proceeds. */
  private async daemonStatusFailure(deadlineIso: string | undefined): Promise<ManageCutoverResult | null> {
    const status = await this.guarded(deadlineIso, () => this.deps.daemonStatus.read());
    if (status.kind === 'deadline') return unknown('deadline-exceeded');
    if (status.kind === 'threw') return unknown('daemon-status-unreadable');
    if (status.value.status !== 'ok' && status.value.status !== 'missing') {
      return unknown('daemon-status-unreadable');
    }
    return null;
  }

  /**
   * The daemon-pause gate: a switch only runs while the daemon is paused.
   * Unreadable or malformed is `unknown`, `clear` is refused, and the deadline
   * is honoured through the guarded read.
   */
  private async daemonPauseFailure(deadlineIso: string | undefined): Promise<ManageCutoverResult | null> {
    const pause = await this.guarded(deadlineIso, () => this.deps.daemonPauseRead.read());
    if (pause.kind === 'deadline') return unknown('deadline-exceeded');
    if (
      pause.kind === 'threw' ||
      typeof pause.value !== 'object' ||
      pause.value === null ||
      (pause.value.state !== 'paused' && pause.value.state !== 'clear')
    ) {
      return unknown('daemon-pause-unreadable');
    }
    if (pause.value.state !== 'paused') {
      return refuse('daemon-not-paused');
    }
    return null;
  }

  /** The train-pause store must read `paused` or `clear` before a switch moves anything. */
  private async readTrainPausedBefore(
    deadlineIso: string | undefined,
  ): Promise<ManageCutoverResult | { readonly trainPausedBefore: boolean }> {
    const trainPause = await this.guarded(deadlineIso, () => this.deps.trainPauseRead.read());
    if (trainPause.kind === 'deadline') return unknown('deadline-exceeded');
    if (trainPause.kind === 'threw' || (trainPause.value.status !== 'paused' && trainPause.value.status !== 'clear')) {
      return unknown('train-pause-unreadable');
    }
    return { trainPausedBefore: trainPause.value.status === 'paused' };
  }

  /**
   * The guarded action sequence for a switch: the record is still `shadow`
   * (or absent with revision 0). A stored switched record never reaches here —
   * the state precondition refuses it on every pass; only a final journal
   * result replays a completed switch.
   */
  private async applySwitch(
    record: CutoverRecord | null,
    request: ManageCutoverSwitchRequest,
    plan: SwitchIntentPlan,
    normalizedNowIso: string,
  ): Promise<ManageCutoverResult | { readonly record: CutoverRecord }> {
    const { expectedRevision, relaunchPlanDigest, deadlineIso } = request;
    if (record !== null) {
      const caseA = record.revision === expectedRevision && record.state === 'shadow';
      if (!caseA) {
        return refuse('revision-conflict');
      }
    } else if (expectedRevision !== 0) {
      return refuse('revision-conflict');
    }

    const paused = await this.guarded(deadlineIso, () => this.deps.trainPause.set({ paused: true, nowIso: normalizedNowIso }));
    if (paused.kind === 'deadline') return unknown('deadline-exceeded');
    if (paused.kind === 'threw' || paused.value.outcome === 'refused') return unknown('train-pause-write-failed');
    const trainPauseSetByCutover = switchOwnsTrainPause(paused.value.outcome, plan);

    const nextRecord: CutoverRecord = {
      schemaVersion: 1,
      revision: expectedRevision + 1,
      state: 'switched',
      updatedAtIso: normalizedNowIso,
      switchedAtIso: normalizedNowIso,
      rolledBackAtIso: null,
      retiredAtIso: null,
      relaunchPlanDigest,
      trainPauseSetByCutover,
    };
    return this.swapCutoverRecord(expectedRevision, nextRecord, deadlineIso);
  }

  /** The compare-and-set every switch or retire ends with, mapped to the move's refusals. */
  private async swapCutoverRecord(
    expectedRevision: number,
    nextRecord: CutoverRecord,
    deadlineIso: string | undefined,
  ): Promise<ManageCutoverResult | { readonly record: CutoverRecord }> {
    const swapped = await this.guarded(deadlineIso, () =>
      this.deps.cutoverRepo.compareAndSet({ expectedRevision, next: nextRecord, deadlineIso }),
    );
    if (swapped.kind === 'deadline') return unknown('deadline-exceeded');
    if (swapped.kind === 'threw' || swapped.value.outcome === 'refused') return unknown('cutover-record-write-failed');
    if (swapped.value.outcome === 'conflict') return refuse('revision-conflict');
    return { record: swapped.value.record };
  }

  /** The completed result of a move this pass performed. */
  private completedMove(kind: MoveKind, key: string, record: CutoverRecord, parkCounts?: SwitchParkCounts): ManageCutoverResult {
    return completedResult(kind, key, false, record, parkCounts);
  }

  /** A completed switch returns its recorded outcome with no write; a refused one stays refused. */
  private replaySwitchFinal(
    finalEntry: CutoverJournalEntry,
    key: string,
    deadlineIso: string | undefined,
  ): Promise<ManageCutoverResult> {
    return this.replayCompletedMove(SWITCH_KIND, finalEntry, key, deadlineIso);
  }

  /** A completed retire returns its recorded outcome with no write and lifts no pause again. */
  private replayRetireFinal(
    finalEntry: CutoverJournalEntry,
    key: string,
    deadlineIso: string | undefined,
  ): Promise<ManageCutoverResult> {
    return this.replayCompletedMove(RETIRE_KIND, finalEntry, key, deadlineIso);
  }

  private async replayCompletedMove(
    kind: MoveKind,
    finalEntry: CutoverJournalEntry,
    key: string,
    deadlineIso: string | undefined,
  ): Promise<ManageCutoverResult> {
    if (finalEntry.outcome === 'refused') {
      return refuse('journal-refused');
    }
    const cutover = await this.readCutover(deadlineIso);
    if ('stop' in cutover) {
      return cutover.stop;
    }
    const read = cutover.record;
    if (read === null) {
      return unknown('cutover-record-unreadable');
    }
    if (read.state !== kind.state) {
      return refuse('revision-conflict');
    }
    return completedResult(kind, key, true, read);
  }

  private async retireMove(request: ManageCutoverRetireRequest): Promise<ManageCutoverResult> {
    const { expectedRevision, deadlineIso, nowIso } = request;
    const key = cutoverJournalKey('retire', expectedRevision);
    if (key === null) {
      return refuse('invalid-request');
    }
    const requestDigest = this.deps.computeDigest(
      canonicalCutoverRetirePayload({ expectedRevision, operationId: request.operationId }),
    );

    const journal = await this.listMoveJournal('retire', expectedRevision, deadlineIso);
    if ('stop' in journal) {
      return journal.stop;
    }
    if (journal.intent !== null && journal.intent.digest !== requestDigest) {
      return refuse('intent-digest-mismatch');
    }
    if (journal.final !== null) {
      return this.replayRetireFinal(journal.final, key, deadlineIso);
    }

    const cutover = await this.readCutover(deadlineIso);
    if ('stop' in cutover) {
      return cutover.stop;
    }
    const { record } = cutover;

    const normalizedNowIso = normalizeIso(nowIso);
    // The record, clock and window preconditions run on every pass: `nowIso` is
    // not part of the intent digest, so a retry must re-decide the rollback
    // window against the request's own clock, never trust the earlier pass.
    const precondition = this.retireStatePrecondition(record, expectedRevision, normalizedNowIso);
    if (precondition !== null) {
      return precondition;
    }
    const ledgerFailure = await this.retirementLedgerFailure(deadlineIso);
    if (ledgerFailure !== null) {
      return ledgerFailure;
    }
    const intentFailure = await this.appendIntentUnlessRecorded(
      journal.intent,
      key,
      requestDigest,
      normalizedNowIso,
      deadlineIso,
    );
    if (intentFailure !== null) {
      return intentFailure;
    }

    const saved = await this.applyRetire(record, expectedRevision, normalizedNowIso, deadlineIso);
    if ('outcome' in saved) {
      return saved;
    }

    const resultFailure = await this.appendResult(key, requestDigest, 'retired', saved.record.updatedAtIso, deadlineIso);
    if (resultFailure !== null) {
      return resultFailure;
    }
    return this.completedMove(RETIRE_KIND, key, saved.record);
  }

  /** The record, clock and window refusals a retire decides on every pass. */
  private retireStatePrecondition(
    record: CutoverRecord | null,
    expectedRevision: number,
    normalizedNowIso: string,
  ): ManageCutoverResult | null {
    if (record?.revision !== expectedRevision) {
      return refuse('not-switched');
    }
    if (record.state !== 'switched' || record.switchedAtIso === null) {
      return refuse('not-switched');
    }
    if (Date.parse(normalizedNowIso) < Date.parse(record.switchedAtIso)) {
      return refuse('invalid-clock');
    }
    const withinWindow = isWithinCutoverRollbackWindow(record.switchedAtIso, normalizedNowIso);
    if (withinWindow === null) {
      return refuse('invalid-clock');
    }
    if (withinWindow) {
      return refuse('inside-rollback-window');
    }
    return null;
  }

  /**
   * The guarded action sequence for a retire: the record is still `switched`.
   * A stored retired record never reaches here — the state precondition
   * refuses it on every pass; only a final journal result replays a completed
   * retire.
   */
  private async applyRetire(
    record: CutoverRecord | null,
    expectedRevision: number,
    normalizedNowIso: string,
    deadlineIso: string | undefined,
  ): Promise<ManageCutoverResult | { readonly record: CutoverRecord }> {
    if (record === null) {
      return refuse('revision-conflict');
    }
    const caseA = record.revision === expectedRevision && record.state === 'switched' && record.switchedAtIso !== null;
    if (!caseA) {
      return refuse('revision-conflict');
    }
    if (Date.parse(normalizedNowIso) < Date.parse(record.switchedAtIso as string)) {
      return refuse('invalid-clock');
    }

    if (record.trainPauseSetByCutover) {
      const lifted = await this.guarded(deadlineIso, () =>
        this.deps.trainPause.set({ paused: false, nowIso: normalizedNowIso }),
      );
      if (lifted.kind === 'deadline') return unknown('deadline-exceeded');
      if (lifted.kind === 'threw' || lifted.value.outcome === 'refused') return unknown('train-pause-write-failed');
    }

    const nextRecord: CutoverRecord = {
      schemaVersion: 1,
      revision: expectedRevision + 1,
      state: 'retired',
      updatedAtIso: normalizedNowIso,
      switchedAtIso: record.switchedAtIso,
      rolledBackAtIso: null,
      retiredAtIso: normalizedNowIso,
      relaunchPlanDigest: record.relaunchPlanDigest,
      trainPauseSetByCutover: false,
    };
    return this.swapCutoverRecord(expectedRevision, nextRecord, deadlineIso);
  }
}
