// @generated inbound contract scaffold — refined for P3a.
/**
 * UpdateProjectProfilePort: change an active profile only when the caller
 * names the revision it read. The whole merged profile is re-checked against
 * the installation (host, clone and gate procedure names), not only the
 * changed fields, so a profile naming a host or procedure the installation no
 * longer has must be repaired (or retired; retire is not name-checked) before
 * any other edit. A change of repository or clones clears the last probe.
 */

import type { ProjectCloneRecord, ProjectProfileRecord } from '../../../domain/coordination-records.js';

export interface UpdateProjectProfileRequest {
  readonly projectId: string;
  readonly expectedRevision: number;
  readonly changes: Partial<{
    readonly displayName: string;
    readonly repository: string;
    readonly designatedDispatcherHost: string;
    readonly policyRevision: string;
    readonly maxConcurrentLanes: number;
    readonly runnerCapabilities: Readonly<Record<string, boolean | string>>;
    readonly defaultBranch: string | null;
    readonly clones: Readonly<Record<string, ProjectCloneRecord>>;
    readonly gateProcedures: readonly string[];
    readonly defaultAllowedPathPrefixes: readonly string[];
  }>;
  readonly nowIso?: string;
}

export type UpdateProjectProfileResult =
  | {
      readonly outcome: 'updated';
      readonly profile: ProjectProfileRecord;
    }
  | {
      readonly outcome: 'rejected';
      readonly reason: string;
    };

export interface UpdateProjectProfilePort {
  updateProjectProfile(request: UpdateProjectProfileRequest): Promise<UpdateProjectProfileResult>;
}
