/**
 * ManageCutoverUseCase (lane CO30a): `status` reads the cutover record and the
 * stores a cutover depends on and writes nothing; `rollback` pauses the daemon,
 * lifts only the train pause the cutover itself set, and saves the rolled-back
 * record by compare-and-set. `switch` and `retire` are refused until CO30b.
 *
 * A rollback is keyed `cutover/rollback@<expectedRevision>`: the intent carries a
 * digest of the full request and is checked on replay before any write, every
 * outbound call is deadline-guarded, and a pass cut short at any step is finished
 * by the next pass. An unreadable or unknown-version store is `unknown`, never a
 * default. Nothing here echoes a path or a raw input value.
 */

import { containsSecretShape, LANE_DIFF_SECRET_PATTERNS } from '@fleet/shared';
import { isZonedIsoDateTime } from '../../domain/conductor-halt.js';
import {
  canonicalCutoverRollbackPayload,
  cutoverJournalKey,
  isWithinCutoverRollbackWindow,
  type CutoverRecord,
} from '../../domain/cutover-records.js';
import { snapshotPlainDataRecord } from '../../domain/plain-record-reads.js';
import type {
  ManageCutoverPort,
  ManageCutoverRefusalReason,
  ManageCutoverResult,
  ManageCutoverRollbackRequest,
  ManageCutoverStatusRequest,
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
}

const MAX_REQUEST_KEYS = 8;
const MAX_STRING_LENGTH = 256;
const MAX_ISO_LENGTH = 64;
const MAX_REVISION = 1_000_000_000;
const OPERATION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const STATUS_KEYS: readonly string[] = ['move', 'nowIso', 'deadlineIso'];
const ROLLBACK_KEYS: readonly string[] = ['move', 'expectedRevision', 'operationId', 'nowIso', 'deadlineIso'];

type ParsedRequest =
  | { readonly ok: true; readonly request: ManageCutoverStatusRequest | ManageCutoverRollbackRequest }
  | { readonly ok: false; readonly reason: ManageCutoverRefusalReason };

/** The outcome of one guarded outbound call. */
type Guarded<T> =
  | { readonly kind: 'value'; readonly value: T }
  | { readonly kind: 'deadline' }
  | { readonly kind: 'threw' };

function refuse(reason: ManageCutoverRefusalReason): ManageCutoverResult {
  return { outcome: 'refused', reason };
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
  if (move === 'switch' || move === 'retire') {
    return { ok: false, reason: 'move-not-implemented' };
  }
  if (move === 'status') {
    return parseStatus(snapshot);
  }
  if (move === 'rollback') {
    return parseRollback(snapshot);
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

function parseRollback(snapshot: Record<string, unknown>): ParsedRequest {
  const { expectedRevision, operationId, nowIso, deadlineIso } = snapshot;
  if (
    !hasOnlyKeys(snapshot, ROLLBACK_KEYS) ||
    typeof expectedRevision !== 'number' ||
    !Number.isSafeInteger(expectedRevision) ||
    expectedRevision < 1 ||
    expectedRevision > MAX_REVISION ||
    typeof operationId !== 'string' ||
    !OPERATION_ID.test(operationId) ||
    !isBoundedIso(nowIso) ||
    (deadlineIso !== undefined && !isBoundedIso(deadlineIso))
  ) {
    return { ok: false, reason: 'invalid-request' };
  }
  return {
    ok: true,
    request: {
      move: 'rollback',
      expectedRevision,
      operationId,
      nowIso,
      ...(deadlineIso === undefined ? {} : { deadlineIso }),
    },
  };
}

export class ManageCutoverUseCase implements ManageCutoverPort {
  constructor(private readonly deps: ManageCutoverDependencies) {}

  async execute(request: unknown): Promise<ManageCutoverResult> {
    try {
      const parsed = parseRequest(request);
      if (!parsed.ok) {
        return refuse(parsed.reason);
      }
      return parsed.request.move === 'status' ? await this.status(parsed.request) : await this.rollback(parsed.request);
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
}
