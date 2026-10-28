// @generated adapter — implemented for step 4 (fail-closed forge evidence).
/**
 * ForgeEvidenceAdapter implements ForgeEvidencePort. It resolves the
 * candidate head to exactly one open pull request of the configured
 * owner/repo, then reads that pull request's CI buckets and unresolved
 * review threads through `gh`. Anything it cannot read fails closed: the CI
 * state is `unknown` and the thread count is `null`, never a pass and never
 * a zero.
 */

import type { EvidenceResultValue } from '../../domain/value-objects/EvidenceResult.vo.js';
import type {
  ForgeCheckStatus,
  ForgeEvidencePort,
  ReadForgeCheckStatusRequest,
} from '../../application/ports/out/ForgeEvidencePort.out-port.js';

export interface GhCommandResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr?: string;
}

export interface ForgeEvidenceOptions {
  /** Repository owner that owns the candidate head's pull request. */
  readonly owner?: string;
  /** Repository name that owns the candidate head's pull request. */
  readonly repo?: string;
  /** Test/seam transport for `gh pr checks` and `gh api`. */
  readonly runGh?: (args: readonly string[]) => Promise<GhCommandResult>;
  /** Static per-head status, used when no forge transport is configured. */
  readonly statuses?: Readonly<Record<string, ForgeCheckStatus>>;
}

const HEAD_SHA_PATTERN = /^[0-9a-f]{40}$/;
const OWNER_OR_REPO_PATTERN = /^[A-Za-z0-9_.-]+$/;
const UNRESOLVED_THREADS_QUERY =
  'query($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){pullRequest(number:$number){reviewThreads(first:100){totalCount nodes{isResolved}}}}}';

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

/**
 * `gh pr checks --json bucket` buckets to the evidence enum; an empty check
 * list is `unknown` because no checks is not a pass.
 */
function ciStateFromBuckets(parsed: unknown): EvidenceResultValue {
  if (!Array.isArray(parsed) || parsed.length === 0) {
    return 'unknown';
  }
  let pending = false;
  for (const entry of parsed) {
    const bucket = (entry as { bucket?: unknown }).bucket;
    if (bucket === 'pass' || bucket === 'skipping') {
      continue;
    }
    if (bucket === 'pending') {
      pending = true;
      continue;
    }
    // 'fail', 'cancel' and anything unrecognised never count as a pass.
    return bucket === 'fail' || bucket === 'cancel' ? 'fail' : 'unknown';
  }
  return pending ? 'pending' : 'pass';
}

/**
 * The single open pull request whose head is exactly this sha, as an integer
 * PR number. Zero matches, several matches and anything unreadable are null.
 */
function openPullRequestNumberForHead(payload: unknown, sha: string): number | null {
  if (!Array.isArray(payload)) {
    return null;
  }
  const matching = payload.filter((entry) => {
    if (typeof entry !== 'object' || entry === null) {
      return false;
    }
    const record = entry as { state?: unknown; head?: { sha?: unknown } };
    return record.state === 'open' && record.head?.sha === sha;
  });
  if (matching.length !== 1) {
    return null;
  }
  const number = (matching[0] as { number?: unknown }).number;
  return typeof number === 'number' && Number.isInteger(number) ? number : null;
}

/**
 * The head of the pull request with this number in the same payload shape as
 * the open-pull lookup. Unlike that lookup, it does not require the head to
 * equal the requested sha, so a moved head is observed rather than treated as
 * no match. Anything unreadable is null.
 */
function pullHeadForNumber(payload: unknown, number: number): string | null {
  if (!Array.isArray(payload)) {
    return null;
  }
  const entry = payload.find((item) => {
    if (typeof item !== 'object' || item === null) {
      return false;
    }
    return (item as { number?: unknown }).number === number;
  });
  if (typeof entry !== 'object' || entry === null) {
    return null;
  }
  const sha = (entry as { head?: { sha?: unknown } }).head?.sha;
  return typeof sha === 'string' && HEAD_SHA_PATTERN.test(sha) ? sha : null;
}

/** Unresolved review threads from the GraphQL payload; unreadable is null. */
function unresolvedThreadCountFrom(payload: unknown): number | null {
  if (typeof payload !== 'object' || payload === null) {
    return null;
  }
  const data = (payload as { data?: { repository?: unknown } }).data;
  const repository = data?.repository;
  const pullRequest = (repository as { pullRequest?: unknown } | undefined)?.pullRequest;
  const reviewThreads = (pullRequest as { reviewThreads?: unknown } | undefined)?.reviewThreads;
  const totalCount = (reviewThreads as { totalCount?: unknown } | undefined)?.totalCount;
  const nodes = (reviewThreads as { nodes?: unknown } | undefined)?.nodes;
  if (typeof totalCount !== 'number' || !Array.isArray(nodes)) {
    return null;
  }
  // More threads than one page holds was never completely read.
  if (totalCount > 100) {
    return null;
  }
  return nodes.filter((node) => (node as { isResolved?: unknown }).isResolved !== true).length;
}

export class ForgeEvidenceAdapter implements ForgeEvidencePort {
  constructor(private readonly options: ForgeEvidenceOptions = {}) {}

  /**
   * Read-only forge inspection. The adapter never opens, merges or mutates a
   * pull request, and an unreadable forge state is `unknown` with a `null`
   * thread count rather than a pass.
   */
  async readForgeCheckStatus(request: ReadForgeCheckStatusRequest): Promise<ForgeCheckStatus> {
    const candidateHeadSha = request.candidateHeadSha;
    const unreadable = (): ForgeCheckStatus => ({
      candidateHeadSha,
      ciState: 'unknown',
      unresolvedThreadCount: null,
      observedHeadSha: null,
    });

    if (!HEAD_SHA_PATTERN.test(candidateHeadSha)) {
      return unreadable();
    }

    const staticStatus = this.options.statuses?.[candidateHeadSha];
    if (staticStatus !== undefined) {
      return staticStatus;
    }

    const runGh = this.options.runGh;
    if (runGh === undefined) {
      return unreadable();
    }

    const { owner, repo } = this.options;
    if (
      owner === undefined ||
      repo === undefined ||
      !OWNER_OR_REPO_PATTERN.test(owner) ||
      !OWNER_OR_REPO_PATTERN.test(repo)
    ) {
      return unreadable();
    }

    try {
      // Step A: the head must resolve to exactly one open pull request.
      const pulls = await runGh([
        'api',
        `repos/${owner}/${repo}/commits/${candidateHeadSha}/pulls`,
      ]);
      if (pulls.exitCode !== 0) {
        return unreadable();
      }
      const pullRequestNumber = openPullRequestNumberForHead(
        parseJson(pulls.stdout),
        candidateHeadSha,
      );
      if (pullRequestNumber === null) {
        return unreadable();
      }

      // Step B: CI buckets for that pull request; gh exits 8 while checks run.
      const checks = await runGh([
        'pr',
        'checks',
        String(pullRequestNumber),
        '-R',
        `${owner}/${repo}`,
        '--json',
        'bucket',
      ]);
      const ciState: EvidenceResultValue =
        checks.exitCode === 0 || checks.exitCode === 8
          ? ciStateFromBuckets(parseJson(checks.stdout))
          : 'unknown';

      // Step B': re-read the PR's head with the same lookup used to find it.
      // A head that moved between this read and the checks read is observed as
      // different, so the CI state is never assumed to belong to the requested
      // head. An unreadable re-read is null, failing closed.
      const pullsAfterChecks = await runGh([
        'api',
        `repos/${owner}/${repo}/commits/${candidateHeadSha}/pulls`,
      ]);
      const observedHeadSha =
        pullsAfterChecks.exitCode === 0
          ? pullHeadForNumber(parseJson(pullsAfterChecks.stdout), pullRequestNumber)
          : null;

      // Step C: unresolved review threads on that pull request.
      const threads = await runGh([
        'api',
        'graphql',
        '-f',
        `query=${UNRESOLVED_THREADS_QUERY}`,
        '-F',
        `owner=${owner}`,
        '-F',
        `repo=${repo}`,
        '-F',
        `number=${pullRequestNumber}`,
      ]);
      const unresolvedThreadCount =
        threads.exitCode === 0 ? unresolvedThreadCountFrom(parseJson(threads.stdout)) : null;

      return { candidateHeadSha, ciState, unresolvedThreadCount, observedHeadSha };
    } catch {
      // A rejecting transport is an unreadable forge, never a thrown error.
      return unreadable();
    }
  }
}
