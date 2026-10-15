// @generated inbound contract scaffold — refined for step 5.
/**
 * InspectConfiguredCapabilitiesPort: report the configured runner and
 * integration capabilities, missing requirements and explicit unknowns. An
 * unrecorded capability is unknown, never assumed available.
 */

import type { ProjectProfileRecord } from '../../../domain/coordination-records.js';

export interface InspectConfiguredCapabilitiesRequest {
  readonly projectId: string;
  readonly requiredCapabilities?: readonly string[];
}

export type InspectConfiguredCapabilitiesResult =
  | {
      readonly outcome: 'inspected';
      readonly profile: ProjectProfileRecord;
      readonly missingRequirements: readonly string[];
      readonly explicitUnknowns: readonly string[];
    }
  | {
      readonly outcome: 'not-found';
      readonly projectId: string;
    };

export interface InspectConfiguredCapabilitiesPort {
  inspectConfiguredCapabilities(
    request: InspectConfiguredCapabilitiesRequest,
  ): Promise<InspectConfiguredCapabilitiesResult>;
}
