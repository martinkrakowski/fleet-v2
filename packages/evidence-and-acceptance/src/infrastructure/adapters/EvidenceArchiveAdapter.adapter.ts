// @generated adapter stub — signature-matched for step 4 (no behaviour).
/**
 * EvidenceArchiveAdapter implements EvidenceArchivePort.
 * Behaviour lands with the station implementation; every method refuses.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type {
  ArchiveEvidenceRequest,
  ArchiveEvidenceResult,
  EvidenceArchivePort,
} from '../../application/ports/out/EvidenceArchivePort.out-port.js';

export interface EvidenceArchiveOptions {
  /** When set, archived artifacts are also written as `<sha256>.txt`. */
  readonly archiveDir?: string;
}

function sha256Hex(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function digestFromEvidenceRef(evidenceRef: string): string | null {
  const separatorIndex = evidenceRef.lastIndexOf('@');
  if (separatorIndex === -1) {
    return null;
  }
  const digest = evidenceRef.slice(separatorIndex + 1);
  return /^[0-9a-f]{64}$/.test(digest) ? digest : null;
}

export class EvidenceArchiveAdapter implements EvidenceArchivePort {
  private readonly artifacts = new Map<string, string>();

  constructor(private readonly options: EvidenceArchiveOptions = {}) {}

  async archiveEvidence(request: ArchiveEvidenceRequest): Promise<ArchiveEvidenceResult> {
    const digest = sha256Hex(request.content);
    // The reference carries the digest, so identical content is stored once
    // and a reference can be re-verified against its bytes later.
    const evidenceRef = `evidence://${request.artifactId}@${digest}`;
    this.artifacts.set(digest, request.content);
    this.persist(digest, request.content);
    return { evidenceRef, digest };
  }

  async readArchivedEvidence(evidenceRef: string): Promise<string | null> {
    const digest = digestFromEvidenceRef(evidenceRef);
    if (digest === null) {
      return null;
    }
    const inMemory = this.artifacts.get(digest);
    if (inMemory !== undefined) {
      return inMemory;
    }
    return this.read(digest);
  }

  private pathFor(digest: string): string | null {
    const archiveDir = this.options.archiveDir;
    return archiveDir === undefined ? null : join(archiveDir, `${digest}.txt`);
  }

  private persist(digest: string, content: string): void {
    const path = this.pathFor(digest);
    if (path === null) {
      return;
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, 'utf8');
  }

  private read(digest: string): string | null {
    const path = this.pathFor(digest);
    if (path === null) {
      return null;
    }
    try {
      return readFileSync(path, 'utf8');
    } catch {
      return null;
    }
  }
}