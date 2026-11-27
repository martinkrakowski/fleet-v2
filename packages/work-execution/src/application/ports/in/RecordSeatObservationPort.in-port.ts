// Implemented for lane SR6 — `fleet-v2 seats observe`.
/**
 * RecordSeatObservationPort: record one `SeatObservationRecord` (plan
 * §3.5.5). The subject must be an existing attempt or review request whose
 * committed seat matches the given seat id and which has no result or
 * receipt yet; at most one cooling observation per seat per observation
 * window; a `dryRun` validates and writes nothing. Every failure path is a
 * typed refusal — the input is never echoed and attempts or installation
 * health are never mutated.
 */

import type { SeatObservationRecord } from '../../../domain/execution-records.js';

export type RecordSeatObservationRefusalCode =
  | 'invalid-input'
  | 'subject-not-found'
  | 'seat-mismatch'
  | 'subject-has-result'
  | 'not-wired'
  | 'store-error'
  | 'clock-error';

export type RecordSeatObservationResult =
  | {
      readonly outcome: 'recorded';
      readonly observation: SeatObservationRecord;
      readonly cooling: boolean;
    }
  | {
      readonly outcome: 'duplicate';
      readonly observation: SeatObservationRecord;
      readonly cooling: false;
      readonly reason: 'duplicate-observation-id' | 'window-already-cooling';
    }
  | {
      readonly outcome: 'dry-run';
      readonly observation: SeatObservationRecord;
      readonly wouldCool: boolean;
      readonly duplicate: boolean;
    }
  | {
      readonly outcome: 'refused';
      readonly code: RecordSeatObservationRefusalCode;
      readonly reason: string;
    };

export interface RecordSeatObservationPort {
  /** `input` is untrusted and never echoed; `via` names the transport, never the body. */
  execute(
    input: unknown,
    via: 'cli' | 'mcp',
    options?: { readonly dryRun?: boolean },
  ): Promise<RecordSeatObservationResult>;
}
