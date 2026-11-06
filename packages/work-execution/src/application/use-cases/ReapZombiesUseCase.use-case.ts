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

import type { ActionJournalEntryRecord, AttemptRecord, AttemptRunnerRecord, CapacityReservationRecord } from '../../domain/execution-records.js';
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
  ListWorktreesResult,
  InspectWorktreeForRemovalResult,
  ReadFilesystemSpaceResult,
} from '../ports/out/WorkspacePort.out-port.js';
import type { ForgeReadPort } from '../ports/out/ForgeReadPort.out-port.js';
import type { WorkspacePort } from '../ports/out/WorkspacePort.out-port.js';
import { pathUnderPrefix } from '../../domain/lane-diff-check.js';
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
  ReaperWorktreeView,
} from '../ports/in/ReapZombiesPort.in-port.js';
import {
  classifyZombies,
  type ReaperFact,
  type ReaperFinding,
  type ReaperObservation,
  type ReaperPolicy,
} from '../../domain/reaper-findings.js';
import { runnerHasHostName } from '../../domain/execution-records.js';
import { REAPER_FINDING_KINDS, REAPER_SUBJECT_ID_PATTERN, REQUEST_ID_PATTERN, reaperRepairKey } from '../../domain/lane-run-keys.js';

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

/**
 * The project-profile surface the reaper needs, declared locally so
 * application code imports no cross-package type. The composition root binds
 * the coordination context's `listProjectProfiles` read here; its shape
 * satisfies this structurally (D3).
 */
export interface ReaperProjectProfileView {
  readonly projectId: string;
  readonly status: 'active' | 'retired';
  readonly defaultBranch: string | null;
  readonly clones: Readonly<Record<string, { readonly path: string; readonly worktreeRoot: string }>>;
}

export interface ReaperProjectProfilesPort {
  listProjectProfiles(request: { readonly status?: 'active' | 'retired' }): Promise<
    | { readonly outcome: 'listed'; readonly profiles: readonly ReaperProjectProfileView[] }
    | { readonly outcome: 'rejected'; readonly reason: string }
  >;
}

/** The forge read the evidence fact needs (D5), declared locally like the attention port. */
type ReaperForgeReadPort = Pick<ForgeReadPort, 'readPullRequest' | 'isConfigured'>;

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
  /** Absent: the worktree and disk gathering does not run and claims nothing. */
  readonly workspace?: Pick<
    WorkspacePort,
    'listWorktrees' | 'inspectWorktreeForRemoval' | 'readFilesystemSpace'
  >;
  /** Absent: no enumeration of the active profiles' clones. */
  readonly profiles?: ReaperProjectProfilesPort;
  /** Absent: the `evidence` fact is unknown, so no merged-worktree finding is reported. */
  readonly forgeRead?: Pick<ForgeReadPort, 'readPullRequest' | 'isConfigured'>;
  /** The digest behind a worktree subject; injected, never node:crypto here. */
  readonly computeDigest?: (text: string) => string;
}

const MAX_SUBJECTS_PER_PASS = 64;
const MAX_CLONES_PER_PASS = 16;
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
  readonly staleAttentionBySubject: ReadonlyMap<string, StaleAttentionTarget>;
  readonly unknown: ReaperUnknownView[];
  /** The resolved reaper policy, for the disk hysteresis thresholds (D8/D9). */
  readonly policy: ReaperPolicy;
  /** The current pass's disk readings per host digest; a missing host means the read failed. */
  readonly diskFreePercentByHost: ReadonlyMap<string, number>;
  /** The worktrees this pass inspected, with their branch facts, for the settle sweep. */
  readonly inspectedWorktrees: ReadonlyMap<string, InspectedWorktreeFacts>;
  /** The subjects this pass reported as busy (D7). */
  readonly busySubjects: ReadonlySet<string>;
}

/**
 * The open attention item behind one stale-attention finding. The finding's
 * subject is `<attempt ref>:<item kind>`, so two open items of different kinds
 * on one terminal attempt are two findings, each repaired and journalled on its
 * own key.
 */
interface StaleAttentionTarget {
  readonly ref: string;
  readonly kind: string;
  readonly subjectKind: string;
}

const STALE_ATTENTION_DEFAULT_KIND = 'stale-attention';
const ATTENTION_KIND_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

function staleAttentionSubject(ref: string, kind: string): string {
  return ref + ':' + kind;
}

/** The branch facts one inspected worktree carried this pass, for the settle sweep. */
interface InspectedWorktreeFacts {
  readonly headOnDefault: 'yes' | 'no' | 'unknown';
  readonly branch: string | null;
  readonly evidence: 'merged-pr' | 'ancestor-only' | 'unknown';
}

/** The context the worktree and disk gathering needs for one pass. */
interface WorktreeBuild {
  /** The busy subjects of this pass: reported as `worktree-busy`, never classified. */
  readonly busySubjects: Set<string>;
  /** One busy report per busy subject: the evidence read or unknown, and the measured size. */
  readonly busyReports: Map<string, { readonly evidence: 'merged-pr' | 'ancestor-only' | 'unknown'; readonly sizeBytes: number | null }>;
  /** The merge evidence per classified subject. */
  readonly mergedEvidence: Map<string, 'merged-pr' | 'ancestor-only' | 'unknown'>;
  /** The measured size per subject; null when the measurement ran out of budget. */
  readonly sizeBySubject: Map<string, number | null>;
  /** The branch facts of every inspected subject, for the settle sweep. */
  readonly inspectedWorktrees: Map<string, InspectedWorktreeFacts>;
  /** The disk free percent per host digest, for the hysteresis close. */
  readonly diskFreePercentByHost: Map<string, number>;
  /** Dedupe: the first clone to claim a subject digest wins. */
  readonly digestByPath: Map<string, string>;
  /** False once any worktree or disk read of this pass failed: nothing may be closed. */
  readsComplete: boolean;
}

/** One registered clone to read (D2/D3): only registered clones' worktrees are ever read. */
interface CloneRef {
  readonly projectId: string;
  readonly hostName: string;
  readonly clonePath: string;
  readonly worktreeRoot: string;
  readonly defaultRef: string;
  readonly recordedHost: AttemptRunnerRecord;
}

/** The (ref, kind) a stale-attention subject names: the pass's map first, else parse it; a bare id is the legacy form. */
function staleAttentionTarget(
  subject: string,
  known: ReadonlyMap<string, StaleAttentionTarget>,
): StaleAttentionTarget {
  const mapped = known.get(subject);
  if (mapped !== undefined) {
    return mapped;
  }
  const split = subject.lastIndexOf(':');
  if (split > 0 && ATTENTION_KIND_PATTERN.test(subject.slice(split + 1))) {
    return { ref: subject.slice(0, split), kind: subject.slice(split + 1), subjectKind: 'attempt' };
  }
  return { ref: subject, kind: STALE_ATTENTION_DEFAULT_KIND, subjectKind: 'attempt' };
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

/** D9: the effective retention hours; a missing, non-finite or negative value reads as the default 24. */
function effectiveRetentionHours(policy: ReaperPolicy): number {
  const value = policy.retentionHours;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 24;
}

/**
 * D9: the effective clear threshold for the disk hysteresis close. The
 * policy's `clearFreePercent` when finite and ordered above the effective
 * min; otherwise the fallback (20 when above the min, else the min) — and the
 * unknown `disk-thresholds-unordered` says so. KWp owns the parse error; the
 * lane only degrades safely.
 */
function effectiveClearPercent(policy: ReaperPolicy, unknown: ReaperUnknownView[]): number {
  const minRaw = policy.minFreePercent;
  const min = typeof minRaw === 'number' && Number.isFinite(minRaw) && minRaw >= 0 ? minRaw : 15;
  const clearRaw = policy.clearFreePercent;
  if (typeof clearRaw === 'number' && Number.isFinite(clearRaw) && clearRaw > min) {
    return clearRaw;
  }
  pushBounded(unknown, { subject: '', reason: 'disk-thresholds-unordered' });
  return 20 > min ? 20 : min;
}

/** `Date.parse` that never throws: an unparsable or absent time reads as null. */
function msOfSafe(iso: unknown): number | null {
  if (typeof iso !== 'string') {
    return null;
  }
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

/** The routing block for a registered clone's reads: it names the clone's host, never a local fallback. */
function cloneHostBlock(hostName: string): AttemptRunnerRecord {
  return { kind: 'opencode', remotePort: null, host: hostName, hostName, agent: null, model: null, variant: null };
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
  retentionHours: { kind: 'integer', optional: true },
  clearFreePercent: { kind: 'integer', optional: true },
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
  readonly staleAttentionBySubject: Map<string, StaleAttentionTarget>;
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
        worktrees: [],
        unknown: [...unknown, { subject: '', reason: 'findings-unreadable' }],
      };
    }

    // 3-4. Observe and classify. When the attempts read failed, no
    // observation is built at all: a reservation whose attempt could not be
    // read is not classified as `absent`.
    const built = this.newBuild(unknown);
    let findings: ReaperFinding[] = [];
    let gather: WorktreeBuild | null = null;
    if (facts.attempts !== null) {
      await this.buildObservations(built, facts, nowMs, graceMs);
      // KW4a: gather the registered clones' worktree and disk facts and merge
      // their observations before the classification, so the two-sightings
      // rule, the grace, the precedence and the store all apply unchanged.
      // Report only (D6): no worktree is removed, no branch is touched.
      gather = await this.gatherWorktreeAndDisk(built, facts, nowMs, graceMs, policy);
      findings = classifyZombies({ observations: built.observations, openFindings: openRecords.map((r) => r.finding) }, nowIso, policy).map(
        // The reaper never releases capacity: a leaked slot is report-only whatever the policy says.
        // The reaper never repairs a worktree (D6): a merged-worktree repair is report-only too.
        (finding) =>
          finding.kind === 'leaked-slot' || finding.kind === 'merged-worktree'
            ? (finding.action === 'repair' ? { ...finding, action: 'report' as const } : finding)
            : finding,
      );
    }
    const gatherReadsComplete = gather === null || gather.readsComplete;
    const readsComplete =
      facts.attempts !== null && facts.reservations !== null && facts.attentionItems !== null && gatherReadsComplete;

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
      policy,
      diskFreePercentByHost: gather === null ? new Map<string, number>() : gather.diskFreePercentByHost,
      inspectedWorktrees: gather === null ? new Map<string, InspectedWorktreeFacts>() : gather.inspectedWorktrees,
      busySubjects: gather === null ? new Set<string>() : gather.busySubjects,
    };

    // 6. Raise or refresh attention (skipped when the attention read failed).
    const attention = facts.attentionItems === null ? [] : await this.raiseAttention(findings, stored.storedIds, ctx);
    if (gather !== null && facts.attentionItems !== null) {
      await this.raiseWorktreeBusyAttention(projectId, gather, attention, unknown);
    }

    // 7. Repair: record-only, keyed, per kind.
    const repairs = await this.runRepairs(findings, stored.storedIds, ctx);

    // 8. Close findings the pass no longer sees, only when every read
    // succeeded — including the worktree and disk reads (D7, D8).
    if (readsComplete) {
      await this.settleUnseenFindings(openRecords, findings, built.cappedKeys, ctx);
      if (gather !== null) {
        await this.clearWorktreeBusyItems(projectId, gather, ctx);
      }
    }

    return {
      outcome: 'completed',
      findings: stored.views,
      attention,
      repairs,
      worktrees: gather === null ? [] : this.worktreeViews(gather, findings),
      unknown,
    };
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
      staleAttentionBySubject: new Map<string, StaleAttentionTarget>(),
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
    if (!screenSubject(build, subj.ref)) {
      return;
    }
    const itemKind = typeof raw.kind === 'string' ? raw.kind : STALE_ATTENTION_DEFAULT_KIND;
    const subject = staleAttentionSubject(subj.ref, itemKind);
    if (!ATTENTION_KIND_PATTERN.test(itemKind) || !REAPER_SUBJECT_ID_PATTERN.test(subject) || !isSafeSubject(subject)) {
      pushBounded(build.unknown, { subject: '', reason: 'subject-unsafe' });
      return;
    }
    if (build.staleAttentionBySubject.has(subject) || !claimSubjectSlot(build, 'stale-attention', subject)) {
      return;
    }
    build.observations.push({
      kind: 'stale-attention',
      subject,
      youngActivity: false,
      attentionOpen: true,
      questionUnanswered: false,
      runTerminal: true,
    });
    build.staleAttentionBySubject.set(subject, { ref: subj.ref, kind: itemKind, subjectKind: 'attempt' });
  }

  /**
   * KW4a: gather the registered clones' worktree and disk facts (D1–D8) and
   * merge the observations before classification. Report only: no worktree is
   * removed, no branch is touched, no session is aborted. Returns null when
   * the dependencies are absent: the gathering does not run and claims
   * nothing — no finding, no report, no unknown.
   */
  private async gatherWorktreeAndDisk(
    build: ObservationBuild,
    facts: PassFacts,
    nowMs: number,
    graceMs: number,
    policy: ReaperPolicy,
  ): Promise<WorktreeBuild | null> {
    const { workspace, profiles, forgeRead, computeDigest } = this.deps;
    if (workspace === undefined || profiles === undefined || computeDigest === undefined) {
      return null;
    }
    const wk: WorktreeBuild = {
      busySubjects: new Set<string>(),
      busyReports: new Map(),
      mergedEvidence: new Map(),
      sizeBySubject: new Map(),
      inspectedWorktrees: new Map(),
      diskFreePercentByHost: new Map(),
      digestByPath: new Map(),
      readsComplete: true,
    };
    const clones = await this.readActiveProfiles(build, wk, profiles);
    if (clones === null) {
      return wk;
    }
    const journalCache = new Map<string, readonly ActionJournalEntryRecord[] | null>();
    const hostsRead = new Set<string>();
    for (const clone of clones) {
      // D8: one disk read per clone, deduped per host digest.
      const hostDigest = this.hostDigestOf(clone.hostName, computeDigest, build.unknown);
      if (hostDigest !== null && !hostsRead.has(hostDigest)) {
        hostsRead.add(hostDigest);
        await this.buildDiskObservation(build, wk, clone, hostDigest, workspace);
      }
      const listed = await this.listCloneWorktrees(build, wk, clone, workspace);
      if (listed === null) {
        continue;
      }
      for (const worktreePath of listed) {
        const subject = this.subjectOf(clone, worktreePath, computeDigest);
        if (subject === null) {
          pushBounded(build.unknown, { subject: '', kind: 'merged-worktree', reason: 'digest-invalid' });
          continue;
        }
        if (wk.digestByPath.has(subject)) {
          continue; // the same subject listed twice: one inspection
        }
        if (!claimSubjectSlot(build, 'merged-worktree', subject)) {
          continue;
        }
        wk.digestByPath.set(subject, worktreePath);
        await this.buildWorktreeObservation(
          build, wk, clone, worktreePath, subject, facts, nowMs, graceMs, policy, journalCache, forgeRead, workspace,
        );
      }
    }
    return wk;
  }

  /**
   * D3: the clones of the active project profiles, through the coordination
   * context's existing `listProjectProfiles` read bound locally. A rejected
   * read or a throw is the unknown `profiles-unreadable` and no clones; a
   * profile that is not active is skipped; a clone whose path or worktree
   * root is not a non-empty string is skipped. The clones are capped at
   * MAX_CLONES_PER_PASS with one `pass-cap` unknown.
   */
  private async readActiveProfiles(
    build: ObservationBuild,
    wk: WorktreeBuild,
    profiles: ReaperProjectProfilesPort,
  ): Promise<readonly CloneRef[] | null> {
    let answer: Awaited<ReturnType<ReaperProjectProfilesPort['listProjectProfiles']>>;
    try {
      answer = await profiles.listProjectProfiles({ status: 'active' });
    } catch {
      wk.readsComplete = false;
      pushBounded(build.unknown, { subject: '', reason: 'profiles-unreadable' });
      return null;
    }
    if (answer.outcome !== 'listed') {
      wk.readsComplete = false;
      pushBounded(build.unknown, { subject: '', reason: 'profiles-unreadable' });
      return null;
    }
    const clones: CloneRef[] = [];
    for (const profile of answer.profiles) {
      if (!isPlainObject(profile)) {
        continue;
      }
      const projectId = readField(profile, 'projectId');
      const cloneRecord = readField(profile, 'clones');
      if (typeof projectId !== 'string' || projectId === '' || !isPlainObject(cloneRecord)) {
        continue;
      }
      const defaultBranchValue = readField(profile, 'defaultBranch');
      const defaultBranch = typeof defaultBranchValue === 'string' && defaultBranchValue !== ''
        ? defaultBranchValue
        : 'main';
      const defaultRef = 'origin/' + defaultBranch;
      for (const hostName of Object.keys(cloneRecord)) {
        if (clones.length >= MAX_CLONES_PER_PASS) {
          pushBounded(build.unknown, { subject: '', reason: 'pass-cap' });
          return clones;
        }
        const clone = readField(cloneRecord, hostName);
        if (!isPlainObject(clone)) {
          continue;
        }
        // A throwing getter on a clone field is a malformed record: skipped, never thrown on.
        const clonePath = readField(clone, 'path');
        const worktreeRoot = readField(clone, 'worktreeRoot');
        if (typeof clonePath !== 'string' || clonePath === '' || typeof worktreeRoot !== 'string' || worktreeRoot === '') {
          continue;
        }
        clones.push({
          projectId,
          hostName,
          clonePath,
          worktreeRoot,
          defaultRef,
          recordedHost: cloneHostBlock(hostName),
        });
      }
    }
    return clones;
  }

  /** D2: one clone's listed worktrees under its worktree root, never the clone's own main checkout. */
  private async listCloneWorktrees(
    build: ObservationBuild,
    wk: WorktreeBuild,
    clone: CloneRef,
    workspace: NonNullable<ReapZombiesDependencies['workspace']>,
  ): Promise<readonly string[] | null> {
    if (workspace.listWorktrees === undefined) {
      wk.readsComplete = false;
      pushBounded(build.unknown, { subject: '', reason: 'worktree-read-unconfigured' });
      return null;
    }
    let listed: ListWorktreesResult;
    try {
      listed = await workspace.listWorktrees({ repositoryRoot: clone.clonePath, recordedHost: clone.recordedHost });
    } catch {
      wk.readsComplete = false;
      pushBounded(build.unknown, { subject: '', reason: 'worktree-list-unreadable' });
      return null;
    }
    if (listed === null || listed.outcome !== 'listed' || !Array.isArray(listed.worktrees)) {
      wk.readsComplete = false;
      pushBounded(build.unknown, { subject: '', reason: 'worktree-list-unreadable' });
      return null;
    }
    const paths: string[] = [];
    for (const entry of listed.worktrees) {
      if (!isPlainObject(entry)) {
        continue;
      }
      // A throwing getter on an entry field is a malformed record: skipped, never thrown on.
      const path = readField(entry, 'path');
      if (typeof path !== 'string' || path === '') {
        continue; // a malformed entry is skipped, never thrown on
      }
      if (path === clone.clonePath || !pathUnderPrefix(path, clone.worktreeRoot)) {
        continue; // the main checkout, or a worktree of another root: not this clone's
      }
      paths.push(path);
    }
    return paths;
  }

  /** D1: the subject is a 12-hex digest of the clone and the worktree; null when the digest is unusable. */
  private subjectOf(clone: CloneRef, worktreePath: string, computeDigest: (text: string) => string): string | null {
    let digest: string;
    try {
      digest = computeDigest(`${clone.hostName}\u0000${clone.projectId}\u0000${clone.clonePath}\u0000${worktreePath}`);
    } catch {
      return null;
    }
    return /^[0-9a-f]{12}$/.test(digest) ? digest : null;
  }

  /** D1: the disk-pressure subject is the host digest; null when the digest is unusable. */
  private hostDigestOf(hostName: string, computeDigest: (text: string) => string, unknown: ReaperUnknownView[]): string | null {
    let digest: string;
    try {
      digest = computeDigest(`host\u0000${hostName}`);
    } catch {
      return null;
    }
    if (!/^[0-9a-f]{12}$/.test(digest)) {
      pushBounded(unknown, { subject: '', kind: 'disk-pressure', reason: 'digest-invalid' });
      return null;
    }
    return digest;
  }

  /** D8: one disk reading per clone, as a `disk-pressure` observation on the host digest. */
  private async buildDiskObservation(
    build: ObservationBuild,
    wk: WorktreeBuild,
    clone: CloneRef,
    hostDigest: string,
    workspace: NonNullable<ReapZombiesDependencies['workspace']>,
  ): Promise<void> {
    if (workspace.readFilesystemSpace === undefined) {
      wk.readsComplete = false;
      pushBounded(build.unknown, { subject: hostDigest, kind: 'disk-pressure', reason: 'disk-unreadable' });
      return;
    }
    let read: ReadFilesystemSpaceResult;
    try {
      read = await workspace.readFilesystemSpace({ path: clone.worktreeRoot, recordedHost: clone.recordedHost });
    } catch {
      wk.readsComplete = false;
      pushBounded(build.unknown, { subject: hostDigest, kind: 'disk-pressure', reason: 'disk-unreadable' });
      return;
    }
    if (read === null || read.outcome !== 'read') {
      wk.readsComplete = false;
      pushBounded(build.unknown, { subject: hostDigest, kind: 'disk-pressure', reason: 'disk-unreadable' });
      return;
    }
    const freePercent = (read.freeBytes / read.totalBytes) * 100;
    if (!Number.isFinite(freePercent)) {
      wk.readsComplete = false;
      pushBounded(build.unknown, { subject: hostDigest, kind: 'disk-pressure', reason: 'disk-unreadable' });
      return;
    }
    wk.diskFreePercentByHost.set(hostDigest, freePercent);
    build.observations.push({ kind: 'disk-pressure', subject: hostDigest, youngActivity: false, freePercent });
  }

  /**
   * D2/D4: one worktree's eleven facts. A refused inspection is not a linked
   * worktree: skipped with no unknown. An unknown or thrown inspection is the
   * unknown `worktree-unreadable`. A busy worktree is reported (D7) and gets
   * no merged-worktree observation.
   */
  private async buildWorktreeObservation(
    build: ObservationBuild,
    wk: WorktreeBuild,
    clone: CloneRef,
    worktreePath: string,
    subject: string,
    facts: PassFacts,
    nowMs: number,
    graceMs: number,
    policy: ReaperPolicy,
    journalCache: Map<string, readonly ActionJournalEntryRecord[] | null>,
    forgeRead: ReaperForgeReadPort | undefined,
    workspace: NonNullable<ReapZombiesDependencies['workspace']>,
  ): Promise<void> {
    const fail = (reason: string): void => {
      wk.readsComplete = false;
      pushBounded(build.unknown, { subject, kind: 'merged-worktree', reason });
    };
    if (workspace.inspectWorktreeForRemoval === undefined) {
      fail('worktree-read-unconfigured');
      return;
    }
    let inspected: InspectWorktreeForRemovalResult;
    try {
      inspected = await workspace.inspectWorktreeForRemoval({
        repositoryRoot: clone.clonePath,
        worktreePath,
        defaultRef: clone.defaultRef,
        recordedHost: clone.recordedHost,
      });
    } catch {
      fail('worktree-unreadable');
      return;
    }
    if (inspected === null) {
      fail('worktree-unreadable');
      return;
    }
    if (inspected.outcome === 'unknown') {
      fail('worktree-unreadable');
      return;
    }
    if (inspected.outcome !== 'inspected') {
      return; // refused: not a linked worktree, no unknown
    }
    const facts0 = inspected.facts;
    wk.sizeBySubject.set(subject, typeof facts0.sizeBytes === 'number' && Number.isFinite(facts0.sizeBytes) ? facts0.sizeBytes : null);

    const naming = this.attemptsNamingWorktree(facts, worktreePath);
    const held = this.heldReservationsNamingWorktree(facts, worktreePath, naming);
    const routing = this.worktreeRouting(clone, naming);
    const retentionMs = effectiveRetentionHours(policy) * 3_600_000;

    const headOnDefault: ReaperFact = facts0.headOnDefault === true ? 'yes' : facts0.headOnDefault === false ? 'no' : 'unknown';
    const clean: ReaperFact = facts0.status.tracked === 0 && facts0.status.untracked === 0 && facts0.status.unmerged === 0 ? 'yes' : 'no';
    const unlocked: ReaperFact = facts0.locked ? 'no' : 'yes';
    const onBranch: ReaperFact = facts0.detached || facts0.branch === null ? 'no' : 'yes';
    const notBusy: ReaperFact = facts0.inProgressOperations.length === 0 ? 'yes' : 'no';
    const notPrimary: ReaperFact = 'yes';
    const activityMs = msOfSafe(facts0.lastActivity.iso);
    const quiet: ReaperFact = facts0.lastActivity.unknown || activityMs === null
      ? 'unknown'
      : nowMs - activityMs >= retentionMs ? 'yes' : 'no';
    const journal = await this.worktreeJournalFacts(naming, journalCache, build.unknown, subject, nowMs, graceMs);
    const { noLiveRecord, noYoungIntent } = this.worktreeRecordFacts(naming, held, facts.reservations, nowMs, graceMs, journal.unreadable, journal.youngIntent);

    const runnerIdle = await this.worktreeRunnerIdle(naming, routing, worktreePath);

    // A busy worktree is reported, not classified (D7).
    if (notBusy === 'no') {
      wk.busySubjects.add(subject);
      wk.busyReports.set(subject, { evidence: 'unknown', sizeBytes: wk.sizeBySubject.get(subject) ?? null });
      return;
    }

    // D5: the evidence read only when the other ten facts are already yes.
    const tenFacts: readonly ReaperFact[] = [headOnDefault, clean, unlocked, onBranch, notBusy, notPrimary, quiet, noLiveRecord, runnerIdle, noYoungIntent];
    const evidence = tenFacts.every((fact) => fact === 'yes')
      ? await this.readMergeEvidence(build, wk, forgeRead, subject, facts0)
      : 'unknown';
    wk.mergedEvidence.set(subject, evidence);
    wk.inspectedWorktrees.set(subject, { headOnDefault, branch: facts0.branch, evidence });

    build.observations.push({
      kind: 'merged-worktree',
      subject,
      youngActivity: false,
      facts: {
        headOnDefault, clean, unlocked, onBranch, notBusy, notPrimary, quiet, noLiveRecord, runnerIdle, noYoungIntent, evidence,
      },
    });
  }

  /** The attempts that name a worktree path, in record order. */
  private attemptsNamingWorktree(facts: PassFacts, worktreePath: string): readonly AttemptRecord[] {
    const naming: AttemptRecord[] = [];
    for (const attempt of facts.attempts ?? []) {
      if (isPlainObject(attempt) && (attempt as { worktreePath?: unknown }).worktreePath === worktreePath) {
        naming.push(attempt);
      }
    }
    return naming;
  }

  /** The held reservations naming the worktree directly or through a naming attempt. */
  private heldReservationsNamingWorktree(
    facts: PassFacts,
    worktreePath: string,
    naming: readonly AttemptRecord[],
  ): readonly CapacityReservationRecord[] {
    const held: CapacityReservationRecord[] = [];
    if (facts.reservations === null) {
      return held;
    }
    const namingIds = new Set(naming.map((attempt) => attempt.id));
    for (const reservation of facts.reservations) {
      if (!isPlainObject(reservation) || (reservation as { held?: unknown }).held !== true) {
        continue;
      }
      const record = reservation as CapacityReservationRecord;
      const namesDirectly = (record as { worktreePath?: unknown }).worktreePath === worktreePath;
      if (namesDirectly || namingIds.has(record.attemptId)) {
        held.push(record);
      }
    }
    return held;
  }

  /** The routing block for one worktree's reads: the naming attempt's own block when it names the clone's host, else the clone's. */
  private worktreeRouting(clone: CloneRef, naming: readonly AttemptRecord[]): AttemptRunnerRecord {
    for (const attempt of naming) {
      if (runnerHasHostName(attempt.runner) && attempt.runner?.hostName === clone.hostName) {
        return attempt.runner;
      }
    }
    return clone.recordedHost;
  }

  /**
   * The action journal of each naming attempt, read once and cached. The
   * journal facts: whether an attempt carries a young intent. A failed read
   * leaves the fact unknown and is the unknown `journal-unreadable`.
   */
  private async worktreeJournalFacts(
    naming: readonly AttemptRecord[],
    journalCache: Map<string, readonly ActionJournalEntryRecord[] | null>,
    unknown: ReaperUnknownView[],
    subject: string,
    nowMs: number,
    graceMs: number,
  ): Promise<{ unreadable: boolean; youngIntent: boolean }> {
    let youngIntent = false;
    let unreadable = false;
    for (const attempt of naming) {
      let entries = journalCache.get(attempt.id);
      if (entries === undefined) {
        try {
          entries = await this.deps.executionJournal.listJournalEntriesForAttempt(attempt.id);
        } catch {
          entries = null;
        }
        journalCache.set(attempt.id, entries);
      }
      if (entries === null) {
        unreadable = true;
        continue;
      }
      if (actionJournalHasYoungIntent(entries, nowMs, graceMs)) {
        youngIntent = true;
      }
    }
    if (unreadable) {
      pushBounded(unknown, { subject, kind: 'merged-worktree', reason: 'journal-unreadable' });
    }
    return { unreadable, youngIntent };
  }

  /** The `noLiveRecord` and `noYoungIntent` facts of D4 from the naming attempts and the held reservations. */
  private worktreeRecordFacts(
    naming: readonly AttemptRecord[],
    held: readonly CapacityReservationRecord[],
    reservations: PassFacts['reservations'],
    nowMs: number,
    graceMs: number,
    journalUnknown: boolean,
    journalYoungIntent: boolean,
  ): { noLiveRecord: ReaperFact; noYoungIntent: ReaperFact } {
    if (reservations === null) {
      // The reservation read failed: unknown stays unknown, nothing is fabricated.
      return { noLiveRecord: 'unknown', noYoungIntent: 'unknown' };
    }
    let noLiveRecord: ReaperFact = 'yes';
    for (const attempt of naming) {
      const settled = (attempt.state === 'collected' && attempt.artifacts !== null) || attempt.state === 'cancelled';
      if (!settled) {
        noLiveRecord = 'no';
        break;
      }
    }
    for (const reservation of held) {
      noLiveRecord = 'no';
      if (reservationsYoungActivity(reservation.reservedAtIso, nowMs, graceMs)) {
        break;
      }
    }
    let noYoungIntent: ReaperFact = journalUnknown ? 'unknown' : journalYoungIntent ? 'no' : 'yes';
    if (noYoungIntent === 'yes') {
      for (const attempt of naming) {
        if (attemptYoungActivity(attempt, nowMs, graceMs)) {
          noYoungIntent = 'no';
          break;
        }
      }
    }
    if (noYoungIntent === 'yes') {
      for (const reservation of held) {
        if (reservationsYoungActivity(reservation.reservedAtIso, nowMs, graceMs)) {
          noYoungIntent = 'no';
          break;
        }
      }
    }
    return { noLiveRecord, noYoungIntent };
  }

  /** The `runnerIdle` fact of D4: idle yes, running no, anything else unknown. */
  private async worktreeRunnerIdle(
    naming: readonly AttemptRecord[],
    routing: AttemptRunnerRecord,
    worktreePath: string,
  ): Promise<ReaperFact> {
    const attemptId = naming.length > 0 ? naming[0].id : '';
    let answer: { readonly state: string };
    try {
      const resolved = this.deps.runnerForAttempt.runnerForAttempt({ runner: routing });
      if (!resolved.ok || resolved.runner.inspectWorktreeRun === undefined) {
        return 'unknown';
      }
      answer = await resolved.runner.inspectWorktreeRun({ attemptId, worktreePath, runner: routing });
    } catch {
      return 'unknown';
    }
    if (answer === null || answer.state === undefined) {
      return 'unknown';
    }
    return answer.state === 'idle' ? 'yes' : answer.state === 'running' ? 'no' : 'unknown';
  }

  /** D5: the merge evidence of one worktree, read only when the other ten facts are yes. */
  private async readMergeEvidence(
    build: ObservationBuild,
    wk: WorktreeBuild,
    forgeRead: ReaperForgeReadPort | undefined,
    subject: string,
    inspected: { readonly head: string | null; readonly branch: string | null },
  ): Promise<'merged-pr' | 'ancestor-only' | 'unknown'> {
    const unreadable = (): 'unknown' => {
      wk.readsComplete = false;
      pushBounded(build.unknown, { subject, kind: 'merged-worktree', reason: 'forge-unreadable' });
      return 'unknown';
    };
    if (forgeRead === undefined || forgeRead.isConfigured === undefined || !forgeRead.isConfigured()) {
      return unreadable();
    }
    if (inspected.branch === null) {
      return unreadable();
    }
    let answer: Awaited<ReturnType<ReaperForgeReadPort['readPullRequest']>>;
    try {
      answer = await forgeRead.readPullRequest({
        ref: { kind: 'branch', branchName: inspected.branch },
        timeoutMs: 5000,
      });
    } catch {
      return unreadable();
    }
    if (answer === null || answer.outcome === 'unavailable') {
      return unreadable();
    }
    if (answer.outcome === 'not-found') {
      return 'ancestor-only';
    }
    const pr = answer.pullRequest;
    const merged = isPlainObject(pr) && (pr as { state?: unknown }).state === 'merged';
    const headSha = isPlainObject(pr) ? (pr as { headSha?: unknown }).headSha : undefined;
    return merged && headSha === inspected.head ? 'merged-pr' : 'ancestor-only';
  }

  /** D7: one worktree-busy attention item per busy subject, raised or refreshed. */
  private async raiseWorktreeBusyAttention(
    projectId: string,
    gather: WorktreeBuild,
    attention: ReaperAttentionView[],
    unknown: ReaperUnknownView[],
  ): Promise<void> {
    for (const subject of gather.busySubjects) {
      if (attention.length >= MAX_ATTENTION_PER_PASS) {
        pushBounded(unknown, { subject, kind: 'worktree-busy', reason: 'pass-cap' });
        continue;
      }
      const outcome = await this.deps.attention.recordAttentionItem(
        {
          projectId,
          kind: 'worktree-busy',
          subject: { kind: 'worktree', ref: subject },
          workOrderId: null,
          summary: truncate(`Reaper report worktree-busy for worktree ${subject}`),
        },
        'reaper',
      );
      attention.push({
        kind: 'worktree-busy',
        subject,
        outcome: isReaperAttentionOutcome(outcome.outcome) ? outcome.outcome : 'refused',
      });
    }
  }

  /** D7: clear a worktree-busy item whose subject is not busy this pass, only when every worktree read succeeded. */
  private async clearWorktreeBusyItems(projectId: string, gather: WorktreeBuild, ctx: SettleContext): Promise<void> {
    if (!gather.readsComplete) {
      return; // a failed read never clears anything
    }
    for (const [subject] of gather.inspectedWorktrees) {
      if (gather.busySubjects.has(subject)) {
        continue;
      }
      if (!this.isAttentionItemOpen(subject, 'worktree-busy', ctx.attentionItems)) {
        continue;
      }
      try {
        await this.deps.attention.clearAttentionItem(
          { action: 'resolve', projectId, kind: 'worktree-busy', subject: { kind: 'worktree', ref: subject }, reason: 'stale' },
          'machine',
          'reaper',
        );
      } catch {
        pushBounded(ctx.unknown, { subject, kind: 'worktree-busy', reason: 'attention-unclearable' });
      }
    }
  }

  /** D11: the worktrees result view — one entry per merged-worktree finding and one per busy subject. */
  private worktreeViews(gather: WorktreeBuild, findings: readonly ReaperFinding[]): ReaperWorktreeView[] {
    const views: ReaperWorktreeView[] = [];
    for (const finding of findings) {
      if (finding.kind !== 'merged-worktree') {
        continue;
      }
      const sizeBytes = gather.sizeBySubject.get(finding.subject);
      views.push({
        subject: finding.subject,
        report: 'merged-worktree',
        evidence: gather.mergedEvidence.get(finding.subject) ?? 'unknown',
        sizeBytes: sizeBytes === undefined ? null : sizeBytes,
      });
    }
    for (const [subject, busy] of gather.busyReports) {
      views.push({ subject, report: 'worktree-busy', evidence: busy.evidence, sizeBytes: busy.sizeBytes });
    }
    return views;
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
      // The subject kind comes from the finding kind, never guessed (D7/D8):
      // a worktree subject is `worktree`, a disk-pressure subject is `host`.
      const subjectKind =
        finding.kind === 'merged-worktree' ? 'worktree' : finding.kind === 'disk-pressure' ? 'host' : undefined;
      const outcome = await this.recordAttention(ctx.projectId, finding, ctx.attemptsById, subjectKind);
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
    subjectKindOverride?: string,
  ): Promise<ReaperAttentionOutcome> {
    const attempt = subjectKindOverride === undefined ? attemptsById.get(finding.subject) : undefined;
    const subjectKind = subjectKindOverride ?? (attempt !== undefined ? 'attempt' : 'reservation');
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
   * underlying open attention item. The finding's subject names the item's
   * attempt ref and kind, so the clear targets exactly that item and the
   * journal key is its own.
   */
  private async repairStaleAttention(
    nowIso: string,
    projectId: string,
    finding: ReaperFinding,
    findingId: string,
    unknown: ReaperUnknownView[],
    attentionItems: readonly unknown[],
    staleAttentionBySubject: ReadonlyMap<string, StaleAttentionTarget>,
  ): Promise<ReaperRepairView> {
    const keyResult = reaperRepairKey(finding.subject, finding.kind, findingId);
    if (!keyResult.ok) {
      return repairView('', finding, 'skipped', 'key-refused');
    }
    const key = keyResult.key;
    const target = staleAttentionTarget(finding.subject, staleAttentionBySubject);

    const entries = await this.safeListForKey(key, unknown, finding.subject, finding.kind);
    if (entries === null) {
      return repairView(key, finding, 'skipped', 'journal-unreadable');
    }
    if (entries.some((entry) => entry.kind === 'result' && entry.outcome !== 'ambiguous')) {
      return repairView(key, finding, 'skipped', 'already-repaired');
    }
    if (entries.some((entry) => entry.kind === 'intent')) {
      if (this.isAttentionItemOpen(target.ref, target.kind, attentionItems)) {
        return repairView(key, finding, 'skipped', 'intent-without-result');
      }
      return await this.journalStaleAttention(key, nowIso, finding, 'reconciled', unknown);
    }

    const appended = await this.appendIntent(key, nowIso, findingId, unknown, finding.subject, finding.kind);
    if (appended === 'duplicate-key') {
      return repairView(key, finding, 'skipped', 'already-intended');
    }
    if (appended !== 'appended') {
      return repairView(key, finding, 'skipped', appended === 'refused' ? 'journal-refused' : 'journal-unwritable');
    }

    const outcome = await this.clearStaleAttentionItem(projectId, finding, target, unknown);
    if (outcome === null) {
      return repairView(key, finding, 'skipped', 'attention-unclearable');
    }
    return await this.journalStaleAttention(key, nowIso, finding, outcome, unknown);
  }

  /** Clear the one open item; its outcome as a journal outcome, or null when the clear threw. */
  private async clearStaleAttentionItem(
    projectId: string,
    finding: ReaperFinding,
    target: StaleAttentionTarget,
    unknown: ReaperUnknownView[],
  ): Promise<'completed' | 'reconciled' | 'refused' | null> {
    let clear: ClearAttentionShapeResult;
    try {
      clear = (await this.deps.attention.clearAttentionItem(
        {
          action: 'resolve',
          projectId,
          kind: target.kind,
          subject: { kind: 'attempt', ref: target.ref },
          reason: 'stale',
        },
        'machine',
        'reaper',
      )) as ClearAttentionShapeResult;
    } catch {
      unknown.push({ subject: finding.subject, kind: finding.kind, reason: 'attention-unclearable' });
      return null;
    }
    const outcome = clear?.outcome;
    if (outcome === 'cleared') {
      return 'completed';
    }
    return outcome === 'unchanged' || outcome === 'not-found' ? 'reconciled' : 'refused';
  }

  /** Journal the final result of one stale-attention repair and answer its view. */
  private async journalStaleAttention(
    key: string,
    nowIso: string,
    finding: ReaperFinding,
    outcome: 'completed' | 'reconciled' | 'refused',
    unknown: ReaperUnknownView[],
  ): Promise<ReaperRepairView> {
    const journaled = await this.journalResult(key, nowIso, outcome, null, unknown, finding.subject, finding.kind);
    if (!journaled) {
      return repairView(key, finding, 'skipped', 'result-unwritten');
    }
    return repairView(key, finding, outcome);
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
        const target = staleAttentionTarget(subject, ctx.staleAttentionBySubject);
        if (!this.isAttentionItemOpen(target.ref, target.kind, ctx.attentionItems)) {
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
      const target = staleAttentionTarget(subject, ctx.staleAttentionBySubject);
      return !this.isAttentionItemOpen(target.ref, target.kind, ctx.attentionItems);
    }
    if (kind === 'merged-worktree') {
      // The branch facts of this pass's inspection decide: the merge condition
      // ended when the branch is gone (detached or null) or the forge read a
      // definite negative. A busy or dirty worktree keeps the finding open.
      const inspected = ctx.inspectedWorktrees.get(subject);
      if (inspected === undefined) {
        return false;
      }
      return inspected.headOnDefault === 'no' || inspected.branch === null || inspected.evidence === 'ancestor-only';
    }
    if (kind === 'disk-pressure') {
      // Hysteresis (D8/D9): the finding closes only when this pass read the
      // host above the clear threshold; a failed disk read leaves it open.
      const freePercent = ctx.diskFreePercentByHost.get(subject);
      if (freePercent === undefined) {
        return false;
      }
      return freePercent > effectiveClearPercent(ctx.policy, ctx.unknown);
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
    const stale = record.finding.kind === 'stale-attention';
    const target = stale ? staleAttentionTarget(record.finding.subject, ctx.staleAttentionBySubject) : null;
    const subjectKind =
      record.finding.kind === 'disk-pressure' ? 'host'
      : record.finding.kind === 'merged-worktree' ? 'worktree'
      : record.finding.kind === 'leaked-slot' ? 'reservation'
      : 'attempt';
    const attentionKind = target?.kind ?? record.finding.kind;
    const attentionRef = target?.ref ?? record.finding.subject;
    try {
      await this.deps.attention.clearAttentionItem(
        {
          action: 'resolve',
          projectId: ctx.projectId,
          kind: attentionKind,
          subject: { kind: subjectKind, ref: attentionRef },
          reason: 'stale',
        },
        'machine',
        'reaper',
      );
    } catch {
      ctx.unknown.push({ subject: record.finding.subject, kind: record.finding.kind, reason: 'attention-unclearable' });
    }
  }

  /** Whether an open attention item of `kind` references `ref`. */
  private isAttentionItemOpen(ref: string, kind: string, attentionItems: readonly unknown[]): boolean {
    for (const raw of attentionItems) {
      if (!isPlainObject(raw)) {
        continue;
      }
      const item = raw as { state?: unknown; subject?: unknown; kind?: unknown };
      if (item.state !== 'open' || (typeof item.kind === 'string' ? item.kind : STALE_ATTENTION_DEFAULT_KIND) !== kind) {
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

function repairView(key: string, finding: ReaperFinding, outcome: ReaperRepairView['outcome'], reasonCode?: string): ReaperRepairView {
  return reasonCode === undefined
    ? { key, kind: finding.kind, subject: finding.subject, outcome }
    : { key, kind: finding.kind, subject: finding.subject, outcome, reasonCode };
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
    worktrees: [],
    unknown: [],
  };
}
