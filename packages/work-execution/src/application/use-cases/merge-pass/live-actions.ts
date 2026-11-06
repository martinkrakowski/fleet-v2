// Lane DT9b — the merge pass's keyed live-action module.
/**
 * Performs exactly one merge-pass action for one already-decided merge-queue
 * entry (daemon-tick plan §3.3). It decides nothing: the entry and the grant
 * arrive as inputs. It journals an intent/result pair under the `merge/` key
 * family and reconciles an intent with no result by re-reading the forge once,
 * never acting twice. Pure orchestration over ports: no clock, no id minting,
 * no filesystem, no subprocess, no network, no console output.
 */

import type { ForgeRefusalKind } from '../../../domain/coordination-keys.js';
import { FORGE_REFUSAL_KINDS } from '../../../domain/coordination-keys.js';
import type {
  LaneRunJournalEntryRecord,
  LaneRunJournalOutcome,
  LaneRunJournalRefusal,
} from '../../../domain/lane-run-journal.js';
import {
  LANE_RUN_JOURNAL_ENTRY_VERSION,
  LANE_RUN_JOURNAL_REFUSALS,
  readLaneRunJournalEntry,
} from '../../../domain/lane-run-journal.js';
import type { MergeKeyRetryProof } from '../../../domain/lane-run-keys.js';
import { buildMergeKey, head12Of } from '../../../domain/lane-run-keys.js';
import type { MergeQueueEntryRecord, MergeShadowReason } from '../../../domain/merge-queue-records.js';
import {
  isMergeHex40,
  isMergeQueueEntryLive,
  readMergeQueueEntryRecord,
} from '../../../domain/merge-queue-records.js';
import type { LaneRunJournalPort } from '../../ports/out/LaneRunJournalPort.out-port.js';
import type {
  MergeForgeActionPort,
  MergeForgeActionRequest,
  MergeForgeActionResult,
} from '../../ports/out/MergeForgeActionPort.out-port.js';
import type { ForgeMergeReadPort, ReadForgeMergeResult } from '../../ports/out/ForgeMergeReadPort.out-port.js';

export type MergeLiveActionKind = 'merge-pr' | 'update-branch' | 'post-status';

const MERGE_LIVE_ACTION_KINDS: readonly MergeLiveActionKind[] = [
  'merge-pr',
  'update-branch',
  'post-status',
];

const SHADOW_REASON_BY_ACTION: Record<MergeLiveActionKind, MergeShadowReason> = {
  'merge-pr': 'would-merge',
  'update-branch': 'would-update-branch',
  'post-status': 'would-post-status',
};

/** The longest grant id or branch name accepted (a ref name is at most 255 bytes on the forge). */
const MAX_TOKEN_LENGTH = 255;

/** The merge-pass budget floor: a call with under 2 s left is not started (plan §3.1). */
const MIN_BUDGET_REMAINING_MS = 2000;

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    // C0, DEL and C1 (U+0080..U+009F) are all control characters.
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) {
      return true;
    }
  }
  return false;
}

export interface MergeLiveActionDependencies {
  readonly journal: LaneRunJournalPort;
  readonly forgeAction: MergeForgeActionPort;
  readonly forgeRead: ForgeMergeReadPort;
  /** Mints one ULID per journal entry id and per forge action id. Injected; never minted here. */
  readonly mintId: () => string;
}

export interface MergeLivePostStatus {
  readonly context: 'premerge';
  readonly state: 'success' | 'failure';
  readonly description: string;
}

/** The status type alias the integration barrel re-exports beside `MergeLivePostStatus`. */
export type MergeLiveActionPostStatus = MergeLivePostStatus;

export interface MergeLiveActionRequest {
  /** The decided entry (already read through `readMergeQueueEntryRecord` by the caller). */
  readonly entry: MergeQueueEntryRecord;
  readonly action: MergeLiveActionKind;
  readonly execution: 'live' | 'shadow';
  /** Required for `shadow` (the matching `MERGE_SHADOW_REASONS` value), null for `live`. */
  readonly shadowReason: MergeShadowReason | null;
  /** The 40-hex head the action is pinned to; always the entry's own head. */
  readonly expectedHeadOid: string;
  /** The pull request's head branch. */
  readonly branchName: string;
  /** The grant the action consumes. Required; no grant, no action. */
  readonly grantId: string;
  /** Required for `post-status`, null for the other two kinds. */
  readonly status: MergeLivePostStatus | null;
  readonly nowIso: string;
  readonly deadlineIso: string;
  /** Optional proof-gated retry ordinal (1..9); null for the base key. */
  readonly retry: { readonly ordinal: number; readonly proof: MergeKeyRetryProof } | null;
}

export type MergeLiveActionOutcome =
  | { readonly outcome: 'acted'; readonly journalKey: string; readonly actionId: string; readonly headSha: string }
  | { readonly outcome: 'dry-run'; readonly journalKey: string; readonly shadowReason: MergeShadowReason }
  | { readonly outcome: 'refused'; readonly journalKey: string; readonly refusalKind: ForgeRefusalKind; readonly reasonCode: string }
  | { readonly outcome: 'ambiguous'; readonly journalKey: string; readonly reasonCode: string }
  | { readonly outcome: 'reconciled'; readonly journalKey: string; readonly reconcile: 'merged' | 'absent' | 'head-moved' | 'closed' | 'status-present' }
  | {
      readonly outcome: 'skipped';
      readonly journalKey: string;
      readonly reasonCode: 'already-settled' | 'budget-exhausted' | 'intent-in-flight';
    }
  | { readonly outcome: 'invalid-request'; readonly reasonCode: string }
  | { readonly outcome: 'journal-refused'; readonly journalKey: string; readonly refusal: LaneRunJournalRefusal }
  /**
   * A port threw or answered outside its contract (the journal could not be
   * read or written, or the id minter failed). Nothing was acted on after the
   * failure: an unreadable journal or an unminted id stops before any forge
   * call; a result append that threw after the action leaves the intent for
   * the next call's reconcile.
   */
  | { readonly outcome: 'unavailable'; readonly journalKey: string; readonly reasonCode: 'journal-unavailable' | 'id-unavailable' };

/** The request after validation: a snapshot, so a later read never re-runs a caller's getter. */
interface ValidatedRequest {
  readonly entry: MergeQueueEntryRecord;
  readonly action: MergeLiveActionKind;
  readonly execution: 'live' | 'shadow';
  readonly shadowReason: MergeShadowReason | null;
  readonly expectedHeadOid: string;
  readonly branchName: string;
  readonly grantId: string;
  readonly status: MergeLivePostStatus | null;
  readonly nowIso: string;
  readonly deadlineIso: string;
  readonly nowMs: number;
  readonly deadlineMs: number;
  readonly key: string;
}

type Validation =
  | { readonly ok: true; readonly request: ValidatedRequest }
  | { readonly ok: false; readonly reasonCode: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isBoundedToken(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_TOKEN_LENGTH &&
    !hasControlCharacter(value)
  );
}

function isLiveActionKind(value: unknown): value is MergeLiveActionKind {
  return typeof value === 'string' && (MERGE_LIVE_ACTION_KINDS as readonly string[]).includes(value);
}

function readStatus(action: MergeLiveActionKind, input: unknown): MergeLivePostStatus | null | 'invalid' {
  if (action !== 'post-status') {
    return input === null ? null : 'invalid';
  }
  if (!isRecord(input)) {
    return 'invalid';
  }
  const { context, state, description } = input;
  if (context !== 'premerge' || (state !== 'success' && state !== 'failure')) {
    return 'invalid';
  }
  if (typeof description !== 'string' || description.length === 0) {
    return 'invalid';
  }
  return { context, state, description };
}

function readRetry(
  input: unknown,
): { readonly ordinal: unknown; readonly proof: MergeKeyRetryProof | null } | null | 'invalid' {
  if (input === null) {
    return null;
  }
  if (!isRecord(input)) {
    return 'invalid';
  }
  // Each field is read once: the ordinal that is checked is the ordinal that is keyed.
  const ordinal = input['ordinal'];
  const proof = input['proof'];
  if (ordinal === undefined || ordinal === null) {
    return 'invalid';
  }
  // The ordinal's range and the proof's shape are buildMergeKey's to refuse.
  return { ordinal, proof: (proof ?? null) as MergeKeyRetryProof | null };
}

function readExecution(
  action: MergeLiveActionKind,
  execution: unknown,
  shadowReason: unknown,
): { readonly execution: 'live' | 'shadow'; readonly shadowReason: MergeShadowReason | null } | null {
  if (execution === 'shadow' && shadowReason === SHADOW_REASON_BY_ACTION[action]) {
    return { execution, shadowReason: SHADOW_REASON_BY_ACTION[action] };
  }
  if (execution === 'live' && shadowReason === null) {
    return { execution, shadowReason: null };
  }
  return null;
}

function readTimes(
  nowIso: unknown,
  deadlineIso: unknown,
): { readonly nowIso: string; readonly deadlineIso: string; readonly nowMs: number; readonly deadlineMs: number } | null {
  if (typeof nowIso !== 'string' || typeof deadlineIso !== 'string') {
    return null;
  }
  const nowMs = Date.parse(nowIso);
  const deadlineMs = Date.parse(deadlineIso);
  if (!Number.isFinite(nowMs) || !Number.isFinite(deadlineMs) || deadlineMs <= nowMs) {
    return null;
  }
  return { nowIso, deadlineIso, nowMs, deadlineMs };
}

/** Step 2 — build the key (never by hand). A malformed retry is refused, never read as the base key. */
function buildKey(
  entry: MergeQueueEntryRecord,
  action: MergeLiveActionKind,
  expectedHeadOid: string,
  retryInput: unknown,
): string | null {
  const retry = readRetry(retryInput);
  const head12 = head12Of(expectedHeadOid);
  if (retry === 'invalid' || head12 === null) {
    return null;
  }
  const builtKey = buildMergeKey({
    repoDigest: entry.repoDigest,
    pullRequest: entry.pullRequest,
    head12,
    action,
    attemptOrdinal: null,
    retry: (retry?.ordinal ?? null) as number | null,
    retryProof: retry?.proof ?? null,
  });
  return builtKey.ok ? builtKey.key : null;
}

/** The entry, if it reads and is live; null otherwise (a merged/dropped/superseded entry never acts). */
function readLiveEntry(input: unknown): MergeQueueEntryRecord | null {
  const entryRead = readMergeQueueEntryRecord(input);
  return entryRead.ok && isMergeQueueEntryLive(entryRead.record) ? entryRead.record : null;
}

/** Step 1 and step 2: validate the request and build its key. Nothing is written; no port is called. */
function validateRequest(input: unknown): Validation {
  if (!isRecord(input)) {
    return { ok: false, reasonCode: 'invalid-request' };
  }
  const entry = readLiveEntry(input['entry']);
  if (entry === null) {
    return { ok: false, reasonCode: 'invalid-entry' };
  }
  const action = input['action'];
  if (!isLiveActionKind(action)) {
    return { ok: false, reasonCode: 'invalid-action' };
  }
  const mode = readExecution(action, input['execution'], input['shadowReason']);
  if (mode === null) {
    return { ok: false, reasonCode: 'invalid-execution' };
  }
  const expectedHeadOid = input['expectedHeadOid'];
  const headVerified = action !== 'merge-pr' || entry.verifiedHeadOid === entry.headOid;
  if (!isMergeHex40(expectedHeadOid) || expectedHeadOid !== entry.headOid || !headVerified) {
    return { ok: false, reasonCode: 'invalid-head' };
  }
  const branchName = input['branchName'];
  if (!isBoundedToken(branchName)) {
    return { ok: false, reasonCode: 'invalid-branch' };
  }
  const grantId = input['grantId'];
  // The brief asks only for a non-empty grant id; the journal validates what it stores.
  if (typeof grantId !== 'string' || grantId.length === 0) {
    return { ok: false, reasonCode: 'invalid-grant' };
  }
  const status = readStatus(action, input['status']);
  if (status === 'invalid') {
    return { ok: false, reasonCode: 'invalid-status' };
  }
  const times = readTimes(input['nowIso'], input['deadlineIso']);
  if (times === null) {
    return { ok: false, reasonCode: 'invalid-deadline' };
  }
  const key = buildKey(entry, action, expectedHeadOid, input['retry']);
  if (key === null) {
    return { ok: false, reasonCode: 'invalid-key' };
  }
  return {
    ok: true,
    request: { entry, action, ...mode, expectedHeadOid, branchName, grantId, status, ...times, key },
  };
}

function intentEntry(
  request: ValidatedRequest,
  entryId: string,
  mintedId: string | null,
): LaneRunJournalEntryRecord {
  return {
    version: LANE_RUN_JOURNAL_ENTRY_VERSION,
    entryId,
    kind: 'intent',
    key: request.key,
    runId: request.entry.runId,
    recordedAtIso: request.nowIso,
    mode: null,
    expectedRevision: null,
    mintedId,
    outcome: null,
    reasonCode: null,
    detail: null,
    grantId: null,
    state: null,
  };
}

function resultEntry(
  request: ValidatedRequest,
  entryId: string,
  outcome: LaneRunJournalOutcome,
  reasonCode: string | null,
  grantId: string | null,
): LaneRunJournalEntryRecord {
  return {
    version: LANE_RUN_JOURNAL_ENTRY_VERSION,
    entryId,
    kind: 'result',
    key: request.key,
    runId: request.entry.runId,
    recordedAtIso: request.nowIso,
    mode: null,
    expectedRevision: null,
    mintedId: null,
    outcome,
    reasonCode,
    detail: null,
    grantId,
    state: null,
  };
}

/**
 * Mints `count` distinct ids before anything is written; null when the minter throws, answers a
 * non-string or repeats an id (a repeated id would make the result unjournalable after the act).
 */
function mintIds(deps: MergeLiveActionDependencies, count: number): readonly string[] | null {
  const ids: string[] = [];
  try {
    for (let index = 0; index < count; index += 1) {
      const id: unknown = deps.mintId();
      if (typeof id !== 'string' || id.length === 0 || ids.includes(id)) {
        return null;
      }
      ids.push(id);
    }
  } catch {
    return null;
  }
  return ids;
}

const COMPARED_ENTRY_FIELDS = [
  'entryId', 'kind', 'key', 'runId', 'recordedAtIso', 'mode', 'expectedRevision', 'mintedId', 'outcome',
  'reasonCode', 'detail', 'grantId', 'state',
] as const;

/** Whether the journal's stored copy is the entry we submitted, field for field. */
function isSameEntry(stored: LaneRunJournalEntryRecord, submitted: LaneRunJournalEntryRecord): boolean {
  return COMPARED_ENTRY_FIELDS.every((field) => stored[field] === submitted[field]);
}

function isJournalRefusal(value: unknown): value is LaneRunJournalRefusal {
  return (LANE_RUN_JOURNAL_REFUSALS as readonly unknown[]).includes(value);
}

type AppendOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly refusal: LaneRunJournalRefusal }
  | { readonly ok: false; readonly refusal: null };

/** One journal append; a throw or an off-contract answer is `refusal: null` (journal unavailable). */
async function appendEntry(
  deps: MergeLiveActionDependencies,
  entry: LaneRunJournalEntryRecord,
): Promise<AppendOutcome> {
  try {
    const appended: unknown = await deps.journal.append(entry);
    const outcome = isRecord(appended) ? appended['outcome'] : null;
    if (isRecord(appended) && outcome === 'appended') {
      // Only an answer that carries back the very entry we submitted proves it is durable.
      const stored = readLaneRunJournalEntry(appended['entry']);
      return stored.ok && isSameEntry(stored.entry, entry) ? { ok: true } : { ok: false, refusal: null };
    }
    const reason = isRecord(appended) && outcome === 'refused' ? appended['reason'] : null;
    if (isJournalRefusal(reason)) {
      return { ok: false, refusal: reason };
    }
    return { ok: false, refusal: null };
  } catch {
    return { ok: false, refusal: null };
  }
}

function appendFailure(key: string, appended: AppendOutcome): MergeLiveActionOutcome | null {
  if (appended.ok) {
    return null;
  }
  return appended.refusal === null
    ? { outcome: 'unavailable', journalKey: key, reasonCode: 'journal-unavailable' }
    : { outcome: 'journal-refused', journalKey: key, refusal: appended.refusal };
}

/**
 * A key's entries as the journal's own rules allow them: exactly one intent first, then results, and
 * nothing after a final result. Any other sequence (a result with no intent, a second intent) cannot
 * say whether the key was acted on, so it is treated as an unreadable journal, never as an unused key.
 */
function isConsistentKeySequence(records: readonly LaneRunJournalEntryRecord[]): boolean {
  let settled = false;
  for (const [index, record] of records.entries()) {
    const expectedKind = index === 0 ? 'intent' : 'result';
    if (record.kind !== expectedKind || settled) {
      return false;
    }
    settled = record.kind === 'result' && record.outcome !== 'ambiguous';
  }
  return true;
}

/** The key's journal entries; null when the journal throws or answers outside its contract. */
async function listKey(
  deps: MergeLiveActionDependencies,
  key: string,
): Promise<readonly LaneRunJournalEntryRecord[] | null> {
  try {
    const entries: unknown = await deps.journal.listForKey(key);
    if (!Array.isArray(entries)) {
      return null;
    }
    // A record that does not read cannot prove the key unused: fail closed, never act on it.
    const records: LaneRunJournalEntryRecord[] = [];
    for (const item of entries as readonly unknown[]) {
      const read = readLaneRunJournalEntry(item);
      if (!read.ok || read.entry.key !== key) {
        return null;
      }
      records.push(read.entry);
    }
    return isConsistentKeySequence(records) ? records : null;
  } catch {
    return null;
  }
}

/** The reconcile read; a throw reads as `unavailable` (the outcome stays unknown, never guessed). */
async function readForge(
  deps: MergeLiveActionDependencies,
  request: ValidatedRequest,
): Promise<ReadForgeMergeResult> {
  let read: unknown;
  try {
    read = await deps.forgeRead.readForgeMerge({
      repository: request.entry.repository,
      pullRequestNumber: request.entry.pullRequest,
      headSha: request.expectedHeadOid,
      requiredContexts: ['premerge'],
      nowIso: request.nowIso,
      deadlineIso: request.deadlineIso,
    });
    // Validated and copied inside the guard: a hostile getter on the answer is an unknown read, never a
    // throw, and the copy is what the verdict reads, so a getter cannot answer differently the second time.
    const copy = copyRead(read);
    if (isWellFormedRead(copy)) {
      return snapshotRead(copy);
    }
  } catch {
    return { outcome: 'unavailable', code: 'unknown', reason: 'port threw' };
  }
  return { outcome: 'unavailable', code: 'unreadable', reason: 'off-contract answer' };
}

const FORGE_PR_STATES: readonly unknown[] = ['open', 'merged', 'closed'];
const FORGE_MERGE_STATES: readonly unknown[] = ['clean', 'behind', 'blocked', 'unknown'];

function isUnresolvedThreads(value: unknown): boolean {
  return value === 'unknown' || (Number.isSafeInteger(value) && (value as number) >= 0);
}
const FORGE_READ_NON_OK_OUTCOMES: readonly unknown[] = ['not-found', 'budget-exhausted', 'unavailable'];

/** Reads every field the verdict uses exactly once into a plain object; validation then judges the copy. */
function copyRead(read: unknown): unknown {
  if (!isRecord(read)) {
    return read;
  }
  const contexts = read['contexts'];
  return {
    outcome: read['outcome'],
    prState: read['prState'],
    liveHeadSha: read['liveHeadSha'],
    mergeState: read['mergeState'],
    unresolvedThreads: read['unresolvedThreads'],
    contexts: Array.isArray(contexts)
      ? Array.from(contexts as readonly unknown[], (context) =>
          isRecord(context)
            ? {
                name: context['name'],
                state: context['state'],
                isGreen: context['isGreen'],
                creatorLogin: context['creatorLogin'],
              }
            : context,
        )
      : contexts,
  };
}

function snapshotRead(read: ReadForgeMergeResult): ReadForgeMergeResult {
  if (read.outcome === 'ok') {
    return {
      outcome: 'ok',
      prState: read.prState,
      liveHeadSha: read.liveHeadSha,
      mergeState: read.mergeState,
      unresolvedThreads: read.unresolvedThreads,
      contexts: read.contexts.map((context) => ({
        name: context.name,
        state: context.state,
        isGreen: context.isGreen,
        creatorLogin: context.creatorLogin,
      })),
    };
  }
  if (read.outcome === 'unavailable') {
    return { outcome: 'unavailable', code: 'unknown', reason: 'forge unavailable' };
  }
  return read.outcome === 'not-found' ? { outcome: 'not-found' } : { outcome: 'budget-exhausted' };
}

/** An `ok` read must name a known PR state, a 40-hex live head and a context list; anything else is unknown. */
function isWellFormedRead(read: unknown): read is ReadForgeMergeResult {
  if (!isRecord(read)) {
    return false;
  }
  if (read['outcome'] !== 'ok') {
    return FORGE_READ_NON_OK_OUTCOMES.includes(read['outcome']);
  }
  return (
    FORGE_PR_STATES.includes(read['prState']) &&
    isMergeHex40(read['liveHeadSha']) &&
    FORGE_MERGE_STATES.includes(read['mergeState']) &&
    isUnresolvedThreads(read['unresolvedThreads']) &&
    Array.isArray(read['contexts']) &&
    (read['contexts'] as readonly unknown[]).every(isWellFormedContext)
  );
}

/** A context snapshot as the port declares it; a partial one cannot prove a status is present. */
function isWellFormedContext(context: unknown): boolean {
  return (
    isRecord(context) &&
    typeof context['name'] === 'string' &&
    typeof context['state'] === 'string' &&
    context['state'].length > 0 &&
    typeof context['isGreen'] === 'boolean' &&
    (context['creatorLogin'] === null || typeof context['creatorLogin'] === 'string')
  );
}

/** The one forge action; a throw or an off-contract answer is ambiguous (reconciled later, never retried blind). */
async function performForgeAction(
  deps: MergeLiveActionDependencies,
  forgeRequest: MergeForgeActionRequest,
): Promise<MergeForgeActionResult> {
  try {
    const result: unknown = await deps.forgeAction.performMergeForgeAction(forgeRequest);
    // Every field is read once and judged on that copy, so a getter cannot answer differently later.
    const outcome = isRecord(result) ? result['outcome'] : null;
    if (isRecord(result) && outcome === 'executed') {
      const headSha = result['headSha'];
      return isMergeHex40(headSha)
        ? { outcome: 'executed', headSha }
        : { outcome: 'ambiguous', reason: 'off-contract answer' };
    }
    if (isRecord(result) && outcome === 'refused') {
      const kind = result['refusalKind'];
      const rawReason = result['reason'];
      const refusalKind: ForgeRefusalKind = (FORGE_REFUSAL_KINDS as readonly unknown[]).includes(kind)
        ? (kind as ForgeRefusalKind)
        : 'other';
      return { outcome: 'refused', reason: typeof rawReason === 'string' ? rawReason : '', refusalKind };
    }
    return { outcome: 'ambiguous', reason: 'off-contract answer' };
  } catch {
    return { outcome: 'ambiguous', reason: 'port threw' };
  }
}

function forgeRequestOf(request: ValidatedRequest, actionId: string): MergeForgeActionRequest {
  const base = {
    actionId,
    repository: request.entry.repository,
    pullRequestNumber: request.entry.pullRequest,
    branchName: request.branchName,
    expectedHeadSha: request.expectedHeadOid,
    deadlineIso: request.deadlineIso,
  };
  if (request.action === 'post-status' && request.status !== null) {
    return { ...base, kind: 'post-status', status: request.status };
  }
  return request.action === 'merge-pr'
    ? { ...base, kind: 'merge-pr' }
    : { ...base, kind: 'update-branch' };
}

function reconcileVerdict(
  request: ValidatedRequest,
  read: ReadForgeMergeResult,
): { readonly journal: LaneRunJournalOutcome; readonly reasonCode: string; readonly returned: MergeLiveActionOutcome } {
  const key = request.key;
  const reconciled = (
    journal: LaneRunJournalOutcome,
    reconcile: 'merged' | 'absent' | 'head-moved' | 'closed' | 'status-present',
  ) => ({ journal, reasonCode: reconcile, returned: { outcome: 'reconciled', journalKey: key, reconcile } as const });
  if (read.outcome === 'not-found') {
    return reconciled('not-started', 'absent');
  }
  if (read.outcome !== 'ok') {
    return {
      journal: 'ambiguous',
      reasonCode: 'reconcile-unknown',
      returned: { outcome: 'ambiguous', journalKey: key, reasonCode: 'reconcile-unknown' },
    };
  }
  if (read.prState === 'merged') {
    return reconciled('reconciled', 'merged');
  }
  if (read.prState === 'closed') {
    return reconciled('reconciled', 'closed');
  }
  if (read.liveHeadSha !== request.expectedHeadOid) {
    return reconciled('overtaken', 'head-moved');
  }
  if (request.action === 'post-status') {
    const present = read.contexts.some((context) => context.name === 'premerge' && context.state !== 'missing');
    if (present) {
      return reconciled('reconciled', 'status-present');
    }
  }
  return reconciled('not-started', 'absent');
}

/**
 * Step 5 — reconcile an intent with no result (the crash path). Reads the forge
 * once and maps the read to exactly one journal result; never calls the forge.
 */
async function reconcile(
  deps: MergeLiveActionDependencies,
  request: ValidatedRequest,
): Promise<MergeLiveActionOutcome> {
  const ids = mintIds(deps, 1);
  if (ids === null) {
    return { outcome: 'unavailable', journalKey: request.key, reasonCode: 'id-unavailable' };
  }
  const read = await readForge(deps, request);
  const verdict = reconcileVerdict(request, read);
  const appended = await appendEntry(deps, resultEntry(request, ids[0] ?? '', verdict.journal, verdict.reasonCode, null));
  return appendFailure(request.key, appended) ?? verdict.returned;
}

/** Step 6, shadow: journal the intent and a dry-run result; the forge is not called. */
async function actShadow(
  deps: MergeLiveActionDependencies,
  request: ValidatedRequest,
  shadowReason: MergeShadowReason,
): Promise<MergeLiveActionOutcome> {
  const ids = mintIds(deps, 2);
  if (ids === null) {
    return { outcome: 'unavailable', journalKey: request.key, reasonCode: 'id-unavailable' };
  }
  const intentFailure = appendFailure(request.key, await appendEntry(deps, intentEntry(request, ids[0] ?? '', null)));
  if (intentFailure !== null) {
    return intentFailure;
  }
  const resultFailure = appendFailure(
    request.key,
    await appendEntry(deps, resultEntry(request, ids[1] ?? '', 'dry-run', shadowReason, null)),
  );
  return resultFailure ?? { outcome: 'dry-run', journalKey: request.key, shadowReason };
}

/**
 * Step 6, live: at most one forge call. Every id is minted before the intent,
 * the intent is journalled before the action, and a later crash is reconciled
 * instead of acting twice.
 */
async function actLive(
  deps: MergeLiveActionDependencies,
  request: ValidatedRequest,
): Promise<MergeLiveActionOutcome> {
  const key = request.key;
  const ids = mintIds(deps, 3);
  if (ids === null) {
    return { outcome: 'unavailable', journalKey: key, reasonCode: 'id-unavailable' };
  }
  const actionId = ids[0] ?? '';
  // The grant is the one field the result carries that the intent does not: a grant the journal cannot
  // record (over 256 bytes, blank, secret-shaped) is refused here, before the intent, never after the act.
  if (!readLaneRunJournalEntry(resultEntry(request, ids[2] ?? '', 'completed', null, request.grantId)).ok) {
    return { outcome: 'invalid-request', reasonCode: 'invalid-grant' };
  }
  const forgeRequest = forgeRequestOf(request, actionId);
  const intentFailure = appendFailure(key, await appendEntry(deps, intentEntry(request, ids[1] ?? '', actionId)));
  if (intentFailure !== null) {
    return intentFailure;
  }

  const forgeResult = await performForgeAction(deps, forgeRequest);

  let journalOutcome: LaneRunJournalOutcome;
  let reasonCode: string | null;
  let returned: MergeLiveActionOutcome;
  if (forgeResult.outcome === 'executed') {
    journalOutcome = 'completed';
    reasonCode = null;
    returned = { outcome: 'acted', journalKey: key, actionId, headSha: forgeResult.headSha };
  } else if (forgeResult.outcome === 'refused' && forgeResult.reason === 'budget-exhausted') {
    journalOutcome = 'not-started';
    reasonCode = 'budget-exhausted';
    returned = { outcome: 'skipped', journalKey: key, reasonCode: 'budget-exhausted' };
  } else if (forgeResult.outcome === 'refused') {
    journalOutcome = 'refused';
    reasonCode = forgeResult.refusalKind;
    returned = { outcome: 'refused', journalKey: key, refusalKind: forgeResult.refusalKind, reasonCode };
  } else {
    journalOutcome = 'ambiguous';
    reasonCode = 'forge-ambiguous';
    returned = { outcome: 'ambiguous', journalKey: key, reasonCode: 'forge-ambiguous' };
  }

  // A refused or failed result append leaves the intent with no final result: the next call reconciles it.
  const resultFailure = appendFailure(
    key,
    await appendEntry(deps, resultEntry(request, ids[2] ?? '', journalOutcome, reasonCode, request.grantId)),
  );
  return resultFailure ?? returned;
}

/**
 * Performs one keyed merge-pass action for one decided entry. Never throws:
 * malformed input is `invalid-request`, a failing port is a typed outcome.
 *
 * Concurrency precondition: the caller holds the repository's merge-pass lease
 * (scope `merge/<repoDigest>`, daemon-tick plan §3.2), so no two calls on one
 * key overlap across passes, and every forge call is bounded by `deadlineIso`.
 * The journal has no in-flight marker, so within a pass an intent recorded at
 * or after `nowIso` is treated as in flight and never reconciled.
 */
export async function performMergeLiveAction(
  deps: MergeLiveActionDependencies,
  request: MergeLiveActionRequest,
): Promise<MergeLiveActionOutcome> {
  let validation: Validation;
  try {
    validation = validateRequest(request);
  } catch {
    // A hostile getter or proxy on the request: refused, never thrown on.
    return { outcome: 'invalid-request', reasonCode: 'invalid-request' };
  }
  if (!validation.ok) {
    return { outcome: 'invalid-request', reasonCode: validation.reasonCode };
  }
  const valid = validation.request;

  // Step 3 — budget (plan §3.1): a call with under 2 s left is not started.
  if (valid.deadlineMs - valid.nowMs < MIN_BUDGET_REMAINING_MS) {
    return { outcome: 'skipped', journalKey: valid.key, reasonCode: 'budget-exhausted' };
  }

  // Step 4 — read the key's journal entries.
  const entries = await listKey(deps, valid.key);
  if (entries === null) {
    return { outcome: 'unavailable', journalKey: valid.key, reasonCode: 'journal-unavailable' };
  }
  const settled = entries.some((record) => record.kind === 'result' && record.outcome !== 'ambiguous');
  if (settled) {
    return { outcome: 'skipped', journalKey: valid.key, reasonCode: 'already-settled' };
  }
  const intent = entries.find((record) => record.kind === 'intent');
  if (intent !== undefined) {
    // Only an intent from an earlier pass can be a crash. One written at or after this call's
    // nowIso belongs to the current pass and may still be acting: reconciling it as absent could
    // settle the key while its action runs. Nothing is written and no port is called.
    const intentMs = Date.parse(intent.recordedAtIso);
    if (!Number.isFinite(intentMs) || intentMs >= valid.nowMs) {
      return { outcome: 'skipped', journalKey: valid.key, reasonCode: 'intent-in-flight' };
    }
    return reconcile(deps, valid);
  }
  return valid.shadowReason !== null ? actShadow(deps, valid, valid.shadowReason) : actLive(deps, valid);
}
