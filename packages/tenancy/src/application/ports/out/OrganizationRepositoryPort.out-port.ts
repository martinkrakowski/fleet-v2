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
import type { ProjectRecord } from '../../../domain/entities/Project.js';

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

/** A stored project: its validated record plus its current revision. */
export interface StoredProject {
  readonly record: ProjectRecord;
  readonly revision: number;
}

/** The outcome of one project write: saved with the new revision, or refused. */
export type ProjectWriteOutcome =
  | { readonly status: 'saved'; readonly record: ProjectRecord; readonly revision: number }
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

  /**
   * The stored project `(organizationId, projectId)`, or null when none is
   * stored, when the pair belongs to another organisation, or when either id
   * is not a non-empty string (a malformed lookup fails closed, never
   * answering across organisations).
   */
  findProject(organizationId: string, projectId: string): Promise<StoredProject | null>;
  /**
   * Every stored project of `organizationId` (required), in insertion order.
   * An invalid `organizationId` is an empty list, never other organisations'
   * projects.
   */
  listProjects(organizationId: string): Promise<readonly StoredProject[]>;
  /**
   * Store a new project under its organisation at revision 0;
   * `already-exists` when the `(organizationId, projectId)` pair is taken
   * (the same `projectId` under another organisation is a different
   * project), `invalid-record` for invalid or hostile input. It does not
   * check whether `organizationId` exists in `organizations.json`.
   */
  createProject(record: ProjectRecord): Promise<ProjectWriteOutcome>;
  /**
   * Compare-and-swap on the `(organizationId, projectId)` pair: the stored
   * record's revision must equal `expectedRevision`; the stored record then
   * moves to `expectedRevision + 1`. `not-found` for an absent pair,
   * `stale-revision` for a mismatched revision and `invalid-record` for
   * invalid or hostile input, including a non-integer, negative or
   * non-safe-integer `expectedRevision`. It never applies a lifecycle
   * transition itself: `decideProjectTransition` runs in the domain before
   * `saveProject` is called.
   */
  saveProject(record: ProjectRecord, expectedRevision: number): Promise<ProjectWriteOutcome>;
}

/**
 * Thrown by `findOrganization` for an id that is not a non-empty string: a
 * malformed lookup key is a caller bug, never an answer of "absent". The
 * message never echoes the offending value.
 */
export class UnsafeOrganizationIdError extends Error {
  constructor() {
    super('organization id must be a non-empty string');
    this.name = 'UnsafeOrganizationIdError';
  }
}
