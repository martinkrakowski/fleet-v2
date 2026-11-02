/**
 * The `merge` command group of the CLI driver (plan DT4). Flags only; the
 * driver mints ULIDs and computes fresh deadlines, never the store.
 */

import { str, optNum, CliUsageError, type Payload } from './commands/payload.js';
import type { CommandHandler } from './commands/payload.js';

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
};
