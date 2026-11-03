// @generated outbound contract scaffold — refined for lane WB4c.
/**
 * DeclarationRepositoryPort stores lane declarations (work-board plan §3.5).
 * The store keeps every declaration — the board, not the store, judges lapse
 * — and each append is a compare-and-swap on the whole list under the
 * store's exclusive lock.
 */
import type { LaneDeclarationRecord } from '../../../domain/lane-activity-records.js';

export type AppendDeclarationResult =
  | { readonly outcome: 'saved'; readonly revision: number }
  | { readonly outcome: 'refused'; readonly reason: string };

export interface DeclarationRepositoryPort {
  /** Every stored declaration, oldest first. */
  list(): Promise<readonly LaneDeclarationRecord[]>;
  /** Append one already-valid record; never truncates and never deletes. */
  append(record: LaneDeclarationRecord): Promise<AppendDeclarationResult>;
}
