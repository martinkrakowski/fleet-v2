/**
 * The pure isolation plan for a failing batch: how one gate outcome maps to
 * the train's next step, and how a multi-member failure splits into halves.
 * The second half is always validated against the base that results after
 * the first half is resolved — never against the original base, because
 * independent green results never prove their combination.
 */

import { accepted, refused, type ValidationResult } from './entities/validation.js';
import { validateBatchMemberRecord, type BatchMemberRecord } from './entities/BatchRecord.js';
import { classifyGateOutcome, type GateOutcomeInput } from './failure-classification.js';

/** 'current-base': the base as it stands when the run starts.
 * 'after-first-half': the base once the first half is resolved (landed or blocked). */
export type IsolationBase = 'current-base' | 'after-first-half';

/** One isolation run: an ordered member list and the base it is validated against. */
export interface IsolationRun {
  readonly members: readonly BatchMemberRecord[];
  readonly base: IsolationBase;
}

/** A split of one failing batch into two ordered halves. */
export interface IsolationSplit {
  readonly first: IsolationRun;
  readonly second: IsolationRun;
}

/**
 * Split an ordered member list into two halves that keep the original order.
 * The first half validates against the current base; the second half runs
 * only after the first is resolved, against that later base. Refuses fewer
 * than two members (a single member is already isolated), any malformed member
 * and any repeated pull request number. Never mutates the input.
 */
export function planIsolationSplit(members: readonly BatchMemberRecord[]): ValidationResult<IsolationSplit> {
  if (members.length < 2) {
    return refused('a batch of fewer than two members is already isolated and cannot be split');
  }
  const seenPrNumbers = new Set<number>();
  for (const member of members) {
    const validated = validateBatchMemberRecord(member);
    if (!validated.ok) {
      return validated;
    }
    if (seenPrNumbers.has(member.prNumber)) {
      return refused(`batch lists pull request ${member.prNumber} more than once and cannot be split`);
    }
    seenPrNumbers.add(member.prNumber);
  }
  const splitAt = Math.ceil(members.length / 2);
  return accepted({
    first: { members: members.slice(0, splitAt), base: 'current-base' },
    second: { members: members.slice(splitAt), base: 'after-first-half' },
  });
}

/** The train's next step after one gate outcome. */
export type IsolationDecision =
  | { readonly action: 'promote'; readonly members: readonly BatchMemberRecord[] }
  | { readonly action: 'retry'; readonly members: readonly BatchMemberRecord[] }
  | { readonly action: 'halt'; readonly reason: string }
  | { readonly action: 'block'; readonly prNumber: number; readonly headSha: string; readonly reason: string }
  | { readonly action: 'split'; readonly split: IsolationSplit };

/**
 * Decide the train's next step from one gate outcome. Infrastructure
 * failures retry the same candidate and halt once retries are exhausted —
 * they never split and never blame a PR. A single failed member is blocked
 * with its head sha; a multi-member failure splits. Refusals pass through.
 */
export function decideIsolationStep(input: GateOutcomeInput): ValidationResult<IsolationDecision> {
  const classification = classifyGateOutcome(input);
  if (!classification.ok) {
    return classification;
  }
  switch (classification.value.kind) {
    case 'passed':
      return accepted({ action: 'promote', members: [...input.members] });
    case 'infrastructure':
      if (classification.value.action === 'retry-same-candidate') {
        return accepted({ action: 'retry', members: [...input.members] });
      }
      return accepted({
        action: 'halt',
        reason:
          'infrastructure retries are exhausted; no pull request is blamed and the batch is never split on an infrastructure failure',
      });
    case 'member-failure': {
      const failedPrNumber = classification.value.prNumber;
      const failed = input.members.find((candidate) => candidate.prNumber === failedPrNumber);
      const headSha = failed === undefined ? '' : failed.headSha;
      return accepted({
        action: 'block',
        prNumber: failedPrNumber,
        headSha,
        reason: `pull request ${failedPrNumber} at head ${headSha} failed the gate; it stays available for remediation`,
      });
    }
    case 'batch-failure': {
      const split = planIsolationSplit(input.members);
      if (!split.ok) {
        return split;
      }
      return accepted({ action: 'split', split: split.value });
    }
  }
}
