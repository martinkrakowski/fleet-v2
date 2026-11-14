/**
 * The `merge` command group of the CLI driver (plan DT4). Flags only; the
 * driver mints ULIDs and computes fresh deadlines, never the store.
 */

import {
  str,
  strArr,
  optNum,
  optStr,
  parseDurationOption,
  sleep,
  CliUsageError,
  DEFAULT_WAIT_MAX_MS,
  DEFAULT_WAIT_INTERVAL_MS,
  type Payload,
} from './commands/payload.js';
import type { CommandHandler } from './commands/payload.js';
import type { InspectMergeReadinessResult } from '@fleet/work-execution';
import type { FleetCliRuntime } from './composition.js';

const REPOSITORY_SEGMENT_PATTERN = /^[A-Za-z0-9_.-]{1,100}$/;
const HEAD40_PATTERN = /^[0-9a-f]{40}$/;

/** Parse `--repository owner/repo`; undefined when absent, usage error when malformed. */
function repositoryFromPayload(p: Payload): { owner: string; repo: string } | undefined {
  const raw = str(p, 'repository').trim();
  if (raw === '') {
    return undefined;
  }
  const segments = raw.split('/');
  if (segments.length !== 2) {
    throw new CliUsageError('merge commands require --repository as owner/repo');
  }
  const [owner, repo] = segments;
  if (
    !REPOSITORY_SEGMENT_PATTERN.test(owner) ||
    !REPOSITORY_SEGMENT_PATTERN.test(repo) ||
    owner === '.' ||
    owner === '..' ||
    repo === '.' ||
    repo === '..'
  ) {
    throw new CliUsageError('merge commands require --repository as owner/repo with valid segments');
  }
  return { owner, repo };
}

function requiredEntryId(p: Payload, subcommand: string): string {
  const entryId = str(p, 'entryId').trim();
  if (entryId === '') {
    throw new CliUsageError(`merge ${subcommand} requires --entry-id`);
  }
  return entryId;
}

/** CO25: the default `--timeout` for one readiness read (30 s). */
const DEFAULT_READINESS_TIMEOUT_MS = 30 * 1000;
/** CO25: one required context name pattern (mirrors the CLI repository segments). */
const CONTEXT_NAME_PATTERN = /^[A-Za-z0-9_.-]{1,100}$/;

function requiredPullRequest(p: Payload, subcommand: string): number {
  const raw = p['pullRequest'];
  if (typeof raw === 'boolean') {
    throw new CliUsageError(`merge ${subcommand}: --pull-request must be a positive integer`);
  }
  const n = optNum(p, 'pullRequest');
  if (n === undefined || !Number.isSafeInteger(n) || n < 1) {
    throw new CliUsageError(`merge ${subcommand}: --pull-request must be a positive integer`);
  }
  return n;
}

function optionalHead(p: Payload, subcommand: string): string | null {
  const head = optStr(p, 'head');
  if (head === undefined) {
    return null;
  }
  if (!HEAD40_PATTERN.test(head)) {
    throw new CliUsageError(`merge ${subcommand}: --head must be 40 lowercase hex characters`);
  }
  return head;
}

function requiredContextsOf(p: Payload, subcommand: string): string[] {
  const raw = p['contexts'];
  if (raw === undefined) {
    return ['gate'];
  }
  if (typeof raw !== 'string' && !Array.isArray(raw)) {
    throw new CliUsageError(`merge ${subcommand}: --contexts must be a comma-separated list of context names`);
  }
  const contexts = strArr(p, 'contexts');
  for (const name of contexts) {
    if (!CONTEXT_NAME_PATTERN.test(name)) {
      throw new CliUsageError(`merge ${subcommand}: --contexts must be a comma-separated list of context names`);
    }
  }
  return contexts;
}

export const mergeCommands: Readonly<Record<string, CommandHandler>> = {
  enqueue: async (p, rt) => {
    const nowIso = new Date().toISOString();
    const deadlineIso = new Date(Date.now() + 60_000).toISOString();
    const repository = repositoryFromPayload(p);
    if (repository === undefined) {
      throw new CliUsageError('merge enqueue requires --repository owner/repo');
    }
    const pullRequest = optNum(p, 'pullRequest');
    if (pullRequest === undefined || !Number.isSafeInteger(pullRequest) || pullRequest < 1) {
      throw new CliUsageError('merge enqueue: --pull-request must be a positive integer');
    }
    const head = str(p, 'head');
    if (!HEAD40_PATTERN.test(head)) {
      throw new CliUsageError('merge enqueue: --head must be 40 lowercase hex characters');
    }
    let tier = 2;
    const tierRaw = p['tier'];
    if (tierRaw !== undefined) {
      if (
        tierRaw !== 0 &&
        tierRaw !== 1 &&
        tierRaw !== 2 &&
        tierRaw !== '0' &&
        tierRaw !== '1' &&
        tierRaw !== '2'
      ) {
        throw new CliUsageError('merge enqueue: --tier must be 0, 1 or 2');
      }
      tier = Number(tierRaw);
    }
    return rt.execution.enqueueMerge.enqueue({
      repository,
      pullRequest,
      headOid: head,
      tier,
      enqueuedBy: 'cli',
      runId: null,
      entryId: rt.conductor.newUlid(),
      successorEntryId: rt.conductor.newUlid(),
      enqueuedAtIso: nowIso,
      deadlineIso,
    });
  },
  list: async (p, rt) => {
    const deadlineIso = new Date(Date.now() + 60_000).toISOString();
    const repository = repositoryFromPayload(p);
    return rt.execution.listMergeQueue.list({ repository, deadlineIso });
  },
  drop: async (p, rt) => {
    const deadlineIso = new Date(Date.now() + 60_000).toISOString();
    const entryId = requiredEntryId(p, 'drop');
    const decision = await rt.execution.mergeQueueRepository.dropMergeEntry({ entryId, deadlineIso });
    if (decision.outcome === 'refused') {
      return { outcome: 'refused', reason: decision.reason };
    }
    return decision;
  },
  retry: async (p, rt) => {
    const nowIso = new Date().toISOString();
    const deadlineIso = new Date(Date.now() + 60_000).toISOString();
    const entryId = requiredEntryId(p, 'retry');
    return rt.execution.mergeQueueRepository.retryMergeEntry({
      entryId,
      retryEntryId: rt.conductor.newUlid(),
      enqueuedAtIso: nowIso,
      deadlineIso,
    });
  },
  import: async (p, rt) => {
    const repository = repositoryFromPayload(p);
    if (repository === undefined) {
      throw new CliUsageError('merge import requires --repository owner/repo');
    }
    const stateDir = str(p, 'legacyStateDir').trim();
    if (stateDir === '') {
      throw new CliUsageError('merge import requires --legacy-state-dir');
    }
    const apply = p['apply'] === true || p['apply'] === 'true';
    const authority = optStr(p, 'authority') ?? null;
    if (apply && authority === null) {
      throw new CliUsageError('merge import --apply requires --authority');
    }
    return rt.execution.importTrainState.importTrainState({ repository, stateDir, apply, authority });
  },
  export: async (p, rt) => {
    for (const key of Object.keys(p)) {
      if (key !== 'legacy' && key !== 'repository' && key !== 'positional') {
        throw new CliUsageError('merge export does not accept an unknown flag');
      }
    }
    const positional = p['positional'];
    if (positional !== undefined) {
      if (Array.isArray(positional) ? positional.length > 0 : positional !== '') {
        throw new CliUsageError('merge export does not accept an unknown flag');
      }
    }
    if (p['legacy'] !== true && p['legacy'] !== 'true') {
      throw new CliUsageError('merge export requires --legacy');
    }
    const repository = repositoryFromPayload(p);
    if (repository === undefined) {
      throw new CliUsageError('merge export requires --repository owner/repo');
    }
    return rt.execution.exportLegacyTrainState.exportLegacyTrainState({ repository });
  },
  ready: async (p, rt) => {
    const repository = repositoryFromPayload(p);
    if (repository === undefined) {
      throw new CliUsageError('merge ready requires --repository owner/repo');
    }
    const pullRequest = requiredPullRequest(p, 'ready');
    const expectedHeadOid = optionalHead(p, 'ready');
    const requiredContexts = requiredContextsOf(p, 'ready');
    const timeoutMs = parseDurationOption(p, 'timeout', DEFAULT_READINESS_TIMEOUT_MS);
    const deadlineIso = new Date(Date.now() + timeoutMs).toISOString();
    return rt.execution.inspectMergeReadiness.inspectMergeReadiness({
      repository,
      pullRequest,
      expectedHeadOid,
      requiredContexts,
      deadlineIso,
    });
  },
  wait: async (p, rt) => runMergeWait(p, rt, SYSTEM_WAIT_CLOCK),
};

/** The clock one `merge wait` loop reads; the system clock in production, a fake in tests. */
export interface MergeWaitClock {
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
}

const SYSTEM_WAIT_CLOCK: MergeWaitClock = { now: () => Date.now(), sleep };

/** The absolute deadline of one readiness read: never past the remaining `--max` budget. */
function readDeadlineIso(clock: MergeWaitClock, timeoutMs: number, remainingMs: number): string {
  return new Date(clock.now() + Math.min(timeoutMs, remainingMs)).toISOString();
}

/**
 * One `merge wait` answer: the port's answers, or the CLI-level wait-timeout
 * wrapper that adds the last read's own reason.
 */
type MergeWaitResult =
  | InspectMergeReadinessResult
  | { outcome: 'still-waiting'; reason: 'wait-timeout'; lastReason: string };

/**
 * The answer a spent budget reports: the typed wait-timeout for a read that was
 * still waiting or could not decide (unknown, for example a deadline under the
 * adapter's budget floor or a forge read cut short), the settled answer itself
 * otherwise.
 */
function budgetSpentResult(answer: InspectMergeReadinessResult): MergeWaitResult {
  if (answer.outcome === 'still-waiting' || answer.outcome === 'unknown') {
    return { outcome: 'still-waiting', reason: 'wait-timeout', lastReason: answer.reason };
  }
  return answer;
}

/**
 * CO25: `merge wait` polls the readiness read until it answers ready (or
 * answers a settled not-open reason). The `--max` budget bounds the whole
 * wait, including any in-flight read: every read's deadline is
 * `min(--timeout, remaining budget)`, so the forge read cannot run past the
 * budget, and a spent budget returns the typed `still-waiting` timeout
 * without starting another read. The clock is injectable for tests.
 */
export async function runMergeWait(
  p: Payload,
  rt: FleetCliRuntime,
  clock: MergeWaitClock,
): Promise<unknown> {
  const repository = repositoryFromPayload(p);
  if (repository === undefined) {
    throw new CliUsageError('merge wait requires --repository owner/repo');
  }
  const pullRequest = requiredPullRequest(p, 'wait');
  const expectedHeadOid = optionalHead(p, 'wait');
  const requiredContexts = requiredContextsOf(p, 'wait');
  const timeoutMs = parseDurationOption(p, 'timeout', DEFAULT_READINESS_TIMEOUT_MS);
  const maxMs = parseDurationOption(p, 'max', DEFAULT_WAIT_MAX_MS);
  const intervalMs = parseDurationOption(p, 'interval', DEFAULT_WAIT_INTERVAL_MS);
  if (maxMs <= 0) {
    throw new CliUsageError("merge wait: '--max' must be greater than zero");
  }
  if (intervalMs <= 0) {
    throw new CliUsageError("merge wait: '--interval' must be greater than zero");
  }
  const budgetEnd = clock.now() + maxMs;
  const readOnce = (deadlineIso: string) =>
    rt.execution.inspectMergeReadiness.inspectMergeReadiness({
      repository,
      pullRequest,
      expectedHeadOid,
      requiredContexts,
      deadlineIso,
    });

  let answer = await readOnce(readDeadlineIso(clock, timeoutMs, maxMs));
  for (;;) {
    if (answer.outcome === 'ready') {
      return answer;
    }
    if (answer.outcome === 'still-waiting' && answer.reason === 'not-open') {
      return answer;
    }
    if (budgetEnd - clock.now() <= 0) {
      return budgetSpentResult(answer);
    }
    await clock.sleep(Math.min(intervalMs, budgetEnd - clock.now()));
    const remainingBudget = budgetEnd - clock.now();
    if (remainingBudget <= 0) {
      return budgetSpentResult(answer);
    }
    answer = await readOnce(readDeadlineIso(clock, timeoutMs, remainingBudget));
  }
}
