// @generated outbound contract scaffold — refined for step 4.
/**
 * Retain immutable verification and review artifacts addressed by identity
 * and digest.
 */

export interface ArchiveEvidenceRequest {
  readonly artifactId: string;
  readonly candidateHeadSha: string;
  readonly content: string;
}

export interface ArchiveEvidenceResult {
  readonly evidenceRef: string;
  readonly digest: string;
}

export interface EvidenceArchivePort {
  archiveEvidence(request: ArchiveEvidenceRequest): Promise<ArchiveEvidenceResult>;
  readArchivedEvidence(evidenceRef: string): Promise<string | null>;
}
