// @generated inbound contract scaffold — refined for P3b.
/**
 * RecordProjectProbePort: store a probe receipt as the profile's last probe
 * only when the profile is still at the revision the probe started from.
 */

import type {
  ProjectProfileRecord,
  ProjectProbeReceiptRecord,
} from '../../../domain/coordination-records.js';

export interface RecordProjectProbeRequest {
  readonly projectId: string;
  readonly expectedRevision: number;
  readonly receipt: ProjectProbeReceiptRecord;
}

export type RecordProjectProbeResult =
  | {
      readonly outcome: 'recorded';
      readonly profile: ProjectProfileRecord;
    }
  | {
      readonly outcome: 'rejected';
      readonly reason: string;
    };

export interface RecordProjectProbePort {
  recordProjectProbe(
    request: RecordProjectProbeRequest,
  ): Promise<RecordProjectProbeResult>;
}
