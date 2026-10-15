// @generated inbound contract scaffold — refined for step 5.
/**
 * ReadProjectAttentionPort: read bounded attention and staleness summaries
 * without rewriting another project's observations. An unreadable summary is
 * unavailable; it is never reported as an empty, healthy project.
 */

import type { ProjectAttentionSummaryRecord } from '../../../domain/coordination-records.js';

export interface ReadProjectAttentionRequest {
  readonly projectId: string;
}

export type ReadProjectAttentionResult =
  | {
      readonly outcome: 'read';
      readonly attention: ProjectAttentionSummaryRecord;
    }
  | {
      readonly outcome: 'unavailable';
      readonly reason: string;
    };

export interface ReadProjectAttentionPort {
  readProjectAttention(request: ReadProjectAttentionRequest): Promise<ReadProjectAttentionResult>;
}
