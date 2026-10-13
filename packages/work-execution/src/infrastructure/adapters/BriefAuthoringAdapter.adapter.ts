// @generated adapter stub — placeholders refuse; no external operation is implemented.
/**
 * BriefAuthoringAdapter implements BriefAuthoringPort
 *
 * Intended integration (manifest adapter_bindings): reviewed harness or a
 * hand-written file, without provider inference in the control plane.
 * Not implemented in migration step 1.
 */

import type {
  AuthoredBriefRequest,
  AuthoredBriefResult,
  BriefAuthoringPort,
} from '../../application/ports/out/BriefAuthoringPort.out-port.js';

export class BriefAuthoringAdapter implements BriefAuthoringPort {
  authorBrief(_request: AuthoredBriefRequest): Promise<AuthoredBriefResult> {
    return Promise.reject(new Error('Not implemented: BriefAuthoringAdapter.authorBrief'));
  }
}
