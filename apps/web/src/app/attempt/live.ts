/**
 * Server-side loader for the attempt page's live data layer.
 *
 * Reads `GET /v1/attempts/:id` through the web API client. The fixture
 * appears only when the API boundary is not configured, and is labelled
 * sample; a configured API that fails shows the error with its reason, never
 * a sample attempt in place of a real id.
 */

import {
  createFleetWebApiClient,
  type FleetWebApiClient,
} from "../../lib/api-client";
// Declared here, not imported from use-auto-refresh.ts: that module is "use client", and a server
// module importing from it gets a client-reference proxy instead of the string (Fable, W1a-1).
// It must equal the transport's not-configured fallback reason in lib/api/transport.ts.
const NOT_CONFIGURED_REASON = "api boundary is not configured";
import { parseAttemptListEnvelope } from "../lanes/map-attempt";
import { parseInspectEnvelope, type AttemptDetail } from "./map-inspect";

export type AttemptPageView =
  | { readonly view: "sample" } // API unconfigured; the client picks the fixture
  | { readonly view: "found"; readonly attempt: AttemptDetail }
  | { readonly view: "not-found" }
  | { readonly view: "unknown"; readonly reason: string }
  | { readonly view: "error"; readonly reason: string }
  | { readonly view: "missing-id"; readonly newestAttemptId: string | null };

export type AttemptPageData = AttemptPageView & {
  readonly attemptId: string;
  readonly source: "api" | "fixture-fallback";
  readonly fallbackReason: string | null;
  readonly observedAtIso: string;
};

export async function loadAttemptPage(
  attemptId: string,
  client: FleetWebApiClient = createFleetWebApiClient(),
  now: () => Date = () => new Date(),
): Promise<AttemptPageData> {
  const id = attemptId.trim();

  if (id === "") {
    const endpoint = await client.fetchAttemptList({ limit: 1 }, null);
    let view: AttemptPageView;
    if (
      endpoint.source === "fixture-fallback" &&
      endpoint.fallbackReason === NOT_CONFIGURED_REASON
    ) {
      view = { view: "sample" };
    } else {
      const newestAttemptId =
        endpoint.source === "api"
          ? (parseAttemptListEnvelope(endpoint.data)?.rows[0]?.attempt.id ?? null)
          : null;
      view = { view: "missing-id", newestAttemptId };
    }
    return {
      ...view,
      attemptId: id,
      source: endpoint.source,
      fallbackReason: endpoint.fallbackReason,
      observedAtIso: now().toISOString(),
    };
  }

  const endpoint = await client.fetchAttemptView(id, null);

  let view: AttemptPageView;
  if (endpoint.source === "fixture-fallback") {
    view =
      endpoint.fallbackReason === NOT_CONFIGURED_REASON
        ? { view: "sample" }
        : {
            view: "error",
            reason:
              endpoint.fallbackReason ?? "the api client gave no fallback reason",
          };
  } else {
    const parsed = parseInspectEnvelope(endpoint.data);
    if (parsed === null) {
      const code =
        typeof endpoint.data === "object" &&
        endpoint.data !== null &&
        typeof (endpoint.data as Record<string, unknown>).code === "string"
          ? ((endpoint.data as Record<string, unknown>).code as string)
          : null;
      const reason =
        code !== null && code !== "OK"
          ? `api boundary answered ${code} for /v1/attempts/${id}`
          : `api boundary returned an unexpected attempt shape for /v1/attempts/${id}`;
      view = { view: "error", reason };
    } else if (parsed.outcome === "found") {
      view = { view: "found", attempt: parsed.attempt };
    } else if (parsed.outcome === "not-found") {
      view = { view: "not-found" };
    } else {
      view = { view: "unknown", reason: parsed.reason };
    }
  }

  return {
    ...view,
    attemptId: id,
    source: endpoint.source,
    fallbackReason: endpoint.fallbackReason,
    observedAtIso: now().toISOString(),
  };
}
