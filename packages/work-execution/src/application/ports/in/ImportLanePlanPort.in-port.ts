// @generated inbound contract scaffold — refined for lane WB4a.
/**
 * ImportLanePlanPort: import one validated plan sidecar revision per
 * (projectId, planId). Recording is import, not dispatch: it authorizes
 * nothing. Project match, greater-revision CAS with digest idempotency,
 * the cross-plan cycle check and dropped lanes kept are decided here.
 */
import type { LanePlanRecord } from '../../../domain/lane-plan-records.js';

export interface ImportLanePlanRequest {
  /** The JSON.parse result of a `<plan>.workbook.json` file; validated here, never trusted. */
  readonly sidecar: unknown;
  /** The operator's requested project; must equal the sidecar's projectId. */
  readonly requestedProjectId: string;
}

export type ImportLanePlanRefusalCode =
  | 'request' | 'sidecar-invalid' | 'project-mismatch'
  | 'stale-revision' | 'plan-cycle' | 'store';

export type ImportLanePlanResult =
  | { readonly outcome: 'imported'; readonly plan: LanePlanRecord; readonly digest: string }
  | { readonly outcome: 'unchanged'; readonly plan: LanePlanRecord }
  | { readonly outcome: 'refused'; readonly code: ImportLanePlanRefusalCode; readonly reason: string };

export interface ImportLanePlanPort {
  /** Import one sidecar revision. Recording is import, not dispatch: it authorizes nothing. */
  importLanePlan(request: ImportLanePlanRequest): Promise<ImportLanePlanResult>;
}
