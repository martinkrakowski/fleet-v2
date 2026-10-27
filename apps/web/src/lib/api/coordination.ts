import type { EndpointRead, LiveEndpointResult } from "./transport";

export type QuestionStateQuery =
  | "open"
  | "answered"
  | "rejected"
  | "expired"
  | "acknowledged";

export interface CoordinationReaders {
  fetchCoordinationView<T>(fallback: T): Promise<LiveEndpointResult<T>>;
  fetchAttentionView<T>(fallback: T): Promise<LiveEndpointResult<T>>;
  fetchQuestionList<T>(
    query: { readonly state?: QuestionStateQuery },
    fallback: T,
  ): Promise<LiveEndpointResult<T>>;
}

export function questionListPath(query: {
  readonly state?: QuestionStateQuery;
}): string {
  const params = new URLSearchParams();
  if (query.state !== undefined) {
    params.set("state", query.state);
  }
  const queryString = params.toString();
  return queryString ? `/v1/questions?${queryString}` : "/v1/questions";
}

export function createCoordinationReaders(
  read: EndpointRead,
): CoordinationReaders {
  return {
    fetchCoordinationView<T>(
      fallback: T,
    ): Promise<LiveEndpointResult<T>> {
      return read("/v1/coordination", fallback);
    },
    fetchAttentionView<T>(
      fallback: T,
    ): Promise<LiveEndpointResult<T>> {
      return read("/v1/attention", fallback);
    },
    fetchQuestionList<T>(
      query: { readonly state?: QuestionStateQuery },
      fallback: T,
    ): Promise<LiveEndpointResult<T>> {
      return read(questionListPath(query), fallback);
    },
  };
}
