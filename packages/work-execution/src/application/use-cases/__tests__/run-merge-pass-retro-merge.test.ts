// EV2: the shadow retro `would-merge` on the first `already-merged`
// observation. Two layers are pinned here: the pure decider helper
// `isMergedHeadRetroMergeEligible` (hostile-input refusals and every
// predicate) and the use-case wiring (the retro `would-merge` is journalled
// with the merged head as its `linkedId` BEFORE `would-already-merged`, only
// on the first observation for the head12, only when every live predicate
// and the forge merge-time facts pass).
import { describe, expect, it } from 'vitest';

import { isMergedHeadRetroMergeEligible } from '../../../domain/merge-queue-decider.js';
import type { MergeStepFacts } from '../../../domain/merge-queue-decider.js';
import { MERGE_QUEUE_ENTRY_VERSION } from '../../../domain/merge-queue-records.js';
import type { MergeQueueEntryRecord } from '../../../domain/merge-queue-records.js';
import type { MergeRepoPolicy } from '../../../domain/merge-queue-decider.js';
import { RunMergePassUseCase } from '../RunMergePassUseCase.use-case.js';
import type { RunMergePassRequest } from '../../ports/in/RunMergePassPort.in-port.js';
import type {
  ForgeMergeReadPort,
  MergeContextSnapshot,
  ReadForgeMergeResult,
} from '../../ports/out/ForgeMergeReadPort.out-port.js';
import type { MergeVerificationPort } from '../../ports/out/MergeVerificationPort.out-port.js';
import type { MergeQueueRepositoryPort } from '../../ports/out/MergeQueueRepositoryPort.out-port.js';
import type { ConductorHaltPort } from '../../ports/out/ConductorHaltPort.out-port.js';
import type { ConductorHaltState } from '../../../domain/conductor-halt.js';
import type { LaneRunJournalPort } from '../../ports/out/LaneRunJournalPort.out-port.js';
import { LaneRunJournalAdapter } from '../../../infrastructure/adapters/LaneRunJournalAdapter.adapter.js';

const OWNER = 'fleet';
const REPO = 'v2';
const DIGEST = '0123456789ab';
const HEAD = '0123456789abcdef0123456789abcdef01234567';
const HEAD3 = 'fedcba987654ef0123456789abcdef0123456789';
const HEAD3_12 = 'fedcba987654';
const HEAD12 = '0123456789ab';
const NOW = '2026-11-01T12:00:00.000Z';
const DEADLINE = '2026-11-01T12:10:00.000Z';
const POSTER = 'premerge-bot';
const MERGED_AT = '2026-11-01T11:00:00.000Z';
const CREATED_AT = '2026-11-01T10:30:00.000Z';
const MERGE_KEY = `merge/${DIGEST}/1/${HEAD12}/merge-pr`;
const ALREADY_KEY = `merge/${DIGEST}/1/${HEAD12}/would-already-merged`;

let entryIdCounter = 0;
function makeEntry(overrides: Partial<MergeQueueEntryRecord> = {}): MergeQueueEntryRecord {
  return {
    version: MERGE_QUEUE_ENTRY_VERSION,
    entryId: `01JB${String(++entryIdCounter).padStart(22, '0').slice(-22)}`,
    repository: { owner: OWNER, repo: REPO },
    repoDigest: DIGEST,
    pullRequest: 1,
    headOid: HEAD,
    state: 'queued',
    reason: null,
    attempt: 0,
    notBeforeIso: null,
    enqueuedAtIso: '2026-11-01T10:00:00.000Z',
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
    ...overrides,
  };
}

function makePolicy(overrides: Record<string, unknown> = {}): MergeRepoPolicy {
  return {
    policyRevision: 'rev-1',
    shadow: true,
    unattended: true,
    updateBranch: false,
    premergePosterLogin: POSTER,
    macosProcedure: null,
    requiredContexts: ['gate', 'premerge'],
    veto: { mode: 'off' },
    ...overrides,
  } as MergeRepoPolicy;
}

/** Facts the live path would have gathered for a merged green head. */
function makeFacts(overrides: Record<string, unknown> = {}): MergeStepFacts {
  return {
    halted: false,
    paused: false,
    isQueueHead: true,
    pr: { status: 'merged', headOid: HEAD },
    reReadHeadOid: HEAD,
    headObservedAtIso: '2026-11-01T10:00:00.000Z',
    contexts: {
      gate: { state: 'success', creatorLogin: null, createdAtIso: CREATED_AT },
      premerge: { state: 'success', creatorLogin: POSTER, createdAtIso: CREATED_AT },
    },
    unresolvedThreads: { status: 'known', count: 0 },
    updatesInLastHour: 0,
    premergeCarry: { status: 'unknown' },
    disjointness: 'not-applicable',
    macosVerification: { status: 'none' },
    mergedAtIso: MERGED_AT,
    ...overrides,
  } as MergeStepFacts;
}

function forgeReadFake(result: ReadForgeMergeResult): ForgeMergeReadPort & { calls: number } {
  const adapter = {
    calls: 0,
    async readForgeMerge(): Promise<ReadForgeMergeResult> {
      adapter.calls += 1;
      return result;
    },
    isConfigured(): boolean {
      return true;
    },
  };
  return adapter as ForgeMergeReadPort & { calls: number };
}

const verificationFake: MergeVerificationPort = {
  async readVerification() {
    return { outcome: 'unknown', reasonCode: 'no-receipt' };
  },
  async runVerification(): Promise<never> {
    throw new Error('runVerification must never be called in the shadow pass');
  },
} as unknown as MergeVerificationPort;

function makeQueue(records: readonly MergeQueueEntryRecord[]): MergeQueueRepositoryPort {
  return {
    async listMergeEntries(): Promise<readonly MergeQueueEntryRecord[]> {
      return records;
    },
    async enqueueMergeEntry(): Promise<never> {
      throw new Error('not used');
    },
    async dropMergeEntry(): Promise<never> {
      throw new Error('not used');
    },
    async retryMergeEntry(): Promise<never> {
      throw new Error('not used');
    },
    async applyMergeTransition(): Promise<never> {
      throw new Error('not used');
    },
  } as unknown as MergeQueueRepositoryPort;
}

const haltClear: ConductorHaltState = { state: 'clear', record: null };
const haltFake: ConductorHaltPort = {
  async read(): Promise<ConductorHaltState> {
    return haltClear;
  },
  async set(): Promise<never> {
    throw new Error('not used');
  },
};

/** A merged forge read whose every required context is green and time-stamped. */
function retroForge(overrides: Record<string, unknown> = {}): ReadForgeMergeResult {
  const contexts: MergeContextSnapshot[] = [
    {
      name: 'gate',
      state: 'SUCCESS',
      isGreen: true,
      creatorLogin: null,
      createdAtIso: CREATED_AT,
    },
    {
      name: 'premerge',
      state: 'SUCCESS',
      isGreen: true,
      creatorLogin: POSTER,
      createdAtIso: CREATED_AT,
    },
  ];
  return {
    outcome: 'ok',
    prState: 'merged',
    liveHeadSha: HEAD,
    mergeState: 'clean',
    mergedAtIso: MERGED_AT,
    contexts,
    unresolvedThreads: 0,
    ...overrides,
  } as ReadForgeMergeResult;
}

function makeUseCase(
  forgeResult: ReadForgeMergeResult,
  policyOverrides: Record<string, unknown> = {},
  records: readonly MergeQueueEntryRecord[] = [makeEntry()],
  options: { spendClockOnKey?: string } = {},
): { useCase: RunMergePassUseCase; journal: LaneRunJournalAdapter; request: RunMergePassRequest } {
  const journal = new LaneRunJournalAdapter();
  let ulid = 0;
  // The budget test flips the pass clock the moment the already-merged key
  // is looked up, so only the lookup's own guard can still see a spent
  // budget; every earlier guard saw the fresh clock.
  let clockSpent = false;
  const SPENT = '2026-11-01T12:00:02.000Z';
  const spentJournal = {
    append: journal.append.bind(journal),
    async listForKey(key: string) {
      if (key === options.spendClockOnKey) {
        clockSpent = true;
      }
      return journal.listForKey(key);
    },
  };
  const useCase = new RunMergePassUseCase({
    queue: makeQueue(records),
    forgeRead: forgeReadFake(forgeResult),
    verification: verificationFake,
    journal: (options.spendClockOnKey === undefined ? journal : spentJournal) as LaneRunJournalPort,
    halt: haltFake,
    newUlid: () => `01JB${String(++ulid).padStart(22, '0').slice(-22)}`,
    nowIso: () => (clockSpent ? SPENT : NOW),
  });
  const request: RunMergePassRequest = {
    repository: { owner: OWNER, repo: REPO },
    repoDigest: DIGEST,
    projectId: 'proj-1',
    policy: makePolicy(policyOverrides),
    deadlineIso: DEADLINE,
  };
  return { useCase, journal, request };
}

describe('isMergedHeadRetroMergeEligible (EV2 retro decider helper)', () => {
  it('returns true for a merged green head with merge-time facts that predate the merge commit', () => {
    expect(isMergedHeadRetroMergeEligible(makeEntry(), makeFacts(), makePolicy(), NOW)).toBe(true);
  });

  it('refuses null, undefined, wrong primitives, array-likes, and prototype-polluting keys on retro-merge check', () => {
    // Control: the unmodified eligible input passes, so a constant `false` fails this test.
    expect(isMergedHeadRetroMergeEligible(makeEntry(), makeFacts(), makePolicy(), NOW)).toBe(true);
    const entry = makeEntry();
    const facts = makeFacts();
    const policy = makePolicy();
    // Malformed `entry`.
    expect(isMergedHeadRetroMergeEligible(null, facts, policy, NOW)).toBe(false);
    expect(isMergedHeadRetroMergeEligible(undefined, facts, policy, NOW)).toBe(false);
    expect(isMergedHeadRetroMergeEligible('entry', facts, policy, NOW)).toBe(false);
    expect(isMergedHeadRetroMergeEligible(7, facts, policy, NOW)).toBe(false);
    expect(isMergedHeadRetroMergeEligible({ length: 0, ...{} }, facts, policy, NOW)).toBe(false);
    expect(isMergedHeadRetroMergeEligible(JSON.parse('{"__proto__":{}}'), facts, policy, NOW)).toBe(false);
    // Malformed `facts`.
    expect(isMergedHeadRetroMergeEligible(entry, null, policy, NOW)).toBe(false);
    expect(isMergedHeadRetroMergeEligible(entry, undefined, policy, NOW)).toBe(false);
    expect(isMergedHeadRetroMergeEligible(entry, 'facts', policy, NOW)).toBe(false);
    expect(isMergedHeadRetroMergeEligible(entry, 0, policy, NOW)).toBe(false);
    expect(isMergedHeadRetroMergeEligible(entry, [facts], policy, NOW)).toBe(false);
    expect(isMergedHeadRetroMergeEligible(entry, { ...facts, length: 0 }, policy, NOW)).toBe(false);
    expect(isMergedHeadRetroMergeEligible(entry, { ...facts, constructor: {} }, policy, NOW)).toBe(false);
    // An own `__proto__` data property (the prototype itself stays
    // `Object.prototype`; the key is what is refused). Cost O(1).
    const pollutingFacts: Record<string, unknown> = { ...facts };
    Reflect.defineProperty(pollutingFacts, '__proto__', {
      value: {},
      enumerable: true,
      writable: true,
      configurable: true,
    });
    expect(Object.getPrototypeOf(pollutingFacts)).toBe(Object.prototype);
    expect(isMergedHeadRetroMergeEligible(entry, pollutingFacts, policy, NOW)).toBe(false);
    // Malformed `repoPolicy`: wrong primitive, array-like length, and an own
    // prototype-polluting key. Cost of each probe is O(1); none of them walks
    // the length.
    expect(isMergedHeadRetroMergeEligible(entry, facts, null, NOW)).toBe(false);
    expect(isMergedHeadRetroMergeEligible(entry, facts, 'policy' as unknown as MergeRepoPolicy, NOW)).toBe(false);
    expect(isMergedHeadRetroMergeEligible(entry, facts, undefined as unknown as MergeRepoPolicy, NOW)).toBe(false);
    expect(
      isMergedHeadRetroMergeEligible(entry, facts, { ...policy, length: 0 } as MergeRepoPolicy, NOW),
    ).toBe(false);
    expect(
      isMergedHeadRetroMergeEligible(
        entry,
        facts,
        { ...policy, length: Number.MAX_SAFE_INTEGER } as MergeRepoPolicy,
        NOW,
      ),
    ).toBe(false);
    const pollutingPolicy: Record<string, unknown> = { ...policy, constructor: {} };
    Reflect.defineProperty(pollutingPolicy, '__proto__', {
      value: {},
      enumerable: true,
      writable: true,
      configurable: true,
    });
    expect(Object.getPrototypeOf(pollutingPolicy)).toBe(Object.prototype);
    expect(isMergedHeadRetroMergeEligible(entry, facts, pollutingPolicy as unknown as MergeRepoPolicy, NOW)).toBe(false);
    // Malformed `nowIso`.
    expect(isMergedHeadRetroMergeEligible(entry, facts, policy, 'not-a-timestamp')).toBe(false);
    expect(isMergedHeadRetroMergeEligible(entry, facts, policy, 42 as unknown as string)).toBe(false);
  });

  it('refuses getter properties without invoking them', () => {
    // Control: the unmodified eligible input passes, so a constant `false` fails this test.
    expect(isMergedHeadRetroMergeEligible(makeEntry(), makeFacts(), makePolicy(), NOW)).toBe(true);
    const entry = makeEntry();
    const policy = makePolicy();
    let invoked = false;
    const throwing = (): never => {
      invoked = true;
      throw new Error('getter ran');
    };
    // An accessor on the facts record itself, on each key the check reads,
    // and on the nested `pr` / `unresolvedThreads` records.
    for (const key of [
      'pr', 'reReadHeadOid', 'contexts', 'unresolvedThreads', 'veto', 'mergedAtIso', 'observedBaseBranch',
    ]) {
      const facts = { ...makeFacts() };
      Reflect.defineProperty(facts, key, {
        get: throwing,
        enumerable: true,
        configurable: true,
      });
      expect(isMergedHeadRetroMergeEligible(entry, facts, policy, NOW)).toBe(false);
    }
    expect(invoked).toBe(false);
    const prWithGetter = {
      status: 'merged',
      get headOid(): never {
        return throwing();
      },
    };
    expect(isMergedHeadRetroMergeEligible(entry, { ...makeFacts(), pr: prWithGetter }, policy, NOW)).toBe(false);
    const threadsWithGetter = {
      status: 'known',
      get count(): never {
        return throwing();
      },
    };
    expect(
      isMergedHeadRetroMergeEligible(entry, { ...makeFacts(), unresolvedThreads: threadsWithGetter }, policy, NOW),
    ).toBe(false);
    // A getter on the policy is normalized away (normalizeRepoPolicy refuses).
    const policyWithGetter: Record<string, unknown> = { ...makePolicy() };
    Reflect.defineProperty(policyWithGetter, 'shadow', {
      get: throwing,
      enumerable: true,
      configurable: true,
    });
    expect(
      isMergedHeadRetroMergeEligible(entry, makeFacts(), policyWithGetter as unknown as MergeRepoPolicy, NOW),
    ).toBe(false);
    // A getter on a nested policy field the normalizer would read.
    const vetoRecord: Record<string, unknown> = {};
    Reflect.defineProperty(vetoRecord, 'mode', { get: throwing, enumerable: true, configurable: true });
    expect(
      isMergedHeadRetroMergeEligible(
        entry,
        makeFacts(),
        { ...makePolicy(), veto: vetoRecord } as unknown as MergeRepoPolicy,
        NOW,
      ),
    ).toBe(false);
    const grace: Record<string, unknown> = {};
    Reflect.defineProperty(grace, 'gate', { get: throwing, enumerable: true, configurable: true });
    expect(
      isMergedHeadRetroMergeEligible(
        entry,
        makeFacts(),
        { ...makePolicy(), checksGraceMinutes: grace } as unknown as MergeRepoPolicy,
        NOW,
      ),
    ).toBe(false);
    // A getter on the deciding context's own fields, including the retro
    // timestamp. The descriptor is refused; the getter does not run.
    const contextWithGetter = {
      gate: {
        state: 'success',
        creatorLogin: null,
        get createdAtIso(): never {
          return throwing();
        },
      },
      premerge: { state: 'success', creatorLogin: POSTER, createdAtIso: CREATED_AT },
    };
    expect(
      isMergedHeadRetroMergeEligible(entry, { ...makeFacts(), contexts: contextWithGetter }, policy, NOW),
    ).toBe(false);
    const stateGetter = {
      gate: {
        get state(): never {
          return throwing();
        },
        createdAtIso: CREATED_AT,
      },
      premerge: { state: 'success', creatorLogin: POSTER, createdAtIso: CREATED_AT },
    };
    expect(
      isMergedHeadRetroMergeEligible(entry, { ...makeFacts(), contexts: stateGetter }, policy, NOW),
    ).toBe(false);
    // An accessor `length` (array-like) is refused from its descriptor. The
    // length is never read, so the getter does not run. Cost O(1).
    const factsWithLength = { ...makeFacts() };
    Reflect.defineProperty(factsWithLength, 'length', {
      get: throwing,
      enumerable: true,
      configurable: true,
    });
    expect(isMergedHeadRetroMergeEligible(entry, factsWithLength, policy, NOW)).toBe(false);
    const policyWithLength: Record<string, unknown> = { ...makePolicy() };
    Reflect.defineProperty(policyWithLength, 'length', {
      get: throwing,
      enumerable: true,
      configurable: true,
    });
    expect(
      isMergedHeadRetroMergeEligible(entry, makeFacts(), policyWithLength as unknown as MergeRepoPolicy, NOW),
    ).toBe(false);
    expect(invoked).toBe(false);
  });

  it('refuses a benign getter on any own facts key or nested element without invoking it', () => {
    const entry = makeEntry();
    const policy = makePolicy();
    // Control: the same facts with plain data properties are eligible, so each
    // refusal below is caused by the accessor alone.
    expect(isMergedHeadRetroMergeEligible(entry, makeFacts(), policy, NOW)).toBe(true);
    let invocations = 0;
    // Every own key of the facts, including ones the check itself never reads
    // (such as `halted`): a getter returning the same plain value is refused.
    for (const key of Reflect.ownKeys(makeFacts())) {
      const facts = { ...makeFacts() } as Record<PropertyKey, unknown>;
      const value = facts[key];
      Reflect.defineProperty(facts, key, {
        get: () => {
          invocations += 1;
          return value;
        },
        enumerable: true,
        configurable: true,
      });
      expect(isMergedHeadRetroMergeEligible(entry, facts, policy, NOW)).toBe(false);
    }
    // A getter two levels down, on `contexts.premerge.state`, returning the
    // same plain value.
    const premerge = { state: 'success', creatorLogin: POSTER, createdAtIso: CREATED_AT };
    Reflect.defineProperty(premerge, 'state', {
      get: () => {
        invocations += 1;
        return 'success';
      },
      enumerable: true,
      configurable: true,
    });
    const contexts = {
      gate: { state: 'success', creatorLogin: null, createdAtIso: CREATED_AT },
      premerge,
    };
    expect(isMergedHeadRetroMergeEligible(entry, makeFacts({ contexts }), policy, NOW)).toBe(false);
    expect(invocations).toBe(0);
  });

  it('refuses a throwing Proxy, an accessor-lying Proxy, and an enormous length', () => {
    // Control: the unmodified eligible input passes, so a constant `false` fails this test.
    expect(isMergedHeadRetroMergeEligible(makeEntry(), makeFacts(), makePolicy(), NOW)).toBe(true);
    const entry = makeEntry();
    const policy = makePolicy();
    const facts = makeFacts();
    // A Proxy whose get trap throws is not eligible. Cost O(1): the refusal
    // is the catch, and nothing walks a length.
    const throwingProxy = new Proxy(facts, {
      get(): never {
        throw new Error('proxy get');
      },
    });
    expect(isMergedHeadRetroMergeEligible(entry, throwingProxy, policy, NOW)).toBe(false);
    // A Proxy that reports `pr` as an accessor is refused without calling
    // that accessor. A Proxy that lies consistently in every trap stays an
    // accepted residual; this one does not.
    let accessorRan = false;
    const lyingProxy = new Proxy(facts, {
      getOwnPropertyDescriptor(target, prop) {
        if (prop === 'pr') {
          return {
            configurable: true,
            enumerable: true,
            get(): unknown {
              accessorRan = true;
              return target.pr;
            },
          };
        }
        return Reflect.getOwnPropertyDescriptor(target, prop);
      },
    });
    expect(isMergedHeadRetroMergeEligible(entry, lyingProxy, policy, NOW)).toBe(false);
    expect(accessorRan).toBe(false);
    expect(
      isMergedHeadRetroMergeEligible(entry, { ...facts, length: Number.MAX_SAFE_INTEGER }, policy, NOW),
    ).toBe(false);
  });

  it('refuses non-array, sparse, and oversized requiredContexts', () => {
    // Control: the unmodified eligible input passes, so a constant `false` fails this test.
    expect(isMergedHeadRetroMergeEligible(makeEntry(), makeFacts(), makePolicy(), NOW)).toBe(true);
    const entry = makeEntry();
    const facts = makeFacts();
    expect(
      isMergedHeadRetroMergeEligible(entry, facts, makePolicy({ requiredContexts: 'nope' }), NOW),
    ).toBe(false);
    expect(
      isMergedHeadRetroMergeEligible(entry, facts, makePolicy({ requiredContexts: [] }), NOW),
    ).toBe(false);
    const sparse: Array<string | undefined> = ['gate', undefined, 'premerge'];
    expect(
      isMergedHeadRetroMergeEligible(entry, facts, makePolicy({ requiredContexts: sparse }), NOW),
    ).toBe(false);
    // A real array hole (index 1 missing), not an explicit undefined element.
    const hole: string[] = [];
    hole[0] = 'gate';
    hole[2] = 'premerge';
    expect(
      isMergedHeadRetroMergeEligible(entry, facts, makePolicy({ requiredContexts: hole }), NOW),
    ).toBe(false);
    // An array-like with an enormous length is not an array, so the refusal
    // is the Array.isArray check: O(1), the length is never walked.
    const arrayLike = { length: 1e15, 0: 'gate' };
    expect(
      isMergedHeadRetroMergeEligible(entry, facts, makePolicy({ requiredContexts: arrayLike }), NOW),
    ).toBe(false);
    expect(
      isMergedHeadRetroMergeEligible(
        entry,
        facts,
        makePolicy({ requiredContexts: Array.from({ length: 33 }, (_, i) => `ctx-${i}`) }),
        NOW,
      ),
    ).toBe(false);
  });

  it('refuses a live policy, an invalid now timestamp, a head that is not the entry head, and a re-read that mismatches or is unknown', () => {
    // Control: the unmodified eligible input passes, so a constant `false` fails this test.
    expect(isMergedHeadRetroMergeEligible(makeEntry(), makeFacts(), makePolicy(), NOW)).toBe(true);
    const entry = makeEntry();
    const facts = makeFacts();
    expect(isMergedHeadRetroMergeEligible(entry, facts, makePolicy({ shadow: false }), NOW)).toBe(false);
    expect(isMergedHeadRetroMergeEligible(entry, facts, makePolicy(), '2026-11-01T12:00:00')).toBe(false);
    expect(isMergedHeadRetroMergeEligible(entry, facts, makePolicy(), '')).toBe(false);
    expect(
      isMergedHeadRetroMergeEligible(entry, { ...facts, pr: { status: 'merged', headOid: HEAD3 } }, makePolicy(), NOW),
    ).toBe(false);
    expect(
      isMergedHeadRetroMergeEligible(entry, { ...facts, reReadHeadOid: HEAD3 }, makePolicy(), NOW),
    ).toBe(false);
    expect(
      isMergedHeadRetroMergeEligible(entry, { ...facts, reReadHeadOid: 'unknown' }, makePolicy(), NOW),
    ).toBe(false);
    expect(
      isMergedHeadRetroMergeEligible(entry, { ...facts, reReadHeadOid: null }, makePolicy(), NOW),
    ).toBe(false);
    expect(
      isMergedHeadRetroMergeEligible(entry, { ...facts, pr: { status: 'open', headOid: HEAD, mergeStateStatus: 'CLEAN' } }, makePolicy(), NOW),
    ).toBe(false);
  });

  it('refuses when a required context is pending, failed, or missing', () => {
    // Control: the unmodified eligible input passes, so a constant `false` fails this test.
    expect(isMergedHeadRetroMergeEligible(makeEntry(), makeFacts(), makePolicy(), NOW)).toBe(true);
    const entry = makeEntry();
    const policy = makePolicy();
    expect(
      isMergedHeadRetroMergeEligible(
        entry,
        makeFacts({ contexts: { gate: { state: 'pending' }, premerge: { state: 'success', creatorLogin: POSTER, createdAtIso: CREATED_AT } } }),
        policy,
        NOW,
      ),
    ).toBe(false);
    expect(
      isMergedHeadRetroMergeEligible(
        entry,
        makeFacts({
          contexts: {
            gate: { state: 'success', createdAtIso: CREATED_AT },
            premerge: { state: 'success', creatorLogin: 'someone-else', createdAtIso: CREATED_AT },
          },
        }),
        policy,
        NOW,
      ),
    ).toBe(false);
    expect(
      isMergedHeadRetroMergeEligible(entry, makeFacts({ contexts: 'unknown' }), policy, NOW),
    ).toBe(false);
    expect(
      isMergedHeadRetroMergeEligible(
        entry,
        makeFacts({ contexts: { gate: { state: 'missing' }, premerge: { state: 'success', creatorLogin: POSTER, createdAtIso: CREATED_AT } } }),
        policy,
        NOW,
      ),
    ).toBe(false);
  });

  it('refuses unknown or non-zero unresolved threads', () => {
    // Control: the unmodified eligible input passes, so a constant `false` fails this test.
    expect(isMergedHeadRetroMergeEligible(makeEntry(), makeFacts(), makePolicy(), NOW)).toBe(true);
    const entry = makeEntry();
    const policy = makePolicy();
    expect(
      isMergedHeadRetroMergeEligible(entry, makeFacts({ unresolvedThreads: { status: 'unknown' } }), policy, NOW),
    ).toBe(false);
    expect(
      isMergedHeadRetroMergeEligible(entry, makeFacts({ unresolvedThreads: { status: 'known', count: 2 } }), policy, NOW),
    ).toBe(false);
  });

  it('refuses a veto hold, an act veto, and an unreadable veto record', () => {
    // Control: the unmodified eligible input passes, so a constant `false` fails this test.
    expect(isMergedHeadRetroMergeEligible(makeEntry(), makeFacts(), makePolicy(), NOW)).toBe(true);
    const entry = makeEntry();
    const holdFacts = makeFacts({
      veto: { outcome: 'hold-for-human', confidence: 0.9, mode: 'live', decisionReceiptId: null },
    });
    expect(
      isMergedHeadRetroMergeEligible(entry, holdFacts, makePolicy({ veto: { mode: 'live' } }), NOW),
    ).toBe(false);
    expect(
      isMergedHeadRetroMergeEligible(entry, holdFacts, makePolicy({ veto: { mode: 'shadow' } }), NOW),
    ).toBe(false);
    // `act-veto`: a null veto under a non-off mode would drive the live
    // merge row; the retro estimate refuses it too.
    expect(isMergedHeadRetroMergeEligible(entry, makeFacts(), makePolicy({ veto: { mode: 'live' } }), NOW)).toBe(false);
    expect(
      isMergedHeadRetroMergeEligible(
        entry,
        makeFacts({ veto: { outcome: 'not-an-outcome' } }),
        makePolicy({ veto: { mode: 'live' } }),
        NOW,
      ),
    ).toBe(false);
  });

  it('refuses a parked entry unless its park reason is checks', () => {
    const policy = makePolicy();
    const facts = makeFacts();
    expect(
      isMergedHeadRetroMergeEligible(makeEntry({ state: 'parked', reason: 'macos' }), facts, policy, NOW),
    ).toBe(false);
    expect(
      isMergedHeadRetroMergeEligible(makeEntry({ state: 'parked', reason: 'checks' }), facts, policy, NOW),
    ).toBe(true);
  });

  it('refuses when the merge-commit time or a context creation time is missing, unparsable, or after the merge', () => {
    const entry = makeEntry();
    const policy = makePolicy();
    expect(isMergedHeadRetroMergeEligible(entry, makeFacts({ mergedAtIso: null }), policy, NOW)).toBe(false);
    expect(
      isMergedHeadRetroMergeEligible(entry, makeFacts({ mergedAtIso: 'not-a-timestamp' }), policy, NOW),
    ).toBe(false);
    const factsWithoutMergeTime = makeFacts();
    delete (factsWithoutMergeTime as { mergedAtIso?: string }).mergedAtIso;
    expect(isMergedHeadRetroMergeEligible(entry, factsWithoutMergeTime, policy, NOW)).toBe(false);
    // A context creation time after the merge commit: the status was re-run
    // on a later head, so the merge state at merge time is not what these
    // facts show.
    const lateCreated = makeFacts({
      contexts: {
        gate: { state: 'success', creatorLogin: null, createdAtIso: '2026-11-01T11:30:00.000Z' },
        premerge: { state: 'success', creatorLogin: POSTER, createdAtIso: CREATED_AT },
      },
    });
    expect(isMergedHeadRetroMergeEligible(entry, lateCreated, policy, NOW)).toBe(false);
    const missingCreated = makeFacts({
      contexts: {
        gate: { state: 'success', creatorLogin: null },
        premerge: { state: 'success', creatorLogin: POSTER, createdAtIso: CREATED_AT },
      },
    });
    expect(isMergedHeadRetroMergeEligible(entry, missingCreated, policy, NOW)).toBe(false);
    // Text order is not chronological. `11:30Z` sorts before `12:00+01:00`,
    // but 11:30 UTC is after 11:00 UTC, so the status was created after the
    // merge and the retro refuses. An offset instant one second BEFORE the
    // merge (`11:59:59+01:00` vs `11:00Z`) passes: comparison is by instant.
    const textEarlierButLater = makeFacts({
      mergedAtIso: '2026-11-01T12:00:00.000+01:00',
      contexts: {
        gate: { state: 'success', creatorLogin: null, createdAtIso: '2026-11-01T11:30:00.000Z' },
        premerge: { state: 'success', creatorLogin: POSTER, createdAtIso: '2026-11-01T10:00:00.000Z' },
      },
    });
    expect(isMergedHeadRetroMergeEligible(entry, textEarlierButLater, policy, NOW)).toBe(false);
    const offsetJustBefore = makeFacts({
      mergedAtIso: '2026-11-01T11:00:00.000Z',
      contexts: {
        gate: { state: 'success', creatorLogin: null, createdAtIso: '2026-11-01T11:59:59.000+01:00' },
        premerge: { state: 'success', creatorLogin: POSTER, createdAtIso: '2026-11-01T11:59:59.000+01:00' },
      },
    });
    expect(isMergedHeadRetroMergeEligible(entry, offsetJustBefore, policy, NOW)).toBe(true);
  });

  it('refuses a required context created at the merge instant or within the same millisecond', () => {
    const entry = makeEntry();
    const policy = makePolicy();
    // Control: a context created before the merge is eligible.
    expect(isMergedHeadRetroMergeEligible(entry, makeFacts(), policy, NOW)).toBe(true);
    const contextsAt = (createdAtIso: string): Record<string, unknown> => ({
      gate: { state: 'success', creatorLogin: null, createdAtIso: CREATED_AT },
      premerge: { state: 'success', creatorLogin: POSTER, createdAtIso },
    });
    // Exactly the merge instant.
    expect(
      isMergedHeadRetroMergeEligible(entry, makeFacts({ mergedAtIso: '2026-11-01T11:00:00.000Z', contexts: contextsAt('2026-11-01T11:00:00.000Z') }), policy, NOW),
    ).toBe(false);
    // Sub-millisecond: the context is later than the merge, but both parse to the same millisecond.
    expect(
      isMergedHeadRetroMergeEligible(entry, makeFacts({ mergedAtIso: '2026-11-01T11:00:00.0001Z', contexts: contextsAt('2026-11-01T11:00:00.0009Z') }), policy, NOW),
    ).toBe(false);
  });

  it('refuses when the observed base does not match or a macos procedure is configured', () => {
    // Control: the unmodified eligible input passes, so a constant `false` fails this test.
    expect(isMergedHeadRetroMergeEligible(makeEntry(), makeFacts(), makePolicy(), NOW)).toBe(true);
    const entry = makeEntry();
    const policy = makePolicy();
    expect(
      isMergedHeadRetroMergeEligible(entry, makeFacts({ observedBaseBranch: 'chain/example' }), policy, NOW),
    ).toBe(false);
    expect(isMergedHeadRetroMergeEligible(entry, makeFacts(), makePolicy({ macosProcedure: 'proc-1' }), NOW)).toBe(false);
  });
});

describe('RunMergePassUseCase retro would-merge (EV2)', () => {
  it('journals would-merge with linkedId before would-already-merged on first green already-merged observation', async () => {
    const { useCase, journal, request } = makeUseCase(retroForge());

    const result = await useCase.runMergePass(request);

    expect(result.outcome).toBe('completed');
    expect(result.entries[0].decision).toBe('journalled');
    // The would-merge pair: exactly one intent and one dry-run result whose
    // linkedId names the merged head and whose detail marks it retro.
    const wouldMerge = await journal.listForKey(MERGE_KEY);
    expect(wouldMerge.map((e) => e.kind)).toEqual(['intent', 'result']);
    expect(wouldMerge[1].outcome).toBe('dry-run');
    expect(wouldMerge[1].reasonCode).toBe('would-merge');
    expect(wouldMerge[1].detail).toBe('retro');
    expect((wouldMerge[1] as { linkedId?: string }).linkedId).toBe(HEAD);
    // The would-already-merged pair, unchanged from SH24a.
    const already = await journal.listForKey(ALREADY_KEY);
    expect(already.map((e) => e.kind)).toEqual(['intent', 'result']);
    expect(already[1].outcome).toBe('dry-run');
    expect(already[1].reasonCode).toBe('would-already-merged');
    // Before: the retro would-merge was journalled first (its intent's ULID
    // sorts strictly before the would-already-merged intent's).
    expect(wouldMerge[0].entryId.localeCompare(already[0].entryId)).toBeLessThan(0);
  });

  it('writes nothing new on second pass when would-already-merged is already journaled', async () => {
    const { useCase, journal, request } = makeUseCase(retroForge());
    await useCase.runMergePass(request);
    const wouldMergeBefore = await journal.listForKey(MERGE_KEY);
    const alreadyBefore = await journal.listForKey(ALREADY_KEY);

    const second = await useCase.runMergePass(request);

    expect(second.outcome).toBe('completed');
    expect(second.entries[0].decision).toBe('no-action');
    expect(second.entries[0].reasonCode).toBe('already-journalled');
    expect(await journal.listForKey(MERGE_KEY)).toEqual(wouldMergeBefore);
    expect(await journal.listForKey(ALREADY_KEY)).toEqual(alreadyBefore);
  });

  it('supersedes a moved merged head and never journals a retro would-merge on the stale entry head', async () => {
    // A head that no longer matches the entry supersedes (SH24a); any retro
    // would-merge is keyed on the head the forge confirms merged — the
    // successor's own head — never on the stale entry head.
    const { useCase, journal, request } = makeUseCase(retroForge({ liveHeadSha: HEAD3 }));

    const result = await useCase.runMergePass(request);

    expect(result.entries[0].decision).toBe('journalled');
    expect(result.entries[0].reasonCode).toBe('would-already-merged');
    // No would-merge and no would-already-merged on the stale entry head.
    expect(await journal.listForKey(MERGE_KEY)).toHaveLength(0);
    expect(await journal.listForKey(ALREADY_KEY)).toHaveLength(0);
    // The supersession is journalled on the predecessor head.
    const superseded = await journal.listForKey(`merge/${DIGEST}/1/${HEAD12}/would-supersede`);
    expect(superseded.map((e) => e.kind)).toEqual(['intent', 'result']);
    // The successor's own head is the one the forge merged. Its re-read
    // matches, so the first observation of that head12 still journals the
    // retro would-merge before would-already-merged.
    const successorMerge = `merge/${DIGEST}/1/${HEAD3_12}/merge-pr`;
    const successorAlready = `merge/${DIGEST}/1/${HEAD3_12}/would-already-merged`;
    const wouldMerge = await journal.listForKey(successorMerge);
    const already = await journal.listForKey(successorAlready);
    expect(wouldMerge.map((e) => e.kind)).toEqual(['intent', 'result']);
    expect(wouldMerge[1].reasonCode).toBe('would-merge');
    expect(wouldMerge[1].detail).toBe('retro');
    expect(wouldMerge[1].linkedId).toBe(HEAD3);
    expect(already.map((e) => e.kind)).toEqual(['intent', 'result']);
    expect(already[1].reasonCode).toBe('would-already-merged');
    expect(wouldMerge[0].entryId.localeCompare(already[0].entryId)).toBeLessThan(0);
  });

  it('journals only would-already-merged when gate is pending', async () => {
    const contexts: MergeContextSnapshot[] = [
      { name: 'gate', state: 'PENDING', isGreen: false, creatorLogin: null, createdAtIso: CREATED_AT },
      { name: 'premerge', state: 'SUCCESS', isGreen: true, creatorLogin: POSTER, createdAtIso: CREATED_AT },
    ];
    const { useCase, journal, request } = makeUseCase(retroForge({ contexts }));

    const result = await useCase.runMergePass(request);

    expect(result.entries[0].decision).toBe('journalled');
    expect(result.entries[0].reasonCode).toBe('would-already-merged');
    expect(await journal.listForKey(MERGE_KEY)).toHaveLength(0);
    expect(await journal.listForKey(ALREADY_KEY)).toHaveLength(2);
  });

  it('journals only would-already-merged when premerge creator is not the configured poster', async () => {
    const contexts: MergeContextSnapshot[] = [
      { name: 'gate', state: 'SUCCESS', isGreen: true, creatorLogin: null, createdAtIso: CREATED_AT },
      { name: 'premerge', state: 'SUCCESS', isGreen: true, creatorLogin: 'someone-else', createdAtIso: CREATED_AT },
    ];
    const { useCase, journal, request } = makeUseCase(retroForge({ contexts }));

    const result = await useCase.runMergePass(request);

    expect(result.entries[0].decision).toBe('journalled');
    expect(result.entries[0].reasonCode).toBe('would-already-merged');
    expect(await journal.listForKey(MERGE_KEY)).toHaveLength(0);
    expect(await journal.listForKey(ALREADY_KEY)).toHaveLength(2);
  });

  it('journals only would-already-merged when unresolved threads are unknown or non-zero', async () => {
    for (const unresolvedThreads of ['unknown' as const, 2]) {
      const { useCase, journal, request } = makeUseCase(retroForge({ unresolvedThreads }));

      const result = await useCase.runMergePass(request);

      expect(result.entries[0].reasonCode).toBe('would-already-merged');
      expect(await journal.listForKey(MERGE_KEY)).toHaveLength(0);
      expect(await journal.listForKey(ALREADY_KEY)).toHaveLength(2);
    }
  });

  it('journals only would-already-merged when veto holds', async () => {
    // `live` is park-hold; `shadow` is would-hold. Both refuse the retro.
    for (const mode of ['live', 'shadow'] as const) {
      const entry = makeEntry({
        veto: { outcome: 'hold-for-human', confidence: 0.9, mode: 'live', decisionReceiptId: null },
      });
      const { useCase, journal, request } = makeUseCase(retroForge(), { veto: { mode } }, [entry]);

      const result = await useCase.runMergePass(request);

      expect(result.entries[0].reasonCode).toBe('would-already-merged');
      expect(await journal.listForKey(MERGE_KEY)).toHaveLength(0);
      expect(await journal.listForKey(ALREADY_KEY)).toHaveLength(2);
    }
  });

  it('returns budget-exhausted when deadline is spent before already-merged journal lookup', async () => {
    // The already-merged lookup is the first read of that key. Its own
    // guard runs before the read, while 3 s remain (allowed). The read
    // itself moves the clock to 1 s left. The next guard — the retro
    // `would-merge` this green head reaches, which is before
    // `would-already-merged` is written — refuses, and nothing is journaled.
    const { useCase, journal, request } = makeUseCase(retroForge(), {}, [makeEntry()], {
      spendClockOnKey: ALREADY_KEY,
    });
    const spent = { ...request, deadlineIso: '2026-11-01T12:00:03.000Z' } as RunMergePassRequest;

    const result = await useCase.runMergePass(spent);

    expect(result.outcome).toBe('budget-exhausted');
    expect(result.reasonCode).toBeNull();
    expect(await journal.listForKey(MERGE_KEY)).toHaveLength(0);
    expect(await journal.listForKey(ALREADY_KEY)).toHaveLength(0);
  });

  it('journals only would-already-merged when the merge-commit time was not observable', async () => {
    const { useCase, journal, request } = makeUseCase(retroForge({ mergedAtIso: null }));

    const result = await useCase.runMergePass(request);

    expect(result.entries[0].reasonCode).toBe('would-already-merged');
    expect(await journal.listForKey(MERGE_KEY)).toHaveLength(0);
    expect(await journal.listForKey(ALREADY_KEY)).toHaveLength(2);
  });

  it('returns no-action already-merged and journals nothing under a live policy', async () => {
    const { useCase, journal, request } = makeUseCase(retroForge(), { shadow: false });

    const result = await useCase.runMergePass(request);

    expect(result.entries[0].decision).toBe('no-action');
    expect(result.entries[0].reasonCode).toBe('already-merged');
    expect(await journal.listForKey(MERGE_KEY)).toHaveLength(0);
    expect(await journal.listForKey(ALREADY_KEY)).toHaveLength(0);
  });

  it('does not re-evaluate the retro on a later pass whose forge read became eligible', async () => {
    // The retro fires only while no `would-already-merged` result exists for
    // the head12. Pass one observes a merged head with no observable merge
    // time; pass two's forge read turns the merge time observable — the
    // first-observation rule still refuses to journal a retro would-merge.
    const reads: Array<ReadForgeMergeResult> = [
      retroForge({ mergedAtIso: null }),
      retroForge(),
    ];
    let call = 0;
    const forgeRead = {
      async readForgeMerge(): Promise<ReadForgeMergeResult> {
        const result = reads[Math.min(call, reads.length - 1)];
        call += 1;
        return result;
      },
      isConfigured(): boolean {
        return true;
      },
    };
    const journal = new LaneRunJournalAdapter();
    let ulid = 0;
    const useCase = new RunMergePassUseCase({
      queue: makeQueue([makeEntry()]),
      forgeRead: forgeRead as unknown as ForgeMergeReadPort,
      verification: verificationFake,
      journal: journal as LaneRunJournalPort,
      halt: haltFake,
      newUlid: () => `01JB${String(++ulid).padStart(22, '0').slice(-22)}`,
      nowIso: () => NOW,
    });
    const request: RunMergePassRequest = {
      repository: { owner: OWNER, repo: REPO },
      repoDigest: DIGEST,
      projectId: 'proj-1',
      policy: makePolicy(),
      deadlineIso: DEADLINE,
    };

    const first = await useCase.runMergePass(request);
    expect(first.entries[0].reasonCode).toBe('would-already-merged');
    expect(await journal.listForKey(MERGE_KEY)).toHaveLength(0);

    const second = await useCase.runMergePass(request);

    expect(second.entries[0].decision).toBe('no-action');
    expect(second.entries[0].reasonCode).toBe('already-journalled');
    expect(await journal.listForKey(MERGE_KEY)).toHaveLength(0);
    expect(await journal.listForKey(ALREADY_KEY)).toHaveLength(2);
  });

  it('journals only would-already-merged when a required context was created after the merge', async () => {
    const contexts: MergeContextSnapshot[] = [
      {
        name: 'gate',
        state: 'SUCCESS',
        isGreen: true,
        creatorLogin: null,
        createdAtIso: '2026-11-01T11:30:00.000Z',
      },
      { name: 'premerge', state: 'SUCCESS', isGreen: true, creatorLogin: POSTER, createdAtIso: CREATED_AT },
    ];
    const { useCase, journal, request } = makeUseCase(retroForge({ contexts }));

    const result = await useCase.runMergePass(request);

    expect(result.entries[0].reasonCode).toBe('would-already-merged');
    expect(await journal.listForKey(MERGE_KEY)).toHaveLength(0);
    expect(await journal.listForKey(ALREADY_KEY)).toHaveLength(2);
  });

  it('journals only would-already-merged when a required context has no creation time', async () => {
    const contexts: MergeContextSnapshot[] = [
      { name: 'gate', state: 'SUCCESS', isGreen: true, creatorLogin: null },
      { name: 'premerge', state: 'SUCCESS', isGreen: true, creatorLogin: POSTER, createdAtIso: CREATED_AT },
    ];
    const { useCase, journal, request } = makeUseCase(retroForge({ contexts }));

    const result = await useCase.runMergePass(request);

    expect(result.entries[0].reasonCode).toBe('would-already-merged');
    expect(await journal.listForKey(MERGE_KEY)).toHaveLength(0);
    expect(await journal.listForKey(ALREADY_KEY)).toHaveLength(2);
  });

  it('journals only would-already-merged when a macos procedure is configured', async () => {
    const { useCase, journal, request } = makeUseCase(retroForge(), { macosProcedure: 'proc-1' });

    const result = await useCase.runMergePass(request);

    expect(result.entries[0].reasonCode).toBe('would-already-merged');
    expect(await journal.listForKey(MERGE_KEY)).toHaveLength(0);
    expect(await journal.listForKey(ALREADY_KEY)).toHaveLength(2);
  });

  it('journals only would-already-merged when the observed base does not match', async () => {
    const { useCase, journal, request } = makeUseCase(retroForge({ baseRef: 'chain/example' }));

    const result = await useCase.runMergePass(request);

    expect(result.entries[0].reasonCode).toBe('would-already-merged');
    expect(await journal.listForKey(MERGE_KEY)).toHaveLength(0);
    expect(await journal.listForKey(ALREADY_KEY)).toHaveLength(2);
  });

  it('returns no-action entry-failed when the journal read throws', async () => {
    const journal = new LaneRunJournalAdapter();
    let ulid = 0;
    const useCase = new RunMergePassUseCase({
      queue: makeQueue([makeEntry()]),
      forgeRead: forgeReadFake(retroForge()),
      verification: verificationFake,
      journal: {
        append: (entry) => journal.append(entry),
        async listForKey(): Promise<never> {
          throw new Error('journal unreadable');
        },
      },
      halt: haltFake,
      newUlid: () => `01JB${String(++ulid).padStart(22, '0').slice(-22)}`,
      nowIso: () => NOW,
    });
    const request: RunMergePassRequest = {
      repository: { owner: OWNER, repo: REPO },
      repoDigest: DIGEST,
      projectId: 'proj-1',
      policy: makePolicy(),
      deadlineIso: DEADLINE,
    };

    const result = await useCase.runMergePass(request);

    expect(result.outcome).toBe('completed');
    expect(result.entries[0].decision).toBe('no-action');
    expect(result.entries[0].reasonCode).toBe('entry-failed');
    expect(await journal.listForKey(MERGE_KEY)).toHaveLength(0);
    expect(await journal.listForKey(ALREADY_KEY)).toHaveLength(0);
  });

  it('returns no-action with the refusal reason when the would-merge append is refused', async () => {
    const journal = new LaneRunJournalAdapter();
    let ulid = 0;
    const useCase = new RunMergePassUseCase({
      queue: makeQueue([makeEntry()]),
      forgeRead: forgeReadFake(retroForge()),
      verification: verificationFake,
      journal: {
        listForKey: (key: string) => journal.listForKey(key),
        async append(entry) {
          // Only the retro would-merge key is refused. A pass that ignored
          // the refusal would still append would-already-merged below.
          if (typeof entry.key === 'string' && entry.key.endsWith('/merge-pr')) {
            return { outcome: 'refused' as const, reason: 'invalid-entry' as const, detail: null };
          }
          return journal.append(entry);
        },
      },
      halt: haltFake,
      newUlid: () => `01JB${String(++ulid).padStart(22, '0').slice(-22)}`,
      nowIso: () => NOW,
    });
    const request: RunMergePassRequest = {
      repository: { owner: OWNER, repo: REPO },
      repoDigest: DIGEST,
      projectId: 'proj-1',
      policy: makePolicy(),
      deadlineIso: DEADLINE,
    };

    const result = await useCase.runMergePass(request);

    expect(result.outcome).toBe('completed');
    expect(result.entries[0].decision).toBe('no-action');
    expect(result.entries[0].reasonCode).toBe('invalid-entry');
    expect(await journal.listForKey(MERGE_KEY)).toHaveLength(0);
    expect(await journal.listForKey(ALREADY_KEY)).toHaveLength(0);
  });

  it('returns no-action entry-failed when the journal append throws', async () => {
    const journal = new LaneRunJournalAdapter();
    let ulid = 0;
    const useCase = new RunMergePassUseCase({
      queue: makeQueue([makeEntry()]),
      forgeRead: forgeReadFake(retroForge()),
      verification: verificationFake,
      journal: {
        listForKey: (key: string) => journal.listForKey(key),
        async append(): Promise<never> {
          throw new Error('append failed');
        },
      },
      halt: haltFake,
      newUlid: () => `01JB${String(++ulid).padStart(22, '0').slice(-22)}`,
      nowIso: () => NOW,
    });
    const request: RunMergePassRequest = {
      repository: { owner: OWNER, repo: REPO },
      repoDigest: DIGEST,
      projectId: 'proj-1',
      policy: makePolicy(),
      deadlineIso: DEADLINE,
    };

    const result = await useCase.runMergePass(request);

    expect(result.outcome).toBe('completed');
    expect(result.entries[0].decision).toBe('no-action');
    expect(result.entries[0].reasonCode).toBe('entry-failed');
    expect(await journal.listForKey(MERGE_KEY)).toHaveLength(0);
    expect(await journal.listForKey(ALREADY_KEY)).toHaveLength(0);
  });
});
