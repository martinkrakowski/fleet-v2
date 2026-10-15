// @generated inbound contract scaffold — refined for migration step 4.
/**
 * ProposeBriefContextPort: return eligible ranked keepers for a project's
 * task, paths, environment and target revision within explicit retrieval
 * bounds. Proposals are observations for the project orchestrator, who
 * decides what enters a brief — never instructions or authority.
 */

export interface ProposeBriefContextRequest {
  readonly projectId: string;
  readonly laneId: string;
  readonly taskSummary: string;
  readonly pathPrefixes?: readonly string[];
  readonly maxEntries?: number;
  readonly maxTotalChars?: number;
}

/** One ranked keeper proposal; the orchestrator selects what enters a brief. */
export interface BriefKnowledgeProposal {
  readonly proposalId: string;
  readonly knowledgeEntryId: string;
  readonly version: string;
  readonly claimText: string;
  readonly proposedBecause: string;
}

export type ProposeBriefContextResult =
  | { readonly outcome: 'proposed'; readonly proposals: readonly BriefKnowledgeProposal[] }
  | { readonly outcome: 'rejected'; readonly reason: string };

export interface ProposeBriefContextPort {
  /** Propose bounded, eligible keepers for one task; rejected, superseded or inapplicable facts are never returned. */
  proposeBriefContext(request: ProposeBriefContextRequest): Promise<ProposeBriefContextResult>;
}
