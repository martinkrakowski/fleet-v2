// @generated inbound contract scaffold — refined for lane VZ5b.
import type { ConductorPassTraceRecord } from '../../../domain/conductor-pass-trace.js';

export const LIST_CONDUCTOR_PASSES_MAX_LIMIT = 32;
export type ConductorPassView = Omit<ConductorPassTraceRecord, 'holderId'>;
export interface ListConductorPassesRequest {
  readonly limit?: number; // 1..32, default 32
}
export type ListConductorPassesResult =
  | {
      readonly outcome: 'listed';
      readonly store: 'readable' | 'unreadable';
      /** Newest first. */
      readonly passes: readonly ConductorPassView[];
      readonly total: number;
      readonly truncated: boolean;
    }
  | { readonly outcome: 'rejected'; readonly reason: 'invalid-limit' };
export interface ListConductorPassesPort {
  listConductorPasses(request: ListConductorPassesRequest): Promise<ListConductorPassesResult>;
}
