// @generated adapter stub — refined for step 5 (no behaviour).
/**
 * DecisionTransportAdapter implements DecisionTransportPort
 * (existing-waves-decision-client-or-owner-recorded-file). Implementation lands
 * in a later step; it refuses rather than reporting an unverified answer as a
 * decision.
 */

import type {
  DecisionAnswer,
  DecisionTransportPort,
} from '../../application/ports/out/DecisionTransportPort.out-port.js';

export class DecisionTransportAdapter implements DecisionTransportPort {
  async readDecisionAnswer(_requestId: string): Promise<DecisionAnswer> {
    throw new Error('Not implemented: DecisionTransportAdapter.readDecisionAnswer');
  }
}
