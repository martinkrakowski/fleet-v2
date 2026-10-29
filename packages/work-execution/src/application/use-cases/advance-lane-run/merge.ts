/** The conductor's acceptance, PR, push and merge acts and facts (K6). */

import type { AdvanceLaneRunRequest, AdvanceLaneRunResult } from '../../ports/in/AdvanceLaneRunPort.in-port.js';
import type { CiStatePort } from '../../ports/out/CiStatePort.out-port.js';
import type { ForgeReadPort, PullRequestRef } from '../../ports/out/ForgeReadPort.out-port.js';
import type { ReviewRequestPort } from '../../ports/out/ReviewRequestPort.out-port.js';
import type { AttemptRecord } from '../../../domain/execution-records.js';
import type { LaneRunJournalEntryRecord } from '../../../domain/lane-run-journal.js';
import { head12Of, parseLaneRunKey } from '../../../domain/lane-run-keys.js';
import type { LaneRunRecord } from '../../../domain/lane-run-records.js';
import type { LaneRunDecision } from '../../../domain/lane-run-decider.js';
import type { LaneRunResultReasonCode } from '../../../domain/lane-run-step-facts.js';
import type { LaneRunStateValue } from '../../../domain/value-objects/LaneRunState.vo.js';
import type { AdvanceStepContext, GatheredLaneRunFacts } from './step-context.js';
import { appendRunIntent, appendRunResult } from './step-context.js';

type ActDecision = Extract<LaneRunDecision, { kind: 'act' }>;
type ReconcileDecision = Extract<LaneRunDecision, { kind: 'reconcile' }>;

/** The states where the read-only facts are read from the ports (K6-5): after acceptance, before the merge. */
const FACT_READ_STATES: readonly LaneRunStateValue[] = [
  'awaiting-premerge', 'opening-pr', 'pushing', 'watching-ci', 'merging',
];

/** The acceptance and read-only PR/CI facts one advance gathers (K6-5). */
export interface AcceptanceFacts {
  readonly acceptance: 'none' | 'accepted' | 'rejected' | 'unknown';
  readonly acceptedHead12: string | null;
  readonly preMerge: 'none' | 'passed' | 'failed' | 'unknown';
  readonly ci: 'pending' | 'passed' | 'failed' | 'unknown';
  readonly pr: { readonly state: 'open' | 'merged' | 'closed'; readonly head12: string } | null;
}

/** The key's final (non-ambiguous) result, or null when it has none. */
function finalResultOfKey(
  entries: readonly LaneRunJournalEntryRecord[],
  key: string,
): LaneRunJournalEntryRecord | null {
  for (const entry of entries) {
    if (entry.kind === 'result' && entry.key === key && entry.outcome !== 'ambiguous') {
      return entry;
    }
  }
  return null;
}

/**
 * The acceptance fact at `head12`: the latest final result of an `accept`
 * step key at the head (`accepted` → accepted, `acceptance-rejected` →
 * rejected, any other final or an intent without a final → unknown); none
 * without one, and none at a missing head.
 */
function acceptanceOf(
  entries: readonly LaneRunJournalEntryRecord[],
  runId: string,
  head12: string | null,
): AcceptanceFacts['acceptance'] {
  if (head12 === null) {
    return 'none';
  }
  let sawIntent = false;
  let latestFinal: LaneRunResultReasonCode | null = null;
  for (const entry of entries) {
    if (entry.kind !== 'intent' || entry.runId !== runId || entry.key === null) {
      continue;
    }
    const parsed = parseLaneRunKey(entry.key);
    if (parsed === null || parsed.kind !== 'step' || parsed.step !== 'accept' || parsed.head12 !== head12) {
      continue;
    }
    sawIntent = true;
    const final = finalResultOfKey(entries, entry.key);
    if (final !== null) {
      latestFinal = (final.reasonCode ?? null) as LaneRunResultReasonCode | null;
    }
  }
  if (latestFinal === null) {
    return sawIntent ? 'unknown' : 'none';
  }
  if (latestFinal === 'accepted') {
    return 'accepted';
  }
  return latestFinal === 'acceptance-rejected' ? 'rejected' : 'unknown';
}

/** The head12 of the LATEST `accepted` accept result's key over all heads; null without one. */
function acceptedHead12Of(
  entries: readonly LaneRunJournalEntryRecord[],
  runId: string,
): string | null {
  let accepted: string | null = null;
  for (const entry of entries) {
    if (
      entry.kind !== 'result' ||
      entry.runId !== runId ||
      entry.key === null ||
      entry.outcome === 'ambiguous' ||
      entry.reasonCode !== 'accepted'
    ) {
      continue;
    }
    const parsed = parseLaneRunKey(entry.key);
    if (parsed === null || parsed.kind !== 'step' || parsed.step !== 'accept') {
      continue;
    }
    accepted = parsed.head12;
  }
  return accepted;
}

/**
 * No branch name is recorded on the run, so the PR is read by number when
 * `record.prNumber` is set, else by branch — the branch name being the last
 * path segment of the latest attempt's worktreePath (the same decision K5-5
 * takes).
 */
function pullRequestRefOf(record: LaneRunRecord, latest: AttemptRecord): PullRequestRef {
  if (record.prNumber !== null) {
    return { kind: 'number', number: record.prNumber };
  }
  const segments = latest.worktreePath.split('/');
  return { kind: 'branch', branchName: segments[segments.length - 1] };
}

/** The pre-merge receipt fact (D3): the receipt's verdict; unreadable → unknown, absent → none. */
async function preMergeFactOf(
  port: ReviewRequestPort,
  attemptId: string,
  headSha: string,
): Promise<AcceptanceFacts['preMerge']> {
  try {
    const read = await port.findLatestReceiptOfKind({ attemptId, candidateHeadSha: headSha, kind: 'pre-merge' });
    if (read.outcome === 'found') {
      return read.receipt.verdict === 'passed' ? 'passed' : read.receipt.verdict === 'failed' ? 'failed' : 'unknown';
    }
    return read.outcome === 'not-found' ? 'none' : 'unknown';
  } catch {
    return 'unknown';
  }
}

/** The CI fact at the exact head: the state passes through only when the answer names the asked head. */
async function ciFactOf(
  port: CiStatePort,
  headSha: string,
): Promise<AcceptanceFacts['ci']> {
  try {
    const read = await port.readHeadCiState({ headSha });
    return read.headSha === headSha ? read.state : 'unknown';
  } catch {
    return 'unknown';
  }
}

/** The PR fact: the snapshot's state and head; anything but a found snapshot reads null. */
async function prFactOf(
  port: ForgeReadPort,
  record: LaneRunRecord,
  latest: AttemptRecord,
): Promise<AcceptanceFacts['pr']> {
  try {
    const read = await port.readPullRequest({ ref: pullRequestRefOf(record, latest) });
    if (read.outcome !== 'found') {
      return null;
    }
    const head12 = head12Of(read.pullRequest.headSha);
    return head12 === null ? null : { state: read.pullRequest.state, head12 };
  } catch {
    return null;
  }
}

/**
 * The acceptance and read-only facts of one advance (K6-5). The acceptance
 * journal facts are read always; the three port reads run only past
 * acceptance — a state inside the PR/CI window, a collected head to read at,
 * a bound port, and never while halted — otherwise the hard-coded defaults
 * stand (`preMerge: 'none'`, `ci: 'unknown'`, `pr: null`).
 */
export async function acceptanceFactsOf(
  ctx: AdvanceStepContext,
  record: LaneRunRecord,
  state: LaneRunStateValue,
  entries: readonly LaneRunJournalEntryRecord[],
  latest: AttemptRecord | null,
  head12: string | null,
  halted: boolean,
): Promise<AcceptanceFacts> {
  const acceptance = acceptanceOf(entries, record.runId, head12);
  const acceptedHead12 = acceptedHead12Of(entries, record.runId);
  let preMerge: AcceptanceFacts['preMerge'] = 'none';
  let ci: AcceptanceFacts['ci'] = 'unknown';
  let pr: AcceptanceFacts['pr'] = null;
  const canRead = !halted && latest !== null && latest.artifacts !== null && FACT_READ_STATES.includes(state);
  if (canRead) {
    const headSha = latest.artifacts.headCommit;
    if (ctx.deps.reviewRequest !== undefined) {
      preMerge = await preMergeFactOf(ctx.deps.reviewRequest, latest.id, headSha);
    }
    if (ctx.deps.ciState !== undefined) {
      ci = await ciFactOf(ctx.deps.ciState, headSha);
    }
    if (ctx.deps.forgeRead !== undefined) {
      pr = await prFactOf(ctx.deps.forgeRead, record, latest);
    }
  }
  return { acceptance, acceptedHead12, preMerge, ci, pr };
}

/** The accept body after its intent (K6-5): one assessment at the exact head, mapped by reason code only. */
async function runAcceptBody(
  ctx: AdvanceStepContext,
  record: LaneRunRecord,
  gathered: GatheredLaneRunFacts,
  decision: ActDecision | ReconcileDecision,
  request: AdvanceLaneRunRequest,
  key: string,
): Promise<AdvanceLaneRunResult> {
  const assessment = ctx.deps.acceptanceAssessment;
  if (assessment === undefined) {
    return { outcome: 'not-wired', step: decision.step };
  }
  const latest = gathered.latestAttempt;
  if (latest === null || latest.artifacts === null) {
    return { outcome: 'waiting', reason: 'facts-inconsistent' };
  }
  const headSha = latest.artifacts.headCommit;
  let result: 'completed' | 'ambiguous';
  let reasonCode: LaneRunResultReasonCode;
  try {
    const outcome = await assessment.assessHeadAcceptance({
      attemptId: latest.id,
      workOrderId: record.workOrderId,
      candidateHeadSha: headSha,
      policyRevision: record.runPolicyRevision,
    });
    if (outcome.outcome === 'accepted') {
      if (outcome.assessedHeadSha === headSha) {
        result = 'completed';
        reasonCode = 'accepted';
      } else {
        result = 'ambiguous';
        reasonCode = 'acceptance-unknown';
      }
    } else if (outcome.outcome === 'rejected') {
      result = 'completed';
      reasonCode = 'acceptance-rejected';
    } else {
      result = 'ambiguous';
      reasonCode = 'acceptance-unknown';
    }
  } catch {
    result = 'ambiguous';
    reasonCode = 'acceptance-unknown';
  }
  const resultRefusal = await appendRunResult(ctx, request, key, result, reasonCode);
  if (resultRefusal !== null) {
    return { outcome: 'refused', reason: resultRefusal };
  }
  return { outcome: 'acted', step: decision.step, key, result, reasonCode };
}

/**
 * The `act accept` step (K6-5): assess the collected head through
 * `AcceptanceAssessmentPort` under the keyed intent. Only reason codes are
 * journalled — the receipt id is not (acceptance is idempotent per head; the
 * merge reads it again through AM4a), never a reason or blocker text. A
 * thrown or `unknown` assessment stays ambiguous for the reconcile.
 */
export async function performAccept(
  ctx: AdvanceStepContext,
  record: LaneRunRecord,
  gathered: GatheredLaneRunFacts,
  decision: ActDecision,
  request: AdvanceLaneRunRequest,
): Promise<AdvanceLaneRunResult> {
  const preCheck = acceptPreCheck(ctx, gathered, decision);
  if (preCheck !== null) {
    return preCheck;
  }
  const intentRefusal = await appendRunIntent(ctx, request, decision.key, null);
  if (intentRefusal !== null) {
    return { outcome: 'refused', reason: intentRefusal };
  }
  return runAcceptBody(ctx, record, gathered, decision, request, decision.key);
}

/** The accept's pre-checks before its intent (K6-5): the wiring and the collected head. */
function acceptPreCheck(
  ctx: AdvanceStepContext,
  gathered: GatheredLaneRunFacts,
  decision: ActDecision | ReconcileDecision,
): AdvanceLaneRunResult | null {
  if (ctx.deps.acceptanceAssessment === undefined) {
    return { outcome: 'not-wired', step: decision.step };
  }
  const latest = gathered.latestAttempt;
  if (latest === null || latest.artifacts === null) {
    return { outcome: 'waiting', reason: 'facts-inconsistent' };
  }
  return null;
}

/**
 * The accept reconcile (K6-5): acceptance is not one-way, so the reconcile
 * re-runs the assessment body under the pending key — no second intent, the
 * result appended under `decision.key`.
 */
export async function reconcileAccept(
  ctx: AdvanceStepContext,
  record: LaneRunRecord,
  gathered: GatheredLaneRunFacts,
  decision: ReconcileDecision,
  request: AdvanceLaneRunRequest,
): Promise<AdvanceLaneRunResult> {
  const preCheck = acceptPreCheck(ctx, gathered, decision);
  if (preCheck !== null) {
    return preCheck;
  }
  return runAcceptBody(ctx, record, gathered, decision, request, decision.key);
}
