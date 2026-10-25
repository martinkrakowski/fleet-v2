// @generated inbound contract scaffold — refined for P3b.
/**
 * InspectProjectProfilePort: return one profile with its revision, or a known
 * absence, without mutating state.
 */

import type { ProjectProfileRecord } from '../../../domain/coordination-records.js';

export interface InspectProjectProfileRequest {
  readonly projectId: string;
}

export type InspectProjectProfileResult =
  | {
      readonly outcome: 'found';
      readonly profile: ProjectProfileRecord;
    }
  | {
      readonly outcome: 'not-found';
      readonly projectId: string;
    }
  | {
      readonly outcome: 'rejected';
      readonly reason: string;
    };

export interface InspectProjectProfilePort {
  inspectProjectProfile(
    request: InspectProjectProfileRequest,
  ): Promise<InspectProjectProfileResult>;
}
