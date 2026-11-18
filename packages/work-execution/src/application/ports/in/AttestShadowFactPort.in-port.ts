// Lane AT1: the owner attestation command's inbound contract. One call records
// one sticky one-time shadow fact (`s2-forge-error-backoff`, `s2-canary-parks`
// or `s3-wake-after-outage`) into the installation's attestation ledger at the
// caller's expected revision, keyed in the cutover journal by operation id.
// `execute` accepts `unknown` and never throws; ids, digests and codes only.
import type { ShadowAttestation, ShadowAttestationLedger } from '../../../domain/shadow-attestations.js';

export interface AttestShadowFactRequest {
  readonly fact: string;
  readonly note: string;
  readonly evidence?: string;
  /** The ledger revision the caller believes is stored; 0 when nothing is stored yet. */
  readonly expectedRevision: number;
  readonly operationId: string;
  /** A non-empty label; hashed into the digest, never stored. */
  readonly authority: string;
  readonly deadlineIso?: string;
}

export type AttestShadowFactRefusalReason =
  | 'invalid-input'
  | 'unknown-fact'
  | 'secret-shaped'
  | 'authority-required'
  | 'operation-id-conflict'
  | 'revision-conflict'
  | 'journal-refused'
  | 'journal-incomplete'
  | 'read-only';

export type AttestShadowFactUnknownReason =
  | 'deadline-exceeded'
  | 'clock-unreadable'
  | 'journal-unreadable'
  | 'journal-append-failed'
  | 'attestations-unknown-version'
  | 'attestations-unreadable'
  | 'attestations-write-refused';

export type AttestShadowFactResult =
  | {
      readonly outcome: 'attested' | 'unchanged';
      readonly ledger: ShadowAttestationLedger;
      readonly attestation: ShadowAttestation;
    }
  | { readonly outcome: 'refused'; readonly reason: AttestShadowFactRefusalReason }
  | { readonly outcome: 'unknown'; readonly reason: AttestShadowFactUnknownReason };

export interface AttestShadowFactPort {
  execute(request: unknown): Promise<AttestShadowFactResult>;
}
