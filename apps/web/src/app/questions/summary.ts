/**
 * Server-side open-question summary for the Views rail badge and the Lanes
 * attention card.
 *
 * Reads `GET /v1/questions?state=open` once, server side, but counts only
 * records whose own `state` is `open` (the view never trusts that the server
 * filtered). An unconfigured boundary is `not-read`; any other failure is an
 * `error` with the reason verbatim; a zero is never invented from a failure.
 */

import {
  createFleetWebApiClient,
  type FleetWebApiClient,
} from "../../lib/api-client";
import { NOT_CONFIGURED_REASON } from "../attempt/live";
import { parseQuestionListEnvelope } from "./map-question";

export type QuestionSummary =
  | {
      readonly status: "read";
      readonly open: number;
      readonly oneWay: number;
      readonly blocking: number;
      readonly observedAtIso: string;
    }
  | { readonly status: "error"; readonly reason: string }
  | { readonly status: "not-read" };

export async function loadQuestionSummary(
  client: Pick<FleetWebApiClient, "fetchQuestionList"> =
    createFleetWebApiClient(),
  now: () => Date = () => new Date(),
): Promise<QuestionSummary> {
  const endpoint = await client.fetchQuestionList({ state: "open" }, null);

  if (endpoint.source === "fixture-fallback") {
    if (endpoint.fallbackReason === NOT_CONFIGURED_REASON) {
      return { status: "not-read" };
    }
    return {
      status: "error",
      reason:
        endpoint.fallbackReason ?? "the api client gave no fallback reason",
    };
  }

  const questions = parseQuestionListEnvelope(endpoint.data);
  if (questions === null) {
    const code =
      typeof endpoint.data === "object" &&
      endpoint.data !== null &&
      typeof (endpoint.data as Record<string, unknown>).code === "string"
        ? ((endpoint.data as Record<string, unknown>).code as string)
        : null;
    const reason =
      code !== null && code !== "OK"
        ? `api boundary answered ${code} for /v1/questions`
        : "api boundary returned an unexpected questions shape for /v1/questions";
    return { status: "error", reason };
  }

  const openQuestions = questions.filter((q) => q.state === "open");
  let oneWay = 0;
  let blocking = 0;
  for (const q of openQuestions) {
    if (q.doorKind === "one-way") {
      oneWay += 1;
    }
    if (q.blocks.length > 0) {
      blocking += 1;
    }
  }
  return {
    status: "read",
    open: openQuestions.length,
    oneWay,
    blocking,
    observedAtIso: now().toISOString(),
  };
}

export function openQuestionCount(summary: QuestionSummary): number | null {
  return summary.status === "read" ? summary.open : null;
}
