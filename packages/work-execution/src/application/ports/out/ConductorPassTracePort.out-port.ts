// @generated outbound contract scaffold — refined for lane VZ5a.
import type { ConductorPassTraceInput, ConductorPassTraceRecord } from '../../../domain/conductor-pass-trace.js';

export type ConductorPassTraceNotRecordedReason =
  | 'limits-unset' | 'read-only' | 'invalid-trace' | 'unknown-schema-version' | 'store-unreadable' | 'write-failed';
export type ConductorPassTraceAppendResult =
  | { readonly outcome: 'recorded'; readonly passId: string }
  | { readonly outcome: 'not-recorded'; readonly reason: ConductorPassTraceNotRecordedReason };
export type ConductorPassTraceListResult =
  | { readonly outcome: 'listed'; /** Oldest first, as stored. */ readonly traces: readonly ConductorPassTraceRecord[] }
  | { readonly outcome: 'unreadable'; readonly reason: 'unknown-schema-version' | 'store-unreadable' };
export interface ConductorPassTracePort {
  /** Never throws; a not-recorded append wrote nothing. */
  append(input: ConductorPassTraceInput): Promise<ConductorPassTraceAppendResult>;
  /** Never throws; reads only. */
  list(): Promise<ConductorPassTraceListResult>;
}
