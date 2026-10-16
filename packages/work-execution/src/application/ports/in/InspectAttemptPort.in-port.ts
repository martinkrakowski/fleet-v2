// @generated inbound contract scaffold — refined for migration step 1.
/**
 * InspectAttemptPort: safely inspect an attempt record without runner execution
 * or durable state mutations.
 */

import type { AttemptRecord } from '../../../domain/execution-records.js';

export interface InspectAttemptRequest {
  readonly attemptId: string;
}

export type InspectAttemptResult =
  | { readonly outcome: 'found'; readonly attempt: AttemptRecord }
  | { readonly outcome: 'not-found'; readonly attemptId: string };

export interface InspectAttemptPort {
  /** Inspect one attempt without modifying state or invoking runner. */
  inspectAttempt(request: InspectAttemptRequest): Promise<InspectAttemptResult>;
}
