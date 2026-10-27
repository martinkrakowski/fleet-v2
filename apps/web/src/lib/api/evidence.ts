import type { EndpointRead, LiveEndpointResult } from "./transport";

export interface EvidenceReaders {
  fetchHeadEvidenceView<T>(
    headSha: string,
    fallback: T,
  ): Promise<LiveEndpointResult<T>>;
}

export function createEvidenceReaders(read: EndpointRead): EvidenceReaders {
  return {
    fetchHeadEvidenceView<T>(
      headSha: string,
      fallback: T,
    ): Promise<LiveEndpointResult<T>> {
      return read(
        `/v1/heads/${encodeURIComponent(headSha)}/evidence`,
        fallback,
      );
    },
  };
}
