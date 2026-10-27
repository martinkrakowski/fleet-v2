/**
 * Server-side loader for the work-order timeline page. Reads
 * `GET /v1/work-orders/:id` and the newest attempts' journals through the web
 * API client. The fixture never stands in for a real failed read: unconfigured
 * and error views say so explicitly.
 */

import {
  createFleetWebApiClient,
  type FleetWebApiClient,
} from "../../lib/api-client";
import { NOT_CONFIGURED_REASON } from "../attempt/live";
import {
  parseWorkOrderEnvelope,
  type WorkOrderSummary,
} from "../attempt/map-work-order";
import { readJournalPanel, type JournalPanel } from "../attempt/live-context";
import { chainOrder } from "../attempt/work-order-view";
import type { RecordedAttemptWire } from "../../lib/attempt-wire";
import { chainNote, journalReadIds, type ChainNote } from "./timeline-view";

export interface TimelineAttempt {
  readonly attempt: RecordedAttemptWire;
  readonly chain: ChainNote;
  readonly journal: JournalPanel;
}

export type TimelineView =
  | {
      readonly view: "found";
      readonly workOrder: WorkOrderSummary;
      readonly attempts: readonly TimelineAttempt[];
      readonly journalsNotRead: number;
    }
  | { readonly view: "not-found" }
  | { readonly view: "error"; readonly reason: string }
  | { readonly view: "not-configured" }
  | { readonly view: "missing-id" };

export type TimelineData = TimelineView & {
  readonly workOrderId: string;
  readonly observedAtIso: string;
};

export async function loadWorkOrderTimeline(
  workOrderId: string,
  client: Pick<
    FleetWebApiClient,
    "fetchWorkOrderView" | "fetchAttemptJournal"
  > = createFleetWebApiClient(),
  now: () => Date = () => new Date(),
): Promise<TimelineData> {
  const id = workOrderId.trim();

  if (id === "") {
    return {
      view: "missing-id",
      workOrderId: id,
      observedAtIso: now().toISOString(),
    };
  }

  const endpoint = await client.fetchWorkOrderView(id, null);

  if (endpoint.source === "fixture-fallback") {
    if (endpoint.fallbackReason === NOT_CONFIGURED_REASON) {
      return {
        view: "not-configured",
        workOrderId: id,
        observedAtIso: now().toISOString(),
      };
    }
    return {
      view: "error",
      reason:
        endpoint.fallbackReason ?? "the api client gave no fallback reason",
      workOrderId: id,
      observedAtIso: now().toISOString(),
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
        ? `api boundary answered ${code} for /v1/work-orders/${id}`
        : `api boundary returned an unexpected work order shape for /v1/work-orders/${id}`;
    return {
      view: "error",
      reason,
      workOrderId: id,
      observedAtIso: now().toISOString(),
    };
  }

  if (parsed.outcome === "not-found") {
    return {
      view: "not-found",
      workOrderId: id,
      observedAtIso: now().toISOString(),
    };
  }

  const ordered = chainOrder(parsed.attempts);
  const ids = new Set(ordered.map((attempt) => attempt.id));
  const readIds = journalReadIds(ordered);
  const journals = await Promise.all(
    ordered.map((attempt) =>
      readIds.has(attempt.id)
        ? readJournalPanel(attempt.id, client)
        : Promise.resolve<JournalPanel>({ panel: "not-read" }),
    ),
  );
  const attempts: TimelineAttempt[] = ordered.map((attempt, index) => ({
    attempt,
    chain: chainNote(attempt, ids),
    journal: journals[index],
  }));
  const journalsNotRead = ordered.length - readIds.size;

  return {
    view: "found",
    workOrder: parsed.workOrder,
    attempts,
    journalsNotRead,
    workOrderId: id,
    observedAtIso: now().toISOString(),
  };
}
