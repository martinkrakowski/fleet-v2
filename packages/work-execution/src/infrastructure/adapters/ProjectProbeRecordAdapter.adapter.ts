/**
 * ProjectProbeRecordAdapter implements ProjectProbeRecordPort by delegating
 * in-process to operator-coordination's RecordProjectProbePort, bound by the
 * composition root. Without a delegate it throws. The supplier's `recorded`
 * and `rejected` outcomes map one-to-one; any other answer throws.
 */

import type {
  ProjectProbeRecordPort,
  ProjectProbeRecordRequest,
  ProjectProbeRecordResult,
} from '../../application/ports/out/ProjectProbeRecordPort.out-port.js';

export interface ProjectProbeRecordDelegate {
  readonly record?: (req: ProjectProbeRecordRequest) => Promise<unknown>;
}

export class ProjectProbeRecordAdapter implements ProjectProbeRecordPort {
  constructor(private readonly delegate?: ProjectProbeRecordDelegate) {}

  async recordProjectProbe(request: ProjectProbeRecordRequest): Promise<ProjectProbeRecordResult> {
    const record = this.delegate?.record;
    if (!record) {
      throw new Error('Not implemented: ProjectProbeRecordAdapter');
    }

    const answer = await record(request);
    if (answer === null || typeof answer !== 'object') {
      throw new Error('ProjectProbeRecordAdapter received an unexpected answer');
    }
    const answerRecord = answer as Record<string, unknown>;

    if (answerRecord.outcome === 'recorded') {
      return { outcome: 'recorded' };
    }
    if (answerRecord.outcome === 'rejected') {
      if (typeof answerRecord.reason !== 'string' || answerRecord.reason.trim() === '') {
        throw new Error('ProjectProbeRecordAdapter received a rejection without a reason');
      }
      return { outcome: 'rejected', reason: answerRecord.reason };
    }
    throw new Error('ProjectProbeRecordAdapter received an unexpected answer');
  }
}
