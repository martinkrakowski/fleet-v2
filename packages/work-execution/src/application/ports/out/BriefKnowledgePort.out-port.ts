// @generated outbound contract scaffold — refined for migration step 1.
/**
 * BriefKnowledgePort: request bounded context proposals, record selected
 * versions and forward only completed-attempt notes to the knowledge context.
 * Consumer-side types only; the adapter delegates to brief-knowledge's
 * application contracts at the composition root.
 */

export interface BriefContextProposal {
  readonly proposalId: string;
  readonly knowledgeEntryId: string;
  readonly version: string;
  /** Why this proposal was made; retrieval proposes, the orchestrator decides. */
  readonly proposedBecause: string;
}

export interface RequestBriefContextProposalsRequest {
  readonly projectId: string;
  readonly laneId: string;
  readonly taskSummary: string;
}

export type RequestBriefContextProposalsResult =
  | { readonly outcome: 'proposed'; readonly proposals: readonly BriefContextProposal[] }
  | { readonly outcome: 'unavailable'; readonly reason: string };

export interface RecordContextSelectionEntry {
  readonly proposalId: string;
  readonly knowledgeEntryId: string;
  readonly version: string;
  readonly accepted: boolean;
}

export interface RecordContextSelectionRequest {
  readonly attemptId: string;
  readonly selections: readonly RecordContextSelectionEntry[];
}

export type RecordContextSelectionResult =
  | { readonly outcome: 'recorded' }
  | { readonly outcome: 'refused'; readonly reason: string };

export interface ForwardCompletedAttemptNotesRequest {
  readonly attemptId: string;
  readonly workOrderId: string;
  readonly headCommit: string;
  readonly notes: string | null;
}

export type ForwardCompletedAttemptNotesResult =
  | { readonly outcome: 'forwarded' }
  | { readonly outcome: 'refused'; readonly reason: string };

export interface BriefKnowledgePort {
  /** Retrieve bounded candidate context proposals for one lane. */
  requestBriefContextProposals(
    request: RequestBriefContextProposalsRequest,
  ): Promise<RequestBriefContextProposalsResult>;

  /** Record the orchestrator's accepted/excluded knowledge versions for an attempt. */
  recordContextSelection(request: RecordContextSelectionRequest): Promise<RecordContextSelectionResult>;

  /** Forward notes only from an ended, collected attempt; null notes are explicit. */
  forwardCompletedAttemptNotes(
    request: ForwardCompletedAttemptNotesRequest,
  ): Promise<ForwardCompletedAttemptNotesResult>;
}
