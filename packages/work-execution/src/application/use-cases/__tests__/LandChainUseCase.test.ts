// Lane CO10: LandChainUseCase — the adversarial parser, the read phase, the
// keyed intent + compare-and-set landing mark, the post-mark re-check with
// withdrawal, and the enqueue. Every fake below is in-memory.
import { describe, expect, it } from 'vitest';

import { telemetryHashInput } from '../../../domain/run-telemetry-ids.js';
import type { ChainRecord } from '../../../domain/chain-records.js';
import type { LandChainResult } from '../../ports/in/LandChainPort.in-port.js';
import type { ChainLandingPort } from '../../ports/out/ChainLandingPort.out-port.js';
import {
  LandChainUseCase,
  canonicalLandChainPayload,
  type LandChainDependencies,
} from '../LandChainUseCase.use-case.js';

const OWNER = 'own';
const REPO = 'rep';
const PROJECT = 'proj';
const CHAIN = 'alpha';
const BRANCH = 'chain/alpha';
const TIP = 'a'.repeat(40);
const OTHER_SHA = 'b'.repeat(40);
const NOW = '2026-11-16T12:00:00.000Z';
const FUTURE = '2026-11-16T13:00:00.000Z';
const REQUEST_ID = 'req-1';
const LINK_PR = 21;
const ATTEMPT_ID = 'att-1';
const RUN_ID = 'run-1';

const BASE_COMMAND = {
  projectId: PROJECT,
  repository: { owner: OWNER, repo: REPO },
  chainName: CHAIN,
  nowIso: NOW,
  deadlineIso: FUTURE,
  dryRun: false,
};

function digest(text: string): string {
  let hash = 0x811c9dc5;
  for (let at = 0; at < text.length; at += 1) {
    hash ^= text.charCodeAt(at);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function hashInput(value: string) {
  const minted = telemetryHashInput(value);
  if (minted === null) {
    throw new Error('bad hash input');
  }
  return minted;
}

function chainRecord(overrides: Partial<ChainRecord> = {}): ChainRecord {
  return {
    schemaVersion: 1,
    repository: { owner: OWNER, repo: REPO },
    chainName: CHAIN,
    branchName: BRANCH,
    sourceBranch: 'main',
    expectedHeadSha: OTHER_SHA,
    actionKey: 'chain-start/alpha',
    state: 'started',
    reason: null,
    createdAtIso: NOW,
    revision: 2,
    reviewPin: { headSha: TIP, requestId: REQUEST_ID, key: `chain-review/${CHAIN}@${TIP.slice(0, 12)}`, pinnedAtIso: NOW },
    ...overrides,
  } as ChainRecord;
}

function laneRun(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    runId: RUN_ID,
    workOrderId: 'wo-1',
    tier: 1,
    seatPlanRef: 'sp',
    cursors: {},
    round: 0,
    attemptIds: [ATTEMPT_ID],
    prNumber: LINK_PR,
    parked: null,
    parkCount: 0,
    lease: null,
    revision: 1,
    runPolicyRevision: 'p',
    baseBranch: BRANCH,
    ...overrides,
  };
}

function attemptRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: ATTEMPT_ID,
    workOrderId: 'wo-1',
    kind: 'implement',
    fixNumber: 0,
    priorAttemptId: null,
    worktreePath: '/wt',
    baseCommit: OTHER_SHA,
    state: 'completed',
    outcome: 'merged',
    briefDigest: null,
    briefPackagePath: null,
    sessionId: null,
    completionReceipt: { receiptId: 'c1' },
    artifacts: { headCommit: TIP },
    ...overrides,
  };
}

function preMergeReceipt(result = 'pass') {
  return {
    receiptId: hashInput(`receipt:${result}`),
    kind: 'pre-merge',
    result,
    findings: { blocker: 0, major: 0, minor: 0, nit: 0 },
    completedAtIso: NOW,
  };
}

function pullRequestSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    number: 0,
    state: 'open',
    mergeState: 'clean',
    headSha: TIP,
    headRef: BRANCH,
    baseRef: 'main',
    isCrossRepository: false,
    headRepositoryOwner: OWNER,
    mergedAtIso: null,
    closedAtIso: null,
    mergeCommitSha: null,
    ...overrides,
  };
}

interface JournalEntryShape {
  key: string;
  kind: 'intent' | 'result';
  entryId: string;
  recordedAtIso: string;
  digest: string;
  deadlineIso: string;
}

interface FakeLanding extends ChainLandingPort {
  journal: Map<string, JournalEntryShape[]>;
  marks: Map<string, { revision: number; mark: { headSha: string; pullRequestNumber: number; key: string; state: 'landing' | 'withdrawn' } }>;
  calls: { openOrAdopt: number };
}

function makeLanding(): FakeLanding {
  const journal = new Map<string, JournalEntryShape[]>();
  const marks = new Map<string, { revision: number; mark: { headSha: string; pullRequestNumber: number; key: string; state: 'landing' | 'withdrawn' } }>();
  const calls = { openOrAdopt: 0 };
  const keyOf = (repository: { owner: string; repo: string }, chainName: string): string => `${repository.owner}/${repository.repo}#${chainName}`;
  return {
    journal,
    marks,
    calls,
    async append(entry) {
      const entries = journal.get(entry.key) ?? [];
      if (entry.kind === 'intent' && entries.some((existing) => existing.kind === 'intent')) {
        return { outcome: 'refused', reason: 'duplicate-intent' };
      }
      if (typeof entry.key !== 'string' || entry.key.length === 0 || typeof entry.digest !== 'string' || entry.digest.length === 0) {
        return { outcome: 'refused', reason: 'invalid-entry' };
      }
      entries.push({ ...entry });
      journal.set(entry.key, entries);
      return { outcome: 'appended' };
    },
    async listByKey(key) {
      return { outcome: 'listed', entries: [...(journal.get(key) ?? [])] };
    },
    async readMark({ repository, chainName }) {
      const stored = marks.get(keyOf(repository, chainName));
      return stored === undefined ? { outcome: 'missing', revision: 0 } : { outcome: 'found', mark: { ...stored.mark, revision: stored.revision } };
    },
    async compareAndSetMark({ repository, chainName, expectedRevision, mark }) {
      const id = keyOf(repository, chainName);
      const stored = marks.get(id);
      if (stored === undefined) {
        if (expectedRevision !== 0) {
          return { outcome: 'refused', reason: 'stale-revision' };
        }
        marks.set(id, { revision: 1, mark: { ...mark } });
        return { outcome: 'recorded', revision: 1 };
      }
      if (stored.revision !== expectedRevision) {
        return { outcome: 'refused', reason: 'stale-revision' };
      }
      if (stored.mark.state === 'landing' && (stored.mark.headSha !== mark.headSha || stored.mark.key !== mark.key)) {
        return { outcome: 'refused', reason: 'conflict' };
      }
      stored.revision += 1;
      stored.mark = { ...mark };
      return { outcome: 'recorded', revision: stored.revision };
    },
    async openOrAdopt(command) {
      calls.openOrAdopt += 1;
      if (command.mode === 'adopt') {
        return { outcome: 'adopted', pullRequestNumber: command.pullRequestNumber ?? 0, headSha: command.expectedHeadSha };
      }
      return { outcome: 'opened', pullRequestNumber: 77, headSha: command.expectedHeadSha };
    },
    async unfinishedBatch() {
      return { outcome: 'none' };
    },
  };
}

interface World {
  deps: LandChainDependencies;
  landing: FakeLanding;
  calls: {
    readReceiptsForHead: number;
    enqueueMergeEntry: number;
    performMergeForgeAction: number;
    openOrAdopt: number;
    enqueued: { tier: number; entryId: string; successorEntryId: string }[];
  };
}

interface Overrides {
  chainRecord?: Partial<ChainRecord> | ((record: ChainRecord) => ChainRecord);
  laneRuns?: unknown;
  attempts?: Map<string, Record<string, unknown> | null>;
  queueEntries?: Record<string, unknown>[];
  enqueueDecision?: { outcome: string; recordEntryId?: string };
  linkPullRequest?: Record<string, unknown> | 'unavailable' | 'not-found';
  openPullRequests?: { number: number; headSha: string }[] | 'unreadable';
  /** What reading a head-lookup candidate other than the link PR answers. */
  candidatePullRequest?: 'not-found' | 'unavailable';
  integrationPullRequest?: Record<string, unknown>;
  reviewReceipt?: 'not-found' | { candidateHeadSha?: string; kind?: string; verdict?: string };
  linkReceipts?: 'none' | 'unavailable' | ((attemptId: string, headSha: string) => unknown);
  containsCommit?: { outcome: 'answered'; contains: boolean } | { outcome: 'unavailable'; reason: string };
  unfinishedBatch?: 'none' | 'targets' | 'unreadable' | 'missing-method';
  mergeBranchHead?: { outcome: 'found'; headSha: string } | { outcome: 'not-found' } | { outcome: 'unavailable'; reason: string } | 'throw';
  readChain?: { status: 'ok'; record: ChainRecord } | { status: 'not-found' } | { status: 'unreadable'; reason: string } | 'throw';
  journalFail?: 'list' | 'append' | 'mark' | 'cas-stale' | 'cas-conflict';
  mintThrows?: boolean;
  clock?: () => string;
  postStatusOutcome?: { outcome: string; reason?: string };
  openOrAdoptOutcome?: { outcome: string; reason?: string; pullRequestNumber?: number; headSha?: string };
}

function makeWorld(overrides: Overrides = {}): World {
  const calls: World['calls'] = {
    readReceiptsForHead: 0,
    enqueueMergeEntry: 0,
    performMergeForgeAction: 0,
    openOrAdopt: 0,
    enqueued: [],
  };
  const landing = makeLanding();
  // One shared call counter for both the world's and the fake's assertions.
  (landing as unknown as { calls: World['calls'] }).calls = calls;
  landing.openOrAdopt = async (command) => {
    calls.openOrAdopt += 1;
    if (overrides.openOrAdoptOutcome?.outcome === 'refused') {
      return { outcome: 'refused', reason: overrides.openOrAdoptOutcome.reason ?? 'no' };
    }
    if (overrides.openOrAdoptOutcome?.outcome === 'ambiguous') {
      return { outcome: 'ambiguous', reason: 'unclear' };
    }
    if (command.mode === 'adopt') {
      return { outcome: 'adopted', pullRequestNumber: command.pullRequestNumber ?? 0, headSha: command.expectedHeadSha };
    }
    return { outcome: 'opened', pullRequestNumber: overrides.openOrAdoptOutcome?.pullRequestNumber ?? 77, headSha: command.expectedHeadSha };
  };
  if (overrides.unfinishedBatch === 'missing-method') {
    delete (landing as Partial<ChainLandingPort>).unfinishedBatch;
  } else if (overrides.unfinishedBatch === 'targets') {
    landing.unfinishedBatch = async () => ({ outcome: 'targets', batchId: 'batch-1' });
  } else if (overrides.unfinishedBatch === 'unreadable') {
    landing.unfinishedBatch = async () => ({ outcome: 'unreadable' });
  }
  if (overrides.journalFail === 'list') {
    landing.listByKey = async () => ({ outcome: 'unreadable' });
  }
  if (overrides.journalFail === 'append') {
    landing.append = async () => ({ outcome: 'refused', reason: 'invalid-entry' });
  }
  if (overrides.journalFail === 'mark') {
    landing.readMark = async () => ({ outcome: 'unreadable' });
  }
  if (overrides.journalFail === 'cas-stale') {
    landing.compareAndSetMark = async () => ({ outcome: 'refused', reason: 'stale-revision' });
  }
  if (overrides.journalFail === 'cas-conflict') {
    landing.compareAndSetMark = async () => ({ outcome: 'refused', reason: 'conflict' });
  }

  const record =
    overrides.chainRecord === undefined
      ? chainRecord()
      : typeof overrides.chainRecord === 'function'
        ? overrides.chainRecord(chainRecord())
        : chainRecord(overrides.chainRecord);
  const readChainFn =
    overrides.readChain === 'throw'
      ? async () => {
          throw new Error('store down');
        }
      : async () => overrides.readChain ?? { status: 'ok' as const, record };
  const laneRuns = overrides.laneRuns === undefined ? [laneRun()] : overrides.laneRuns;
  const attempts = overrides.attempts ?? new Map([[ATTEMPT_ID, attemptRecord()]]);
  const queueEntries = overrides.queueEntries ?? [{ pullRequest: LINK_PR, state: 'merged' }];
  const linkPullRequest =
    overrides.linkPullRequest === undefined
      ? pullRequestSnapshot({ number: LINK_PR, state: 'merged', headRef: `feat/${RUN_ID}`, baseRef: BRANCH, mergedAtIso: NOW, mergeCommitSha: TIP })
      : overrides.linkPullRequest;
  const openPullRequests = overrides.openPullRequests ?? [];
  const integrationPullRequest =
    overrides.integrationPullRequest === undefined
      ? pullRequestSnapshot({ number: 77 })
      : overrides.integrationPullRequest;
  const reviewReceipt =
    overrides.reviewReceipt === undefined ? { verdict: 'passed' } : overrides.reviewReceipt;
  const linkReceipts = overrides.linkReceipts ?? 'found';
  const containsCommit = overrides.containsCommit ?? { outcome: 'answered' as const, contains: true };
  const mergeBranchHead = overrides.mergeBranchHead ?? { outcome: 'found' as const, headSha: TIP };

  const deps: LandChainDependencies = {
    chains: {
      readChain: async () => readChainFn(),
    } as unknown as LandChainDependencies['chains'],
    branches: {
      async readMergeBranchHead() {
        if (mergeBranchHead === 'throw') {
          throw new Error('forge down');
        }
        return mergeBranchHead;
      },
      async performMergeForgeAction() {
        calls.performMergeForgeAction += 1;
        const outcome = overrides.postStatusOutcome?.outcome ?? 'executed';
        if (outcome === 'refused') {
          return { outcome: 'refused', reason: overrides.postStatusOutcome?.reason ?? 'no', refusalKind: 'other' as const };
        }
        if (outcome === 'ambiguous') {
          return { outcome: 'ambiguous', reason: 'unclear' };
        }
        return { outcome: 'executed', headSha: TIP };
      },
      isConfigured: () => true,
    } as unknown as LandChainDependencies['branches'],
    forge: {
      async findOpenPullRequestsByHead() {
        if (openPullRequests === 'unreadable') {
          return { outcome: 'unreadable', reason: 'down' };
        }
        return { outcome: 'read', pullRequests: openPullRequests };
      },
    } as unknown as LandChainDependencies['forge'],
    forgeRead: {
      async readPullRequest(request: { readonly ref: { readonly kind: string; readonly number: number } }) {
        const number = request.ref.kind === 'number' ? request.ref.number : 0;
        if (number === LINK_PR) {
          if (linkPullRequest === 'unavailable') {
            return { outcome: 'unavailable', reason: 'down' };
          }
          if (linkPullRequest === 'not-found') {
            return { outcome: 'not-found' };
          }
          return { outcome: 'found', pullRequest: { ...linkPullRequest } };
        }
        if (integrationPullRequest === null) {
          return { outcome: 'unavailable', reason: 'down' };
        }
        return { outcome: 'found', pullRequest: { ...integrationPullRequest, number } };
      },
    } as unknown as LandChainDependencies['forgeRead'],
    ancestry: {
      async containsCommit() {
        return containsCommit;
      },
    },
    reviews: {
      async findReviewReceipt() {
        if (reviewReceipt === 'not-found') {
          return { outcome: 'not-found' };
        }
        return {
          outcome: 'found',
          receipt: {
            receiptId: 'r1',
            requestId: REQUEST_ID,
            kind: reviewReceipt.kind ?? 'pre-merge',
            reviewerModel: 'm',
            candidateHeadSha: reviewReceipt.candidateHeadSha ?? TIP,
            verdict: reviewReceipt.verdict ?? 'passed',
            findings: [],
          },
        };
      },
    } as unknown as LandChainDependencies['reviews'],
    receipts: {
      async readReceiptsForHead(attemptId: string, headSha: string) {
        calls.readReceiptsForHead += 1;
        if (typeof linkReceipts === 'function') {
          return linkReceipts(attemptId, headSha) as never;
        }
        if (linkReceipts === 'none') {
          return { outcome: 'none' };
        }
        if (linkReceipts === 'unavailable') {
          return { outcome: 'unavailable', reason: 'evidence-unreadable' };
        }
        return { outcome: 'found', verification: [], review: [preMergeReceipt('pass')] };
      },
    } as unknown as LandChainDependencies['receipts'],
    laneRuns: {
      list: async () => laneRuns as never,
    },
    attempts: {
      findAttemptById: async (attemptId: string) => (attempts.get(attemptId) ?? null) as never,
    } as unknown as LandChainDependencies['attempts'],
    mergeQueue: {
      listMergeEntries: async () => queueEntries as never,
      enqueueMergeEntry: async (command: { tier: number; entryId: string; successorEntryId: string }) => {
        calls.enqueueMergeEntry += 1;
        calls.enqueued.push({ tier: command.tier, entryId: command.entryId, successorEntryId: command.successorEntryId });
        if (overrides.enqueueDecision?.outcome === 'refused') {
          return { outcome: 'refused', reason: 'no' } as never;
        }
        const outcome = overrides.enqueueDecision?.outcome ?? 'created';
        return { outcome, entries: [], record: { entryId: overrides.enqueueDecision?.recordEntryId ?? command.entryId } } as never;
      },
    } as unknown as LandChainDependencies['mergeQueue'],
    landing: landing as ChainLandingPort, // the fake adds test-only maps
    mintEntryId: (() => {
      let sequence = 0;
      return () => {
        if (overrides.mintThrows) {
          throw new Error('no ids');
        }
        sequence += 1;
        return `0${String(sequence).padStart(25, '0')}`;
      };
    })(),
    nowIso: overrides.clock ?? (() => NOW),
    computeDigest: digest,
  };
  if (overrides.candidatePullRequest !== undefined) {
    const forgeRead = deps.forgeRead as unknown as {
      readPullRequest: (request: { ref: { kind: string; number: number } }) => Promise<unknown>;
    };
    const inner = forgeRead.readPullRequest.bind(deps.forgeRead);
    forgeRead.readPullRequest = async (request) => {
      if (request.ref.kind === 'number' && request.ref.number !== LINK_PR) {
        return { outcome: overrides.candidatePullRequest, reason: 'down' };
      }
      return inner(request);
    };
  }
  return { deps, landing, calls };
}

function run(input: unknown = BASE_COMMAND, overrides: Overrides = {}): Promise<{ result: LandChainResult; world: World }> {
  const world = makeWorld(overrides);
  const command = input !== null && typeof input === 'object' && !Array.isArray(input) ? { ...BASE_COMMAND, ...(input as Record<string, unknown>) } : input;
  return new LandChainUseCase(world.deps).execute(command).then((result) => ({ result, world }));
}

// ---------- the parser ----------

describe('LandChainUseCase parser', () => {
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a number', 7],
    ['an array', [BASE_COMMAND]],
  ])('%s is invalid-request', async (_name, input) => {
    const world = makeWorld();
    const result = await new LandChainUseCase(world.deps).execute(input);
    expect(result).toEqual({ outcome: 'refused', reason: 'invalid-request' });
  });

  it('a command with more than six own keys is invalid-request', async () => {
    expect((await run({ ...BASE_COMMAND, extra: 'x', another: 'y' })).result).toEqual({ outcome: 'refused', reason: 'invalid-request' });
  });

  it('a proxy command with a throwing getter is invalid-request', async () => {
    const command = new Proxy(
      { ...BASE_COMMAND },
      {
        getOwnPropertyDescriptor() {
          throw new Error('no inspection');
        },
        ownKeys() {
          throw new Error('no keys');
        },
      },
    );
    const world = makeWorld();
    const result = await new LandChainUseCase(world.deps).execute(command);
    expect(result).toEqual({ outcome: 'refused', reason: 'invalid-request' });
  });

  it('a secret-shaped project id is secret-shaped', async () => {
    const secret = 'gh' + 'p_' + 'x'.repeat(28);
    expect((await run({ ...BASE_COMMAND, projectId: secret })).result).toEqual({ outcome: 'refused', reason: 'secret-shaped' });
  });

  it('a secret in a non-enumerable own property is secret-shaped', async () => {
    const world = makeWorld();
    const command: Record<string, unknown> = { ...BASE_COMMAND };
    Object.defineProperty(command, 'note', { value: 'x'.repeat(257), enumerable: false });
    const result = await new LandChainUseCase(world.deps).execute(command);
    expect(result).toEqual({ outcome: 'refused', reason: 'secret-shaped' });
  });

  it('a secret-shaped value on an over-wide command is secret-shaped, not invalid-request', async () => {
    const result = await run({ ...BASE_COMMAND, extra: 'x'.repeat(257), another: 'y' });
    expect(result.result).toEqual({ outcome: 'refused', reason: 'secret-shaped' });
  });

  it('a malformed field is invalid-request', async () => {
    expect((await run({ ...BASE_COMMAND, chainName: '../escape' })).result).toEqual({ outcome: 'refused', reason: 'invalid-request' });
    expect((await run({ ...BASE_COMMAND, deadlineIso: 'not-a-date' })).result).toEqual({ outcome: 'refused', reason: 'invalid-request' });
    expect((await run({ ...BASE_COMMAND, dryRun: 'no' })).result).toEqual({ outcome: 'refused', reason: 'invalid-request' });
  });
});

// ---------- the read phase ----------

describe('LandChainUseCase read phase', () => {
  it('a missing chain record is chain-not-found', async () => {
    const { result } = await run({}, { readChain: { status: 'not-found' } });
    expect(result).toEqual({ outcome: 'refused', reason: 'chain-not-found' });
  });

  it('an unreadable chain record is chain-unreadable', async () => {
    const thrown = await run({}, { readChain: 'throw' });
    expect(thrown.result).toEqual({ outcome: 'unknown', reason: 'chain-unreadable' });
    const unreadable = await run({}, { readChain: { status: 'unreadable', reason: 'bad' } });
    expect(unreadable.result).toEqual({ outcome: 'unknown', reason: 'chain-unreadable' });
  });

  it('a chain record with a throwing conflict mark is chain-unreadable', async () => {
    const record = chainRecord();
    Object.defineProperty(record, 'conflictMark', {
      get() {
        throw new Error('no mark');
      },
    });
    const { result } = await run({}, { chainRecord: () => record });
    expect(result).toEqual({ outcome: 'unknown', reason: 'chain-unreadable' });
  });

  it('a chain that has not started is chain-not-started', async () => {
    const { result } = await run({}, { chainRecord: { state: 'intent-recorded' as never } });
    expect(result).toEqual({ outcome: 'refused', reason: 'chain-not-started' });
  });

  it('a conflict mark refuses conflict-mark before any receipt read', async () => {
    const { result, world } = await run({}, { chainRecord: { conflictMark: 'chain-refresh-conflict' as never } });
    expect(result).toEqual({ outcome: 'refused', reason: 'conflict-mark' });
    expect(world.calls.readReceiptsForHead).toBe(0);
  });

  it('an in-flight refresh is refresh-in-flight', async () => {
    const { result } = await run({}, { chainRecord: { refresh: { key: 'k', mainSha: OTHER_SHA, atIso: NOW, outcome: 'in-flight' } as never } });
    expect(result).toEqual({ outcome: 'refused', reason: 'refresh-in-flight' });
  });

  it('a chain with no review pin is review-not-started', async () => {
    const { result } = await run({}, { chainRecord: { reviewPin: null } });
    expect(result).toEqual({ outcome: 'refused', reason: 'review-not-started' });
  });

  it('a moved chain tip is chain-tip-moved', async () => {
    const moved = await run({}, { mergeBranchHead: { outcome: 'found', headSha: OTHER_SHA } });
    expect(moved.result).toEqual({ outcome: 'refused', reason: 'chain-tip-moved' });
    const nonHex = await run({}, { mergeBranchHead: { outcome: 'found', headSha: 'zz' } });
    expect(nonHex.result).toEqual({ outcome: 'refused', reason: 'chain-tip-moved' });
  });

  it('an unreadable chain tip is forge-unavailable', async () => {
    const unavailable = await run({}, { mergeBranchHead: { outcome: 'unavailable', reason: 'down' } });
    expect(unavailable.result).toEqual({ outcome: 'unknown', reason: 'forge-unavailable' });
    const thrown = await run({}, { mergeBranchHead: 'throw' });
    expect(thrown.result).toEqual({ outcome: 'unknown', reason: 'forge-unavailable' });
  });

  it('a non-array lane-run list is store-unavailable', async () => {
    const fake = { length: 1e9, 0: laneRun() };
    const { result } = await run({}, { laneRuns: fake });
    expect(result).toEqual({ outcome: 'unknown', reason: 'store-unavailable' });
  });

  it('a sparse lane-run list is store-unavailable', async () => {
    const sparse = [laneRun()];
    sparse[1] = laneRun() as never;
    delete sparse[1];
    const { result } = await run({}, { laneRuns: sparse });
    expect(result).toEqual({ outcome: 'unknown', reason: 'store-unavailable' });
  });

  it('a lane-run list longer than 50 is too-many-links', async () => {
    const many = Array.from({ length: 51 }, (_, at) => laneRun({ runId: `run-${at}` }));
    const { result } = await run({}, { laneRuns: many });
    expect(result).toEqual({ outcome: 'refused', reason: 'too-many-links' });
  });

  it('more than 50 listed runs of which only one matches the chain is too-many-links, not a filtered pass', async () => {
    const mixed = Array.from({ length: 51 }, (_, at) => laneRun({ runId: `run-${at}`, baseBranch: at === 0 ? BRANCH : 'main' }));
    const { result, world } = await run({}, { laneRuns: mixed });
    expect(result).toEqual({ outcome: 'refused', reason: 'too-many-links' });
    expect(world.calls.enqueueMergeEntry).toBe(0);
  });

  it('an attempt lookup that throws is store-unavailable, not link-unsettled', async () => {
    const world = makeWorld();
    const deps: LandChainDependencies = {
      ...world.deps,
      attempts: {
        findAttemptById: async () => {
          throw new Error('attempt store down');
        },
      } as unknown as LandChainDependencies['attempts'],
    };
    const result = await new LandChainUseCase(deps).execute({ ...BASE_COMMAND });
    expect(result).toEqual({ outcome: 'unknown', reason: 'store-unavailable' });
  });

  it('an attempt lookup is not made once the deadline has passed', async () => {
    let spent = false;
    let lookups = 0;
    const world = makeWorld({ clock: () => (spent ? '2026-11-16T14:00:00.000Z' : NOW) });
    const deps: LandChainDependencies = {
      ...world.deps,
      mergeQueue: {
        ...world.deps.mergeQueue,
        listMergeEntries: async () => {
          spent = true;
          return [{ pullRequest: LINK_PR, state: 'merged' }] as never;
        },
      },
      attempts: {
        findAttemptById: async () => {
          lookups += 1;
          return attemptRecord() as never;
        },
      } as unknown as LandChainDependencies['attempts'],
    };
    const result = await new LandChainUseCase(deps).execute({ ...BASE_COMMAND });
    expect(result).toEqual({ outcome: 'unknown', reason: 'budget-exhausted' });
    expect(lookups).toBe(0);
  });

  it('a chain with no links is no-links', async () => {
    const { result } = await run({}, { laneRuns: [laneRun({ baseBranch: 'main' })] });
    expect(result).toEqual({ outcome: 'refused', reason: 'no-links' });
  });

  it('a link merged into another base is link-unsettled', async () => {
    const { result } = await run({}, { linkPullRequest: pullRequestSnapshot({ number: LINK_PR, state: 'merged', baseRef: 'main' }) });
    expect(result).toEqual({ outcome: 'refused', reason: 'link-unsettled' });
  });

  it('a link whose head is not an ancestor of the chain tip is link-unsettled', async () => {
    const { result } = await run({}, { containsCommit: { outcome: 'answered', contains: false } });
    expect(result).toEqual({ outcome: 'refused', reason: 'link-unsettled' });
  });

  it('a non-array merge queue is queue-unreadable', async () => {
    const { result } = await run({}, { queueEntries: { length: 5 } as never });
    expect(result).toEqual({ outcome: 'unknown', reason: 'queue-unreadable' });
  });

  it('an unavailable link pull request is forge-unavailable', async () => {
    const { result } = await run({}, { linkPullRequest: 'unavailable' });
    expect(result).toEqual({ outcome: 'unknown', reason: 'forge-unavailable' });
  });

  it('tier 2 without the chain receipt refuses receipt-missing even when link receipts pass', async () => {
    const { result } = await run({}, { reviewReceipt: 'not-found', laneRuns: [laneRun({ tier: 2 })] });
    expect(result).toEqual({ outcome: 'refused', reason: 'receipt-missing' });
  });

  it('a chain receipt whose head is not the pin refuses receipt-wrong-head', async () => {
    const { result } = await run({}, { reviewReceipt: { candidateHeadSha: OTHER_SHA }, laneRuns: [laneRun({ tier: 2 })] });
    expect(result).toEqual({ outcome: 'refused', reason: 'receipt-wrong-head' });
  });

  it('a failed chain verdict is verdict-failed', async () => {
    const { result } = await run({}, { reviewReceipt: { verdict: 'failed' }, laneRuns: [laneRun({ tier: 2 })] });
    expect(result).toEqual({ outcome: 'refused', reason: 'verdict-failed' });
  });

  it('a pin with no link receipt refuses link-receipt-missing and does not open', async () => {
    const { result, world } = await run({}, { linkReceipts: 'none' });
    expect(result).toEqual({ outcome: 'refused', reason: 'link-receipt-missing' });
    expect(world.landing.calls.openOrAdopt).toBe(0);
  });

  it('a link receipt read at the link head is not accepted', async () => {
    // The receipt exists only at the link's own head, never at the pinned chain head.
    const { result, world } = await run(
      {},
      {
        linkReceipts: (_attemptId: string, headSha: string) =>
          headSha === OTHER_SHA ? { outcome: 'found', verification: [], review: [preMergeReceipt('pass')] } : { outcome: 'none' },
      },
    );
    expect(result).toEqual({ outcome: 'refused', reason: 'link-receipt-missing' });
    expect(world.landing.calls.openOrAdopt).toBe(0);
  });

  it('a link receipt that is pending or not-applicable is verdict-unknown and does not enqueue', async () => {
    for (const result of ['pending', 'not-applicable']) {
      const world = makeWorld({ linkReceipts: () => ({ outcome: 'found', verification: [], review: [preMergeReceipt(result)] }) });
      const answer = await new LandChainUseCase(world.deps).execute({ ...BASE_COMMAND });
      expect(answer).toEqual({ outcome: 'unknown', reason: 'verdict-unknown' });
      expect(world.calls.enqueueMergeEntry).toBe(0);
      expect(world.landing.calls.openOrAdopt).toBe(0);
    }
  });

  it('a failed link receipt is link-receipt-failed', async () => {
    const world = makeWorld({
      linkReceipts: () => ({ outcome: 'found', verification: [], review: [preMergeReceipt('fail')] }),
    });
    const result = await new LandChainUseCase(world.deps).execute({ ...BASE_COMMAND });
    expect(result).toEqual({ outcome: 'refused', reason: 'link-receipt-failed' });
  });

  it('an unavailable link receipt read is store-unavailable', async () => {
    const world = makeWorld({ linkReceipts: 'unavailable' });
    const result = await new LandChainUseCase(world.deps).execute({ ...BASE_COMMAND });
    expect(result).toEqual({ outcome: 'unknown', reason: 'store-unavailable' });
  });

  it('an unfinished batch targeting the chain refuses batch-unfinished', async () => {
    const { result } = await run({}, { unfinishedBatch: 'targets' });
    expect(result).toEqual({ outcome: 'refused', reason: 'batch-unfinished' });
  });

  it('an unreadable batch is batch-unreadable and is not a landing', async () => {
    const unreadable = await run({}, { unfinishedBatch: 'unreadable' });
    expect(unreadable.result).toEqual({ outcome: 'unknown', reason: 'batch-unreadable' });
    const missing = await run({}, { unfinishedBatch: 'missing-method' });
    expect(missing.result).toEqual({ outcome: 'unknown', reason: 'batch-unreadable' });
  });
});

// ---------- the dry run ----------

describe('LandChainUseCase dry run', () => {
  it('a dry run opens nothing and writes nothing', async () => {
    const { result, world } = await run({ dryRun: true }, { openPullRequests: [] });
    expect(result).toEqual({
      outcome: 'dry-run',
      title: `Land chain/${CHAIN}`,
      body: `Chain: ${CHAIN}\nHead: ${TIP}\npr ${LINK_PR} attempt ${ATTEMPT_ID} pre-merge pass`,
      action: 'open',
      pullRequestNumber: null,
    });
    expect(world.landing.calls.openOrAdopt).toBe(0);
    expect(world.landing.journal.size).toBe(0);
    expect(world.calls.enqueueMergeEntry).toBe(0);
  });

  it('a dry run adopts the one open integration pull request', async () => {
    const { result } = await run({ dryRun: true }, { openPullRequests: [{ number: 77, headSha: TIP }] });
    expect(result).toMatchObject({ outcome: 'dry-run', action: 'adopt', pullRequestNumber: 77 });
  });

  it('a missing head lookup method is head-lookup-unavailable and does not open', async () => {
    const world = makeWorld();
    delete (world.deps.forge as { findOpenPullRequestsByHead?: unknown }).findOpenPullRequestsByHead;
    const result = await new LandChainUseCase(world.deps).execute({ ...BASE_COMMAND, dryRun: true });
    expect(result).toEqual({ outcome: 'unknown', reason: 'head-lookup-unavailable' });
  });
});

// ---------- the apply phase ----------

describe('LandChainUseCase apply', () => {
  it('a clean landing journals the intent, opens, marks, and enqueues', async () => {
    const { result, world } = await run();
    expect(result).toMatchObject({ outcome: 'landed', pullRequestNumber: 77, headSha: TIP });
    if (result.outcome !== 'landed') {
      return;
    }
    expect(result.entryId.length).toBe(26);
    expect(world.landing.calls.openOrAdopt).toBe(1);
    expect(world.calls.enqueueMergeEntry).toBe(1);
    expect(world.calls.performMergeForgeAction).toBe(1);
    const intent = world.landing.journal.get(`chain-land/${CHAIN}@${TIP.slice(0, 12)}`) ?? [];
    expect(intent.map((entry) => entry.kind)).toEqual(['intent', 'result']);
    const mark = world.landing.marks.get(`${OWNER}/${REPO}#${CHAIN}`);
    expect(mark?.mark).toMatchObject({ headSha: TIP, state: 'landing', pullRequestNumber: 77 });
  });

  it('a supersede or duplicate enqueue reports the entry id of the queue record, not the minted one', async () => {
    for (const outcome of ['supersedes', 'duplicate']) {
      const recordEntryId = `0RECORD${outcome.toUpperCase()}`.padEnd(26, 'X');
      const { result, world } = await run({}, { enqueueDecision: { outcome, recordEntryId } });
      expect(result).toMatchObject({ outcome: 'landed', entryId: recordEntryId });
      expect(world.calls.enqueued[0].entryId).not.toBe(recordEntryId);
    }
  });

  it('a tier-2 link that appears after the landing mark is enqueued as tier 2', async () => {
    const world = makeWorld();
    let listed = 0;
    const second = laneRun({ runId: 'run-2', prNumber: 22, attemptIds: ['att-2'], tier: 2 });
    const attempts = new Map([[ATTEMPT_ID, attemptRecord()], ['att-2', attemptRecord({ id: 'att-2' })]]);
    const baseRead = world.deps.forgeRead.readPullRequest.bind(world.deps.forgeRead);
    const deps: LandChainDependencies = {
      ...world.deps,
      laneRuns: { list: async () => (++listed <= 1 ? [laneRun()] : [laneRun(), second]) as never },
      attempts: { findAttemptById: async (id: string) => (attempts.get(id) ?? null) as never } as unknown as LandChainDependencies['attempts'],
      mergeQueue: {
        ...world.deps.mergeQueue,
        listMergeEntries: async () => [{ pullRequest: LINK_PR, state: 'merged' }, { pullRequest: 22, state: 'merged' }] as never,
      },
      forgeRead: {
        async readPullRequest(request: { readonly ref: { readonly kind: string; readonly number: number } }) {
          if (request.ref.number === 22) {
            return { outcome: 'found', pullRequest: pullRequestSnapshot({ number: 22, state: 'merged', headRef: 'feat/run-2', baseRef: BRANCH }) };
          }
          return baseRead(request as never);
        },
      } as unknown as LandChainDependencies['forgeRead'],
    };
    const result = await new LandChainUseCase(deps).execute({ ...BASE_COMMAND });
    expect(result).toMatchObject({ outcome: 'landed' });
    expect(world.calls.enqueued).toHaveLength(1);
    expect(world.calls.enqueued[0].tier).toBe(2);
  });

  it('a tier-2 link that appears after the landing mark without a chain receipt is receipt-missing and withdraws the mark', async () => {
    const world = makeWorld();
    let listed = 0;
    const second = laneRun({ runId: 'run-2', prNumber: 22, attemptIds: ['att-2'], tier: 2 });
    const attempts = new Map([[ATTEMPT_ID, attemptRecord()], ['att-2', attemptRecord({ id: 'att-2' })]]);
    const baseRead = world.deps.forgeRead.readPullRequest.bind(world.deps.forgeRead);
    const deps: LandChainDependencies = {
      ...world.deps,
      laneRuns: { list: async () => (++listed <= 1 ? [laneRun()] : [laneRun(), second]) as never },
      attempts: { findAttemptById: async (id: string) => (attempts.get(id) ?? null) as never } as unknown as LandChainDependencies['attempts'],
      mergeQueue: {
        ...world.deps.mergeQueue,
        listMergeEntries: async () => [{ pullRequest: LINK_PR, state: 'merged' }, { pullRequest: 22, state: 'merged' }] as never,
      },
      reviews: { findReviewReceipt: async () => ({ outcome: 'not-found' }) } as unknown as LandChainDependencies['reviews'],
      forgeRead: {
        async readPullRequest(request: { readonly ref: { readonly kind: string; readonly number: number } }) {
          if (request.ref.number === 22) {
            return { outcome: 'found', pullRequest: pullRequestSnapshot({ number: 22, state: 'merged', headRef: 'feat/run-2', baseRef: BRANCH }) };
          }
          return baseRead(request as never);
        },
      } as unknown as LandChainDependencies['forgeRead'],
    };
    const result = await new LandChainUseCase(deps).execute({ ...BASE_COMMAND });
    expect(result).toEqual({ outcome: 'refused', reason: 'receipt-missing' });
    expect(world.calls.enqueueMergeEntry).toBe(0);
    expect(world.landing.marks.get(`${OWNER}/${REPO}#${CHAIN}`)?.mark.state).toBe('withdrawn');
  });

  it('a refused premerge post does not enqueue', async () => {
    const { result, world } = await run({}, { postStatusOutcome: { outcome: 'refused' } });
    expect(result).toEqual({ outcome: 'refused', reason: 'forge-refused' });
    expect(world.calls.enqueueMergeEntry).toBe(0);
  });

  it('an ambiguous open is forge-unavailable', async () => {
    const { result } = await run({}, { openOrAdoptOutcome: { outcome: 'ambiguous' } });
    expect(result).toEqual({ outcome: 'unknown', reason: 'forge-unavailable' });
  });

  it('a candidate integration pull request that cannot be read is head-lookup-unavailable and does not open', async () => {
    const notFound = await run({}, { openPullRequests: [{ number: 55, headSha: TIP }], candidatePullRequest: 'not-found' });
    expect(notFound.result).toEqual({ outcome: 'unknown', reason: 'head-lookup-unavailable' });
    expect(notFound.world.landing.calls.openOrAdopt).toBe(0);
    expect(notFound.world.calls.enqueueMergeEntry).toBe(0);
    const unavailable = await run({ dryRun: true }, { openPullRequests: [{ number: 55, headSha: TIP }], candidatePullRequest: 'unavailable' });
    expect(unavailable.result).toEqual({ outcome: 'unknown', reason: 'head-lookup-unavailable' });
  });

  it('two open pull requests of the chain onto main refuse integration-pr-ambiguous', async () => {
    const { result, world } = await run({}, { openPullRequests: [{ number: 77, headSha: TIP }, { number: 78, headSha: TIP }] });
    expect(result).toEqual({ outcome: 'refused', reason: 'integration-pr-ambiguous' });
    expect(world.landing.calls.openOrAdopt).toBe(0);
  });

  it('the pull request opened for the chain is refused when a later read shows another base', async () => {
    const { result, world } = await run({}, { integrationPullRequest: pullRequestSnapshot({ number: 77, baseRef: 'develop' }) });
    expect(result).toEqual({ outcome: 'refused', reason: 'integration-pr-wrong-base' });
    expect(world.calls.enqueueMergeEntry).toBe(0);
  });

  it('an unreadable landing journal is journal-unreadable', async () => {
    const { result } = await run({}, { journalFail: 'list' });
    expect(result).toEqual({ outcome: 'unknown', reason: 'journal-unreadable' });
  });

  it('a second landing intent with another digest is intent-digest-mismatch', async () => {
    const world = makeWorld();
    const key = `chain-land/${CHAIN}@${TIP.slice(0, 12)}`;
    world.landing.journal.set(key, [
      {
        key,
        kind: 'intent',
        entryId: '0AAAAAAAAAAAAAAAAAAAAAAAA',
        recordedAtIso: NOW,
        digest: digest(canonicalLandChainPayload({ chainName: CHAIN, headSha: OTHER_SHA, dryRun: false })),
        deadlineIso: FUTURE,
      },
    ]);
    const result = await new LandChainUseCase(world.deps).execute({ ...BASE_COMMAND });
    expect(result).toEqual({ outcome: 'refused', reason: 'intent-digest-mismatch' });
    expect(world.calls.enqueueMergeEntry).toBe(0);
  });

  it('a stored final result whose mark is withdrawn, or belongs to another key or head, is journal-unreadable and not landed', async () => {
    const key = `chain-land/${CHAIN}@${TIP.slice(0, 12)}`;
    const entryDigest = digest(canonicalLandChainPayload({ chainName: CHAIN, headSha: TIP, dryRun: false }));
    const stored = [
      { state: 'withdrawn' as const, headSha: TIP, key },
      { state: 'landing' as const, headSha: OTHER_SHA, key },
      { state: 'landing' as const, headSha: TIP, key: `chain-land/${CHAIN}@${OTHER_SHA.slice(0, 12)}` },
    ];
    for (const mark of stored) {
      const world = makeWorld();
      world.landing.journal.set(key, [
        { key, kind: 'intent', entryId: '0AAAAAAAAAAAAAAAAAAAAAAAA', recordedAtIso: NOW, digest: entryDigest, deadlineIso: FUTURE },
        { key, kind: 'result', entryId: '0BBBBBBBBBBBBBBBBBBBBBBBB', recordedAtIso: NOW, digest: entryDigest, deadlineIso: FUTURE },
      ]);
      world.landing.marks.set(`${OWNER}/${REPO}#${CHAIN}`, { revision: 2, mark: { pullRequestNumber: 77, ...mark } });
      const result = await new LandChainUseCase(world.deps).execute({ ...BASE_COMMAND });
      expect(result).toEqual({ outcome: 'unknown', reason: 'journal-unreadable' });
      expect(world.landing.calls.openOrAdopt).toBe(0);
      expect(world.calls.enqueueMergeEntry).toBe(0);
    }
  });

  it('a stored final result replays without calling forge or queue again', async () => {
    const world = makeWorld();
    const key = `chain-land/${CHAIN}@${TIP.slice(0, 12)}`;
    const entryDigest = digest(canonicalLandChainPayload({ chainName: CHAIN, headSha: TIP, dryRun: false }));
    world.landing.journal.set(key, [
      { key, kind: 'intent', entryId: '0AAAAAAAAAAAAAAAAAAAAAAAA', recordedAtIso: NOW, digest: entryDigest, deadlineIso: FUTURE },
      { key, kind: 'result', entryId: '0BBBBBBBBBBBBBBBBBBBBBBBB', recordedAtIso: NOW, digest: entryDigest, deadlineIso: FUTURE },
    ]);
    world.landing.marks.set(`${OWNER}/${REPO}#${CHAIN}`, { revision: 2, mark: { headSha: TIP, pullRequestNumber: 77, key, state: 'landing' } });
    const result = await new LandChainUseCase(world.deps).execute({ ...BASE_COMMAND });
    expect(result).toMatchObject({ outcome: 'landed', pullRequestNumber: 77, headSha: TIP, entryId: '0BBBBBBBBBBBBBBBBBBBBBBBB' });
    if (result.outcome === 'landed') {
      expect(result.body.split('\n')).toEqual([`Chain: ${CHAIN}`, `Head: ${TIP}`, `pr ${LINK_PR} attempt ${ATTEMPT_ID} pre-merge pass`]);
    }
    expect(world.landing.calls.openOrAdopt).toBe(0);
    expect(world.calls.enqueueMergeEntry).toBe(0);
  });

  it('a stale landing mark is landing-mark-stale', async () => {
    const { result, world } = await run({}, { journalFail: 'cas-stale' });
    expect(result).toEqual({ outcome: 'refused', reason: 'landing-mark-stale' });
    expect(world.calls.enqueueMergeEntry).toBe(0);
  });

  it('a conflicting landing mark is landing-mark-conflict', async () => {
    const { result } = await run({}, { journalFail: 'cas-conflict' });
    expect(result).toEqual({ outcome: 'refused', reason: 'landing-mark-conflict' });
  });

  it('an unsettled link after the landing mark is not enqueued', async () => {
    let read = 0;
    const world = makeWorld({
      linkReceipts: () => {
        read += 1;
        // The first pass (before the mark) finds the receipt; the re-check after the mark does not.
        return read <= 1 ? { outcome: 'found', verification: [], review: [preMergeReceipt('pass')] } : { outcome: 'none' };
      },
    });
    const result = await new LandChainUseCase(world.deps).execute({ ...BASE_COMMAND });
    expect(result).toEqual({ outcome: 'refused', reason: 'link-receipt-missing' });
    expect(world.calls.enqueueMergeEntry).toBe(0);
    const mark = world.landing.marks.get(`${OWNER}/${REPO}#${CHAIN}`);
    expect(mark?.mark.state).toBe('withdrawn');
  });

  it('a chain receipt that disappears after the landing mark withdraws the mark and is not enqueued', async () => {
    let reviewReads = 0;
    const world = makeWorld({ queueEntries: [{ pullRequest: LINK_PR, state: 'merged' }] });
    const deps: LandChainDependencies = {
      ...world.deps,
      laneRuns: { list: async () => [laneRun({ tier: 2 })] as never },
      reviews: {
        findReviewReceipt: async () => {
          reviewReads += 1;
          if (reviewReads <= 1) {
            return {
              outcome: 'found',
              receipt: { receiptId: 'r1', requestId: REQUEST_ID, kind: 'pre-merge', reviewerModel: 'm', candidateHeadSha: TIP, verdict: 'passed', findings: [] },
            };
          }
          return { outcome: 'not-found' };
        },
      } as unknown as LandChainDependencies['reviews'],
    };
    const result = await new LandChainUseCase(deps).execute({ ...BASE_COMMAND });
    expect(result).toEqual({ outcome: 'refused', reason: 'receipt-missing' });
    expect(world.calls.enqueueMergeEntry).toBe(0);
    const mark = world.landing.marks.get(`${OWNER}/${REPO}#${CHAIN}`);
    expect(mark?.mark.state).toBe('withdrawn');
  });

  it('a stored withdrawn mark for another head is landing-mark-conflict and is never overwritten', async () => {
    const world = makeWorld();
    const markId = `${OWNER}/${REPO}#${CHAIN}`;
    world.landing.marks.set(markId, {
      revision: 1,
      mark: { headSha: OTHER_SHA, pullRequestNumber: 5, key: `chain-land/${CHAIN}@${OTHER_SHA.slice(0, 12)}`, state: 'withdrawn' },
    });
    const result = await new LandChainUseCase(world.deps).execute({ ...BASE_COMMAND });
    expect(result).toEqual({ outcome: 'refused', reason: 'landing-mark-conflict' });
    expect(world.calls.enqueueMergeEntry).toBe(0);
    expect(world.landing.marks.get(markId)?.mark).toMatchObject({ headSha: OTHER_SHA, state: 'withdrawn' });
  });

  it('a failed withdrawal CAS surfaces landing-mark-stale and does not land', async () => {
    let read = 0;
    const world = makeWorld({
      linkReceipts: () => {
        read += 1;
        return read <= 1 ? { outcome: 'found', verification: [], review: [preMergeReceipt('pass')] } : { outcome: 'none' };
      },
    });
    withdrawalCasAlwaysStale(world.landing);
    const result = await new LandChainUseCase(world.deps).execute({ ...BASE_COMMAND });
    expect(result).toEqual({ outcome: 'refused', reason: 'landing-mark-stale' });
    expect(world.calls.enqueueMergeEntry).toBe(0);
    // The landing mark was recorded (initial CAS succeeded) and the withdrawal never took effect.
    expect(world.landing.marks.get(`${OWNER}/${REPO}#${CHAIN}`)?.mark.state).toBe('landing');
  });

  it('a refused enqueue is enqueue-refused', async () => {
    const { result } = await run({}, { enqueueDecision: { outcome: 'refused' } });
    expect(result).toEqual({ outcome: 'refused', reason: 'enqueue-refused' });
  });

  it('a throwing id mint is id-unavailable', async () => {
    const { result } = await run({}, { mintThrows: true });
    expect(result).toEqual({ outcome: 'unknown', reason: 'id-unavailable' });
  });

  it('a spent deadline is budget-exhausted and does not enqueue', async () => {
    const spent = await run({ deadlineIso: NOW }, {});
    expect(spent.result).toEqual({ outcome: 'unknown', reason: 'budget-exhausted' });
    const throwingClock = await run({}, { clock: () => { throw new Error('no clock'); } });
    expect(throwingClock.result).toEqual({ outcome: 'unknown', reason: 'budget-exhausted' });
  });

  it('a clock that throws only on the timestamp read before the enqueue is budget-exhausted with no enqueue call', async () => {
    // Record how many clock reads happen before enqueueMergeEntry is invoked on a clean run.
    let reads = 0;
    let readsAtEnqueue = 0;
    const probe = makeWorld({ clock: () => { reads += 1; return NOW; } });
    const probeEnqueue = probe.deps.mergeQueue.enqueueMergeEntry.bind(probe.deps.mergeQueue);
    probe.deps.mergeQueue.enqueueMergeEntry = async (command) => {
      readsAtEnqueue = reads;
      return probeEnqueue(command);
    };
    expect((await new LandChainUseCase(probe.deps).execute({ ...BASE_COMMAND })).outcome).toBe('landed');
    expect(readsAtEnqueue).toBeGreaterThan(1);

    // The last clock read before the enqueue is the timestamp read, after the deadline guard passed.
    let count = 0;
    const world = makeWorld({
      clock: () => {
        count += 1;
        if (count === readsAtEnqueue) {
          throw new Error('clock failed on the timestamp read');
        }
        return NOW;
      },
    });
    const result = await new LandChainUseCase(world.deps).execute({ ...BASE_COMMAND });
    expect(result).toEqual({ outcome: 'unknown', reason: 'budget-exhausted' });
    expect(world.calls.enqueueMergeEntry).toBe(0);
  });
});

/** Force only the withdrawal CAS (the `withdrawn` mark) to `stale-revision`; the landing-mark CAS behaves normally. */
function withdrawalCasAlwaysStale(landing: ChainLandingPort): void {
  const original = landing.compareAndSetMark.bind(landing);
  landing.compareAndSetMark = async (command) =>
    command.mark.state === 'withdrawn' ? { outcome: 'refused', reason: 'stale-revision' } : original(command);
}
