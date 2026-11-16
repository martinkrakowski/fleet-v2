// Implemented for lane OG-16b.
/**
 * GhMergeVetoStateAdapter: one read-only `gh api graphql` read of the veto
 * state for one pull request at one head. Cost bound: stdout is refused
 * above 1_048_576 bytes before parsing, the query asks for at most 100
 * labels and 100 files, and `changedPaths` is cut to MAX_CHANGED_PATHS.
 * Five fields stay placeholders (MERGE_VETO_UNREAD_FIELDS) until a later
 * unit reads them, so only shadow veto may use this adapter.
 */

import type { GhInvocationResult } from './ForgeActionAdapter.adapter.js';
import type {
  MergeVetoStatePort,
  MergeVetoStateRequest,
  MergeVetoStateResult,
} from '../../application/ports/out/MergeVetoStatePort.out-port.js';

export interface GhMergeVetoStateAdapterOptions {
  /** Host-side delegate; the composition root binds the reviewed subprocess. */
  readonly runGh?: (args: readonly string[], timeoutMs?: number) => Promise<GhInvocationResult>;
  /** Normal timeout of the one graphql call; default 30_000. */
  readonly timeoutMs?: number;
  /** Test hook: wall clock in epoch milliseconds; default Date.now. */
  readonly now?: () => number;
}

export const MAX_CHANGED_PATHS = 100;

export const MERGE_VETO_STATE_QUERY = `
  query MergeVetoState($owner: String!, $repo: String!, $number: Int!) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) {
        headRefOid
        title
        additions
        deletions
        labels(first: 100) { nodes { name } }
        files(first: ${MAX_CHANGED_PATHS}) { nodes { path } }
      }
    }
  }
`;

/**
 * The five fields one forge read cannot answer. They are placeholders, not
 * observations: a later unit replaces them before any veto mode other than
 * shadow may use this adapter.
 */
export const MERGE_VETO_UNREAD_FIELDS = Object.freeze({
  hardToUndo: 'not-read',
  fixRounds: 0,
  reviewerFamilies: Object.freeze([]) as readonly string[],
  replyResolvedThreads: 0,
  majorBlockerFindings: 0,
});

const HEX_40 = /^[0-9a-f]{40}$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]{1,100}$/;
const TIER_LABEL_PATTERN = /^tier:[0-9]$/;
const MAX_STDOUT_BYTES = 1_048_576;
const BUDGET_MIN_REMAINING_MS = 2_000;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TEXT_LENGTH = 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function unavailable(reason: string): MergeVetoStateResult {
  return { status: 'unavailable', reason };
}

function isCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isText(value: unknown): value is string {
  const text: unknown = value;
  return typeof text === 'string' && text.length >= 1 && text.length <= MAX_TEXT_LENGTH;
}

/** Rule 3: data, repository and pullRequest must each be non-null objects. */
function readPullRequest(stdout: string): Record<string, unknown> {
  const root: unknown = JSON.parse(stdout);
  if (!isRecord(root)) throw new Error('root');
  const errors: unknown = root.errors;
  if (errors !== undefined && errors !== null) {
    if (!Array.isArray(errors) || errors.length > 0) throw new Error('errors');
  }
  const data = root.data;
  if (!isRecord(data)) throw new Error('data');
  const repository = data.repository;
  if (!isRecord(repository)) throw new Error('repository');
  const pullRequest = repository.pullRequest;
  if (!isRecord(pullRequest)) throw new Error('pullRequest');
  return pullRequest;
}

/** Tier rule: exactly one distinct `tier:<digit>` label; otherwise `'2'`. */
function readTier(labels: unknown): string {
  if (!isRecord(labels) || !Array.isArray(labels.nodes)) throw new Error('labels');
  const distinct = new Set<string>();
  for (const node of labels.nodes) {
    if (!isRecord(node) || typeof node.name !== 'string') throw new Error('label');
    if (TIER_LABEL_PATTERN.test(node.name)) distinct.add(node.name);
  }
  return distinct.size === 1 ? [...distinct][0].slice('tier:'.length) : '2';
}

/** Rule 9: validate every element, then keep only the first MAX_CHANGED_PATHS. */
function readChangedPaths(files: unknown): string[] {
  if (!isRecord(files) || !Array.isArray(files.nodes)) throw new Error('files');
  const paths: string[] = [];
  for (const node of files.nodes) {
    if (!isRecord(node)) throw new Error('file');
    if (!isText(node.path)) throw new Error('path');
    paths.push(node.path);
  }
  return paths.slice(0, MAX_CHANGED_PATHS);
}

export function parseMergeVetoState(stdout: string, expectedHeadOid: string): MergeVetoStateResult {
  try {
    const pr = readPullRequest(stdout);
    if (typeof pr.headRefOid !== 'string' || !HEX_40.test(pr.headRefOid)) {
      return unavailable('forge-answer-malformed');
    }
    if (pr.headRefOid !== expectedHeadOid) return unavailable('head-moved');
    if (typeof pr.title !== 'string' || pr.title.length < 1 || pr.title.length > MAX_TEXT_LENGTH) {
      return unavailable('forge-answer-malformed');
    }
    if (!isCount(pr.additions) || !isCount(pr.deletions)) {
      return unavailable('forge-answer-malformed');
    }
    const changedPaths = readChangedPaths(pr.files);
    return {
      status: 'read',
      state: {
        tier: readTier(pr.labels),
        title: pr.title,
        changedPaths,
        additions: pr.additions,
        deletions: pr.deletions,
        ...MERGE_VETO_UNREAD_FIELDS,
        headChangedAfterReview: false,
      },
    };
  } catch {
    return unavailable('forge-answer-malformed');
  }
}

type GhRace =
  | { readonly kind: 'ok'; readonly gh: unknown }
  | { readonly kind: 'timed-out' }
  | { readonly kind: 'failed' };

async function raceGh(
  runGh: NonNullable<GhMergeVetoStateAdapterOptions['runGh']>,
  args: readonly string[],
  timeoutMs: number,
): Promise<GhRace> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<GhRace>((resolve) => {
    timer = setTimeout(() => resolve({ kind: 'timed-out' }), timeoutMs);
  });
  const call = Promise.resolve()
    .then(() => runGh(args, timeoutMs))
    .then(
      (gh): GhRace => ({ kind: 'ok', gh }),
      (): GhRace => ({ kind: 'failed' }),
    );
  try {
    return await Promise.race([call, timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

export class GhMergeVetoStateAdapter implements MergeVetoStatePort {
  private readonly runGh?: (args: readonly string[], timeoutMs?: number) => Promise<GhInvocationResult>;
  private readonly timeoutMs: number;
  private readonly now: () => number;

  constructor(options: GhMergeVetoStateAdapterOptions = {}) {
    this.runGh = options.runGh;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.now = options.now ?? (() => Date.now());
  }

  isConfigured(): boolean {
    return this.runGh !== undefined;
  }

  async readMergeVetoState(request: MergeVetoStateRequest): Promise<MergeVetoStateResult> {
    try {
      if (this.runGh === undefined) return unavailable('not-configured');
      if (!isRecord(request)) return unavailable('invalid-request');
      const repository: unknown = request.repository;
      if (!isRecord(repository)) return unavailable('invalid-request');
      const owner: unknown = repository.owner;
      const repo: unknown = repository.repo;
      const pullRequestNumber: unknown = request.pullRequestNumber;
      const headOid: unknown = request.headOid;
      const deadlineIso: unknown = request.deadlineIso;
      if (typeof owner !== 'string' || !REPOSITORY_PATTERN.test(owner)) return unavailable('invalid-request');
      if (typeof repo !== 'string' || !REPOSITORY_PATTERN.test(repo)) return unavailable('invalid-request');
      if (typeof pullRequestNumber !== 'number' || !Number.isSafeInteger(pullRequestNumber) || pullRequestNumber < 1) {
        return unavailable('invalid-request');
      }
      if (typeof headOid !== 'string' || !HEX_40.test(headOid)) return unavailable('invalid-request');
      if (typeof deadlineIso !== 'string') return unavailable('invalid-request');

      const deadlineMs = Date.parse(deadlineIso);
      if (!Number.isFinite(deadlineMs)) return unavailable('invalid-deadline');
      const remainingMs = deadlineMs - this.now();
      if (remainingMs < BUDGET_MIN_REMAINING_MS) return unavailable('budget-exhausted');
      const callMs = Math.min(this.timeoutMs, remainingMs);

      const raced = await raceGh(this.runGh, [
        'api', 'graphql',
        '-f', `query=${MERGE_VETO_STATE_QUERY}`,
        '-f', `owner=${owner}`,
        '-f', `repo=${repo}`,
        '-F', `number=${pullRequestNumber}`,
      ], callMs);
      if (raced.kind === 'failed') return unavailable('forge-call-failed');
      if (raced.kind === 'timed-out') return unavailable('forge-timeout');

      const gh = raced.gh;
      if (!isRecord(gh) || typeof gh.exitCode !== 'number') {
        return unavailable('forge-answer-malformed');
      }
      if (gh.exitCode !== 0) return unavailable('forge-exit-nonzero');
      if (typeof gh.stdout !== 'string') return unavailable('forge-answer-malformed');
      if (gh.stdout.trim() === '') return unavailable('forge-output-empty');
      if (Buffer.byteLength(gh.stdout, 'utf8') > MAX_STDOUT_BYTES) {
        return unavailable('forge-output-too-large');
      }
      return parseMergeVetoState(gh.stdout, headOid);
    } catch {
      return unavailable('state-read-failed');
    }
  }
}
