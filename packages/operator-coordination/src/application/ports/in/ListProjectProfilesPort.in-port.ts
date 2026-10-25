// @generated inbound contract scaffold — refined for P3b.
/**
 * ListProjectProfilesPort: return every profile, optionally only active or
 * only retired, sorted by project id, without mutating state.
 */

import type { ProjectProfileRecord } from '../../../domain/coordination-records.js';

export interface ListProjectProfilesRequest {
  readonly status?: 'active' | 'retired';
}

export type ListProjectProfilesResult =
  | {
      readonly outcome: 'listed';
      readonly profiles: readonly ProjectProfileRecord[];
    }
  | {
      readonly outcome: 'rejected';
      readonly reason: string;
    };

export interface ListProjectProfilesPort {
  listProjectProfiles(
    request: ListProjectProfilesRequest,
  ): Promise<ListProjectProfilesResult>;
}
