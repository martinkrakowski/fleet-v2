// @generated inbound contract scaffold — refined for lane WB4a.
/**
 * ImportLanePlanPort: import one validated plan sidecar revision per
 * (projectId, planId). Recording is import, not dispatch: it authorizes
 * nothing. Project match, greater-revision CAS with digest idempotency,
 * the cross-plan cycle check and dropped lanes kept are decided here.
 */
import type {
  LanePlanRecord,
  PullRequestLinkRecord,
  PullRequestLinkSource,
} from '../../../domain/lane-plan-records.js';

export interface ImportLanePlanRequest {
  /** The JSON.parse result of a `<plan>.workbook.json` file; validated here, never trusted. */
  readonly sidecar: unknown;
  /** The operator's requested project; must equal the sidecar's projectId. */
  readonly requestedProjectId: string;
}

export type ImportLanePlanRefusalCode =
  | 'request' | 'sidecar-invalid' | 'project-mismatch'
  | 'stale-revision' | 'plan-cycle' | 'store';

/** One backfilled `mergedPr` link's outcome, reported on an imported plan. */
export interface MergedPrLinkOutcome {
  readonly repository: string;
  readonly number: number;
  readonly laneId: string;
  readonly outcome: 'linked' | 'unchanged' | 'refused';
  readonly code: 'pr-already-linked' | null;
}

export type ImportLanePlanResult =
  | {
      readonly outcome: 'imported';
      readonly plan: LanePlanRecord;
      readonly digest: string;
      readonly links: readonly MergedPrLinkOutcome[];
    }
  | { readonly outcome: 'unchanged'; readonly plan: LanePlanRecord }
  | { readonly outcome: 'refused'; readonly code: ImportLanePlanRefusalCode; readonly reason: string };

export interface ImportLanePlanPort {
  /** Import one sidecar revision. Recording is import, not dispatch: it authorizes nothing. */
  importLanePlan(request: ImportLanePlanRequest): Promise<ImportLanePlanResult>;
}

// hosted here: the index barrels are owned by the cutover lane; no new file until that lane merges
/** Link one pull request to one lane (work-board plan §3.2 "PR links are unique"). */
export interface LinkPullRequestRequest {
  readonly repository: string;
  readonly number: number;
  readonly projectId: string;
  /** null for a lane with no plan. */
  readonly planId: string | null;
  readonly laneId: string;
  readonly source: PullRequestLinkSource;
}

export type LinkPullRequestRefusalCode = 'invalid' | 'unknown-lane' | 'pr-already-linked' | 'store';

export type LinkPullRequestResult =
  | { readonly outcome: 'linked'; readonly link: PullRequestLinkRecord }
  | { readonly outcome: 'unchanged'; readonly link: PullRequestLinkRecord }
  | {
      readonly outcome: 'refused';
      readonly code: LinkPullRequestRefusalCode;
      readonly reason: string;
    };

export interface LinkPullRequestPort {
  linkPullRequest(request: LinkPullRequestRequest): Promise<LinkPullRequestResult>;
}
