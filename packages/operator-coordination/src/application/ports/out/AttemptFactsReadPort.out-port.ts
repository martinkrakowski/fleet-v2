// @generated outbound contract scaffold — refined for CO24f.
/**
 * AttemptFactsReadPort: read the few facts the coordination use cases need
 * about one work attempt — that it exists, which project owns it and at which
 * head it was collected. Known absence is null; an unreadable store is the
 * reader's own error. Nothing here writes attempt state.
 */

/** The facts of one attempt, reduced to what authorization binding checks. */
export interface AttemptFactsRecord {
  readonly attemptId: string;
  /** The project the attempt's work order belongs to; null when it cannot be read. */
  readonly projectId: string | null;
  /** The head the attempt's artifacts were collected at; null when not collected. */
  readonly collectedHeadSha: string | null;
}

export interface AttemptFactsReadPort {
  /** The attempt's facts, or null when no attempt with that id is recorded. */
  findAttemptFactsById(attemptId: string): Promise<AttemptFactsRecord | null>;
}
