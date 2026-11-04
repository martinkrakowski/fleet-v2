/**
 * Same-origin SSE relay for the API boundary's change signals (E3c).
 *
 * The browser talks only to `/live/changes`; the bearer stays on the web
 * server. An unconfigured or unreachable API answers 503 and the Lanes page
 * keeps its 30 s poll as the fallback.
 */

import { readWebClientApiToken } from "../../../lib/api-client";
import { createChangeRelay } from "../../../lib/live/changes-relay";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function apiOrigin(): string {
  const raw =
    typeof process !== "undefined"
      ? (process.env.FLEET_API_URL ?? process.env.NEXT_PUBLIC_FLEET_API_URL)
      : undefined;
  return (raw ?? "").trim();
}

export async function GET(): Promise<Response> {
  const origin = apiOrigin();
  if (origin.length === 0) {
    return new Response(JSON.stringify({ reason: "api boundary is not configured" }), {
      status: 503,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  }

  const relay = await createChangeRelay({
    url: origin,
    token: readWebClientApiToken(),
  });

  if (relay.status === "unavailable") {
    return new Response(JSON.stringify({ reason: relay.reason }), {
      status: 503,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  }

  return new Response(relay.body, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      "x-accel-buffering": "no",
    },
  });
}
