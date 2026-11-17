// @generated inbound contract scaffold — refined for lane CO-WD2.
/**
 * WatchTrainHealthPort: one bounded merge-train health watch pass. An
 * unreadable or unevaluable state is reported as blind and never as healthy,
 * nothing is cleared on unknown, and a cut finding list or a queue over 500
 * entries raises its own attention item.
 *
 * Announcement counters, on `evaluated` and `blind` only. `announced` is how
 * many sentences the alert port spoke. `announceFailures` is how many speak
 * attempts did not come back `spoken`, plus each success raise whose
 * `previousRaisedAtIso` was neither null nor a zoned ISO string: that target
 * is not spoken. `announceSuppressed` is the announcement decision's own
 * suppressed count: due targets that were not given a sentence.
 * `announceUnspoken` is sentences that decision produced which this pass did
 * not start because the call budget ran out. A speech failure is
 * `announceFailures`, never either of the other two, and so is an unusable
 * `previousRaisedAtIso`. A missing alert port reports all four as 0. Ids and
 * codes only.
 */
import type { TrainHealthFinding, TrainHealthThresholds } from '../../../domain/train-health-rules.js';

export interface WatchTrainHealthRequest {
  readonly projectId: string;
  readonly repository: { readonly owner: string; readonly repo: string };
  readonly repoDigest: string;
  readonly deadlineIso: string;
  readonly thresholds?: TrainHealthThresholds;
}

export type WatchTrainHealthRefusalReason = 'invalid-request' | 'invalid-clock' | 'invalid-deadline';

export type WatchTrainHealthResult =
  | {
      readonly outcome: 'evaluated';
      readonly exitCode: 0 | 1;
      readonly healthy: boolean;
      readonly findings: readonly TrainHealthFinding[];
      readonly unknownForgeStates: number;
      readonly truncated: boolean;
      readonly queueOverflow: boolean;
      readonly raised: number;
      readonly cleared: number;
      readonly attentionFailures: number;
      readonly budgetExhausted: boolean;
      readonly announced: number;
      readonly announceFailures: number;
      readonly announceSuppressed: number;
      readonly announceUnspoken: number;
    }
  | {
      readonly outcome: 'blind';
      readonly exitCode: 1;
      readonly reasonCode: string;
      readonly findings: readonly TrainHealthFinding[];
      readonly raised: number;
      readonly attentionFailures: number;
      readonly announced: number;
      readonly announceFailures: number;
      readonly announceSuppressed: number;
      readonly announceUnspoken: number;
    }
  | { readonly outcome: 'budget-exhausted'; readonly exitCode: 1 }
  | {
      readonly outcome: 'refused';
      readonly exitCode: 1;
      readonly reasonCode: WatchTrainHealthRefusalReason;
    };

export interface WatchTrainHealthPort {
  watchTrainHealth(request: WatchTrainHealthRequest): Promise<WatchTrainHealthResult>;
}
