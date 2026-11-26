// @generated outbound contract scaffold — refined for FC3D.
/**
 * OrganizationRepositoryPort is the outbound contract for persisting
 * organisation records. `revision` carries optimistic concurrency:
 * `createOrganization` stores at revision 0 and `saveOrganization` stores only
 * at the stored revision plus one. Known absence is `null`; an unreadable
 * store is a named error, never silence and never a default. No method throws
 * for a domain refusal: every refusal is a typed result.
 */

import type { OrganizationRecord } from '../../../domain/entities/Organization.js';

/** A stored organisation: its validated record plus its current revision. */
export interface StoredOrganization {
  readonly record: OrganizationRecord;
  readonly revision: number;
}

/** The outcome of one organisation write: saved with the new revision, or refused. */
export type OrganizationWriteOutcome =
  | { readonly status: 'saved'; readonly record: OrganizationRecord; readonly revision: number }
  | {
      readonly status: 'refused';
      readonly reason: 'already-exists' | 'not-found' | 'stale-revision' | 'invalid-record';
    };

export interface OrganizationRepositoryPort {
  /** The stored organisation for `organizationId`, or null when none is stored. */
  findOrganization(id: string): Promise<StoredOrganization | null>;
  /** Every stored organisation, in insertion order. */
  listOrganizations(): Promise<readonly StoredOrganization[]>;
  /**
   * Store a new organisation at revision 0; `already-exists` when the id is
   * taken, `invalid-record` for invalid or hostile input.
   */
  createOrganization(record: OrganizationRecord): Promise<OrganizationWriteOutcome>;
  /**
   * Compare-and-swap: the stored record's revision must equal
   * `expectedRevision`; the stored record then moves to
   * `expectedRevision + 1`. `not-found` for an absent id, `stale-revision`
   * for a mismatched revision and `invalid-record` for invalid or hostile
   * input, including a non-integer, negative or non-safe-integer
   * `expectedRevision`.
   */
  saveOrganization(record: OrganizationRecord, expectedRevision: number): Promise<OrganizationWriteOutcome>;
}
