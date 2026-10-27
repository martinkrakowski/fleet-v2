/**
 * Server-side loader for the attempt page's work-order sidebar. Reads
 * `GET /v1/work-orders/:id` through the web API client only when the page
 * found the attempt; every other view answers `not-read` with no read.
 */

import {
  createFleetWebApiClient,
  type FleetWebApiClient,
} from "../../lib/api-client";
import {
  NOT_CONFIGURED_REASON,
  type AttemptPageData,
} from "./live";
import {
  parseWorkOrderEnvelope,
  type HeldSlot,
  type WorkOrderSummary,
} from "./map-work-order";
import type { RecordedAttemptWire } from "../../lib/attempt-wire";

export type WorkOrderPanel =
  | {
      readonly panel: "found";
      readonly workOrder: WorkOrderSummary;
      readonly attempts: readonly RecordedAttemptWire[];
      readonly heldSlots: readonly HeldSlot[];
    }
  | { readonly panel: "not-found"; readonly workOrderId: string }
  | {
      readonly panel: "error";
      readonly workOrderId: string;
      readonly reason: string;
    }
  | { readonly panel: "not-read" };

export interface AttemptContext {
  readonly workOrder: WorkOrderPanel;
}

export async function loadAttemptContext(
  data: AttemptPageData,
  client: Pick<FleetWebApiClient, "fetchWorkOrderView"> =
    createFleetWebApiClient(),
): Promise<AttemptContext> {
  if (data.view !== "found") {
    return { workOrder: { panel: "not-read" } };
  }

  const workOrderId = data.attempt.workOrderId.trim();
  if (workOrderId === "") {
    return {
      workOrder: {
        panel: "error",
        workOrderId,
        reason: "the attempt record names no work order",
      },
    };
  }

  const endpoint = await client.fetchWorkOrderView(workOrderId, null);

  if (endpoint.source === "fixture-fallback") {
    if (endpoint.fallbackReason === NOT_CONFIGURED_REASON) {
      return { workOrder: { panel: "not-read" } };
    }
    return {
      workOrder: {
        panel: "error",
        workOrderId,
        reason:
          endpoint.fallbackReason ?? "the api client gave no fallback reason",
      },
    };
  }

  const parsed = parseWorkOrderEnvelope(endpoint.data);
  if (parsed === null) {
    const code =
      typeof endpoint.data === "object" &&
      endpoint.data !== null &&
      typeof (endpoint.data as Record<string, unknown>).code === "string"
        ? ((endpoint.data as Record<string, unknown>).code as string)
        : null;
    const reason =
      code !== null && code !== "OK"
        ? `api boundary answered ${code} for /v1/work-orders/${workOrderId}`
        : `api boundary returned an unexpected work order shape for /v1/work-orders/${workOrderId}`;
    return { workOrder: { panel: "error", workOrderId, reason } };
  }

  if (parsed.outcome === "not-found") {
    return { workOrder: { panel: "not-found", workOrderId } };
  }

  return {
    workOrder: {
      panel: "found",
      workOrder: parsed.workOrder,
      attempts: parsed.attempts,
      heldSlots: parsed.heldSlots,
    },
  };
}
