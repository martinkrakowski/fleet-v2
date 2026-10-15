// @generated outbound contract scaffold — refined for migration step 1.
/**
 * ExecutionObservationPort: publish recorded lifecycle observations through
 * coordination. A delivery gap is preserved and visible; it never fails the
 * lane and never mutates the attempt.
 */

import type { ActionJournalEntryRecord } from '../../../domain/execution-records.js';

export interface PublishExecutionObservationRequest {
  readonly entry: ActionJournalEntryRecord;
  readonly projectId: string;
}

export type PublishExecutionObservationResult =
  | { readonly outcome: 'published' }
  | { readonly outcome: 'delivery-gap'; readonly reason: string };

export interface ExecutionObservationPort {
  /** Publish one recorded observation; a delivery gap does not fail the lane. */
  publishExecutionObservation(
    request: PublishExecutionObservationRequest,
  ): Promise<PublishExecutionObservationResult>;
}
