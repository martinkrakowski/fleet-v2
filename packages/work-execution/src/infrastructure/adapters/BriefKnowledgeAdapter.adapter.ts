// @generated adapter stub — placeholders refuse; no external operation is implemented.
/**
 * BriefKnowledgeAdapter implements BriefKnowledgePort
 *
 * Intended integration (manifest adapter_bindings): in-process delegation to
 * brief-knowledge application contracts. Not implemented in migration step 1.
 */

import type {
  BriefKnowledgePort,
  ForwardCompletedAttemptNotesRequest,
  ForwardCompletedAttemptNotesResult,
  RecordContextSelectionRequest,
  RecordContextSelectionResult,
  RequestBriefContextProposalsRequest,
  RequestBriefContextProposalsResult,
} from '../../application/ports/out/BriefKnowledgePort.out-port.js';

export class BriefKnowledgeAdapter implements BriefKnowledgePort {
  requestBriefContextProposals(
    _request: RequestBriefContextProposalsRequest,
  ): Promise<RequestBriefContextProposalsResult> {
    return Promise.reject(new Error('Not implemented: BriefKnowledgeAdapter.requestBriefContextProposals'));
  }

  recordContextSelection(
    _request: RecordContextSelectionRequest,
  ): Promise<RecordContextSelectionResult> {
    return Promise.reject(new Error('Not implemented: BriefKnowledgeAdapter.recordContextSelection'));
  }

  forwardCompletedAttemptNotes(
    _request: ForwardCompletedAttemptNotesRequest,
  ): Promise<ForwardCompletedAttemptNotesResult> {
    return Promise.reject(new Error('Not implemented: BriefKnowledgeAdapter.forwardCompletedAttemptNotes'));
  }
}
