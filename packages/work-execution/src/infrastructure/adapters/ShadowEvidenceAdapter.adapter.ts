/**
 * ShadowEvidenceAdapter implements ShadowEvidencePort over the one
 * shadow-evidence ledger of a state directory (lane SE0):
 * `<stateDir>/shadow-evidence.json`, or memory only when no state directory
 * is given. A read never writes, locks or quarantines: a missing file is
 * known absence and an unknown version or an unreadable file is reported,
 * never treated as absent and never overwritten. A write is a
 * compare-and-set on the ledger's revision under the shared exclusive lock
 * with an atomic rename, and it accepts only a well-formed ledger v1 whose
 * revision is the stored revision plus one. Files are read through
 * `readBoundedStoreBytes`: a symlink, a non-regular file or one over 64 KiB
 * is unreadable, never absent. Ids, digests and codes only.
 */

import * as path from 'node:path';

import type {
  ShadowEvidenceCompareAndSetInput,
  ShadowEvidenceCompareAndSetResult,
  ShadowEvidencePort,
  ShadowEvidenceRead,
} from '../../application/ports/out/ShadowEvidencePort.out-port.js';
import {
  SHADOW_EVIDENCE_LEDGER_SCHEMA_VERSION,
  readShadowEvidenceLedger,
  type ShadowEvidenceLedger,
} from '../../domain/shadow-evidence-ledger.js';
import { assertStoreWritable, readBoundedStoreBytes, withFileLock, writeJsonAtomically } from './file-store.js';

/** The ledger keeps 31 days of 13 criteria verdicts each; 64 KiB bounds it generously. */
export const SHADOW_EVIDENCE_MAX_BYTES = 65_536;

export interface ShadowEvidenceAdapterOptions {
  /** Directory for file-backed persistence; in-memory only when omitted or blank. */
  readonly stateDir?: string;
  /** File name inside the state directory; defaults to `shadow-evidence.json`. */
  readonly fileName?: string;
  /** Read-only: every compare-and-set is refused. */
  readonly readOnly?: boolean;
}

const DEFAULT_FILE_NAME = 'shadow-evidence.json';
const SAFE_FILE_NAME = /^[A-Za-z0-9._-]{1,128}$/;

export class ShadowEvidenceAdapter implements ShadowEvidencePort {
  private inMemoryLedger: ShadowEvidenceLedger | null = null;
  private readonly target: string | null;

  constructor(private readonly options: ShadowEvidenceAdapterOptions = {}) {
    const { stateDir, fileName } = options;
    if (fileName !== undefined) {
      if (!SAFE_FILE_NAME.test(fileName) || fileName === '.' || fileName === '..') {
        throw new Error('ShadowEvidenceAdapter refuses unsafe state file name');
      }
    }
    this.target =
      stateDir === undefined || stateDir.trim().length === 0
        ? null
        : path.join(stateDir, fileName ?? DEFAULT_FILE_NAME);
  }

  async read(): Promise<ShadowEvidenceRead> {
    try {
      return await this.load();
    } catch {
      return { status: 'unreadable' };
    }
  }

  async compareAndSet(input: ShadowEvidenceCompareAndSetInput): Promise<ShadowEvidenceCompareAndSetResult> {
    try {
      return await this.compareAndSetUnchecked(input);
    } catch {
      return { outcome: 'refused' };
    }
  }

  private async compareAndSetUnchecked(input: ShadowEvidenceCompareAndSetInput): Promise<ShadowEvidenceCompareAndSetResult> {
    try {
      assertStoreWritable(this.options.readOnly === true, 'ShadowEvidenceAdapter');
    } catch {
      return { outcome: 'refused' };
    }
    const { expectedRevision, next } = input;
    if (
      typeof expectedRevision !== 'number' ||
      !Number.isSafeInteger(expectedRevision) ||
      expectedRevision < 0
    ) {
      return { outcome: 'refused' };
    }
    // The stored bytes are never overwritten: the next ledger must itself be a
    // well-formed v1 at exactly the stored revision plus one.
    const validated = readShadowEvidenceLedger(next);
    if (!validated.ok || validated.ledger.revision !== expectedRevision + 1) {
      return { outcome: 'refused' };
    }

    const target = this.target;
    if (target === null) {
      // No await between the decision and the store: two racing writes cannot both pass.
      const current = this.memoryState();
      if (current.status === 'unknown-version' || current.status === 'unreadable') {
        return { outcome: 'refused' };
      }
      if ((current.status === 'ok' ? current.ledger.revision : 0) !== expectedRevision) {
        return { outcome: 'conflict' };
      }
      this.inMemoryLedger = validated.ledger;
      return { outcome: 'recorded', ledger: validated.ledger };
    }
    return withFileLock(`${target}.lock`, async (): Promise<ShadowEvidenceCompareAndSetResult> => {
      const current = await this.load();
      if (current.status === 'unknown-version' || current.status === 'unreadable') {
        return { outcome: 'refused' };
      }
      if ((current.status === 'ok' ? current.ledger.revision : 0) !== expectedRevision) {
        return { outcome: 'conflict' };
      }
      await writeJsonAtomically(target, { ...validated.ledger, schemaVersion: SHADOW_EVIDENCE_LEDGER_SCHEMA_VERSION });
      return { outcome: 'recorded', ledger: validated.ledger };
    });
  }

  private memoryState(): ShadowEvidenceRead {
    return this.inMemoryLedger === null ? { status: 'absent' } : { status: 'ok', ledger: this.inMemoryLedger };
  }

  private async load(): Promise<ShadowEvidenceRead> {
    const target = this.target;
    if (target === null) {
      return this.memoryState();
    }
    let bounded;
    try {
      bounded = await readBoundedStoreBytes(target, SHADOW_EVIDENCE_MAX_BYTES);
    } catch {
      return { status: 'unreadable' };
    }
    if (bounded.status === 'missing') return { status: 'absent' };
    if (bounded.status !== 'ok') return { status: 'unreadable' };
    let raw: unknown;
    try {
      raw = JSON.parse(bounded.bytes.toString('utf8'));
    } catch {
      return { status: 'unreadable' };
    }
    const read = readShadowEvidenceLedger(raw);
    if (read.ok) return { status: 'ok', ledger: read.ledger };
    return read.reason === 'unknown-version' ? { status: 'unknown-version' } : { status: 'unreadable' };
  }
}
