/**
 * Server-side loader for the Lanes page's live data layer.
 *
 * Reads `GET /v1/attempts` through the web API client and degrades to the
 * deterministic fixture when the boundary is unconfigured, unimplemented or
 * returns an unexpected shape. The fixture is the authority whenever the API
 * body cannot be trusted, so the page renders rows and reports why.
 */

import {
  createFleetWebApiClient,
  type FleetWebApiClient,
} from "../../lib/api-client";
import {
  attempts as fixtureAttempts,
  capacity as fixtureCapacity,
  workOrders as fixtureWorkOrders,
  type AttemptSummary,
  type WorkOrderSummary,
} from "./fixture";
import {
  parseAttemptListEnvelope,
  toAttemptSummary,
  toWorkOrderSummary,
} from "./map-attempt";

export interface LanesData {
  source: "api" | "fixture-fallback";
  fallbackReason: string | null;
  observedAtIso: string;
  attempts: AttemptSummary[];
  workOrders: Record<string, WorkOrderSummary>;
  capacity: { host: string; port: number; slots: number } | null;
  total: number;
  truncated: boolean;
}

function fixtureLanesData(reason: string, observedAtIso: string): LanesData {
  return {
    source: "fixture-fallback",
    fallbackReason: reason,
    observedAtIso,
    attempts: fixtureAttempts,
    workOrders: fixtureWorkOrders,
    capacity: fixtureCapacity,
    total: fixtureAttempts.length,
    truncated: false,
  };
}

export async function loadLanesData(
  client: FleetWebApiClient = createFleetWebApiClient(),
  now: () => Date = () => new Date(),
): Promise<LanesData> {
  const observedAtIso = now().toISOString();
  const endpoint = await client.fetchAttemptList({ limit: 200 }, null);

  if (endpoint.source === "fixture-fallback") {
    return fixtureLanesData(endpoint.fallbackReason ?? "", observedAtIso);
  }

  const parsed = parseAttemptListEnvelope(endpoint.data);
  if (!parsed) {
    return fixtureLanesData(
      "api boundary returned an unexpected attempt list shape",
      observedAtIso,
    );
  }

  const attempts = parsed.rows.map(toAttemptSummary);
  const workOrders: Record<string, WorkOrderSummary> = {};
  for (const row of parsed.rows) {
    workOrders[row.attempt.workOrderId] = toWorkOrderSummary(row);
  }

  return {
    source: "api",
    fallbackReason: null,
    observedAtIso,
    attempts,
    workOrders,
    capacity: null,
    total: parsed.total,
    truncated: parsed.truncated,
  };
}
