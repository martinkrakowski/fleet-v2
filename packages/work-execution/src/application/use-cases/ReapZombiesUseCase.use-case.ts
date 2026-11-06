// Implemented for lane K11a2.
/**
 * ReapZombiesUseCase: one reaper pass. It gathers facts through existing read
 * ports (attempts, held reservations, attention items, stored open findings),
 * classifies with the merged `classifyZombies`, upserts one finding per open
 * `(subject, kind)`, raises or refreshes attention items, and performs only
 * record-only repairs under keyed journal entries: the intent before the
 * action, the result after, so a crash between the two is reconciled by the
 * next pass instead of a second action. No destructive repair, no capacity
 * release (`leaked-slot` is report-only), no policy read — the
 * already-resolved policy arrives on the request. The use case never throws;
 * every failure is a typed refusal or an unknown entry, and ids and codes
 * only ever cross its boundary.
 */

import { containsSecretShape } from '@fleet/shared';

import type { AttemptRecord } from '../../domain/execution-records.js';
import type { AttemptRepositoryPort } from '../ports/out/AttemptRepositoryPort.out-port.js';
import type { ExecutionJournalPort } from '../ports/out/ExecutionJournalPort.out-port.js';
import type {
  LaneRunJournalEntryRecord,
  LaneRunJournalOutcome,
} from '../../domain/lane-run-journal.js';
import type { LaneRunJournalPort } from '../ports/out/LaneRunJournalPort.out-port.js';
import type { ExecutionRunnerPort, RunnerSessionStatus } from '../ports/out/ExecutionRunnerPort.out-port.js';
import type { RunnerForAttemptPort } from '../ports/out/RunnerForAttemptPort.out-port.js';
import type { ReconcileAttemptPort, ReconcileAttemptResult } from '../ports/in/ReconcileAttemptPort.in-port.js';
import type { ReaperFindingRepositoryPort } from '../ports/out/ReaperFindingRepositoryPort.out-port.js';
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
  /** Read-only: the reaper never releases a capacity reservation. */
  readonly executionJournal: Pick<ExecutionJournalPort, 'listActiveReservations'>;
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

    // 2. Read the facts. A read that throws is an unknown; an unreadable
    // findings store writes nothing at all — never treated as empty.
    const unknown: ReaperUnknownView[] = [];
    let attempts: readonly AttemptRecord[];
    try {
      attempts = await this.deps.attemptRepo.listAllAttempts();
    } catch {
      attempts = [];
      unknown.push({ subject: '', reason: 'attempts-unreadable' });
    }
    let reservations: Awaited<ReturnType<ExecutionJournalPort['listActiveReservations']>>;
    try {
      reservations = await this.deps.executionJournal.listActiveReservations();
    } catch {
      reservations = [];
      unknown.push({ subject: '', reason: 'reservations-unreadable' });
    }
    try {
      await this.deps.attention.listAttentionItems({ projectId });
    } catch {
      unknown.push({ subject: '', reason: 'attention-unreadable' });
    }
    let openRecords: Awaited<ReturnType<ReaperFindingRepositoryPort['listOpenFindings']>>;
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

    // 3. Build the observations, one per subject, this lane's two kinds only.
    const observations: ReaperObservation[] = [];
    let subjects = 0;
    const attemptsById = new Map<string, AttemptRecord>();
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
      const sessionEndedOrMissing =
        status.runnerReachable === 'unreachable' ||
        status.workerCommand === 'not-started' ||
        status.workerCommand === 'ended';
      observations.push({
        kind: 'dead-attempt',
        subject: attempt.id,
        youngActivity: attemptYoungActivity(attempt, nowMs, graceMs),
        recordSaysRunning: true,
        sessionEndedOrMissing,
      });
    }
    for (const reservation of reservations) {
      if (!isPlainObject(reservation) || (reservation as { held?: unknown }).held !== true) {
        continue;
      }
      const record = reservation as { id: string; attemptId: string; reservedAtIso: string };
      if (subjects >= MAX_SUBJECTS_PER_PASS) {
        unknown.push({ subject: record.id, kind: 'leaked-slot', reason: 'pass-cap' });
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

    // 4. Classify. The classifier never throws.
    const findings = classifyZombies(
      { observations, openFindings: openRecords.map((record) => record.finding) },
      nowIso,
      policy,
    );

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
    for (let index = 0; index < findings.length; index += 1) {
      const finding = findings[index];
      const findingId = findingIds.get(index) as string;
      let storedId = findingId;
      try {
        const upsert = await this.deps.reaperFindings.upsertFinding(finding, findingId);
        if (upsert.outcome === 'stored') {
          storedId = upsert.record.findingId;
        } else {
          unknown.push({ subject: finding.subject, kind: finding.kind, reason: 'finding-store-refused' });
        }
      } catch {
        unknown.push({ subject: finding.subject, kind: finding.kind, reason: 'finding-store-unwritable' });
        continue;
      }
      findingViews.push({
        findingId: storedId,
        kind: finding.kind,
        subject: finding.subject,
        action: finding.action,
        sightings: finding.sightings,
      });
    }

    // 6. Raise or refresh attention for report and repair findings.
    const attention: ReaperAttentionView[] = [];
    let raised = 0;
    for (const finding of findings) {
      if (finding.action === 'wait') {
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

    // 7. Repair: record-only, keyed, dead-attempt only.
    const repairs: ReaperRepairView[] = [];
    for (let index = 0; index < findings.length; index += 1) {
      const finding = findings[index];
      if (finding.action !== 'repair') {
        continue;
      }
      const findingId = findingIds.get(index) as string;
      if (finding.kind !== 'dead-attempt') {
        repairs.push({
          key: keyOf(finding.subject, finding.kind, findingId),
          kind: finding.kind,
          subject: finding.subject,
          outcome: 'skipped',
          reasonCode: 'repair-not-available',
        });
        continue;
      }
      repairs.push(
        await this.repairDeadAttempt(nowIso, finding, findingId, unknown),
      );
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

    let entries: readonly LaneRunJournalEntryRecord[];
    try {
      entries = await this.deps.runJournal.listForKey(key);
    } catch {
      unknown.push({ subject: finding.subject, kind: finding.kind, reason: 'journal-unreadable' });
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
        const journaled = await this.journalResult(key, nowIso, 'reconciled', null, unknown, finding);
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

    const entryId = mintedUlid(this.deps.newId);
    if (entryId === null) {
      return { key, kind: finding.kind, subject: finding.subject, outcome: 'skipped', reasonCode: 'id-source-invalid' };
    }
    let appended: 'appended' | 'duplicate-key' | 'refused';
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
      appended = append.outcome === 'appended' ? 'appended' : append.reason === 'duplicate-key' ? 'duplicate-key' : 'refused';
    } catch {
      unknown.push({ subject: finding.subject, kind: finding.kind, reason: 'journal-unwritable' });
      return { key, kind: finding.kind, subject: finding.subject, outcome: 'skipped', reasonCode: 'journal-unwritable' };
    }
    if (appended === 'duplicate-key') {
      return { key, kind: finding.kind, subject: finding.subject, outcome: 'skipped', reasonCode: 'already-intended' };
    }
    if (appended === 'refused') {
      unknown.push({ subject: finding.subject, kind: finding.kind, reason: 'journal-refused' });
      return { key, kind: finding.kind, subject: finding.subject, outcome: 'skipped', reasonCode: 'journal-refused' };
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
      const journaled = await this.journalResult(key, nowIso, 'completed', null, unknown, finding);
      if (!journaled) {
        return { key, kind: finding.kind, subject: finding.subject, outcome: 'skipped', reasonCode: 'result-unwritten' };
      }
      return { key, kind: finding.kind, subject: finding.subject, outcome: 'completed' };
    }
    if (outcome.outcome === 'refused') {
      const reasonCode = reasonCodeToken(outcome.reason);
      const journaled = await this.journalResult(key, nowIso, 'refused', reasonCode, unknown, finding);
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
    const journaled = await this.journalResult(key, nowIso, 'ambiguous', null, unknown, finding);
    if (!journaled) {
      return { key, kind: finding.kind, subject: finding.subject, outcome: 'skipped', reasonCode: 'result-unwritten' };
    }
    return { key, kind: finding.kind, subject: finding.subject, outcome: 'ambiguous' };
  }

  /** Append one result entry; a failure is recorded and answered, never thrown. */
  private async journalResult(
    key: string,
    nowIso: string,
    outcome: Extract<LaneRunJournalOutcome, 'completed' | 'refused' | 'reconciled' | 'ambiguous'>,
    reasonCode: string | null,
    unknown: ReaperUnknownView[],
    finding: ReaperFinding,
  ): Promise<boolean> {
    const entryId = mintedUlid(this.deps.newId);
    if (entryId === null) {
      unknown.push({ subject: finding.subject, kind: finding.kind, reason: 'id-source-invalid' });
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
      unknown.push({ subject: finding.subject, kind: finding.kind, reason: 'journal-refused' });
      return false;
    } catch {
      unknown.push({ subject: finding.subject, kind: finding.kind, reason: 'journal-unwritable' });
      return false;
    }
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
