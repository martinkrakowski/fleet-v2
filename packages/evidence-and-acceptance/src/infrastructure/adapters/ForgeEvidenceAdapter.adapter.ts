// @generated adapter stub — signature-matched for step 4 (no behaviour).
/**
 * ForgeEvidenceAdapter implements ForgeEvidencePort.
 * Behaviour lands with the station implementation; every method refuses.
 */

import type {
  ForgeCheckStatus,
  ForgeEvidencePort,
  ReadForgeCheckStatusRequest,
} from '../../application/ports/out/ForgeEvidencePort.out-port.js';

export class ForgeEvidenceAdapter implements ForgeEvidencePort {
  async readForgeCheckStatus(
    _request: ReadForgeCheckStatusRequest,
  ): Promise<ForgeCheckStatus> {
    throw new Error('Not implemented: ForgeEvidenceAdapter.readForgeCheckStatus');
  }
}
