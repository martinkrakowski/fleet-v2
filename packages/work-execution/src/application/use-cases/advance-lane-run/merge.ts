/** The conductor's acceptance, PR, push and merge acts and facts (K6). */

import type { AdvanceLaneRunRequest, AdvanceLaneRunResult } from '../../ports/in/AdvanceLaneRunPort.in-port.js';
import type { ExecuteAuthorizedForgeActionResult, ExecuteAuthorizedForgeActionRequest } from '../../ports/in/ExecuteAuthorizedForgeActionPort.in-port.js';
import type { CiStatePort } from '../../ports/out/CiStatePort.out-port.js';
import type { ConductorForgeGrantResult } from '../../ports/out/ConductorForgeGrantPort.out-port.js';
import type { ForgeReadPort, PullRequestMergeState, PullRequestRef, ReadPullRequestResult } from '../../ports/out/ForgeReadPort.out-port.js';
import type { ForgeAncestryPort } from '../../ports/out/ForgeAncestryPort.out-port.js';
import type { ReviewRequestPort } from '../../ports/out/ReviewRequestPort.out-port.js';
import type { AttemptRecord, WorkOrderRecord } from '../../../domain/execution-records.js';
import { laneRunJournalState } from '../../../domain/lane-run-journal.js';
import type { LaneRunJournalEntryRecord, LaneRunJournalOutcome } from '../../../domain/lane-run-journal.js';
import { resolveLaneRunBaseBranch } from '../../../domain/base-branch.js';
import { head12Of, parseLaneRunKey } from '../../../domain/lane-run-keys.js';
import type { LaneRunPrBodyFrozen, RenderPrBodyResult } from '../../../domain/lane-run-pr-body.js';
import { renderPrBody } from '../../../domain/lane-run-pr-body.js';
import type { LaneRunRecord } from '../../../domain/lane-run-records.js';
import type { LaneRunDecision } from '../../../domain/lane-run-decider.js';
import type { LaneRunResultReasonCode } from '../../../domain/lane-run-step-facts.js';
import type { LaneRunStateValue } from '../../../domain/value-objects/LaneRunState.vo.js';
import type { AdvanceStepContext, GatheredLaneRunFacts } from './step-context.js';
import { appendRunIntent, appendRunResult, performPark, saveOrRefuse } from './step-context.js';
import { readVerifiedFrozenManifest } from './frozen-manifest.js';

type ActDecision = Extract<LaneRunDecision, { kind: 'act' }>;
type ReconcileDecision = Extract<LaneRunDecision, { kind: 'reconcile' }>;

/** The states where the read-only facts are read from the ports (K6-5): after acceptance, before the merge. */
const FACT_READ_STATES: readonly LaneRunStateValue[] = [
  'awaiting-premerge', 'opening-pr', 'pushing', 'watching-ci', 'merging',
];

/** The merge facts the decider reads in `merging` (K6-7). */
export interface MergeFacts {
  readonly oneWayDoor: boolean;
  readonly branchBehind: boolean;
  readonly trainFree: boolean;
  readonly policyGrant: boolean;
}

/** The acceptance and read-only PR/CI/merge facts one advance gathers (K6-5/7). */
export interface AcceptanceFacts {
  readonly acceptance: 'none' | 'accepted' | 'rejected' | 'unknown';
  readonly acceptedHead12: string | null;
  /** KF-23: the accept retry ordinal at `head12`, or null when no retry is due. */
  readonly acceptanceRetry: number | null;
  readonly preMerge: 'none' | 'passed' | 'failed' | 'unknown';
  readonly ci: 'pending' | 'passed' | 'failed' | 'unknown';
  readonly pr: { readonly state: 'open' | 'merged' | 'closed'; readonly head12: string; readonly containsLaneHead: boolean } | null;
  readonly merge: MergeFacts;
}

/** The PR read kept for the merge facts: the decider's `pr` plus the snapshot's merge state. */
interface PrReadResult {
  readonly pr: AcceptanceFacts['pr'];
  readonly mergeState: PullRequestMergeState | null;
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
 * A spent one-way key never loops: the decider re-acting on it parks
 * `step-refused <step>` for the owner. An unread intent would have been routed
 * to the reconcile by the decider's G3a, so an intent here has a final result.
 */
export async function parkSpentOneWayKey(
  ctx: AdvanceStepContext,
  record: LaneRunRecord,
  gathered: GatheredLaneRunFacts,
  decision: ActDecision,
  request: AdvanceLaneRunRequest,
): Promise<AdvanceLaneRunResult | null> {
  const entries = await ctx.deps.runJournal.listForKey(decision.key);
  if (!entries.some((entry) => entry.kind === 'intent')) {
    return null;
  }
  return performPark(ctx, record, 'step-refused', decision.step, gathered.facts.state, request);
}

/**
 * The acceptance fact at `head12`: the latest accept intent at the head decides
 * (`accepted` → accepted, `acceptance-rejected` → rejected, any other final or
 * an intent without a final → unknown); none without one, and none at a missing
 * head. An earlier intent's final never overrides a later intent (KF-23).
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
  let latestIntentKey: string | null = null;
  for (const entry of entries) {
    if (entry.kind !== 'intent' || entry.runId !== runId || entry.key === null) {
      continue;
    }
    const parsed = parseLaneRunKey(entry.key);
    if (parsed === null || parsed.kind !== 'step' || parsed.step !== 'accept' || parsed.head12 !== head12) {
      continue;
    }
    sawIntent = true;
    latestIntentKey = entry.key;
  }
  if (latestIntentKey === null) {
    return sawIntent ? 'unknown' : 'none';
  }
  const final = finalResultOfKey(entries, latestIntentKey);
  if (final === null) {
    return 'unknown';
  }
  if (final.reasonCode === 'accepted') {
    return 'accepted';
  }
  return final.reasonCode === 'acceptance-rejected' ? 'rejected' : 'unknown';
}

/**
 * The accept retry ordinal at `head12` (KF-23): non-null only when the latest
 * accept result at the head is `acceptance-rejected` AND a `parked` conduct
 * entry comes after that result in the run journal (the run has since been
 * resumed back to `accepting`); its value is the number of accept intents
 * already journalled at this head (1 → retry 1, …).
 */
function acceptanceRetryOf(
  entries: readonly LaneRunJournalEntryRecord[],
  runId: string,
  head12: string | null,
): number | null {
  if (head12 === null) {
    return null;
  }
  let latestIntentKey: string | null = null;
  let acceptIntentsAtHead = 0;
  for (const entry of entries) {
    if (entry.kind !== 'intent' || entry.runId !== runId || entry.key === null) {
      continue;
    }
    const parsed = parseLaneRunKey(entry.key);
    if (parsed === null || parsed.kind !== 'step' || parsed.step !== 'accept' || parsed.head12 !== head12) {
      continue;
    }
    acceptIntentsAtHead += 1;
    latestIntentKey = entry.key;
  }
  if (latestIntentKey === null) {
    return null;
  }
  const final = finalResultOfKey(entries, latestIntentKey);
  if (final === null || final.reasonCode !== 'acceptance-rejected') {
    return null;
  }
  const resultIndex = entries.indexOf(final);
  if (resultIndex === -1) {
    return null;
  }
  for (let index = resultIndex + 1; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry.kind === 'conduct' && entry.runId === runId && entry.state === 'parked') {
      return acceptIntentsAtHead;
    }
  }
  return null;
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
 * The PR is read by number when `record.prNumber` is set, else by the run's
 * recorded branch (`record.branchName`, KF-5b); old records without the field
 * fall back to the last path segment of the latest attempt's worktreePath
 * (the same decision K5-5 takes).
 */
function pullRequestRefOf(record: LaneRunRecord, latest: AttemptRecord): PullRequestRef {
  if (record.prNumber !== null) {
    return { kind: 'number', number: record.prNumber };
  }
  if (record.branchName !== undefined) {
    return { kind: 'branch', branchName: record.branchName };
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

/**
 * The ancestry answer as a boolean (CT-2b): only an `answered` true is true;
 * unavailable or a throwing port is false, and the PR snapshot is kept so the
 * decider parks `ambiguous merge` rather than waiting on inconsistent facts.
 */
async function containsLaneHeadOf(ancestry: ForgeAncestryPort, ancestorSha: string, descendantSha: string): Promise<boolean> {
  try {
    const answer = await ancestry.containsCommit({ ancestorSha, descendantSha });
    return answer.outcome === 'answered' && answer.contains;
  } catch {
    return false;
  }
}

/** The PR read: the snapshot's state and head plus its merge state; anything but a found snapshot reads null. */
async function prFactOf(
  port: ForgeReadPort,
  record: LaneRunRecord,
  latest: AttemptRecord,
  laneHead12: string | null,
  laneHeadSha: string | null,
  ancestry: ForgeAncestryPort | undefined,
): Promise<PrReadResult> {
  try {
    const read = await port.readPullRequest({ ref: pullRequestRefOf(record, latest) });
    if (read.outcome !== 'found') {
      return { pr: null, mergeState: null };
    }
    const head12 = head12Of(read.pullRequest.headSha);
    if (head12 === null) {
      return { pr: null, mergeState: null };
    }
    let containsLaneHead = head12 === laneHead12;
    if (!containsLaneHead && read.pullRequest.state === 'merged' && ancestry !== undefined && laneHeadSha !== null) {
      // CT-2b: a merged PR's head is rarely the lane's collected head (the
      // merge train adds a merge commit), so ancestry answers it from the
      // forge. No answer is false: the run parks ambiguous merge or stays
      // parked for the owner; it never enters merged on a guess.
      containsLaneHead = await containsLaneHeadOf(ancestry, laneHeadSha, read.pullRequest.headSha);
    }
    return {
      pr: { state: read.pullRequest.state, head12, containsLaneHead },
      mergeState: read.pullRequest.mergeState,
    };
  } catch {
    return { pr: null, mergeState: null };
  }
}

/**
 * The acceptance, read-only PR/CI facts of one advance (K6-5) and the merge
 * facts (K6-7). The acceptance journal facts are read always; the port reads
 * run only past acceptance — a state inside the PR/CI window, a collected head
 * to read at, a bound port, and never while halted — otherwise the hard-coded
 * defaults stand (`preMerge: 'none'`, `ci: 'unknown'`, `pr: null`). The PR is
 * read once; its snapshot's merge state feeds the merge facts.
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
  const acceptanceRetry = acceptanceRetryOf(entries, record.runId, head12);
  const acceptedHead12 = acceptedHead12Of(entries, record.runId);
  let preMerge: AcceptanceFacts['preMerge'] = 'none';
  let ci: AcceptanceFacts['ci'] = 'unknown';
  let pr: AcceptanceFacts['pr'] = null;
  let mergeState: PullRequestMergeState | null = null;
  const canRead = !halted && latest !== null && latest.artifacts !== null && FACT_READ_STATES.includes(state);
  if (canRead) {
    const headSha = latest.artifacts.headCommit;
    if (ctx.deps.reviewRequest !== undefined) {
      preMerge = await preMergeFactOf(ctx.deps.reviewRequest, latest.id, headSha);
    }
    if (ctx.deps.ciState !== undefined) {
      ci = await ciFactOf(ctx.deps.ciState, headSha);
    }
  }
  // CT-2a: an owner-merge park reads the PR so G5 can leave once the PR merges
  // with the lane head; every other park keeps reading nothing.
  const canReadPr =
    !halted &&
    latest !== null &&
    latest.artifacts !== null &&
    (FACT_READ_STATES.includes(state) ||
      (state === 'parked' && record.parked?.reason === 'owner-merge'));
  if (canReadPr && ctx.deps.forgeRead !== undefined) {
    const prRead = await prFactOf(ctx.deps.forgeRead, record, latest, head12, latest.artifacts.headCommit, ctx.deps.forgeAncestry);
    pr = prRead.pr;
    mergeState = prRead.mergeState;
  }
  const merge = await mergeFactsOf(ctx, record, state, halted, acceptance, mergeState);
  return { acceptance, acceptanceRetry, acceptedHead12, preMerge, ci, pr, merge };
}

/**
 * The merge facts (K6-7): `oneWayDoor` is false exactly when the head is
 * accepted (the acceptance assessment already blocks on an open one-way door
 * with blocker kind `door`; anything else, including unreadable, is true);
 * `branchBehind` follows the PR snapshot's merge state (behind or unknown;
 * clean and blocked read false — blocked is CI's or the thread's business, which
 * the merge attempt reports as not-merged); `trainFree` is true when no OTHER
 * run is merging on the same repository; and `policyGrant` is the dependency's
 * `autoMergeEnabled` boolean. The run list and work orders are read only in
 * `merging`, never while halted; every read failure falls closed (wait).
 */
async function mergeFactsOf(
  ctx: AdvanceStepContext,
  record: LaneRunRecord,
  state: LaneRunStateValue,
  halted: boolean,
  acceptance: AcceptanceFacts['acceptance'],
  mergeState: PullRequestMergeState | null,
): Promise<MergeFacts> {
  const oneWayDoor = acceptance !== 'accepted';
  const branchBehind = mergeState === 'behind' || mergeState === 'unknown';
  let trainFree = true;
  if (!halted && state === 'merging') {
    try {
      const workOrderRepo = ctx.deps.workOrderRepo;
      if (workOrderRepo === undefined) {
        trainFree = false;
      } else {
        const thisWo = await workOrderRepo.findWorkOrderById(record.workOrderId);
        const runs = await ctx.deps.runRepo.list();
        for (const other of runs) {
          if (other.runId === record.runId || other.parked !== null) {
            continue;
          }
          const otherEntries = await ctx.deps.runJournal.listForRun(other.runId);
          if (laneRunJournalState(otherEntries, other.runId) !== 'merging') {
            continue;
          }
          if (thisWo === null) {
            trainFree = false;
            break;
          }
          const otherWo = await workOrderRepo.findWorkOrderById(other.workOrderId);
          if (otherWo === null || otherWo.repository === thisWo.repository) {
            trainFree = false;
            break;
          }
        }
      }
    } catch {
      trainFree = false;
    }
  }
  const policyGrant = ctx.deps.autoMergeEnabled === true;
  return { oneWayDoor, branchBehind, trainFree, policyGrant };
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
    // The conductor's pre-PR accept uses the receipts-only assessment: no
    // acceptance is stored, but a `passed` answer at the exact head accepts.
    const outcome = await assessment.assessHeadReceipts({
      attemptId: latest.id,
      workOrderId: record.workOrderId,
      candidateHeadSha: headSha,
      policyRevision: record.runPolicyRevision,
    });
    if (outcome.outcome === 'passed') {
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
    // A thrown assessment leaves the intent unread (mirror performReview's
    // pendingReview shape): append no result; the next advance's G3a routes the
    // key to reconcileAccept, which re-runs the assessment. An `unknown`
    // OUTCOME from the port (not a throw) keeps the ambiguous result below.
    return { outcome: 'acted', step: decision.step, key, result: 'ambiguous', reasonCode: 'acceptance-unknown' };
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
 * thrown assessment stays `ambiguous` with no result for the reconcile; an
 * `unknown` outcome journals ambiguous.
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

/** The frozen D7 note sections of the brief manifest: three non-empty strings; null when absent or malformed. */
function frozenPrNotesOf(manifest: Record<string, unknown> | null): LaneRunPrBodyFrozen | null {
  const notes = manifest?.prNotes;
  if (typeof notes !== 'object' || notes === null || Array.isArray(notes)) {
    return null;
  }
  const record = notes as Record<string, unknown>;
  const text = (field: string): string => (typeof record[field] === 'string' ? (record[field] as string) : '');
  const hardToUndo = text('hardToUndo');
  const assumptions = text('assumptions');
  const challengeThis = text('challengeThis');
  if (hardToUndo.trim().length === 0 || assumptions.trim().length === 0 || challengeThis.trim().length === 0) {
    return null;
  }
  return { hardToUndo, assumptions, challengeThis };
}

/** The open-pr/push act pre-checks (K6-6): the wiring and the collected head. */
function prPushPreCheck(
  ctx: AdvanceStepContext,
  gathered: GatheredLaneRunFacts,
  decision: ActDecision | ReconcileDecision,
): AdvanceLaneRunResult | null {
  if (
    ctx.deps.conductorForgeGrant === undefined ||
    ctx.deps.executeForgeAction === undefined ||
    ctx.deps.acceptanceAssessment === undefined ||
    ctx.deps.workOrderRepo === undefined
  ) {
    return { outcome: 'not-wired', step: decision.step };
  }
  const latest = gathered.latestAttempt;
  if (latest === null || latest.artifacts === null) {
    return { outcome: 'waiting', reason: 'facts-inconsistent' };
  }
  return null;
}

/** Append the keyed intent (mintedId null) then a refused result for a pre-execution refusal; nothing external is called. */
async function refuseKeyed(
  ctx: AdvanceStepContext,
  request: AdvanceLaneRunRequest,
  decision: ActDecision,
  reasonCode: Extract<LaneRunResultReasonCode, 'forge-refused' | 'grant-refused'>,
  detail: string | null = null,
): Promise<AdvanceLaneRunResult> {
  const intentRefusal = await appendRunIntent(ctx, request, decision.key, null);
  if (intentRefusal !== null) {
    return { outcome: 'refused', reason: intentRefusal };
  }
  const resultRefusal = await appendRunResult(ctx, request, decision.key, 'refused', reasonCode, detail);
  if (resultRefusal !== null) {
    return { outcome: 'refused', reason: resultRefusal };
  }
  return { outcome: 'acted', step: decision.step, key: decision.key, result: 'refused', reasonCode };
}

/** The two conductor push grant kinds (K6-6): open a PR, or push to an existing one. */
type ForgePushKind = 'push-and-open-pr' | 'push-to-pr';

/**
 * The shared open-pr/push body (K6-6): the frozen D7 notes and `renderPrBody`
 * (open-pr only) before any intent, the acceptance receipt id read again at
 * the exact head, then the keyed intent minting the forge action id, the
 * conductor push grant, and the authorized forge action. A missing or invalid
 * note or a missing receipt refuses before the intent (no minted id, no forge
 * call); a refused or thrown grant refuses under the keyed intent's minted id
 * with no forge call; an ambiguous or thrown forge outcome leaves the intent
 * pending for the reconcile. Reason strings are never journalled.
 */
async function runPrPushBody(
  ctx: AdvanceStepContext,
  record: LaneRunRecord,
  gathered: GatheredLaneRunFacts,
  decision: ActDecision,
  request: AdvanceLaneRunRequest,
  kind: ForgePushKind,
): Promise<AdvanceLaneRunResult> {
  const latest = gathered.latestAttempt;
  if (latest === null || latest.artifacts === null) {
    return { outcome: 'waiting', reason: 'facts-inconsistent' };
  }
  const conductorForgeGrant = ctx.deps.conductorForgeGrant;
  const executeForgeAction = ctx.deps.executeForgeAction;
  const acceptanceAssessment = ctx.deps.acceptanceAssessment;
  const workOrderRepo = ctx.deps.workOrderRepo;
  if (
    conductorForgeGrant === undefined ||
    executeForgeAction === undefined ||
    acceptanceAssessment === undefined ||
    workOrderRepo === undefined
  ) {
    return { outcome: 'not-wired', step: decision.step };
  }
  const headSha = latest.artifacts.headCommit;

  // CB-D2 (CB2): open-pr opens against the run's recorded base branch; the
  // same string names the base on the result's detail. Push-to-pr carries no
  // base and keeps a null detail.
  const baseBranch = kind === 'push-and-open-pr' ? resolveLaneRunBaseBranch(record) : null;

  // The work order carries the project id; a null one is facts-inconsistent.
  let workOrder: WorkOrderRecord | null;
  try {
    workOrder = await workOrderRepo.findWorkOrderById(record.workOrderId);
  } catch {
    workOrder = null;
  }
  if (workOrder === null) {
    return { outcome: 'waiting', reason: 'facts-inconsistent' };
  }

  // PR bodies come from records only (§5): the frozen D7 notes and renderPrBody.
  // Only push-and-open-pr renders; a missing or invalid note (or an unrenderable
  // body) refuses before any intent, grant or forge call.
  let rendered: RenderPrBodyResult | null = null;
  if (kind === 'push-and-open-pr') {
    const manifest = await readVerifiedFrozenManifest(latest, ctx.deps.artifactPort, ctx.deps.computeDigest);
    const frozen = frozenPrNotesOf(manifest);
    const title = 'Fleet work order ' + record.workOrderId;
    rendered = frozen === null ? null : renderPrBody({
      workOrderId: record.workOrderId,
      title,
      tier: record.tier,
      runId: record.runId,
      rounds: record.round,
      gate: 'passed',
      reviews: [],
      frozen,
    });
    if (rendered === null || !rendered.ok) {
      return refuseKeyed(ctx, request, decision, 'forge-refused', baseBranch);
    }
  }

  // The grant's acceptance receipt id is the receipts-only pass read again at
  // the exact head (K6-5): never journalled, idempotent per head; anything
  // else refuses the grant.
  let receiptId: string | null = null;
  try {
    const assessment = await acceptanceAssessment.assessHeadReceipts({
      attemptId: latest.id,
      workOrderId: record.workOrderId,
      candidateHeadSha: headSha,
      policyRevision: record.runPolicyRevision,
    });
    if (assessment.outcome === 'passed' && assessment.assessedHeadSha === headSha) {
      receiptId = assessment.receiptsId;
    }
  } catch {
    // fall through: no receipt.
  }
  if (receiptId === null) {
    return refuseKeyed(ctx, request, decision, 'grant-refused', baseBranch);
  }

  // Mint the forge action id under the keyed intent BEFORE any grant is issued:
  // a crash or a journal refusal between them must never leave an issued,
  // unconsumed conductor grant with no journal trace. A grant refusal or throw
  // then appends `refused` / `grant-refused` under the same key — one result,
  // no second intent.
  const actionId = 'forge-' + ctx.deps.newUlid();
  const intentRefusal = await appendRunIntent(ctx, request, decision.key, actionId);
  if (intentRefusal !== null) {
    return { outcome: 'refused', reason: intentRefusal };
  }
  const refuseGrant = async (): Promise<AdvanceLaneRunResult> => {
    const resultRefusal = await appendRunResult(ctx, request, decision.key, 'refused', 'grant-refused', baseBranch);
    if (resultRefusal !== null) {
      return { outcome: 'refused', reason: resultRefusal };
    }
    return { outcome: 'acted', step: decision.step, key: decision.key, result: 'refused', reasonCode: 'grant-refused' };
  };

  // The conductor's own push grant under `policy:conductor@<revision>`; a
  // refusal or a throw refuses under the keyed intent before the forge call.
  let grant: ConductorForgeGrantResult;
  try {
    grant = await conductorForgeGrant.issueConductorForgeGrant({
      projectId: workOrder.projectId,
      workOrderId: record.workOrderId,
      attemptId: latest.id,
      forgeKind: kind,
      expectedHeadSha: headSha,
      policyRevision: record.runPolicyRevision,
      acceptanceReceiptId: receiptId,
    });
  } catch {
    return refuseGrant();
  }
  if (grant.outcome !== 'issued') {
    return refuseGrant();
  }
  let forgeRequest: ExecuteAuthorizedForgeActionRequest;
  const recordedBranch = record.branchName === undefined ? {} : { branchName: record.branchName };
  if (kind === 'push-and-open-pr' && rendered !== null) {
    forgeRequest = {
      actionId,
      attemptId: latest.id,
      workOrderId: record.workOrderId,
      kind: 'push-and-open-pr',
      expectedHeadSha: headSha,
      authorizationGrantId: grant.grantId,
      authorizedBy: grant.decisionRevision,
      title: rendered.title,
      body: rendered.body,
      ...recordedBranch,
      baseBranch: resolveLaneRunBaseBranch(record),
    };
  } else {
    forgeRequest = {
      actionId,
      attemptId: latest.id,
      workOrderId: record.workOrderId,
      kind: 'push-to-pr',
      expectedHeadSha: headSha,
      authorizationGrantId: grant.grantId,
      authorizedBy: grant.decisionRevision,
      ...recordedBranch,
    };
  }
  let forged: ExecuteAuthorizedForgeActionResult;
  try {
    forged = await executeForgeAction.executeAuthorizedForgeAction(forgeRequest);
  } catch {
    // Ambiguous: the intent stays pending for the reconcile; nothing more is written.
    return { outcome: 'acted', step: decision.step, key: decision.key, result: 'ambiguous', reasonCode: 'forge-ambiguous' };
  }
  if (forged.outcome === 'executed') {
    if (kind === 'push-and-open-pr') {
      const saved = await saveOrRefuse(ctx,
        { ...record, prNumber: forged.pullRequestNumber ?? record.prNumber, revision: record.revision + 1 },
        request,
      );
      if (!saved.ok) {
        return { outcome: 'refused', reason: saved.reason };
      }
    }
    const reasonCode = kind === 'push-and-open-pr' ? 'pr-opened' : 'pushed';
    const resultRefusal = await appendRunResult(ctx, request, decision.key, 'completed', reasonCode, baseBranch);
    if (resultRefusal !== null) {
      return { outcome: 'refused', reason: resultRefusal };
    }
    return { outcome: 'acted', step: decision.step, key: decision.key, result: 'completed', reasonCode };
  }
  if (forged.forgeAmbiguous === true) {
    return { outcome: 'acted', step: decision.step, key: decision.key, result: 'ambiguous', reasonCode: 'forge-ambiguous' };
  }
  const resultRefusal = await appendRunResult(ctx, request, decision.key, 'refused', 'forge-refused', baseBranch);
  if (resultRefusal !== null) {
    return { outcome: 'refused', reason: resultRefusal };
  }
  return { outcome: 'acted', step: decision.step, key: decision.key, result: 'refused', reasonCode: 'forge-refused' };
}

/**
 * The `act open-pr` step (K6-6): open the branch's PR through a conductor push
 * grant (`push-and-open-pr`) and the authorized forge action, with the PR
 * title and body rendered from records only. One-way: an intent that exists is
 * never re-sent; the reconcile decides from the forge.
 */
export async function performOpenPr(
  ctx: AdvanceStepContext,
  record: LaneRunRecord,
  gathered: GatheredLaneRunFacts,
  decision: ActDecision,
  request: AdvanceLaneRunRequest,
): Promise<AdvanceLaneRunResult> {
  const preCheck = prPushPreCheck(ctx, gathered, decision);
  if (preCheck !== null) {
    return preCheck;
  }
  const spent = await parkSpentOneWayKey(ctx, record, gathered, decision, request);
  if (spent !== null) {
    return spent;
  }
  return runPrPushBody(ctx, record, gathered, decision, request, 'push-and-open-pr');
}

/**
 * The `act push` step (K6-6): push the head to the branch's existing PR
 * through a conductor push grant (`push-to-pr`); no title, body or prNumber
 * write. One-way like open-pr.
 */
export async function performPush(
  ctx: AdvanceStepContext,
  record: LaneRunRecord,
  gathered: GatheredLaneRunFacts,
  decision: ActDecision,
  request: AdvanceLaneRunRequest,
): Promise<AdvanceLaneRunResult> {
  const preCheck = prPushPreCheck(ctx, gathered, decision);
  if (preCheck !== null) {
    return preCheck;
  }
  const spent = await parkSpentOneWayKey(ctx, record, gathered, decision, request);
  if (spent !== null) {
    return spent;
  }
  return runPrPushBody(ctx, record, gathered, decision, request, 'push-to-pr');
}

/** Append the reconcile result under the pending key and return the acted outcome. */
async function appendReconcileResult(
  ctx: AdvanceStepContext,
  request: AdvanceLaneRunRequest,
  decision: ReconcileDecision,
  outcome: LaneRunJournalOutcome,
  reasonCode: LaneRunResultReasonCode,
): Promise<AdvanceLaneRunResult> {
  const resultRefusal = await appendRunResult(ctx, request, decision.key, outcome, reasonCode);
  if (resultRefusal !== null) {
    return { outcome: 'refused', reason: resultRefusal };
  }
  return { outcome: 'acted', step: decision.step, key: decision.key, result: outcome, reasonCode };
}

/**
 * The open-pr/push reconcile (§3.5): both are one-way, so the reconcile only
 * reads the forge and records — never re-sends the action. The PR is read by
 * number when `record.prNumber` is set, else by the branch name (the last path
 * segment of the latest attempt's worktreePath). A found open PR at the exact
 * head reconciles and fills a missing `prNumber`; another head or not-found is
 * refused, unreadable ambiguous.
 */
export async function reconcilePrPush(
  ctx: AdvanceStepContext,
  record: LaneRunRecord,
  gathered: GatheredLaneRunFacts,
  decision: ReconcileDecision,
  request: AdvanceLaneRunRequest,
): Promise<AdvanceLaneRunResult> {
  const forgeRead = ctx.deps.forgeRead;
  if (forgeRead === undefined) {
    return { outcome: 'not-wired', step: decision.step };
  }
  const latest = gathered.latestAttempt;
  if (latest === null) {
    return { outcome: 'waiting', reason: 'facts-inconsistent' };
  }
  let read: ReadPullRequestResult;
  try {
    read = await forgeRead.readPullRequest({ ref: pullRequestRefOf(record, latest) });
  } catch {
    return appendReconcileResult(ctx, request, decision, 'ambiguous', 'forge-ambiguous');
  }
  if (read.outcome === 'found') {
    const snapshot = read.pullRequest;
    if (snapshot.state === 'open' && head12Of(snapshot.headSha) === gathered.facts.head12) {
      if (record.prNumber === null) {
        const saved = await saveOrRefuse(ctx,
          { ...record, prNumber: snapshot.number, revision: record.revision + 1 },
          request,
        );
        if (!saved.ok) {
          return { outcome: 'refused', reason: saved.reason };
        }
      }
      const reasonCode = decision.step === 'open-pr' ? 'pr-opened' : 'pushed';
      return appendReconcileResult(ctx, request, decision, 'reconciled', reasonCode);
    }
    return appendReconcileResult(ctx, request, decision, 'refused', 'forge-refused');
  }
  if (read.outcome === 'not-found') {
    return appendReconcileResult(ctx, request, decision, 'refused', 'forge-refused');
  }
  return appendReconcileResult(ctx, request, decision, 'ambiguous', 'forge-ambiguous');
}

/**
 * The `act merge` step (K6-7): one keyed intent, then `AutoMergeAttemptPort`
 * under the attempt id. Only reason codes are journalled — the port's `detail`
 * text is never. A merged head that matches the run's head completes; a merge
 * at any other head stays ambiguous for the reconcile; `waiting` is refused
 * (`merge-waiting`: a one-way key cannot wait); `off` and `not-merged` are
 * refused; a throw is ambiguous. `merge` is one-way: the key is never re-sent,
 * and a spent key (an intent with a final result) parks `step-refused merge`.
 */
export async function performMerge(
  ctx: AdvanceStepContext,
  record: LaneRunRecord,
  gathered: GatheredLaneRunFacts,
  decision: ActDecision,
  request: AdvanceLaneRunRequest,
): Promise<AdvanceLaneRunResult> {
  const autoMergeAttempt = ctx.deps.autoMergeAttempt;
  if (autoMergeAttempt === undefined) {
    return { outcome: 'not-wired', step: decision.step };
  }
  const latest = gathered.latestAttempt;
  if (latest === null || latest.artifacts === null) {
    return { outcome: 'waiting', reason: 'facts-inconsistent' };
  }
  const spent = await parkSpentOneWayKey(ctx, record, gathered, decision, request);
  if (spent !== null) {
    return spent;
  }
  const intentRefusal = await appendRunIntent(ctx, request, decision.key, null);
  if (intentRefusal !== null) {
    return { outcome: 'refused', reason: intentRefusal };
  }
  let result: 'completed' | 'refused' | 'ambiguous';
  let reasonCode: LaneRunResultReasonCode;
  try {
    const outcome = await autoMergeAttempt.autoMergeAttempt(
      record.branchName === undefined
        ? { attemptId: latest.id }
        : { attemptId: latest.id, branchName: record.branchName },
    );
    if (outcome.outcome === 'merged') {
      if (head12Of(outcome.headSha) === gathered.facts.head12) {
        result = 'completed';
        reasonCode = 'merged';
      } else {
        result = 'ambiguous';
        reasonCode = 'forge-ambiguous';
      }
    } else if (outcome.outcome === 'waiting') {
      result = 'refused';
      reasonCode = 'merge-waiting';
    } else if (outcome.outcome === 'off') {
      result = 'refused';
      reasonCode = 'merge-off';
    } else {
      result = 'refused';
      reasonCode = 'merge-not-merged';
    }
  } catch {
    result = 'ambiguous';
    reasonCode = 'forge-ambiguous';
  }
  const resultRefusal = await appendRunResult(ctx, request, decision.key, result, reasonCode);
  if (resultRefusal !== null) {
    return { outcome: 'refused', reason: resultRefusal };
  }
  return { outcome: 'acted', step: decision.step, key: decision.key, result, reasonCode };
}

/**
 * The merge reconcile (K6-7): merge is one-way, so the reconcile only reads the
 * PR at the head through `forgeRead` and records — never a second
 * `autoMergeAttempt` under the key. A merged PR at the run's head completes; an
 * open PR at the head is refused (`merge-not-merged`, the decider acts again);
 * any other state, `unavailable` or a throw is ambiguous.
 */
export async function reconcileMerge(
  ctx: AdvanceStepContext,
  record: LaneRunRecord,
  gathered: GatheredLaneRunFacts,
  decision: ReconcileDecision,
  request: AdvanceLaneRunRequest,
): Promise<AdvanceLaneRunResult> {
  const forgeRead = ctx.deps.forgeRead;
  if (forgeRead === undefined) {
    return { outcome: 'not-wired', step: decision.step };
  }
  const latest = gathered.latestAttempt;
  if (latest === null) {
    return { outcome: 'waiting', reason: 'facts-inconsistent' };
  }
  let read: ReadPullRequestResult;
  try {
    read = await forgeRead.readPullRequest({ ref: pullRequestRefOf(record, latest) });
  } catch {
    return appendReconcileResult(ctx, request, decision, 'ambiguous', 'forge-ambiguous');
  }
  if (read.outcome === 'found') {
    const snapshot = read.pullRequest;
    if (snapshot.state === 'merged' && head12Of(snapshot.headSha) === gathered.facts.head12) {
      return appendReconcileResult(ctx, request, decision, 'completed', 'merged');
    }
    if (snapshot.state === 'open' && head12Of(snapshot.headSha) === gathered.facts.head12) {
      return appendReconcileResult(ctx, request, decision, 'refused', 'merge-not-merged');
    }
  }
  return appendReconcileResult(ctx, request, decision, 'ambiguous', 'forge-ambiguous');
}
