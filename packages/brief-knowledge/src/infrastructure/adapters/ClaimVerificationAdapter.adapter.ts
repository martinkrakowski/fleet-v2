// @generated adapter stub — refined for migration step 5 (no behaviour).
/**
 * ClaimVerificationAdapter implements ClaimVerificationPort
 * (allow-listed-command-or-source-inspection). Implementation lands in a
 * later wave; the method refuses until then.
 */

import type { ClaimVerificationPort, VerifyClaimRequest, VerifyClaimResult } from '../../application/ports/out/ClaimVerificationPort.out-port.js';

export class ClaimVerificationAdapter implements ClaimVerificationPort {
  async verifyClaim(_request: VerifyClaimRequest): Promise<VerifyClaimResult> {
    throw new Error('Not implemented: ClaimVerificationAdapter.verifyClaim');
  }
}
