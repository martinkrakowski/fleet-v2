// Extracted refusal classifier shared by the attempt-bound ForgeActionAdapter
// and the repo-scoped merge path (DT6a). Permission wins over protection,
// protection over conflict; anything unrecognised is `other`.

import type { ForgeRefusalKind } from '../../domain/coordination-keys.js';

/** Lower-case needles checked in this order: permission, then protection, then conflict. */
export const PERMISSION_NEEDLES: readonly string[] = [
  'resource not accessible by integration',
  'does not have the correct permissions',
  'must have admin rights',
  'must have write access',
  'permission denied',
  'bad credentials',
  'http 401',
  'http 403',
  'gh auth login',
];
export const PROTECTION_NEEDLES: readonly string[] = [
  'base branch policy prohibits the merge',
  'required status check',
  'approving review',
  'review is required',
  'repository rule violation',
  'protected branch',
  'branch protection',
];
export const CONFLICT_NEEDLES: readonly string[] = [
  'merge commit cannot be cleanly created',
  'merge conflict',
  'has conflicts',
];

/**
 * Classify a failed `gh` run by its whole output (plan AM4b). Permission wins
 * over protection, protection over conflict; anything unrecognised is `other`.
 */
export function classifyGhRefusal(stderr: string, stdout: string): ForgeRefusalKind {
  const text = (stderr + '\n' + stdout).toLowerCase();
  if (PERMISSION_NEEDLES.some((needle) => text.includes(needle))) {
    return 'permission';
  }
  if (PROTECTION_NEEDLES.some((needle) => text.includes(needle))) {
    return 'protection';
  }
  if (CONFLICT_NEEDLES.some((needle) => text.includes(needle))) {
    return 'conflict';
  }
  return 'other';
}
