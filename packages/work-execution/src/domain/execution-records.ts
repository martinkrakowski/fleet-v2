/**
 * Shared execution records used by more than one contract. They are pure
 * domain facts, not outbound port behaviour, so they live here rather than in
 * any single port module.
 */

import type { WorkOrderStateValue } from './value-objects/WorkOrderState.vo.js';
import type { AttemptStateValue } from './value-objects/AttemptState.vo.js';
import type { AttemptOutcomeValue } from './value-objects/AttemptOutcome.vo.js';
import type { StopReasonValue } from './value-objects/StopReason.vo.js';
import type { SeatPlanProps, SeatPlanRole } from './value-objects/SeatPlan.vo.js';

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
  /**
   * Worktree-relative path of the sealed content-addressed artifact manifest
   * (`.lane/artifacts-manifest-<first 16 hex>.json`). Absent on records
   * collected before C1 (or before content-addressed manifests) or by a port
   * that does not seal; for C2, older records that lack `manifestPath` are
   * read as "artifacts not collected".
   */
  readonly manifestPath?: string;
  /**
   * SHA-256 of the sealed artifact manifest text (C1). Absent on records
   * collected before C1 or by a port that does not seal; a caller that needs
   * a sealed manifest treats absence of `manifestSha256` or `manifestPath`
   * as not collected.
   */
  readonly manifestSha256?: string;
}

/**
 * The plan lane a work order was registered from (work-board plan §3.2, review decision 7).
 * `projectId` always equals the work order's own `projectId`; ids repeat across plans, so a
 * lane is never matched by `laneId` text alone. Set only at registration.
 */
export interface PlanRef {
  readonly projectId: string;
  readonly planId: string;
  readonly laneId: string;
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
  /** Absent on a work order with no plan and on every record written before the field existed. */
  readonly planRef?: PlanRef;
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
  /**
   * The installation's policy.useFreeSeats as the dispatch seat check saw it
   * (F7). Absent when no check was wired and on records written before the
   * field existed.
   */
  readonly useFreeSeats?: boolean;
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
 * Usage measurement for one attempt's opencode session (S3). `costUsd` is
 * what opencode recorded: a free seat records 0 and an unreadable value is
 * `null`, never 0. When `source` is `'unavailable'`, every measurement field
 * is `null` and `reason` names why.
 */
export interface AttemptUsageRecord {
  readonly source: 'opencode-db' | 'unavailable';
  readonly readAtIso: string;
  readonly sessionId: string | null;
  readonly steps: number | null;
  readonly wallSeconds: number | null;
  readonly tokensInput: number | null;
  readonly tokensOutput: number | null;
  readonly tokensReasoning: number | null;
  readonly tokensCacheRead: number | null;
  readonly tokensCacheWrite: number | null;
  readonly costUsd: number | null;
  readonly model: string | null;
  readonly agent: string | null;
  readonly reason: string | null;
}

/**
 * The seat-plan entry an attempt was bound to (S1). `model`, `tool`,
 * `variant` and `agent` copy the plan entry; what actually ran is
 * `runner`, which an operator seat override may differ from.
 */
export interface AttemptSeatSelectionRecord {
  readonly role: SeatPlanRole;
  readonly seatIndex: number;
  readonly seatId: string;
  readonly model: string;
  readonly tool: string | null;
  readonly variant: string | null;
  readonly agent: string | null;
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
  /** Optimistic-concurrency revision; absent reads as 0 (legacy records). */
  readonly revision?: number;
  /** Revision of the dispatching save that began this dispatch; a re-dispatch sets a new one, metadata-only writes (usage) keep it. Absent on legacy records. */
  readonly dispatchRevision?: number;
  readonly outcome: AttemptOutcomeValue | null;
  readonly briefDigest: string | null;
  readonly briefPackagePath: string | null;
  readonly sessionId: string | null;
  readonly completionReceipt: CommandCompletionReceipt | null;
  readonly artifacts: CollectedAttemptArtifacts | null;
  readonly runner?: AttemptRunnerRecord | null;
  readonly seatOverride?: AttemptSeatOverrideRecord | null;
  /**
   * Usage of the attempt's opencode session (S3), read from opencode's own
   * database on the recorded runner host. Absent on records written before
   * S3 means "not measured", which is not the same as `source:
   * 'unavailable'`.
   */
  readonly usage?: AttemptUsageRecord | null;
  /**
   * Why the attempt stopped (S1). Absent on records written before the
   * field existed; `stopReasonOf` reads that as `unknown`.
   */
  readonly stopReason?: StopReasonValue;
  /** The frozen seat plan of the attempt's lane (S1); absent means no plan (D1). */
  readonly seatPlan?: SeatPlanProps | null;
  /** The plan entry this attempt was bound to (S1); absent when there is no plan. */
  readonly seatSelection?: AttemptSeatSelectionRecord | null;
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
  /**
   * The lane-runner host the capacity is reserved on (H9a1). Records
   * persisted before these fields existed are read with all of them
   * `null`; a `null` hostName is never defaulted to the current
   * installation's lane-runner host.
   */
  readonly hostName?: string | null;
  readonly hostKind?: RunnerKind | null;
  readonly transport?: 'local' | 'ssh' | null;
  readonly sshAlias?: string | null;
  readonly port?: number | null;
  /**
   * The worktree path the reservation claims (H9a2). Records persisted
   * before the field existed read with `null`; a `null` path never blocks a
   * busy-worktree check.
   */
  readonly worktreePath?: string | null;
  readonly reservedAtIso: string;
  readonly releasedAtIso: string | null;
}

/** Journal entry: intent is durable before the subprocess runs. */
export interface ActionJournalEntryRecord {
  readonly id: string;
  readonly attemptId: string;
  readonly workOrderId: string;
  readonly action: 'dispatch' | 'reconcile' | 'stop' | 'collect' | 'forge' | 'accept';
  readonly baseCommit: string;
  readonly recordedAtIso: string;
  readonly status: 'intent-recorded' | 'completed' | 'ambiguous' | 'refused';
  readonly sessionId: string | null;
  readonly detail: string | null;
  /** The typed stop reason of a refused or ended action (S1); absent on other entries. */
  readonly stopReason?: StopReasonValue;
  /**
   * Session ids seen running in the worktree when this entry was written;
   * evidence only, never proof of ownership.
   */
  readonly observedSessionIds?: readonly string[];
}
