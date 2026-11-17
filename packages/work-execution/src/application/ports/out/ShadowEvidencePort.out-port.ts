/**
 * ShadowEvidencePort stores and reads the one ShadowLedger v1 of an
 * installation with compare-and-set on its revision (lane SH2). An unknown
 * version or an unreadable ledger is reported, never treated as absent and
 * never overwritten. It performs no forge, host or git action.
 */
import type { ShadowLedger } from '../../../domain/shadow-evidence-ledger.js';

export type ShadowLedgerReadResult =
  | { readonly status: 'missing' }
  | { readonly status: 'ok'; readonly ledger: ShadowLedger }
  | { readonly status: 'unknown-version' }
  | { readonly status: 'unreadable' };

export type ShadowLedgerCasRefusalReason =
  | 'invalid-request'
  | 'invalid-ledger'
  | 'unknown-version'
  | 'unreadable'
  | 'read-only'
  | 'deadline-exceeded';

export type ShadowLedgerCasResult =
  | { readonly outcome: 'saved'; readonly ledger: ShadowLedger }
  | { readonly outcome: 'conflict'; readonly currentRevision: number | null }
  | { readonly outcome: 'refused'; readonly reason: ShadowLedgerCasRefusalReason };

export interface ShadowEvidencePort {
  /** Never writes, locks or quarantines. */
  read(options?: { readonly deadlineIso?: string }): Promise<ShadowLedgerReadResult>;
  /** Saves `next` only when the stored revision is `expectedRevision` (0 when nothing is stored). Never throws. */
  compareAndSet(request: {
    readonly expectedRevision: number;
    readonly next: ShadowLedger;
    readonly deadlineIso?: string;
  }): Promise<ShadowLedgerCasResult>;
}
