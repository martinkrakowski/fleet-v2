/**
 * Server-side loader for the attempt page's work-order sidebar and journal
 * panel. Reads `GET /v1/work-orders/:id` and `GET /v1/attempts/:id/journal`
 * through the web API client only when the page found (or, for the journal,
 * recognised) the attempt; every other view answers `not-read` with no read.
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
import { parseJournalEnvelope, type JournalEntryView } from "./map-journal";
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

export type JournalPanel =
  | { readonly panel: "listed"; readonly entries: readonly JournalEntryView[] }
  | { readonly panel: "not-found" }
  | { readonly panel: "error"; readonly reason: string }
  | { readonly panel: "not-read" };

export interface AttemptContext {
  readonly workOrder: WorkOrderPanel;
  readonly journal: JournalPanel;
}

async function loadWorkOrderPanel(
  data: AttemptPageData,
  client: Pick<FleetWebApiClient, "fetchWorkOrderView">,
): Promise<WorkOrderPanel> {
  if (data.view !== "found") {
    return { panel: "not-read" };
  }

  const workOrderId = data.attempt.workOrderId.trim();
  if (workOrderId === "") {
    return {
      panel: "error",
      workOrderId,
      reason: "the attempt record names no work order",
    };
  }

  const endpoint = await client.fetchWorkOrderView(workOrderId, null);

  if (endpoint.source === "fixture-fallback") {
    if (endpoint.fallbackReason === NOT_CONFIGURED_REASON) {
      return { panel: "not-read" };
    }
    return {
      panel: "error",
      workOrderId,
      reason:
        endpoint.fallbackReason ?? "the api client gave no fallback reason",
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
    return { panel: "error", workOrderId, reason };
  }

  if (parsed.outcome === "not-found") {
    return { panel: "not-found", workOrderId };
  }

  return {
    panel: "found",
    workOrder: parsed.workOrder,
    attempts: parsed.attempts,
    heldSlots: parsed.heldSlots,
  };
}

async function loadJournalPanel(
  data: AttemptPageData,
  client: Pick<FleetWebApiClient, "fetchAttemptJournal">,
): Promise<JournalPanel> {
  if (data.view !== "found" && data.view !== "unknown") {
    return { panel: "not-read" };
  }

  const endpoint = await client.fetchAttemptJournal(data.attemptId, null);

  if (endpoint.source === "fixture-fallback") {
    if (endpoint.fallbackReason === NOT_CONFIGURED_REASON) {
      return { panel: "not-read" };
    }
    if (endpoint.status === 404) {
      return { panel: "not-found" };
    }
    return {
      panel: "error",
      reason:
        endpoint.fallbackReason ?? "the api client gave no fallback reason",
    };
  }

  const parsed = parseJournalEnvelope(endpoint.data);
  if (parsed === null) {
    const code =
      typeof endpoint.data === "object" &&
      endpoint.data !== null &&
      typeof (endpoint.data as Record<string, unknown>).code === "string"
        ? ((endpoint.data as Record<string, unknown>).code as string)
        : null;
    const reason =
      code !== null && code !== "OK"
        ? `api boundary answered ${code} for /v1/attempts/${data.attemptId}/journal`
        : `api boundary returned an unexpected journal shape for /v1/attempts/${data.attemptId}/journal`;
    return { panel: "error", reason };
  }

  return { panel: "listed", entries: parsed };
}

export async function loadAttemptContext(
  data: AttemptPageData,
  client: Pick<
    FleetWebApiClient,
    "fetchWorkOrderView" | "fetchAttemptJournal"
  > = createFleetWebApiClient(),
): Promise<AttemptContext> {
  const [workOrder, journal] = await Promise.all([
    loadWorkOrderPanel(data, client),
    loadJournalPanel(data, client),
  ]);
  return { workOrder, journal };
}
