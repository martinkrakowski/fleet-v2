/**
 * Server-side loader for the Questions page's live data layer.
 *
 * Reads `GET /v1/questions` once, server side, with no query: every state is
 * carried and filtered in the view. There is no fixture: questions exist only
 * on a station, so an unconfigured boundary and every failed read render an
 * error view with the reason verbatim, never sample data.
 */

import {
  createFleetWebApiClient,
  type FleetWebApiClient,
} from "../../lib/api-client";
import { NOT_CONFIGURED_REASON } from "../attempt/live";
import {
  parseQuestionListEnvelope,
  type QuestionView,
} from "./map-question";

export type QuestionsView =
  | { readonly view: "listed"; readonly questions: readonly QuestionView[] }
  | { readonly view: "error"; readonly reason: string }
  | { readonly view: "not-configured" };

export type QuestionsData = QuestionsView & {
  readonly source: "api" | "fixture-fallback";
  readonly fallbackReason: string | null;
  readonly observedAtIso: string;
};

export async function loadQuestions(
  client: Pick<FleetWebApiClient, "fetchQuestionList"> =
    createFleetWebApiClient(),
  now: () => Date = () => new Date(),
): Promise<QuestionsData> {
  const observedAtIso = now().toISOString();
  const endpoint = await client.fetchQuestionList({}, null);

  if (endpoint.source === "fixture-fallback") {
    if (endpoint.fallbackReason === NOT_CONFIGURED_REASON) {
      return {
        view: "not-configured",
        source: endpoint.source,
        fallbackReason: endpoint.fallbackReason,
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

  const parsed = parseQuestionListEnvelope(endpoint.data);
  if (parsed === null) {
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
    questions: parsed,
    source: endpoint.source,
    fallbackReason: endpoint.fallbackReason,
    observedAtIso,
  };
}
