// @generated adapter stub — refined for migration step 1 (no behaviour).
/**
 * AttemptRepositoryAdapter implements AttemptRepositoryPort
 * (local-transactional-store). Implementation lands in wave 2; every method
 * refuses until then.
 */

import type { AttemptRecord } from '../../domain/execution-records.js';
import type { AttemptRepositoryPort } from '../../application/ports/out/AttemptRepositoryPort.out-port.js';

export class AttemptRepositoryAdapter implements AttemptRepositoryPort {
  async saveAttempt(_record: AttemptRecord): Promise<void> {
    throw new Error('Not implemented: AttemptRepositoryAdapter.saveAttempt');
  }

  async findAttemptById(_attemptId: string): Promise<AttemptRecord | null> {
    throw new Error('Not implemented: AttemptRepositoryAdapter.findAttemptById');
  }

  async listAttemptsByWorkOrder(_workOrderId: string): Promise<readonly AttemptRecord[]> {
    throw new Error('Not implemented: AttemptRepositoryAdapter.listAttemptsByWorkOrder');
  }

  async listAllAttempts(): Promise<readonly AttemptRecord[]> {
    throw new Error('Not implemented: AttemptRepositoryAdapter.listAllAttempts');
  }
}
