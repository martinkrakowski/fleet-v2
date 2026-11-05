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
import type {
  LaneRunJournalEntryRecord,
  LaneRunJournalOutcome,
  LaneRunJournalRefusal,
} from '../../../domain/lane-run-journal.js';
import { LANE_RUN_JOURNAL_ENTRY_VERSION } from '../../../domain/lane-run-journal.js';
import type { MergeKeyRetryProof } from '../../../domain/lane-run-keys.js';
import { buildMergeKey, head12Of } from '../../../domain/lane-run-keys.js';
import type { MergeQueueEntryRecord, MergeShadowReason } from '../../../domain/merge-queue-records.js';
import {
  isMergeHex40,
  isMergeQueueEntryLive,
  readMergeQueueEntryRecord,
} from '../../../domain/merge-queue-records.js';
import type { LaneRunJournalPort } from '../../ports/out/LaneRunJournalPort.out-port.js';
import type { MergeForgeActionPort, MergeForgeActionRequest } from '../../ports/out/MergeForgeActionPort.out-port.js';
import type { ForgeMergeReadPort } from '../../ports/out/ForgeMergeReadPort.out-port.js';

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

/** The merge-pass budget floor: a call with under 2 s left is not started (plan §3.1). */
const MIN_BUDGET_REMAINING_MS = 2000;

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) {
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
  | { readonly outcome: 'skipped'; readonly journalKey: string; readonly reasonCode: 'already-settled' | 'budget-exhausted' }
  | { readonly outcome: 'invalid-request'; readonly reasonCode: string }
  | { readonly outcome: 'journal-refused'; readonly journalKey: string; readonly refusal: LaneRunJournalRefusal };

function intentEntry(
  deps: MergeLiveActionDependencies,
  request: MergeLiveActionRequest,
  key: string,
  mintedId: string | null,
): LaneRunJournalEntryRecord {
  return {
    version: LANE_RUN_JOURNAL_ENTRY_VERSION,
    entryId: deps.mintId(),
    kind: 'intent',
    key,
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
  deps: MergeLiveActionDependencies,
  request: MergeLiveActionRequest,
  key: string,
  outcome: LaneRunJournalOutcome,
  reasonCode: string | null,
  grantId: string | null,
): LaneRunJournalEntryRecord {
  return {
    version: LANE_RUN_JOURNAL_ENTRY_VERSION,
    entryId: deps.mintId(),
    kind: 'result',
    key,
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

async function appendEntried(
  deps: MergeLiveActionDependencies,
  entry: LaneRunJournalEntryRecord,
): Promise<{ readonly ok: true } | { readonly ok: false; readonly refusal: LaneRunJournalRefusal }> {
  const appended = await deps.journal.append(entry);
  return appended.outcome === 'appended'
    ? { ok: true }
    : { ok: false, refusal: appended.reason };
}

/**
 * Step 5 — reconcile an intent with no result (the crash path). Reads the forge
 * once and maps the read to exactly one journal result; never calls the forge.
 */
async function reconcile(
  deps: MergeLiveActionDependencies,
  request: MergeLiveActionRequest,
  entry: MergeQueueEntryRecord,
  key: string,
): Promise<MergeLiveActionOutcome> {
  const read = await deps.forgeRead.readForgeMerge({
    repository: entry.repository,
    pullRequestNumber: entry.pullRequest,
    headSha: request.expectedHeadOid,
    requiredContexts: ['premerge'],
    nowIso: request.nowIso,
    deadlineIso: request.deadlineIso,
  });

  let journalOutcome: LaneRunJournalOutcome;
  let reasonCode: string;
  let returned: MergeLiveActionOutcome;

  if (read.outcome === 'ok' && read.prState === 'merged') {
    journalOutcome = 'reconciled';
    reasonCode = 'merged';
    returned = { outcome: 'reconciled', journalKey: key, reconcile: 'merged' };
  } else if (read.outcome === 'ok' && read.prState === 'closed') {
    journalOutcome = 'reconciled';
    reasonCode = 'closed';
    returned = { outcome: 'reconciled', journalKey: key, reconcile: 'closed' };
  } else if (read.outcome === 'ok' && read.liveHeadSha !== request.expectedHeadOid) {
    journalOutcome = 'overtaken';
    reasonCode = 'head-moved';
    returned = { outcome: 'reconciled', journalKey: key, reconcile: 'head-moved' };
  } else if (read.outcome === 'ok' && request.action === 'post-status') {
    const premerge = read.contexts.find((context) => context.name === 'premerge');
    if (premerge !== undefined && premerge.state !== 'missing') {
      journalOutcome = 'reconciled';
      reasonCode = 'status-present';
      returned = { outcome: 'reconciled', journalKey: key, reconcile: 'status-present' };
    } else {
      journalOutcome = 'not-started';
      reasonCode = 'absent';
      returned = { outcome: 'reconciled', journalKey: key, reconcile: 'absent' };
    }
  } else if (read.outcome === 'ok') {
    journalOutcome = 'not-started';
    reasonCode = 'absent';
    returned = { outcome: 'reconciled', journalKey: key, reconcile: 'absent' };
  } else if (read.outcome === 'not-found') {
    journalOutcome = 'not-started';
    reasonCode = 'absent';
    returned = { outcome: 'reconciled', journalKey: key, reconcile: 'absent' };
  } else {
    journalOutcome = 'ambiguous';
    reasonCode = 'reconcile-unknown';
    returned = { outcome: 'ambiguous', journalKey: key, reasonCode: 'reconcile-unknown' };
  }

  const appended = await appendEntried(deps, resultEntry(deps, request, key, journalOutcome, reasonCode, null));
  if (!appended.ok) {
    return { outcome: 'journal-refused', journalKey: key, refusal: appended.refusal };
  }
  return returned;
}

/**
 * Step 6 — act (at most one forge call per invocation). Shadow journals a
 * dry-run and never calls the forge; live journals the intent before the
 * action and reconciles any later crash instead of acting twice.
 */
async function act(
  deps: MergeLiveActionDependencies,
  request: MergeLiveActionRequest,
  entry: MergeQueueEntryRecord,
  key: string,
): Promise<MergeLiveActionOutcome> {
  if (request.execution === 'shadow') {
    const shadowReason = request.shadowReason;
    if (shadowReason === null) {
      return { outcome: 'invalid-request', reasonCode: 'invalid-execution' };
    }
    const intentAppended = await appendEntried(deps, intentEntry(deps, request, key, null));
    if (!intentAppended.ok) {
      return { outcome: 'journal-refused', journalKey: key, refusal: intentAppended.refusal };
    }
    const resultAppended = await appendEntried(
      deps,
      resultEntry(deps, request, key, 'dry-run', shadowReason, null),
    );
    if (!resultAppended.ok) {
      return { outcome: 'journal-refused', journalKey: key, refusal: resultAppended.refusal };
    }
    return { outcome: 'dry-run', journalKey: key, shadowReason };
  }

  const actionId = deps.mintId();
  const intentAppended = await appendEntried(deps, intentEntry(deps, request, key, actionId));
  if (!intentAppended.ok) {
    return { outcome: 'journal-refused', journalKey: key, refusal: intentAppended.refusal };
  }

  let forgeRequest: MergeForgeActionRequest;
  if (request.action === 'post-status') {
    const status = request.status;
    if (status === null) {
      return { outcome: 'invalid-request', reasonCode: 'invalid-status' };
    }
    forgeRequest = {
      actionId,
      repository: entry.repository,
      pullRequestNumber: entry.pullRequest,
      branchName: request.branchName,
      expectedHeadSha: request.expectedHeadOid,
      deadlineIso: request.deadlineIso,
      kind: 'post-status',
      status,
    };
  } else {
    forgeRequest = {
      actionId,
      repository: entry.repository,
      pullRequestNumber: entry.pullRequest,
      branchName: request.branchName,
      expectedHeadSha: request.expectedHeadOid,
      deadlineIso: request.deadlineIso,
      kind: request.action,
    };
  }

  const forgeResult = await deps.forgeAction.performMergeForgeAction(forgeRequest);

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
    returned = {
      outcome: 'refused',
      journalKey: key,
      refusalKind: forgeResult.refusalKind,
      reasonCode: forgeResult.refusalKind,
    };
  } else {
    journalOutcome = 'ambiguous';
    reasonCode = 'forge-ambiguous';
    returned = { outcome: 'ambiguous', journalKey: key, reasonCode: 'forge-ambiguous' };
  }

  const resultAppended = await appendEntried(
    deps,
    resultEntry(deps, request, key, journalOutcome, reasonCode, request.grantId),
  );
  if (!resultAppended.ok) {
    return { outcome: 'journal-refused', journalKey: key, refusal: resultAppended.refusal };
  }
  return returned;
}

export async function performMergeLiveAction(
  deps: MergeLiveActionDependencies,
  request: MergeLiveActionRequest,
): Promise<MergeLiveActionOutcome> {
  // Step 1 — validate; nothing is written and the forge is not called.
  const entryRead = readMergeQueueEntryRecord(request.entry);
  if (!entryRead.ok) {
    return { outcome: 'invalid-request', reasonCode: 'invalid-entry' };
  }
  const entry = entryRead.record;
  if (!isMergeQueueEntryLive(entry)) {
    return { outcome: 'invalid-request', reasonCode: 'invalid-entry' };
  }
  if (!MERGE_LIVE_ACTION_KINDS.includes(request.action)) {
    return { outcome: 'invalid-request', reasonCode: 'invalid-action' };
  }
  if (request.execution === 'shadow') {
    if (request.shadowReason !== SHADOW_REASON_BY_ACTION[request.action]) {
      return { outcome: 'invalid-request', reasonCode: 'invalid-execution' };
    }
  } else if (request.shadowReason !== null) {
    return { outcome: 'invalid-request', reasonCode: 'invalid-execution' };
  }
  if (!isMergeHex40(request.expectedHeadOid) || request.expectedHeadOid !== entry.headOid) {
    return { outcome: 'invalid-request', reasonCode: 'invalid-head' };
  }
  if (request.action === 'merge-pr' && entry.verifiedHeadOid !== entry.headOid) {
    return { outcome: 'invalid-request', reasonCode: 'invalid-head' };
  }
  if (
    typeof request.branchName !== 'string' ||
    request.branchName.length === 0 ||
    request.branchName.length > 255 ||
    hasControlCharacter(request.branchName)
  ) {
    return { outcome: 'invalid-request', reasonCode: 'invalid-branch' };
  }
  if (typeof request.grantId !== 'string' || request.grantId.length === 0) {
    return { outcome: 'invalid-request', reasonCode: 'invalid-grant' };
  }
  if (request.action === 'post-status') {
    const status = request.status;
    if (status === null || status.context !== 'premerge' || status.description.length === 0) {
      return { outcome: 'invalid-request', reasonCode: 'invalid-status' };
    }
    if (status.state !== 'success' && status.state !== 'failure') {
      return { outcome: 'invalid-request', reasonCode: 'invalid-status' };
    }
  } else if (request.status !== null) {
    return { outcome: 'invalid-request', reasonCode: 'invalid-status' };
  }
  const nowMs = Date.parse(request.nowIso);
  const deadlineMs = Date.parse(request.deadlineIso);
  if (Number.isNaN(nowMs) || Number.isNaN(deadlineMs) || deadlineMs <= nowMs) {
    return { outcome: 'invalid-request', reasonCode: 'invalid-deadline' };
  }

  // Step 2 — build the key (never by hand).
  const head12 = head12Of(request.expectedHeadOid);
  if (head12 === null) {
    return { outcome: 'invalid-request', reasonCode: 'invalid-key' };
  }
  const builtKey = buildMergeKey({
    repoDigest: entry.repoDigest,
    pullRequest: entry.pullRequest,
    head12,
    action: request.action,
    attemptOrdinal: null,
    retry: request.retry?.ordinal ?? null,
    retryProof: request.retry?.proof ?? null,
  });
  if (!builtKey.ok) {
    return { outcome: 'invalid-request', reasonCode: 'invalid-key' };
  }
  const key = builtKey.key;

  // Step 3 — budget (plan §3.1): a call with under 2 s left is not started.
  if (deadlineMs - nowMs < MIN_BUDGET_REMAINING_MS) {
    return { outcome: 'skipped', journalKey: key, reasonCode: 'budget-exhausted' };
  }

  // Step 4 — read the key's journal entries.
  const entries = await deps.journal.listForKey(key);
  let final: LaneRunJournalEntryRecord | null = null;
  let intent: LaneRunJournalEntryRecord | null = null;
  for (const entryRecord of entries) {
    if (final === null && entryRecord.kind === 'result' && entryRecord.outcome !== 'ambiguous') {
      final = entryRecord;
    }
    if (intent === null && entryRecord.kind === 'intent') {
      intent = entryRecord;
    }
  }
  if (final !== null) {
    return { outcome: 'skipped', journalKey: key, reasonCode: 'already-settled' };
  }
  if (intent !== null) {
    return reconcile(deps, request, entry, key);
  }
  return act(deps, request, entry, key);
}
