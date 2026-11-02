// @generated adapter scaffold — refined for lane KA2.
/**
 * KillallStopAgentUnavailableAdapter implements KillallStopAgentPort without a
 * live transport: the real stop agent (KA3) lives in another repository and
 * arrives in a later lane, so this adapter always reports `unavailable`. It
 * performs no I/O; the CLI never imports KA3 and never runs a real stop.
 */

import type {
  KillallStopAgentPort,
  KillallStopAgentResult,
} from '../../application/ports/out/KillallStopAgentPort.out-port.js';

export class KillallStopAgentUnavailableAdapter implements KillallStopAgentPort {
  async stop(_request: { readonly haltedAtIso: string }): Promise<KillallStopAgentResult> {
    return { ok: false, reason: 'unavailable' };
  }
}
