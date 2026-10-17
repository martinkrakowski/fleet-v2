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

/** The lane runner tool that executed the attempt's worker command. */
export type RunnerKind = 'opencode' | 'agy';

/**
 * Parse a seat tool value into a declared `RunnerKind`. Only the declared
 * kinds are accepted: a blank, unknown, wrong-case or non-string value yields
 * `undefined`, never a default to opencode. Callers decide what an absent
 * tool means; this function only classifies the value it is given.
 */
export function parseSeatTool(value: unknown): RunnerKind | undefined {
  return value === 'opencode' || value === 'agy' ? value : undefined;
}

/** Runner session details recorded at dispatch time for port and host fidelity. */
export interface AttemptRunnerRecord {
  /**
   * The runner tool (D7). Records persisted before this field existed were
   * opencode runs; the record repository reads them as `'opencode'`.
   */
  readonly kind: RunnerKind;
  /** The opencode tunnel port. `null` for agy runs, which have no port. */
  readonly remotePort: number | null;
  readonly host: string | null;
  /**
   * The installation host name the attempt ran on. The composition roots pass
   * the installation's selected lane-runner host, so a v2 installation
   * records that host's name; legacy mode (a v1 or absent installation)
   * records `null`, as do records persisted before this field existed —
   * those are read with `runner.host`, which holds the alias.
   */
  readonly hostName?: string | null;
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
  /**
   * Owner decision references the product froze into the brief package, read
   * from that frozen package at dispatch and never from a worktree file at
   * acceptance time. An absent field on records written before dispatch
   * recorded it is read as unknown, which blocks acceptance; it is not an empty
   * list and never a caller-supplied one.
   */
  readonly ownerDecisionReferences?: readonly string[];
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
  /**
   * The seat tool the reservation was made for. Records persisted before
   * this field existed are read with `null`; it is never defaulted to a
   * declared kind.
   */
  readonly seatTool: RunnerKind | null;
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
