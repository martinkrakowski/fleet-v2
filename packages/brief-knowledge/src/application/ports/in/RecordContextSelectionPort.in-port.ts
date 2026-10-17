// @generated inbound contract scaffold — refined for migration step 4.
/**
 * RecordContextSelectionPort: record the orchestrator's selected entry
 * versions, applicability checks and target brief identity before freezing
 * context. Selections are provenance with an accountable decision; context
 * inclusion alone does not prove saved work.
 */

export interface RecordContextSelectionItem {
  readonly proposalId: string;
  readonly knowledgeEntryId: string;
  readonly version: string;
  readonly accepted: boolean;
  readonly decisionBecause?: string;
}

export interface RecordBriefContextSelectionRequest {
  readonly attemptId: string;
  readonly selections: readonly RecordContextSelectionItem[];
  readonly nowIso?: string;
  /**
   * The ranking `contextRef` (`ranking:<laneId>:<sha256>`) the proposals
   * carried, as `ProposeBriefContext` reported it. When given and non-empty,
   * a recorded selection also appends the best-effort ranking-selection
   * outcome the trial report joins (K4); without it nothing is recorded
   * beyond the selections themselves.
   */
  readonly rankingContextRef?: string;
}

export type RecordBriefContextSelectionResult =
  | { readonly outcome: 'recorded'; readonly recordedCount: number }
  | { readonly outcome: 'rejected'; readonly reason: string };

export interface RecordContextSelectionPort {
  /** Record the orchestrator's selections for one attempt before context freezes. */
  recordContextSelection(request: RecordBriefContextSelectionRequest): Promise<RecordBriefContextSelectionResult>;
}
