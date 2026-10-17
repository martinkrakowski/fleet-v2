/**
 * The validation step of the shared onboarding engine (plan section 5):
 * apply a draft to a copy of the current installation and let the real
 * loader decide. `parseInstallation` is called, never a second copy of its
 * rules, and its errors are returned unchanged — so `hosts add`, `init` and
 * the Settings Hosts card all see the same refusal text the loader would
 * print on the file itself.
 *
 * The candidate is returned even when the loader refused it, because a caller
 * shows the diff of a draft that is not yet writable next to the errors.
 */

import { parseInstallation } from '@fleet/installation';
import type { FleetInstallation } from '@fleet/installation';

import {
  applyHostDraft,
  type ApplyHostDraftMode,
  type HostDraft,
  type HostDraftCandidate,
} from './draft.js';

/**
 * The outcome of validating a drafted host against the current installation:
 * the candidate file, and the loader's errors when it refused one.
 */
export type ValidateHostDraftResult =
  | {
      readonly ok: true;
      readonly candidate: HostDraftCandidate;
      readonly installation: FleetInstallation;
    }
  | {
      readonly ok: false;
      /** Absent only when the draft could not be applied to the current file at all. */
      readonly candidate?: HostDraftCandidate;
      readonly errors: readonly string[];
    };

/**
 * Apply the draft to a copy of the current installation value and run the
 * real `parseInstallation` on the candidate.
 *
 * Every error the caller sees is the loader's own text, in the loader's
 * order, with no value echoed: an unapplicable draft reports only that a
 * schema version 2 file is required, and an applicable one reports exactly
 * what `parseInstallation` rejects in the candidate (an unknown key, a
 * missing role, a colliding derived dial port, a stale agy acknowledgement).
 */
export function validateHostDraft(
  current: unknown,
  draft: HostDraft,
  mode: ApplyHostDraftMode,
): ValidateHostDraftResult {
  const applied = applyHostDraft(current, draft, mode);
  if (!applied.ok) {
    return { ok: false, errors: applied.errors };
  }
  const parsed = parseInstallation(applied.candidate);
  if (!parsed.ok) {
    return { ok: false, candidate: applied.candidate, errors: parsed.errors };
  }
  return {
    ok: true,
    candidate: applied.candidate,
    installation: parsed.installation,
  };
}
