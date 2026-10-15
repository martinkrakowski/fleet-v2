// @generated adapter stub — refined for migration step 1 (no behaviour).
/**
 * ForgeActionAdapter implements ForgeActionPort
 * (reviewed-github-cli-subprocess). Forge stays owner-gated until migration
 * step 7; every method refuses until then.
 */

import type {
  ForgeActionPort,
  ForgeActionRequest,
  ForgeActionResult,
} from '../../application/ports/out/ForgeActionPort.out-port.js';

export class ForgeActionAdapter implements ForgeActionPort {
  async performForgeAction(_request: ForgeActionRequest): Promise<ForgeActionResult> {
    throw new Error('Not implemented: ForgeActionAdapter.performForgeAction');
  }
}
