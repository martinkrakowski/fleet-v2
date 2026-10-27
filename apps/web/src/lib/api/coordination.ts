import type { EndpointRead, LiveEndpointResult } from "./transport";

export interface CoordinationReaders {
  fetchCoordinationView<T>(fallback: T): Promise<LiveEndpointResult<T>>;
  fetchAttentionView<T>(fallback: T): Promise<LiveEndpointResult<T>>;
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
  };
}
