// @generated use-case scaffold — refined for lane CO25.
import type { ForgeMergeReadPort } from '../ports/out/ForgeMergeReadPort.out-port.js';
import type {
  InspectMergeReadinessPort,
  InspectMergeReadinessRequest,
  InspectMergeReadinessResult,
} from '../ports/in/InspectMergeReadinessPort.in-port.js';
import type {
  MergeContextSnapshot,
  ReadForgeMergeResult,
} from '../ports/out/ForgeMergeReadPort.out-port.js';

const REPOSITORY_SEGMENT_PATTERN = /^[A-Za-z0-9_.-]{1,100}$/;

const CONTEXT_SUCCESS_TOKENS = new Set(['SUCCESS']);
const CONTEXT_PENDING_TOKENS = new Set([
  'PENDING',
  'IN_PROGRESS',
  'QUEUED',
  'WAITING',
  'REQUESTED',
  'EXPECTED',
]);
const CONTEXT_FAILED_TOKENS = new Set([
  'FAILURE',
  'ERROR',
  'CANCELLED',
  'SKIPPED',
  'NEUTRAL',
  'TIMED_OUT',
  'ACTION_REQUIRED',
  'STALE',
]);

/** A positive integer pull request number the request must carry. */
function isValidPullRequest(pullRequest: number): boolean {
  return Number.isSafeInteger(pullRequest) && pullRequest >= 1;
}

/** The `unknown` answer for one failed forge read outcome, never for a successful one. */
function forgeFailureResult(
  outcome: Exclude<ReadForgeMergeResult['outcome'], 'ok'>,
): InspectMergeReadinessResult {
  if (outcome === 'not-found') {
    return { outcome: 'unknown', reason: 'pr-not-found' };
  }
  if (outcome === 'budget-exhausted') {
    return { outcome: 'unknown', reason: 'budget-exhausted' };
  }
  return { outcome: 'unknown', reason: 'forge-unavailable' };
}

/**
 * The first blocking answer one required context forces, or null when every
 * required context is finished and green.
 */
function contextStateOutcome(
  requiredContexts: readonly string[],
  contexts: readonly MergeContextSnapshot[],
): InspectMergeReadinessResult | null {
  for (const contextName of requiredContexts) {
    const context = contexts.find((candidate) => candidate.name === contextName);
    const state = context === undefined ? 'missing' : context.state;
    if (CONTEXT_SUCCESS_TOKENS.has(state)) {
      continue;
    }
    if (CONTEXT_PENDING_TOKENS.has(state)) {
      return { outcome: 'still-waiting', reason: 'checks-pending' };
    }
    if (state === 'missing') {
      return { outcome: 'still-waiting', reason: 'checks-missing' };
    }
    if (CONTEXT_FAILED_TOKENS.has(state)) {
      return { outcome: 'still-waiting', reason: 'checks-failed' };
    }
    return { outcome: 'unknown', reason: 'contexts-unknown' };
  }
  return null;
}

/** Report, read-only, whether one pull request of a repository without a merge train is ready to merge. */
export class InspectMergeReadinessUseCase implements InspectMergeReadinessPort {
  constructor(
    private readonly deps: {
      readonly mergeRead: ForgeMergeReadPort;
      readonly nowIso: () => string;
    },
  ) {}

  async inspectMergeReadiness(request: InspectMergeReadinessRequest): Promise<InspectMergeReadinessResult> {
    if (!this.isValidRequest(request)) {
      return { outcome: 'unknown', reason: 'invalid-request' };
    }
    if (!this.deps.mergeRead.isConfigured()) {
      return { outcome: 'unknown', reason: 'forge-not-configured' };
    }

    const read = await this.deps.mergeRead.readForgeMerge({
      repository: request.repository,
      pullRequestNumber: request.pullRequest,
      headSha: request.expectedHeadOid ?? '',
      requiredContexts: request.requiredContexts,
      nowIso: this.deps.nowIso(),
      deadlineIso: request.deadlineIso,
    });

    if (read.outcome !== 'ok') {
      return forgeFailureResult(read.outcome);
    }
    if (read.prState !== 'open') {
      return { outcome: 'still-waiting', reason: 'not-open' };
    }
    if (request.expectedHeadOid !== null && read.liveHeadSha !== request.expectedHeadOid) {
      return { outcome: 'still-waiting', reason: 'head-moved' };
    }
    const contextOutcome = contextStateOutcome(request.requiredContexts, read.contexts);
    if (contextOutcome !== null) {
      return contextOutcome;
    }
    if (read.unresolvedThreads === 'unknown') {
      return { outcome: 'unknown', reason: 'threads-unknown' };
    }
    if (read.unresolvedThreads > 0) {
      return { outcome: 'still-waiting', reason: 'threads-unresolved' };
    }
    if (read.mergeState === 'unknown') {
      return { outcome: 'unknown', reason: 'merge-state-unknown' };
    }
    if (read.mergeState !== 'clean') {
      return { outcome: 'still-waiting', reason: 'not-mergeable' };
    }
    return { outcome: 'ready', headOid: read.liveHeadSha };
  }

  /** The request is well formed only with a valid repository and a positive pull request number. */
  private isValidRequest(request: InspectMergeReadinessRequest): boolean {
    return this.isValidRepository(request.repository) && isValidPullRequest(request.pullRequest);
  }

  private isValidRepository(repository: { readonly owner: string; readonly repo: string }): boolean {
    const { owner, repo } = repository;
    return (
      REPOSITORY_SEGMENT_PATTERN.test(owner) &&
      REPOSITORY_SEGMENT_PATTERN.test(repo) &&
      owner !== '.' &&
      owner !== '..' &&
      repo !== '.' &&
      repo !== '..'
    );
  }
}
