import { describe, expect, it } from 'vitest';

import {
  MERGE_QUEUE_DEFAULT_MAX_ATTEMPTS,
  computeMergeBackoffIso,
  decideMergeStep,
} from '../merge-queue-decider.js';
import type { MergeRepoPolicy, MergeStepDecision, MergeStepFacts } from '../merge-queue-decider.js';
import { MERGE_QUEUE_ENTRY_VERSION } from '../merge-queue-records.js';
import type { MergeQueueEntryRecord } from '../merge-queue-records.js';

const HEAD = '0123456789abcdef0123456789abcdef01234567';
const HEAD_2 = '0123456789abcdef0123456789abcdef01234568';
const DIGEST = '0123456789ab';
const NOW = '2026-11-01T12:00:00.000Z';
const POSTER = 'premerge-bot';
const PROCEDURE = 'macos-procedure';

let entryIdCounter = 0;
function nextEntryId(): string {
  const ordinal = String(entryIdCounter).padStart(22, '0').slice(-22);
  entryIdCounter += 1;
  return '01JB' + ordinal;
}

function makeEntry(overrides: Partial<MergeQueueEntryRecord> = {}): MergeQueueEntryRecord {
  return {
    version: MERGE_QUEUE_ENTRY_VERSION,
    entryId: nextEntryId(),
    repository: { owner: 'fleet', repo: 'v2' },
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
  const policy: Record<string, unknown> = {
    policyRevision: 'rev-1',
    updateBranch: true,
    shadow: false,
    unattended: true,
    premergePosterLogin: POSTER,
    veto: { mode: 'off' },
    ...overrides,
  };
  return policy as unknown as MergeRepoPolicy;
}

function makeOpenFacts(overrides: Record<string, unknown> = {}): MergeStepFacts {
  return {
    halted: false,
    paused: false,
    isQueueHead: true,
    pr: { status: 'open', headOid: HEAD, mergeStateStatus: 'CLEAN' },
    reReadHeadOid: HEAD,
    headObservedAtIso: NOW,
    contexts: {
      gate: { state: 'success' },
      premerge: { state: 'success', creatorLogin: POSTER },
    },
    unresolvedThreads: { status: 'known', count: 0 },
    updatesInLastHour: 0,
    premergeCarry: { status: 'ineligible' },
    disjointness: 'not-applicable',
    macosVerification: { status: 'none' },
    ...overrides,
  } as MergeStepFacts;
}

/** An entry whose recorded readiness already satisfies the policy. */
function makeReadyEntry(overrides: Partial<MergeQueueEntryRecord> = {}, verifiedBy: 'contexts' | 'procedure' = 'contexts'): MergeQueueEntryRecord {
  return makeEntry({
    state: 'ready',
    verifiedHeadOid: HEAD,
    verifiedBy,
    policyRevision: 'rev-1',
    ...overrides,
  });
}

function minutesBeforeNow(minutes: number, seconds = 0): string {
  return new Date(Date.parse(NOW) - (minutes * 60 + seconds) * 1000).toISOString();
}

function updateEntry(overrides: Partial<MergeQueueEntryRecord> = {}): MergeQueueEntryRecord {
  return makeEntry({ tier: 2, enqueuedBy: 'update', supersedes: '01JC000000000000000000AAAA', ...overrides });
}

function expectWait(decision: MergeStepDecision, reason: string): void {
  expect(decision.kind).toBe('wait');
  if (decision.kind === 'wait') {
    expect(decision.reason).toBe(reason);
  }
}

function expectPark(decision: MergeStepDecision, reason: string): void {
  expect(decision.kind).toBe('park');
  if (decision.kind === 'park') {
    expect(decision.reason).toBe(reason);
  }
}

describe('supersede (row 2)', () => {
  it('supersedes at a new PR head', () => {
    const decision = decideMergeStep(makeEntry(), makeOpenFacts({ pr: { status: 'open', headOid: HEAD_2, mergeStateStatus: 'CLEAN' } }), makePolicy(), NOW);
    expect(decision).toEqual({ kind: 'supersede', liveHeadOid: HEAD_2 });
  });

  it('supersedes at a different re-read head', () => {
    const decision = decideMergeStep(makeEntry(), makeOpenFacts({ reReadHeadOid: HEAD_2 }), makePolicy(), NOW);
    expect(decision).toEqual({ kind: 'supersede', liveHeadOid: HEAD_2 });
  });
});

describe('halt and pause (row 3)', () => {
  it.each([
    ['halted', { halted: true }],
    ['halted', { halted: 'unreadable' }],
    ['paused', { paused: true }],
    ['paused', { paused: 'unreadable' }],
  ])('waits %s for %j', (reason, overrides) => {
    const decision = decideMergeStep(makeEntry(), makeOpenFacts(overrides), makePolicy(), NOW);
    expectWait(decision, reason);
  });

  it('waits halted even without a policy', () => {
    const decision = decideMergeStep(makeEntry(), makeOpenFacts({ halted: true }), null, NOW);
    expectWait(decision, 'halted');
  });
});

describe('policy unreadable (row 5)', () => {
  it('parks without backoff on a null policy', () => {
    const decision = decideMergeStep(makeEntry(), makeOpenFacts(), null, NOW);
    expect(decision).toEqual({ kind: 'park', reason: 'policy-unreadable', detail: null, backoff: false, notBeforeIso: null, nextAttempt: 0 });
  });

  it('parks without backoff when updateBranch is missing', () => {
    const raw = { ...makePolicy() } as Record<string, unknown>;
    delete raw.updateBranch;
    const decision = decideMergeStep(makeEntry({ attempt: 2 }), makeOpenFacts(), raw as unknown as MergeRepoPolicy, NOW);
    expect(decision).toEqual({ kind: 'park', reason: 'policy-unreadable', detail: null, backoff: false, notBeforeIso: null, nextAttempt: 2 });
  });
});

describe('update row (row 9)', () => {
  function behind(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return { pr: { status: 'open', headOid: HEAD, mergeStateStatus: 'BEHIND' }, ...overrides };
  }

  it('acts update-branch live under the cap', () => {
    const decision = decideMergeStep(makeEntry(), makeOpenFacts(behind()), makePolicy(), NOW);
    expect(decision).toEqual({
      kind: 'act', action: 'update-branch', execution: 'live', shadowReason: null,
      expectedHeadOid: HEAD, receiptHeadOid: null, procedure: null, vetoShadow: null,
    });
  });

  it('acts update-branch in shadow with the repo', () => {
    const decision = decideMergeStep(makeEntry(), makeOpenFacts(behind()), makePolicy({ shadow: true }), NOW);
    expect(decision).toEqual({
      kind: 'act', action: 'update-branch', execution: 'shadow', shadowReason: 'would-update-branch',
      expectedHeadOid: HEAD, receiptHeadOid: null, procedure: null, vetoShadow: null,
    });
  });

  it('parks update-churn at the cap without backoff', () => {
    const decision = decideMergeStep(makeEntry(), makeOpenFacts(behind({ updatesInLastHour: 3 })), makePolicy(), NOW);
    expectPark(decision, 'update-churn');
    if (decision.kind === 'park') {
      expect(decision.backoff).toBe(false);
    }
  });

  it('waits updating inside the grace and acts at the boundary', () => {
    const inside = decideMergeStep(makeEntry(), makeOpenFacts(behind({ pendingUpdateSinceIso: minutesBeforeNow(4) })), makePolicy(), NOW);
    expectWait(inside, 'updating');
    const boundary = decideMergeStep(makeEntry(), makeOpenFacts(behind({ pendingUpdateSinceIso: minutesBeforeNow(5) })), makePolicy(), NOW);
    expect(boundary.kind).toBe('act');
    if (boundary.kind === 'act') {
      expect(boundary.action).toBe('update-branch');
    }
  });

  it('parks update-refused when the policy forbids updates', () => {
    const decision = decideMergeStep(makeEntry(), makeOpenFacts(behind()), makePolicy({ updateBranch: false }), NOW);
    expectPark(decision, 'update-refused');
  });

  it('parks update-refused from the recorded forge outcome even when CLEAN', () => {
    const decision = decideMergeStep(makeEntry(), makeOpenFacts({ lastForgeOutcome: { outcome: 'update-refused' } }), makePolicy(), NOW);
    expectPark(decision, 'update-refused');
  });
});

describe('checks pending (row 10)', () => {
  it('waits checks-pending on a pending gate', () => {
    const decision = decideMergeStep(makeEntry(), makeOpenFacts({ contexts: { gate: { state: 'pending' }, premerge: { state: 'success', creatorLogin: POSTER } } }), makePolicy(), NOW);
    expectWait(decision, 'checks-pending');
  });

  it('waits checks-pending on a gate missing inside the grace', () => {
    const facts = makeOpenFacts({ contexts: { gate: { state: 'missing' }, premerge: { state: 'success', creatorLogin: POSTER } }, headObservedAtIso: minutesBeforeNow(0, 299) });
    expectWait(decideMergeStep(makeEntry(), facts, makePolicy(), NOW), 'checks-pending');
  });

  it('waits checks-pending on premerge missing inside 20 minutes for a conductor entry', () => {
    const facts = makeOpenFacts({ contexts: { gate: { state: 'success' }, premerge: { state: 'missing' } }, headObservedAtIso: minutesBeforeNow(19, 59) });
    expectWait(decideMergeStep(makeEntry(), facts, makePolicy(), NOW), 'checks-pending');
  });
});

describe('checks failed (row 10)', () => {
  it.each([
    ['gate failure', { gate: { state: 'failure' }, premerge: { state: 'success', creatorLogin: POSTER } }, 'gate'],
    ['gate skipped', { gate: { state: 'skipped' }, premerge: { state: 'success', creatorLogin: POSTER } }, 'gate'],
    ['gate neutral', { gate: { state: 'neutral' }, premerge: { state: 'success', creatorLogin: POSTER } }, 'gate'],
    ['premerge wrong creator', { gate: { state: 'success' }, premerge: { state: 'success', creatorLogin: 'someone-else' } }, 'premerge'],
    ['premerge null creator', { gate: { state: 'success' }, premerge: { state: 'success', creatorLogin: null } }, 'premerge'],
    ['gate missing past grace', { gate: { state: 'missing' }, premerge: { state: 'success', creatorLogin: POSTER } }, 'gate'],
    ['custom context missing', { gate: { state: 'success' }, premerge: { state: 'success', creatorLogin: POSTER }, deploy: { state: 'missing' } }, 'deploy'],
  ])('parks checks on %s', (_name, contexts, detail) => {
    const observed = _name === 'custom context missing' ? NOW : minutesBeforeNow(5);
    const policy = _name === 'custom context missing' ? makePolicy({ requiredContexts: ['gate', 'premerge', 'deploy'] }) : makePolicy();
    const decision = decideMergeStep(makeEntry(), makeOpenFacts({ contexts, headObservedAtIso: observed }), policy, NOW);
    expect(decision).toEqual({
      kind: 'park', reason: 'checks', detail, backoff: true,
      notBeforeIso: computeMergeBackoffIso(NOW, 0), nextAttempt: 1,
    });
  });

  it('drops checks once attempts are spent', () => {
    const facts = makeOpenFacts({ contexts: { gate: { state: 'failure' }, premerge: { state: 'success', creatorLogin: POSTER } } });
    const decision = decideMergeStep(makeEntry({ attempt: 9 }), facts, makePolicy(), NOW);
    expect(decision).toEqual({ kind: 'drop', reason: 'checks', detail: 'gate' });
  });
});

describe('threads (row 12)', () => {
  it('parks threads without backoff', () => {
    const decision = decideMergeStep(makeEntry(), makeOpenFacts({ unresolvedThreads: { status: 'known', count: 2 } }), makePolicy(), NOW);
    expectPark(decision, 'threads');
    if (decision.kind === 'park') {
      expect(decision.backoff).toBe(false);
    }
  });

  it('waits threads-unknown', () => {
    expectWait(decideMergeStep(makeEntry(), makeOpenFacts({ unresolvedThreads: { status: 'unknown' } }), makePolicy(), NOW), 'threads-unknown');
  });
});

describe('premerge carry (row 13)', () => {
  function carryFacts(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      contexts: { gate: { state: 'success' }, premerge: { state: 'missing' } },
      ...overrides,
    };
  }

  it('acts premerge-carry live at the carried receipt', () => {
    const decision = decideMergeStep(updateEntry(), makeOpenFacts(carryFacts({ premergeCarry: { status: 'eligible', receiptHeadOid: HEAD_2 } })), makePolicy(), NOW);
    expect(decision).toEqual({
      kind: 'act', action: 'premerge-carry', execution: 'live', shadowReason: null,
      expectedHeadOid: HEAD, receiptHeadOid: HEAD_2, procedure: null, vetoShadow: null,
    });
  });

  it('acts premerge-carry in shadow with the repo', () => {
    const decision = decideMergeStep(updateEntry(), makeOpenFacts(carryFacts({ premergeCarry: { status: 'eligible', receiptHeadOid: HEAD_2 } })), makePolicy({ shadow: true }), NOW);
    if (decision.kind !== 'act') {
      expect(decision.kind).toBe('act');
    } else {
      expect(decision.execution).toBe('shadow');
      expect(decision.shadowReason).toBe('would-post-status');
    }
  });

  it('parks premerge without backoff when ineligible', () => {
    const decision = decideMergeStep(updateEntry(), makeOpenFacts(carryFacts()), makePolicy(), NOW);
    expectPark(decision, 'premerge');
    if (decision.kind === 'park') {
      expect(decision.backoff).toBe(false);
    }
  });

  it('waits premerge-carry-unknown', () => {
    const decision = decideMergeStep(updateEntry(), makeOpenFacts(carryFacts({ premergeCarry: { status: 'unknown' } })), makePolicy(), NOW);
    expectWait(decision, 'premerge-carry-unknown');
  });
});

describe('disjointness (row 14)', () => {
  it('parks disjointness without backoff on overlap', () => {
    const decision = decideMergeStep(makeEntry(), makeOpenFacts({ disjointness: 'overlap' }), makePolicy(), NOW);
    expectPark(decision, 'disjointness');
  });

  it('waits disjointness-unknown', () => {
    expectWait(decideMergeStep(makeEntry(), makeOpenFacts({ disjointness: 'unknown' }), makePolicy(), NOW), 'disjointness-unknown');
  });

  it.each(['not-applicable', 'clean'])('continues past %s into enter ready', (disjointness) => {
    const decision = decideMergeStep(makeEntry(), makeOpenFacts({ disjointness }), makePolicy(), NOW);
    expect(decision.kind).toBe('enter');
  });
});

describe('enter ready (row 15)', () => {
  it('enters ready from an unverified entry with all contexts green', () => {
    const decision = decideMergeStep(makeEntry(), makeOpenFacts(), makePolicy(), NOW);
    expect(decision).toEqual({ kind: 'enter', state: 'ready', verifiedHeadOid: HEAD, verifiedBy: 'contexts', policyRevision: 'rev-1' });
  });

  it('re-enters when the stored policy revision differs', () => {
    const entry = makeEntry({ verifiedHeadOid: HEAD, verifiedBy: 'contexts', policyRevision: 'rev-0', state: 'ready' });
    const decision = decideMergeStep(entry, makeOpenFacts(), makePolicy(), NOW);
    expect(decision).toEqual({ kind: 'enter', state: 'ready', verifiedHeadOid: HEAD, verifiedBy: 'contexts', policyRevision: 'rev-1' });
  });
});

describe('macOS verification (row 16)', () => {
  function procedurePolicy(overrides: Record<string, unknown> = {}): MergeRepoPolicy {
    return makePolicy({ macosProcedure: PROCEDURE, ...overrides });
  }

  it('waits not-queue-head for none off head', () => {
    const entry = makeReadyEntry({}, 'procedure');
    const decision = decideMergeStep(entry, makeOpenFacts({ isQueueHead: false }), procedurePolicy(), NOW);
    expectWait(decision, 'not-queue-head');
  });

  it('acts macos-verify live even in repo shadow', () => {
    for (const shadow of [false, true]) {
      const entry = makeReadyEntry({}, 'procedure');
      const decision = decideMergeStep(entry, makeOpenFacts(), procedurePolicy({ shadow }), NOW);
      expect(decision).toEqual({
        kind: 'act', action: 'macos-verify', execution: 'live', shadowReason: null,
        expectedHeadOid: HEAD, receiptHeadOid: null, procedure: PROCEDURE, vetoShadow: null,
      });
    }
  });

  it('enters ready as procedure after a passing run recorded as contexts', () => {
    const entry = makeReadyEntry();
    const decision = decideMergeStep(entry, makeOpenFacts({ macosVerification: { status: 'passed', receiptHeadOid: HEAD } }), procedurePolicy(), NOW);
    expect(decision).toEqual({ kind: 'enter', state: 'ready', verifiedHeadOid: HEAD, verifiedBy: 'procedure', policyRevision: 'rev-1' });
  });

  it('waits macos-unknown for a receipt on another head', () => {
    const entry = makeReadyEntry({}, 'procedure');
    const decision = decideMergeStep(entry, makeOpenFacts({ macosVerification: { status: 'passed', receiptHeadOid: HEAD_2 } }), procedurePolicy(), NOW);
    expectWait(decision, 'macos-unknown');
  });

  it('parks macos with backoff and drops at the cap', () => {
    const entry = makeReadyEntry({}, 'procedure');
    const facts = makeOpenFacts({ macosVerification: { status: 'failed' } });
    const decision = decideMergeStep(entry, facts, procedurePolicy(), NOW);
    expect(decision).toEqual({
      kind: 'park', reason: 'macos', detail: null, backoff: true,
      notBeforeIso: computeMergeBackoffIso(NOW, 0), nextAttempt: 1,
    });
    const dropped = decideMergeStep(makeReadyEntry({ attempt: 9 }, 'procedure'), facts, procedurePolicy(), NOW);
    expect(dropped).toEqual({ kind: 'drop', reason: 'macos', detail: null });
  });
});

describe('veto (rows 15 and 17)', () => {
  function vetoRecord(outcome: string, confidence: number | null, mode: 'live' | 'shadow'): Record<string, unknown> {
    return { outcome, confidence, mode, decisionReceiptId: null };
  }

  it('acts veto live even in repo shadow when no veto is recorded', () => {
    for (const mode of ['live', 'shadow']) {
      for (const shadow of [false, true]) {
        const decision = decideMergeStep(makeReadyEntry(), makeOpenFacts(), makePolicy({ veto: { mode }, shadow }), NOW);
        expect(decision).toEqual({
          kind: 'act', action: 'veto', execution: 'live', shadowReason: null,
          expectedHeadOid: HEAD, receiptHeadOid: null, procedure: null, vetoShadow: null,
        });
      }
    }
  });

  it('parks veto-hold and stays parked on a re-read', () => {
    const policy = makePolicy({ veto: { mode: 'live' } });
    const veto = vetoRecord('hold-for-human', 0.8, 'live');
    const first = decideMergeStep(makeReadyEntry(), makeOpenFacts({ veto }), policy, NOW);
    expectPark(first, 'veto-hold');
    if (first.kind === 'park') {
      expect(first.backoff).toBe(false);
    }
    const parked = makeReadyEntry({ state: 'parked', reason: 'veto-hold' });
    const second = decideMergeStep(parked, makeOpenFacts({ veto }), policy, NOW);
    expectPark(second, 'veto-hold');
  });

  it('merges in shadow with vetoShadow would-hold', () => {
    const policy = makePolicy({ veto: { mode: 'shadow' }, shadow: true, unattended: false });
    const veto = vetoRecord('hold-for-human', 0.85, 'shadow');
    const decision = decideMergeStep(makeReadyEntry(), makeOpenFacts({ veto }), policy, NOW);
    expect(decision).toEqual({
      kind: 'act', action: 'merge-pr', execution: 'shadow', shadowReason: 'would-merge',
      expectedHeadOid: HEAD, receiptHeadOid: null, procedure: null, vetoShadow: 'would-hold',
    });
  });

  it.each([
    ['merge-safe', 0.9, 'live', {}, true],
    ['hold-for-human', 0.79, 'live', {}, true],
    ['unknown', null, 'live', {}, true],
    ['merge-safe', 0.9, 'shadow', { shadow: true }, true],
    ['hold-for-human', 0.79, 'shadow', { shadow: true }, true],
    ['unknown', null, 'shadow', { shadow: true }, true],
  ])('passes %s at %j in veto %s and merges', (outcome, confidence, mode, repoOverrides, unattended) => {
    const policy = makePolicy({ veto: { mode }, unattended, ...repoOverrides });
    const veto = vetoRecord(outcome, confidence, mode === 'live' ? 'live' : 'shadow');
    const decision = decideMergeStep(makeReadyEntry(), makeOpenFacts({ veto }), policy, NOW);
    if (decision.kind !== 'act') {
      expect(decision.kind).toBe('act');
    } else {
      expect(decision.action).toBe('merge-pr');
      expect(decision.vetoShadow).toBeNull();
    }
  });
});

describe('owner gate and merge (rows 15 and 17)', () => {
  it('parks owner-merge for an attended live repo and stays parked', () => {
    const policy = makePolicy({ unattended: false, shadow: false });
    const first = decideMergeStep(makeReadyEntry(), makeOpenFacts(), policy, NOW);
    expectPark(first, 'owner-merge');
    if (first.kind === 'park') {
      expect(first.backoff).toBe(false);
    }
    const parked = makeReadyEntry({ state: 'parked', reason: 'owner-merge' });
    const second = decideMergeStep(parked, makeOpenFacts(), policy, NOW);
    expectPark(second, 'owner-merge');
  });

  it('merges in shadow during the trial instead of parking owner-merge', () => {
    const policy = makePolicy({ shadow: true, unattended: false });
    const decision = decideMergeStep(makeReadyEntry(), makeOpenFacts(), policy, NOW);
    expect(decision).toEqual({
      kind: 'act', action: 'merge-pr', execution: 'shadow', shadowReason: 'would-merge',
      expectedHeadOid: HEAD, receiptHeadOid: null, procedure: null, vetoShadow: null,
    });
  });
});

describe('merge-pr (row 17)', () => {
  it('acts merge-pr live at the verified head', () => {
    const decision = decideMergeStep(makeReadyEntry(), makeOpenFacts(), makePolicy(), NOW);
    expect(decision).toEqual({
      kind: 'act', action: 'merge-pr', execution: 'live', shadowReason: null,
      expectedHeadOid: HEAD, receiptHeadOid: null, procedure: null, vetoShadow: null,
    });
  });

  it('acts merge-pr in shadow when the repo is in the trial', () => {
    const decision = decideMergeStep(makeReadyEntry(), makeOpenFacts(), makePolicy({ shadow: true }), NOW);
    if (decision.kind !== 'act') {
      expect(decision.kind).toBe('act');
    } else {
      expect(decision.action).toBe('merge-pr');
      expect(decision.execution).toBe('shadow');
      expect(decision.shadowReason).toBe('would-merge');
    }
  });

  it('requires a procedure verification before merging with a procedure set', () => {
    const policy = makePolicy({ macosProcedure: PROCEDURE });
    const facts = makeOpenFacts({ macosVerification: { status: 'passed', receiptHeadOid: HEAD } });
    const decision = decideMergeStep(makeReadyEntry({}, 'procedure'), facts, policy, NOW);
    if (decision.kind !== 'act') {
      expect(decision.kind).toBe('act');
    } else {
      expect(decision.action).toBe('merge-pr');
      expect(decision.expectedHeadOid).toBe(HEAD);
    }
  });

  it('parks threads instead of merging when threads appear', () => {
    const decision = decideMergeStep(makeReadyEntry(), makeOpenFacts({ unresolvedThreads: { status: 'known', count: 2 } }), makePolicy(), NOW);
    expectPark(decision, 'threads');
  });

  it('updates instead of merging when the PR falls BEHIND', () => {
    const facts = makeOpenFacts({ pr: { status: 'open', headOid: HEAD, mergeStateStatus: 'BEHIND' } });
    const decision = decideMergeStep(makeReadyEntry(), facts, makePolicy(), NOW);
    if (decision.kind !== 'act') {
      expect(decision.kind).toBe('act');
    } else {
      expect(decision.action).toBe('update-branch');
    }
  });
});

describe('conflict drops (rows 6 and 9)', () => {
  it('drops conflict from the recorded outcome', () => {
    const decision = decideMergeStep(makeEntry(), makeOpenFacts({ lastForgeOutcome: { outcome: 'conflict' } }), makePolicy(), NOW);
    expect(decision).toEqual({ kind: 'drop', reason: 'conflict', detail: null });
  });

  it('drops conflict on a DIRTY merge state', () => {
    const decision = decideMergeStep(makeEntry(), makeOpenFacts({ pr: { status: 'open', headOid: HEAD, mergeStateStatus: 'DIRTY' } }), makePolicy(), NOW);
    expect(decision).toEqual({ kind: 'drop', reason: 'conflict', detail: null });
  });
});

describe('forge errors park or drop with backoff (rows 6 and 7)', () => {
  const CODES = ['protection', 'permission', 'gh-error', 'network', 'http-5xx', 'rate-limit'];

  it.each(CODES)('parks forge-error for %s from the PR read at attempt 0', (code) => {
    const facts = makeOpenFacts({ pr: { status: 'forge-error', code } });
    const decision = decideMergeStep(makeEntry(), facts, makePolicy(), NOW);
    expect(decision).toEqual({
      kind: 'park', reason: 'forge-error', detail: code, backoff: true,
      notBeforeIso: computeMergeBackoffIso(NOW, 0), nextAttempt: 1,
    });
  });

  it.each(CODES)('parks forge-error for %s from the recorded outcome at attempt 0', (code) => {
    const facts = makeOpenFacts({ lastForgeOutcome: { outcome: 'forge-error', code } });
    const decision = decideMergeStep(makeEntry(), facts, makePolicy(), NOW);
    expectPark(decision, 'forge-error');
    if (decision.kind === 'park') {
      expect(decision.detail).toBe(code);
      expect(decision.backoff).toBe(true);
      expect(decision.notBeforeIso).toBe(computeMergeBackoffIso(NOW, 0));
    }
  });

  it.each(CODES)('caps the backoff at 30 minutes for %s at attempt 6', (code) => {
    const facts = makeOpenFacts({ pr: { status: 'forge-error', code } });
    const decision = decideMergeStep(makeEntry({ attempt: 6 }), facts, makePolicy(), NOW);
    if (decision.kind !== 'park') {
      expect(decision.kind).toBe('park');
    } else {
      expect(decision.notBeforeIso).toBe(computeMergeBackoffIso(NOW, 6));
    }
  });

  it('waits backoff before the not-before instant', () => {
    const facts = makeOpenFacts({ pr: { status: 'forge-error', code: 'network' } });
    const notBeforeIso = computeMergeBackoffIso(NOW, 0);
    const decision = decideMergeStep(makeEntry({ notBeforeIso }), facts, makePolicy(), NOW);
    expectWait(decision, 'backoff');
  });

  it('drops forge-error-exhausted at the attempt cap', () => {
    const facts = makeOpenFacts({ pr: { status: 'forge-error', code: 'network' } });
    const decision = decideMergeStep(makeEntry({ attempt: 9 }), facts, makePolicy(), NOW);
    expect(decision).toEqual({ kind: 'drop', reason: 'forge-error-exhausted', detail: 'network' });
  });
});

describe('unknown facts never merge', () => {
  it('refuses to act on each unknown fact', () => {
    const cases: Array<{ overrides: Record<string, unknown>; policy?: Record<string, unknown> }> = [
      { overrides: { pr: { status: 'unknown' } } },
      { overrides: { pr: { status: 'open', headOid: HEAD, mergeStateStatus: 'UNKNOWN' } } },
      { overrides: { contexts: 'unknown' } },
      { overrides: { unresolvedThreads: { status: 'unknown' } } },
      { overrides: { pr: { status: 'open', headOid: HEAD, mergeStateStatus: 'BEHIND' }, updatesInLastHour: 'unknown' } },
      { overrides: { contexts: { gate: { state: 'success' }, premerge: { state: 'missing' } }, premergeCarry: { status: 'unknown' } } },
      { overrides: { disjointness: 'unknown' } },
      { overrides: { macosVerification: { status: 'unknown' } }, policy: { macosProcedure: PROCEDURE } },
      { overrides: { reReadHeadOid: 'unknown' } },
    ];
    for (const testCase of cases) {
      const tier2 = testCase.overrides.premergeCarry !== undefined;
      const entry = tier2
        ? updateEntry({ state: 'ready', verifiedHeadOid: HEAD, verifiedBy: 'contexts', policyRevision: 'rev-1' })
        : makeReadyEntry();
      const policy = testCase.policy === undefined ? makePolicy() : makePolicy(testCase.policy);
      const decision = decideMergeStep(entry, makeOpenFacts(testCase.overrides), policy, NOW);
      expect(decision.kind).not.toBe('act');
    }
  });

  it('parks policy-unreadable for a null policy on a merge-ready entry', () => {
    const decision = decideMergeStep(makeReadyEntry(), makeOpenFacts(), null, NOW);
    expect(decision.kind).toBe('park');
  });

  it('is deterministic and never mutates its inputs', () => {
    const entry = makeReadyEntry();
    const facts = makeOpenFacts();
    const policy = makePolicy();
    const entrySnapshot = JSON.stringify(entry);
    const factsSnapshot = JSON.stringify(facts);
    const first = decideMergeStep(entry, facts, policy, NOW);
    const second = decideMergeStep(entry, facts, policy, NOW);
    expect(first).toEqual(second);
    expect(JSON.stringify(entry)).toBe(entrySnapshot);
    expect(JSON.stringify(facts)).toBe(factsSnapshot);
  });

  it('returns facts-inconsistent on hostile inputs without throwing', () => {
    const hostile = new Proxy({}, {
      get() {
        throw new Error('hostile');
      },
      getOwnPropertyDescriptor() {
        throw new Error('hostile');
      },
    });
    for (const entry of [null, 42, 'entry', [], hostile]) {
      expectWait(decideMergeStep(entry, makeOpenFacts(), makePolicy(), NOW), 'facts-inconsistent');
    }
    for (const facts of [null, 42, 'facts', [], hostile]) {
      expectWait(decideMergeStep(makeEntry(), facts, makePolicy(), NOW), 'facts-inconsistent');
    }
    expectWait(decideMergeStep(makeEntry(), makeOpenFacts(), makePolicy(), '2026-11-01T12:00:00'), 'facts-inconsistent');
  });
});

describe('backoff helper', () => {
  it('doubles from 30 seconds and caps at 30 minutes', () => {
    expect(computeMergeBackoffIso(NOW, 0)).toBe('2026-11-01T12:00:30.000Z');
    expect(computeMergeBackoffIso(NOW, 6)).toBe('2026-11-01T12:30:00.000Z');
  });

  it('refuses hostile input', () => {
    expect(computeMergeBackoffIso('2026-11-01T12:00:00', 0)).toBeNull();
    expect(computeMergeBackoffIso(NOW, -1)).toBeNull();
    expect(computeMergeBackoffIso(NOW, Number.NaN)).toBeNull();
  });
});

describe('defaults', () => {
  it('defaults maxAttempts to the lane retry cap', () => {
    expect(MERGE_QUEUE_DEFAULT_MAX_ATTEMPTS).toBe(9);
  });
});
