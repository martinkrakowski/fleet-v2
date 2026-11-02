/**
 * Batch formation: which queued pull requests form the next merge batch, or
 * whether the train should wait, hold, or find nothing to do.
 *
 * Everything here is pure: no I/O, no clock (time arrives as `nowMs`), no
 * randomness, nothing throws and no input is mutated. Re-exporting the
 * admission policy keeps `domain/index.ts` down to one added line.
 */

export * from './admission-policy.js';

import type { BatchMemberRecord, QueueEntryRecord } from './entities/index.js';
import {
  admissionClassCap,
  changesOverlap,
  classifyChange,
  type AdmissionClass,
  type BatchPolicy,
} from './admission-policy.js';

/** One queued pull request, with the paths its change touches. */
export interface AdmissionCandidate {
  readonly entry: QueueEntryRecord;
  readonly changedPaths: readonly string[];
  readonly enqueuedAtMs: number;
}

/** Everything the formation decision may look at. Never mutated. */
export interface BatchFormationInput {
  readonly candidates: readonly AdmissionCandidate[];
  readonly policy: BatchPolicy;
  readonly nowMs: number;
  /** Batches already validating or ready to promote. */
  readonly inFlightBatches: number;
}

/**
 * The formation decision. File compatibility inside a batch is a scheduling
 * heuristic, never proof; the validation gate still decides what lands.
 */
export type BatchFormationDecision =
  | { readonly kind: 'form'; readonly members: readonly BatchMemberRecord[]; readonly classes: readonly AdmissionClass[]; readonly reason: string }
  | { readonly kind: 'wait'; readonly reason: string; readonly retryAfterMs: number }
  | { readonly kind: 'hold'; readonly reason: string }
  | { readonly kind: 'none'; readonly reason: string };

/** Dedupe by prNumber (earlier enqueue wins, then input order) and sort FIFO. */
function buildPool(candidates: readonly AdmissionCandidate[]): readonly AdmissionCandidate[] {
  const byPr = new Map<number, AdmissionCandidate>();
  for (const candidate of candidates) {
    if (candidate.entry.eligibility.kind === 'blocked') {
      continue;
    }
    const existing = byPr.get(candidate.entry.prNumber);
    if (existing === undefined || candidate.enqueuedAtMs < existing.enqueuedAtMs) {
      byPr.set(candidate.entry.prNumber, candidate);
    }
  }
  return [...byPr.values()].sort((a, b) => {
    if (a.enqueuedAtMs !== b.enqueuedAtMs) {
      return a.enqueuedAtMs - b.enqueuedAtMs;
    }
    return a.entry.prNumber - b.entry.prNumber;
  });
}

function batchCap(policy: BatchPolicy, classes: readonly AdmissionClass[]): number {
  return Math.min(policy.maxBatchSize, ...classes.map((cls) => admissionClassCap(cls, policy.maxBatchSize)));
}

/**
 * Decide the next batch. The walk is strict first-in first-out: the first
 * entry that cannot join stops it, and no later entry may skip past it.
 */
export function formBatch(input: BatchFormationInput): BatchFormationDecision {
  const { candidates, policy, nowMs, inFlightBatches } = input;
  if (inFlightBatches >= policy.speculativeDepth) {
    return {
      kind: 'hold',
      reason: `speculative depth of ${policy.speculativeDepth} is reached with ${inFlightBatches} batches in flight`,
    };
  }
  const pool = buildPool(candidates);
  if (pool.length === 0) {
    return { kind: 'none', reason: 'no eligible entries' };
  }

  const head = pool[0];
  const classes: AdmissionClass[] = pool.map((candidate) => classifyChange(candidate.changedPaths));

  if (classes[0] === 'alone') {
    return {
      kind: 'form',
      members: [{ prNumber: head.entry.prNumber, headSha: head.entry.headSha }],
      classes: [classes[0]],
      reason: 'head is admitted alone and never shares a batch',
    };
  }

  const members: AdmissionCandidate[] = [head];
  const memberClasses: AdmissionClass[] = [classes[0]];
  let stoppedAtBlocker = false;
  for (let index = 1; index < pool.length; index += 1) {
    const candidate = pool[index];
    const cls = classes[index];
    const cannotJoin =
      cls === 'alone' ||
      members.some((member) => changesOverlap(member.changedPaths, candidate.changedPaths)) ||
      members.length + 1 > batchCap(policy, [...memberClasses, cls]);
    if (cannotJoin) {
      stoppedAtBlocker = true;
      break;
    }
    members.push(candidate);
    memberClasses.push(cls);
  }

  const cap = batchCap(policy, memberClasses);
  const headAge = nowMs - head.enqueuedAtMs;
  const form =
    members.length >= cap ||
    members.length >= policy.minBatchSize ||
    stoppedAtBlocker ||
    inFlightBatches === 0 ||
    headAge >= policy.collectionWaitMs;
  if (!form) {
    return {
      kind: 'wait',
      reason: `batch is under the minimum of ${policy.minBatchSize} and still collecting`,
      retryAfterMs: Math.max(1, policy.collectionWaitMs - headAge),
    };
  }

  return {
    kind: 'form',
    members: members.map((member) => ({ prNumber: member.entry.prNumber, headSha: member.entry.headSha })),
    classes: [...memberClasses],
    reason: stoppedAtBlocker
      ? `formed ${members.length} entr${members.length === 1 ? 'y' : 'ies'} before the first entry that cannot join`
      : `formed ${members.length} entr${members.length === 1 ? 'y' : 'ies'} within the batch cap of ${cap}`,
  };
}
