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
 * Results are record-only and keyed: attempt reconciliation and clearing
 * stale attention items. A leaked slot is report-only; the reaper never
 * releases capacity. A finding the pass no longer sees is closed on
 * positive evidence the condition ended, and its attention item is cleared; a
 * repair intent without a result is reconciled read-only, never repeated. The
 * use case never throws; every failure is a typed refusal or an unknown entry,
 * and ids and codes only ever cross its boundary.
 */

import { containsSecretShape, readPlainRecord } from '@fleet/shared';
import type { PlainFieldSchema, PlainRecordSchema } from '@fleet/shared';

import type { ActionJournalEntryRecord, AttemptRecord, CapacityReservationRecord } from '../../domain/execution-records.js';
import type { AttemptRepositoryPort } from '../ports/out/AttemptRepositoryPort.out-port.js';
import type {
  ExecutionJournalPort,
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
import { REAPER_FINDING_KINDS, REQUEST_ID_PATTERN, reaperRepairKey } from '../../domain/lane-run-keys.js';

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
  /** Read-only facts only; the reaper never releases capacity. */
  readonly executionJournal: Pick<ExecutionJournalPort, 'listActiveReservations' | 'listJournalEntriesForAttempt'>;
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


/** At most this many unknown entries of one bounded reason (`pass-cap`, `subject-unsafe`) per pass. */
const MAX_BOUNDED_UNKNOWNS = 64;

function repairFlagSchema(): PlainRecordSchema {
  const flags: Record<string, PlainFieldSchema> = {};
  for (const kind of REAPER_FINDING_KINDS) {
    flags[kind] = { kind: 'boolean', optional: true };
  }
  return flags;
}

/** The policy fields the pass and the classifier read; anything else is dropped, a getter is refused. */
const POLICY_SCHEMA: PlainRecordSchema = {
  staleStopMinutes: { kind: 'integer', optional: true },
  minFreePercent: { kind: 'integer', optional: true },
  repairs: { kind: 'record', schema: repairFlagSchema(), optional: true },
};

/** Snapshot the policy through the shared plain-record reader; a hostile policy is a refusal (null). */
function readPolicy(value: unknown): ReaperPolicy | null {
  if (value === undefined) {
    return {};
  }
  const read = readPlainRecord(value, POLICY_SCHEMA);
  return read.ok ? (read.value as ReaperPolicy) : null;
}

interface ParsedRequest {
  readonly projectId: string;
  readonly nowIso: string;
  readonly nowMs: number;
  readonly graceMs: number;
  readonly policy: ReaperPolicy;
}

/**
 * `graceMinutes` is any finite number >= 0 (fractions allowed), read from the
 * own data property only: a getter, NaN, Infinity, a negative or a non-number
 * is a refusal (null); absent is the default. Never throws.
 */
function readGraceMinutes(policy: unknown): number | null {
  if (policy === undefined) {
    return DEFAULT_GRACE_MINUTES;
  }
  try {
    const descriptor = Object.getOwnPropertyDescriptor(policy as object, 'graceMinutes');
    if (descriptor === undefined) {
      return DEFAULT_GRACE_MINUTES;
    }
    if (descriptor.get !== undefined || descriptor.set !== undefined) {
      return null;
    }
    const grace: unknown = descriptor.value;
    if (grace === undefined) {
      return DEFAULT_GRACE_MINUTES;
    }
    return typeof grace === 'number' && Number.isFinite(grace) && grace >= 0 ? grace : null;
  } catch {
    return null;
  }
}

/** Validate the request; null is the `request-invalid` refusal. Never throws. */
function parseRequest(request: unknown): ParsedRequest | null {
  if (!isPlainObject(request)) {
    return null;
  }
  const projectId = readField(request, 'projectId');
  if (typeof projectId !== 'string' || projectId === '' || containsSecretShape(projectId)) {
    return null;
  }
  const nowIso = parseNowIso(readField(request, 'nowIso'));
  const policy = readPolicy(readField(request, 'policy'));
  if (nowIso === null || policy === null) {
    return null;
  }
  const graceMinutes = readGraceMinutes(readField(request, 'policy'));
  if (graceMinutes === null) {
    return null;
  }
  return { projectId, nowIso, nowMs: Date.parse(nowIso), graceMs: graceMinutes * MINUTE_MS, policy };
}

/** A subject id that may appear in output: a string that is not secret-shaped. */
function isSafeSubject(id: unknown): id is string {
  return typeof id === 'string' && !containsSecretShape(id);
}

/** Push an unknown whose reason is bounded: past the cap the entry is dropped, never grown without limit. */
function pushBounded(unknown: ReaperUnknownView[], entry: ReaperUnknownView): void {
  let count = 0;
  for (const existing of unknown) {
    if (existing.reason === entry.reason) {
      count += 1;
    }
  }
  if (count < MAX_BOUNDED_UNKNOWNS) {
    unknown.push(entry);
  }
}

/** Run one read; a throw is an unknown (never an empty read) and yields null. */
async function safeRead<T>(read: () => Promise<T>, reason: string, unknown: ReaperUnknownView[]): Promise<T | null> {
  try {
    return await read();
  } catch {
    unknown.push({ subject: '', reason });
    return null;
  }
}

/** Everything the observation builders fill in for one pass. */
interface ObservationBuild {
  readonly observations: ReaperObservation[];
  readonly attemptsById: Map<string, AttemptRecord>;
  readonly reservationById: Map<string, CapacityReservationRecord>;
  /** Subjects skipped by the per-pass cap: their open findings are never closed. */
  readonly cappedKeys: Set<string>;
  /** The attention item behind each stale-attention subject, so a clear targets it. */
  readonly staleAttentionBySubject: Map<string, { kind: string; subjectKind: string }>;
  readonly unknown: ReaperUnknownView[];
  subjects: number;
}

/** Claim one of the per-pass subject slots; past the cap the subject is an unknown, never silently dropped. */
function claimSubjectSlot(build: ObservationBuild, kind: string, subject: string): boolean {
  if (build.subjects >= MAX_SUBJECTS_PER_PASS) {
    pushBounded(build.unknown, { subject, kind, reason: 'pass-cap' });
    build.cappedKeys.add(kind + '\u0000' + subject);
    return false;
  }
  build.subjects += 1;
  return true;
}

/** A subject id that is secret-shaped is redacted: skipped with an id-free unknown. */
function screenSubject(build: ObservationBuild, id: unknown): id is string {
  if (isSafeSubject(id)) {
    return true;
  }
  pushBounded(build.unknown, { subject: '', reason: 'subject-unsafe' });
  return false;
}

interface PassFacts {
  readonly attempts: readonly AttemptRecord[] | null;
  readonly reservations: Awaited<ReturnType<ExecutionJournalPort['listActiveReservations']>> | null;
  readonly attentionItems: readonly unknown[] | null;
}

export class ReapZombiesUseCase implements ReapZombiesPort {
  private readonly deps: ReapZombiesDependencies;

  constructor(deps: ReapZombiesDependencies) {
    this.deps = deps;
  }

  async reapZombies(request: ReapZombiesRequest): Promise<ReapZombiesResult> {
    // 1. Validate. Never throw on runtime input.
    const parsed = parseRequest(request);
    if (parsed === null) {
      return refused('request-invalid');
    }
    const { projectId, nowIso, nowMs, graceMs, policy } = parsed;

    // 2. Read the facts. A read that throws is an unknown; the affected part
    // of the pass is skipped, never substituted with an empty read, and an
    // unreadable findings store writes nothing at all.
    const unknown: ReaperUnknownView[] = [];
    const facts = await this.readFacts(projectId, unknown);
    const openRecords = await this.readOpenFindings();
    if (openRecords === null) {
      return {
        outcome: 'completed',
        findings: [],
        attention: [],
        repairs: [],
        unknown: [...unknown, { subject: '', reason: 'findings-unreadable' }],
      };
    }
    const readsComplete = facts.attempts !== null && facts.reservations !== null && facts.attentionItems !== null;

    // 3-4. Observe and classify. When the attempts read failed, no
    // observation is built at all: a reservation whose attempt could not be
    // read is not classified as `absent`.
    const built = this.newBuild(unknown);
    let findings: ReaperFinding[] = [];
    if (facts.attempts !== null) {
      await this.buildObservations(built, facts, nowMs, graceMs);
      findings = [...classifyZombies({ observations: built.observations, openFindings: openRecords.map((r) => r.finding) }, nowIso, policy)];
    }

    // 5. Upsert under reused or freshly minted ids.
    const stored = await this.storeFindings(findings, openRecords, unknown);
    if (stored === null) {
      return { ...refused('id-source-invalid'), unknown };
    }

    const ctx: SettleContext = {
      projectId,
      nowIso,
      attemptsById: built.attemptsById,
      reservationById: built.reservationById,
      attentionItems: facts.attentionItems ?? [],
      staleAttentionBySubject: built.staleAttentionBySubject,
      unknown,
    };

    // 6. Raise or refresh attention (skipped when the attention read failed).
    const attention = facts.attentionItems === null ? [] : await this.raiseAttention(findings, stored.storedIds, ctx);

    // 7. Repair: record-only, keyed, per kind.
    const repairs = await this.runRepairs(findings, stored.storedIds, ctx);

    // 8. Close findings the pass no longer sees, only when every read succeeded.
    if (readsComplete) {
      await this.settleUnseenFindings(openRecords, findings, built.cappedKeys, ctx);
    }

    return { outcome: 'completed', findings: stored.views, attention, repairs, unknown };
  }

  private async readFacts(projectId: string, unknown: ReaperUnknownView[]): Promise<PassFacts> {
    const attempts = await safeRead(() => this.deps.attemptRepo.listAllAttempts(), 'attempts-unreadable', unknown);
    const reservations = await safeRead(
      () => this.deps.executionJournal.listActiveReservations(),
      'reservations-unreadable',
      unknown,
    );
    const attentionItems = await safeRead(
      async () => {
        const result = await this.deps.attention.listAttentionItems({ projectId });
        return Array.isArray(result?.items) ? result.items : [];
      },
      'attention-unreadable',
      unknown,
    );
    return { attempts, reservations, attentionItems };
  }

  private async readOpenFindings(): Promise<readonly ReaperFindingStoreRecord[] | null> {
    try {
      return await this.deps.reaperFindings.listOpenFindings();
    } catch {
      return null;
    }
  }

  private newBuild(unknown: ReaperUnknownView[]): ObservationBuild {
    return {
      observations: [],
      attemptsById: new Map<string, AttemptRecord>(),
      reservationById: new Map<string, CapacityReservationRecord>(),
      cappedKeys: new Set<string>(),
      staleAttentionBySubject: new Map<string, { kind: string; subjectKind: string }>(),
      unknown,
      subjects: 0,
    };
  }

  /** Observations for every kind the read ports can establish, in the order attempts, reservations, attention. */
  private async buildObservations(
    build: ObservationBuild,
    facts: PassFacts,
    nowMs: number,
    graceMs: number,
  ): Promise<void> {
    const attempts = facts.attempts ?? [];
    for (const entry of attempts) {
      if (isPlainObject(entry) && typeof (entry as { id?: unknown }).id === 'string') {
        build.attemptsById.set((entry as { id: string }).id, entry);
      }
    }
    for (const attempt of attempts) {
      if (isPlainObject(attempt)) {
        await this.observeDeadAttempt(build, attempt, nowMs, graceMs);
      } // a sparse or malformed entry is skipped, never thrown on
    }
    if (facts.reservations !== null) {
      for (const reservation of facts.reservations) {
        this.observeLeakedSlot(build, reservation, nowMs, graceMs);
      }
    }
    if (facts.attentionItems !== null) {
      for (const raw of facts.attentionItems) {
        this.observeStaleAttention(build, raw);
      }
    }
  }

  private async observeDeadAttempt(
    build: ObservationBuild,
    attempt: AttemptRecord,
    nowMs: number,
    graceMs: number,
  ): Promise<void> {
    if (attempt.state !== 'running' || typeof attempt.sessionId !== 'string') {
      return;
    }
    if (!screenSubject(build, attempt.id) || !claimSubjectSlot(build, 'dead-attempt', attempt.id)) {
      return;
    }
    const inspected = await this.inspectAttempt(attempt, build.unknown);
    if (inspected === null) {
      return;
    }
    build.observations.push({
      kind: 'dead-attempt',
      subject: attempt.id,
      youngActivity:
        attemptYoungActivity(attempt, nowMs, graceMs) ||
        actionJournalHasYoungIntent(inspected.actionEntries, nowMs, graceMs),
      recordSaysRunning: true,
      sessionEndedOrMissing: inspected.status.workerCommand === 'not-started' || inspected.status.workerCommand === 'ended',
    });
  }

  /** The runner's view and the action journal of one running attempt; null (with an unknown) when either is not established. */
  private async inspectAttempt(
    attempt: AttemptRecord,
    unknown: ReaperUnknownView[],
  ): Promise<{ status: RunnerSessionStatus; actionEntries: readonly ActionJournalEntryRecord[] } | null> {
    const fail = (reason: string): null => {
      unknown.push({ subject: attempt.id, kind: 'dead-attempt', reason });
      return null;
    };
    const resolved = this.deps.runnerForAttempt.runnerForAttempt({ runner: attempt.runner ?? null });
    if (!resolved.ok) {
      return fail('runner-unresolved');
    }
    let status: RunnerSessionStatus;
    try {
      status = await resolved.runner.inspectSession({
        attemptId: attempt.id,
        sessionId: attempt.sessionId as string,
        runner: attempt.runner ?? null,
      });
    } catch {
      return fail('runner-unreadable');
    }
    if (status.runnerReachable === 'unknown') {
      return fail('runner-unknown');
    }
    if (status.runnerReachable === 'unreachable') {
      // Unreachability does not establish that the session ended.
      return fail('runner-unreachable');
    }
    try {
      return { status, actionEntries: await this.deps.executionJournal.listJournalEntriesForAttempt(attempt.id) };
    } catch {
      return fail('journal-unreadable');
    }
  }

  private observeLeakedSlot(build: ObservationBuild, reservation: unknown, nowMs: number, graceMs: number): void {
    if (!isPlainObject(reservation) || reservation.held !== true) {
      return;
    }
    const record = reservation as unknown as CapacityReservationRecord;
    if (typeof record.id !== 'string' || record.id === '') {
      return;
    }
    if (!screenSubject(build, record.id)) {
      return;
    }
    build.reservationById.set(record.id, record);
    if (!claimSubjectSlot(build, 'leaked-slot', record.id)) {
      return;
    }
    const attempt = build.attemptsById.get(record.attemptId);
    build.observations.push({
      kind: 'leaked-slot',
      subject: record.id,
      youngActivity: reservationsYoungActivity(record.reservedAtIso, nowMs, graceMs),
      attemptState: attempt === undefined ? 'absent' : attemptStateOf(attempt.state),
    });
  }

  private observeStaleAttention(build: ObservationBuild, raw: unknown): void {
    if (!isPlainObject(raw) || raw.state !== 'open') {
      return;
    }
    const subj = raw.subject as { kind?: unknown; ref?: unknown } | null;
    if (!isPlainObject(subj) || subj.kind !== 'attempt' || typeof subj.ref !== 'string' || subj.ref === '') {
      return;
    }
    const attempt = build.attemptsById.get(subj.ref);
    if (attempt === undefined || !TERMINAL_ATTEMPT_STATES.has(attempt.state)) {
      return;
    }
    if (!screenSubject(build, subj.ref) || !claimSubjectSlot(build, 'stale-attention', subj.ref)) {
      return;
    }
    build.observations.push({
      kind: 'stale-attention',
      subject: subj.ref,
      youngActivity: false,
      attentionOpen: true,
      questionUnanswered: false,
      runTerminal: true,
    });
    build.staleAttentionBySubject.set(subj.ref, {
      kind: typeof raw.kind === 'string' ? raw.kind : 'stale-attention',
      subjectKind: 'attempt',
    });
  }

  /**
   * Upsert every finding under its stored id (reused for an open
   * `(kind, subject)`, else a validated ULID). Null when the id source is
   * invalid. Only a stored finding is exposed or repaired.
   */
  private async storeFindings(
    findings: readonly ReaperFinding[],
    openRecords: readonly ReaperFindingStoreRecord[],
    unknown: ReaperUnknownView[],
  ): Promise<{ views: ReaperFindingView[]; storedIds: Map<number, string> } | null> {
    const candidateIds: string[] = [];
    for (const finding of findings) {
      const existing = openRecords.find(
        (record) => record.finding.kind === finding.kind && record.finding.subject === finding.subject,
      );
      const id = existing !== undefined ? existing.findingId : mintedUlid(this.deps.newId);
      if (id === null) {
        return null;
      }
      candidateIds.push(id);
    }
    const views: ReaperFindingView[] = [];
    const storedIds = new Map<number, string>();
    for (let index = 0; index < findings.length; index += 1) {
      const finding = findings[index];
      const storedId = await this.upsertOne(finding, candidateIds[index], unknown);
      if (storedId === null) {
        continue; // not stored: no view, no attention item, no repair on a candidate id
      }
      storedIds.set(index, storedId);
      views.push({
        findingId: storedId,
        kind: finding.kind,
        subject: finding.subject,
        action: finding.action,
        sightings: finding.sightings,
      });
    }
    return { views, storedIds };
  }

  /** The stored record's id is authoritative: concurrent passes share one finding id and one repair key. */
  private async upsertOne(finding: ReaperFinding, candidateId: string, unknown: ReaperUnknownView[]): Promise<string | null> {
    try {
      const upsert = await this.deps.reaperFindings.upsertFinding(finding, candidateId);
      if (upsert.outcome === 'stored') {
        return upsert.record.findingId;
      }
      unknown.push({ subject: finding.subject, kind: finding.kind, reason: 'finding-store-refused' });
    } catch {
      unknown.push({ subject: finding.subject, kind: finding.kind, reason: 'finding-store-unwritable' });
    }
    return null;
  }

  /**
   * Attention for report and repair findings. A stale-attention finding is
   * about an item that is already open: it raises nothing, and its repair
   * clears the underlying item instead.
   */
  private async raiseAttention(
    findings: readonly ReaperFinding[],
    storedIds: ReadonlyMap<number, string>,
    ctx: SettleContext,
  ): Promise<ReaperAttentionView[]> {
    const attention: ReaperAttentionView[] = [];
    let raised = 0;
    for (let index = 0; index < findings.length; index += 1) {
      const finding = findings[index];
      if (!storedIds.has(index) || finding.action === 'wait' || finding.kind === 'stale-attention') {
        continue;
      }
      if (raised >= MAX_ATTENTION_PER_PASS) {
        pushBounded(ctx.unknown, { subject: finding.subject, kind: finding.kind, reason: 'pass-cap' });
        continue;
      }
      raised += 1;
      // A refusal is recorded in the view, never retried in the same pass.
      const outcome = await this.recordAttention(ctx.projectId, finding, ctx.attemptsById);
      attention.push({ kind: finding.kind, subject: finding.subject, outcome });
    }
    return attention;
  }

  /** Only a successfully stored finding participates, and only under its authoritative id. */
  private async runRepairs(
    findings: readonly ReaperFinding[],
    storedIds: ReadonlyMap<number, string>,
    ctx: SettleContext,
  ): Promise<ReaperRepairView[]> {
    const repairs: ReaperRepairView[] = [];
    for (let index = 0; index < findings.length; index += 1) {
      const finding = findings[index];
      const storedId = storedIds.get(index);
      if (finding.action === 'repair' && storedId !== undefined) {
        repairs.push(await this.repairOne(finding, storedId, ctx));
      }
    }
    return repairs;
  }

  private async repairOne(finding: ReaperFinding, storedId: string, ctx: SettleContext): Promise<ReaperRepairView> {
    switch (finding.kind) {
      case 'dead-attempt':
        return await this.repairDeadAttempt(ctx.nowIso, finding, storedId, ctx.unknown);
      // A leaked slot is report-only whatever the policy says: the reaper
      // never releases capacity, so it falls to `repair-not-available`.
      case 'stale-attention':
        return await this.repairStaleAttention(
          ctx.nowIso,
          ctx.projectId,
          finding,
          storedId,
          ctx.unknown,
          ctx.attentionItems,
          ctx.staleAttentionBySubject,
        );
      default:
        return {
          key: keyOf(finding.subject, finding.kind, storedId),
          kind: finding.kind,
          subject: finding.subject,
          outcome: 'skipped',
          reasonCode: 'repair-not-available',
        };
    }
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

    if (entries.some((entry) => entry.kind === 'intent')) {
      return await this.recoverDeadAttempt(key, nowIso, finding, unknown);
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

    return await this.actDeadAttempt(key, nowIso, finding, unknown);
  }

  /** A dead-attempt repair intent without a result: reconcile read-only, never act twice. */
  private async recoverDeadAttempt(
    key: string,
    nowIso: string,
    finding: ReaperFinding,
    unknown: ReaperUnknownView[],
  ): Promise<ReaperRepairView> {
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

  /** The act step of a dead-attempt repair: the record-only reconcile and its journaled result. */
  private async actDeadAttempt(
    key: string,
    nowIso: string,
    finding: ReaperFinding,
    unknown: ReaperUnknownView[],
  ): Promise<ReaperRepairView> {
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
      if (closed.outcome === 'conflict') {
        // A concurrent pass updated the finding: leave it and its attention item as they are.
        ctx.unknown.push({ subject: record.finding.subject, kind: record.finding.kind, reason: 'finding-close-conflict' });
        return;
      }
      if (closed.outcome !== 'stored') {
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
