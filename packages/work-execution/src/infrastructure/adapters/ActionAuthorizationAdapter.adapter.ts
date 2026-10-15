// @generated adapter stub — refined for migration step 1 (no behaviour).
/**
 * ActionAuthorizationAdapter implements ActionAuthorizationPort
 * (in-process delegation to operator-coordination). Wiring lands in wave 2;
 * every method refuses until then.
 */

import type {
  ActionAuthorizationPort,
  ConsumeActionAuthorizationRequest,
  ConsumeActionAuthorizationResult,
  ResolveActionAuthorizationRequest,
  ResolveActionAuthorizationResult,
} from '../../application/ports/out/ActionAuthorizationPort.out-port.js';

export class ActionAuthorizationAdapter implements ActionAuthorizationPort {
  async resolveActionAuthorization(
    _request: ResolveActionAuthorizationRequest,
  ): Promise<ResolveActionAuthorizationResult> {
    throw new Error('Not implemented: ActionAuthorizationAdapter.resolveActionAuthorization');
  }

  async consumeActionAuthorization(
    _request: ConsumeActionAuthorizationRequest,
  ): Promise<ConsumeActionAuthorizationResult> {
    throw new Error('Not implemented: ActionAuthorizationAdapter.consumeActionAuthorization');
  }
}
