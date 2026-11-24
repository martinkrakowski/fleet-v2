// EV1b: `premergePosterLogin` flows from the resolved installation merge policy through
// `MergePolicyAdapter` and `toDaemonRepositoryRefs` into `RunMergePassUseCase`.
import { describe, expect, it } from 'vitest';

import {
  DAEMON_RECORD_VERSION,
  buildDaemonStatusRecord,
  LaneRunJournalAdapter,
  MergePolicyAdapter,
  MERGE_QUEUE_ENTRY_VERSION,
  RunDaemonTickUseCase,
  RunMergePassUseCase,
  mergeQueueRepositoryDigest,
} from '@fleet/work-execution';
import type {
  ForgeMergeReadPort,
  MergePolicySource,
  MergeQueueEntryRecord,
  MergeQueueTransitionCommand,
  MergeRepoPolicy,
  ReadForgeMergeResult,
  RunDaemonTickDependencies,
} from '@fleet/work-execution';
import { toDaemonRepositoryRefs } from '../composition/daemon.js';

const OWNER = 'fleet';
const REPO = 'v2';
const PROJECT_ID = 'proj-1';
const REVISION = '0123456789ab';
const HEAD = '0123456789abcdef0123456789abcdef01234567';
const HEAD12 = '0123456789ab';
const NOW = '2026-11-01T12:00:00.000Z';
const DEADLINE = '2026-11-01T12:10:00.000Z';
const POSTER = 'fleet-premerge';

let ulidCounter = 0;
function nextUlid(): string {
  ulidCounter += 1;
  return '01JB' + String(ulidCounter).padStart(22, '0').slice(-22);
}

/** A resolved installation source carrying exactly the keys the adapter declares. */
function resolvedSource(repository: Record<string, unknown>): Record<string, unknown> {
  return {
    outcome: 'resolved',
    policyRevision: REVISION,
    repositories: [repository],
    daemon: {
      intervalSeconds: 60,
      budgetSeconds: 30,
      settleSeconds: 5,
      chainRefresh: 'shadow',
    },
  };
}

function repositoryRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    owner: OWNER,
    repo: REPO,
    repositoryKey: `${OWNER}/${REPO}`,
    projectId: PROJECT_ID,
    shadow: true,
    unattended: true,
    requiredContexts: ['gate', 'premerge'],
    updateBranch: false,
    macosProcedure: null,
    maxAttempts: 2,
    checksGraceMinutes: 10,
    veto: { mode: 'off', holdConfidence: 0.5 },
    ...overrides,
  };
}

function adapterFor(source: unknown): MergePolicyAdapter {
  return new MergePolicyAdapter({
    readInstallation: async () => source as MergePolicySource,
  });
}

describe('MergePolicyAdapter + toDaemonRepositoryRefs forward premergePosterLogin', () => {
  it('a resolved poster login answers known and is carried unchanged into the daemon ref policy', async () => {
    for (const poster of [POSTER, 'a', 'pre--merge']) {
      const answer = await adapterFor(resolvedSource(repositoryRecord({ premergePosterLogin: poster })))
        .readMergePolicy();
      expect(answer.outcome).toBe('known');
      if (answer.outcome !== 'known') {
        return;
      }
      expect(answer.repositories[0].premergePosterLogin).toBe(poster);
      const [ref] = toDaemonRepositoryRefs(answer);
      expect(ref.policy.premergePosterLogin).toBe(poster);
    }
  });

  it('an absent or null poster answers known with null, is omitted from the ref policy, and the daemon tick accepts the ref', async () => {
    for (const repository of [repositoryRecord(), repositoryRecord({ premergePosterLogin: null })]) {
      const answer = await adapterFor(resolvedSource(repository)).readMergePolicy();
      expect(answer.outcome).toBe('known');
      if (answer.outcome !== 'known') {
        return;
      }
      expect(answer.repositories[0].premergePosterLogin).toBeNull();
      const [ref] = toDaemonRepositoryRefs(answer);
      expect('premergePosterLogin' in ref.policy).toBe(false);
      // The daemon tick itself (not just the registry) accepts the ref: a tick
      // serving only this repository completes instead of refusing it.
      const tick = new RunDaemonTickUseCase(tickDeps());
      const result = await tick.runTick({
        tickId: `tick-${nextUlid()}`,
        repositories: [ref],
        forgeReachable: true,
      });
      expect(result.outcome).toBe('completed');
      expect(result.exitCode).toBe(0);
      expect(result.jobs).toHaveLength(1);
    }
  });
});

/** Minimal daemon-tick ports: a clear clock, an empty queue and one completed merge pass. */
function tickDeps(): RunDaemonTickDependencies {
  return {
    pause: { read: async () => ({ state: 'clear', record: null }) },
    halt: { read: async () => ({ state: 'clear', record: null }) },
    status: {
      read: async () => ({ status: 'missing' }),
      write: async (input) => buildDaemonStatusRecord(input),
    },
    lease: {
      read: async () => null,
      acquire: async (request) => ({
        outcome: 'ok',
        lease: {
          version: DAEMON_RECORD_VERSION,
          scope: request.scope,
          holderId: request.holderId,
          fence: 1,
          leaseUntilIso: request.leaseUntilIso,
        },
      }),
      release: async (request) => ({
        outcome: 'ok',
        lease: {
          version: DAEMON_RECORD_VERSION,
          scope: request.scope,
          holderId: request.holderId,
          fence: request.fence,
          leaseUntilIso: request.nowIso,
        },
      }),
    },
    events: { append: async (events) => ({ appended: events.length }) },
    queue: { listMergeEntries: async () => [] },
    forge: { isConfigured: () => true },
    journal: { listForKey: async () => [] },
    mergePass: {
      runMergePass: async () => ({ outcome: 'completed', reasonCode: null, entries: [] }),
    },
    now: () => NOW,
    sleep: async () => {},
    newUlid: nextUlid,
  };
}

describe('MergePolicyAdapter refuses hostile premergePosterLogin and record shapes', () => {
  it.each<[string, unknown]>([
    ['a number', 42],
    ['an empty string', ''],
    ['whitespace only', '   '],
    ['an object', {}],
    ['an array', ['bot']],
    ['an own key holding undefined', undefined],
    ['a leading hyphen', '-bot'],
    ['a trailing hyphen', 'bot-'],
    ['a dot', 'bad.login'],
    ['an underscore', 'bad_bot'],
    ['a bot suffix', 'github-actions[bot]'],
    ['a 40-character string', 'a'.repeat(40)],
  ])('refuses %s as premergePosterLogin with installation-invalid', async (_label, value) => {
    const source = resolvedSource(repositoryRecord({ premergePosterLogin: value }));
    const answer = await adapterFor(source).readMergePolicy();
    expect(answer).toEqual({ outcome: 'unknown', reason: 'installation-invalid' });
  });

  it('reads a getter-bearing premergePosterLogin without ever invoking the getter and refuses the record', async () => {
    let reads = 0;
    const repository: Record<string, unknown> = repositoryRecord();
    Object.defineProperty(repository, 'premergePosterLogin', {
      enumerable: true,
      get() {
        reads += 1;
        return POSTER;
      },
    });
    const answer = await adapterFor(resolvedSource(repository)).readMergePolicy();
    expect(reads).toBe(0);
    expect(answer).toEqual({ outcome: 'unknown', reason: 'installation-invalid' });
  });

  it('refuses a Proxy that reports a getter for the poster key without invoking it', async () => {
    let reads = 0;
    const repository = repositoryRecord({ premergePosterLogin: POSTER });
    const proxied: Record<string, unknown> = new Proxy(repository, {
      getOwnPropertyDescriptor(target, key) {
        if (key === 'premergePosterLogin') {
          return { enumerable: true, configurable: true, get() { reads += 1; return POSTER; } };
        }
        return Object.getOwnPropertyDescriptor(target, key);
      },
    });
    const answer = await adapterFor(resolvedSource(proxied as Record<string, unknown>)).readMergePolicy();
    expect(reads).toBe(0);
    expect(answer).toEqual({ outcome: 'unknown', reason: 'installation-invalid' });
  });

  it('refuses a repository record carrying an extra own key', async () => {
    const answer = await adapterFor(resolvedSource(repositoryRecord({ extra: 1 }))).readMergePolicy();
    expect(answer).toEqual({ outcome: 'unknown', reason: 'installation-invalid' });
  });

  it('answers installation-unreadable when readInstallation rejects', async () => {
    const adapter = new MergePolicyAdapter({
      readInstallation: () => Promise.reject(new Error('unreadable')),
    });
    const answer = await adapter.readMergePolicy();
    expect(answer).toEqual({ outcome: 'unknown', reason: 'installation-unreadable' });
  });
});

function makeEntry(repoDigest: string): MergeQueueEntryRecord {
  return {
    version: MERGE_QUEUE_ENTRY_VERSION,
    entryId: nextUlid(),
    repository: { owner: OWNER, repo: REPO },
    repoDigest,
    pullRequest: 1,
    headOid: HEAD,
    state: 'queued',
    reason: null,
    attempt: 0,
    notBeforeIso: null,
    enqueuedAtIso: NOW,
    enqueuedBy: 'conductor',
    supersedes: null,
    runId: null,
    attemptId: null,
    workOrderId: null,
    tier: 0,
    verifiedHeadOid: null,
    verifiedBy: null,
    policyRevision: null,
    premergeReceiptHeadOid: null,
    veto: null,
    mergeCommitOid: null,
    mergedAtIso: null,
    revision: 1,
  };
}

function forgeReadFake(result: ReadForgeMergeResult): ForgeMergeReadPort {
  return {
    isConfigured: () => true,
    async readForgeMerge() {
      return result;
    },
  };
}

async function runEndToEndPass(
  creatorLogin: string,
  poster = POSTER,
): Promise<{
  reasonCode: string | null;
  decision: string;
  journalKey: string | null;
  /** The queue record a persisted transition wrote, null when nothing persisted. */
  persisted: MergeQueueEntryRecord | null;
}> {
  const transitions: MergeQueueTransitionCommand[] = [];
  const answer = await adapterFor(
    resolvedSource(repositoryRecord({ premergePosterLogin: poster })),
  ).readMergePolicy();
  if (answer.outcome !== 'known') {
    throw new Error('fixture policy must resolve');
  }
  const [ref] = toDaemonRepositoryRefs(answer);
  const entry = makeEntry(ref.repoDigest);
  const journal = new LaneRunJournalAdapter();
  const useCase = new RunMergePassUseCase({
    queue: {
      async listMergeEntries() {
        return [entry];
      },
    },
    forgeRead: forgeReadFake({
      outcome: 'ok',
      prState: 'open',
      liveHeadSha: HEAD,
      mergeState: 'clean',
      contexts: [
        { name: 'gate', state: 'SUCCESS', isGreen: true, creatorLogin: null },
        { name: 'premerge', state: 'SUCCESS', isGreen: true, creatorLogin },
      ],
      unresolvedThreads: 0,
    }),
    verification: {
      async readVerification() {
        return { outcome: 'unknown', reasonCode: 'no-receipt' };
      },
      async runVerification() {
        throw new Error('not used');
      },
    },
    journal,
    queueWriter: {
      async applyMergeTransition(command: MergeQueueTransitionCommand) {
        transitions.push(command);
        return {
          outcome: 'applied' as const,
          entries: [command.next],
          record: command.next,
          successor: command.successor ?? null,
        };
      },
    },
    halt: {
      async read() {
        return { state: 'clear', record: null };
      },
    },
    newUlid: () => nextUlid(),
    nowIso: () => NOW,
  });
  const result = await useCase.runMergePass({
    repository: { owner: OWNER, repo: REPO },
    repoDigest: ref.repoDigest,
    projectId: PROJECT_ID,
    policy: ref.policy as MergeRepoPolicy,
    deadlineIso: DEADLINE,
  });
  expect(ref.repoDigest).toBe(mergeQueueRepositoryDigest(answer.repositories[0]));
  expect(result.entries).toHaveLength(1);
  return {
    reasonCode: result.entries[0].reasonCode,
    decision: result.entries[0].decision,
    journalKey: result.entries[0].journalKey,
    persisted: transitions.length > 0 ? transitions[0].next : null,
  };
}

describe('RunMergePassUseCase over the forwarded policy (end to end)', () => {
  it('a matching premerge poster journals would-merge instead of parking on checks', async () => {
    const pass = await runEndToEndPass(POSTER);
    expect(pass.decision).toBe('journalled');
    expect(pass.reasonCode).toBe('would-merge');
    expect(pass.journalKey).toBe(`merge/${(await digestOf())[0]}/1/${HEAD12}/merge-pr`);
  });

  it('the premerge poster matches case-insensitively (Martin-K matches martin-k)', async () => {
    const pass = await runEndToEndPass('Martin-K', 'martin-k');
    expect(pass.decision).toBe('journalled');
    expect(pass.reasonCode).toBe('would-merge');
    // The receipt recorded on the ready entry uses the same match as the decider.
    expect(pass.persisted?.premergeReceiptHeadOid).toBe(HEAD);
  });

  it('a mismatched premerge poster persists the entry as parked on checks and journals no merge key', async () => {
    const pass = await runEndToEndPass('someone-else');
    expect(pass.decision).toBe('recorded');
    expect(pass.reasonCode).toBe('checks');
    expect(pass.journalKey).toBeNull();
    expect(pass.persisted).not.toBeNull();
    expect(pass.persisted?.state).toBe('parked');
    expect(pass.persisted?.reason).toBe('checks');
  });
});

async function digestOf(): Promise<readonly string[]> {
  const answer = await adapterFor(
    resolvedSource(repositoryRecord({ premergePosterLogin: POSTER })),
  ).readMergePolicy();
  if (answer.outcome !== 'known') {
    throw new Error('fixture policy must resolve');
  }
  return toDaemonRepositoryRefs(answer).map((ref) => ref.repoDigest);
}
