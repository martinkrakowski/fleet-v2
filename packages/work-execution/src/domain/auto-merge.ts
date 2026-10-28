/**
 * Pure rules of the auto-merge policy (auto-merge plan A4, A7, A8, A11, §4). Nothing here reads
 * a store or decides a merge on its own; unknown is never eligible.
 */

import { readExactPlainRecord } from './plain-record-reads.js';
import { head12Of } from './lane-run-keys.js';

export const AUTO_MERGE_REASONS = [
  'invalid-request', 'settings-unreadable', 'attempt-missing', 'work-order-missing', 'records-unreadable',
  'work-order-closed', 'no-head', 'forge-history-unreadable', 'forge-suspended', 'already-attempted',
  'door-named', 'doors-unreadable', 'high-risk', 'forge-mode', 'gate-not-passed', 'acceptance-unreadable',
  'acceptance-blocked', 'ci-pending-second-look', 'first-look-unrecorded', 'merge-not-wired',
  'grant-refused', 'grant-superseded', 'grant-revision-mismatch', 'setting-changed', 'head-moved',
  'forge-refused', 'forge-ambiguous', 'forge-refused-before-grant',
] as const;
export type AutoMergeReason = (typeof AUTO_MERGE_REASONS)[number];

/** Where a not-merged outcome is sent (§4). `on-blocked` means the setting's onBlocked decides. */
export type AutoMergeRouteRule = 'none' | 'attention' | 'owner-question' | 'on-blocked';

export const AUTO_MERGE_ROUTE_RULE: Readonly<Record<AutoMergeReason, AutoMergeRouteRule>> = Object.freeze({
  'invalid-request': 'none',
  'attempt-missing': 'none',
  'work-order-missing': 'none',
  'records-unreadable': 'none',
  'work-order-closed': 'none',
  'no-head': 'none',
  'already-attempted': 'none',
  'first-look-unrecorded': 'none',
  'merge-not-wired': 'none',
  'grant-superseded': 'none',
  'setting-changed': 'none',
  'head-moved': 'none',
  'settings-unreadable': 'attention',
  'forge-history-unreadable': 'attention',
  'forge-suspended': 'attention',
  'door-named': 'attention',
  'doors-unreadable': 'attention',
  'high-risk': 'attention',
  'forge-mode': 'attention',
  'acceptance-unreadable': 'attention',
  'grant-refused': 'attention',
  'grant-revision-mismatch': 'attention',
  'forge-ambiguous': 'attention',
  'forge-refused-before-grant': 'attention',
  'forge-refused': 'owner-question',
  'gate-not-passed': 'on-blocked',
  'acceptance-blocked': 'on-blocked',
  'ci-pending-second-look': 'on-blocked',
});

/** One auto-merge action per (attempt, head): `auto-merge:<attemptId>:<headSha>`. */
export function autoMergeActionId(attemptId: string, headSha: string): string {
  return 'auto-merge:' + attemptId + ':' + headSha;
}

/** The journal-entry prefix of every forge entry of one auto-merge action. */
export function autoMergeForgeEntryPrefix(attemptId: string, headSha: string): string {
  return 'forge:' + autoMergeActionId(attemptId, headSha) + ':';
}

/** The execution-journal entry id of a first look; distinct from the accept-entry prefix and suffix. */
export function autoMergeFirstLookEntryId(attemptId: string, headSha: string): string {
  return attemptId + ':auto-merge-first-look:' + headSha;
}

/** Stable notice key per (attempt, head, reason); missing or malformed head reads as `no-head`. */
export function autoMergeRoutingKey(attemptId: string, headSha: string | null, reason: AutoMergeReason): string {
  return 'auto-merge/' + attemptId + '/' + (head12Of(headSha) ?? 'no-head') + '/' + reason;
}

/** Prefix of the authorised-by value of a policy merge: `policy:autoMerge@<12 hex>`. */
export const AUTO_MERGE_DECISION_PREFIX = 'policy:autoMerge@';

/** The provider decision revision that authorises a policy merge. */
export function autoMergeDecisionRevision(revision: string): string {
  return AUTO_MERGE_DECISION_PREFIX + revision;
}

/** The installation's auto-merge revision: exactly 12 lowercase hex. */
export const AUTO_MERGE_REVISION_PATTERN = /^[0-9a-f]{12}$/;

/** A full 40- or 64-hex commit id (the same shape AM3a's grant requires). */
export const AUTO_MERGE_HEAD_PATTERN = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

/** An authorised-by value naming a policy revision (`autoMerge` or `conductor`). */
export const AUTHORIZED_BY_PATTERN = /^policy:(?:autoMerge|conductor)@[0-9a-f]{12}$/;

export type AutoMergeOnBlocked = 'ask-owner' | 'hold';

export type AutoMergeForgeMode = 'github' | 'none' | 'unknown';

export interface AutoMergeSettings {
  readonly allowHighRisk: boolean;
  readonly onBlocked: AutoMergeOnBlocked;
  readonly revision: string;
  readonly forgeMode: AutoMergeForgeMode;
}

export type AutoMergeSettingsRead =
  | { readonly kind: 'off' }
  | { readonly kind: 'on'; readonly settings: AutoMergeSettings }
  | { readonly kind: 'unreadable'; readonly reason: string };

const AUTO_MERGE_SETTINGS_READ_KEYS = ['outcome', 'enabled', 'allowHighRisk', 'onBlocked', 'revision', 'forgeMode'];
const AUTO_MERGE_SETTINGS_UNREADABLE_KEYS = ['outcome', 'reason'];
const AUTO_MERGE_SETTINGS_NOT_PLAIN = 'settings answer is not a plain record';
const AUTO_MERGE_SETTINGS_UNREADABLE = 'settings could not be read';

/**
 * Read the port's settings answer. `enabled` is read first: `false` is off whatever the other fields
 * say; only an enabled block must be fully well-typed. A non-boolean `enabled` is unreadable.
 */
export function readAutoMergeSettingsAnswer(answer: unknown): AutoMergeSettingsRead {
  let record = readExactPlainRecord(answer, AUTO_MERGE_SETTINGS_READ_KEYS);
  if (record === null) {
    record = readExactPlainRecord(answer, AUTO_MERGE_SETTINGS_UNREADABLE_KEYS);
    if (record !== null && record.outcome === 'unreadable') {
      return { kind: 'unreadable', reason: AUTO_MERGE_SETTINGS_UNREADABLE };
    }
    return { kind: 'unreadable', reason: AUTO_MERGE_SETTINGS_NOT_PLAIN };
  }
  if (record.outcome !== 'read') {
    return { kind: 'unreadable', reason: AUTO_MERGE_SETTINGS_NOT_PLAIN };
  }
  if (record.enabled === false) {
    return { kind: 'off' };
  }
  if (record.enabled !== true) {
    return { kind: 'unreadable', reason: 'enabled is not a boolean' };
  }
  if (typeof record.allowHighRisk !== 'boolean') {
    return { kind: 'unreadable', reason: 'allowHighRisk is not a boolean' };
  }
  if (record.onBlocked !== 'ask-owner' && record.onBlocked !== 'hold') {
    return { kind: 'unreadable', reason: 'onBlocked is not ask-owner or hold' };
  }
  if (typeof record.revision !== 'string' || !AUTO_MERGE_REVISION_PATTERN.test(record.revision)) {
    return { kind: 'unreadable', reason: 'revision does not match the 12-hex pattern' };
  }
  if (record.forgeMode !== 'github' && record.forgeMode !== 'none' && record.forgeMode !== 'unknown') {
    return { kind: 'unreadable', reason: 'forgeMode is not github, none or unknown' };
  }
  return {
    kind: 'on',
    settings: Object.freeze({
      allowHighRisk: record.allowHighRisk as boolean,
      onBlocked: record.onBlocked as AutoMergeOnBlocked,
      revision: record.revision as string,
      forgeMode: record.forgeMode as AutoMergeForgeMode,
    }),
  };
}

export interface AutoMergeBlocker {
  readonly kind: string;
  readonly text: string;
}

const AUTO_MERGE_MAX_BLOCKERS = 20;
const AUTO_MERGE_MAX_BLOCKER_TEXT = 300;
const AUTO_MERGE_OTHER_BLOCKER = 'other';

/**
 * Read the acceptance port's `blockerDetails`. Absent, non-array, empty, or containing a non-record
 * reads as one `other` blocker; texts are capped for display and the list is capped at 20 entries.
 */
export function autoMergeBlockersOf(details: unknown, fallbackText: string): readonly AutoMergeBlocker[] {
  const fallback: AutoMergeBlocker = { kind: AUTO_MERGE_OTHER_BLOCKER, text: fallbackText.slice(0, AUTO_MERGE_MAX_BLOCKER_TEXT) };
  if (!Array.isArray(details) || details.length === 0) {
    return [fallback];
  }
  const blockers: AutoMergeBlocker[] = [];
  for (const element of details) {
    if (blockers.length >= AUTO_MERGE_MAX_BLOCKERS) {
      break;
    }
    const record = readExactPlainRecord(element, ['kind', 'text']);
    if (record === null || typeof record.kind !== 'string' || typeof record.text !== 'string') {
      return [fallback];
    }
    blockers.push({ kind: record.kind, text: record.text.slice(0, AUTO_MERGE_MAX_BLOCKER_TEXT) });
  }
  return blockers;
}

/**
 * True only for a non-empty list whose every entry is `ci-pending`. Written with `.some`, never
 * `.every`, so an empty list is never "only ci-pending".
 */
export function isCiPendingOnly(blockers: readonly AutoMergeBlocker[]): boolean {
  return blockers.length > 0 && !blockers.some((blocker) => blocker.kind !== 'ci-pending');
}

export type AutoMergeDoors =
  | { readonly kind: 'none' }
  | { readonly kind: 'named'; readonly count: number }
  | { readonly kind: 'unreadable' };

function autoMergeDoorsFromReferences(references: unknown): AutoMergeDoors {
  if (!Array.isArray(references)) {
    return { kind: 'unreadable' };
  }
  for (const reference of references) {
    if (typeof reference !== 'string') {
      return { kind: 'unreadable' };
    }
  }
  return references.length === 0 ? { kind: 'none' } : { kind: 'named', count: references.length };
}

/** Read an AttemptOwnerDecisionPort answer: recorded with an array of strings → none/named; else unreadable. */
export function autoMergeDoorsOf(answer: unknown): AutoMergeDoors {
  if (Array.isArray(answer)) {
    return autoMergeDoorsFromReferences(answer);
  }
  const record = readExactPlainRecord(answer, ['outcome', 'ownerDecisionReferences']);
  if (record === null || record.outcome !== 'recorded') {
    return { kind: 'unreadable' };
  }
  return autoMergeDoorsFromReferences(record.ownerDecisionReferences);
}

export interface AutoMergeEligibilityFacts {
  readonly doors: AutoMergeDoors;
  readonly risk: 'standard' | 'high';
  readonly allowHighRisk: boolean;
  readonly forgeMode: AutoMergeForgeMode;
}

/** The first failing A4 fact, in this order: doors (unreadable, then named), risk, forge mode; else null. */
export function autoMergeIneligibility(facts: AutoMergeEligibilityFacts): AutoMergeReason | null {
  if (facts.doors.kind === 'unreadable') {
    return 'doors-unreadable';
  }
  if (facts.doors.kind === 'named') {
    return 'door-named';
  }
  if (facts.risk === 'high' && !facts.allowHighRisk) {
    return 'high-risk';
  }
  if (facts.forgeMode !== 'github') {
    return 'forge-mode';
  }
  return null;
}
