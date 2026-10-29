/**
 * The `policy.autoMerge` engine of the shared onboarding flow (auto-merge
 * plan A2/A6), pure half: summarise the resolved policy of a parsed
 * installation, draft the candidate `policy` change for a settings change,
 * and render the status and impact lines the CLI shows. Nothing here touches
 * a filesystem, a subprocess, the network or the clock; the compare-and-swap
 * write is shared with the free-tier draft and lives in `hosts/write-node.ts`.
 */

import {
  autoMergeRevision,
  isFleetInstallationV2,
  parseInstallation,
  resolveAutoMergePolicy,
} from '@fleet/installation';

import type {
  AutoMergePolicy,
  FleetInstallation,
  HostSection,
} from '@fleet/installation';

import type { HostDraftCandidate } from '../hosts/draft.js';

import { validateV2InstallationValue } from '../seats/free-tier.js';

/** One settings change: the fields that are omitted keep their current value. */
export interface AutoMergeChange {
  readonly enabled: boolean;
  /** Omitted: keep the current value (the default is `false`). */
  readonly allowHighRisk?: boolean;
  /** Omitted: keep the current value (the default is `'ask-owner'`). */
  readonly onBlocked?: 'ask-owner' | 'hold';
}

/** The auto-merge view of an installation: resolved policy, revision, explicitness. */
export interface AutoMergeSummary {
  readonly policy: AutoMergePolicy;
  readonly revision: string;
  /** True when the file writes `policy.autoMerge`; absent means off. */
  readonly explicit: boolean;
}

/** The outcome of drafting an auto-merge settings change. */
export type AutoMergeDraft =
  | { readonly status: 'invalid'; readonly errors: readonly string[] }
  | { readonly status: 'unchanged'; readonly summary: AutoMergeSummary }
  | {
      readonly status: 'draft';
      readonly candidate: HostDraftCandidate;
      readonly before: AutoMergeSummary;
      readonly after?: AutoMergeSummary;
      readonly errors: readonly string[];
    };

/** Summarise the auto-merge view of a parsed installation. */
export function summariseAutoMerge(
  installation: FleetInstallation,
): AutoMergeSummary {
  const explicit = installation.policy?.autoMerge !== undefined;
  const policy = resolveAutoMergePolicy(installation.policy);
  return { policy, revision: autoMergeRevision(policy), explicit };
}

/** The same three keys, with the change applied over the current values. */
function targetPolicy(current: AutoMergePolicy, change: AutoMergeChange): AutoMergePolicy {
  return {
    enabled: change.enabled,
    allowHighRisk: change.allowHighRisk ?? current.allowHighRisk,
    onBlocked: change.onBlocked ?? current.onBlocked,
  };
}

function samePolicy(a: AutoMergePolicy, b: AutoMergePolicy): boolean {
  return (
    a.enabled === b.enabled &&
    a.allowHighRisk === b.allowHighRisk &&
    a.onBlocked === b.onBlocked
  );
}

/**
 * Draft the candidate file value for a settings change, from the raw value
 * (never from the parsed one). The complete three-key block is always
 * written, other `policy` keys are never removed, and the candidate is judged
 * exactly as the loader would judge it.
 */
export function draftAutoMerge(
  current: unknown,
  change: AutoMergeChange,
): AutoMergeDraft {
  const parsed = parseInstallation(current);
  if (!parsed.ok) {
    return { status: 'invalid', errors: parsed.errors };
  }
  if (!isFleetInstallationV2(parsed.installation)) {
    return {
      status: 'invalid',
      errors: ['installation: the candidate is not a schema version 2 file'],
    };
  }

  const before = summariseAutoMerge(parsed.installation);
  const target = targetPolicy(before.policy, change);
  if (samePolicy(before.policy, target)) {
    return { status: 'unchanged', summary: before };
  }

  const next: Record<string, unknown> = {
    ...(current as Record<string, unknown>),
  };
  const rawPolicy = next.policy;
  const policyCopy: Record<string, unknown> =
    typeof rawPolicy === 'object' &&
    rawPolicy !== null &&
    !Array.isArray(rawPolicy)
      ? { ...(rawPolicy as Record<string, unknown>) }
      : {};
  policyCopy.autoMerge = {
    enabled: target.enabled,
    allowHighRisk: target.allowHighRisk,
    onBlocked: target.onBlocked,
  };
  next.policy = policyCopy;

  const candidate: HostDraftCandidate = {
    ...next,
    schemaVersion: 2,
    hosts: (next.hosts ?? {}) as Readonly<Record<string, HostSection>>,
  };

  const checked = validateV2InstallationValue(candidate);
  const after =
    checked.installation !== undefined
      ? summariseAutoMerge(checked.installation)
      : undefined;
  return {
    status: 'draft',
    candidate,
    before,
    after,
    errors: checked.ok ? [] : checked.errors,
  };
}

/** Render the auto-merge status line for a summary. */
export function renderAutoMergeStatus(summary: AutoMergeSummary): string[] {
  const line =
    'auto-merge: ' +
    (summary.policy.enabled ? 'on' : 'off') +
    ', allowHighRisk ' +
    summary.policy.allowHighRisk +
    ', onBlocked ' +
    summary.policy.onBlocked +
    ', revision ' +
    summary.revision +
    (summary.explicit ? '' : ' (absent; absent means off)');
  return [line];
}

/** Render the impact lines of a settings change: before -> after. */
export function renderAutoMergeImpact(
  before: AutoMergeSummary,
  after: AutoMergeSummary,
): string[] {
  const lines: string[] = [];
  if (after.policy.enabled) {
    lines.push(
      'auto-merge on: accepted low- and standard-risk lanes with no named door merge without a further owner step',
    );
    if (after.policy.allowHighRisk) {
      lines.push('allowHighRisk true: high-risk lanes merge under the same policy');
    }
  } else {
    lines.push(
      'auto-merge off: nothing merges by policy; outstanding policy grants are cancelled on the next attempt (A7)',
    );
  }
  lines.push(
    'auto-merge: ' +
      (before.policy.enabled ? 'on' : 'off') +
      ' -> ' +
      (after.policy.enabled ? 'on' : 'off'),
  );
  return lines;
}
