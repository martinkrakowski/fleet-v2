/**
 * ShadowEvidencePort stores and reads the one cutover shadow-evidence ledger
 * v1 of an installation with compare-and-set on its revision. A recorded
 * day-and-criterion verdict is never changed, an identical repeat is a no-op
 * and any other is refused; the newest 31 days are kept. An absent ledger is
 * known absence; an unknown version or an unreadable ledger is reported,
 * never treated as absent and never overwritten. Ids, digests and codes only.
 */

import type {
  ShadowEvidenceLedger,
  ShadowEvidenceLedgerRead,
} from '../../../domain/shadow-evidence-ledger.js';

export type { ShadowEvidenceLedger, ShadowEvidenceLedgerRead };

/** The read of the ledger store: known absence is its own answer. */
export type ShadowEvidenceRead =
  | { readonly status: 'ok'; readonly ledger: ShadowEvidenceLedger }
  | { readonly status: 'absent' }
  | { readonly status: 'unreadable' }
  | { readonly status: 'unknown-version' };

export interface ShadowEvidenceCompareAndSetInput {
  /** The revision this call read; any other value is a `conflict`. */
  readonly expectedRevision: number;
  /** The complete next ledger, already trimmed to its newest 31 days. */
  readonly next: ShadowEvidenceLedger;
}

export type ShadowEvidenceCompareAndSetResult =
  | { readonly outcome: 'recorded'; readonly ledger: ShadowEvidenceLedger }
  | { readonly outcome: 'conflict' }
  | { readonly outcome: 'refused' };

export interface ShadowEvidencePort {
  read(): Promise<ShadowEvidenceRead>;
  compareAndSet(input: ShadowEvidenceCompareAndSetInput): Promise<ShadowEvidenceCompareAndSetResult>;
}
