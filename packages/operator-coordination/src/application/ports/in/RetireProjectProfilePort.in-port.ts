// @generated inbound contract scaffold — refined for P3a.
/**
 * RetireProjectProfilePort: mark a profile retired when the caller names the
 * revision it read; history is kept and new work orders for it are refused
 * elsewhere.
 */

import type { ProjectProfileRecord } from '../../../domain/coordination-records.js';

export interface RetireProjectProfileRequest {
  readonly projectId: string;
  readonly expectedRevision: number;
  readonly nowIso?: string;
}

export type RetireProjectProfileResult =
  | {
      readonly outcome: 'retired';
      readonly profile: ProjectProfileRecord;
    }
  | {
      readonly outcome: 'rejected';
      readonly reason: string;
    };

export interface RetireProjectProfilePort {
  retireProjectProfile(request: RetireProjectProfileRequest): Promise<RetireProjectProfileResult>;
}
