// @generated outbound contract scaffold — refined for migration step 1.
/**
 * BriefAuthoringPort: obtain a project orchestrator's brief or a hand-written
 * file without introducing provider inference into the control plane.
 */

export interface AuthoredBriefRequest {
  readonly workOrderId: string;
  readonly laneId: string;
  /** Path of a hand-written brief file, when one is used instead of the orchestrator. */
  readonly handWrittenBriefPath: string | null;
}

export interface AuthoredBrief {
  readonly proseMarkdown: string;
  readonly provenance: 'orchestrator' | 'hand-written-file';
}

export type AuthoredBriefResult =
  | { readonly outcome: 'authored'; readonly brief: AuthoredBrief }
  | { readonly outcome: 'unavailable'; readonly reason: string };

export interface BriefAuthoringPort {
  /** Obtain the reviewed prose brief for one lane. */
  authorBrief(request: AuthoredBriefRequest): Promise<AuthoredBriefResult>;
}
