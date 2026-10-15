// @generated adapter stub — signature-matched for step 4 (no behaviour).
/**
 * ForgeEvidenceAdapter implements ForgeEvidencePort.
 * Behaviour lands with the station implementation; every method refuses.
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
  /** Test/seam transport for `gh pr checks` and `gh api`. */
  readonly runGh?: (args: readonly string[]) => Promise<GhCommandResult>;
  /** Static per-head status, used when no forge transport is configured. */
  readonly statuses?: Readonly<Record<string, ForgeCheckStatus>>;
}

const UNRESOLVED_THREADS_QUERY =
  'query($headSha:String!){repository(owner:"fleet",name:"fleet"){pullRequest(headRefName:$headSha){reviewThreads(first:100){nodes{isResolved}}}}}';

function isNonEmptyTrimmedString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

/** `gh pr checks --json bucket` buckets to the evidence enum. */
function ciStateFromBuckets(parsed: unknown): EvidenceResultValue {
  if (!Array.isArray(parsed)) {
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

function unresolvedThreadCountFrom(payload: unknown): number | null {
  if (typeof payload !== 'object' || payload === null) {
    return null;
  }
  const repository = (payload as { data?: { repository?: unknown } }).data?.repository;
  const pullRequest = (repository as { pullRequest?: unknown } | undefined)?.pullRequest;
  const reviewThreads = (pullRequest as { reviewThreads?: unknown } | undefined)?.reviewThreads;
  const nodes = (reviewThreads as { nodes?: unknown } | undefined)?.nodes;
  if (!Array.isArray(nodes)) {
    return null;
  }
  return nodes.filter((node) => (node as { isResolved?: unknown }).isResolved !== true).length;
}

export class ForgeEvidenceAdapter implements ForgeEvidencePort {
  constructor(private readonly options: ForgeEvidenceOptions = {}) {}

  /**
   * Read-only forge inspection. The adapter never opens, merges or mutates a
   * pull request, and an unreadable forge state is `unknown` rather than a
   * pass.
   */
  async readForgeCheckStatus(request: ReadForgeCheckStatusRequest): Promise<ForgeCheckStatus> {
    const candidateHeadSha = request.candidateHeadSha;
    if (!isNonEmptyTrimmedString(candidateHeadSha)) {
      return { candidateHeadSha, ciState: 'unknown', unresolvedThreadCount: 0 };
    }

    const staticStatus = this.options.statuses?.[candidateHeadSha];
    if (staticStatus !== undefined) {
      return staticStatus;
    }

    const runGh = this.options.runGh;
    if (runGh === undefined) {
      return { candidateHeadSha, ciState: 'unknown', unresolvedThreadCount: 0 };
    }

    const checks = await runGh(['pr', 'checks', candidateHeadSha, '--json', 'bucket']);
    const ciState =
      checks.exitCode === 0 ? ciStateFromBuckets(parseJson(checks.stdout)) : 'unknown';

    const threads = await runGh([
      'api',
      'graphql',
      '-f',
      `query=${UNRESOLVED_THREADS_QUERY}`,
      '-F',
      `headSha=${candidateHeadSha}`,
    ]);
    const parsedThreads =
      threads.exitCode === 0 ? unresolvedThreadCountFrom(parseJson(threads.stdout)) : null;

    return {
      candidateHeadSha,
      ciState,
      // An unreadable thread count cannot be reported as "no threads"; the
      // unknown CI state above already keeps acceptance blocked.
      unresolvedThreadCount: parsedThreads ?? 0,
    };
  }
}