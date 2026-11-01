/**
 * Server-side loader for the Conductor page's live data layer.
 *
 * Reads `GET /v1/runs` once, server side. There is no fixture: an
 * unconfigured boundary renders a banner, and every other unread renders an
 * error view with its reason — never sample rows.
 */

import {
  createFleetWebApiClient,
  type FleetWebApiClient,
} from "../../lib/api-client";
import { NOT_IMPLEMENTED_STATUS } from "../../lib/api/transport";
import { NOT_CONFIGURED_REASON } from "../attempt/live";
import { parseScheduleEnvelope, type ScheduleView } from "./map-schedule";

export type ConductorView =
  | { readonly view: "listed"; readonly schedule: ScheduleView }
  | { readonly view: "error"; readonly reason: string }
  | { readonly view: "not-configured" };

export type ConductorData = ConductorView & {
  readonly source: "api" | "fixture-fallback";
  readonly fallbackReason: string | null;
  readonly observedAtIso: string;
};

function envelopeCode(data: unknown): string | null {
  if (typeof data === "object" && data !== null) {
    const code = (data as Record<string, unknown>).code;
    if (typeof code === "string") {
      return code;
    }
  }
  return null;
}

export async function loadConductor(
  client: Pick<FleetWebApiClient, "fetchRunSchedule"> = createFleetWebApiClient(),
  now: () => Date = () => new Date(),
): Promise<ConductorData> {
  const observedAtIso = now().toISOString();
  const fetchRunSchedule = client.fetchRunSchedule;
  if (fetchRunSchedule === undefined) {
    return {
      view: "not-configured",
      source: "fixture-fallback",
      fallbackReason: NOT_CONFIGURED_REASON,
      observedAtIso,
    };
  }
  const endpoint = await fetchRunSchedule(null);

  if (endpoint.source === "fixture-fallback") {
    if (
      endpoint.fallbackReason === NOT_CONFIGURED_REASON ||
      endpoint.status === NOT_IMPLEMENTED_STATUS
    ) {
      // Set the transport's not-configured reason so useAutoRefresh stops.
      return {
        view: "not-configured",
        source: endpoint.source,
        fallbackReason: NOT_CONFIGURED_REASON,
        observedAtIso,
      };
    }
    return {
      view: "error",
      reason:
        endpoint.fallbackReason ?? "the api client gave no fallback reason",
      source: endpoint.source,
      fallbackReason: endpoint.fallbackReason,
      observedAtIso,
    };
  }

  const parsed = parseScheduleEnvelope(endpoint.data);
  if (parsed === null) {
    const code = envelopeCode(endpoint.data);
    const reason =
      code !== null && code !== "OK"
        ? `api boundary answered ${code} for /v1/runs`
        : "api boundary returned an unexpected schedule shape for /v1/runs";
    return {
      view: "error",
      reason,
      source: endpoint.source,
      fallbackReason: endpoint.fallbackReason,
      observedAtIso,
    };
  }

  return {
    view: "listed",
    schedule: parsed,
    source: endpoint.source,
    fallbackReason: endpoint.fallbackReason,
    observedAtIso,
  };
}
