// Implemented for lane K11a2.
/**
 * ReapZombiesUseCase: one reaper pass. It gathers facts through existing read
 * ports (attempts, held reservations, open attention items, stored open
 * findings), classifies with the merged `classifyZombies`, upserts one finding
 * per open `(subject, kind)`, raises or refreshes attention items, and performs
 * only record-only repairs under keyed journal entries: the intent before the
 * action, the result after, so a crash between the two is reconciled by the
 * next pass instead of a second action.
 *
 * The observations cover every kind this lane's read ports can establish:
 * `dead-attempt` (a running attempt whose runner reports the session ended),
 * `leaked-slot` (a held reservation on a terminal or absent attempt) and
 * `stale-attention` (an open attention item on a terminal attempt). Other
 * declared kinds need facts this lane has no port for (runs, worktrees, disk,
 * forge); they are never fabricated.
 *
 * Results are record-only and keyed: attempt reconciliation, the fenced
 * capacity release (`releaseCapacityReservationIfUnchanged`), and clearing
 * stale attention items. A finding the pass no longer sees is closed on
 * positive evidence the condition ended, and its attention item is cleared; a
 * repair intent without a result is reconciled read-only, never repeated. The
 * use case never throws; every failure is a typed refusal or an unknown entry,
 * and ids and codes only ever cross its boundary.
 */

import { containsSecretShape } from '@fleet/shared';

import type { ActionJournalEntryRecord, AttemptRecord, CapacityReservationRecord } from '../../domain/execution-records.js';
import type { AttemptRepositoryPort } from '../ports/out/AttemptRepositoryPort.out-port.js';
import type {
  ExecutionJournalPort,
  ReleaseCapacityReservationIfUnchangedResult,
} from '../ports/out/ExecutionJournalPort.out-port.js';
import type {
  LaneRunJournalEntryRecord,
  LaneRunJournalOutcome,
} from '../../domain/lane-run-journal.js';
import type { LaneRunJournalPort } from '../ports/out/LaneRunJournalPort.out-port.js';
import type { ExecutionRunnerPort, RunnerSessionStatus } from '../ports/out/ExecutionRunnerPort.out-port.js';
import type { RunnerForAttemptPort } from '../ports/out/RunnerForAttemptPort.out-port.js';
import type { ReconcileAttemptPort, ReconcileAttemptResult } from '../ports/in/ReconcileAttemptPort.in-port.js';
import type {
  ReaperFindingRepositoryPort,
  ReaperFindingStoreRecord,
} from '../ports/out/ReaperFindingRepositoryPort.out-port.js';
import type {
  ReapZombiesPort,
  ReapZombiesRequest,
  ReapZombiesResult,
  ReaperAttentionOutcome,
  ReaperAttentionView,
  ReaperFindingView,
  ReaperRepairView,
  ReaperUnknownView,
} from '../ports/in/ReapZombiesPort.in-port.js';
import {
  classifyZombies,
  type ReaperFinding,
  type ReaperObservation,
  type ReaperPolicy,
} from '../../domain/reaper-findings.js';
import { REQUEST_ID_PATTERN, reaperRepairKey } from '../../domain/lane-run-keys.js';

/**
 * The attention surface the reaper needs, declared locally so application
 * code imports no cross-package type. The composition root binds the
 * operator-coordination ports (Record / Clear / List attention items) here;
 * their shapes satisfy this structurally.
 */
export interface ReaperAttentionListRequest {
  readonly projectId?: string;
  readonly state?: string;
  readonly kind?: string;
  readonly workOrderId?: string;
}

export interface ReaperAttentionRecordBody {
  readonly projectId: string;
  readonly kind: string;
  readonly subject: { readonly kind: string; readonly ref: string };
  readonly workOrderId: string | null;
  readonly summary: string;
}

export interface ReaperAttentionRecordResult {
  readonly outcome: 'raised' | 'refreshed' | 'reopened' | 'exists' | 'refused';
}

export interface ReaperAttentionPort {
  listAttentionItems(request?: ReaperAttentionListRequest): Promise<{ readonly items: readonly unknown[] }>;
  recordAttentionItem(body: unknown, actor: string): Promise<ReaperAttentionRecordResult>;
  clearAttentionItem(request: unknown, via: string, actor: string): Promise<unknown>;
}

/** The reads, writes and id source the pass needs; narrowed so composition supplies only what it has. */
export interface ReapZombiesDependencies {
  readonly attemptRepo: Pick<AttemptRepositoryPort, 'listAllAttempts' | 'findAttemptById'>;
  /**
   * Read-only facts plus the fenced capacity release. The release is optional
   * on the port; when absent a `leaked-slot` repair is skipped.
   */
  readonly executionJournal: Pick<
    ExecutionJournalPort,
    'listActiveReservations' | 'listJournalEntriesForAttempt' | 'releaseCapacityReservationIfUnchanged'
  >;
  readonly runJournal: Pick<LaneRunJournalPort, 'append' | 'listForKey'>;
  readonly reconcile: Pick<ReconcileAttemptPort, 'reconcileAttempt'>;
  readonly runner: ExecutionRunnerPort;
  readonly runnerForAttempt: RunnerForAttemptPort;
  readonly attention: ReaperAttentionPort;
  readonly reaperFindings: ReaperFindingRepositoryPort;
  /** The composition root mints ULIDs; this lane never mints one itself. */
  readonly newId: () => string;
}

const MAX_SUBJECTS_PER_PASS = 64;
const MAX_ATTENTION_PER_PASS = 64;
const MAX_SUMMARY_LENGTH = 1024;
const DEFAULT_GRACE_MINUTES = 5;
const MINUTE_MS = 60_000;
const TERMINAL_ATTEMPT_STATES = new Set(['ended', 'collected', 'cancelled']);

/** The context the unseen-finding sweep needs to decide a close or a recovery. */
interface SettleContext {
  readonly projectId: string;
  readonly nowIso: string;
  readonly attemptsById: ReadonlyMap<string, AttemptRecord>;
  readonly reservationById: ReadonlyMap<string, CapacityReservationRecord>;
  readonly attentionItems: readonly unknown[];
  readonly staleAttentionBySubject: ReadonlyMap<string, { readonly kind: string; readonly subjectKind: string }>;
  readonly unknown: ReaperUnknownView[];
}

type ClearAttentionShapeResult = { readonly outcome?: string };

function reasonCodeToken(value: string | null | undefined): string | null {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(value)) {
    return null;
  }
  return value;
}

/** A safe result entry id: only a ULID is ever written. */
function mintedUlid(newId: () => string): string | null {
  let id: string;
  try {
    id = newId();
  } catch {
    return null;
  }
  return typeof id === 'string' && REQUEST_ID_PATTERN.test(id) ? id : null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Read one request field with a throwing getter treated as absent. */
function readField(request: unknown, field: string): unknown {
  try {
    return (request as Record<string, unknown>)[field];
  } catch {
    return undefined;
  }
}

function parseNowIso(nowIso: unknown): string | null {
  if (nowIso === undefined) {
    return new Date().toISOString();
  }
  if (typeof nowIso !== 'string') {
    return null;
  }
  const ms = Date.parse(nowIso);
  if (Number.isNaN(ms)) {
    return null;
  }
  return nowIso;
}

function reservationsYoungActivity(reservedAtIso: unknown, nowMs: number, graceMs: number): boolean {
  if (typeof reservedAtIso !== 'string') {
    return false;
  }
  const ms = Date.parse(reservedAtIso);
  if (Number.isNaN(ms)) {
    return false;
  }
  return nowMs - ms < graceMs;
}

function attemptYoungActivity(attempt: AttemptRecord, nowMs: number, graceMs: number): boolean {
  const updated = Date.parse(attempt.updatedAtIso);
  const created = Date.parse(attempt.createdAtIso);
  const latest = Math.max(
    Number.isNaN(updated) ? 0 : updated,
    Number.isNaN(created) ? 0 : created,
  );
  return nowMs - latest < graceMs;
}

/**
 * The no-young-intent rule: an attempt whose action journal carries a pending
 * intent recorded within the grace window is young — a stop (or any action)
 * is in flight, and the reaper must not race it.
 */
function actionJournalHasYoungIntent(entries: readonly ActionJournalEntryRecord[], nowMs: number, graceMs: number): boolean {
  for (const entry of entries) {
    if (entry.status === 'intent-recorded' && typeof entry.recordedAtIso === 'string') {
      const ms = Date.parse(entry.recordedAtIso);
      if (!Number.isNaN(ms) && nowMs - ms < graceMs) {
        return true;
      }
    }
  }
  return false;
}

export class ReapZombiesUseCase implements ReapZombiesPort {
  private readonly deps: ReapZombiesDependencies;

  constructor(deps: ReapZombiesDependencies) {
    this.deps = deps;
  }

  async reapZombies(request: ReapZombiesRequest): Promise<ReapZombiesResult> {
    // 1. Validate. Never throw on runtime input.
    if (!isPlainObject(request)) {
      return refused('request-invalid');
    }
    const projectId = readField(request, 'projectId');
    if (typeof projectId !== 'string' || projectId === '' || containsSecretShape(projectId)) {
      return refused('request-invalid');
    }
    const nowIso = parseNowIso(readField(request, 'nowIso'));
    if (nowIso === null) {
      return refused('request-invalid');
    }
    const policyValue = readField(request, 'policy');
    const policy: ReaperPolicy = isPlainObject(policyValue) ? (policyValue as ReaperPolicy) : {};
    const graceMinutes =
      typeof policy.graceMinutes === 'number' && Number.isFinite(policy.graceMinutes) && policy.graceMinutes >= 0
        ? policy.graceMinutes
        : DEFAULT_GRACE_MINUTES;
    const graceMs = graceMinutes * MINUTE_MS;
    const nowMs = Date.parse(nowIso);

    // 2. Read the facts. A read that throws is an unknown; the affected part
    // of the pass is skipped — never substituted with an empty read, and an
    // unreadable findings store writes nothing at all.
    const unknown: ReaperUnknownView[] = [];
    let attempts: readonly AttemptRecord[] = [];
    let attemptsUnreadable = false;
    try {
      attempts = await this.deps.attemptRepo.listAllAttempts();
    } catch {
      attemptsUnreadable = true;
      unknown.push({ subject: '', reason: 'attempts-unreadable' });
    }
    let reservations: Awaited<ReturnType<ExecutionJournalPort['listActiveReservations']>> = [];
    let reservationsUnreadable = false;
    try {
      reservations = await this.deps.executionJournal.listActiveReservations();
    } catch {
      reservationsUnreadable = true;
      unknown.push({ subject: '', reason: 'reservations-unreadable' });
    }
    let attentionItems: readonly unknown[] = [];
    let attentionUnreadable = false;
    try {
      const attentionResult = await this.deps.attention.listAttentionItems({ projectId });
      attentionItems = Array.isArray(attentionResult?.items) ? attentionResult.items : [];
    } catch {
      attentionUnreadable = true;
      unknown.push({ subject: '', reason: 'attention-unreadable' });
    }
    let openRecords: readonly ReaperFindingStoreRecord[];
    try {
      openRecords = await this.deps.reaperFindings.listOpenFindings();
    } catch {
      // An unreadable findings store writes nothing at all — never treated as empty.
      return {
        outcome: 'completed',
        findings: [],
        attention: [],
        repairs: [],
        unknown: [...unknown, { subject: '', reason: 'findings-unreadable' }],
      };
    }
    const readsComplete = !attemptsUnreadable && !reservationsUnreadable && !attentionUnreadable;

    // 3. Build the observations, one per subject, for every kind the read
    // ports can establish. When the attempts read failed, no observation is
    // built at all: a reservation whose attempt could not be read is not
    // classified as `absent`, and no finding, attention item or repair follows
    // from a read this pass could not make.
    const observations: ReaperObservation[] = [];
    const findings: ReaperFinding[] = [];
    const attemptsById = new Map<string, AttemptRecord>();
    const reservationById = new Map<string, CapacityReservationRecord>();
    /** Subjects skipped by the per-pass cap: their open findings are never closed. */
    const cappedKeys = new Set<string>();
    /** The attention item behind each stale-attention subject, so a clear targets it. */
    const staleAttentionBySubject = new Map<string, { kind: string; subjectKind: string }>();

    if (!attemptsUnreadable) {
      let subjects = 0;
      for (const entry of attempts) {
        if (isPlainObject(entry) && typeof (entry as { id?: unknown }).id === 'string') {
          attemptsById.set((entry as { id: string }).id, entry as AttemptRecord);
        }
      }
      for (const attempt of attempts) {
        if (!isPlainObject(attempt)) {
          continue; // a sparse or malformed entry is skipped, never thrown on
        }
        if (attempt.state !== 'running' || typeof attempt.sessionId !== 'string') {
          continue;
        }
        if (subjects >= MAX_SUBJECTS_PER_PASS) {
          unknown.push({ subject: attempt.id, kind: 'dead-attempt', reason: 'pass-cap' });
          cappedKeys.add('dead-attempt\u0000' + attempt.id);
          continue;
        }
        subjects += 1;
        const resolved = this.deps.runnerForAttempt.runnerForAttempt({ runner: attempt.runner ?? null });
        if (!resolved.ok) {
          unknown.push({ subject: attempt.id, kind: 'dead-attempt', reason: 'runner-unresolved' });
          continue;
        }
        let status: RunnerSessionStatus;
        try {
          status = await resolved.runner.inspectSession({
            attemptId: attempt.id,
            sessionId: attempt.sessionId,
            runner: attempt.runner ?? null,
          });
        } catch {
          unknown.push({ subject: attempt.id, kind: 'dead-attempt', reason: 'runner-unreadable' });
          continue;
        }
        if (status.runnerReachable === 'unknown') {
          unknown.push({ subject: attempt.id, kind: 'dead-attempt', reason: 'runner-unknown' });
          continue;
        }
        if (status.runnerReachable === 'unreachable') {
          // Unreachability does not establish that the session ended; the
          // subject stays an unknown instead of a dead-attempt observation.
          unknown.push({ subject: attempt.id, kind: 'dead-attempt', reason: 'runner-unreachable' });
          continue;
        }
        let actionEntries: readonly ActionJournalEntryRecord[];
        try {
          actionEntries = await this.deps.executionJournal.listJournalEntriesForAttempt(attempt.id);
        } catch {
          unknown.push({ subject: attempt.id, kind: 'dead-attempt', reason: 'journal-unreadable' });
          continue;
        }
        const sessionEndedOrMissing =
          status.workerCommand === 'not-started' ||
          status.workerCommand === 'ended';
        observations.push({
          kind: 'dead-attempt',
          subject: attempt.id,
          youngActivity:
            attemptYoungActivity(attempt, nowMs, graceMs) ||
            actionJournalHasYoungIntent(actionEntries, nowMs, graceMs),
          recordSaysRunning: true,
          sessionEndedOrMissing,
        });
      }
      if (!reservationsUnreadable) {
        for (const reservation of reservations) {
          if (!isPlainObject(reservation) || (reservation as { held?: unknown }).held !== true) {
            continue;
          }
          const record = reservation as { id: string; attemptId: string; reservedAtIso: string };
          if (typeof record.id !== 'string' || record.id === '') {
            continue;
          }
          reservationById.set(record.id, reservation as CapacityReservationRecord);
          if (subjects >= MAX_SUBJECTS_PER_PASS) {
            unknown.push({ subject: record.id, kind: 'leaked-slot', reason: 'pass-cap' });
            cappedKeys.add('leaked-slot\u0000' + record.id);
            continue;
          }
          subjects += 1;
          const attempt = attemptsById.get(record.attemptId);
          const state = attempt === undefined ? 'absent' : attemptStateOf(attempt.state);
          observations.push({
            kind: 'leaked-slot',
            subject: record.id,
            youngActivity: reservationsYoungActivity(record.reservedAtIso, nowMs, graceMs),
            attemptState: state,
          });
        }
      }
      if (!attentionUnreadable) {
        for (const raw of attentionItems) {
          if (!isPlainObject(raw)) {
            continue;
          }
          const item = raw as { state?: unknown; kind?: unknown; subject?: unknown };
          if (item.state !== 'open') {
            continue;
          }
          const subj = item.subject as { kind?: unknown; ref?: unknown } | null;
          if (!isPlainObject(subj) || subj.kind !== 'attempt') {
            continue;
          }
          if (typeof subj.ref !== 'string' || subj.ref === '') {
            continue;
          }
          const attempt = attemptsById.get(subj.ref);
          if (attempt === undefined || !TERMINAL_ATTEMPT_STATES.has(attempt.state)) {
            continue;
          }
          if (subjects >= MAX_SUBJECTS_PER_PASS) {
            unknown.push({ subject: subj.ref, kind: 'stale-attention', reason: 'pass-cap' });
            cappedKeys.add('stale-attention\u0000' + subj.ref);
            continue;
          }
          subjects += 1;
          observations.push({
            kind: 'stale-attention',
            subject: subj.ref,
            youngActivity: false,
            attentionOpen: true,
            questionUnanswered: false,
            runTerminal: true,
          });
          staleAttentionBySubject.set(subj.ref, {
            kind: typeof item.kind === 'string' ? item.kind : 'stale-attention',
            subjectKind: 'attempt',
          });
        }
      }

      // 4. Classify. The classifier never throws.
      findings.push(
        ...classifyZombies(
          { observations, openFindings: openRecords.map((record) => record.finding) },
          nowIso,
          policy,
        ),
      );
    }

    // 5. Upsert. Reuse the stored finding id for (kind, subject); mint only
    // for a first sighting, and validate every minted id before any write.
    const findingIds = new Map<number, string>();
    for (let index = 0; index < findings.length; index += 1) {
      const finding = findings[index];
      const existing = openRecords.find(
        (record) => record.finding.kind === finding.kind && record.finding.subject === finding.subject,
      );
      if (existing !== undefined) {
        findingIds.set(index, existing.findingId);
        continue;
      }
      const minted = mintedUlid(this.deps.newId);
      if (minted === null) {
        return { ...refused('id-source-invalid'), unknown };
      }
      findingIds.set(index, minted);
    }
    const findingViews: ReaperFindingView[] = [];
    /** The authoritative finding id per finding index; only a stored finding has one. */
    const storedIds = new Map<number, string>();
    for (let index = 0; index < findings.length; index += 1) {
      const finding = findings[index];
      const candidateId = findingIds.get(index) as string;
      let storedId: string | null = null;
      try {
        const upsert = await this.deps.reaperFindings.upsertFinding(finding, candidateId);
        if (upsert.outcome === 'stored') {
          // The stored record's id is authoritative, including when the store
          // found an existing open record for this (subject, kind): concurrent
          // passes share one finding id and therefore one repair key.
          storedId = upsert.record.findingId;
        } else {
          unknown.push({ subject: finding.subject, kind: finding.kind, reason: 'finding-store-refused' });
        }
      } catch {
        unknown.push({ subject: finding.subject, kind: finding.kind, reason: 'finding-store-unwritable' });
      }
      if (storedId === null) {
        // A finding that was not stored is not exposed: no view, no attention
        // item, and no repair may run on a locally minted candidate id.
        continue;
      }
      storedIds.set(index, storedId);
      findingViews.push({
        findingId: storedId,
        kind: finding.kind,
        subject: finding.subject,
        action: finding.action,
        sightings: finding.sightings,
      });
    }

    // 6. Raise or refresh attention for report and repair findings. When the
    // attention read failed, this part of the pass is skipped entirely. A
    // stale-attention finding is about an item that is already open: it raises
    // nothing, and its repair clears the underlying item instead.
    const attention: ReaperAttentionView[] = [];
    if (!attentionUnreadable) {
      let raised = 0;
      for (let index = 0; index < findings.length; index += 1) {
        const finding = findings[index];
        if (!storedIds.has(index) || finding.action === 'wait' || finding.kind === 'stale-attention') {
          continue;
        }
        if (raised >= MAX_ATTENTION_PER_PASS) {
          unknown.push({ subject: finding.subject, kind: finding.kind, reason: 'pass-cap' });
          continue;
        }
        raised += 1;
        const outcome = await this.recordAttention(projectId, finding, attemptsById);
        attention.push({ kind: finding.kind, subject: finding.subject, outcome });
        if (outcome === 'refused') {
          // Recorded, never retried in the same pass.
        }
      }
    }

    // 7. Repair: record-only, keyed, per kind. Only a successfully stored
    // finding participates, and only under its authoritative id.
    const repairs: ReaperRepairView[] = [];
    for (let index = 0; index < findings.length; index += 1) {
      const finding = findings[index];
      if (finding.action !== 'repair') {
        continue;
      }
      const storedId = storedIds.get(index);
      if (storedId === undefined) {
        continue; // never repaired and never surfaced under the candidate id
      }
      if (finding.kind === 'dead-attempt') {
        repairs.push(await this.repairDeadAttempt(nowIso, finding, storedId, unknown));
      } else if (finding.kind === 'leaked-slot') {
        repairs.push(
          await this.repairLeakedSlot(nowIso, finding, storedId, unknown, reservationById, attemptsById),
        );
      } else if (finding.kind === 'stale-attention') {
        repairs.push(
          await this.repairStaleAttention(nowIso, projectId, finding, storedId, unknown, attentionItems, staleAttentionBySubject),
        );
      } else {
        repairs.push({
          key: keyOf(finding.subject, finding.kind, storedId),
          kind: finding.kind,
          subject: finding.subject,
          outcome: 'skipped',
          reasonCode: 'repair-not-available',
        });
      }
    }

    // 8. Close findings the pass no longer sees: on positive evidence the
    // condition ended, close the finding and clear its attention item; a
    // repair intent without a result is reconciled read-only, never repeated.
    // This never runs when a read failed — unknown stays unknown.
    if (readsComplete) {
      await this.settleUnseenFindings(openRecords, findings, cappedKeys, {
        projectId,
        nowIso,
        attemptsById,
        reservationById,
        attentionItems,
        staleAttentionBySubject,
        unknown,
      });
    }

    return {
      outcome: 'completed',
      findings: findingViews,
      attention,
      repairs,
      unknown,
    };
  }

  /** One attention item per (project, subject, kind); ids and codes only, at most 1024 characters. */
  private async recordAttention(
    projectId: string,
    finding: ReaperFinding,
    attemptsById: ReadonlyMap<string, AttemptRecord>,
  ): Promise<ReaperAttentionOutcome> {
    const attempt = attemptsById.get(finding.subject);
    const subjectKind = attempt !== undefined ? 'attempt' : 'reservation';
    const workOrderId = attempt !== undefined ? attempt.workOrderId : null;
    const summary = truncate(
      `Reaper finding ${finding.kind} for ${subjectKind} ${finding.subject}; action ${finding.action}; sightings ${finding.sightings}`,
    );
    try {
      const result = await this.deps.attention.recordAttentionItem(
        {
          projectId,
          kind: finding.kind,
          subject: { kind: subjectKind, ref: finding.subject },
          workOrderId,
          summary,
        },
        'reaper',
      );
      return isReaperAttentionOutcome(result.outcome) ? result.outcome : 'refused';
    } catch {
      return 'refused';
    }
  }

  /**
   * The keyed record-only repair of one dead attempt: the intent is appended
   * before the action and the result after, so a crash between them leaves
   * the next pass to record `reconciled` without acting again.
   */
  private async repairDeadAttempt(
    nowIso: string,
    finding: ReaperFinding,
    findingId: string,
    unknown: ReaperUnknownView[],
  ): Promise<ReaperRepairView> {
    const keyResult = reaperRepairKey(finding.subject, finding.kind, findingId);
    if (!keyResult.ok) {
      return { key: '', kind: finding.kind, subject: finding.subject, outcome: 'skipped', reasonCode: 'key-refused' };
    }
    const key = keyResult.key;

    const entries = await this.safeListForKey(key, unknown, finding.subject, finding.kind);
    if (entries === null) {
      return { key, kind: finding.kind, subject: finding.subject, outcome: 'skipped', reasonCode: 'journal-unreadable' };
    }

    const finalResult = entries.find((entry) => entry.kind === 'result' && entry.outcome !== 'ambiguous');
    if (finalResult !== undefined) {
      return { key, kind: finding.kind, subject: finding.subject, outcome: 'skipped', reasonCode: 'already-repaired' };
    }

    const intent = entries.find((entry) => entry.kind === 'intent');
    if (intent !== undefined) {
      // Recovery: the previous pass acted and crashed before its result.
      let attempt: AttemptRecord | null;
      try {
        attempt = await this.deps.attemptRepo.findAttemptById(finding.subject);
      } catch {
        unknown.push({ subject: finding.subject, kind: finding.kind, reason: 'attempts-unreadable' });
        attempt = null;
      }
      if (attempt !== null && TERMINAL_ATTEMPT_STATES.has(attempt.state)) {
        const journaled = await this.journalResult(key, nowIso, 'reconciled', null, unknown, finding.subject, finding.kind);
        if (!journaled) {
          return { key, kind: finding.kind, subject: finding.subject, outcome: 'skipped', reasonCode: 'result-unwritten' };
        }
        return { key, kind: finding.kind, subject: finding.subject, outcome: 'reconciled' };
      }
      return {
        key,
        kind: finding.kind,
        subject: finding.subject,
        outcome: 'skipped',
        reasonCode: 'intent-without-result',
      };
    }

    const appended = await this.appendIntent(key, nowIso, findingId, unknown, finding.subject, finding.kind);
    if (appended === 'duplicate-key') {
      return { key, kind: finding.kind, subject: finding.subject, outcome: 'skipped', reasonCode: 'already-intended' };
    }
    if (appended !== 'appended') {
      return {
        key,
        kind: finding.kind,
        subject: finding.subject,
        outcome: 'skipped',
        reasonCode: appended === 'refused' ? 'journal-refused' : 'journal-unwritable',
      };
    }

    // Act: record-only reconcile of the dead attempt.
    let outcome: ReconcileAttemptResult;
    try {
      outcome = await this.deps.reconcile.reconcileAttempt({ attemptId: finding.subject, nowIso });
    } catch {
      unknown.push({ subject: finding.subject, kind: finding.kind, reason: 'reconcile-unknown' });
      return { key, kind: finding.kind, subject: finding.subject, outcome: 'skipped', reasonCode: 'reconcile-unknown' };
    }

    if (outcome.outcome === 'ended' || outcome.outcome === 'cancelled') {
      const journaled = await this.journalResult(key, nowIso, 'completed', null, unknown, finding.subject, finding.kind);
      if (!journaled) {
        return { key, kind: finding.kind, subject: finding.subject, outcome: 'skipped', reasonCode: 'result-unwritten' };
      }
      return { key, kind: finding.kind, subject: finding.subject, outcome: 'completed' };
    }
    if (outcome.outcome === 'refused') {
      const reasonCode = reasonCodeToken(outcome.reason);
      const journaled = await this.journalResult(key, nowIso, 'refused', reasonCode, unknown, finding.subject, finding.kind);
      if (!journaled) {
        return { key, kind: finding.kind, subject: finding.subject, outcome: 'skipped', reasonCode: 'result-unwritten' };
      }
      return {
        key,
        kind: finding.kind,
        subject: finding.subject,
        outcome: 'refused',
        ...(reasonCode !== null ? { reasonCode } : {}),
      };
    }
    // 'active', 'unknown' and 'not-found' stay ambiguous and the finding stays reported.
    const journaled = await this.journalResult(key, nowIso, 'ambiguous', null, unknown, finding.subject, finding.kind);
    if (!journaled) {
      return { key, kind: finding.kind, subject: finding.subject, outcome: 'skipped', reasonCode: 'result-unwritten' };
    }
    return { key, kind: finding.kind, subject: finding.subject, outcome: 'ambiguous' };
  }

  /**
   * The keyed record-only repair of one leaked slot: the fenced capacity
   * release (`releaseCapacityReservationIfUnchanged`). The release observes
   * the reservation and the attempt's revision; a changed postcondition ends
   * the repair without a write. An absent release implementation means the
   * repair is not available and the finding stays a report.
   */
  private async repairLeakedSlot(
    nowIso: string,
    finding: ReaperFinding,
    findingId: string,
    unknown: ReaperUnknownView[],
    reservationById: ReadonlyMap<string, CapacityReservationRecord>,
    attemptsById: ReadonlyMap<string, AttemptRecord>,
  ): Promise<ReaperRepairView> {
    const release = this.deps.executionJournal.releaseCapacityReservationIfUnchanged;
    if (release === undefined) {
      return {
        key: keyOf(finding.subject, finding.kind, findingId),
        kind: finding.kind,
        subject: finding.subject,
        outcome: 'skipped',
        reasonCode: 'repair-not-available',
      };
    }

    const keyResult = reaperRepairKey(finding.subject, finding.kind, findingId);
    if (!keyResult.ok) {
      return { key: '', kind: finding.kind, subject: finding.subject, outcome: 'skipped', reasonCode: 'key-refused' };
    }
    const key = keyResult.key;

    const entries = await this.safeListForKey(key, unknown, finding.subject, finding.kind);
    if (entries === null) {
      return { key, kind: finding.kind, subject: finding.subject, outcome: 'skipped', reasonCode: 'journal-unreadable' };
    }

    const finalResult = entries.find((entry) => entry.kind === 'result' && entry.outcome !== 'ambiguous');
    if (finalResult !== undefined) {
      return { key, kind: finding.kind, subject: finding.subject, outcome: 'skipped', reasonCode: 'already-repaired' };
    }

    const intent = entries.find((entry) => entry.kind === 'intent');
    if (intent !== undefined) {
      const stillHeld = reservationById.get(finding.subject)?.held === true;
      if (!stillHeld) {
        const journaled = await this.journalResult(key, nowIso, 'reconciled', null, unknown, finding.subject, finding.kind);
        if (!journaled) {
          return { key, kind: finding.kind, subject: finding.subject, outcome: 'skipped', reasonCode: 'result-unwritten' };
        }
        return { key, kind: finding.kind, subject: finding.subject, outcome: 'reconciled' };
      }
      return {
        key,
        kind: finding.kind,
        subject: finding.subject,
        outcome: 'skipped',
        reasonCode: 'intent-without-result',
      };
    }

    const appended = await this.appendIntent(key, nowIso, findingId, unknown, finding.subject, finding.kind);
    if (appended === 'duplicate-key') {
      return { key, kind: finding.kind, subject: finding.subject, outcome: 'skipped', reasonCode: 'already-intended' };
    }
    if (appended !== 'appended') {
      return {
        key,
        kind: finding.kind,
        subject: finding.subject,
        outcome: 'skipped',
        reasonCode: appended === 'refused' ? 'journal-refused' : 'journal-unwritable',
      };
    }

    const reservation = reservationById.get(finding.subject);
    if (reservation === undefined || reservation.held !== true) {
      // The reservation is already gone: the postcondition holds. Journal the
      // observed result as `reconciled` and perform no second action.
      const journaled = await this.journalResult(key, nowIso, 'reconciled', null, unknown, finding.subject, finding.kind);
      if (!journaled) {
        return { key, kind: finding.kind, subject: finding.subject, outcome: 'skipped', reasonCode: 'result-unwritten' };
      }
      return { key, kind: finding.kind, subject: finding.subject, outcome: 'reconciled' };
    }

    const attempt = attemptsById.get(reservation.attemptId);
    const attemptRevision = attempt === undefined ? 0 : (attempt.revision ?? 0);
    let result: ReleaseCapacityReservationIfUnchangedResult;
    try {
      result = await release({
        attemptId: reservation.attemptId,
        reservationId: reservation.id,
        attemptRevision,
        releasedAtIso: nowIso,
        readAttemptRevision: async () => {
          const fresh = await this.deps.attemptRepo.findAttemptById(reservation.attemptId);
          return fresh === null ? null : (fresh.revision ?? 0);
        },
      });
    } catch {
      unknown.push({ subject: finding.subject, kind: finding.kind, reason: 'release-unknown' });
      return { key, kind: finding.kind, subject: finding.subject, outcome: 'skipped', reasonCode: 'release-unknown' };
    }

    if (result.outcome === 'released') {
      const journaled = await this.journalResult(key, nowIso, 'completed', null, unknown, finding.subject, finding.kind);
      if (!journaled) {
        return { key, kind: finding.kind, subject: finding.subject, outcome: 'skipped', reasonCode: 'result-unwritten' };
      }
      return { key, kind: finding.kind, subject: finding.subject, outcome: 'completed' };
    }
    if (result.outcome === 'changed') {
      const journaled = await this.journalResult(key, nowIso, 'ambiguous', null, unknown, finding.subject, finding.kind);
      if (!journaled) {
        return { key, kind: finding.kind, subject: finding.subject, outcome: 'skipped', reasonCode: 'result-unwritten' };
      }
      return { key, kind: finding.kind, subject: finding.subject, outcome: 'ambiguous' };
    }
    if (result.outcome === 'not-held') {
      const journaled = await this.journalResult(key, nowIso, 'reconciled', null, unknown, finding.subject, finding.kind);
      if (!journaled) {
        return { key, kind: finding.kind, subject: finding.subject, outcome: 'skipped', reasonCode: 'result-unwritten' };
      }
      return { key, kind: finding.kind, subject: finding.subject, outcome: 'reconciled' };
    }
    if (result.outcome === 'unknown') {
      unknown.push({ subject: finding.subject, kind: finding.kind, reason: 'release-unknown' });
      return { key, kind: finding.kind, subject: finding.subject, outcome: 'skipped', reasonCode: 'release-unknown' };
    }
    const journaled = await this.journalResult(key, nowIso, 'refused', 'invalid-request', unknown, finding.subject, finding.kind);
    if (!journaled) {
      return { key, kind: finding.kind, subject: finding.subject, outcome: 'skipped', reasonCode: 'result-unwritten' };
    }
    return { key, kind: finding.kind, subject: finding.subject, outcome: 'refused', reasonCode: 'invalid-request' };
  }

  /**
   * The keyed record-only repair of one stale-attention finding: clear the
   * underlying open attention item. The finding's subject is the item's
   * subject ref; the item's own kind is reused so the clear targets it.
   */
  private async repairStaleAttention(
    nowIso: string,
    projectId: string,
    finding: ReaperFinding,
    findingId: string,
    unknown: ReaperUnknownView[],
    attentionItems: readonly unknown[],
    staleAttentionBySubject: ReadonlyMap<string, { kind: string; subjectKind: string }>,
  ): Promise<ReaperRepairView> {
    const keyResult = reaperRepairKey(finding.subject, finding.kind, findingId);
    if (!keyResult.ok) {
      return { key: '', kind: finding.kind, subject: finding.subject, outcome: 'skipped', reasonCode: 'key-refused' };
    }
    const key = keyResult.key;

    const entries = await this.safeListForKey(key, unknown, finding.subject, finding.kind);
    if (entries === null) {
      return { key, kind: finding.kind, subject: finding.subject, outcome: 'skipped', reasonCode: 'journal-unreadable' };
    }

    const finalResult = entries.find((entry) => entry.kind === 'result' && entry.outcome !== 'ambiguous');
    if (finalResult !== undefined) {
      return { key, kind: finding.kind, subject: finding.subject, outcome: 'skipped', reasonCode: 'already-repaired' };
    }

    const intent = entries.find((entry) => entry.kind === 'intent');
    if (intent !== undefined) {
      if (!this.isAttentionItemOpen(finding.subject, attentionItems)) {
        const journaled = await this.journalResult(key, nowIso, 'reconciled', null, unknown, finding.subject, finding.kind);
        if (!journaled) {
          return { key, kind: finding.kind, subject: finding.subject, outcome: 'skipped', reasonCode: 'result-unwritten' };
        }
        return { key, kind: finding.kind, subject: finding.subject, outcome: 'reconciled' };
      }
      return {
        key,
        kind: finding.kind,
        subject: finding.subject,
        outcome: 'skipped',
        reasonCode: 'intent-without-result',
      };
    }

    const appended = await this.appendIntent(key, nowIso, findingId, unknown, finding.subject, finding.kind);
    if (appended === 'duplicate-key') {
      return { key, kind: finding.kind, subject: finding.subject, outcome: 'skipped', reasonCode: 'already-intended' };
    }
    if (appended !== 'appended') {
      return {
        key,
        kind: finding.kind,
        subject: finding.subject,
        outcome: 'skipped',
        reasonCode: appended === 'refused' ? 'journal-refused' : 'journal-unwritable',
      };
    }

    const attentionMeta = staleAttentionBySubject.get(finding.subject);
    const attentionKind = attentionMeta?.kind ?? 'stale-attention';
    let clear: ClearAttentionShapeResult;
    try {
      clear = (await this.deps.attention.clearAttentionItem(
        {
          action: 'resolve',
          projectId,
          kind: attentionKind,
          subject: { kind: 'attempt', ref: finding.subject },
          reason: 'stale',
        },
        'machine',
        'reaper',
      )) as ClearAttentionShapeResult;
    } catch {
      unknown.push({ subject: finding.subject, kind: finding.kind, reason: 'attention-unclearable' });
      return { key, kind: finding.kind, subject: finding.subject, outcome: 'skipped', reasonCode: 'attention-unclearable' };
    }

    const outcome = clear?.outcome;
    if (outcome === 'cleared') {
      const journaled = await this.journalResult(key, nowIso, 'completed', null, unknown, finding.subject, finding.kind);
      if (!journaled) {
        return { key, kind: finding.kind, subject: finding.subject, outcome: 'skipped', reasonCode: 'result-unwritten' };
      }
      return { key, kind: finding.kind, subject: finding.subject, outcome: 'completed' };
    }
    if (outcome === 'unchanged' || outcome === 'not-found') {
      const journaled = await this.journalResult(key, nowIso, 'reconciled', null, unknown, finding.subject, finding.kind);
      if (!journaled) {
        return { key, kind: finding.kind, subject: finding.subject, outcome: 'skipped', reasonCode: 'result-unwritten' };
      }
      return { key, kind: finding.kind, subject: finding.subject, outcome: 'reconciled' };
    }
    const journaled = await this.journalResult(key, nowIso, 'refused', null, unknown, finding.subject, finding.kind);
    if (!journaled) {
      return { key, kind: finding.kind, subject: finding.subject, outcome: 'skipped', reasonCode: 'result-unwritten' };
    }
    return { key, kind: finding.kind, subject: finding.subject, outcome: 'refused' };
  }

  /** Append one intent entry; a failure is recorded and answered, never thrown. */
  private async appendIntent(
    key: string,
    nowIso: string,
    findingId: string,
    unknown: ReaperUnknownView[],
    subject: string,
    kind: string,
  ): Promise<'appended' | 'duplicate-key' | 'refused' | 'unwritable'> {
    const entryId = mintedUlid(this.deps.newId);
    if (entryId === null) {
      unknown.push({ subject, kind, reason: 'id-source-invalid' });
      return 'refused';
    }
    try {
      const append = await this.deps.runJournal.append({
        version: 1,
        entryId,
        kind: 'intent',
        key,
        runId: null,
        recordedAtIso: nowIso,
        mode: null,
        expectedRevision: null,
        mintedId: findingId,
        outcome: null,
        reasonCode: null,
        detail: null,
        grantId: null,
        state: null,
      });
      if (append.outcome === 'appended') {
        return 'appended';
      }
      return append.reason === 'duplicate-key' ? 'duplicate-key' : 'refused';
    } catch {
      unknown.push({ subject, kind, reason: 'journal-unwritable' });
      return 'unwritable';
    }
  }

  /** Read one repair key's journal; an unreadable journal is an unknown and answers null. */
  private async safeListForKey(
    key: string,
    unknown: ReaperUnknownView[],
    subject: string,
    kind: string,
  ): Promise<readonly LaneRunJournalEntryRecord[] | null> {
    try {
      return await this.deps.runJournal.listForKey(key);
    } catch {
      unknown.push({ subject, kind, reason: 'journal-unreadable' });
      return null;
    }
  }

  /** Append one result entry; a failure is recorded and answered, never thrown. */
  private async journalResult(
    key: string,
    nowIso: string,
    outcome: Extract<LaneRunJournalOutcome, 'completed' | 'refused' | 'reconciled' | 'ambiguous'>,
    reasonCode: string | null,
    unknown: ReaperUnknownView[],
    subject: string,
    kind: string,
  ): Promise<boolean> {
    const entryId = mintedUlid(this.deps.newId);
    if (entryId === null) {
      unknown.push({ subject, kind, reason: 'id-source-invalid' });
      return false;
    }
    try {
      const append = await this.deps.runJournal.append({
        version: 1,
        entryId,
        kind: 'result',
        key,
        runId: null,
        recordedAtIso: nowIso,
        mode: null,
        expectedRevision: null,
        mintedId: null,
        outcome,
        reasonCode,
        detail: null,
        grantId: null,
        state: null,
      });
      if (append.outcome === 'appended') {
        return true;
      }
      unknown.push({ subject, kind, reason: 'journal-refused' });
      return false;
    } catch {
      unknown.push({ subject, kind, reason: 'journal-unwritable' });
      return false;
    }
  }

  /**
   * Close the open findings the current pass did not see. A finding is closed
   * only on positive evidence its condition ended; a repair intent without a
   * result is reconciled read-only first, never repeated. Capped subjects and
   * findings from a pass with a failed read are never touched.
   */
  private async settleUnseenFindings(
    openRecords: readonly ReaperFindingStoreRecord[],
    currentFindings: readonly ReaperFinding[],
    cappedKeys: ReadonlySet<string>,
    ctx: SettleContext,
  ): Promise<void> {
    const currentKeys = new Set<string>();
    for (const finding of currentFindings) {
      currentKeys.add(finding.kind + '\u0000' + finding.subject);
    }
    for (const record of openRecords) {
      const key = record.finding.kind + '\u0000' + record.finding.subject;
      if (currentKeys.has(key) || cappedKeys.has(key)) {
        continue;
      }
      await this.settleOne(record, ctx);
    }
  }

  /** Decide and perform the close or recovery of one unseen open finding. */
  private async settleOne(record: ReaperFindingStoreRecord, ctx: SettleContext): Promise<void> {
    const { kind, subject } = record.finding;
    const reparables =
      kind === 'dead-attempt' || kind === 'leaked-slot' || kind === 'stale-attention';
    if (reparables) {
      const keyResult = reaperRepairKey(subject, kind, record.findingId);
      if (keyResult.ok) {
        const entries = await this.safeListForKey(keyResult.key, ctx.unknown, subject, kind);
        if (entries === null) {
          return;
        }
        const finalResult = entries.find((entry) => entry.kind === 'result' && entry.outcome !== 'ambiguous');
        if (finalResult !== undefined) {
          await this.closeAndClear(record, ctx);
          return;
        }
        const intent = entries.find((entry) => entry.kind === 'intent');
        if (intent !== undefined) {
          const recovered = await this.recoverPendingIntent(kind, subject, keyResult.key, ctx);
          if (recovered) {
            await this.closeAndClear(record, ctx);
          }
          return;
        }
      }
    }
    if (await this.hasResolutionEvidence(kind, subject, ctx)) {
      await this.closeAndClear(record, ctx);
    }
  }

  /**
   * A repair intent without a final result: reconcile the postcondition
   * read-only and journal the result it finds as `reconciled`, performing no
   * second action. An unreadable or unestablished postcondition leaves the
   * finding open.
   */
  private async recoverPendingIntent(kind: string, subject: string, key: string, ctx: SettleContext): Promise<boolean> {
    try {
      if (kind === 'dead-attempt') {
        const attempt = await this.deps.attemptRepo.findAttemptById(subject);
        if (attempt !== null && TERMINAL_ATTEMPT_STATES.has(attempt.state)) {
          return await this.journalResult(key, ctx.nowIso, 'reconciled', null, ctx.unknown, subject, kind);
        }
        return false;
      }
      if (kind === 'leaked-slot') {
        const reservation = ctx.reservationById.get(subject);
        if (reservation === undefined || reservation.held !== true) {
          return await this.journalResult(key, ctx.nowIso, 'reconciled', null, ctx.unknown, subject, kind);
        }
        return false;
      }
      if (kind === 'stale-attention') {
        if (!this.isAttentionItemOpen(subject, ctx.attentionItems)) {
          return await this.journalResult(key, ctx.nowIso, 'reconciled', null, ctx.unknown, subject, kind);
        }
        return false;
      }
      return false;
    } catch {
      ctx.unknown.push({ subject, kind, reason: 'journal-unreadable' });
      return false;
    }
  }

  /** Positive evidence the finding's condition ended; false keeps the finding open. */
  private async hasResolutionEvidence(kind: string, subject: string, ctx: SettleContext): Promise<boolean> {
    if (kind === 'dead-attempt') {
      const attempt = ctx.attemptsById.get(subject);
      return attempt !== undefined && attempt.state !== 'running';
    }
    if (kind === 'leaked-slot') {
      const reservation = ctx.reservationById.get(subject);
      if (reservation === undefined) {
        return true; // no longer held: released
      }
      const attempt = ctx.attemptsById.get(reservation.attemptId);
      if (attempt === undefined) {
        return false; // an absent attempt stays a report-only leak
      }
      return !TERMINAL_ATTEMPT_STATES.has(attempt.state);
    }
    if (kind === 'stale-attention') {
      return !this.isAttentionItemOpen(subject, ctx.attentionItems);
    }
    return false;
  }

  /** Close one finding by CAS and clear its attention item. */
  private async closeAndClear(record: ReaperFindingStoreRecord, ctx: SettleContext): Promise<void> {
    try {
      const closed = await this.deps.reaperFindings.closeFinding(record.findingId, record.revision);
      if (closed.outcome !== 'stored' && closed.outcome !== 'conflict') {
        return;
      }
    } catch {
      return;
    }
    const subjectKind = record.finding.kind === 'leaked-slot' ? 'reservation' : 'attempt';
    const attentionKind =
      record.finding.kind === 'stale-attention'
        ? (ctx.staleAttentionBySubject.get(record.finding.subject)?.kind ?? 'stale-attention')
        : record.finding.kind;
    try {
      await this.deps.attention.clearAttentionItem(
        {
          action: 'resolve',
          projectId: ctx.projectId,
          kind: attentionKind,
          subject: { kind: subjectKind, ref: record.finding.subject },
          reason: 'stale',
        },
        'machine',
        'reaper',
      );
    } catch {
      ctx.unknown.push({ subject: record.finding.subject, kind: record.finding.kind, reason: 'attention-unclearable' });
    }
  }

  /** Whether an open attention item references `ref`. */
  private isAttentionItemOpen(ref: string, attentionItems: readonly unknown[]): boolean {
    for (const raw of attentionItems) {
      if (!isPlainObject(raw)) {
        continue;
      }
      const item = raw as { state?: unknown; subject?: unknown };
      if (item.state !== 'open') {
        continue;
      }
      const subj = item.subject as { ref?: unknown } | null;
      if (isPlainObject(subj) && subj.ref === ref) {
        return true;
      }
    }
    return false;
  }
}

function attemptStateOf(state: string): 'ended' | 'collected' | 'cancelled' | 'absent' | 'live' {
  if (state === 'ended' || state === 'collected' || state === 'cancelled') {
    return state;
  }
  return 'live';
}

function isReaperAttentionOutcome(value: unknown): value is ReaperAttentionOutcome {
  return (
    value === 'raised' || value === 'refreshed' || value === 'reopened' || value === 'exists' || value === 'refused'
  );
}

function truncate(summary: string): string {
  return summary.length <= MAX_SUMMARY_LENGTH ? summary : summary.slice(0, MAX_SUMMARY_LENGTH);
}

function keyOf(subject: string, kind: string, findingId: string): string {
  const built = reaperRepairKey(subject, kind as ReaperFinding['kind'], findingId);
  return built.ok ? built.key : '';
}

function refused(reason: string): ReapZombiesResult {
  return {
    outcome: 'refused',
    reason,
    findings: [],
    attention: [],
    repairs: [],
    unknown: [],
  };
}
