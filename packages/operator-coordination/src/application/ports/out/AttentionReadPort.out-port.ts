// @generated outbound contract scaffold — refined for step 5.
/**
 * AttentionReadPort: read the existing Waves attention and project-staleness
 * endpoints with bounded requests. Known absence is null; a failed read is an
 * error, never an empty summary presented as a healthy project.
 */

import type { ProjectAttentionSummaryRecord } from '../../../domain/coordination-records.js';

export interface AttentionReadPort {
  fetchProjectAttention(projectId: string): Promise<ProjectAttentionSummaryRecord | null>;
}
