import { createHash } from 'node:crypto';

import { CONDUCTOR_REAPER_REPAIR_KINDS } from './policy.js';
import type { ResolvedConductorPolicy } from './types.js';

/** Length of a conductor revision: the first 12 hex characters of sha256. */
export const CONDUCTOR_REVISION_LENGTH = 12;

/**
 * The canonical JSON the revision hashes: `enabled`, `stopGraceMinutes`, then `reaper` with
 * `enabled`, `intervalMinutes`, `graceMinutes`, `staleStopMinutes` and `repairs` (every kind, in
 * CONDUCTOR_REAPER_REPAIR_KINDS order), no whitespace. Pass a resolved policy
 * (`resolveConductorPolicy`) so an absent block hashes as the default.
 */
export function canonicalConductorJson(policy: ResolvedConductorPolicy): string {
  const repairs: Record<string, boolean> = {};
  for (const kind of CONDUCTOR_REAPER_REPAIR_KINDS) {
    repairs[kind] = policy.reaper.repairs[kind];
  }
  return JSON.stringify({
    enabled: policy.enabled,
    stopGraceMinutes: policy.stopGraceMinutes,
    reaper: {
      enabled: policy.reaper.enabled,
      intervalMinutes: policy.reaper.intervalMinutes,
      graceMinutes: policy.reaper.graceMinutes,
      staleStopMinutes: policy.reaper.staleStopMinutes,
      repairs,
    },
  });
}

/**
 * First 12 hex characters of sha256 over `canonicalConductorJson(policy)`.
 *
 * The revision names which conductor setting authorised a policy grant for `push-and-open-pr` or
 * `push-to-pr` (`decisionRevision: policy:conductor@<rev>`, AM3a), so a change of the setting can
 * cancel outstanding conductor grants (auto-merge plan A7 applied to the conductor); it is
 * unrelated to the work order's `policyRevision`.
 */
export function conductorRevision(policy: ResolvedConductorPolicy): string {
  return createHash('sha256')
    .update(canonicalConductorJson(policy))
    .digest('hex')
    .slice(0, CONDUCTOR_REVISION_LENGTH);
}
