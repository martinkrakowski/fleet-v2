// @generated adapter stub — signature-matched for step 4 (no behaviour).
/**
 * IndependentReviewAdapter implements IndependentReviewPort.
 * Behaviour lands with the station implementation; every method refuses.
 */

import type {
  IndependentReviewPort,
  RunIndependentReviewRequest,
  RunIndependentReviewResult,
} from '../../application/ports/out/IndependentReviewPort.out-port.js';

export class IndependentReviewAdapter implements IndependentReviewPort {
  async runIndependentReview(
    _request: RunIndependentReviewRequest,
  ): Promise<RunIndependentReviewResult> {
    throw new Error('Not implemented: IndependentReviewAdapter.runIndependentReview');
  }
}
