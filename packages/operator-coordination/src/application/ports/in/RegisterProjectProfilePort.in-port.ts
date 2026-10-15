// @generated inbound contract scaffold — refined for step 5.
/**
 * RegisterProjectProfilePort: validate installation references, designated
 * dispatcher, runner capabilities and approved policy without persisting
 * credential values.
 */

import type { ProjectProfileRecord } from '../../../domain/coordination-records.js';

export interface RegisterProjectProfileRequest {
  readonly projectId: string;
  readonly displayName: string;
  readonly repository: string;
  readonly designatedDispatcherHost: string;
  readonly policyRevision: string;
  readonly maxConcurrentLanes: number;
  readonly runnerCapabilities: Readonly<Record<string, boolean | string>>;
  readonly nowIso?: string;
}

export type RegisterProjectProfileResult =
  | {
      readonly outcome: 'registered';
      readonly profile: ProjectProfileRecord;
    }
  | {
      readonly outcome: 'rejected';
      readonly reason: string;
    };

export interface RegisterProjectProfilePort {
  registerProjectProfile(
    request: RegisterProjectProfileRequest,
  ): Promise<RegisterProjectProfileResult>;
}
