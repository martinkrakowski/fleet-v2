// Implemented adapter — acceptance & forge station (cross-context step).
/**
 * BriefKnowledgeAdapter implements BriefKnowledgePort by in-process
 * delegation to brief-knowledge's application contracts. Until that
 * wiring lands at the composition root, the adapter either delegates to
 * supplied functions or serves a local in-memory store; every method
 * rejects while unconfigured. Notes and proposals are observations, never
 * instructions or authority.
 */

import type {
  BriefContextProposal,
  BriefKnowledgePort,
  ForwardCompletedAttemptNotesRequest,
  ForwardCompletedAttemptNotesResult,
  RecordContextSelectionRequest,
  RecordContextSelectionResult,
  RequestBriefContextProposalsRequest,
  RequestBriefContextProposalsResult,
} from '../../application/ports/out/BriefKnowledgePort.out-port.js';

/** Supplier-side delegates; the composition root binds the real use cases. */
export interface BriefKnowledgeDelegate {
  readonly propose?: (
    request: RequestBriefContextProposalsRequest,
  ) => Promise<RequestBriefContextProposalsResult>;
  readonly recordSelection?: (
    request: RecordContextSelectionRequest,
  ) => Promise<RecordContextSelectionResult>;
  readonly forwardNotes?: (
    request: ForwardCompletedAttemptNotesRequest,
  ) => Promise<ForwardCompletedAttemptNotesResult>;
  /** Serve a local in-memory store instead of a supplier delegate. */
  readonly enableInMemory?: boolean;
  /** Proposals served by the in-memory store. */
  readonly proposals?: readonly BriefContextProposal[];
}

export class BriefKnowledgeAdapter implements BriefKnowledgePort {
  private readonly delegate?: BriefKnowledgeDelegate;
  private readonly inMemorySelections: RecordContextSelectionRequest[] = [];
  private readonly inMemoryForwardedNotes: ForwardCompletedAttemptNotesRequest[] = [];

  constructor(delegate?: BriefKnowledgeDelegate) {
    this.delegate = delegate;
  }

  requestBriefContextProposals(
    request: RequestBriefContextProposalsRequest,
  ): Promise<RequestBriefContextProposalsResult> {
    if (this.delegate?.propose) {
      return this.delegate.propose(request);
    }
    if (this.delegate?.enableInMemory) {
      return Promise.resolve({
        outcome: 'proposed',
        proposals: [...(this.delegate.proposals ?? [])],
      });
    }
    return Promise.reject(
      new Error('Not implemented: BriefKnowledgeAdapter.requestBriefContextProposals'),
    );
  }

  recordContextSelection(request: RecordContextSelectionRequest): Promise<RecordContextSelectionResult> {
    if (this.delegate?.recordSelection) {
      return this.delegate.recordSelection(request);
    }
    if (this.delegate?.enableInMemory) {
      this.inMemorySelections.push(request);
      return Promise.resolve({ outcome: 'recorded' });
    }
    return Promise.reject(new Error('Not implemented: BriefKnowledgeAdapter.recordContextSelection'));
  }

  forwardCompletedAttemptNotes(
    request: ForwardCompletedAttemptNotesRequest,
  ): Promise<ForwardCompletedAttemptNotesResult> {
    if (this.delegate?.forwardNotes) {
      return this.delegate.forwardNotes(request);
    }
    if (this.delegate?.enableInMemory) {
      // Null notes are an explicit fact; they are forwarded as-is.
      this.inMemoryForwardedNotes.push(request);
      return Promise.resolve({ outcome: 'forwarded' });
    }
    return Promise.reject(
      new Error('Not implemented: BriefKnowledgeAdapter.forwardCompletedAttemptNotes'),
    );
  }
}
