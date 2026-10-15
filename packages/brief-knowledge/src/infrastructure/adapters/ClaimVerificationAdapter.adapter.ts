// Implemented for lane bk-usecases-adapters (migration step 6).
/**
 * ClaimVerificationAdapter implements ClaimVerificationPort with a bounded,
 * allow-listed source/path inspection or an injected `verify` callback. The
 * claim text is treated strictly as data — instructions inside a note are
 * never executed; only the allow-listed procedure may run, and it only
 * inspects the declared target path.
 */

import { stat } from 'node:fs/promises';
import type {
  ClaimVerificationPort,
  VerifyClaimRequest,
  VerifyClaimResult,
} from '../../application/ports/out/ClaimVerificationPort.out-port.js';

/** Procedures this adapter may perform without an injected callback. */
export const DEFAULT_CLAIM_VERIFICATION_PROCEDURES: readonly string[] = [
  'inspect-source-path',
  'confirm-path-exists',
];

export type ClaimVerificationCallback = (
  request: VerifyClaimRequest,
) => Promise<VerifyClaimResult> | VerifyClaimResult;

export interface ClaimVerificationAdapterDependencies {
  /** Injected verification procedure; when present it fully owns the check. */
  readonly verify?: ClaimVerificationCallback;
  /** Restrict the procedures accepted without an injected callback. */
  readonly allowedProcedures?: readonly string[];
}

export class ClaimVerificationAdapter implements ClaimVerificationPort {
  constructor(private readonly deps?: ClaimVerificationAdapterDependencies) {}

  async verifyClaim(request: VerifyClaimRequest): Promise<VerifyClaimResult> {
    if (!request || typeof request !== 'object') {
      throw new Error('ClaimVerificationAdapter requires a VerifyClaimRequest');
    }
    if (typeof request.entryId !== 'string' || request.entryId.trim().length === 0) {
      throw new Error('ClaimVerificationAdapter requires a non-empty entryId');
    }
    if (typeof request.claimText !== 'string') {
      throw new Error('ClaimVerificationAdapter requires claimText as data (a string)');
    }
    if (typeof request.procedureName !== 'string' || request.procedureName.trim().length === 0) {
      throw new Error('ClaimVerificationAdapter requires a non-empty procedureName');
    }

    if (this.deps?.verify) {
      return await this.deps.verify(request);
    }

    const allowedProcedures = this.deps?.allowedProcedures ?? DEFAULT_CLAIM_VERIFICATION_PROCEDURES;
    if (!allowedProcedures.includes(request.procedureName)) {
      throw new Error(`Claim verification procedure is not allow-listed: ${request.procedureName}`);
    }

    // Bounded source/path inspection: the only evidence gathered is whether
    // the declared target path exists. The claim text is never interpreted.
    const evidenceRef = `claim-check:${request.entryId}:${request.procedureName}`;
    if (typeof request.targetPath === 'string' && request.targetPath.trim().length > 0) {
      const targetExists = await pathIsAccessible(request.targetPath);
      return targetExists
        ? { verification: 'supported', evidenceRef: `${evidenceRef}:${request.targetPath}` }
        : { verification: 'contradicted', evidenceRef: `${evidenceRef}:${request.targetPath}:missing` };
    }
    return { verification: 'unverified', evidenceRef: `${evidenceRef}:no-target` };
  }
}

async function pathIsAccessible(targetPath: string): Promise<boolean> {
  try {
    await stat(targetPath);
    return true;
  } catch {
    return false;
  }
}
