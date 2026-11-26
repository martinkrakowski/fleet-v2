/**
 * Shared shadow-skip filtering: the journaled `would-already-merged` /
 * `would-supersede` dry-runs that settle a queued entry, used by the merge pass
 * and by the single-pair shadow decision so both see the same live queue head.
 * No I/O beyond the journal port passed by the caller.
 */

import type { LaneRunJournalPort } from '../ports/out/LaneRunJournalPort.out-port.js';
import { computeCallBudget } from '../../domain/daemon-tick.js';
import type { MergeQueueEntryRecord } from '../../domain/merge-queue-records.js';
import { buildMergeKey, head12Of, parseLaneRunKey } from '../../domain/lane-run-keys.js';

export type ShadowSkipAction = 'would-already-merged' | 'would-supersede';

export interface ShadowSkipIndex {
  /** Every `would-already-merged` dry-run key for this repository, any head. */
  readonly alreadyMergedKeys: ReadonlySet<string>;
  /** Pull requests that have a `would-already-merged` dry-run under any head. */
  readonly alreadyMergedPullRequests: ReadonlySet<number>;
  /** Every `would-supersede` dry-run key for this repository. */
  readonly supersededKeys: ReadonlySet<string>;
}

export type AlreadyMergedIndex =
  | ({ readonly outcome: 'indexed' } & ShadowSkipIndex)
  | { readonly outcome: 'budget-exhausted' };

export function openShadowSkipIndex(): Extract<AlreadyMergedIndex, { outcome: 'indexed' }> {
  return {
    outcome: 'indexed',
    alreadyMergedKeys: new Set<string>(),
    alreadyMergedPullRequests: new Set<number>(),
    supersededKeys: new Set<string>(),
  };
}

/**
 * One dry-run result that can exclude a shadow entry. It counts only when
 * `kind === 'result'`, `outcome === 'dry-run'` and `reasonCode` is the parsed
 * merge action (`would-already-merged` or `would-supersede`). A closed intent
 * (`shadow-intent-closed`), an open intent, a non-merge key, another
 * repository, a non-integer pull request, or a throwing getter is not a hit.
 */
export function shadowSkipHit(
  record: unknown,
  repoDigest: string,
): { readonly key: string; readonly action: ShadowSkipAction; readonly pullRequest: number } | null {
  try {
    const view = record as {
      kind: unknown;
      outcome: unknown;
      reasonCode: unknown;
      key: unknown;
    };
    const kind = view.kind;
    const outcome = view.outcome;
    const reasonCode = view.reasonCode;
    const key = view.key;
    if (kind !== 'result' || outcome !== 'dry-run' || typeof key !== 'string' || typeof reasonCode !== 'string') {
      return null;
    }
    const parsed = parseLaneRunKey(key);
    if (
      parsed === null ||
      parsed.kind !== 'merge' ||
      parsed.repoDigest !== repoDigest ||
      !Number.isSafeInteger(parsed.pullRequest) ||
      parsed.pullRequest < 1 ||
      reasonCode !== parsed.action
    ) {
      return null;
    }
    if (parsed.action !== 'would-already-merged' && parsed.action !== 'would-supersede') {
      return null;
    }
    return { key, action: parsed.action, pullRequest: parsed.pullRequest };
  } catch {
    return null;
  }
}

/** One pass over the prefix listing. A record that cannot be read is ignored. */
export function shadowSkipIndexFromRecords(records: readonly unknown[], repoDigest: string): ShadowSkipIndex {
  const alreadyMergedKeys = new Set<string>();
  const alreadyMergedPullRequests = new Set<number>();
  const supersededKeys = new Set<string>();
  for (const record of records) {
    const hit = shadowSkipHit(record, repoDigest);
    if (hit === null) {
      continue;
    }
    if (hit.action === 'would-already-merged') {
      alreadyMergedKeys.add(hit.key);
      alreadyMergedPullRequests.add(hit.pullRequest);
      continue;
    }
    supersededKeys.add(hit.key);
  }
  return { alreadyMergedKeys, alreadyMergedPullRequests, supersededKeys };
}

/**
 * True when this shadow entry is already settled in the journal: its current
 * head has a `would-already-merged` dry-run, or that pull request has a
 * `would-already-merged` dry-run under any head and this head already has a
 * `would-supersede` dry-run. An unreadable head or a refused key is not a
 * match, so the entry stays live and its supersede can still be journaled once.
 */
export function matchesJournaledAlreadyMerged(
  repoDigest: string,
  entry: MergeQueueEntryRecord,
  index: ShadowSkipIndex,
): boolean {
  const head12 = head12Of(entry.headOid);
  if (head12 === null) {
    return false;
  }
  const alreadyMerged = buildMergeKey({
    repoDigest,
    pullRequest: entry.pullRequest,
    head12,
    action: 'would-already-merged',
    attemptOrdinal: null,
    retry: null,
  });
  if (alreadyMerged.ok && index.alreadyMergedKeys.has(alreadyMerged.key)) {
    return true;
  }
  // Without the supersede on this head the entry stays live: the next pass
  // still has to journal `would-supersede` once.
  if (!index.alreadyMergedPullRequests.has(entry.pullRequest)) {
    return false;
  }
  const superseded = buildMergeKey({
    repoDigest,
    pullRequest: entry.pullRequest,
    head12,
    action: 'would-supersede',
    attemptOrdinal: null,
    retry: null,
  });
  return superseded.ok && index.supersededKeys.has(superseded.key);
}

export function withoutJournaledAlreadyMerged(
  repoDigest: string,
  ordered: readonly MergeQueueEntryRecord[],
  index: ShadowSkipIndex,
): readonly MergeQueueEntryRecord[] {
  if (!Array.isArray(ordered)) {
    return [];
  }
  if (index.alreadyMergedKeys.size === 0) {
    return ordered;
  }
  return ordered.filter((entry) => !matchesJournaledAlreadyMerged(repoDigest, entry, index));
}

export interface ReadJournaledWouldAlreadyMergedInput {
  readonly journal: Pick<LaneRunJournalPort, 'listForKeyPrefix'> | null | undefined;
  readonly repoDigest: string;
  readonly shadow: boolean;
  readonly nowIso: string;
  readonly deadlineIso: string;
}

/**
 * Journaled shadow dry-runs for this repository, from one `listForKeyPrefix`
 * of `merge/<repoDigest>/`. Live passes do not read. A missing method, a
 * throw, or a non-array answer fails open to empty sets. A spent budget
 * does not call the port. A record counts only when it is a `dry-run`
 * result whose reasonCode is the parsed merge action.
 */
export async function readJournaledWouldAlreadyMerged(
  input: ReadJournaledWouldAlreadyMergedInput,
): Promise<AlreadyMergedIndex> {
  if (input.shadow !== true) {
    return openShadowSkipIndex();
  }
  if (!computeCallBudget({ nowIso: input.nowIso, deadlineIso: input.deadlineIso, normalTimeoutMs: 30_000 }).allowed) {
    return { outcome: 'budget-exhausted' };
  }
  const journal = input.journal;
  const listForKeyPrefix = journal?.listForKeyPrefix;
  if (journal === null || journal === undefined || typeof listForKeyPrefix !== 'function') {
    return openShadowSkipIndex();
  }
  let records: unknown;
  try {
    records = await listForKeyPrefix.call(journal, `merge/${input.repoDigest}/`);
  } catch {
    return openShadowSkipIndex();
  }
  if (!Array.isArray(records)) {
    return openShadowSkipIndex();
  }
  const index = shadowSkipIndexFromRecords(records, input.repoDigest);
  return {
    outcome: 'indexed',
    alreadyMergedKeys: index.alreadyMergedKeys,
    alreadyMergedPullRequests: index.alreadyMergedPullRequests,
    supersededKeys: index.supersededKeys,
  };
}
