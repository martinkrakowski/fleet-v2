/**
 * Shared knowledge records used by more than one contract. They are pure
 * domain facts — serializable projections of the KnowledgeEntry aggregate —
 * so they live here rather than inside any single port module.
 */

import type { KnowledgeDispositionValue } from './value-objects/KnowledgeDisposition.vo.js';
import type { KnowledgeVerificationValue } from './value-objects/KnowledgeVerification.vo.js';
import type { KnowledgeReuseOutcomeValue } from './value-objects/KnowledgeReuseOutcome.vo.js';

/**
 * The escalation a candidate-claim triage attached to an entry: the chosen
 * class was `policy-proposal` or `instruction` at or above the consumer
 * threshold. A flag is write-once, never cleared by a later triage, and an
 * `unknown` triage answer writes none (plan `2026-10-16_decision-kernel-and-claim-triage.md`, §5).
 */
export const KNOWLEDGE_TRIAGE_FLAGS = ['policy-like', 'instruction-like'] as const;

export type KnowledgeTriageFlag = (typeof KNOWLEDGE_TRIAGE_FLAGS)[number];

const KNOWLEDGE_TRIAGE_FLAG_VALUES: readonly string[] = KNOWLEDGE_TRIAGE_FLAGS;

/** True exactly for a declared triage flag value. */
export function isKnowledgeTriageFlag(value: unknown): value is KnowledgeTriageFlag {
  return typeof value === 'string' && KNOWLEDGE_TRIAGE_FLAG_VALUES.includes(value);
}

/**
 * What a stored claim asserts. `fact` is a statement the keeper path may
 * promote, `observed` is a recorded observation, and `failed` is an approach
 * that was tried and disproved. Optional on the record, so entries written
 * before claim kinds existed load unchanged and read as `fact`.
 */
export const KNOWLEDGE_CLAIM_KINDS = ['fact', 'observed', 'failed'] as const;

export type KnowledgeClaimKind = (typeof KNOWLEDGE_CLAIM_KINDS)[number];

const KNOWLEDGE_CLAIM_KIND_VALUES: readonly string[] = KNOWLEDGE_CLAIM_KINDS;

/** True exactly for a declared claim kind value. */
export function isKnowledgeClaimKind(value: unknown): value is KnowledgeClaimKind {
  return typeof value === 'string' && KNOWLEDGE_CLAIM_KIND_VALUES.includes(value);
}

/** The kind an entry without an explicit kind reads as. */
export const DEFAULT_KNOWLEDGE_CLAIM_KIND: KnowledgeClaimKind = 'fact';

/** Hard upper bound for the `claimText` of a `failed` claim, in characters. */
export const MAX_FAILED_CLAIM_TEXT_CHARS = 300;

/** Hard upper bound for a recorded `overrideReason`, in characters. */
export const MAX_OVERRIDE_REASON_CHARS = 1024;

/**
 * One recorded verification of one claim version. Evidence is attributable:
 * a check names the checker, the procedure that ran and where the evidence
 * lives — model confidence is never evidence.
 */
export interface KnowledgeCheckRecord {
  readonly id: string;
  readonly entryId: string;
  readonly checkerId: string;
  readonly procedureName: string;
  readonly verification: KnowledgeVerificationValue;
  readonly evidenceRef: string;
  readonly checkedAtIso: string;
}

/**
 * One recorded reuse of one entry version in an attempt. Inclusion alone is
 * not saved work; `helped` requires demonstrated benefit, `wrong-turn` keeps
 * harmful lessons out of future briefs.
 */
export interface KnowledgeReuseRecord {
  readonly id: string;
  readonly entryId: string;
  readonly version: string;
  readonly attemptId: string;
  readonly outcome: KnowledgeReuseOutcomeValue;
  readonly evidenceRef: string | null;
  readonly recordedAtIso: string;
}

/**
 * Serializable record of one knowledge entry in one version. Capture only
 * proposes candidate claims; only deliberate checks and disposition promote
 * them into reusable context, and accepted keepers always carry source
 * attempt, commit and checker attribution.
 */
export interface KnowledgeEntryRecord {
  readonly id: string;
  readonly version: string;
  readonly projectId: string;
  readonly sourceAttemptId: string;
  readonly sourceCommitSha: string;
  readonly claimText: string;
  /**
   * What this claim asserts. Optional so entries written before claim kinds
   * existed load unchanged; an absent kind reads as `fact`.
   */
  readonly claimKind?: KnowledgeClaimKind;
  readonly pathPrefixes: readonly string[];
  readonly sharedAcrossProjects: boolean;
  readonly disposition: KnowledgeDispositionValue;
  readonly verification: KnowledgeVerificationValue;
  readonly checkerId: string | null;
  readonly dispositionReason: string | null;
  readonly supersededById: string | null;
  /**
   * Triage escalation attached while the entry was an undecided candidate.
   * Optional so records written before triage existed load unchanged; it is
   * write-once and never cleared.
   */
  readonly triageFlag?: KnowledgeTriageFlag;
  /**
   * The checker's recorded justification for accepting a triage-flagged
   * candidate. Refused when it is empty, longer than 1024 characters or
   * credential-shaped — never redacted.
   */
  readonly overrideReason?: string;
  readonly checks: readonly KnowledgeCheckRecord[];
  readonly reuses: readonly KnowledgeReuseRecord[];
  readonly revision: number;
  readonly createdAtIso: string;
  readonly updatedAtIso: string;
}
