import type { EndpointRead, LiveEndpointResult } from "./transport";

export interface WorkOrderReaders {
  fetchWorkOrderView<T>(
    workOrderId: string,
    fallback: T,
  ): Promise<LiveEndpointResult<T>>;
}

export function createWorkOrderReaders(read: EndpointRead): WorkOrderReaders {
  return {
    fetchWorkOrderView<T>(
      workOrderId: string,
      fallback: T,
    ): Promise<LiveEndpointResult<T>> {
      return read(
        `/v1/work-orders/${encodeURIComponent(workOrderId)}`,
        fallback,
      );
    },
  };
}
