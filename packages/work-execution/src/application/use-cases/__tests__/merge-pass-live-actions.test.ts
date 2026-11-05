// Merge-pass live-action module tests — lane DT9b.
/**
 * Covers performMergeLiveAction: validation, keying, budget, the
 * intent-before-action journal order, the crash reconcile path and the
 * "never acts twice" guard. Fakes only; no network, no filesystem, no state
 * directory. The fake journal runs the real pure prepareLaneRunJournalAppend
 * so the real uniqueness and finality rules apply.
 */

import { describe, expect, it } from 'vitest';

import { performMergeLiveAction } from '../merge-pass/live-actions.js';
import type { MergeLiveActionDependencies, MergeLiveActionRequest } from '../merge-pass/live-actions.js';
import type { LaneRunJournalAppendResult, LaneRunJournalPort } from '../../ports/out/LaneRunJournalPort.out-port.js';
import type {
  MergeForgeActionPort,
  MergeForgeActionRequest,
  MergeForgeActionResult,
} from '../../ports/out/MergeForgeActionPort.out-port.js';
import type { ForgeMergeReadPort, ReadForgeMergeResult } from '../../ports/out/ForgeMergeReadPort.out-port.js';
import type { LaneRunJournalEntryRecord, LaneRunJournalOutcome } from '../../../domain/lane-run-journal.js';
import { LANE_RUN_JOURNAL_ENTRY_VERSION } from '../../../domain/lane-run-journal.js';
import { prepareLaneRunJournalAppend } from '../../../domain/lane-run-journal.js';
import type { MergeQueueEntryRecord } from '../../../domain/merge-queue-records.js';
import { MERGE_QUEUE_ENTRY_VERSION } from '../../../domain/merge-queue-records.js';

const HEAD = 'a'.repeat(40);
const OTHER_HEAD = 'b'.repeat(40);
const NOW_ISO = '2026-11-05T09:00:00.000Z';
const DEADLINE_ISO = '2026-11-05T09:01:00.000Z';
const GRANT_ID = 'grant-example-1';

const KEY_MERGE_PR = 'merge/0123456789ab/42/aaaaaaaaaaaa/merge-pr';
const KEY_UPDATE_BRANCH = 'merge/0123456789ab/42/aaaaaaaaaaaa/update-branch';
const KEY_POST_STATUS = 'merge/0123456789ab/42/aaaaaaaaaaaa/post-status';

class FakeJournal implements LaneRunJournalPort {
  readonly entries: LaneRunJournalEntryRecord[] = [];

  async append(entry: LaneRunJournalEntryRecord): Promise<LaneRunJournalAppendResult> {
    const decision = prepareLaneRunJournalAppend(this.entries, entry);
    if (!decision.ok) {
      return { outcome: 'refused', reason: decision.reason, detail: decision.detail };
    }
    this.entries.push(decision.entry);
    return { outcome: 'appended', entry: decision.entry };
  }

  async listForRun(runId: string): Promise<readonly LaneRunJournalEntryRecord[]> {
    return this.entries.filter((entry) => entry.runId === runId);
  }

  async listForKey(key: string): Promise<readonly LaneRunJournalEntryRecord[]> {
    return this.entries.filter((entry) => entry.key === key);
  }
}

class FakeForgeAction implements MergeForgeActionPort {
  readonly requests: MergeForgeActionRequest[] = [];
  result: MergeForgeActionResult = { outcome: 'executed', headSha: HEAD };

  async performMergeForgeAction(request: MergeForgeActionRequest): Promise<MergeForgeActionResult> {
    this.requests.push(request);
    return this.result;
  }

  isConfigured(): boolean {
    return true;
  }
}

class FakeForgeRead implements ForgeMergeReadPort {
  calls = 0;
  result: ReadForgeMergeResult = {
    outcome: 'ok',
    prState: 'open',
    liveHeadSha: HEAD,
    mergeState: 'clean',
    contexts: [],
    unresolvedThreads: 0,
  };

  async readForgeMerge(): Promise<ReadForgeMergeResult> {
    this.calls += 1;
    return this.result;
  }

  isConfigured(): boolean {
    return true;
  }
}

function makeUlidMinter(): () => string {
  let next = 0;
  return () => {
    const id = '01JB00000000000000000000' + String(next).padStart(2, '0');
    next += 1;
    return id;
  };
}

function makeEntry(overrides: Partial<MergeQueueEntryRecord> = {}): MergeQueueEntryRecord {
  return {
    version: MERGE_QUEUE_ENTRY_VERSION,
    entryId: '01JB00000000000000000000AA',
    repository: { owner: 'fleet', repo: 'fleet-v2' },
    repoDigest: '0123456789ab',
    pullRequest: 42,
    headOid: HEAD,
    state: 'ready',
    reason: null,
    attempt: 0,
    notBeforeIso: null,
    enqueuedAtIso: NOW_ISO,
    enqueuedBy: 'cli',
    supersedes: null,
    runId: null,
    attemptId: null,
    workOrderId: null,
    tier: 2,
    verifiedHeadOid: HEAD,
    verifiedBy: 'contexts',
    policyRevision: null,
    premergeReceiptHeadOid: null,
    veto: null,
    mergeCommitOid: null,
    mergedAtIso: null,
    revision: 1,
    ...overrides,
  };
}

function makeRequest(overrides: Partial<MergeLiveActionRequest> = {}): MergeLiveActionRequest {
  return {
    entry: makeEntry(),
    action: 'merge-pr',
    execution: 'live',
    shadowReason: null,
    expectedHeadOid: HEAD,
    branchName: 'feat/merge-pass',
    grantId: GRANT_ID,
    status: null,
    nowIso: NOW_ISO,
    deadlineIso: DEADLINE_ISO,
    retry: null,
    ...overrides,
  };
}

function build(overrides: Partial<MergeLiveActionDependencies> = {}) {
  const journal = new FakeJournal();
  const forgeAction = new FakeForgeAction();
  const forgeRead = new FakeForgeRead();
  const mintId = makeUlidMinter();
  const deps: MergeLiveActionDependencies = { journal, forgeAction, forgeRead, mintId, ...overrides };
  return { journal, forgeAction, forgeRead, deps };
}

function seedIntent(journal: FakeJournal, key: string): void {
  journal.entries.push({
    version: LANE_RUN_JOURNAL_ENTRY_VERSION,
    entryId: '01JB00000000000000000000AA',
    kind: 'intent',
    key,
    runId: null,
    recordedAtIso: NOW_ISO,
    mode: null,
    expectedRevision: null,
    mintedId: '01JB00000000000000000000AB',
    outcome: null,
    reasonCode: null,
    detail: null,
    grantId: null,
    state: null,
  });
}

function seedFinalResult(journal: FakeJournal, key: string, outcome: LaneRunJournalOutcome): void {
  journal.entries.push({
    version: LANE_RUN_JOURNAL_ENTRY_VERSION,
    entryId: '01JB00000000000000000000AC',
    kind: 'result',
    key,
    runId: null,
    recordedAtIso: NOW_ISO,
    mode: null,
    expectedRevision: null,
    mintedId: null,
    outcome,
    reasonCode: null,
    detail: null,
    grantId: GRANT_ID,
    state: null,
  });
}

describe('performMergeLiveAction (DT9b)', () => {
  it('journals the intent before the forge call and one completed result for a live merge-pr', async () => {
    const { journal, forgeAction, deps } = build();
    const result = await performMergeLiveAction(deps, makeRequest());
    expect(result).toEqual({
      outcome: 'acted',
      journalKey: KEY_MERGE_PR,
      actionId: '01JB0000000000000000000000',
      headSha: HEAD,
    });
    expect(journal.entries.map((entry) => entry.kind)).toEqual(['intent', 'result']);
    expect(journal.entries[0]).toMatchObject({ key: KEY_MERGE_PR, mintedId: '01JB0000000000000000000000' });
    expect(journal.entries[1]).toMatchObject({ outcome: 'completed', grantId: GRANT_ID, mintedId: null });
    expect(forgeAction.requests).toHaveLength(1);
    expect(forgeAction.requests[0]).toEqual({
      actionId: '01JB0000000000000000000000',
      repository: { owner: 'fleet', repo: 'fleet-v2' },
      pullRequestNumber: 42,
      branchName: 'feat/merge-pass',
      expectedHeadSha: HEAD,
      deadlineIso: DEADLINE_ISO,
      kind: 'merge-pr',
    });
  });

  it('keys the update-branch action under the merge key family', async () => {
    const { journal, forgeAction, deps } = build();
    const result = await performMergeLiveAction(deps, makeRequest({ action: 'update-branch' }));
    expect(result.outcome).toBe('acted');
    expect(journal.entries[0]?.key).toBe(KEY_UPDATE_BRANCH);
    expect(forgeAction.requests[0]?.kind).toBe('update-branch');
  });

  it('keys the post-status action under the merge key family and posts the premerge status', async () => {
    const { journal, forgeAction, deps } = build();
    const status = { context: 'premerge' as const, state: 'success' as const, description: 'premerge passed' };
    const result = await performMergeLiveAction(deps, makeRequest({ action: 'post-status', status }));
    expect(result.outcome).toBe('acted');
    expect(journal.entries[0]?.key).toBe(KEY_POST_STATUS);
    expect(forgeAction.requests).toHaveLength(1);
    expect(forgeAction.requests[0]).toMatchObject({ kind: 'post-status', status });
  });

  it('refuses to act without a grant and writes nothing', async () => {
    const { journal, forgeAction, deps } = build();
    const result = await performMergeLiveAction(deps, makeRequest({ grantId: '' }));
    expect(result).toEqual({ outcome: 'invalid-request', reasonCode: 'invalid-grant' });
    expect(journal.entries).toHaveLength(0);
    expect(forgeAction.requests).toHaveLength(0);
  });

  it('refuses a request whose expected head is not the entry head', async () => {
    const { journal, forgeAction, deps } = build();
    const result = await performMergeLiveAction(deps, makeRequest({ expectedHeadOid: OTHER_HEAD }));
    expect(result).toEqual({ outcome: 'invalid-request', reasonCode: 'invalid-head' });
    expect(journal.entries).toHaveLength(0);
    expect(forgeAction.requests).toHaveLength(0);
  });

  it('does not call the forge when the journal refuses the intent', async () => {
    const { journal, forgeAction } = build();
    // Seed an unrelated intent whose entry id collides with the second mint (the intent's entry id).
    journal.entries.push({
      version: LANE_RUN_JOURNAL_ENTRY_VERSION,
      entryId: '01JB0000000000000000000001',
      kind: 'intent',
      key: KEY_UPDATE_BRANCH,
      runId: null,
      recordedAtIso: NOW_ISO,
      mode: null,
      expectedRevision: null,
      mintedId: null,
      outcome: null,
      reasonCode: null,
      detail: null,
      grantId: null,
      state: null,
    });
    const mintIds = ['01JB0000000000000000000000', '01JB0000000000000000000001'];
    let next = 0;
    const deps: MergeLiveActionDependencies = {
      journal,
      forgeAction,
      forgeRead: new FakeForgeRead(),
      mintId: () => mintIds[next++] ?? '01JB00000000000000000000FF',
    };
    const result = await performMergeLiveAction(deps, makeRequest());
    expect(result).toEqual({ outcome: 'journal-refused', journalKey: KEY_MERGE_PR, refusal: 'duplicate-entry-id' });
    expect(forgeAction.requests).toHaveLength(0);
  });

  it('reconciles an intent with no result after a crash: the pull request is merged, so it records reconciled and never merges again', async () => {
    const { journal, forgeAction, forgeRead, deps } = build();
    seedIntent(journal, KEY_MERGE_PR);
    forgeRead.result = {
      outcome: 'ok',
      prState: 'merged',
      liveHeadSha: HEAD,
      mergeState: 'clean',
      contexts: [],
      unresolvedThreads: 0,
    };
    const result = await performMergeLiveAction(deps, makeRequest());
    expect(result).toEqual({ outcome: 'reconciled', journalKey: KEY_MERGE_PR, reconcile: 'merged' });
    expect(forgeAction.requests).toHaveLength(0);
    expect(forgeRead.calls).toBe(1);
    expect(journal.entries).toHaveLength(2);
    expect(journal.entries[1]).toMatchObject({ kind: 'result', outcome: 'reconciled', reasonCode: 'merged' });
  });

  it('reconciles an intent with no result: the pull request is still open at the same head, so it records not-started and does not act', async () => {
    const { journal, forgeAction, forgeRead, deps } = build();
    seedIntent(journal, KEY_MERGE_PR);
    forgeRead.result = {
      outcome: 'ok',
      prState: 'open',
      liveHeadSha: HEAD,
      mergeState: 'clean',
      contexts: [],
      unresolvedThreads: 0,
    };
    const result = await performMergeLiveAction(deps, makeRequest());
    expect(result).toEqual({ outcome: 'reconciled', journalKey: KEY_MERGE_PR, reconcile: 'absent' });
    expect(journal.entries[1]).toMatchObject({ outcome: 'not-started', reasonCode: 'absent' });
    expect(forgeAction.requests).toHaveLength(0);
  });

  it('reconciles an intent with no result: the head moved, so it records overtaken', async () => {
    const { journal, forgeAction, forgeRead, deps } = build();
    seedIntent(journal, KEY_MERGE_PR);
    forgeRead.result = {
      outcome: 'ok',
      prState: 'open',
      liveHeadSha: OTHER_HEAD,
      mergeState: 'behind',
      contexts: [],
      unresolvedThreads: 0,
    };
    const result = await performMergeLiveAction(deps, makeRequest());
    expect(result).toEqual({ outcome: 'reconciled', journalKey: KEY_MERGE_PR, reconcile: 'head-moved' });
    expect(journal.entries[1]).toMatchObject({ outcome: 'overtaken', reasonCode: 'head-moved' });
    expect(forgeAction.requests).toHaveLength(0);
  });

  it('keeps the key pending when the reconcile read cannot answer', async () => {
    const { journal, forgeAction, forgeRead, deps } = build();
    seedIntent(journal, KEY_MERGE_PR);
    forgeRead.result = { outcome: 'unavailable', code: 'forge-error', reason: 'network down' };
    const result = await performMergeLiveAction(deps, makeRequest());
    expect(result).toEqual({ outcome: 'ambiguous', journalKey: KEY_MERGE_PR, reasonCode: 'reconcile-unknown' });
    expect(journal.entries[1]).toMatchObject({ outcome: 'ambiguous', reasonCode: 'reconcile-unknown' });
    expect(forgeAction.requests).toHaveLength(0);
  });

  it('never acts twice on a key that already has a final result', async () => {
    const { journal, forgeAction, deps } = build();
    seedIntent(journal, KEY_MERGE_PR);
    seedFinalResult(journal, KEY_MERGE_PR, 'completed');
    const before = journal.entries.length;
    const result = await performMergeLiveAction(deps, makeRequest());
    expect(result).toEqual({ outcome: 'skipped', journalKey: KEY_MERGE_PR, reasonCode: 'already-settled' });
    expect(journal.entries).toHaveLength(before);
    expect(forgeAction.requests).toHaveLength(0);
  });

  it('journals a dry-run would-merge in shadow mode and never calls the forge', async () => {
    const { journal, forgeAction, deps } = build();
    const result = await performMergeLiveAction(
      deps,
      makeRequest({ execution: 'shadow', shadowReason: 'would-merge' }),
    );
    expect(result).toEqual({ outcome: 'dry-run', journalKey: KEY_MERGE_PR, shadowReason: 'would-merge' });
    expect(journal.entries.map((entry) => entry.kind)).toEqual(['intent', 'result']);
    expect(journal.entries[0]).toMatchObject({ key: KEY_MERGE_PR, mintedId: null });
    expect(journal.entries[1]).toMatchObject({ outcome: 'dry-run', reasonCode: 'would-merge', grantId: null });
    expect(forgeAction.requests).toHaveLength(0);
  });

  it('journals a dry-run would-update-branch in shadow mode and never calls the forge', async () => {
    const { journal, forgeAction, deps } = build();
    const result = await performMergeLiveAction(
      deps,
      makeRequest({ action: 'update-branch', execution: 'shadow', shadowReason: 'would-update-branch' }),
    );
    expect(result).toEqual({ outcome: 'dry-run', journalKey: KEY_UPDATE_BRANCH, shadowReason: 'would-update-branch' });
    expect(journal.entries[1]).toMatchObject({ outcome: 'dry-run', reasonCode: 'would-update-branch' });
    expect(forgeAction.requests).toHaveLength(0);
  });

  it('maps a forge refusal to a journalled refused result with the refusal kind', async () => {
    const { journal, forgeAction, deps } = build();
    forgeAction.result = { outcome: 'refused', reason: 'conflict', refusalKind: 'conflict' };
    const result = await performMergeLiveAction(deps, makeRequest());
    expect(result).toEqual({
      outcome: 'refused',
      journalKey: KEY_MERGE_PR,
      refusalKind: 'conflict',
      reasonCode: 'conflict',
    });
    expect(journal.entries[1]).toMatchObject({ outcome: 'refused', reasonCode: 'conflict', grantId: GRANT_ID });
  });

  it('journals an ambiguous result when the forge call cannot answer', async () => {
    const { journal, forgeAction, deps } = build();
    forgeAction.result = { outcome: 'ambiguous', reason: 'timed out' };
    const result = await performMergeLiveAction(deps, makeRequest());
    expect(result).toEqual({ outcome: 'ambiguous', journalKey: KEY_MERGE_PR, reasonCode: 'forge-ambiguous' });
    expect(journal.entries[1]).toMatchObject({ outcome: 'ambiguous', reasonCode: 'forge-ambiguous' });
  });

  it('does not start a call with less than two seconds left in the budget', async () => {
    const { journal, forgeAction, deps } = build();
    const deadlineIso = new Date(Date.parse(NOW_ISO) + 1000).toISOString();
    const result = await performMergeLiveAction(deps, makeRequest({ deadlineIso }));
    expect(result).toEqual({ outcome: 'skipped', journalKey: KEY_MERGE_PR, reasonCode: 'budget-exhausted' });
    expect(journal.entries).toHaveLength(0);
    expect(forgeAction.requests).toHaveLength(0);
  });
});

describe('performMergeLiveAction never throws and never acts twice (DT9b fix round)', () => {
  it('journals an ambiguous result when the forge action port throws, and calls it once', async () => {
    const { journal, forgeAction, deps } = build();
    let calls = 0;
    forgeAction.performMergeForgeAction = async () => {
      calls += 1;
      throw new Error('socket hang up');
    };
    const result = await performMergeLiveAction(deps, makeRequest());
    expect(result).toEqual({ outcome: 'ambiguous', journalKey: KEY_MERGE_PR, reasonCode: 'forge-ambiguous' });
    expect(calls).toBe(1);
    expect(journal.entries.map((entry) => [entry.kind, entry.outcome])).toEqual([
      ['intent', null],
      ['result', 'ambiguous'],
    ]);
  });

  it('treats an off-contract forge answer as ambiguous, never as acted', async () => {
    const { journal, forgeAction, deps } = build();
    forgeAction.result = { outcome: 'executed', headSha: 'not-a-sha' };
    const result = await performMergeLiveAction(deps, makeRequest());
    expect(result).toEqual({ outcome: 'ambiguous', journalKey: KEY_MERGE_PR, reasonCode: 'forge-ambiguous' });
    expect(journal.entries[1]).toMatchObject({ outcome: 'ambiguous', reasonCode: 'forge-ambiguous' });
  });

  it('journals an unknown forge refusal kind as other instead of losing the result', async () => {
    const { journal, forgeAction, deps } = build();
    forgeAction.result = {
      outcome: 'refused',
      reason: 'teapot',
      refusalKind: 'Teapot' as unknown as 'other',
    };
    const result = await performMergeLiveAction(deps, makeRequest());
    expect(result).toEqual({ outcome: 'refused', journalKey: KEY_MERGE_PR, refusalKind: 'other', reasonCode: 'other' });
    expect(journal.entries[1]).toMatchObject({ outcome: 'refused', reasonCode: 'other', grantId: GRANT_ID });
  });

  it('keeps the key pending when the reconcile read throws', async () => {
    const { journal, forgeAction, forgeRead, deps } = build();
    seedIntent(journal, KEY_MERGE_PR);
    forgeRead.readForgeMerge = async () => {
      throw new Error('dns');
    };
    const result = await performMergeLiveAction(deps, makeRequest());
    expect(result).toEqual({ outcome: 'ambiguous', journalKey: KEY_MERGE_PR, reasonCode: 'reconcile-unknown' });
    expect(journal.entries[1]).toMatchObject({ outcome: 'ambiguous', reasonCode: 'reconcile-unknown' });
    expect(forgeAction.requests).toHaveLength(0);
  });

  it('reports the journal unavailable and never calls the forge when the key cannot be read', async () => {
    const { journal, forgeAction, forgeRead, deps } = build();
    journal.listForKey = async () => {
      throw new Error('EIO');
    };
    const result = await performMergeLiveAction(deps, makeRequest());
    expect(result).toEqual({ outcome: 'unavailable', journalKey: KEY_MERGE_PR, reasonCode: 'journal-unavailable' });
    expect(forgeAction.requests).toHaveLength(0);
    expect(forgeRead.calls).toBe(0);
  });

  it('reports the journal unavailable and never calls the forge when the intent append throws', async () => {
    const { journal, forgeAction, deps } = build();
    journal.append = async () => {
      throw new Error('ENOSPC');
    };
    const result = await performMergeLiveAction(deps, makeRequest());
    expect(result).toEqual({ outcome: 'unavailable', journalKey: KEY_MERGE_PR, reasonCode: 'journal-unavailable' });
    expect(forgeAction.requests).toHaveLength(0);
  });

  it('leaves the intent for reconcile when the result append throws after the action, and the next call does not act again', async () => {
    const { journal, forgeAction, forgeRead, deps } = build();
    const realAppend = journal.append.bind(journal);
    let appends = 0;
    journal.append = async (entry) => {
      appends += 1;
      if (appends === 2) {
        throw new Error('ENOSPC');
      }
      return realAppend(entry);
    };
    const first = await performMergeLiveAction(deps, makeRequest());
    expect(first).toEqual({ outcome: 'unavailable', journalKey: KEY_MERGE_PR, reasonCode: 'journal-unavailable' });
    expect(forgeAction.requests).toHaveLength(1);
    forgeRead.result = { outcome: 'ok', prState: 'merged', liveHeadSha: HEAD, mergeState: 'clean', contexts: [], unresolvedThreads: 0 };
    const second = await performMergeLiveAction(deps, makeRequest());
    expect(second).toEqual({ outcome: 'reconciled', journalKey: KEY_MERGE_PR, reconcile: 'merged' });
    expect(forgeAction.requests).toHaveLength(1);
    const third = await performMergeLiveAction(deps, makeRequest());
    expect(third).toEqual({ outcome: 'skipped', journalKey: KEY_MERGE_PR, reasonCode: 'already-settled' });
    expect(journal.entries.filter((entry) => entry.kind === 'result')).toHaveLength(1);
  });

  it('mints every id before the intent, so a failing minter never strands an action without its result', async () => {
    const { journal, forgeAction, deps } = build();
    const mint = makeUlidMinter();
    let mints = 0;
    const failingDeps: MergeLiveActionDependencies = {
      ...deps,
      mintId: () => {
        mints += 1;
        if (mints === 3) {
          throw new Error('entropy');
        }
        return mint();
      },
    };
    const result = await performMergeLiveAction(failingDeps, makeRequest());
    expect(result).toEqual({ outcome: 'unavailable', journalKey: KEY_MERGE_PR, reasonCode: 'id-unavailable' });
    expect(journal.entries).toHaveLength(0);
    expect(forgeAction.requests).toHaveLength(0);
  });

  it('refuses a null request and a hostile getter without throwing', async () => {
    const { journal, forgeAction, deps } = build();
    const nullResult = await performMergeLiveAction(deps, null as unknown as MergeLiveActionRequest);
    expect(nullResult).toEqual({ outcome: 'invalid-request', reasonCode: 'invalid-request' });
    const hostile = new Proxy(makeRequest(), {
      get(target, property, receiver) {
        if (property === 'grantId') {
          throw new Error('trap');
        }
        return Reflect.get(target, property, receiver) as unknown;
      },
    });
    const hostileResult = await performMergeLiveAction(deps, hostile);
    expect(hostileResult).toEqual({ outcome: 'invalid-request', reasonCode: 'invalid-request' });
    expect(journal.entries).toHaveLength(0);
    expect(forgeAction.requests).toHaveLength(0);
  });

  it('refuses a post-status whose description is not a string', async () => {
    const { journal, forgeAction, deps } = build();
    const status = { context: 'premerge', state: 'success', description: 42 } as unknown as MergeLiveActionRequest['status'];
    const result = await performMergeLiveAction(deps, makeRequest({ action: 'post-status', status }));
    expect(result).toEqual({ outcome: 'invalid-request', reasonCode: 'invalid-status' });
    expect(journal.entries).toHaveLength(0);
    expect(forgeAction.requests).toHaveLength(0);
  });

  it('refuses a malformed retry instead of acting on the base key', async () => {
    const { journal, forgeAction, deps } = build();
    for (const retry of [5, {}, { ordinal: null }]) {
      const result = await performMergeLiveAction(
        deps,
        makeRequest({ retry: retry as unknown as MergeLiveActionRequest['retry'] }),
      );
      expect(result).toEqual({ outcome: 'invalid-request', reasonCode: 'invalid-key' });
    }
    expect(journal.entries).toHaveLength(0);
    expect(forgeAction.requests).toHaveLength(0);
  });

  it('refuses an execution mode that is neither live nor shadow', async () => {
    const { journal, forgeAction, deps } = build();
    const result = await performMergeLiveAction(
      deps,
      makeRequest({ execution: 'dry' as unknown as 'live' }),
    );
    expect(result).toEqual({ outcome: 'invalid-request', reasonCode: 'invalid-execution' });
    expect(journal.entries).toHaveLength(0);
    expect(forgeAction.requests).toHaveLength(0);
  });

  it('refuses non-string times instead of parsing them', async () => {
    const { journal, forgeAction, deps } = build();
    const result = await performMergeLiveAction(
      deps,
      makeRequest({ nowIso: 2026 as unknown as string }),
    );
    expect(result).toEqual({ outcome: 'invalid-request', reasonCode: 'invalid-deadline' });
    expect(journal.entries).toHaveLength(0);
    expect(forgeAction.requests).toHaveLength(0);
  });
});
