// Pure projection functions for the read tools (MX2-1; plan §3.7). Each
// function reads a /v1 use-case result (or one record inside it) defensively
// and returns an allow-list projection: every field not listed is dropped.
// A value of the wrong type is never coerced — it becomes null, or the entry
// is omitted from a list. These functions never throw and never touch the
// network, the filesystem or the process.

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

function asBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === "string");
}

export interface AttemptSeatProjection {
  readonly seatId: string | null;
  readonly role: string | null;
  readonly seatIndex: number | null;
  readonly model: string | null;
  readonly tool: string | null;
  readonly variant: string | null;
  readonly agent: string | null;
}

export interface AttemptRunnerProjection {
  readonly kind: string | null;
  readonly model: string | null;
  readonly variant: string | null;
  readonly agent: string | null;
}

export interface AttemptUsageProjection {
  readonly source: string | null;
  readonly steps: number | null;
  readonly wallSeconds: number | null;
  readonly tokensInput: number | null;
  readonly tokensOutput: number | null;
  readonly tokensReasoning: number | null;
  readonly tokensCacheRead: number | null;
  readonly tokensCacheWrite: number | null;
  readonly costUsd: number | null;
  readonly model: string | null;
}

export interface AttemptProjection {
  readonly id: string | null;
  readonly workOrderId: string | null;
  readonly kind: string | null;
  readonly fixNumber: number | null;
  readonly priorAttemptId: string | null;
  readonly state: string | null;
  readonly outcome: string | null;
  readonly stopReason: string | null;
  readonly baseCommit: string | null;
  readonly createdAtIso: string | null;
  readonly updatedAtIso: string | null;
  readonly seat: AttemptSeatProjection | null;
  readonly runner: AttemptRunnerProjection | null;
  readonly usage: AttemptUsageProjection | null;
}

/** Project one attempt record. Dropped: worktree, brief, receipt, artifacts, runner host/port/hostName, seat override, usage reason/sessionId, seat plan, reviewer, owner references. */
export function projectAttempt(value: unknown): AttemptProjection {
  const record = asRecord(value);
  const seatSelection = asRecord(record?.seatSelection);
  const runner = asRecord(record?.runner);
  const usage = asRecord(record?.usage);
  return {
    id: asString(record?.id),
    workOrderId: asString(record?.workOrderId),
    kind: asString(record?.kind),
    fixNumber: asNumber(record?.fixNumber),
    priorAttemptId: asString(record?.priorAttemptId),
    state: asString(record?.state),
    outcome: asString(record?.outcome),
    stopReason: asString(record?.stopReason),
    baseCommit: asString(record?.baseCommit),
    createdAtIso: asString(record?.createdAtIso),
    updatedAtIso: asString(record?.updatedAtIso),
    seat: seatSelection
      ? {
          seatId: asString(seatSelection.seatId),
          role: asString(seatSelection.role),
          seatIndex: asNumber(seatSelection.seatIndex),
          model: asString(seatSelection.model),
          tool: asString(seatSelection.tool),
          variant: asString(seatSelection.variant),
          agent: asString(seatSelection.agent),
        }
      : null,
    runner: runner
      ? {
          kind: asString(runner.kind),
          model: asString(runner.model),
          variant: asString(runner.variant),
          agent: asString(runner.agent),
        }
      : null,
    usage: usage
      ? {
          source: asString(usage.source),
          steps: asNumber(usage.steps),
          wallSeconds: asNumber(usage.wallSeconds),
          tokensInput: asNumber(usage.tokensInput),
          tokensOutput: asNumber(usage.tokensOutput),
          tokensReasoning: asNumber(usage.tokensReasoning),
          tokensCacheRead: asNumber(usage.tokensCacheRead),
          tokensCacheWrite: asNumber(usage.tokensCacheWrite),
          costUsd: asNumber(usage.costUsd),
          model: asString(usage.model),
        }
      : null,
  };
}

export interface AttemptListItemProjection {
  readonly attempt: AttemptProjection;
  readonly workOrder: {
    readonly id: string | null;
    readonly projectId: string | null;
    readonly taskId: string | null;
    readonly laneId: string | null;
  } | null;
  readonly reservation: {
    readonly slotIndex: number | null;
    readonly held: true;
  } | null;
}

export type AttemptListProjection =
  | {
      readonly outcome: "listed";
      readonly total: number | null;
      readonly truncated: boolean | null;
      readonly attempts: AttemptListItemProjection[];
    }
  | { readonly outcome: string };

/** Project the attempts-list result. Dropped: reservation hostId/hostName, work-order repository/ownedPaths, any reason. */
export function projectAttemptList(result: unknown): AttemptListProjection {
  const record = asRecord(result);
  if (record?.outcome !== "listed") {
    return { outcome: asString(record?.outcome) ?? "unknown" };
  }
  const items = Array.isArray(record.attempts) ? record.attempts : [];
  const attempts: AttemptListItemProjection[] = items.flatMap((raw) => {
    const item = asRecord(raw);
    if (!item) {
      return [];
    }
    const workOrder = asRecord(item.workOrder);
    const reservation = asRecord(item.reservation);
    return [
      {
        attempt: projectAttempt(item.attempt),
        workOrder: workOrder
          ? {
              id: asString(workOrder.id),
              projectId: asString(workOrder.projectId),
              taskId: asString(workOrder.taskId),
              laneId: asString(workOrder.laneId),
            }
          : null,
        reservation: reservation
          ? { slotIndex: asNumber(reservation.slotIndex), held: true }
          : null,
      },
    ];
  });
  return {
    outcome: "listed",
    total: asNumber(record.total),
    truncated: asBoolean(record.truncated),
    attempts,
  };
}

export interface JournalEntryProjection {
  readonly id: string | null;
  readonly action: string | null;
  readonly status: string | null;
  readonly recordedAtIso: string | null;
  readonly stopReason: string | null;
  readonly authorizedBy: string | null;
}

export type JournalProjection =
  | {
      readonly outcome: "listed";
      readonly attemptId: string | null;
      readonly entries: JournalEntryProjection[];
    }
  | { readonly outcome: string; readonly attemptId?: string | null };

/** Project the attempt-journal result. Dropped: detail, sessionId, observedSessionIds, baseCommit, workOrderId. */
export function projectJournal(result: unknown): JournalProjection {
  const record = asRecord(result);
  if (record?.outcome !== "listed") {
    return {
      outcome: asString(record?.outcome) ?? "unknown",
      attemptId: asString(record?.attemptId),
    };
  }
  const entries = Array.isArray(record.entries) ? record.entries : [];
  return {
    outcome: "listed",
    attemptId: asString(record.attemptId),
    entries: entries.flatMap((raw) => {
      const entry = asRecord(raw);
      if (!entry) {
        return [];
      }
      return [
        {
          id: asString(entry.id),
          action: asString(entry.action),
          status: asString(entry.status),
          recordedAtIso: asString(entry.recordedAtIso),
          stopReason: asString(entry.stopReason),
          authorizedBy: asString(entry.authorizedBy),
        },
      ];
    }),
  };
}

export interface WorkOrderProjection {
  readonly id: string | null;
  readonly projectId: string | null;
  readonly taskId: string | null;
  readonly laneId: string | null;
  readonly baseCommit: string | null;
  readonly policyRevision: string | null;
  readonly risk: string | null;
  readonly state: string | null;
  readonly revision: number | null;
  readonly prerequisiteWorkOrderIds: string[];
  readonly createdAtIso: string | null;
  readonly updatedAtIso: string | null;
}

export interface ActiveReservationProjection {
  readonly id: string | null;
  readonly attemptId: string | null;
  readonly slotIndex: number | null;
  readonly held: boolean | null;
  readonly seatTool: string | null;
  readonly reservedAtIso: string | null;
}

export type WorkOrderResultProjection =
  | {
      readonly outcome: "found";
      readonly workOrder: WorkOrderProjection | null;
      readonly attempts: AttemptProjection[];
      readonly activeReservations: ActiveReservationProjection[];
    }
  | { readonly outcome: string; readonly workOrderId: string | null };

/** Project the work-order result. Dropped: repository, ownedPaths, planRef, reservation host/ssh/port/worktreePath. */
export function projectWorkOrder(result: unknown): WorkOrderResultProjection {
  const record = asRecord(result);
  if (record?.outcome !== "found") {
    return {
      outcome: asString(record?.outcome) ?? "unknown",
      workOrderId: asString(record?.workOrderId),
    };
  }
  const workOrder = asRecord(record.workOrder);
  const attempts = Array.isArray(record.attempts) ? record.attempts : [];
  const reservations = Array.isArray(record.activeReservations)
    ? record.activeReservations
    : [];
  return {
    outcome: "found",
    workOrder: workOrder
      ? {
          id: asString(workOrder.id),
          projectId: asString(workOrder.projectId),
          taskId: asString(workOrder.taskId),
          laneId: asString(workOrder.laneId),
          baseCommit: asString(workOrder.baseCommit),
          policyRevision: asString(workOrder.policyRevision),
          risk: asString(workOrder.risk),
          state: asString(workOrder.state),
          revision: asNumber(workOrder.revision),
          prerequisiteWorkOrderIds: stringList(workOrder.prerequisiteWorkOrderIds),
          createdAtIso: asString(workOrder.createdAtIso),
          updatedAtIso: asString(workOrder.updatedAtIso),
        }
      : null,
    attempts: attempts.map(projectAttempt),
    activeReservations: reservations.flatMap((raw) => {
      const reservation = asRecord(raw);
      if (!reservation) {
        return [];
      }
      return [
        {
          id: asString(reservation.id),
          attemptId: asString(reservation.attemptId),
          slotIndex: asNumber(reservation.slotIndex),
          held: asBoolean(reservation.held),
          seatTool: asString(reservation.seatTool),
          reservedAtIso: asString(reservation.reservedAtIso),
        },
      ];
    }),
  };
}

export type AttemptResultProjection =
  | { readonly outcome: "found"; readonly attempt: AttemptProjection }
  | { readonly outcome: string; readonly attemptId: string | null };

/** Project the single-attempt result. Non-found outcomes pass through as `{ outcome, attemptId }` only; a reason is dropped. */
export function projectAttemptResult(result: unknown): AttemptResultProjection {
  const record = asRecord(result);
  if (record?.outcome !== "found") {
    return {
      outcome: asString(record?.outcome) ?? "unknown",
      attemptId: asString(record?.attemptId),
    };
  }
  return { outcome: "found", attempt: projectAttempt(record.attempt) };
}
