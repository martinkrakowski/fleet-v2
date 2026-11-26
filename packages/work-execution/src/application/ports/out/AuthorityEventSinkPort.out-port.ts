// @generated outbound contract scaffold — refined for FC12B.
/**
 * AuthorityEventSinkPort: the consumer-side, stop-only audit sink of the
 * authority trail (FC12B). The adapter delegates to the supplier context's
 * storage; this contract is local to `work-execution` and never imports
 * `@fleet/operator-coordination` (docs/architecture.md "Dependency direction").
 * Grant, dispatch and merge emission do not cross this port.
 */

import type { StopAuthorityEvent } from '../../../domain/authority-event-mapping.js';

/** The local consumer-side stop event; field names mirror FC12A's `AuthorityEvent`. */
export type { StopAuthorityEvent };

/** The outcome of one sink write: recorded, or a typed refusal, never a throw. */
export type AuthorityEventSinkResult =
  | { readonly outcome: 'recorded' }
  | { readonly outcome: 'refused'; readonly reason: 'unavailable' | 'invalid-event' };

export interface AuthorityEventSinkPort {
  /**
   * Record one stop authority event. Idempotent on `eventId`: a repeat of a
   * recorded event writes nothing and answers `'recorded'` again. A failed,
   * empty or refused transport answers `'refused'` with `'unavailable'`; an
   * event the supplier's own validation rejects answers `'refused'` with
   * `'invalid-event'`. Never throws and never echoes the event back.
   */
  record(event: StopAuthorityEvent): Promise<AuthorityEventSinkResult>;
}
