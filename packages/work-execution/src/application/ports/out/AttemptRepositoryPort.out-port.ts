// @generated outbound contract scaffold — refined for migration step 1.
/**
 * AttemptRepositoryPort: persist immutable dispatch identity and guarded
 * lifecycle updates. A fresh attempt identity is created per dispatch and
 * per fix round; identities are never reused or resumed.
 */

import type { AttemptRecord } from '../../../domain/execution-records.js';

export interface AttemptRepositoryPort {
  /** Persist one attempt record; lifecycle updates stay guarded by the use case. */
  saveAttempt(record: AttemptRecord): Promise<void>;

  /** Known absence is null; unreadable state is an error. */
  findAttemptById(attemptId: string): Promise<AttemptRecord | null>;

  /** List attempts in creation order for one work order. */
  listAttemptsByWorkOrder(workOrderId: string): Promise<readonly AttemptRecord[]>;

  /** List every attempt, newest state first, for recovery and inspection. */
  listAllAttempts(): Promise<readonly AttemptRecord[]>;
}
