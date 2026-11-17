/**
 * ShadowAttestationPort stores and reads the one ShadowAttestationLedger of an
 * installation with compare-and-set on its revision (lane SH16). An unknown
 * version or an unreadable ledger is reported, never treated as absent and
 * never overwritten. It performs no forge, host or git action.
 */
import type { ShadowAttestationLedger } from '../../../domain/shadow-attestations.js';

export type ShadowAttestationReadResult =
  | { readonly status: 'missing' }
  | { readonly status: 'ok'; readonly ledger: ShadowAttestationLedger }
  | { readonly status: 'unknown-version' }
  | { readonly status: 'unreadable' };

export type ShadowAttestationCasRefusalReason =
  | 'invalid-request'
  | 'invalid-ledger'
  | 'unknown-version'
  | 'unreadable'
  | 'read-only'
  | 'deadline-exceeded';

export type ShadowAttestationCasResult =
  | { readonly outcome: 'saved'; readonly ledger: ShadowAttestationLedger }
  | { readonly outcome: 'conflict'; readonly currentRevision: number | null }
  | { readonly outcome: 'refused'; readonly reason: ShadowAttestationCasRefusalReason };

export interface ShadowAttestationPort {
  /** Never writes, locks or quarantines. */
  read(options?: { readonly deadlineIso?: string }): Promise<ShadowAttestationReadResult>;
  /** Saves `next` only when the stored revision is `expectedRevision` (0 when nothing is stored). Never throws. */
  compareAndSet(request: {
    readonly expectedRevision: number;
    readonly next: ShadowAttestationLedger;
    readonly deadlineIso?: string;
  }): Promise<ShadowAttestationCasResult>;
}
