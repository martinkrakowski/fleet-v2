/**
 * Server-side loader for the Conductor page's live data layer.
 *
 * Reads `GET /v1/runs` and `GET /v1/runs/passes` once, server side. There is
 * no fixture: an unconfigured boundary renders a banner, and every other
 * unread renders an error view with its reason — never sample rows. The
 * schedule is authoritative; a failed or illegible pass list renders as
 * `unreadable` (never as an empty readable list, which would look like
 * "no passes recorded yet") rather than failing the page.
 */

import {
  createFleetWebApiClient,
  type FleetWebApiClient,
  type LiveEndpointResult,
} from "../../lib/api-client";
import { NOT_IMPLEMENTED_STATUS } from "../../lib/api/transport";
import { NOT_CONFIGURED_REASON } from "../attempt/live";
import { parseScheduleEnvelope, type ScheduleView } from "./map-schedule";
import {
  parseConductorPassesEnvelope,
  type PassListView,
} from "./map-passes";

const PASS_LIST_LIMIT = 32;

export type ConductorView =
  | {
      readonly view: "listed";
      readonly schedule: ScheduleView;
      readonly passes: PassListView;
    }
  | { readonly view: "error"; readonly reason: string }
  | { readonly view: "not-configured" };

export type ConductorData = ConductorView & {
  readonly source: "api" | "fixture-fallback";
  readonly fallbackReason: string | null;
  readonly observedAtIso: string;
};

const UNREADABLE_PASSES: PassListView = {
  store: "unreadable",
  passes: [],
  total: 0,
  truncated: false,
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

function notConfigured(observedAtIso: string): ConductorData {
  return {
    view: "not-configured",
    source: "fixture-fallback",
    fallbackReason: NOT_CONFIGURED_REASON,
    observedAtIso,
  };
}

/**
 * A failed passes read is never an empty readable list: the API answers 200
 * with an empty list when nothing is recorded (VZ6), so every fallback read
 * or envelope the parser refuses is reported `unreadable` instead.
 */
function readPasses(passesEndpoint: LiveEndpointResult<unknown>): PassListView {
  if (passesEndpoint.source !== "api") {
    return UNREADABLE_PASSES;
  }
  return parseConductorPassesEnvelope(passesEndpoint.data) ?? UNREADABLE_PASSES;
}

export async function loadConductor(
  client: Pick<FleetWebApiClient, "fetchRunSchedule" | "fetchConductorPasses"> =
    createFleetWebApiClient(),
  now: () => Date = () => new Date(),
): Promise<ConductorData> {
  const observedAtIso = now().toISOString();
  const fetchRunSchedule = client.fetchRunSchedule;
  const fetchConductorPasses = client.fetchConductorPasses;
  if (fetchRunSchedule === undefined || fetchConductorPasses === undefined) {
    return notConfigured(observedAtIso);
  }
  const endpoint = await fetchRunSchedule(null);

  if (endpoint.source === "fixture-fallback") {
    if (
      endpoint.fallbackReason === NOT_CONFIGURED_REASON ||
      endpoint.status === NOT_IMPLEMENTED_STATUS
    ) {
      // Set the transport's not-configured reason so useAutoRefresh stops.
      return notConfigured(observedAtIso);
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

  const passesEndpoint = await fetchConductorPasses(
    { limit: PASS_LIST_LIMIT },
    null,
  );

  return {
    view: "listed",
    schedule: parsed,
    passes: readPasses(passesEndpoint),
    source: endpoint.source,
    fallbackReason: endpoint.fallbackReason,
    observedAtIso,
  };
}
