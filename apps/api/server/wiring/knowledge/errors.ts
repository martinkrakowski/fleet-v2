export interface ApiEnvelope {
  operationId: string;
  code: string;
  result: Record<string, unknown> | null;
}

export interface UseCaseFailure {
  status: number;
  body: ApiEnvelope;
}

export function isNotImplementedError(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith("Not implemented");
}

export function mapUseCaseFailure(error: unknown): UseCaseFailure {
  const code = isNotImplementedError(error) ? "NOT_IMPLEMENTED" : "INTERNAL_ERROR";
  return {
    status: isNotImplementedError(error) ? 501 : 500,
    body: { operationId: crypto.randomUUID(), code, result: null },
  };
}
