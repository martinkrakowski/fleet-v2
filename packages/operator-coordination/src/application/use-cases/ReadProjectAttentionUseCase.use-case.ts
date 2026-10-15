/**
 * ReadProjectAttentionUseCase implements ReadProjectAttentionPort. It reads one
 * project's bounded attention and staleness summary without rewriting anything.
 *
 * An unreadable summary is unavailable; it is never reported as an empty,
 * healthy project. A summary that belongs to another project is refused the
 * same way, so reading attention never crosses a project boundary.
 */

import type { ProjectAttentionSummaryRecord } from '../../domain/coordination-records.js';
import type {
  ReadProjectAttentionPort,
  ReadProjectAttentionRequest,
  ReadProjectAttentionResult,
} from '../ports/in/ReadProjectAttentionPort.in-port.js';
import type { AttentionReadPort } from '../ports/out/AttentionReadPort.out-port.js';

export interface ReadProjectAttentionDependencies {
  readonly attentionPort: AttentionReadPort;
}

export class ReadProjectAttentionUseCase implements ReadProjectAttentionPort {
  constructor(private readonly deps?: ReadProjectAttentionDependencies) {}

  async readProjectAttention(
    request: ReadProjectAttentionRequest,
  ): Promise<ReadProjectAttentionResult> {
    return this.execute(request);
  }

  async execute(input: unknown): Promise<ReadProjectAttentionResult> {
    if (!this.deps || typeof input !== 'object' || input === null) {
      throw new Error('Not implemented: ReadProjectAttentionUseCase');
    }
    const request = input as ReadProjectAttentionRequest;
    if (typeof request.projectId !== 'string' || request.projectId.trim().length === 0) {
      throw new Error('Not implemented: ReadProjectAttentionUseCase');
    }
    const projectId = request.projectId.trim();
    let summary: ProjectAttentionSummaryRecord | null;
    try {
      summary = await this.deps.attentionPort.fetchProjectAttention(projectId);
    } catch (error) {
      return {
        outcome: 'unavailable',
        reason: `attention for ${projectId} could not be read: ${
          error instanceof Error ? error.message : 'unknown read failure'
        }`,
      };
    }
    if (summary === null) {
      return { outcome: 'unavailable', reason: `no attention summary is readable for ${projectId}` };
    }
    if (summary.projectId !== projectId) {
      return {
        outcome: 'unavailable',
        reason: `attention summary belongs to ${summary.projectId}, not ${projectId}`,
      };
    }
    return { outcome: 'read', attention: summary };
  }
}
