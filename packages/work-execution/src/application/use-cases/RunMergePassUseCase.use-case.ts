// @generated use-case scaffold — refined for lane DT9a.
/**
 * RunMergePassUseCase implements RunMergePassPort: the shadow half of the
 * daemon merge pass (plan §3.3, lane DT9a). It reads the merge queue for one
 * repository, gathers every live entry's facts through the read-only ports,
 * runs the pure decider once per entry, and journals one keyed intent and one
 * keyed `dry-run` result per acted entry under the `merge/` key family. It
 * never writes to the forge, never writes the queue, and never performs a
 * live action: a live policy decision is reported `live-deferred` for DT9b.
 * A shadow pass does not forge-read a live entry whose current head already
 * has a journaled `would-already-merged` dry-run, nor one whose head has a
 * journaled `would-supersede` dry-run once that pull request has a
 * `would-already-merged` dry-run under any head. Every failure of that
 * lookup leaves the entry live.
 */

import type {
  MergePassEntryDecision,
  MergePassEntryReport,
  RunMergePassPort,
  RunMergePassRequest,
  RunMergePassResult,
} from '../ports/in/RunMergePassPort.in-port.js';
import type { MergeQueueRepositoryPort } from '../ports/out/MergeQueueRepositoryPort.out-port.js';
import type {
  ForgeMergeReadPort,
  MergeContextSnapshot,
  ReadForgeMergeResult,
} from '../ports/out/ForgeMergeReadPort.out-port.js';
import type { MergeNotificationPort } from '../ports/out/MergeNotificationPort.out-port.js';
import type { MergeVerificationPort } from '../ports/out/MergeVerificationPort.out-port.js';
import type { LaneRunJournalPort } from '../ports/out/LaneRunJournalPort.out-port.js';
import type { ConductorHaltPort } from '../ports/out/ConductorHaltPort.out-port.js';
import type {
  MergeContextFact,
  MergeStepDecision,
  MergeStepFacts,
} from '../../domain/merge-queue-decider.js';
import { decideMergeStep, isMergedHeadRetroMergeEligible, premergeLoginsMatch } from '../../domain/merge-queue-decider.js';
import { computeCallBudget } from '../../domain/daemon-tick.js';
import { isZonedIsoDateTime } from '../../domain/conductor-halt.js';
import { isRequiredPassHalted } from './chain-pass-halt.js';
import {
  findMergeQueueHead,
  orderMergeQueue,
  type MergeQueueEntryRecord,
} from '../../domain/merge-queue-records.js';
import type { MergeVetoPort } from '../ports/out/MergeVetoPort.out-port.js';
import type {
  MergeVetoStatePort,
  MergeVetoStateResult,
} from '../ports/out/MergeVetoStatePort.out-port.js';
import type { MergeVetoStateFields } from '../ports/out/MergeVetoPort.out-port.js';
import type { MergeQueueVetoRecord } from '../../domain/merge-queue-records.js';
import { buildVetoEntry } from '../../domain/merge-pass-transitions.js';
import {
  buildDroppedEntry,
  buildParkedEntry,
  buildReadyEntry,
  buildSupersession,
  isMergeParkReason,
  dropNotificationEvent,
  mergeNotificationKey,
  parkNotificationEvent,
  sameMergeEntryContent,
  type MergeNotificationEvent,
} from '../../domain/merge-pass-transitions.js';
import { buildMergeKey, head12Of, parseLaneRunKey, type MergeKeyAction } from '../../domain/lane-run-keys.js';
import {
  LANE_RUN_JOURNAL_ENTRY_VERSION,
  type LaneRunJournalEntryRecord,
} from '../../domain/lane-run-journal.js';

export interface RunMergePassDependencies {
  readonly queue: Pick<MergeQueueRepositoryPort, 'listMergeEntries'>;
  /**
   * Compare-and-set writes of entry records (DT9c). Absent, the pass stays the
   * DT9a observer: it records nothing on the queue.
   */
  readonly queueWriter?: Pick<MergeQueueRepositoryPort, 'applyMergeTransition'>;
  /** One notification per (event, id). Absent, no transition that needs one is written. */
  readonly notifier?: MergeNotificationPort;
  readonly forgeRead: ForgeMergeReadPort;
  readonly verification: MergeVerificationPort;
  readonly journal: Pick<LaneRunJournalPort, 'append' | 'listForKey' | 'listForKeyPrefix'>;
  readonly halt: Pick<ConductorHaltPort, 'read'>;
  readonly newUlid: () => string;   // a fresh ULID per journal entry
  readonly nowIso: () => string;    // the pass clock, read fresh
  /**
   * The advisory Jev veto (OG-16a), shadow mode only: the state read and the
   * answer port. Either absent, or a live or off policy, and the veto row
   * stays today's no-action.
   */
  readonly vetoAdvice?: Pick<MergeVetoPort, 'adviseMergeVeto'>;
  readonly vetoState?: Pick<MergeVetoStatePort, 'readMergeVetoState'>;
}

/** Inputs are size-bounded: a larger queue or id is refused or truncated, never read whole. */
const MAX_QUEUE_RECORDS = 5000;
const MAX_ENTRIES_PER_PASS = 100;
const MAX_PROJECT_ID_LENGTH = 256;
const REASON_TOKEN_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

const REPOSITORY_SEGMENT_PATTERN = /^[A-Za-z0-9_.-]{1,100}$/;
const REPO_DIGEST_PATTERN = /^[0-9a-f]{12}$/;
const NORMAL_CALL_TIMEOUT_MS = 30_000;
const UPDATE_WINDOW_MS = 60 * 60 * 1000;

/** A plain object answer of the veto state port, nothing more. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * A valid answered veto advice: a known choice, a finite confidence in
 * [0, 1] and a receipt id that is a non-empty string or absent. Anything
 * else — a getter that throws, a bad choice, an out-of-range confidence —
 * is read as `unknown` and never as an answer.
 */
function isValidVetoAdvice(advice: unknown): advice is {
  readonly status: 'answered';
  readonly choice: 'merge-safe' | 'hold-for-human';
  readonly confidence: number;
  readonly decisionReceiptId?: string | null;
} {
  try {
    if (!isPlainObject(advice) || advice.status !== 'answered') {
      return false;
    }
    if (advice.choice !== 'merge-safe' && advice.choice !== 'hold-for-human') {
      return false;
    }
    const confidence: unknown = advice.confidence;
    if (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      return false;
    }
    const receipt: unknown = advice.decisionReceiptId;
    return receipt === undefined || receipt === null || (typeof receipt === 'string' && receipt.length > 0);
  } catch {
    return false;
  }
}


const CONTEXT_SUCCESS_TOKENS = new Set(['SUCCESS']);
const CONTEXT_PENDING_TOKENS = new Set([
  'PENDING', 'IN_PROGRESS', 'QUEUED', 'WAITING', 'REQUESTED', 'EXPECTED',
]);
const CONTEXT_FAILED_TOKENS = new Set([
  'FAILURE', 'ERROR', 'CANCELLED', 'SKIPPED', 'NEUTRAL', 'TIMED_OUT',
  'ACTION_REQUIRED', 'STALE',
]);

type MergeStateStatus = 'CLEAN' | 'BEHIND' | 'BLOCKED' | 'DIRTY' | 'UNKNOWN';

const MERGE_STATE_BY_TOKEN: Record<string, MergeStateStatus> = {
  clean: 'CLEAN',
  behind: 'BEHIND',
  blocked: 'BLOCKED',
  dirty: 'DIRTY',
  unknown: 'UNKNOWN',
};

/**
 * Live mode keeps main's mapping: forge `dirty` reads as UNKNOWN and the
 * decider waits. The DIRTY mapping applies only under shadow.
 */
function shadowMergeStateStatus(
  mapped: MergeStateStatus,
  shadow: boolean,
): MergeStateStatus {
  if (!shadow && mapped === 'DIRTY') return 'UNKNOWN';
  return mapped;
}

/**
 * The entry-scoped context the shadow supersede path needs to re-decide and
 * report: the selected entry, the predecessor record it journals against, and
 * the pass context needed to re-gather facts for the in-memory successor.
 */
interface ShadowSupersedeContext {
  /** The originally selected queue entry, used for reporting. */
  readonly entry: MergeQueueEntryRecord;
  /** The predecessor record the supersession journals against. */
  readonly predecessor: MergeQueueEntryRecord;
  /** The predecessor's already-gathered facts (its `isQueueHead` is preserved). */
  readonly facts: MergeStepFacts;
  /** The current queue head, passed through to fact gathering. */
  readonly head: MergeQueueEntryRecord | null;
  /** The pass's halt state, re-checked during fact gathering. */
  readonly halted: boolean;
  /** The pass's full record set, passed through to fact gathering. */
  readonly repoRecords: readonly MergeQueueEntryRecord[];
}

/**
 * At most MAX_ENTRIES_PER_PASS entries per pass: the queue head always, the
 * rest in queue order rotated by the pass minute, so a long run of parked
 * entries at the front cannot starve the entries behind it.
 */
function selectEntriesForPass(
  ordered: readonly MergeQueueEntryRecord[],
  head: MergeQueueEntryRecord | null,
  nowMs: number,
): readonly MergeQueueEntryRecord[] {
  if (ordered.length <= MAX_ENTRIES_PER_PASS) {
    return ordered;
  }
  const rest = ordered.filter((entry) => head === null || entry.entryId !== head.entryId);
  const window = MAX_ENTRIES_PER_PASS - (head === null ? 0 : 1);
  const step = Number.isFinite(nowMs) ? Math.floor(nowMs / 60_000) : 0;
  const offset = (step * window) % rest.length;
  const rotated = [...rest.slice(offset), ...rest.slice(0, offset)].slice(0, window);
  const chosen = new Set(rotated.map((entry) => entry.entryId));
  if (head !== null) {
    chosen.add(head.entryId);
  }
  return ordered.filter((entry) => chosen.has(entry.entryId));
}

/** The budget guard of D-DT9: a call is never started with under 2 s left. */
function callAllowed(nowIso: string, deadlineIso: string): boolean {
  return computeCallBudget({ nowIso, deadlineIso, normalTimeoutMs: NORMAL_CALL_TIMEOUT_MS }).allowed;
}

type ShadowSkipAction = 'would-already-merged' | 'would-supersede';

interface ShadowSkipIndex {
  /** Every `would-already-merged` dry-run key for this repository, any head. */
  readonly alreadyMergedKeys: ReadonlySet<string>;
  /** Pull requests that have a `would-already-merged` dry-run under any head. */
  readonly alreadyMergedPullRequests: ReadonlySet<number>;
  /** Every `would-supersede` dry-run key for this repository. */
  readonly supersededKeys: ReadonlySet<string>;
}

type AlreadyMergedIndex =
  | ({ readonly outcome: 'indexed' } & ShadowSkipIndex)
  | { readonly outcome: 'budget-exhausted' };

function openShadowSkipIndex(): Extract<AlreadyMergedIndex, { outcome: 'indexed' }> {
  return {
    outcome: 'indexed',
    alreadyMergedKeys: new Set<string>(),
    alreadyMergedPullRequests: new Set<number>(),
    supersededKeys: new Set<string>(),
  };
}

/**
 * One dry-run result that can exclude a shadow entry. It counts only when
 * `kind === 'result'`, `outcome === 'dry-run'` and `reasonCode` is the parsed
 * merge action (`would-already-merged` or `would-supersede`). A closed intent
 * (`shadow-intent-closed`), an open intent, a non-merge key, another
 * repository, a non-integer pull request, or a throwing getter is not a hit.
 */
function shadowSkipHit(
  record: unknown,
  repoDigest: string,
): { readonly key: string; readonly action: ShadowSkipAction; readonly pullRequest: number } | null {
  try {
    const view = record as {
      kind: unknown;
      outcome: unknown;
      reasonCode: unknown;
      key: unknown;
    };
    const kind = view.kind;
    const outcome = view.outcome;
    const reasonCode = view.reasonCode;
    const key = view.key;
    if (kind !== 'result' || outcome !== 'dry-run' || typeof key !== 'string' || typeof reasonCode !== 'string') {
      return null;
    }
    const parsed = parseLaneRunKey(key);
    if (
      parsed === null ||
      parsed.kind !== 'merge' ||
      parsed.repoDigest !== repoDigest ||
      !Number.isSafeInteger(parsed.pullRequest) ||
      parsed.pullRequest < 1 ||
      reasonCode !== parsed.action
    ) {
      return null;
    }
    if (parsed.action !== 'would-already-merged' && parsed.action !== 'would-supersede') {
      return null;
    }
    return { key, action: parsed.action, pullRequest: parsed.pullRequest };
  } catch {
    return null;
  }
}

/** One pass over the prefix listing. A record that cannot be read is ignored. */
function shadowSkipIndexFromRecords(records: readonly unknown[], repoDigest: string): ShadowSkipIndex {
  const alreadyMergedKeys = new Set<string>();
  const alreadyMergedPullRequests = new Set<number>();
  const supersededKeys = new Set<string>();
  for (const record of records) {
    const hit = shadowSkipHit(record, repoDigest);
    if (hit === null) {
      continue;
    }
    if (hit.action === 'would-already-merged') {
      alreadyMergedKeys.add(hit.key);
      alreadyMergedPullRequests.add(hit.pullRequest);
      continue;
    }
    supersededKeys.add(hit.key);
  }
  return { alreadyMergedKeys, alreadyMergedPullRequests, supersededKeys };
}

/**
 * True when this shadow entry is already settled in the journal: its current
 * head has a `would-already-merged` dry-run, or that pull request has a
 * `would-already-merged` dry-run under any head and this head already has a
 * `would-supersede` dry-run. An unreadable head or a refused key is not a
 * match, so the entry stays live and its supersede can still be journaled once.
 */
function matchesJournaledAlreadyMerged(
  repoDigest: string,
  entry: MergeQueueEntryRecord,
  index: ShadowSkipIndex,
): boolean {
  const head12 = head12Of(entry.headOid);
  if (head12 === null) {
    return false;
  }
  const alreadyMerged = buildMergeKey({
    repoDigest,
    pullRequest: entry.pullRequest,
    head12,
    action: 'would-already-merged',
    attemptOrdinal: null,
    retry: null,
  });
  if (alreadyMerged.ok && index.alreadyMergedKeys.has(alreadyMerged.key)) {
    return true;
  }
  // Without the supersede on this head the entry stays live: the next pass
  // still has to journal `would-supersede` once.
  if (!index.alreadyMergedPullRequests.has(entry.pullRequest)) {
    return false;
  }
  const superseded = buildMergeKey({
    repoDigest,
    pullRequest: entry.pullRequest,
    head12,
    action: 'would-supersede',
    attemptOrdinal: null,
    retry: null,
  });
  return superseded.ok && index.supersededKeys.has(superseded.key);
}

function withoutJournaledAlreadyMerged(
  repoDigest: string,
  ordered: readonly MergeQueueEntryRecord[],
  index: ShadowSkipIndex,
): readonly MergeQueueEntryRecord[] {
  if (index.alreadyMergedKeys.size === 0) {
    return ordered;
  }
  return ordered.filter((entry) => !matchesJournaledAlreadyMerged(repoDigest, entry, index));
}

/** The queue adapter signals a passed deadline with a dedicated error. */
function isQueueDeadlineError(error: unknown): boolean {
  return error instanceof Error && error.name === 'MergeQueueDeadlineError';
}

/** Raw check-rollup token → the decider's context state; anything else fails closed. */
function contextStateOf(snapshot: MergeContextSnapshot): MergeContextFact {
  const createdAtIso = snapshot.createdAtIso;
  if (snapshot.state === 'missing') {
    return { state: 'missing', creatorLogin: snapshot.creatorLogin, createdAtIso };
  }
  if (CONTEXT_SUCCESS_TOKENS.has(snapshot.state)) {
    return { state: 'success', creatorLogin: snapshot.creatorLogin, createdAtIso };
  }
  if (CONTEXT_PENDING_TOKENS.has(snapshot.state)) {
    return { state: 'pending', creatorLogin: snapshot.creatorLogin, createdAtIso };
  }
  if (CONTEXT_FAILED_TOKENS.has(snapshot.state)) {
    return { state: 'failure', creatorLogin: snapshot.creatorLogin, createdAtIso };
  }
  return { state: 'failure', creatorLogin: snapshot.creatorLogin, createdAtIso };
}

/** The observed-base fact: the key exists only when the forge read carried a base (OG-7). */
function observedBaseFact(read: ReadForgeMergeResult): { readonly observedBaseBranch?: unknown } {
  if (read.outcome !== 'ok' || read.baseRef === undefined) {
    return {};
  }
  return { observedBaseBranch: read.baseRef };
}

export class RunMergePassUseCase implements RunMergePassPort {
  constructor(private readonly deps: RunMergePassDependencies) {}

  async runMergePass(request: RunMergePassRequest): Promise<RunMergePassResult> {
    // The pass never throws on runtime input: any escape is a typed refusal.
    try {
      return await this.runPass(request);
    } catch {
      return { outcome: 'refused', reasonCode: 'pass-failed', entries: [] };
    }
  }

  private async runPass(request: RunMergePassRequest): Promise<RunMergePassResult> {
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

    // A non-list or an oversized answer is refused, never read whole.
    if (!Array.isArray(records) || records.length > MAX_QUEUE_RECORDS) {
      return { outcome: 'refused', reasonCode: 'queue-unreadable', entries };
    }

    // Every record of this repository, any state: the journal-derived update
    // count reads them all, the live order filters to live entries.
    const repoRecords = records.filter(
      (record) => typeof record === 'object' && record !== null && record.repoDigest === request.repoDigest,
    );
    const ordered = orderMergeQueue(repoRecords, request.repoDigest);
    const head = findMergeQueueHead(ordered, request.repoDigest);
    // Shadow only: one prefix read of journaled shadow dry-runs, then drop a
    // head that already has `would-already-merged`, or that has
    // `would-supersede` after the pull request was merged under another head.
    // `repoRecords` stays whole so `updatesInLastHour` still sees every record.
    // `head` is the real queue head and is what `actOnEntry` uses for
    // `isQueueHead`; `passHead` is that head only while it remains a candidate.
    const indexed = await this.readJournaledWouldAlreadyMerged(request);
    if (indexed.outcome === 'budget-exhausted') {
      return { outcome: 'budget-exhausted', reasonCode: null, entries };
    }
    const candidates =
      request.policy.shadow === true
        ? withoutJournaledAlreadyMerged(request.repoDigest, ordered, indexed)
        : ordered;
    const passHead =
      head !== null && candidates.some((candidate) => candidate.entryId === head.entryId) ? head : null;
    const live = selectEntriesForPass(candidates, passHead, Date.parse(this.deps.nowIso()));

    // D-DT9: the budget is checked before every entry's outbound reads,
    // including the halt re-read below.
    if (!callAllowed(this.deps.nowIso(), request.deadlineIso)) {
      return { outcome: 'budget-exhausted', reasonCode: null, entries };
    }

    for (const entry of live) {
      if (!callAllowed(this.deps.nowIso(), request.deadlineIso)) {
        return { outcome: 'budget-exhausted', reasonCode: null, entries };
      }
      // The kill switch, re-read before every entry; an unreadable read is a
      // halt (fail closed).
      const halted = await isRequiredPassHalted(this.deps.halt);
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

  /**
   * Journaled shadow dry-runs for this repository, from one `listForKeyPrefix`
   * of `merge/<repoDigest>/`. Live passes do not read. A missing method, a
   * throw, or a non-array answer fails open to empty sets. A spent budget
   * does not call the port. A record counts only when it is a `dry-run`
   * result whose reasonCode is the parsed merge action.
   */
  private async readJournaledWouldAlreadyMerged(request: RunMergePassRequest): Promise<AlreadyMergedIndex> {
    if (request.policy.shadow !== true) {
      return openShadowSkipIndex();
    }
    if (!callAllowed(this.deps.nowIso(), request.deadlineIso)) {
      return { outcome: 'budget-exhausted' };
    }
    const listForKeyPrefix = this.deps.journal.listForKeyPrefix;
    if (listForKeyPrefix === undefined) {
      return openShadowSkipIndex();
    }
    let records: unknown;
    try {
      records = await listForKeyPrefix.call(this.deps.journal, `merge/${request.repoDigest}/`);
    } catch {
      return openShadowSkipIndex();
    }
    if (!Array.isArray(records)) {
      return openShadowSkipIndex();
    }
    const index = shadowSkipIndexFromRecords(records, request.repoDigest);
    return {
      outcome: 'indexed',
      alreadyMergedKeys: index.alreadyMergedKeys,
      alreadyMergedPullRequests: index.alreadyMergedPullRequests,
      supersededKeys: index.supersededKeys,
    };
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
      request.projectId.length <= MAX_PROJECT_ID_LENGTH &&
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
    let current = entry;
    let decision = decideMergeStep(current, facts, request.policy, this.deps.nowIso());

    // The decider's `enter` is the only proof the contexts are green. The
    // verification audit is written to the entry (plan §3.6) and the decider
    // re-runs on the recorded ready entry, so the same tick still reaches the
    // action row (the shadow `would-merge`).
    if (decision.kind === 'enter' && decision.state === 'ready') {
      const built = buildReadyEntry(entry, {
        verifiedHeadOid: decision.verifiedHeadOid,
        verifiedBy: decision.verifiedBy,
        policyRevision: decision.policyRevision,
        premergeReceiptHeadOid: premergeReceiptHeadOf(request, entry, facts),
      });
      if (!built.ok) {
        return this.report(entry, 'no-action', 'entry-refused', null);
      }
      const persisted = await this.persist(request, entry, built.record, null, null);
      if (persisted.status === 'failed') {
        return this.report(entry, 'no-action', persisted.reasonCode, null);
      }
      current = persisted.status === 'written' ? persisted.record : built.record;
      const second = decideMergeStep(current, facts, request.policy, this.deps.nowIso());
      if (second.kind === 'enter' && second.state === 'ready') {
        // Owner decision A+ (2026-11-18): enter-ready persists as on main,
        // also under a shadow policy; the queue write goes through `persist`.
        return this.report(
          entry,
          persisted.status === 'written' ? 'recorded' : 'no-action',
          'enter-ready',
          null,
        );
      }
      decision = second;
    }

    if (request.policy.shadow === true && decision.kind === 'supersede') {
      // SH24a: the supersession is never persisted; the successor lives only in
      // memory for this pass, so a green moved head still reaches `would-merge`.
      return this.shadowSupersedeThenAct(request, {
        entry,
        predecessor: current,
        facts,
        head,
        halted,
        repoRecords,
      }, decision);
    }

    if (request.policy.shadow === true) {
      await this.closeOpenShadowIntents(request, current, this.actingShadowAction(decision));
    }
    if (decision.kind === 'act' && decision.action === 'veto' && this.shadowVetoBound(request)) {
      const vetoReport = await this.performShadowVeto(request, current, decision.expectedHeadOid);
      if (vetoReport !== null) {
        return vetoReport;
      }
      // No writer, or the veto entry was refused by record validation: the row
      // is unknown for this pass and never blocks (D-JV1), so the pass moves on
      // to the next row as if the veto had answered unknown. Nothing is stored,
      // so a later pass reaches this step again (advice is asked again once per
      // pass when the entry was refused; never when the writer is absent).
      // A failed write is NOT this case: it returns its reason code and stops.
      const unrecorded: MergeStepFacts = {
        ...facts,
        veto: { outcome: 'unknown', confidence: null, mode: 'shadow', decisionReceiptId: null },
      };
      decision = decideMergeStep(current, unrecorded, request.policy, this.deps.nowIso());
      if (request.policy.shadow === true) {
        await this.closeOpenShadowIntents(request, current, this.actingShadowAction(decision));
      }
    }
    return this.actOnDecision(request, current, decision, facts);
  }

  /** The shadow action this decision journals now, if any (its own open intent is completed, not closed). */
  private actingShadowAction(decision: MergeStepDecision): string | null {
    if (decision.kind === 'act' && decision.execution === 'shadow') {
      return decision.action === 'premerge-carry' ? 'post-status' : decision.action;
    }
    // Owner decision A+ (2026-11-18): only the suppressed set journals its own
    // `would-*` key — every drop, the `veto-hold` park, supersede and the
    // forge-confirmed already-merged wait. Ordinary parks and enter-ready
    // persist as on main, so an interrupted intent from a prior tick is
    // closed (not completed) when the head now persists again.
    if (decision.kind === 'drop') {
      return 'would-drop';
    }
    if (decision.kind === 'park' && decision.reason === 'veto-hold') {
      return 'would-park';
    }
    if (decision.kind === 'supersede') {
      return 'would-supersede';
    }
    if (decision.kind === 'wait' && decision.reason === 'already-merged') {
      return 'would-already-merged';
    }
    return null;
  }

  /** Shadow mode with both advisory veto ports bound (OG-16a). */
  private shadowVetoBound(request: RunMergePassRequest): boolean {
    return (
      request.policy.veto.mode === 'shadow' &&
      this.deps.vetoAdvice !== undefined &&
      this.deps.vetoState !== undefined
    );
  }

  /**
   * Shadow `already-merged` (SH24a + EV2): journal the dry-run so
   * shadow-effective liveness can exclude the entry, preceded on the first
   * observation by the retro `would-merge` when the decider would have merged
   * that exact head with every required check created before the merge.
   */
  private async actOnShadowAlreadyMerged(
    request: RunMergePassRequest,
    entry: MergeQueueEntryRecord,
    facts: MergeStepFacts,
  ): Promise<MergePassEntryReport> {
    // SH24a: the forge says the PR is merged; journal the dry-run so
    // shadow-effective liveness can exclude the entry without a write.
    // EV2: on the FIRST already-merged observation for this head12
    // (no `would-already-merged` result yet), re-evaluate the live
    // path's decider predicates on the facts already gathered; if they
    // all pass, the retro `would-merge` is journaled first, keyed with
    // the merged head as its linkedId, before `would-already-merged`.
    const head12 = head12Of(entry.headOid);
    const built = buildMergeKey({
      repoDigest: request.repoDigest,
      pullRequest: entry.pullRequest,
      head12: head12 ?? '',
      action: 'would-already-merged',
      attemptOrdinal: null,
      retry: null,
    });
    if (!built.ok) {
      return this.report(entry, 'no-action', 'key-refused', null);
    }
    this.ensureBudget(request); // D-DT9: guard before the journal read
    const existing = await this.deps.journal.listForKey(built.key);
    if (existing.some((candidate) => candidate.kind === 'result')) {
      return this.report(entry, 'no-action', 'already-journalled', null);
    }
    if (isMergedHeadRetroMergeEligible(entry, facts, request.policy, this.deps.nowIso())) {
      // A refused retro append must not be followed by `would-already-merged`:
      // that result is the first-observation mark, and writing it would
      // make the retro unrecoverable. An already-journalled `would-merge`
      // (a prior pass wrote it, then stopped) still continues, so the
      // already-merged pair can be completed.
      const retro = await this.journalShadowAct(
        request,
        entry,
        {
          kind: 'act',
          action: 'merge-pr',
          execution: 'shadow',
          shadowReason: 'would-merge',
          expectedHeadOid: entry.headOid,
          receiptHeadOid: null,
          procedure: null,
          vetoShadow: null,
        },
        'retro',
      );
      if (retro.decision !== 'journalled' && retro.reasonCode !== 'already-journalled') {
        return retro;
      }
    }
    return this.journalShadowOutcome(request, entry, 'would-already-merged', null);
  }

  /** One action per entry per tick (plan §3.3); shadow mode journals, live defers. */
  private async actOnDecision(
    request: RunMergePassRequest,
    entry: MergeQueueEntryRecord,
    decision: MergeStepDecision,
    facts: MergeStepFacts,
  ): Promise<MergePassEntryReport> {
    if (decision.kind === 'act') {
      if (decision.action === 'macos-verify') {
        // Two-way actions this lane never performs (DT9b).
        return this.report(entry, 'no-action', decision.action, null);
      }
      if (decision.action === 'veto') {
        // Live, off or an unbound port pair: the veto row stays a no-action.
        // (The bound shadow veto is performed by `actOnEntry`.)
        return this.report(entry, 'no-action', 'veto', null);
      }
      if (decision.execution === 'live') {
        // Do not call the forge: DT9b performs the action with a grant.
        return this.report(entry, 'live-deferred', decision.action, null);
      }
      return this.journalShadowAct(request, entry, decision);
    }
    if (decision.kind === 'wait') {
      if (request.policy.shadow === true && decision.reason === 'already-merged') {
        return this.actOnShadowAlreadyMerged(request, entry, facts);
      }
      return this.report(entry, 'no-action', decision.reason, null);
    }
    if (decision.kind === 'park') {
      return this.recordPark(request, entry, decision);
    }
    if (decision.kind === 'drop') {
      return this.recordDrop(request, entry, decision);
    }
    if (decision.kind === 'supersede') {
      return this.recordSupersession(request, entry, decision.liveHeadOid);
    }
    // Owner decision A+ (2026-11-18): enter-ready persists as on main; the
    // write above (`persist` in `actOnEntry`) already recorded it.
    return this.report(entry, 'no-action', 'enter-ready', null);
  }

  /**
   * SH24a: the shadow supersession. The predecessor's `would-supersede` is
   * journalled on its own head, the successor is built in memory only (never
   * persisted), and the decider re-runs on the successor with the same facts
   * rule (its `isQueueHead` is preserved), so a green moved head can reach
   * `would-merge` on its new head within the same pass.
   */
  private async shadowSupersedeThenAct(
    request: RunMergePassRequest,
    context: ShadowSupersedeContext,
    decision: Extract<MergeStepDecision, { kind: 'supersede' }>,
  ): Promise<MergePassEntryReport> {
    const { entry, predecessor, facts, head, halted, repoRecords } = context;
    await this.journalShadowOutcome(request, predecessor, 'would-supersede', null);
    // Luna (minor): the predecessor head's own open intents are closed here —
    // the head is superseded, so nothing keyed on it can act again this pass.
    await this.closeOpenShadowIntents(request, predecessor, 'would-supersede');
    const built = buildSupersession(predecessor, decision.liveHeadOid, this.deps.newUlid());
    if (!built.ok) {
      return this.report(entry, 'no-action', 'entry-refused', null);
    }
    const successor = built.successor;
    const successorFacts: MergeStepFacts = {
      ...(await this.gatherFacts(request, successor, head, halted, repoRecords)),
      isQueueHead: facts.isQueueHead,
    };
    let next = decideMergeStep(successor, successorFacts, request.policy, this.deps.nowIso());
    let acting = successor;
    if (next.kind === 'enter' && next.state === 'ready') {
      const ready = buildReadyEntry(successor, {
        verifiedHeadOid: next.verifiedHeadOid,
        verifiedBy: next.verifiedBy,
        policyRevision: next.policyRevision,
        premergeReceiptHeadOid: premergeReceiptHeadOf(request, successor, successorFacts),
      });
      if (!ready.ok) {
        return this.report(entry, 'no-action', 'entry-refused', null);
      }
      const second = decideMergeStep(ready.record, successorFacts, request.policy, this.deps.nowIso());
      if (second.kind === 'enter' && second.state === 'ready') {
        // Luna (major): the moved successor lives only in memory, so the
        // `would-ready` dry-run is journalled against the successor's own
        // head, never against the original (predecessor) entry.
        return this.journalShadowOutcome(request, ready.record, 'would-ready', null);
      }
      // The in-memory ready advance stands in for the persist the shadow mode
      // never performs; the act below keys on the advanced record's own head.
      next = second;
      acting = ready.record;
    }
    if (request.policy.shadow === true && next.kind === 'park') {
      // Fix round 2 (Fable): the successor lives only in memory, so a park
      // here would call `persist` on an UNPERSISTED entry id — the real
      // adapter refuses it (`unknown-entry`), every tick would report
      // `persist-refused`, and a `would-notify` would be journalled for a
      // park that was never stored. Any decision reached on an in-memory
      // successor is journal-only: the park is journalled as `would-park`
      // with its reason, keyed on the successor's own head.
      return this.journalShadowOutcome(request, acting, 'would-park', next.reason);
    }
    if (request.policy.shadow === true) {
      await this.closeOpenShadowIntents(request, acting, this.actingShadowAction(next));
    }
    if (next.kind === 'act' && next.action === 'veto' && this.shadowVetoBound(request)) {
      const unrecorded: MergeStepFacts = {
        ...successorFacts,
        veto: { outcome: 'unknown', confidence: null, mode: 'shadow', decisionReceiptId: null },
      };
      next = decideMergeStep(acting, unrecorded, request.policy, this.deps.nowIso());
    }
    return this.actOnDecision(request, acting, next, successorFacts);
  }

  /**
   * The advisory shadow veto (OG-16a): ask the veto state port and the veto
   * answer port once, record the answer on the entry through the CAS write,
   * and always return `no-action` — the recorded veto is log-only, the pass's
   * decision never changes here. Every failure path records `unknown` or
   * returns its typed refusal, and none blocks or throws.
   */
  private async performShadowVeto(
    request: RunMergePassRequest,
    entry: MergeQueueEntryRecord,
    verifiedHeadOid: string,
  ): Promise<MergePassEntryReport | null> {
    // Owner decision A+ (2026-11-18): the shadow-veto record persists as on
    // main, also under a shadow policy; only the drop, the `veto-hold` park
    // and the supersession are suppressed.
    const unknownRecord: MergeQueueVetoRecord = {
      outcome: 'unknown',
      confidence: null,
      mode: 'shadow',
      decisionReceiptId: null,
    };
    const vetoState = this.deps.vetoState as Pick<MergeVetoStatePort, 'readMergeVetoState'>;
    const vetoAdvice = this.deps.vetoAdvice as Pick<MergeVetoPort, 'adviseMergeVeto'>;

    // Without a queue writer the veto row cannot be stored; neither port is
    // called, and `null` tells the caller the veto is unknown for this pass.
    if (this.deps.queueWriter === undefined) {
      return null;
    }

    this.ensureBudget(request);
    let stateResult: MergeVetoStateResult;
    try {
      stateResult = await vetoState.readMergeVetoState({
        repository: request.repository,
        pullRequestNumber: entry.pullRequest,
        headOid: verifiedHeadOid,
        deadlineIso: request.deadlineIso,
      });
    } catch {
      stateResult = { status: 'unavailable', reason: 'state-read-threw' };
    }
    let state: MergeVetoStateFields | null = null;
    try {
      if (
        stateResult !== null &&
        typeof stateResult === 'object' &&
        stateResult.status === 'read' &&
        isPlainObject(stateResult.state)
      ) {
        state = stateResult.state;
      }
    } catch {
      state = null;
    }
    if (state === null) {
      return this.persistShadowVeto(request, entry, unknownRecord);
    }

    this.ensureBudget(request);
    let record: MergeQueueVetoRecord = unknownRecord;
    try {
      const advice = await vetoAdvice.adviseMergeVeto({
        repository: request.repository,
        pullRequestNumber: entry.pullRequest,
        verifiedHeadOid,
        mode: 'shadow',
        state: state,
        deadlineIso: request.deadlineIso,
      });
      if (isValidVetoAdvice(advice)) {
        record = {
          outcome: advice.choice,
          confidence: advice.confidence,
          mode: 'shadow',
          decisionReceiptId: advice.decisionReceiptId ?? null,
        };
      }
    } catch {
      // A thrown veto answer is an unknown answer; it never blocks (D-JV1).
    }
    return this.persistShadowVeto(request, entry, record);
  }

  /**
   * Build and persist one veto row. Reports `no-action` / `veto` once the row
   * is stored and the write's reason code when the write fails (the entry stops
   * for this pass); `null` only when the entry is refused, which is unknown.
   */
  private async persistShadowVeto(
    request: RunMergePassRequest,
    entry: MergeQueueEntryRecord,
    vetoRecord: MergeQueueVetoRecord,
  ): Promise<MergePassEntryReport | null> {
    const built = buildVetoEntry(entry, vetoRecord);
    if (!built.ok) {
      return null;
    }
    const persisted = await this.persist(request, entry, built.record, null, null);
    if (persisted.status === 'failed') {
      return this.report(entry, 'no-action', persisted.reasonCode, null);
    }
    return this.report(entry, 'no-action', 'veto', null);
  }

  /** A park is stored once; the first park of an entry notifies once (§3.3 "first parked"). */
  private async recordPark(
    request: RunMergePassRequest,
    entry: MergeQueueEntryRecord,
    decision: Extract<MergeStepDecision, { kind: 'park' }>,
  ): Promise<MergePassEntryReport> {
    if (request.policy.shadow === true && decision.reason === 'veto-hold') {
      // Owner decision A+ (2026-11-18): the `veto-hold` park is the only park
      // the conductor treats as final, so it is suppressed and journalled as
      // `would-park` (the first park reason per head). Every other park
      // persists as on main through the compare-and-set write below.
      return this.journalShadowOutcome(request, entry, 'would-park', decision.reason);
    }
    const built = buildParkedEntry(entry, {
      reason: decision.reason,
      nextAttempt: decision.nextAttempt,
      notBeforeIso: decision.notBeforeIso,
    });
    if (!built.ok) {
      return this.report(entry, 'no-action', 'entry-refused', null);
    }
    if (entry.state === 'parked' && sameMergeEntryContent(entry, built.record)) {
      return this.report(entry, 'no-action', decision.reason, null); // already stored
    }
    // A park notifies on its first entry and again when it changes event (a
    // hold for a veto has its own line); the (event, id) key keeps each once.
    const event = parkNotificationEvent(decision.reason);
    const previousEvent =
      entry.state === 'parked' && isMergeParkReason(entry.reason) ? parkNotificationEvent(entry.reason) : null;
    const notify = previousEvent === event ? null : { event, id: entry.entryId };
    const persisted = await this.persist(request, entry, built.record, null, notify);
    if (persisted.status === 'failed') {
      return this.report(entry, 'no-action', persisted.reasonCode, null);
    }
    return this.report(entry, persisted.status === 'written' ? 'recorded' : 'no-action', decision.reason, null);
  }

  private async recordDrop(
    request: RunMergePassRequest,
    entry: MergeQueueEntryRecord,
    decision: Extract<MergeStepDecision, { kind: 'drop' }>,
  ): Promise<MergePassEntryReport> {
    if (request.policy.shadow === true) {
      // SH24a: shadow mode never drops the entry; the dry-run is journalled.
      return this.journalShadowOutcome(request, entry, 'would-drop', decision.reason);
    }
    const built = buildDroppedEntry(entry, decision.reason);
    if (!built.ok) {
      return this.report(entry, 'no-action', 'entry-refused', null);
    }
    const notify = { event: dropNotificationEvent(decision.reason), id: entry.entryId };
    const persisted = await this.persist(request, entry, built.record, null, notify);
    if (persisted.status === 'failed') {
      return this.report(entry, 'no-action', persisted.reasonCode, null);
    }
    return this.report(entry, persisted.status === 'written' ? 'recorded' : 'no-action', decision.reason, null);
  }

  /** The superseded predecessor and its successor are written in one compare-and-set. */
  private async recordSupersession(
    request: RunMergePassRequest,
    entry: MergeQueueEntryRecord,
    liveHeadOid: string,
  ): Promise<MergePassEntryReport> {
    if (request.policy.shadow === true) {
      // SH24a: defense in depth — the shadow supersession is handled by
      // `shadowSupersedeThenAct` in `actOnEntry`; if this row is ever reached
      // in shadow mode anyway, only the dry-run is journalled.
      return this.journalShadowOutcome(request, entry, 'would-supersede', null);
    }
    if (this.deps.queueWriter === undefined) {
      return this.report(entry, 'no-action', 'superseded', null);
    }
    const built = buildSupersession(entry, liveHeadOid, this.deps.newUlid());
    if (!built.ok) {
      return this.report(entry, 'no-action', 'entry-refused', null);
    }
    const persisted = await this.persist(request, entry, built.predecessor, built.successor, null);
    if (persisted.status === 'failed') {
      return this.report(entry, 'no-action', persisted.reasonCode, null);
    }
    return this.report(entry, 'recorded', 'superseded', null);
  }

  /**
   * Notify, then write, each behind the pass budget (D-DT9). A notification
   * goes first under its (event, id) key: a crash after it replays the same
   * decision, the key answers `duplicate`, and the write completes; a crash
   * before it loses nothing. A notification that cannot be sent leaves the
   * entry untouched for the next tick, so no transition goes unannounced.
   */
  private async persist(
    request: RunMergePassRequest,
    entry: MergeQueueEntryRecord,
    next: MergeQueueEntryRecord,
    successor: MergeQueueEntryRecord | null,
    notify: { readonly event: MergeNotificationEvent; readonly id: string } | null,
  ): Promise<PersistResult> {
    // Owner decision A+ (2026-11-18): the queue write persists as on main.
    // The suppressed transitions (every drop, the `veto-hold` park, the
    // supersession) never reach this method; their callers journal the
    // matching `would-*` key instead.
    const writer = this.deps.queueWriter;
    if (writer === undefined) {
      return { status: 'skipped' };
    }
    // SHADOW IS SILENT (owner decision 2026-11-18): under a shadow policy the
    // notification step is skipped and journalled as `would-notify`, so a
    // persisted shadow park never notifies anyone. Live mode notifies as
    // designed.
    let effectiveNotify = notify;
    if (effectiveNotify !== null && request.policy.shadow === true) {
      await this.journalShadowOutcome(request, entry, 'would-notify', effectiveNotify.event);
      effectiveNotify = null;
    }
    if (effectiveNotify !== null) {
      const notifier = this.deps.notifier;
      if (notifier === undefined) {
        return { status: 'failed', reasonCode: 'notifier-unavailable' };
      }
      this.ensureBudget(request);
      try {
        const sent = await notifier.notifyMergeEvent({
          event: effectiveNotify.event,
          id: effectiveNotify.id,
          key: mergeNotificationKey(effectiveNotify.event, effectiveNotify.id),
          deadlineIso: request.deadlineIso,
        });
        const outcome: unknown = sent?.outcome;
        if (outcome !== 'notified' && outcome !== 'duplicate' && outcome !== 'suppressed') {
          return { status: 'failed', reasonCode: 'notify-failed' };
        }
      } catch {
        return { status: 'failed', reasonCode: 'notify-failed' };
      }
    }
    this.ensureBudget(request);
    try {
      const written = await writer.applyMergeTransition({
        entryId: entry.entryId,
        expectedRevision: entry.revision,
        next,
        successor,
        deadlineIso: request.deadlineIso,
      });
      if (written.outcome === 'applied') {
        return { status: 'written', record: written.record };
      }
      return {
        status: 'failed',
        reasonCode: written.reason === 'revision-conflict' ? 'persist-conflict' : 'persist-refused',
      };
    } catch {
      return { status: 'failed', reasonCode: 'persist-failed' };
    }
  }

  /** The keyed idempotence: one intent, then one `dry-run` result, nothing twice. */
  private async journalShadowAct(
    request: RunMergePassRequest,
    entry: MergeQueueEntryRecord,
    decision: Extract<MergeStepDecision, { kind: 'act' }>,
    detail: string | null = null,
  ): Promise<MergePassEntryReport> {
    const action: MergeKeyAction = decision.action === 'premerge-carry' ? 'post-status' : decision.action;
    // SH24a (S1): a `would-merge` result names the head it would merge, so
    // the head12 of an unpersisted in-memory successor stays resolvable.
    return this.journalWould(request, entry, action, decision.shadowReason, detail,
      decision.action === 'merge-pr' ? entry.headOid : undefined);
  }

  /**
   * SH24a: the keyed dry-run journal for a shadow *mutation* outcome (drop,
   * park, supersede, ready, already-merged) and for the silent shadow
   * notification (`would-notify`). One `would-*` intent and one
   * `dry-run` result per `(pr, head12, action)` key, exactly like
   * `journalShadowAct`; nothing is written to the queue and nothing notifies.
   */
  private async journalShadowOutcome(
    request: RunMergePassRequest,
    entry: MergeQueueEntryRecord,
    action: MergeKeyAction,
    detail: string | null,
  ): Promise<MergePassEntryReport> {
    return this.journalWould(request, entry, action, action, detail);
  }

  /**
   * The one `would-*` journal helper every shadow path shares (SH24a fix
   * round): build the 5-segment key, honour the keyed idempotence (a result
   * present reports `already-journalled`; an open intent from a pass whose
   * budget ran out between the appends is completed, never re-intented), then
   * append the `dry-run` result. Nothing is written to the queue and nothing
   * notifies. `reasonCode` is both the result's reason and the report's; the
   * optional `linkedId` names the head a `would-merge` would merge.
   */
  private async journalWould(
    request: RunMergePassRequest,
    entry: MergeQueueEntryRecord,
    action: MergeKeyAction,
    reasonCode: string | null,
    detail: string | null,
    linkedId?: string | null,
  ): Promise<MergePassEntryReport> {
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
      return this.appendDryRunResult(request, entry, key, openIntent.runId, reasonCode, detail, linkedId);
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

    return this.appendDryRunResult(request, entry, key, entry.runId, reasonCode, detail, linkedId);
  }

  /**
   * The `dry-run` result record shared by `journalWould` (mutation outcomes
   * and shadow acts) and `closeOpenShadowIntents`: one append, guarded by
   * D-DT9, with the refused append mapped to its typed report. If the budget
   * is spent the intent stays open and the next pass completes it.
   */
  private async appendDryRunResult(
    request: RunMergePassRequest,
    entry: MergeQueueEntryRecord,
    key: string,
    runId: string | null,
    reasonCode: string | null,
    detail: string | null,
    linkedId?: string | null,
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
      reasonCode,
      detail,
      grantId: null,
      state: null,
      ...(linkedId !== undefined ? { linkedId } : {}),
    };
    // D-DT9: guard before the result append too.
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
    return this.report(entry, 'journalled', reasonCode, key);
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
    for (const action of [
      'merge-pr', 'update-branch', 'post-status', 'would-notify',
      'would-drop', 'would-park', 'would-supersede', 'would-ready', 'would-already-merged',
    ] as const) {
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
      // The key has no run in it: the result names the intent's own run.
      await this.appendDryRunResult(
        request,
        entry,
        built.key,
        openIntent.runId,
        'shadow-intent-closed',
        null,
      );
    }
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
          // Live mode must match main: forge `dirty` maps to UNKNOWN and the
          // decider waits. Only shadow mode keeps the DIRTY mapping.
          mergeStateStatus: shadowMergeStateStatus(
            MERGE_STATE_BY_TOKEN[read.mergeState] ?? 'UNKNOWN',
            request.policy.shadow === true,
          ),
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
    // blocks (D-JV1). In shadow mode with both veto ports bound (OG-16a) the
    // veto row is left undefined so the decider reads the stored record
    // (`null`) and asks for the advisory veto act; the veto step records it.
    const vetoMode = request.policy.veto.mode;
    const vetoAdvisory =
      vetoMode === 'shadow' &&
      this.deps.vetoAdvice !== undefined &&
      this.deps.vetoState !== undefined;
    const veto: MergeStepFacts['veto'] =
      entry.veto !== null || vetoMode === 'off' || vetoAdvisory
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
      ...observedBaseFact(read),
      // EV2: the merge-commit time the forge read observed (null when the
      // forge did not report one); only the shadow retro check reads it.
      ...('mergedAtIso' in read ? { mergedAtIso: read.mergedAtIso } : {}),
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
      // Only a fixed lowercase token is ever reported; anything else is withheld.
      reasonCode: reasonCode !== null && REASON_TOKEN_PATTERN.test(reasonCode) ? reasonCode : 'unspecified',
      journalKey,
    };
  }
}

type PersistResult =
  | { readonly status: 'skipped' }
  | { readonly status: 'written'; readonly record: MergeQueueEntryRecord }
  | { readonly status: 'failed'; readonly reasonCode: string };

/**
 * The head the poster's `premerge` status was read green at: set only when the
 * policy requires `premerge`, the status is `SUCCESS` and its creator is the
 * poster identity at the entry's exact head; anything else is unknown (null).
 */
function premergeReceiptHeadOf(
  request: RunMergePassRequest,
  entry: MergeQueueEntryRecord,
  facts: MergeStepFacts,
): string | null {
  const required = request.policy.requiredContexts ?? ['gate', 'premerge'];
  const poster = request.policy.premergePosterLogin;
  if (!required.includes('premerge') || typeof poster !== 'string' || poster.length === 0) {
    return null;
  }
  if (typeof facts.contexts !== 'object' || facts.contexts === null || !('premerge' in facts.contexts)) {
    return null;
  }
  const fact = (facts.contexts as Record<string, MergeContextFact>).premerge;
  return fact.state === 'success' && premergeLoginsMatch(fact.creatorLogin, poster) ? entry.headOid : null;
}

/** Thrown inward when a read answers `budget-exhausted`; never leaves the use case. */
class MergePassBudgetExhausted extends Error {
  constructor() {
    super('merge pass budget exhausted');
    this.name = 'MergePassBudgetExhausted';
  }
}
