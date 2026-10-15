// @generated adapter stub — signature-matched for step 4 (no behaviour).
/**
 * EvidenceArchiveAdapter implements EvidenceArchivePort.
 * Behaviour lands with the station implementation; every method refuses.
 */

import type {
  ArchiveEvidenceRequest,
  ArchiveEvidenceResult,
  EvidenceArchivePort,
} from '../../application/ports/out/EvidenceArchivePort.out-port.js';

export class EvidenceArchiveAdapter implements EvidenceArchivePort {
  async archiveEvidence(_request: ArchiveEvidenceRequest): Promise<ArchiveEvidenceResult> {
    throw new Error('Not implemented: EvidenceArchiveAdapter.archiveEvidence');
  }

  async readArchivedEvidence(_evidenceRef: string): Promise<string | null> {
    throw new Error('Not implemented: EvidenceArchiveAdapter.readArchivedEvidence');
  }
}
