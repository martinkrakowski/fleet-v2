/**
 * AttentionReadAdapter implements AttentionReadPort over the existing Waves
 * attention and project-staleness read endpoints, an injected reader, or a
 * local summary store.
 *
 * Reads are bounded to one project and are never cached or rewritten here.
 * Known absence is null; a failed read throws instead of returning an empty
 * summary that a caller could mistake for a healthy project.
 */

import type { ProjectAttentionSummaryRecord } from '../../domain/coordination-records.js';
import type { AttentionReadPort } from '../../application/ports/out/AttentionReadPort.out-port.js';

export type AttentionReader = (
  projectId: string,
) =>
  | Promise<ProjectAttentionSummaryRecord | null>
  | ProjectAttentionSummaryRecord
  | null;

export interface AttentionReadAdapterOptions {
  /** Existing Waves read boundary for one project. */
  readonly read?: AttentionReader;
  /** Locally held summaries, used when no reader is configured. */
  readonly summaries?: Readonly<Record<string, ProjectAttentionSummaryRecord>>;
}

function copy(summary: ProjectAttentionSummaryRecord): ProjectAttentionSummaryRecord {
  return { ...summary };
}

export class AttentionReadAdapter implements AttentionReadPort {
  constructor(private readonly options: AttentionReadAdapterOptions = {}) {}

  async fetchProjectAttention(projectId: string): Promise<ProjectAttentionSummaryRecord | null> {
    const { read, summaries } = this.options;
    if (read !== undefined) {
      // A failed read is an error, never an empty summary.
      const fetched = await read(projectId);
      return fetched === null ? null : copy(fetched);
    }
    const stored = summaries?.[projectId];
    return stored === undefined ? null : copy(stored);
  }
}
