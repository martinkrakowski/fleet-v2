// @generated adapter stub — refined for step 5 (no behaviour).
/**
 * CoordinationRequestRepositoryAdapter implements CoordinationRequestRepositoryPort
 * (local-transactional-store). Implementation lands in a later step; every
 * method refuses until then rather than inventing an unrecorded request.
 */

import type { CoordinationRequestRecord } from '../../domain/coordination-records.js';
import type { CoordinationRequestRepositoryPort } from '../../application/ports/out/CoordinationRequestRepositoryPort.out-port.js';

export class CoordinationRequestRepositoryAdapter implements CoordinationRequestRepositoryPort {
  async saveRequest(_record: CoordinationRequestRecord): Promise<void> {
    throw new Error('Not implemented: CoordinationRequestRepositoryAdapter.saveRequest');
  }

  async findRequestById(_requestId: string): Promise<CoordinationRequestRecord | null> {
    throw new Error('Not implemented: CoordinationRequestRepositoryAdapter.findRequestById');
  }

  async findRequestByGrantId(_grantId: string): Promise<CoordinationRequestRecord | null> {
    throw new Error('Not implemented: CoordinationRequestRepositoryAdapter.findRequestByGrantId');
  }

  async listRequests(_projectId?: string): Promise<readonly CoordinationRequestRecord[]> {
    throw new Error('Not implemented: CoordinationRequestRepositoryAdapter.listRequests');
  }
}
