// @generated use-case scaffold — refined for lane DT9a.
/**
 * RunMergePassUseCase implements RunMergePassPort: the shadow half of the
 * daemon merge pass (plan §3.3, lane DT9a). It reads the merge queue for one
 * repository, gathers every live entry's facts through the read-only ports,
 * runs the pure decider once per entry, and journals one keyed intent and one
 * keyed `dry-run` result per acted entry under the `merge/` key family. It
 * never writes to the forge, never writes the queue, and never performs a
 * live action: a live policy decision is reported `live-deferred` for DT9b.
 */

import type {
  MergePassEntryDecision,
  MergePassEntryReport,
  RunMergePassPort,
  RunMergePassRequest,
  RunMergePassResult,
} from '../ports/in/RunMergePassPort.in-port.js';
import type { MergeQueueRepositoryPort } from '../ports/out/MergeQueueRepositoryPort.out-port.js';
import type { ForgeMergeReadPort, MergeContextSnapshot } from '../ports/out/ForgeMergeReadPort.out-port.js';
import type { MergeVerificationPort } from '../ports/out/MergeVerificationPort.out-port.js';
import type { LaneRunJournalPort } from '../ports/out/LaneRunJournalPort.out-port.js';
import type { ConductorHaltPort } from '../ports/out/ConductorHaltPort.out-port.js';
import type {
  MergeContextFact,
  MergeStepDecision,
  MergeStepFacts,
} from '../../domain/merge-queue-decider.js';
import { decideMergeStep } from '../../domain/merge-queue-decider.js';
import { computeCallBudget } from '../../domain/daemon-tick.js';
import { isConductorHalted, isZonedIsoDateTime } from '../../domain/conductor-halt.js';
import {
  findMergeQueueHead,
  orderMergeQueue,
  type MergeQueueEntryRecord,
} from '../../domain/merge-queue-records.js';
import { buildMergeKey, head12Of, type MergeKeyAction } from '../../domain/lane-run-keys.js';
import {
  LANE_RUN_JOURNAL_ENTRY_VERSION,
  type LaneRunJournalEntryRecord,
} from '../../domain/lane-run-journal.js';

export interface RunMergePassDependencies {
  readonly queue: Pick<MergeQueueRepositoryPort, 'listMergeEntries'>;
  readonly forgeRead: ForgeMergeReadPort;
  readonly verification: MergeVerificationPort;
  readonly journal: Pick<LaneRunJournalPort, 'append' | 'listForKey'>;
  readonly halt: Pick<ConductorHaltPort, 'read'>;
  readonly newUlid: () => string;   // a fresh ULID per journal entry
  readonly nowIso: () => string;    // the pass clock, read fresh
}

const REPOSITORY_SEGMENT_PATTERN = /^[A-Za-z0-9_.-]{1,100}$/;
const REPO_DIGEST_PATTERN = /^[0-9a-f]{12}$/;
const NORMAL_CALL_TIMEOUT_MS = 30_000;
const UPDATE_WINDOW_MS = 60 * 60 * 1000;

const CONTEXT_SUCCESS_TOKENS = new Set(['SUCCESS']);
const CONTEXT_PENDING_TOKENS = new Set([
  'PENDING', 'IN_PROGRESS', 'QUEUED', 'WAITING', 'REQUESTED', 'EXPECTED',
]);
const CONTEXT_FAILED_TOKENS = new Set([
  'FAILURE', 'ERROR', 'CANCELLED', 'SKIPPED', 'NEUTRAL', 'TIMED_OUT',
  'ACTION_REQUIRED', 'STALE',
]);

const MERGE_STATE_BY_TOKEN: Record<string, 'CLEAN' | 'BEHIND' | 'BLOCKED' | 'UNKNOWN'> = {
  clean: 'CLEAN',
  behind: 'BEHIND',
  blocked: 'BLOCKED',
  unknown: 'UNKNOWN',
};

/** The budget guard of D-DT9: a call is never started with under 2 s left. */
function callAllowed(nowIso: string, deadlineIso: string): boolean {
  return computeCallBudget({ nowIso, deadlineIso, normalTimeoutMs: NORMAL_CALL_TIMEOUT_MS }).allowed;
}

/** The queue adapter signals a passed deadline with a dedicated error. */
function isQueueDeadlineError(error: unknown): boolean {
  return error instanceof Error && error.name === 'MergeQueueDeadlineError';
}

/** Raw check-rollup token → the decider's context state; anything else fails closed. */
function contextStateOf(snapshot: MergeContextSnapshot): MergeContextFact {
  if (snapshot.state === 'missing') {
    return { state: 'missing', creatorLogin: snapshot.creatorLogin };
  }
  if (CONTEXT_SUCCESS_TOKENS.has(snapshot.state)) {
    return { state: 'success', creatorLogin: snapshot.creatorLogin };
  }
  if (CONTEXT_PENDING_TOKENS.has(snapshot.state)) {
    return { state: 'pending', creatorLogin: snapshot.creatorLogin };
  }
  if (CONTEXT_FAILED_TOKENS.has(snapshot.state)) {
    return { state: 'failure', creatorLogin: snapshot.creatorLogin };
  }
  return { state: 'failure', creatorLogin: snapshot.creatorLogin };
}

export class RunMergePassUseCase implements RunMergePassPort {
  constructor(private readonly deps: RunMergePassDependencies) {}

  async runMergePass(request: RunMergePassRequest): Promise<RunMergePassResult> {
    if (!this.isValidRequest(request)) {
      return { outcome: 'refused', reasonCode: 'invalid-request', entries: [] };
    }

    const entries: MergePassEntryReport[] = [];

    // Budget guard before the first outbound call (D-DT9).
    if (!callAllowed(this.deps.nowIso(), request.deadlineIso)) {
      return { outcome: 'budget-exhausted', reasonCode: null, entries };
    }

    // Read the queue once; a passed deadline is a budget outcome, any other
    // failure a refusal.
    let records: readonly MergeQueueEntryRecord[];
    try {
      records = await this.deps.queue.listMergeEntries({
        repository: request.repository,
        deadlineIso: request.deadlineIso,
      });
    } catch (error) {
      if (isQueueDeadlineError(error)) {
        return { outcome: 'budget-exhausted', reasonCode: null, entries };
      }
      return { outcome: 'refused', reasonCode: 'queue-unreadable', entries };
    }

    // Every record of this repository, any state: the journal-derived update
    // count reads them all, the live order filters to live entries.
    const repoRecords = records.filter((record) => record.repoDigest === request.repoDigest);
    const live = orderMergeQueue(repoRecords, request.repoDigest);
    const head = findMergeQueueHead(live, request.repoDigest);

    // The kill switch, read once; an unreadable read is a halt (fail closed).
    // D-DT9: the budget is checked before this outbound read too.
    if (!callAllowed(this.deps.nowIso(), request.deadlineIso)) {
      return { outcome: 'budget-exhausted', reasonCode: null, entries };
    }
    let halted: boolean;
    try {
      halted = isConductorHalted(await this.deps.halt.read());
    } catch {
      halted = true;
    }

    for (const entry of live) {
      if (!callAllowed(this.deps.nowIso(), request.deadlineIso)) {
        return { outcome: 'budget-exhausted', reasonCode: null, entries };
      }
      try {
        entries.push(await this.actOnEntry(request, entry, head, halted, repoRecords));
      } catch (error) {
        if (error instanceof MergePassBudgetExhausted) {
          return { outcome: 'budget-exhausted', reasonCode: null, entries };
        }
        entries.push({
          entryId: entry.entryId,
          head12: head12Of(entry.headOid) ?? '',
          decision: 'no-action',
          reasonCode: 'entry-failed',
          journalKey: null,
        });
      }
    }

    return { outcome: 'completed', reasonCode: null, entries };
  }

  private isValidRequest(request: RunMergePassRequest): boolean {
    // A null request or a missing repository is refused, never thrown on.
    if (typeof request !== 'object' || request === null) {
      return false;
    }
    const repository: unknown = (request as { repository?: unknown }).repository;
    if (typeof repository !== 'object' || repository === null) {
      return false;
    }
    const { owner, repo } = repository as { owner?: unknown; repo?: unknown };
    const validSegment = (value: unknown) =>
      typeof value === 'string' && REPOSITORY_SEGMENT_PATTERN.test(value) && value !== '.' && value !== '..';
    return (
      validSegment(owner) &&
      validSegment(repo) &&
      REPO_DIGEST_PATTERN.test(request.repoDigest) &&
      typeof request.projectId === 'string' &&
      request.projectId.length > 0 &&
      typeof request.policy?.policyRevision === 'string' &&
      request.policy.policyRevision.length > 0 &&
      isZonedIsoDateTime(request.deadlineIso)
    );
  }

  /** Gather the facts of one live entry, run the decider, and act on its decision. */
  private async actOnEntry(
    request: RunMergePassRequest,
    entry: MergeQueueEntryRecord,
    head: MergeQueueEntryRecord | null,
    halted: boolean,
    repoRecords: readonly MergeQueueEntryRecord[],
  ): Promise<MergePassEntryReport> {
    const facts = await this.gatherFacts(request, entry, head, halted, repoRecords);
    let decision = decideMergeStep(entry, facts, request.policy, this.deps.nowIso());

    // The decider's `enter` is the only proof the contexts are green: re-run
    // it on the in-memory ready entry. Nothing is written to the queue.
    if (decision.kind === 'enter' && decision.state === 'ready') {
      const readyEntry: MergeQueueEntryRecord = {
        ...entry,
        state: 'ready',
        verifiedHeadOid: decision.verifiedHeadOid,
        verifiedBy: decision.verifiedBy,
        policyRevision: decision.policyRevision,
        revision: entry.revision + 1,
      };
      const second = decideMergeStep(readyEntry, facts, request.policy, this.deps.nowIso());
      if (second.kind === 'enter' && second.state === 'ready') {
        return this.report(entry, 'no-action', 'enter-ready', null);
      }
      decision = second;
    }

    if (request.policy.shadow === true) {
      // The action journaled now completes its own open intent with its real
      // reason (journalShadowAct); every other open shadow intent is closed.
      const current =
        decision.kind === 'act' && decision.execution === 'shadow'
          ? decision.action === 'premerge-carry'
            ? 'post-status'
            : decision.action
          : null;
      await this.closeOpenShadowIntents(request, entry, current);
    }
    return this.actOnDecision(request, entry, decision);
  }

  /** One action per entry per tick (plan §3.3); shadow mode journals, live defers. */
  private async actOnDecision(
    request: RunMergePassRequest,
    entry: MergeQueueEntryRecord,
    decision: MergeStepDecision,
  ): Promise<MergePassEntryReport> {
    if (decision.kind === 'act') {
      if (decision.action === 'macos-verify' || decision.action === 'veto') {
        // Two-way actions this lane never performs (DT9b).
        return this.report(entry, 'no-action', decision.action, null);
      }
      if (decision.execution === 'live') {
        // Do not call the forge: DT9b performs the action with a grant.
        return this.report(entry, 'live-deferred', decision.action, null);
      }
      return this.journalShadowAct(request, entry, decision);
    }
    if (decision.kind === 'wait' || decision.kind === 'park' || decision.kind === 'drop') {
      // The park and the drop are not stored here (DT9c).
      return this.report(entry, 'no-action', decision.reason, null);
    }
    if (decision.kind === 'supersede') {
      // The successor entry is DT9c.
      return this.report(entry, 'no-action', 'superseded', null);
    }
    return this.report(entry, 'no-action', 'enter-ready', null);
  }

  /** The keyed idempotence: one intent, then one `dry-run` result, nothing twice. */
  private async journalShadowAct(
    request: RunMergePassRequest,
    entry: MergeQueueEntryRecord,
    decision: Extract<MergeStepDecision, { kind: 'act' }>,
  ): Promise<MergePassEntryReport> {
    const action: MergeKeyAction = decision.action === 'premerge-carry' ? 'post-status' : decision.action;
    const head12 = head12Of(entry.headOid);
    const built = buildMergeKey({
      repoDigest: request.repoDigest,
      pullRequest: entry.pullRequest,
      head12: head12 ?? '',
      action,
      attemptOrdinal: null,
      retry: null,
    });
    if (!built.ok) {
      return this.report(entry, 'no-action', 'key-refused', null);
    }
    const key = built.key;

    this.ensureBudget(request); // D-DT9: guard before the journal read
    const existing = await this.deps.journal.listForKey(key);
    if (existing.some((candidate) => candidate.kind === 'result')) {
      return this.report(entry, 'no-action', 'already-journalled', null);
    }
    const openIntent = existing.find((candidate) => candidate.kind === 'intent');
    if (openIntent !== undefined) {
      // A pass whose budget ran out between the intent and its result left
      // the intent open: this pass completes the pair instead of reporting
      // it journalled forever. A dry-run has no external effect, so only
      // the result is written; no second intent.
      return this.appendShadowResult(request, entry, decision, key, openIntent.runId);
    }

    const intent: LaneRunJournalEntryRecord = {
      version: LANE_RUN_JOURNAL_ENTRY_VERSION,
      entryId: this.deps.newUlid(),
      kind: 'intent',
      key,
      runId: entry.runId,
      recordedAtIso: this.deps.nowIso(),
      mode: null,
      expectedRevision: null,
      mintedId: null,
      outcome: null,
      reasonCode: null,
      detail: null,
      grantId: null,
      state: null,
    };
    this.ensureBudget(request); // D-DT9: guard before the intent append
    const appended = await this.deps.journal.append(intent);
    if (appended.outcome === 'refused') {
      return this.report(
        entry,
        'no-action',
        appended.reason === 'duplicate-key' ? 'already-journalled' : appended.reason,
        null,
      );
    }

    return this.appendShadowResult(request, entry, decision, key, entry.runId);
  }

  /**
   * Under a shadow policy every merge intent this pass family writes is a
   * dry-run, so an intent left open by an earlier pass's spent budget is
   * closed here after the decider runs, whatever it decides now (the PR may
   * have closed or its head moved). The result is `dry-run` with reason
   * `shadow-intent-closed`; nothing external ran, so nothing is re-read. A
   * live policy leaves open intents to DT9b's reconcile, which re-reads the
   * forge.
   */
  private async closeOpenShadowIntents(
    request: RunMergePassRequest,
    entry: MergeQueueEntryRecord,
    except: string | null,
  ): Promise<void> {
    const head12 = head12Of(entry.headOid);
    if (head12 === null) {
      return;
    }
    for (const action of ['merge-pr', 'update-branch', 'post-status'] as const) {
      if (action === except) {
        continue;
      }
      const built = buildMergeKey({
        repoDigest: request.repoDigest,
        pullRequest: entry.pullRequest,
        head12,
        action,
        attemptOrdinal: null,
        retry: null,
      });
      if (!built.ok) {
        continue;
      }
      this.ensureBudget(request); // D-DT9: guard before the journal read
      const existing = await this.deps.journal.listForKey(built.key);
      const openIntent = existing.find((candidate) => candidate.kind === 'intent');
      if (openIntent === undefined || existing.some((candidate) => candidate.kind === 'result')) {
        continue;
      }
      this.ensureBudget(request); // D-DT9: guard before the result append
      await this.deps.journal.append({
        version: LANE_RUN_JOURNAL_ENTRY_VERSION,
        entryId: this.deps.newUlid(),
        kind: 'result',
        key: built.key,
        // The key has no run in it: the result names the intent's own run.
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
      });
    }
  }

  /** The `dry-run` result that completes a shadow act's intent. */
  private async appendShadowResult(
    request: RunMergePassRequest,
    entry: MergeQueueEntryRecord,
    decision: Extract<MergeStepDecision, { kind: 'act' }>,
    key: string,
    runId: string | null,
  ): Promise<MergePassEntryReport> {
    const result: LaneRunJournalEntryRecord = {
      version: LANE_RUN_JOURNAL_ENTRY_VERSION,
      entryId: this.deps.newUlid(),
      kind: 'result',
      key,
      runId,
      recordedAtIso: this.deps.nowIso(),
      mode: null,
      expectedRevision: null,
      mintedId: null,
      outcome: 'dry-run',
      reasonCode: decision.shadowReason,
      detail: null,
      grantId: null,
      state: null,
    };
    // D-DT9: guard before the result append too. If the budget is spent the
    // intent stays open and the next pass completes it (see journalShadowAct).
    this.ensureBudget(request);
    const appendedResult = await this.deps.journal.append(result);
    if (appendedResult.outcome === 'refused') {
      return this.report(
        entry,
        'no-action',
        appendedResult.reason === 'duplicate-key' ? 'already-journalled' : appendedResult.reason,
        null,
      );
    }
    return this.report(entry, 'journalled', decision.shadowReason, key);
  }

  /** D-DT9: no outbound call may start with under 2 s left on the pass budget. */
  private ensureBudget(request: RunMergePassRequest): void {
    if (!callAllowed(this.deps.nowIso(), request.deadlineIso)) {
      throw new MergePassBudgetExhausted();
    }
  }

  /** Gather every fact one decider run needs, exactly as plan §3.3 names them. */
  private async gatherFacts(
    request: RunMergePassRequest,
    entry: MergeQueueEntryRecord,
    head: MergeQueueEntryRecord | null,
    halted: boolean,
    repoRecords: readonly MergeQueueEntryRecord[],
  ): Promise<MergeStepFacts> {
    const read = await this.deps.forgeRead.readForgeMerge({
      repository: request.repository,
      pullRequestNumber: entry.pullRequest,
      headSha: entry.headOid,
      requiredContexts: request.policy.requiredContexts ?? ['gate', 'premerge'],
      posterLogin: request.policy.premergePosterLogin ?? undefined,
      nowIso: this.deps.nowIso(),
      deadlineIso: request.deadlineIso,
    });

    if (read.outcome === 'budget-exhausted') {
      throw new MergePassBudgetExhausted();
    }

    let pr: MergeStepFacts['pr'];
    let reReadHeadOid: MergeStepFacts['reReadHeadOid'];
    let contexts: MergeStepFacts['contexts'];
    let unresolvedThreads: MergeStepFacts['unresolvedThreads'];
    if (read.outcome === 'ok') {
      const headOid = read.liveHeadSha;
      if (read.prState === 'open') {
        pr = {
          status: 'open',
          headOid,
          mergeStateStatus: MERGE_STATE_BY_TOKEN[read.mergeState] ?? 'UNKNOWN',
        };
      } else if (read.prState === 'merged') {
        pr = { status: 'merged', headOid };
      } else {
        pr = { status: 'closed', headOid };
      }
      reReadHeadOid = headOid; // DT9a reads once; there is no second read.
      const contextRecord: Record<string, MergeContextFact> = {};
      for (const snapshot of read.contexts) {
        contextRecord[snapshot.name] = contextStateOf(snapshot);
      }
      contexts = contextRecord;
      unresolvedThreads =
        read.unresolvedThreads === 'unknown'
          ? { status: 'unknown' }
          : { status: 'known', count: read.unresolvedThreads };
    } else if (read.outcome === 'not-found') {
      pr = { status: 'unknown' };
      reReadHeadOid = undefined;
      contexts = 'unknown';
      unresolvedThreads = { status: 'unknown' };
    } else {
      // A fixed mapping: the adapter's codes are not the decider's codes.
      pr = { status: 'forge-error', code: 'gh-error' };
      reReadHeadOid = undefined;
      contexts = 'unknown';
      unresolvedThreads = { status: 'unknown' };
    }

    const macosVerification: MergeStepFacts['macosVerification'] =
      request.policy.macosProcedure === null
        ? { status: 'none' }
        : await this.readVerificationReceipt(request, entry);

    // The stored veto is used when present; otherwise an unknown veto never
    // blocks (D-JV1) and the veto question cannot be asked in this lane.
    const vetoMode = request.policy.veto.mode;
    const veto: MergeStepFacts['veto'] =
      entry.veto !== null || vetoMode === 'off'
        ? undefined
        : { outcome: 'unknown', confidence: null, mode: vetoMode, decisionReceiptId: null };

    return {
      halted,
      paused: false, // the pause gate belongs to DT10's tick
      isQueueHead: head !== null && head.entryId === entry.entryId,
      pr,
      reReadHeadOid,
      headObservedAtIso: entry.enqueuedAtIso,
      contexts,
      unresolvedThreads,
      updatesInLastHour: await this.updatesInLastHour(request, entry, repoRecords),
      pendingUpdateSinceIso: undefined, // no live update in this lane
      premergeCarry: { status: 'unknown' }, // PatchIdentityPort is cut (no baseSha source)
      disjointness: 'not-applicable', // deferred until KS5
      macosVerification,
      veto,
      lastForgeOutcome: undefined,
    };
  }

  /** Read the procedure receipt only; `runVerification` is live behaviour (DT9b). */
  private async readVerificationReceipt(
    request: RunMergePassRequest,
    entry: MergeQueueEntryRecord,
  ): Promise<MergeStepFacts['macosVerification']> {
    if (!callAllowed(this.deps.nowIso(), request.deadlineIso)) {
      throw new MergePassBudgetExhausted();
    }
    try {
      const answer = await this.deps.verification.readVerification({
        repoDigest: request.repoDigest,
        headOid: entry.headOid,
        macosProcedure: request.policy.macosProcedure as string,
        policyRevision: request.policy.policyRevision,
        projectId: request.projectId,
        attemptId: entry.attemptId,
        deadlineIso: request.deadlineIso,
      });
      return answer.outcome === 'verified'
        ? { status: 'passed', receiptHeadOid: answer.receiptHeadOid }
        : { status: 'unknown' };
    } catch {
      return { status: 'unknown' };
    }
  }

  /**
   * The per-PR update count derived from the journal: every head12 known for
   * the pull request (any state), the intents of its base `update-branch` key
   * within the last hour. A key whose only result is `dry-run` is a shadow
   * trial, not an update, so it does not throttle itself.
   */
  private async updatesInLastHour(
    request: RunMergePassRequest,
    entry: MergeQueueEntryRecord,
    repoRecords: readonly MergeQueueEntryRecord[],
  ): Promise<number | 'unknown'> {
    const head12s = new Set<string>();
    for (const record of repoRecords) {
      if (record.pullRequest !== entry.pullRequest) {
        continue;
      }
      const head12 = head12Of(record.headOid);
      if (head12 !== null) {
        head12s.add(head12);
      }
    }
    if (head12s.size === 0) {
      return 0;
    }
    const nowMs = Date.parse(this.deps.nowIso());
    let count = 0;
    try {
      for (const head12 of head12s) {
        this.ensureBudget(request); // D-DT9: guard before each journal read
        const built = buildMergeKey({
          repoDigest: request.repoDigest,
          pullRequest: entry.pullRequest,
          head12,
          action: 'update-branch',
          attemptOrdinal: null,
          retry: null,
        });
        if (!built.ok) {
          continue;
        }
        const entries = await this.deps.journal.listForKey(built.key);
        const results = entries.filter((candidate) => candidate.kind === 'result');
        if (results.length > 0 && results.every((candidate) => candidate.outcome === 'dry-run')) {
          continue; // a shadow trial is not an update
        }
        for (const candidate of entries) {
          const ageMs = nowMs - Date.parse(candidate.recordedAtIso);
          // Within the last hour only: a future-dated intent is not counted.
          if (candidate.kind === 'intent' && ageMs >= 0 && ageMs < UPDATE_WINDOW_MS) {
            count += 1;
          }
        }
      }
    } catch (error) {
      if (error instanceof MergePassBudgetExhausted) {
        throw error; // a spent budget is the pass outcome, not an unknown count
      }
      return 'unknown';
    }
    return count;
  }

  private report(
    entry: MergeQueueEntryRecord,
    decision: MergePassEntryDecision,
    reasonCode: string | null,
    journalKey: string | null,
  ): MergePassEntryReport {
    return {
      entryId: entry.entryId,
      head12: head12Of(entry.headOid) ?? '',
      decision,
      reasonCode,
      journalKey,
    };
  }
}

/** Thrown inward when a read answers `budget-exhausted`; never leaves the use case. */
class MergePassBudgetExhausted extends Error {
  constructor() {
    super('merge pass budget exhausted');
    this.name = 'MergePassBudgetExhausted';
  }
}
