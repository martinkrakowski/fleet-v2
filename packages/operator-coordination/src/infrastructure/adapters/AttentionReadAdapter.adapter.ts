// @generated adapter stub — refined for step 5 (no behaviour).
/**
 * AttentionReadAdapter implements AttentionReadPort
 * (existing-waves-read-endpoints). Implementation lands in a later step; it
 * refuses rather than reporting an unreadable summary as an empty project.
 */

import type { ProjectAttentionSummaryRecord } from '../../domain/coordination-records.js';
import type { AttentionReadPort } from '../../application/ports/out/AttentionReadPort.out-port.js';

export class AttentionReadAdapter implements AttentionReadPort {
  async fetchProjectAttention(_projectId: string): Promise<ProjectAttentionSummaryRecord | null> {
    throw new Error('Not implemented: AttentionReadAdapter.fetchProjectAttention');
  }
}
