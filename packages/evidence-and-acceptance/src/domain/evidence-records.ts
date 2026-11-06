/**
 * Shared evidence records used by more than one contract. They are pure domain
 * facts, not outbound port behaviour, so they live here rather than in any
 * single port module.
 */

import { assessmentIdForAttempt } from './assessment-id.js';
import type { CheckCoverage } from './check-coverage.js';
import type { EvidenceResultValue } from './value-objects/EvidenceResult.vo.js';
import type { FindingStateValue } from './value-objects/FindingState.vo.js';
import type { AssessmentStateValue } from './value-objects/AssessmentState.vo.js';

/** Serializable record of one completed verification-host check. */
export interface VerificationReceiptRecord {
  readonly id: string;
  readonly assessmentId: string;
  readonly projectId: string;
  readonly attemptId: string;
  readonly candidateHeadSha: string;
  readonly hostId: string;
  readonly procedureName: string;
  readonly result: EvidenceResultValue;
  readonly exitCode: number | null;
  // Optional; records written before V1 have none.
  readonly coverage?: CheckCoverage;
  readonly evidenceRef: string;
  readonly policyRevision: string;
  readonly completedAtIso: string;
}

/** Severity of one reviewer finding. */
export type FindingSeverity = 'blocker' | 'major' | 'minor' | 'nit';

/** The review kinds of the conductor plan §3.3; a receipt without one reads as `code-review` (§3.4). */
export const REVIEW_KINDS = ['brief-check', 'code-review', 'pre-merge'] as const;
export type ReviewKind = (typeof REVIEW_KINDS)[number];

/** What a receipt is about: an attempt at one head, a chain at its integration head, or a brief package at its base commit. */
export const RECEIPT_SUBJECT_KINDS = ['attempt', 'chain', 'brief'] as const;
export type ReceiptSubjectKindValue = (typeof RECEIPT_SUBJECT_KINDS)[number];

/** The versioned receipt subject; the fields of the other kinds are null. */
export interface ReceiptSubject {
  readonly kind: ReceiptSubjectKindValue;
  readonly projectId: string;
  readonly attemptId: string | null;
  readonly chainName: string | null;
  readonly integrationHeadSha: string | null;
  readonly briefPackageDigest: string | null;
  readonly baseCommit: string | null;
}

/** A request id the conductor mints and journals before the review runs (§3.2). */
export const REVIEW_REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/** Serializable record of one finding raised by an independent review. */
export interface ReviewFindingRecord {
  readonly findingId: string;
  readonly severity: FindingSeverity;
  readonly summary: string;
  readonly filePath: string | null;
  readonly line: number | null;
  readonly state: FindingStateValue;
  readonly dispositionReason: string | null;
  readonly dispositionEvidenceRef: string | null;
}

/** Serializable record of one attributable independent review of an exact head. */
export interface ReviewReceiptRecord {
  readonly id: string;
  readonly assessmentId: string;
  readonly projectId: string;
  readonly attemptId: string;
  readonly candidateHeadSha: string;
  readonly reviewerModel: string;
  readonly implementerModel: string;
  readonly readOnlyVerified: boolean;
  readonly result: EvidenceResultValue;
  readonly findings: readonly ReviewFindingRecord[];
  readonly evidenceRef: string;
  readonly policyRevision: string;
  readonly completedAtIso: string;
  /** The review kind (§3.3); absent on receipts recorded before the conductor, read as `code-review`. */
  readonly kind?: ReviewKind;
  /** The conductor's request id (§3.5); absent on manual reviews. */
  readonly requestId?: string;
  /** What the receipt is about; absent on receipts recorded before subjects, read as the attempt (`receiptSubjectOf`). */
  readonly subject?: ReceiptSubject;
}

/** Serializable record of one fix or evidence-backed refutation of a finding. */
export interface FindingDispositionRecord {
  readonly id: string;
  readonly assessmentId: string;
  readonly findingId: string;
  readonly candidateHeadSha: string;
  readonly state: FindingStateValue;
  readonly reason: string;
  readonly evidenceRef: string;
  readonly recordedBy: string;
  readonly recordedAtIso: string;
}

/**
 * Serializable aggregate record of one acceptance assessment with its child
 * receipts, dispositions and derived blockers.
 */
export interface EvidenceAssessmentRecord {
  readonly id: string;
  readonly projectId: string;
  readonly attemptId: string;
  readonly candidateHeadSha: string;
  readonly policyRevision: string;
  /**
   * The implementer seat the assessment's attempt was dispatched on, recorded
   * at assessment creation from the attempt itself. It is the independence
   * reference every review receipt is checked against.
   */
  readonly implementerModel: string;
  /**
   * The reviewer the last request-review named; a recorded review receipt must
   * name the same model. Absent when no review was requested.
   */
  readonly requestedReviewerModel?: string;
  readonly requiredChecks: readonly string[];
  readonly state: AssessmentStateValue;
  /**
   * Forge evidence state recorded at acceptance time (D6). `not-configured`
   * is a distinct value, legal only when the installation's forge mode is
   * `none`; it is never `unknown` and never satisfies a CI-state requirement.
   */
  readonly forgeEvidence?: 'not-configured';
  readonly verificationReceipts: readonly VerificationReceiptRecord[];
  readonly reviewReceipts: readonly ReviewReceiptRecord[];
  readonly findingDispositions: readonly FindingDispositionRecord[];
  readonly acceptanceReceiptId: string | null;
  readonly blockers: readonly string[];
  readonly revision: number;
  readonly updatedAtIso: string;
}

/** The pseudo attempt id a chain's assessment is bound to; never a path. */
export function attemptIdForChain(projectId: string, chainName: string): string {
  return `chain:${projectId}:${chainName}`;
}

/** Deterministic id of the assessment one chain's combined review binds to: project id and chain name only. */
export function assessmentIdForChain(projectId: string, chainName: string): string {
  return assessmentIdForAttempt(attemptIdForChain(projectId, chainName));
}

function ownValue(source: unknown, key: string): unknown {
  try {
    if (typeof source !== 'object' || source === null) {
      return undefined;
    }
    return Object.getOwnPropertyDescriptor(source, key)?.value;
  } catch {
    return undefined;
  }
}

function nonEmptyOrNull(value: unknown): string | null | undefined {
  if (value === null || value === undefined) {
    return null;
  }
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

/**
 * Exactly the fields of the subject's own kind are set: a field of another kind
 * is never tolerated. An unlisted kind reads as the third (brief) shape.
 */
function hasExactlyKindFields(
  kind: string,
  fields: {
    readonly attemptId: string | null;
    readonly chainName: string | null;
    readonly integrationHeadSha: string | null;
    readonly briefPackageDigest: string | null;
    readonly baseCommit: string | null;
  },
): boolean {
  const { attemptId, chainName, integrationHeadSha, briefPackageDigest, baseCommit } = fields;
  if (kind === 'attempt') {
    return attemptId !== null && chainName === null && integrationHeadSha === null && briefPackageDigest === null && baseCommit === null;
  }
  if (kind === 'chain') {
    return chainName !== null && integrationHeadSha !== null && attemptId === null && briefPackageDigest === null && baseCommit === null;
  }
  return briefPackageDigest !== null && baseCommit !== null && attemptId === null && chainName === null && integrationHeadSha === null;
}

/**
 * The subject of a stored receipt, read through own data properties only (no
 * getter runs). A receipt recorded without a subject reads as an attempt
 * subject. A stored subject of an unknown kind, or one missing the fields of its
 * kind, is `null`: an unknown subject is never a pass. Never throws.
 */
export function receiptSubjectOf(record: {
  readonly subject?: unknown;
  readonly projectId?: unknown;
  readonly attemptId?: unknown;
}): ReceiptSubject | null {
  try {
    const descriptor =
      typeof record === 'object' && record !== null ? Object.getOwnPropertyDescriptor(record, 'subject') : undefined;
    // A subject that is present but not a plain data value (an accessor) is unreadable, not absent.
    if (descriptor !== undefined && !('value' in descriptor)) {
      return null;
    }
    const stored = descriptor?.value;
    if (stored === undefined) {
      const projectId = ownValue(record, 'projectId');
      const attemptId = ownValue(record, 'attemptId');
      if (typeof projectId !== 'string' || typeof attemptId !== 'string') {
        return null;
      }
      return {
        kind: 'attempt', projectId, attemptId, chainName: null, integrationHeadSha: null,
        briefPackageDigest: null, baseCommit: null,
      };
    }
    const kind = ownValue(stored, 'kind');
    const projectId = ownValue(stored, 'projectId');
    if (
      typeof kind !== 'string' ||
      !(RECEIPT_SUBJECT_KINDS as readonly string[]).includes(kind) ||
      typeof projectId !== 'string' ||
      projectId.trim().length === 0
    ) {
      return null;
    }
    const attemptId = nonEmptyOrNull(ownValue(stored, 'attemptId'));
    const chainName = nonEmptyOrNull(ownValue(stored, 'chainName'));
    const integrationHeadSha = nonEmptyOrNull(ownValue(stored, 'integrationHeadSha'));
    const briefPackageDigest = nonEmptyOrNull(ownValue(stored, 'briefPackageDigest'));
    const baseCommit = nonEmptyOrNull(ownValue(stored, 'baseCommit'));
    if (
      attemptId === undefined || chainName === undefined || integrationHeadSha === undefined ||
      briefPackageDigest === undefined || baseCommit === undefined
    ) {
      return null;
    }
    // Exactly the fields of the subject's own kind are set: a field of another kind is never tolerated.
    const complete = hasExactlyKindFields(kind, {
      attemptId, chainName, integrationHeadSha, briefPackageDigest, baseCommit,
    });
    if (!complete) {
      return null;
    }
    return {
      kind: kind as ReceiptSubjectKindValue, projectId, attemptId, chainName, integrationHeadSha,
      briefPackageDigest, baseCommit,
    };
  } catch {
    return null;
  }
}
