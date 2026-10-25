/**
 * Pure mapping from the `GET /v1/attempts` wire envelope to the Lanes view's
 * `AttemptSummary`/`WorkOrderSummary` records.
 *
 * The live list is a RECORDED view: it reports what the API journal holds,
 * never a runner observation. Every mapped row carries `basis: "recorded"`
 * with the recorded state word, and the UI rules keep unknown separate from
 * idle and recorded separate from observed.
 */

import type {
  AttemptSummary,
  CapacityState,
  WorkOrderSummary,
} from "./fixture";

/** One row of the `result.attempts` array from `/v1/attempts`. */
export interface ListedAttemptWire {
  attempt: {
    id: string;
    workOrderId: string;
    kind: "initial" | "fix";
    fixNumber: number;
    priorAttemptId: string | null;
    state: string;
    outcome: string | null;
    sessionId: string | null;
    createdAtIso: string;
    updatedAtIso: string;
  };
  workOrder: {
    id: string;
    projectId: string;
    taskId: string;
    laneId: string;
  } | null;
  reservation: {
    hostId: string;
    hostName: string | null;
    slotIndex: number;
  } | null;
}

export interface ParsedAttemptList {
  rows: ListedAttemptWire[];
  total: number;
  truncated: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseAttempt(value: unknown): ListedAttemptWire["attempt"] | null {
  if (!isRecord(value)) {
    return null;
  }
  if (typeof value.id !== "string") return null;
  if (typeof value.workOrderId !== "string") return null;
  if (typeof value.state !== "string") return null;
  if (typeof value.createdAtIso !== "string") return null;
  if (typeof value.updatedAtIso !== "string") return null;
  if (value.kind !== "initial" && value.kind !== "fix") return null;
  if (
    typeof value.fixNumber !== "number" ||
    !Number.isInteger(value.fixNumber) ||
    value.fixNumber < 0
  ) {
    return null;
  }
  if (value.priorAttemptId !== null && typeof value.priorAttemptId !== "string") {
    return null;
  }
  if (value.outcome !== null && typeof value.outcome !== "string") return null;
  if (value.sessionId !== null && typeof value.sessionId !== "string") return null;
  return {
    id: value.id,
    workOrderId: value.workOrderId,
    kind: value.kind,
    fixNumber: value.fixNumber,
    priorAttemptId: value.priorAttemptId,
    state: value.state,
    outcome: value.outcome,
    sessionId: value.sessionId,
    createdAtIso: value.createdAtIso,
    updatedAtIso: value.updatedAtIso,
  };
}

function parseWorkOrderWire(
  value: unknown,
): ListedAttemptWire["workOrder"] | undefined {
  if (value === null) {
    return null;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  if (typeof value.id !== "string") return undefined;
  if (typeof value.projectId !== "string") return undefined;
  if (typeof value.taskId !== "string") return undefined;
  if (typeof value.laneId !== "string") return undefined;
  return {
    id: value.id,
    projectId: value.projectId,
    taskId: value.taskId,
    laneId: value.laneId,
  };
}

function parseReservationWire(
  value: unknown,
): ListedAttemptWire["reservation"] | undefined {
  if (value === null) {
    return null;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  if (typeof value.hostId !== "string") return undefined;
  if (value.hostName !== null && typeof value.hostName !== "string") {
    return undefined;
  }
  if (
    typeof value.slotIndex !== "number" ||
    !Number.isInteger(value.slotIndex) ||
    value.slotIndex < 0
  ) {
    return undefined;
  }
  return {
    hostId: value.hostId,
    hostName: value.hostName,
    slotIndex: value.slotIndex,
  };
}

function parseRow(value: unknown): ListedAttemptWire | null {
  if (!isRecord(value)) {
    return null;
  }
  const attempt = parseAttempt(value.attempt);
  if (!attempt) {
    return null;
  }
  const workOrder = parseWorkOrderWire(value.workOrder);
  if (workOrder === undefined) {
    return null;
  }
  const reservation = parseReservationWire(value.reservation);
  if (reservation === undefined) {
    return null;
  }
  return { attempt, workOrder, reservation };
}

/**
 * Parses the 200 envelope body of `GET /v1/attempts`. Returns null unless
 * every required field is present and typed; one bad row invalidates the
 * whole list so the caller falls back to the fixture and says why.
 */
export function parseAttemptListEnvelope(
  payload: unknown,
): ParsedAttemptList | null {
  if (!isRecord(payload) || payload.code !== "OK") {
    return null;
  }
  const result = payload.result;
  if (!isRecord(result) || result.outcome !== "listed") {
    return null;
  }
  if (!Array.isArray(result.attempts)) {
    return null;
  }
  if (typeof result.total !== "number") {
    return null;
  }
  if (typeof result.truncated !== "boolean") {
    return null;
  }

  const rows: ListedAttemptWire[] = [];
  for (const row of result.attempts) {
    const parsed = parseRow(row);
    if (!parsed) {
      return null;
    }
    rows.push(parsed);
  }
  return { rows, total: result.total, truncated: result.truncated };
}

const ENDED_STATES = new Set(["ended", "collected", "cancelled"]);

/** Maps one wire row to the Lanes view's recorded `AttemptSummary`. */
export function toAttemptSummary(row: ListedAttemptWire): AttemptSummary {
  const { attempt, reservation } = row;
  const state = attempt.state;
  const capacity: CapacityState = reservation
    ? "held"
    : state === "intent-recorded"
      ? "pending"
      : ENDED_STATES.has(state)
        ? "released"
        : "unrecorded";
  const pending = capacity === "pending";

  return {
    id: attempt.id,
    wo: attempt.workOrderId,
    kind: attempt.kind === "fix" ? "fix" : "first",
    number: attempt.kind === "fix" ? attempt.fixNumber : 1,
    fixOf: attempt.priorAttemptId ?? null,
    session: attempt.sessionId ?? null,
    port: null,
    slot: reservation ? reservation.slotIndex + 1 : null,
    capacity,
    startedAt: pending ? null : attempt.createdAtIso,
    queuedAt: pending ? attempt.createdAtIso : null,
    queueBound: null,
    observedAt: attempt.updatedAtIso,
    observedFrom: `recorded state "${state}" · GET /v1/attempts · not a runner observation`,
    facts: {
      reachable: "unknown",
      prepared: "unknown",
      active: "unknown",
      ended: ENDED_STATES.has(state) ? "yes" : "unknown",
      collected:
        state === "collected"
          ? "yes"
          : state === "ended" || state === "cancelled"
            ? "no"
            : "unknown",
    },
    lastKnown: null,
    stale: false,
    receipts: {
      completion: null,
      verification: null,
      acceptance: null,
      decision: null,
    },
    mergeHead: null,
    pullRequest: null,
    cost: null,
    legal: [],
    notOffered: [
      {
        op: "act",
        reason: "the live list is read-only; act through the fleet-v2 CLI",
      },
    ],
    basis: "recorded",
    recordedState: state,
  };
}

/** Maps one wire row to the work-order summary the Lanes view renders. */
export function toWorkOrderSummary(row: ListedAttemptWire): WorkOrderSummary {
  if (row.workOrder === null) {
    return {
      project: "(unknown)",
      task: `work order ${row.attempt.workOrderId} (record missing)`,
      lane: "",
    };
  }
  const workOrder = row.workOrder;
  return {
    project: workOrder.projectId,
    task: workOrder.taskId,
    lane: workOrder.laneId,
  };
}
