// Decision kernel (lane K1): the common decision-call receipt envelope.
// Pure: no I/O, no dependencies, no `node:` imports.
//
// `consumer` is a plain string discriminator; the consumer-specific variants
// (brief-knowledge owns `knowledge-ranking` and `claim-triage`) live with
// their consumers, so a new consumer never edits shared.

import type { QuestionKind } from './types.js';

/** The common fields every decision-call receipt carries. */
export interface DecisionCallReceipt {
  /** Consumer discriminator, e.g. `knowledge-ranking` or `claim-triage`. */
  readonly consumer: string;
  /** Fixed per-consumer reference, e.g. `ranking:<laneId>:<sha256>`. */
  readonly contextRef: string;
  readonly provider: string;
  readonly model: string;
  readonly requestId?: string;
  readonly costUsd?: number;
  /** True when the call carried an assumed cost, not a reported one. */
  readonly estimated: boolean;
  readonly questionKinds: readonly QuestionKind[];
  /** Lowest per-answer confidence accepted, when any answer was accepted. */
  readonly minConfidenceObserved?: number;
  /** Set when the decision outcome was `unknown` and only then. */
  readonly unknownReason?: string;
  readonly latencyMs: number;
  /** When the call was made, ISO 8601. */
  readonly at: string;
}
