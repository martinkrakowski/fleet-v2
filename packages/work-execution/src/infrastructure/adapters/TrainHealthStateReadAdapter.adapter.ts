/**
 * TrainHealthStateReadAdapter implements TrainHealthStateReadPort by composing
 * the daemon status read, the merge-queue list and the forge merge read into
 * one TrainHealthSnapshot. It never throws, never writes and never refuses
 * only because the live queue is longer than 500: the use case keeps the
 * oldest 500 itself.
 */

import type { DaemonStatusPort } from '../../application/ports/out/DaemonStatusPort.out-port.js';
import type { ForgeMergeReadPort } from '../../application/ports/out/ForgeMergeReadPort.out-port.js';
import type { MergeQueueRepositoryPort } from '../../application/ports/out/MergeQueueRepositoryPort.out-port.js';
import type {
  TrainHealthStateReadPort,
  TrainHealthStateReadRequest,
  TrainHealthStateReadResult,
} from '../../application/ports/out/TrainHealthStateReadPort.out-port.js';
import { isZonedIsoDateTime } from '../../domain/conductor-halt.js';
import {
  DAEMON_REPO_DIGEST_PATTERN,
  computeCallBudget,
  readDaemonStatusRecord,
} from '../../domain/daemon-tick.js';
import {
  MERGE_QUEUE_ENTRY_STATES,
  MERGE_QUEUE_ORDER_CAP,
  isMergeHex40,
  isMergeQueueEntryLive,
  type MergeQueueEntryState,
} from '../../domain/merge-queue-records.js';
import type {
  TrainHealthForgeState,
  TrainHealthQueueEntry,
} from '../../domain/train-health-rules.js';

/** Supplier ports and the adapter clock. The composition root binds them. */
export interface TrainHealthStateReadAdapterOptions {
  readonly status: Pick<DaemonStatusPort, 'read'>;
  readonly queue: Pick<MergeQueueRepositoryPort, 'listMergeEntries'>;
  readonly forge: Pick<ForgeMergeReadPort, 'readForgeMerge'>;
  readonly now: () => string;
  /**
   * How many live entries receive a forge read. Anything that is not a safe
   * integer in 0..50 reads as 10.
   */
  readonly maxForgeReads?: number;
}

const REPOSITORY_SEGMENT_PATTERN = /^[A-Za-z0-9_.-]{1,100}$/;
const DEFAULT_MAX_FORGE_READS = 10;
const MAX_FORGE_READS_LIMIT = 50;
/** The use case races the whole read against at most this long. */
const NORMAL_TIMEOUT_MS = 30_000;
const KNOWN_FORGE_STATES: readonly TrainHealthForgeState[] = ['open', 'closed', 'merged'];

interface RepositoryRef {
  readonly owner: string;
  readonly repo: string;
}

type Unavailable = { readonly outcome: 'unavailable'; readonly reasonCode: string };
type BudgetExhausted = { readonly outcome: 'budget-exhausted' };
type Stop = Unavailable | BudgetExhausted;

interface ParsedRequest {
  readonly outcome: 'ok';
  readonly repository: RepositoryRef;
  readonly repoDigest: string;
  readonly deadlineIso: string;
}

type RequestAnswer = ParsedRequest | Unavailable;

interface ClockOk {
  readonly outcome: 'ok';
  readonly nowIso: string;
}

type BudgetAnswer = ClockOk | Stop;

interface TickOk {
  readonly outcome: 'ok';
  readonly lastTickFinishedAtIso?: string;
}

type TickAnswer = TickOk | Stop;

interface QueueRow {
  readonly pullRequest: number;
  readonly state: MergeQueueEntryState;
  readonly enqueuedAtIso: string;
  readonly attempt: number;
  readonly headOid: string;
  readonly mergedAtIso: string | null;
}

interface LiveEntry {
  readonly pullRequest: number;
  readonly state: MergeQueueEntryState;
  readonly enqueuedAtIso: string;
  readonly attempt: number;
  readonly headOid: string;
}

interface QueueOk {
  readonly outcome: 'ok';
  readonly live: readonly LiveEntry[];
  readonly lastMergedAtIso?: string;
}

type QueueAnswer = QueueOk | Stop;

type QueueElement =
  | { readonly kind: 'skip' }
  | { readonly kind: 'bad' }
  | { readonly kind: 'row'; readonly row: QueueRow };

type ForgeStep =
  | { readonly stop: true }
  | { readonly stop: false; readonly forgeState: TrainHealthForgeState };

/** An own data property only: an accessor reads as undefined and never runs. */
function ownValue(source: unknown, key: string): unknown {
  if (typeof source !== 'object' || source === null) {
    return undefined;
  }
  const descriptor = Object.getOwnPropertyDescriptor(source, key);
  return descriptor === undefined ? undefined : descriptor.value;
}

function unavailable(reasonCode: string): Unavailable {
  return { outcome: 'unavailable', reasonCode };
}

function isNonNullObject(value: unknown): value is object {
  return typeof value === 'object' && value !== null;
}

function isSegment(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    REPOSITORY_SEGMENT_PATTERN.test(value) &&
    value !== '.' &&
    value !== '..'
  );
}

function isRepoDigest(value: unknown): value is string {
  return typeof value === 'string' && DAEMON_REPO_DIGEST_PATTERN.test(value);
}

function isSafeIntAtLeast(value: unknown, minimum: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum;
}

function isQueueState(value: unknown): value is MergeQueueEntryState {
  return typeof value === 'string' && (MERGE_QUEUE_ENTRY_STATES as readonly string[]).includes(value);
}

function resolveMaxForgeReads(value: number | undefined): number {
  if (isSafeIntAtLeast(value, 0) && value <= MAX_FORGE_READS_LIMIT) {
    return value;
  }
  return DEFAULT_MAX_FORGE_READS;
}

function readRepository(raw: unknown): RepositoryRef | null {
  const owner = ownValue(raw, 'owner');
  const repo = ownValue(raw, 'repo');
  if (!isSegment(owner) || !isSegment(repo)) {
    return null;
  }
  return { owner, repo };
}

function mergedAtOf(state: MergeQueueEntryState, value: unknown): string | null {
  if (state === 'merged' && isZonedIsoDateTime(value)) {
    return value;
  }
  return null;
}

function readMatchingRow(element: object): QueueRow | null {
  const state = ownValue(element, 'state');
  const pullRequest = ownValue(element, 'pullRequest');
  const attempt = ownValue(element, 'attempt');
  const enqueuedAtIso = ownValue(element, 'enqueuedAtIso');
  const headOid = ownValue(element, 'headOid');
  if (!isQueueState(state) || !isSafeIntAtLeast(pullRequest, 1) || !isSafeIntAtLeast(attempt, 0)) {
    return null;
  }
  if (!isZonedIsoDateTime(enqueuedAtIso) || !isMergeHex40(headOid)) {
    return null;
  }
  return {
    pullRequest,
    state,
    enqueuedAtIso,
    attempt,
    headOid,
    mergedAtIso: mergedAtOf(state, ownValue(element, 'mergedAtIso')),
  };
}

function readQueueElement(element: unknown, repoDigest: string): QueueElement {
  if (!isNonNullObject(element)) {
    return { kind: 'bad' };
  }
  const digest = ownValue(element, 'repoDigest');
  if (typeof digest !== 'string') {
    return { kind: 'bad' };
  }
  if (digest !== repoDigest) {
    return { kind: 'skip' };
  }
  const row = readMatchingRow(element);
  return row === null ? { kind: 'bad' } : { kind: 'row', row };
}

function toLiveEntry(row: QueueRow): LiveEntry {
  return {
    pullRequest: row.pullRequest,
    state: row.state,
    enqueuedAtIso: row.enqueuedAtIso,
    attempt: row.attempt,
    headOid: row.headOid,
  };
}

function byEnqueueThenPullRequest(left: LiveEntry, right: LiveEntry): number {
  const byTime = Date.parse(left.enqueuedAtIso) - Date.parse(right.enqueuedAtIso);
  if (byTime !== 0) {
    return byTime;
  }
  return left.pullRequest - right.pullRequest;
}

function latestMergedAt(rows: readonly QueueRow[]): string | undefined {
  let latest: string | undefined;
  for (const row of rows) {
    if (row.mergedAtIso === null) {
      continue;
    }
    if (latest === undefined || Date.parse(row.mergedAtIso) > Date.parse(latest)) {
      latest = row.mergedAtIso;
    }
  }
  return latest;
}

/**
 * Live entries are returned in full. The 500-entry bound belongs to
 * WatchTrainHealthUseCase, which keeps the oldest 500.
 */
function queueAnswer(rows: readonly QueueRow[]): QueueOk {
  const live = rows.filter((row) => isMergeQueueEntryLive(row)).map(toLiveEntry);
  live.sort(byEnqueueThenPullRequest);
  const lastMergedAtIso = latestMergedAt(rows);
  if (lastMergedAtIso === undefined) {
    return { outcome: 'ok', live };
  }
  return { outcome: 'ok', live, lastMergedAtIso };
}

function collectQueue(listed: readonly unknown[], repoDigest: string): QueueAnswer {
  const rows: QueueRow[] = [];
  for (const element of listed) {
    const read = readQueueElement(element, repoDigest);
    if (read.kind === 'bad') {
      return unavailable('queue-unreadable');
    }
    if (read.kind === 'row') {
      rows.push(read.row);
    }
  }
  return queueAnswer(rows);
}

function tickFromStatus(read: unknown): TickAnswer {
  const status = ownValue(read, 'status');
  if (status === 'missing') {
    return { outcome: 'ok' };
  }
  if (status !== 'ok') {
    return unavailable('status-unreadable');
  }
  const parsed = readDaemonStatusRecord(ownValue(read, 'record'));
  if (!parsed.ok) {
    return unavailable('status-unreadable');
  }
  return { outcome: 'ok', lastTickFinishedAtIso: parsed.record.finishedAtIso };
}

function isKnownForgeState(value: unknown): value is TrainHealthForgeState {
  return (
    typeof value === 'string' &&
    (KNOWN_FORGE_STATES as readonly string[]).includes(value)
  );
}

/** The one forge-outcome mapping: ok plus a known prState, otherwise unknown. */
function mapForgeState(answer: unknown): TrainHealthForgeState {
  if (ownValue(answer, 'outcome') !== 'ok') {
    return 'unknown';
  }
  const prState = ownValue(answer, 'prState');
  if (isKnownForgeState(prState)) {
    return prState;
  }
  return 'unknown';
}

function toQueueEntry(
  entry: {
    readonly pullRequest: number;
    readonly state: MergeQueueEntryState;
    readonly enqueuedAtIso: string;
    readonly attempt: number;
  },
  forgeState: TrainHealthForgeState,
): TrainHealthQueueEntry {
  return {
    pullRequest: entry.pullRequest,
    state: entry.state,
    forgeState,
    enqueuedAtIso: entry.enqueuedAtIso,
    attempt: entry.attempt,
  };
}

function okSnapshot(
  queue: readonly TrainHealthQueueEntry[],
  lastTickFinishedAtIso: string | undefined,
  lastMergedAtIso: string | undefined,
): TrainHealthStateReadResult {
  const snapshot: {
    queue: TrainHealthQueueEntry[];
    lastTickFinishedAtIso?: string;
    lastMergedAtIso?: string;
  } = { queue: queue.map((entry) => toQueueEntry(entry, entry.forgeState)) };
  if (lastTickFinishedAtIso !== undefined) {
    snapshot.lastTickFinishedAtIso = lastTickFinishedAtIso;
  }
  if (lastMergedAtIso !== undefined) {
    snapshot.lastMergedAtIso = lastMergedAtIso;
  }
  return { outcome: 'ok', snapshot };
}

export class TrainHealthStateReadAdapter implements TrainHealthStateReadPort {
  private readonly maxForgeReads: number;

  constructor(private readonly options: TrainHealthStateReadAdapterOptions) {
    this.maxForgeReads = resolveMaxForgeReads(options.maxForgeReads);
  }

  async readTrainHealthState(request: TrainHealthStateReadRequest): Promise<TrainHealthStateReadResult> {
    try {
      return await this.read(request);
    } catch {
      return unavailable('read-failed');
    }
  }

  private async read(request: TrainHealthStateReadRequest): Promise<TrainHealthStateReadResult> {
    const parsed = this.request(request);
    if (parsed.outcome !== 'ok') {
      return parsed;
    }
    const tick = await this.readTick(parsed.deadlineIso);
    if (tick.outcome !== 'ok') {
      return tick;
    }
    const queue = await this.readQueue(parsed.repository, parsed.repoDigest, parsed.deadlineIso);
    if (queue.outcome !== 'ok') {
      return queue;
    }
    const entries = await this.readForgeStates(parsed.repository, queue.live, parsed.deadlineIso);
    return okSnapshot(entries, tick.lastTickFinishedAtIso, queue.lastMergedAtIso);
  }

  /**
   * nowIso is a required request field and is deliberately unread. The use
   * case's clock reading is its own budget; this adapter calls now() inside
   * budget() before every port call. A missing or malformed nowIso is not
   * invalid-request.
   */
  private request(raw: unknown): RequestAnswer {
    const repository = readRepository(ownValue(raw, 'repository'));
    const repoDigest = ownValue(raw, 'repoDigest');
    const deadlineIso = ownValue(raw, 'deadlineIso');
    if (repository === null || !isRepoDigest(repoDigest) || typeof deadlineIso !== 'string') {
      return unavailable('invalid-request');
    }
    return { outcome: 'ok', repository, repoDigest, deadlineIso };
  }

  private budget(deadlineIso: string): BudgetAnswer {
    const nowIso = this.readClock();
    if (nowIso === null) {
      return unavailable('invalid-clock');
    }
    const decision = computeCallBudget({ nowIso, deadlineIso, normalTimeoutMs: NORMAL_TIMEOUT_MS });
    if (decision.allowed) {
      return { outcome: 'ok', nowIso };
    }
    if (decision.reason === 'budget-exhausted') {
      return { outcome: 'budget-exhausted' };
    }
    return unavailable('invalid-clock');
  }

  private async readTick(deadlineIso: string): Promise<TickAnswer> {
    const allowance = this.budget(deadlineIso);
    if (allowance.outcome !== 'ok') {
      return allowance;
    }
    try {
      return tickFromStatus(await this.options.status.read());
    } catch {
      return unavailable('status-unreadable');
    }
  }

  private async readQueue(
    repository: RepositoryRef,
    repoDigest: string,
    deadlineIso: string,
  ): Promise<QueueAnswer> {
    const allowance = this.budget(deadlineIso);
    if (allowance.outcome !== 'ok') {
      return allowance;
    }
    const listed = await this.listQueue(repository, deadlineIso);
    if (!Array.isArray(listed) || listed.length > MERGE_QUEUE_ORDER_CAP) {
      return unavailable('queue-unreadable');
    }
    return collectQueue(listed, repoDigest);
  }

  /**
   * A budget or clock failure here does not fail the read. This entry and
   * every entry after it are forgeState unknown, and the snapshot is still ok.
   * Entries at index >= maxForgeReads are unknown with no forge call.
   */
  private async readForgeStates(
    repository: RepositoryRef,
    live: readonly LiveEntry[],
    deadlineIso: string,
  ): Promise<TrainHealthQueueEntry[]> {
    const entries: TrainHealthQueueEntry[] = [];
    let stopped = false;
    for (let index = 0; index < live.length; index += 1) {
      const next = await this.oneForgeEntry(
        repository,
        live[index],
        deadlineIso,
        stopped || index >= this.maxForgeReads,
      );
      entries.push(next.entry);
      stopped = stopped || next.stopped;
    }
    return entries;
  }

  private readClock(): string | null {
    try {
      const nowIso = this.options.now();
      return isZonedIsoDateTime(nowIso) ? nowIso : null;
    } catch {
      return null;
    }
  }

  private async listQueue(repository: RepositoryRef, deadlineIso: string): Promise<unknown> {
    try {
      return await this.options.queue.listMergeEntries({ repository, deadlineIso });
    } catch {
      return undefined;
    }
  }

  private async oneForgeEntry(
    repository: RepositoryRef,
    entry: LiveEntry,
    deadlineIso: string,
    skip: boolean,
  ): Promise<{ readonly entry: TrainHealthQueueEntry; readonly stopped: boolean }> {
    if (skip) {
      return { entry: toQueueEntry(entry, 'unknown'), stopped: false };
    }
    const step = await this.forgeStep(repository, entry, deadlineIso);
    if (step.stop) {
      return { entry: toQueueEntry(entry, 'unknown'), stopped: true };
    }
    return { entry: toQueueEntry(entry, step.forgeState), stopped: false };
  }

  private async forgeStep(
    repository: RepositoryRef,
    entry: LiveEntry,
    deadlineIso: string,
  ): Promise<ForgeStep> {
    const allowance = this.budget(deadlineIso);
    if (allowance.outcome !== 'ok') {
      return { stop: true };
    }
    const answer = await this.callForge(repository, entry, allowance.nowIso, deadlineIso);
    return { stop: false, forgeState: mapForgeState(answer) };
  }

  private async callForge(
    repository: RepositoryRef,
    entry: LiveEntry,
    nowIso: string,
    deadlineIso: string,
  ): Promise<unknown> {
    try {
      return await this.options.forge.readForgeMerge({
        repository,
        pullRequestNumber: entry.pullRequest,
        headSha: entry.headOid,
        requiredContexts: [],
        nowIso,
        deadlineIso,
      });
    } catch {
      return null;
    }
  }
}
