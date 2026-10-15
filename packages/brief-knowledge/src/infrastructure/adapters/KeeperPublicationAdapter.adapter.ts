// @generated adapter stub — refined for migration step 5 (no behaviour).
/**
 * KeeperPublicationAdapter implements KeeperPublicationPort
 * (optional-stash-subprocess-or-local-export). Implementation lands in a
 * later wave; the method refuses until then.
 */

import type { KeeperPublicationPort, PublishKeeperToShelfRequest, PublishKeeperToShelfResult } from '../../application/ports/out/KeeperPublicationPort.out-port.js';

export class KeeperPublicationAdapter implements KeeperPublicationPort {
  async publishKeeperToShelf(_request: PublishKeeperToShelfRequest): Promise<PublishKeeperToShelfResult> {
    throw new Error('Not implemented: KeeperPublicationAdapter.publishKeeperToShelf');
  }
}
