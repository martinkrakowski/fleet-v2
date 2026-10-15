// @generated value-object stub — refined for step 5.
/**
 * ObservationEnvelope is an immutable value object carrying one external
 * observation summary: what was observed, which project owns it, the attempt it
 * came from when known, and when it was recorded. A payload summary is a fact,
 * never authority or an instruction.
 */

export interface ObservationEnvelopeProps {
  readonly observationId: string;
  readonly projectId: string;
  readonly eventKind: string;
  readonly sourceAttemptId: string | null;
  readonly payloadSummary: string;
  readonly recordedAtIso: string;
}

const REQUIRED_STRING_FIELDS = [
  'observationId',
  'projectId',
  'eventKind',
  'payloadSummary',
  'recordedAtIso',
] as const;

export class ObservationEnvelope {
  private constructor(private readonly props: ObservationEnvelopeProps) {
    // Value is immutable after construction.
  }

  static create(
    props: unknown,
  ): { success: boolean; value?: ObservationEnvelope; error?: Error } {
    if (typeof props !== 'object' || props === null) {
      return { success: false, error: new Error('ObservationEnvelope requires props') };
    }
    const candidate = props as Partial<ObservationEnvelopeProps>;
    for (const field of REQUIRED_STRING_FIELDS) {
      const value = candidate[field];
      if (typeof value !== 'string' || value.trim().length === 0) {
        return {
          success: false,
          error: new Error(`ObservationEnvelope requires a non-empty ${field}`),
        };
      }
    }
    if (candidate.sourceAttemptId !== null && typeof candidate.sourceAttemptId !== 'string') {
      return {
        success: false,
        error: new Error('ObservationEnvelope requires a string or null sourceAttemptId'),
      };
    }
    return {
      success: true,
      value: new ObservationEnvelope({
        observationId: candidate.observationId as string,
        projectId: candidate.projectId as string,
        eventKind: candidate.eventKind as string,
        sourceAttemptId: candidate.sourceAttemptId ?? null,
        payloadSummary: candidate.payloadSummary as string,
        recordedAtIso: candidate.recordedAtIso as string,
      }),
    };
  }

  getProps(): ObservationEnvelopeProps {
    return { ...this.props };
  }

  getObservationId(): string {
    return this.props.observationId;
  }

  /** An unknown source attempt is recorded as unknown, never inferred. */
  hasSourceAttempt(): boolean {
    return this.props.sourceAttemptId !== null;
  }

  equals(other: ObservationEnvelope): boolean {
    return (
      this.props.observationId === other.props.observationId &&
      this.props.projectId === other.props.projectId &&
      this.props.eventKind === other.props.eventKind &&
      this.props.sourceAttemptId === other.props.sourceAttemptId &&
      this.props.payloadSummary === other.props.payloadSummary &&
      this.props.recordedAtIso === other.props.recordedAtIso
    );
  }
}
