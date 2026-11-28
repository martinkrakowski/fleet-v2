/**
 * U6: the premerge receipt-carry facts of one advance. When the PR head moved
 * off the reviewed lane head while the Tier 2 hold waits in `merging`, read
 * the journalled carry for that head, or gather the git evidence through the
 * `ReceiptCarryEvidencePort`, the lane's collected changed paths and the CI
 * state of the PR head, and let the pure `qualifyBaseMergeCarry` decide. The
 * use case only gathers; it never decides, and every failed read leaves "no
 * carry, not refused" so the hold keeps waiting.
 */
import type { AttemptRecord } from '../../../domain/execution-records.js';
import type { LaneRunJournalEntryRecord } from '../../../domain/lane-run-journal.js';
import type { LaneRunRecord } from '../../../domain/lane-run-records.js';
import { resolveLaneRunBaseBranch } from '../../../domain/base-branch.js';
import { laneRunRecordedPremergeCarry } from '../../../domain/lane-run-step-facts.js';
import {
  premergeCarryMatches,
  qualifyBaseMergeCarry,
  receiptCarryRefusalIsTransient,
  type PremergeCarry,
} from '../../../domain/receipt-carry.js';
import { snapshotPlainDataRecord } from '../../../domain/plain-record-reads.js';
import type { LaneRunStateValue } from '../../../domain/value-objects/LaneRunState.vo.js';
import type { AdvanceStepContext } from './step-context.js';
import { conductedRunnerOf } from './conducted-host.js';

/** The carry read: the verified carry, and whether the head move was definitively refused. */
export interface PremergeCarryRead {
  readonly carry: PremergeCarry | null;
  readonly refused: boolean;
}

export const NO_PREMERGE_CARRY: PremergeCarryRead = Object.freeze({ carry: null, refused: false });

const HEX_40_PATTERN = /^[0-9a-f]{40}$/;

/** The evidence budget of one advance, in milliseconds. */
const EVIDENCE_BUDGET_MS = 60_000;

export async function premergeCarryFactsOf(
  ctx: AdvanceStepContext,
  record: LaneRunRecord,
  state: LaneRunStateValue,
  entries: readonly LaneRunJournalEntryRecord[],
  latest: AttemptRecord | null,
  attemptRecords: readonly (AttemptRecord | null)[],
  acceptance: {
    readonly preMerge: 'none' | 'passed' | 'failed' | 'unknown';
    readonly pr: { readonly state: string; readonly head12: string; readonly headSha?: string; readonly baseRef?: string } | null;
  },
  halted: boolean,
  nowIso: string,
): Promise<PremergeCarryRead> {
  try {
    if (record.tier !== 2 || state !== 'merging' || halted || acceptance.preMerge !== 'passed') {
      return NO_PREMERGE_CARRY;
    }
    const laneHead = latest?.artifacts?.headCommit;
    const pr = acceptance.pr;
    if (
      latest === null || pr === null || pr.state !== 'open' ||
      typeof laneHead !== 'string' || !HEX_40_PATTERN.test(laneHead) ||
      typeof pr.headSha !== 'string' || !HEX_40_PATTERN.test(pr.headSha) || pr.headSha === laneHead
    ) {
      return NO_PREMERGE_CARRY;
    }
    // Idempotent per (run, carried head): a journalled carry is the fact; no git is read again.
    const recorded = laneRunRecordedPremergeCarry(entries, record.runId, pr.head12);
    if (premergeCarryMatches(recorded, laneHead, pr.headSha) && recorded.attemptId === latest.id) {
      return { carry: recorded, refused: false };
    }
    // The evidence is computed against the run's own base branch: a PR whose
    // forge base is anything else (or unknown) is a definitive no, never a carry.
    if (pr.baseRef !== resolveLaneRunBaseBranch(record)) {
      return { carry: null, refused: true };
    }
    const port = ctx.deps.receiptCarryEvidence;
    const digest = ctx.deps.repositoryDigest;
    if (port?.readCarryEvidence === undefined || digest === undefined) {
      return NO_PREMERGE_CARRY;
    }
    const evidence = snapshotPlainDataRecord(
      await port.readCarryEvidence({
        repositoryDigest: digest,
        reviewedHeadSha: laneHead,
        newHeadSha: pr.headSha,
        baseBranch: resolveLaneRunBaseBranch(record),
        deadlineIso: new Date(Date.parse(nowIso) + EVIDENCE_BUDGET_MS).toISOString(),
      }),
    );
    if (evidence === null || evidence.ok !== true) {
      return NO_PREMERGE_CARRY;
    }
    const lanePaths = await laneChangedPathsOf(ctx, attemptRecords, latest, laneHead);
    const result = qualifyBaseMergeCarry({
      attemptId: latest.id,
      reviewedHeadSha: laneHead,
      newHeadSha: pr.headSha,
      newHeadParents: evidence.newHeadParents,
      secondParentOnBase: evidence.secondParentOnBase,
      mainRangeBaseSha: evidence.mainRangeBaseSha,
      automaticMergeTreeSha: evidence.automaticMergeTreeSha,
      newHeadTreeSha: evidence.newHeadTreeSha,
      prChangedPaths: evidence.prChangedPaths,
      laneChangedPaths: lanePaths,
      ci: await ciOf(ctx, pr.headSha),
      decidedAtIso: nowIso,
    });
    if (result.carry) {
      return { carry: result.premergeCarry, refused: false };
    }
    return { carry: null, refused: !receiptCarryRefusalIsTransient(result.reason) };
  } catch {
    return NO_PREMERGE_CARRY;
  }
}

async function ciOf(ctx: AdvanceStepContext, headSha: string): Promise<'passed' | 'failed' | 'pending' | 'unknown'> {
  try {
    const read = await ctx.deps.ciState?.readHeadCiState({ headSha });
    return read !== undefined && read.headSha === headSha ? read.state : 'unknown';
  } catch {
    return 'unknown';
  }
}

/** The lane's collected changed paths (base of the first attempt to the collected head); null when unreadable. */
async function laneChangedPathsOf(
  ctx: AdvanceStepContext,
  attemptRecords: readonly (AttemptRecord | null)[],
  latest: AttemptRecord,
  laneHead: string,
): Promise<readonly string[] | null> {
  const laneBase = attemptRecords.find((entry) => entry !== null)?.baseCommit ?? null;
  const host = conductedRunnerOf(latest);
  if (laneBase === null || host === null) {
    return null;
  }
  try {
    return (await ctx.deps.artifactPort.readChangedPaths?.(latest.worktreePath, laneBase, laneHead, host)) ?? null;
  } catch {
    return null;
  }
}
