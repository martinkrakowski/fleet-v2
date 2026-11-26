// @generated use-case scaffold — refined for lane S1U1.

/**
 * DecideShadowMergeUseCase implements DecideShadowMergePort: for ONE
 * `(pullRequest, headOid)` pair it journals the shadow merge decision
 * `RunMergePassUseCase` would reach, by running the real pass over a
 * single-entry in-memory queue. The entry is a v2 record carrying the pair's
 * own base branch, and the real queue is peeked read-only first so an
 * unreadable queue or a pair that is not a queued entry refuses. Any queued entry is decided, head or not. No
 * queue writes, no CLI, no live action.
 */

import type {
  DecideShadowMergePort,
  DecideShadowMergeRequest,
  DecideShadowMergeResult,
} from '../ports/in/DecideShadowMergePort.in-port.js';
import type {
  ForgeMergeReadPort,
} from '../ports/out/ForgeMergeReadPort.out-port.js';
import type { MergeVerificationPort } from '../ports/out/MergeVerificationPort.out-port.js';
import type { LaneRunJournalPort } from '../ports/out/LaneRunJournalPort.out-port.js';
import type { ConductorHaltPort } from '../ports/out/ConductorHaltPort.out-port.js';
import type { MergeQueueRepositoryPort } from '../ports/out/MergeQueueRepositoryPort.out-port.js';
import { isSupersedablePredecessor } from '../../domain/merge-queue-operations.js';
import { computeCallBudget } from '../../domain/daemon-tick.js';
import { isZonedIsoDateTime } from '../../domain/conductor-halt.js';
import { parseBaseBranch } from '../../domain/base-branch.js';
import {
  MERGE_QUEUE_ENTRY_V2_VERSION,
  MERGE_QUEUE_ORDER_CAP,
  sameMergeQueueIdentity,
  type MergeQueueEntryRecord,
} from '../../domain/merge-queue-records.js';
import {
  LANE_RUN_JOURNAL_ENTRY_VERSION,
  type LaneRunJournalEntryRecord,
} from '../../domain/lane-run-journal.js';
import {
  buildMergeKey,
  head12Of,
} from '../../domain/lane-run-keys.js';
import { RunMergePassUseCase } from './RunMergePassUseCase.use-case.js';

const NORMAL_CALL_TIMEOUT_MS = 30_000;
/** The inner pass's deadline sits 3 s before the request's own budget. */
const INNER_PASS_HEADROOM_MS = 3_000;
const REPOSITORY_SEGMENT_PATTERN = /^[A-Za-z0-9_.-]{1,100}$/;
const REPO_DIGEST_PATTERN = /^[0-9a-f]{12}$/;
const HEAD_OID_PATTERN = /^[0-9a-f]{40}$/;
const MAX_PROJECT_ID_LENGTH = 256;

export interface DecideShadowMergeDependencies {
  readonly forgeRead: ForgeMergeReadPort;
  readonly verification: MergeVerificationPort;
  readonly journal: Pick<LaneRunJournalPort, 'append' | 'listForKey' | 'listForKeyPrefix'>;
  readonly halt: Pick<ConductorHaltPort, 'read'>;
  /** Read-only peek at the real merge queue, for the base partition's head. */
  readonly queue: Pick<MergeQueueRepositoryPort, 'listMergeEntries'>;
  readonly newUlid: () => string;
  readonly nowIso: () => string;
}

interface JournalRowView {
  readonly kind: string;
  readonly runId: string | null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isSafeIntGte(value: unknown, min: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min;
}

function isValidRequest(request: unknown): request is DecideShadowMergeRequest {
  if (!isPlainObject(request)) {
    return false;
  }
  const repository: unknown = request.repository;
  if (!isPlainObject(repository)) {
    return false;
  }
  const owner: unknown = repository.owner;
  const repo: unknown = repository.repo;
  if (typeof owner !== 'string' || !REPOSITORY_SEGMENT_PATTERN.test(owner)) {
    return false;
  }
  if (typeof repo !== 'string' || !REPOSITORY_SEGMENT_PATTERN.test(repo)) {
    return false;
  }
  if (typeof request.repoDigest !== 'string' || !REPO_DIGEST_PATTERN.test(request.repoDigest)) {
    return false;
  }
  if (
    typeof request.projectId !== 'string'
    || request.projectId.length === 0
    || request.projectId.length > MAX_PROJECT_ID_LENGTH
  ) {
    return false;
  }
  if (!isSafeIntGte(request.pullRequest, 1)) {
    return false;
  }
  if (typeof request.headOid !== 'string' || !HEAD_OID_PATTERN.test(request.headOid)) {
    return false;
  }
  if (typeof request.baseBranch !== 'string' || parseBaseBranch(request.baseBranch) === undefined) {
    return false;
  }
  if (typeof request.deadlineIso !== 'string' || !isZonedIsoDateTime(request.deadlineIso)) {
    return false;
  }
  if (!isPlainObject(request.policy)) {
    return false;
  }
  return true;
}

/** Plain-object record views of one journal key's rows, nothing more. */
function readJournalRows(value: unknown): JournalRowView[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const rows: JournalRowView[] = [];
  for (const row of value) {
    if (!isPlainObject(row)) {
      return null;
    }
    const kind: unknown = row.kind;
    if (typeof kind !== 'string') {
      return null;
    }
    const runId: unknown = row.runId;
    rows.push({
      kind,
      runId: typeof runId === 'string' ? runId : null,
    });
  }
  return rows;
}

export class DecideShadowMergeUseCase implements DecideShadowMergePort {
  constructor(private readonly deps: DecideShadowMergeDependencies) {}

  async decideShadowMerge(request: DecideShadowMergeRequest): Promise<DecideShadowMergeResult> {
    // The decider never throws on runtime input: any escape is a typed refusal.
    try {
      return await this.decide(request);
    } catch {
      return { outcome: 'refused', reasonCode: 'decide-failed', journalKey: null };
    }
  }

  private async decide(request: DecideShadowMergeRequest): Promise<DecideShadowMergeResult> {
    if (!isValidRequest(request)) {
      return { outcome: 'refused', reasonCode: 'invalid-request', journalKey: null };
    }
    if (request.policy.shadow !== true) {
      return { outcome: 'refused', reasonCode: 'policy-not-shadow', journalKey: null };
    }

    // D-DT9: the entry budget is checked before the first outbound call.
    const entryBudget = computeCallBudget({
      nowIso: this.deps.nowIso(),
      deadlineIso: request.deadlineIso,
      normalTimeoutMs: NORMAL_CALL_TIMEOUT_MS,
    });
    if (!entryBudget.allowed) {
      return { outcome: 'budget-exhausted', reasonCode: 'budget-exhausted', journalKey: null };
    }

    const head12 = head12Of(request.headOid) ?? '';
    const built = buildMergeKey({
      repoDigest: request.repoDigest,
      pullRequest: request.pullRequest,
      head12,
      action: 'merge-pr',
      attemptOrdinal: null,
      retry: null,
    });
    if (!built.ok) {
      return { outcome: 'refused', reasonCode: 'invalid-request', journalKey: null };
    }
    const expectedKey = built.key;

    // Owner decision 2026-11-26: the decision is journaled for any queued
    // entry, not only the queue head. The real queue is peeked: an unreadable
    // queue fails closed, and a pair with no `queued` entry for this exact
    // repository, pull request and head is refused (never a would-merge).
    const queueState = await this.queueEntryState(request);
    if (queueState === 'unreadable') {
      return { outcome: 'refused', reasonCode: 'decide-failed', journalKey: null };
    }
    if (queueState === 'not-queued') {
      return { outcome: 'refused', reasonCode: 'not-queued', journalKey: null };
    }

    const entry: MergeQueueEntryRecord = {
      version: MERGE_QUEUE_ENTRY_V2_VERSION,
      entryId: this.deps.newUlid(),
      repository: request.repository,
      repoDigest: request.repoDigest,
      pullRequest: request.pullRequest,
      headOid: request.headOid,
      state: 'queued',
      reason: null,
      attempt: 0,
      notBeforeIso: null,
      enqueuedAtIso: this.deps.nowIso(),
      enqueuedBy: 'cli',
      supersedes: null,
      runId: null,
      attemptId: null,
      workOrderId: null,
      tier: 0,
      verifiedHeadOid: null,
      verifiedBy: null,
      policyRevision: null,
      premergeReceiptHeadOid: null,
      veto: null,
      mergeCommitOid: null,
      mergedAtIso: null,
      revision: 1,
      // v2: the pair is judged against the base it was queued for, never
      // silently against main (a chain/foo PR is not a base-mismatch).
      baseBranch: request.baseBranch,
    };

    const innerDeadlineIso = new Date(Date.parse(request.deadlineIso) - INNER_PASS_HEADROOM_MS).toISOString();
    const pass = new RunMergePassUseCase({
      queue: {
        async listMergeEntries() {
          return [entry];
        },
      },
      forgeRead: this.deps.forgeRead,
      verification: this.deps.verification,
      journal: this.deps.journal,
      halt: this.deps.halt,
      newUlid: this.deps.newUlid,
      nowIso: this.deps.nowIso,
    });
    const passResult = await pass.runMergePass({
      repository: request.repository,
      repoDigest: request.repoDigest,
      projectId: request.projectId,
      policy: request.policy,
      deadlineIso: innerDeadlineIso,
      baseBranch: request.baseBranch,
    });

    // S9: the inner pass ran out of budget. Close an open intent on merge-pr
    // with the closing dry-run result, regardless of the deadline; a
    // duplicate-key refusal means the intent was closed already.
    if (passResult.outcome === 'budget-exhausted') {
      await this.closeOpenIntent(expectedKey);
      return { outcome: 'budget-exhausted', reasonCode: 'budget-exhausted', journalKey: null };
    }

    if (passResult.outcome === 'refused') {
      return { outcome: 'refused', reasonCode: 'decide-failed', journalKey: null };
    }
    const report = passResult.entries[0];
    if (report === undefined) {
      return { outcome: 'refused', reasonCode: 'decide-failed', journalKey: null };
    }
    if (
      report.reasonCode === 'entry-failed'
      || report.reasonCode === 'key-refused'
      || report.reasonCode === 'entry-refused'
    ) {
      return { outcome: 'refused', reasonCode: 'decide-failed', journalKey: null };
    }
    if (report.decision === 'journalled' && report.reasonCode === 'would-merge') {
      return { outcome: 'journalled', reasonCode: 'would-merge', journalKey: expectedKey };
    }

    // Post-pass idempotence check: only a result row under the expected key
    // makes the call already-journalled; other keys never imply it.
    let rows: unknown;
    try {
      rows = await this.deps.journal.listForKey(expectedKey);
    } catch {
      return { outcome: 'refused', reasonCode: 'decide-failed', journalKey: null };
    }
    const read = readJournalRows(rows);
    if (read === null) {
      return { outcome: 'refused', reasonCode: 'decide-failed', journalKey: null };
    }
    if (read.some((row) => row.kind === 'result')) {
      return { outcome: 'already-journalled', reasonCode: 'already-journalled', journalKey: expectedKey };
    }
    return {
      outcome: 'not-ready',
      reasonCode: report.reasonCode ?? 'not-ready',
      journalKey: null,
    };
  }

  /**
   * Read-only peek at the real merge queue: `queued` when a live entry exists
   * for this repository and pull request: `queued` or `ready` at the requested
   * head, or `queued`, `ready` or `parked` with reason `update-refused` at a
   * different head (superseded by the requested head, by the same predicate
   * `decideMergeEnqueue` uses). `not-queued` when none does (any other parked
   * reason, dropped, merged, superseded, unknown state, or absent),
   * `unreadable` when the peek fails or is malformed (fail closed).
   */
  private async queueEntryState(
    request: DecideShadowMergeRequest,
  ): Promise<'queued' | 'not-queued' | 'unreadable'> {
    let records: unknown;
    try {
      records = await this.deps.queue.listMergeEntries({
        repository: request.repository,
        deadlineIso: request.deadlineIso,
      });
    } catch {
      return 'unreadable';
    }
    if (!Array.isArray(records) || records.length > MERGE_QUEUE_ORDER_CAP) {
      return 'unreadable';
    }
    const target = {
      repository: request.repository,
      pullRequest: request.pullRequest,
      headOid: request.headOid,
    };
    const found = (records as readonly unknown[]).some((record) => {
      try {
        const entry = record as MergeQueueEntryRecord;
        if (entry.repoDigest !== request.repoDigest) {
          return false;
        }
        const live = entry.state === 'queued' || entry.state === 'ready';
        if (live && sameMergeQueueIdentity(entry, target)) {
          return true;
        }
        const supersedable =
          live || (entry.state === 'parked' && entry.reason === 'update-refused');
        return supersedable && isSupersedablePredecessor(entry, target);
      } catch {
        return false;
      }
    });
    return found ? 'queued' : 'not-queued';
  }

  /** S9: close an open intent on `expectedKey` with the closing result; already closed is fine. */
  private async closeOpenIntent(expectedKey: string): Promise<void> {
    let rows: unknown;
    try {
      rows = await this.deps.journal.listForKey(expectedKey);
    } catch {
      return;
    }
    const read = readJournalRows(rows);
    if (read === null) {
      return;
    }
    if (read.some((row) => row.kind === 'result')) {
      return;
    }
    const openIntent = read.find((row) => row.kind === 'intent');
    if (openIntent === undefined) {
      return;
    }
    const result: LaneRunJournalEntryRecord = {
      version: LANE_RUN_JOURNAL_ENTRY_VERSION,
      entryId: this.deps.newUlid(),
      kind: 'result',
      key: expectedKey,
      runId: openIntent.runId,
      recordedAtIso: this.deps.nowIso(),
      mode: null,
      expectedRevision: null,
      mintedId: null,
      outcome: 'dry-run',
      reasonCode: 'shadow-intent-closed',
      detail: null,
      grantId: null,
      state: null,
    };
    try {
      // A duplicate-key refusal means the intent was closed already; either
      // way the closing step has done its work and the budget outcome stands.
      await this.deps.journal.append(result);
    } catch {
      // A throwing append stays unreported here: the budget outcome stands.
    }
  }
}
