// Implemented adapter — acceptance & forge station (cross-context step).
/**
 * ActionAuthorizationAdapter implements ActionAuthorizationPort by
 * in-process delegation to operator-coordination's authorization
 * contracts, or by enforcing the same rules over a supplied grant map
 * until that wiring lands at the composition root.
 *
 * Head and action-kind applicability are verified at resolve time, where
 * the request carries those coordinates; consumption then durably binds
 * one grant to exactly one action id — a second unrelated action is
 * refused, while the same action id remains idempotently consumed.
 */

import type {
  ActionAuthorizationPort,
  ConsumeActionAuthorizationRequest,
  ConsumeActionAuthorizationResult,
  ResolveActionAuthorizationRequest,
  ResolveActionAuthorizationResult,
} from '../../application/ports/out/ActionAuthorizationPort.out-port.js';

/** Known grant facts the adapter may enforce without the supplier context. */
export interface ActionAuthorizationGrantEntry {
  /** Head the grant applies to; a moved head is out of scope. */
  readonly expectedHeadSha: string;
  /** Action kind the grant was issued for. */
  readonly kind: string;
  /** Action id that durably consumed this grant; null while unconsumed. */
  consumedByActionId: string | null;
}

/** Supplier-side delegates; the composition root binds the real use cases. */
export interface ActionAuthorizationDelegate {
  readonly resolveGrant?: (
    request: ResolveActionAuthorizationRequest,
  ) => Promise<ResolveActionAuthorizationResult>;
  readonly consumeGrant?: (
    request: ConsumeActionAuthorizationRequest,
  ) => Promise<ConsumeActionAuthorizationResult>;
  /** Local grant store; entries are bound in place on consumption. */
  readonly grants?: Map<string, ActionAuthorizationGrantEntry>;
}

export class ActionAuthorizationAdapter implements ActionAuthorizationPort {
  private readonly delegate?: ActionAuthorizationDelegate;

  constructor(delegate?: ActionAuthorizationDelegate) {
    this.delegate = delegate;
  }

  async resolveActionAuthorization(
    request: ResolveActionAuthorizationRequest,
  ): Promise<ResolveActionAuthorizationResult> {
    if (this.delegate?.resolveGrant) {
      return this.delegate.resolveGrant(request);
    }
    const grants = this.delegate?.grants;
    if (grants) {
      for (const [authorizationGrantId, grant] of grants) {
        if (
          grant.consumedByActionId === null &&
          grant.kind === request.actionKind &&
          grant.expectedHeadSha === request.expectedHeadSha
        ) {
          return { outcome: 'granted', authorizationGrantId };
        }
      }
      return {
        outcome: 'blocked',
        reason: 'No unconsumed authorization grant matches the requested head and action kind',
      };
    }
    throw new Error('Not implemented: ActionAuthorizationAdapter.resolveActionAuthorization');
  }

  async consumeActionAuthorization(
    request: ConsumeActionAuthorizationRequest,
  ): Promise<ConsumeActionAuthorizationResult> {
    if (this.delegate?.consumeGrant) {
      return this.delegate.consumeGrant(request);
    }
    const grants = this.delegate?.grants;
    if (grants) {
      const grant = grants.get(request.authorizationGrantId);
      if (!grant) {
        return {
          outcome: 'refused',
          reason: `Authorization grant not found: ${request.authorizationGrantId}`,
        };
      }
      if (grant.consumedByActionId === null) {
        grants.set(request.authorizationGrantId, {
          ...grant,
          consumedByActionId: request.actionId,
        });
        return { outcome: 'consumed', actionId: request.actionId };
      }
      if (grant.consumedByActionId === request.actionId) {
        // Idempotent: the same action may observe its own consumption.
        return { outcome: 'consumed', actionId: request.actionId };
      }
      return {
        outcome: 'refused',
        reason: `Authorization grant already consumed by action ${grant.consumedByActionId}`,
      };
    }
    throw new Error('Not implemented: ActionAuthorizationAdapter.consumeActionAuthorization');
  }
}
