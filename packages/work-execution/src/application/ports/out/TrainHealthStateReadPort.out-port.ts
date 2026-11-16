// @generated outbound contract scaffold — refined for lane CO-WD2.
/**
 * TrainHealthStateReadPort: the read-only train-state read for the merge-train
 * health watchdog. It answers one bounded snapshot of the repository's merge
 * train for the use case to evaluate with the pure CO-WD1 rules. Ids and codes
 * only.
 *
 * Contract: `snapshot.queue` holds only this repository's LIVE entries (state
 * not `merged`, `dropped` or `superseded`), ordered oldest `enqueuedAtIso`
 * first and then smaller `pullRequest` first. It may hold more than 500
 * entries. An implementation never answers `unavailable` only because the
 * queue is long: the 500-entry bound is applied by `WatchTrainHealthUseCase`,
 * which keeps the first (oldest) 500 so the head of the train is always
 * assessed.
 */

import type { TrainHealthSnapshot } from '../../../domain/train-health-rules.js';

export interface TrainHealthStateReadRequest {
  readonly repository: { readonly owner: string; readonly repo: string };
  readonly repoDigest: string;
  readonly nowIso: string;
  readonly deadlineIso: string;
}

export type TrainHealthStateReadResult =
  | { readonly outcome: 'ok'; readonly snapshot: TrainHealthSnapshot }
  | { readonly outcome: 'budget-exhausted' }
  | { readonly outcome: 'unavailable'; readonly reasonCode: string };

export interface TrainHealthStateReadPort {
  readTrainHealthState(request: TrainHealthStateReadRequest): Promise<TrainHealthStateReadResult>;
}
