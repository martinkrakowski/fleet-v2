/**
 * Shared execution records used by more than one contract. They are pure
 * domain facts, not outbound port behaviour, so they live here rather than in
 * any single port module.
 */

import type { WorkOrderStateValue } from './value-objects/WorkOrderState.vo.js';
import type { AttemptStateValue } from './value-objects/AttemptState.vo.js';
import type { AttemptOutcomeValue } from './value-objects/AttemptOutcome.vo.js';

/**
 * Completion receipt bound to the attempt and the runner session. A runner
 * `Running` task is not evidence a lane is working or succeeded; a watcher
 * exit or a model's final message never establishes authoritative completion.
 */
export interface CommandCompletionReceipt {
  readonly attemptId: string;
  readonly sessionId: string;
  readonly endedAtIso: string;
  readonly authoritative: boolean;
  readonly exitStatus: number | null;
  readonly stoppedByRequest: boolean;
}

export interface CollectedAttemptArtifacts {
  readonly headCommit: string;
  readonly commitsSinceBase: readonly string[];
  readonly collectedArtifactPaths: readonly string[];
  /** Missing notes are recorded explicitly; absence is a fact, not an error. */
  readonly notes: 'present' | 'missing';
}

/** Serializable record of one registered, approved bounded work unit. */
export interface WorkOrderRecord {
  readonly id: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly laneId: string;
  readonly repository: string;
  readonly baseCommit: string;
  readonly ownedPaths: readonly string[];
  readonly policyRevision: string;
  readonly prerequisiteWorkOrderIds: readonly string[];
  readonly state: WorkOrderStateValue;
  readonly revision: number;
  readonly createdAtIso: string;
  readonly updatedAtIso: string;
}

/** Fix rounds are fresh attempts; they never resume the prior conversation. */
export type AttemptKind = 'initial' | 'fix';

/** Runner session details recorded at dispatch time for port and host fidelity. */
export interface AttemptRunnerRecord {
  readonly remotePort: number;
  readonly host: string | null;
  readonly agent: string | null;
  readonly model: string | null;
  readonly variant: string | null;
}

/** Scoped operator seat override accepted at dispatch. */
export interface AttemptSeatOverrideRecord {
  readonly model: string;
  readonly agent?: string;
  readonly variant?: string;
  readonly reason: string;
  readonly setBy: string;
  readonly expiresAtIso: string;
}

/**
 * Strip provider prefix and variant suffix, returning the underlying model name/family
 * for independent review and override separation checks.
 */
export function underlyingModelFamily(model: string): string {
  const withoutVariant = model.split(/[#:]/)[0].trim().toLowerCase();
  const segments = withoutVariant.split('/').filter((s) => s.length > 0);
  if (segments.length === 0) return withoutVariant;
  return segments[segments.length - 1];
}

/** Serializable record of one dispatch or one fresh fix session. */
export interface AttemptRecord {
  readonly id: string;
  readonly workOrderId: string;
  readonly kind: AttemptKind;
  readonly fixNumber: number;
  readonly priorAttemptId: string | null;
  readonly worktreePath: string;
  readonly baseCommit: string;
  readonly state: AttemptStateValue;
  readonly outcome: AttemptOutcomeValue | null;
  readonly briefDigest: string | null;
  readonly briefPackagePath: string | null;
  readonly sessionId: string | null;
  readonly completionReceipt: CommandCompletionReceipt | null;
  readonly artifacts: CollectedAttemptArtifacts | null;
  readonly runner?: AttemptRunnerRecord | null;
  readonly seatOverride?: AttemptSeatOverrideRecord | null;
  readonly reviewerSeat?: string | null;
  readonly createdAtIso: string;
  readonly updatedAtIso: string;
}

/** One physical slot held for one attempt until the attempt ends. */
export interface CapacityReservationRecord {
  readonly id: string;
  readonly attemptId: string;
  readonly hostId: string;
  readonly slotIndex: number;
  readonly held: boolean;
  readonly reservedAtIso: string;
  readonly releasedAtIso: string | null;
}

/** Journal entry: intent is durable before the subprocess runs. */
export interface ActionJournalEntryRecord {
  readonly id: string;
  readonly attemptId: string;
  readonly workOrderId: string;
  readonly action: 'dispatch' | 'reconcile' | 'stop' | 'collect' | 'forge';
  readonly baseCommit: string;
  readonly recordedAtIso: string;
  readonly status: 'intent-recorded' | 'completed' | 'ambiguous' | 'refused';
  readonly sessionId: string | null;
  readonly detail: string | null;
}
