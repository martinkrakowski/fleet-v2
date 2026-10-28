/**
 * The pure mapping from a `LoadResult` to AM4a's `AutoMergeSettingsAnswer`
 * (auto-merge plan A2). It does no I/O: the composition root (AM5-3) calls it
 * with a fresh `loadInstallation()` on every settings read, which is what
 * A7's re-read needs. The loader's error text never reaches an answer: an
 * invalid installation is reported as `unreadable` with a fixed reason.
 */

import {
  DEFAULT_AUTO_MERGE_POLICY,
  autoMergeRevision,
  isFleetInstallationV2,
  resolveAutoMergePolicy,
} from '@fleet/installation';
import type { LoadResult } from '@fleet/installation';
import { resolveInstallationForgeMode } from '@fleet/work-execution';
import type { AutoMergeSettingsAnswer } from '@fleet/work-execution';

/** The defaults an absent block, an absent installation or a v1 file maps to. */
function defaultAnswer(): AutoMergeSettingsAnswer {
  return {
    outcome: 'read',
    enabled: DEFAULT_AUTO_MERGE_POLICY.enabled,
    allowHighRisk: DEFAULT_AUTO_MERGE_POLICY.allowHighRisk,
    onBlocked: DEFAULT_AUTO_MERGE_POLICY.onBlocked,
    revision: autoMergeRevision(DEFAULT_AUTO_MERGE_POLICY),
    forgeMode: 'unknown',
  };
}

export function autoMergeSettingsFromLoad(
  load: LoadResult,
): AutoMergeSettingsAnswer {
  if (load.status === 'invalid') {
    return { outcome: 'unreadable', reason: 'installation invalid' };
  }
  if (load.status === 'absent' || !isFleetInstallationV2(load.installation)) {
    return defaultAnswer();
  }
  const policy = resolveAutoMergePolicy(load.installation.policy);
  const forgeMode = resolveInstallationForgeMode(load.installation);
  return {
    outcome: 'read',
    enabled: policy.enabled,
    allowHighRisk: policy.allowHighRisk,
    onBlocked: policy.onBlocked,
    revision: autoMergeRevision(policy),
    forgeMode: forgeMode ?? 'unknown',
  };
}
