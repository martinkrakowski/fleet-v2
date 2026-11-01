/**
 * Pure helpers for policy grants (auto-merge plan A3/A7, conductor plan §4
 * AM3a): a policy grant is an ordinary approved action-decision named by the
 * setting revision that authorised it; nothing here decides eligibility.
 */

import type { CoordinationRequestRecord } from './coordination-records.js';

/** Forge kinds a policy grant may authorise (A3; the conductor's forge steps). */
export const POLICY_GRANT_FORGE_KINDS = ['push-and-open-pr', 'push-to-pr', 'merge-pr', 'post-status'] as const;
export type PolicyGrantForgeKind = (typeof POLICY_GRANT_FORGE_KINDS)[number];

/** Installation settings that may authorise a policy grant. */
export const POLICY_GRANT_SOURCES = ['autoMerge', 'conductor'] as const;
export type PolicyGrantSource = (typeof POLICY_GRANT_SOURCES)[number];

/** The one setting that may authorise each kind; the pairing is closed. */
export const POLICY_GRANT_SOURCE_FOR_KIND: Readonly<Record<PolicyGrantForgeKind, PolicyGrantSource>> =
  Object.freeze({
    'push-and-open-pr': 'conductor',
    'push-to-pr': 'conductor',
    'merge-pr': 'autoMerge',
    'post-status': 'conductor',
  });

/** A setting revision: 12 lower-case hex characters (installation's autoMergeRevision / conductorRevision). */
export const POLICY_SETTING_REVISION_PATTERN = /^[0-9a-f]{12}$/;

/** A full commit id: 40 (sha1) or 64 (sha256) lower-case hex characters. */
export const POLICY_GRANT_HEAD_PATTERN = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

export const POLICY_DECISION_REVISION_PREFIX = 'policy:';

const FORGE_SCOPE_PREFIX = 'forge:';

/** `forge:<kind>`, the same scope work-execution's `forgeActionScope` builds. */
export function policyGrantActionScope(kind: PolicyGrantForgeKind): string {
  return `forge:${kind}`;
}

/** The forge kind a scope names, or null when it is not `forge:<one of POLICY_GRANT_FORGE_KINDS>`. */
export function policyGrantForgeKindOf(actionScope: string): PolicyGrantForgeKind | null {
  if (!actionScope.startsWith(FORGE_SCOPE_PREFIX)) {
    return null;
  }
  const kind = actionScope.slice(FORGE_SCOPE_PREFIX.length);
  if (!(POLICY_GRANT_FORGE_KINDS as readonly string[]).includes(kind)) {
    return null;
  }
  return kind as PolicyGrantForgeKind;
}

/** `policy:<source>@<revision>`. */
export function policyDecisionRevision(source: PolicyGrantSource, revision: string): string {
  return `${POLICY_DECISION_REVISION_PREFIX}${source}@${revision}`;
}

/** `{ source, revision }` for a well-formed `policy:<source>@<12 hex>`, else null. Never throws. */
export function parsePolicyDecisionRevision(
  value: unknown,
): { readonly source: PolicyGrantSource; readonly revision: string } | null {
  if (typeof value !== 'string' || !value.startsWith(POLICY_DECISION_REVISION_PREFIX)) {
    return null;
  }
  const atIndex = value.lastIndexOf('@');
  if (atIndex === -1) {
    return null;
  }
  const source = value.slice(POLICY_DECISION_REVISION_PREFIX.length, atIndex);
  const revision = value.slice(atIndex + 1);
  if (
    !(POLICY_GRANT_SOURCES as readonly string[]).includes(source) ||
    !POLICY_SETTING_REVISION_PATTERN.test(revision)
  ) {
    return null;
  }
  return { source: source as PolicyGrantSource, revision };
}

/**
 * The canonical proposal a policy grant binds (A3): `policy-grant/v1:` followed by
 * `JSON.stringify({ attemptId, expectedHeadSha, acceptanceReceiptId })` with exactly that key order.
 */
export function policyGrantProposalDigest(
  attemptId: string,
  expectedHeadSha: string,
  acceptanceReceiptId: string,
): string {
  return `policy-grant/v1:${JSON.stringify({
    attemptId,
    expectedHeadSha,
    acceptanceReceiptId,
  })}`;
}

/**
 * True for any request the no-id resolve must skip: one carrying `policyGrant`, or one whose
 * `decisionRevision` starts with `policy:` (A3's rule, kept even for a malformed revision so it fails closed).
 */
export function isPolicyGrantRecord(record: CoordinationRequestRecord): boolean {
  return (
    record.policyGrant !== undefined ||
    record.decisionRevision?.startsWith(POLICY_DECISION_REVISION_PREFIX) === true
  );
}
