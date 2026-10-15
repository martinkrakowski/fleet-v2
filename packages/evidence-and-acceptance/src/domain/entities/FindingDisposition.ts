// @generated entity stub — refined for step 4.
/**
 * FindingDisposition is a child entity of the EvidenceAssessment aggregate.
 * It records a fix or an evidence-backed refutation of a specific finding
 * while preserving unresolved findings elsewhere in the assessment.
 */

import type { FindingDispositionRecord } from '../evidence-records.js';
import type { FindingStateValue } from '../value-objects/FindingState.vo.js';
import { FindingState } from '../value-objects/FindingState.vo.js';

export interface FindingDispositionProps {
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

function isNonEmptyTrimmedString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export class FindingDisposition {
  private constructor(private readonly props: FindingDispositionProps) {
    // Invariants are validated in create.
  }

  static create(props: FindingDispositionProps): {
    success: boolean;
    value?: FindingDisposition;
    error?: Error;
  } {
    if (
      !isNonEmptyTrimmedString(props.id) ||
      !isNonEmptyTrimmedString(props.assessmentId) ||
      !isNonEmptyTrimmedString(props.findingId) ||
      !isNonEmptyTrimmedString(props.candidateHeadSha) ||
      !isNonEmptyTrimmedString(props.reason) ||
      !isNonEmptyTrimmedString(props.evidenceRef) ||
      !isNonEmptyTrimmedString(props.recordedBy) ||
      !isNonEmptyTrimmedString(props.recordedAtIso)
    ) {
      return {
        success: false,
        error: new Error(
          'FindingDisposition requires non-empty id, assessmentId, findingId, candidateHeadSha, reason, evidenceRef, recordedBy and recordedAtIso',
        ),
      };
    }
    const state = FindingState.create(props.state);
    if (!state.success || state.value === undefined) {
      return {
        success: false,
        error: state.error ?? new Error(`Invalid finding state: ${String(props.state)}`),
      };
    }
    return {
      success: true,
      value: new FindingDisposition({ ...props }),
    };
  }

  static fromRecord(record: FindingDispositionRecord): FindingDisposition {
    const created = FindingDisposition.create(record);
    if (!created.success || created.value === undefined) {
      throw new Error(created.error?.message ?? 'Invalid FindingDisposition record');
    }
    return created.value;
  }

  getId(): string {
    return this.props.id;
  }

  getAssessmentId(): string {
    return this.props.assessmentId;
  }

  getFindingId(): string {
    return this.props.findingId;
  }

  getCandidateHeadSha(): string {
    return this.props.candidateHeadSha;
  }

  getState(): FindingStateValue {
    return this.props.state;
  }

  /** A disposition only applies to the exact head it was recorded for. */
  matchesHead(candidateHeadSha: string): boolean {
    return this.props.candidateHeadSha === candidateHeadSha;
  }

  getProps(): FindingDispositionProps {
    return this.props;
  }

  toRecord(): FindingDispositionRecord {
    return { ...this.props };
  }
}
