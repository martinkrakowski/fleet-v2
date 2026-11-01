import type { EndpointRead, LiveEndpointResult } from "./transport";

export const RUN_SCHEDULE_PATH = "/v1/runs";

/**
 * The /v1/runs reader. Optional on the composed client so existing test
 * fakes that spell out only the readers they exercise stay assignable; the
 * real client always provides it.
 */
export interface RunReaders {
  fetchRunSchedule?<T>(fallback: T): Promise<LiveEndpointResult<T>>;
}

export function createRunReaders(read: EndpointRead): RunReaders {
  return {
    fetchRunSchedule: async <T>(fallback: T) =>
      read(RUN_SCHEDULE_PATH, fallback),
  };
}
