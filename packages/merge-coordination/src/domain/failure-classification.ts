/**
 * Pure failure classification for one gate result. It is total: every input
 * answers, no input throws, and anything outside the known shapes is refused
 * with a reason. Infrastructure failures say nothing about any pull request;
 * they never split a batch and never blame a PR.
 */

import { accepted, refused, type ValidationResult } from './entities/validation.js';
import { validateBatchMemberRecord, type BatchMemberRecord } from './entities/BatchRecord.js';
import type { GateReceiptResult } from './entities/GateReceiptRecord.js';

/** What kind of failure one gate result was, and what that implies. */
export type FailureClassification =
  | { readonly kind: 'passed' }
  | { readonly kind: 'infrastructure'; readonly action: 'retry-same-candidate' | 'retries-exhausted' }
  | { readonly kind: 'member-failure'; readonly prNumber: number }
  | { readonly kind: 'batch-failure' };

/** One gate result plus the members it ran against and the retry budget. */
export interface GateOutcomeInput {
  readonly result: GateReceiptResult;
  readonly members: readonly BatchMemberRecord[];
  readonly infrastructureRetriesUsed: number;
  readonly maxInfrastructureRetries: number;
}

const KNOWN_RESULTS: readonly string[] = ['passed', 'failed', 'infrastructure-failure'];

/** Whether a retry count is a non-negative integer. */
function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/**
 * Classify one gate result. Refuses empty member lists, malformed members,
 * unknown results and bad retry numbers; otherwise answers with the failure
 * kind. The retry budget is a required input — no default is invented.
 */
export function classifyGateOutcome(input: GateOutcomeInput): ValidationResult<FailureClassification> {
  if (input.members.length < 1) {
    return refused('gate outcome needs at least one batch member');
  }
  for (const member of input.members) {
    const validated = validateBatchMemberRecord(member);
    if (!validated.ok) {
      return validated;
    }
  }
  if (typeof input.result !== 'string' || !KNOWN_RESULTS.includes(input.result)) {
    return refused('gate outcome result must be "passed", "failed" or "infrastructure-failure"');
  }
  if (!isNonNegativeInteger(input.infrastructureRetriesUsed) || !isNonNegativeInteger(input.maxInfrastructureRetries)) {
    return refused('infrastructure retry counts must be non-negative integers');
  }
  if (input.result === 'passed') {
    return accepted({ kind: 'passed' });
  }
  if (input.result === 'infrastructure-failure') {
    const action =
      input.infrastructureRetriesUsed < input.maxInfrastructureRetries ? 'retry-same-candidate' : 'retries-exhausted';
    return accepted({ kind: 'infrastructure', action });
  }
  if (input.members.length === 1) {
    const only = input.members[0];
    return accepted({ kind: 'member-failure', prNumber: only.prNumber });
  }
  return accepted({ kind: 'batch-failure' });
}
