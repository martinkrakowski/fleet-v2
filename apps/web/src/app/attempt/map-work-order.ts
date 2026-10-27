/**
 * Strict mapping from the `GET /v1/work-orders/:id` envelope to the typed
 * work-order sidebar view. Only recorded fields are carried: host, transport,
 * port and path fields are deliberately not parsed (rule 6).
 */

import {
  isRecord,
  parseRecordedAttempt,
  type RecordedAttemptWire,
} from "../../lib/attempt-wire";

export interface WorkOrderSummary {
  readonly id: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly laneId: string;
  /** Recorded state, verbatim. */
  readonly state: string;
  readonly revision: number;
  readonly baseCommit: string;
  readonly prerequisiteWorkOrderIds: readonly string[];
  readonly createdAtIso: string;
  readonly updatedAtIso: string;
}

/** A held slot, with no host, transport, port or path field. */
export interface HeldSlot {
  readonly attemptId: string;
  readonly slotIndex: number;
  readonly seatTool: string | null;
  readonly reservedAtIso: string;
}

export type WorkOrderInspect =
  | {
      readonly outcome: "found";
      readonly workOrder: WorkOrderSummary;
      readonly attempts: readonly RecordedAttemptWire[];
      readonly heldSlots: readonly HeldSlot[];
    }
  | { readonly outcome: "not-found"; readonly workOrderId: string };

function parseWorkOrderSummary(value: unknown): WorkOrderSummary | null {
  if (!isRecord(value)) {
    return null;
  }
  for (const field of [
    "id",
    "projectId",
    "taskId",
    "laneId",
    "state",
    "baseCommit",
    "createdAtIso",
    "updatedAtIso",
  ] as const) {
    if (typeof value[field] !== "string") {
      return null;
    }
  }
  if (
    typeof value.revision !== "number" ||
    !Number.isInteger(value.revision) ||
    value.revision < 0
  ) {
    return null;
  }
  if (
    !Array.isArray(value.prerequisiteWorkOrderIds) ||
    !value.prerequisiteWorkOrderIds.every(
      (id) => typeof id === "string",
    )
  ) {
    return null;
  }
  return {
    id: value.id as string,
    projectId: value.projectId as string,
    taskId: value.taskId as string,
    laneId: value.laneId as string,
    state: value.state as string,
    revision: value.revision,
    baseCommit: value.baseCommit as string,
    prerequisiteWorkOrderIds: value.prerequisiteWorkOrderIds as string[],
    createdAtIso: value.createdAtIso as string,
    updatedAtIso: value.updatedAtIso as string,
  };
}

function parseReservation(value: unknown): HeldSlot | null {
  if (!isRecord(value)) {
    return null;
  }
  if (typeof value.attemptId !== "string") {
    return null;
  }
  if (
    typeof value.slotIndex !== "number" ||
    !Number.isInteger(value.slotIndex) ||
    value.slotIndex < 0
  ) {
    return null;
  }
  if (typeof value.held !== "boolean") {
    return null;
  }
  if (typeof value.reservedAtIso !== "string") {
    return null;
  }
  const seatTool = value.seatTool;
  if (seatTool !== null && seatTool !== undefined && typeof seatTool !== "string") {
    return null;
  }
  return {
    attemptId: value.attemptId,
    slotIndex: value.slotIndex,
    seatTool: typeof seatTool === "string" ? seatTool : null,
    reservedAtIso: value.reservedAtIso,
  };
}

export function parseWorkOrderEnvelope(value: unknown): WorkOrderInspect | null {
  if (!isRecord(value) || value.code !== "OK") {
    return null;
  }
  const result = value.result;
  if (!isRecord(result)) {
    return null;
  }
  if (result.outcome === "not-found") {
    if (typeof result.workOrderId !== "string") {
      return null;
    }
    return { outcome: "not-found", workOrderId: result.workOrderId };
  }
  if (result.outcome === "found") {
    const workOrder = parseWorkOrderSummary(result.workOrder);
    if (workOrder === null) {
      return null;
    }
    if (!Array.isArray(result.attempts)) {
      return null;
    }
    const attempts: RecordedAttemptWire[] = [];
    for (const item of result.attempts) {
      const attempt = parseRecordedAttempt(item);
      if (attempt === null) {
        return null;
      }
      attempts.push(attempt);
    }
    if (!Array.isArray(result.activeReservations)) {
      return null;
    }
    const heldSlots: HeldSlot[] = [];
    for (const item of result.activeReservations) {
      if (!isRecord(item)) {
        return null;
      }
      const slot = parseReservation(item);
      if (slot === null) {
        return null;
      }
      if (item.held === true) {
        heldSlots.push(slot);
      }
    }
    return { outcome: "found", workOrder, attempts, heldSlots };
  }
  return null;
}
