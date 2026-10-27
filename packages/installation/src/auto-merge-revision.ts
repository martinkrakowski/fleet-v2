import { createHash } from 'node:crypto';

import type { AutoMergePolicy } from './types.js';

/** Length of an auto-merge revision: the first 12 hex characters of sha256 (plan A2). */
export const AUTO_MERGE_REVISION_LENGTH = 12;

/**
 * The canonical JSON the revision hashes: exactly `enabled`, `allowHighRisk`,
 * `onBlocked`, in that order, no whitespace. Pass a resolved policy
 * (`resolveAutoMergePolicy`) so an absent block hashes as the default.
 */
export function canonicalAutoMergeJson(policy: AutoMergePolicy): string {
  return JSON.stringify({
    enabled: policy.enabled,
    allowHighRisk: policy.allowHighRisk,
    onBlocked: policy.onBlocked,
  });
}

/**
 * First 12 hex characters of sha256 over `canonicalAutoMergeJson(policy)` (plan A2).
 *
 * The revision names which setting authorised a policy grant
 * (`decisionRevision: policy:autoMerge@<rev>`, A3/A8); it is unrelated to the work
 * order's `policyRevision`, so toggling the setting never makes an acceptance stale (A2).
 */
export function autoMergeRevision(policy: AutoMergePolicy): string {
  return createHash('sha256')
    .update(canonicalAutoMergeJson(policy))
    .digest('hex')
    .slice(0, AUTO_MERGE_REVISION_LENGTH);
}
