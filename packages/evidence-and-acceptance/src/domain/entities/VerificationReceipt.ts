// @generated entity stub — refined for step 4.
/**
 * VerificationReceipt is a child entity of the EvidenceAssessment aggregate.
 * It binds one completed check to its exact head, host, procedure, exit
 * result, evidence reference and acceptance-policy revision. A launched check
 * is not a completed one: completion requires a recorded result.
 */

import type { VerificationReceiptRecord } from '../evidence-records.js';
import type { EvidenceResultValue } from '../value-objects/EvidenceResult.vo.js';
import { EVIDENCE_RESULTS } from '../value-objects/EvidenceResult.vo.js';

export interface VerificationReceiptProps {
  readonly id: string;
  readonly assessmentId: string;
  readonly projectId: string;
  readonly attemptId: string;
  readonly candidateHeadSha: string;
  readonly hostId: string;
  readonly procedureName: string;
  readonly result: EvidenceResultValue;
  readonly exitCode: number | null;
  readonly evidenceRef: string;
  readonly policyRevision: string;
  readonly completedAtIso: string;
}

function isNonEmptyTrimmedString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export class VerificationReceipt {
  private constructor(private readonly props: VerificationReceiptProps) {
    // Invariants are validated in create.
  }

  static create(props: VerificationReceiptProps): {
    success: boolean;
    value?: VerificationReceipt;
    error?: Error;
  } {
    if (
      !isNonEmptyTrimmedString(props.id) ||
      !isNonEmptyTrimmedString(props.assessmentId) ||
      !isNonEmptyTrimmedString(props.projectId) ||
      !isNonEmptyTrimmedString(props.attemptId) ||
      !isNonEmptyTrimmedString(props.candidateHeadSha) ||
      !isNonEmptyTrimmedString(props.hostId) ||
      !isNonEmptyTrimmedString(props.procedureName) ||
      !isNonEmptyTrimmedString(props.evidenceRef) ||
      !isNonEmptyTrimmedString(props.policyRevision) ||
      !isNonEmptyTrimmedString(props.completedAtIso)
    ) {
      return {
        success: false,
        error: new Error(
          'VerificationReceipt requires non-empty id, assessmentId, projectId, attemptId, candidateHeadSha, hostId, procedureName, evidenceRef, policyRevision and completedAtIso',
        ),
      };
    }
    if (typeof props.result !== 'string' || !EVIDENCE_RESULTS.includes(props.result)) {
      return {
        success: false,
        error: new Error(`VerificationReceipt has an invalid result: ${String(props.result)}`),
      };
    }
    if (props.exitCode !== null && !Number.isInteger(props.exitCode)) {
      return {
        success: false,
        error: new Error('VerificationReceipt exitCode must be an integer or null'),
      };
    }
    return {
      success: true,
      value: new VerificationReceipt({ ...props }),
    };
  }

  static fromRecord(record: VerificationReceiptRecord): VerificationReceipt {
    const created = VerificationReceipt.create(record);
    if (!created.success || created.value === undefined) {
      throw new Error(created.error?.message ?? 'Invalid VerificationReceipt record');
    }
    return created.value;
  }

  getId(): string {
    return this.props.id;
  }

  getAssessmentId(): string {
    return this.props.assessmentId;
  }

  getCandidateHeadSha(): string {
    return this.props.candidateHeadSha;
  }

  getHostId(): string {
    return this.props.hostId;
  }

  getProcedureName(): string {
    return this.props.procedureName;
  }

  getResult(): EvidenceResultValue {
    return this.props.result;
  }

  /** A receipt only proves the head it was produced for. */
  matchesHead(candidateHeadSha: string): boolean {
    return this.props.candidateHeadSha === candidateHeadSha;
  }

  getProps(): VerificationReceiptProps {
    return this.props;
  }

  toRecord(): VerificationReceiptRecord {
    return { ...this.props };
  }
}
