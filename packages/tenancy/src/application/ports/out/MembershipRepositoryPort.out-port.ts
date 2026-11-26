// @generated outbound contract scaffold — refined for FC3E.
/**
 * MembershipRepositoryPort is the outbound contract for persisting
 * per-organisation membership. One record per `organizationId` holds
 * `{ revision, members }`; every change re-runs the pure
 * `decideMembershipChange` invariants under the store's guard, so the store
 * never accepts a list the decider would refuse. Known absence is `null`
 * (or an empty list); an unreadable file store is a named error, never
 * silence and never a default. No method throws for a domain or hostile
 * input refusal: every refusal of `applyChange` is a typed result.
 */

import type { MembershipChange, MembershipRecord } from '../../../domain/entities/Membership.js';

/**
 * The outcome of one membership change:
 * - `saved`: the decider accepted the change; `members` is a fresh copy of
 *   the stored list at the new `revision`, and `changedMember` — present
 *   only when the change produced one — is the added or role-changed record.
 * - `refused`: `decideMembershipChange` refused the change with its reason
 *   (for example `last-owner`, `duplicate-actor`, `not-permitted`,
 *   `first-owner-required`, `organization-mismatch`); nothing was written.
 * - `stale-revision`: the stored revision is not `expectedRevision`.
 * - `invalid-record`: a hostile or malformed argument (including an invalid
 *   `nowIso`, a non-integer `expectedRevision` or an unparseable change
 *   object) was refused before the store was touched.
 */
export type MembershipApplyResult =
  | {
      readonly outcome: 'saved';
      readonly revision: number;
      readonly members: readonly MembershipRecord[];
      readonly changedMember?: MembershipRecord;
    }
  | { readonly outcome: 'refused'; readonly reason: string }
  | {
      readonly outcome: 'stale-revision';
      readonly expectedRevision: number;
      readonly actualRevision: number;
    }
  | { readonly outcome: 'invalid-record'; readonly reason: string };

export interface MembershipRepositoryPort {
  /**
   * Every stored member of one organisation, in stored order, as fresh
   * copies: mutating a returned record never affects the store. An absent or
   * hostile `organizationId` answers `[]`, never a throw.
   */
  listMembers(organizationId: string): Promise<readonly MembershipRecord[]>;
  /**
   * One actor's record in one organisation as a fresh copy, or null when the
   * actor is not a member (or either id is hostile). Never throws.
   */
  findMember(organizationId: string, actor: string): Promise<MembershipRecord | null>;
  /**
   * Decide and, only when the decider accepts, apply one membership change
   * at `nowIso` under the store's guard: the organisation's stored
   * `{ revision, members }` is read, `expectedRevision` is verified, a
   * `change` naming another `organizationId` is refused with
   * `organization-mismatch`, and the accepted list is written at
   * `expectedRevision + 1`. Hostile input answers `invalid-record`.
   */
  applyChange(
    organizationId: string,
    change: MembershipChange,
    expectedRevision: number,
    nowIso: string,
  ): Promise<MembershipApplyResult>;
}
