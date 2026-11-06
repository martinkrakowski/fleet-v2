// @generated outbound contract scaffold — refined for lane OT2a-1.
/**
 * TelemetryDispositionPort reads and writes the telemetry disposition store
 * of a state directory (plan §3.3 "Application", §3.5): the per-span
 * dispositions, the recorded salt fingerprint and the export counters. Every
 * write merges per span under an exclusive lock with a 500 ms give-up; a
 * pending never replaces a final disposition unless a rejected one is
 * reopened (an exported one is never reopened), and a different
 * salt fingerprint is refused.
 */

import type {
  TelemetryDispositionRecord,
  TelemetryDispositionWriteRequest,
} from '../../../domain/run-telemetry-dispositions.js';

export type TelemetryDispositionRead =
  | { readonly outcome: 'read'; readonly record: TelemetryDispositionRecord }
  | { readonly outcome: 'unreadable' }; // the file was quarantined; never throws

export type TelemetryDispositionWriteResult =
  | { readonly outcome: 'written'; readonly applied: number; readonly kept: number }
  | { readonly outcome: 'skipped'; readonly reason: 'lock-busy' } // 500 ms elapsed; nothing written
  | { readonly outcome: 'refused'; readonly reason: 'invalid-request' | 'salt-mismatch' | 'store-unreadable' };

export interface TelemetryDispositionPort {
  /** Never throws for an unreadable file: it reads `unreadable`. Absent file or in-memory nothing → the empty record. */
  read(): Promise<TelemetryDispositionRead>;
  /**
   * Under the store's lock: the request is validated in full, the file is
   * read under the same lock and each update merges into its one
   * `(traceId, spanId)` entry. `store-unreadable` is a write that found an
   * unreadable file: the file is quarantined and the write is refused, never
   * applied over it, because applying over it would lose the recorded
   * fingerprint. A lock that cannot be taken in time skips the write.
   */
  write(request: TelemetryDispositionWriteRequest): Promise<TelemetryDispositionWriteResult>;
}
