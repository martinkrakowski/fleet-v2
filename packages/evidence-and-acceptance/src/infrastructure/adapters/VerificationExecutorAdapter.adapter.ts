// @generated adapter stub — signature-matched for step 4 (no behaviour).
/**
 * VerificationExecutorAdapter implements VerificationExecutorPort.
 * Behaviour lands with the station implementation; every method refuses.
 */

import type {
  ExecuteVerificationCheckRequest,
  ExecuteVerificationCheckResult,
  VerificationExecutorPort,
} from '../../application/ports/out/VerificationExecutorPort.out-port.js';

export class VerificationExecutorAdapter implements VerificationExecutorPort {
  async executeVerificationCheck(
    _request: ExecuteVerificationCheckRequest,
  ): Promise<ExecuteVerificationCheckResult> {
    throw new Error('Not implemented: VerificationExecutorAdapter.executeVerificationCheck');
  }
}
