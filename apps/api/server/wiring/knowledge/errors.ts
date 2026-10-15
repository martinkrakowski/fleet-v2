import { getRequestHeader, setResponseStatus, type H3Event } from "h3";

export interface ApiEnvelope {
  operationId: string;
  code: string;
  result: Record<string, unknown> | null;
}

export interface UseCaseFailure {
  status: number;
  body: ApiEnvelope;
}

export interface KnowledgeUseCase {
  execute(input: unknown): Promise<unknown>;
}

export function isNotImplementedError(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith("Not implemented");
}

export interface ApiErrorMapping {
  status: number;
  code: string;
}

export function mapKnowledgeError(error: unknown): ApiErrorMapping | null {
  if (!isNotImplementedError(error)) {
    return null;
  }
  return { status: 501, code: "NOT_IMPLEMENTED" };
}

export function resolveOperationId(event: H3Event): string {
  const idempotencyKey = getRequestHeader(event, "Idempotency-Key");
  return idempotencyKey ? idempotencyKey : crypto.randomUUID();
}

export function mapUseCaseFailure(error: unknown, operationId: string): UseCaseFailure {
  const code = isNotImplementedError(error) ? "NOT_IMPLEMENTED" : "INTERNAL_ERROR";
  return {
    status: isNotImplementedError(error) ? 501 : 500,
    body: { operationId, code, result: null },
  };
}

export async function knowledgeResponse(
  event: H3Event,
  useCase: KnowledgeUseCase,
  input: unknown,
): Promise<ApiEnvelope> {
  const operationId = resolveOperationId(event);
  try {
    const result = await useCase.execute(input);
    return { operationId, code: "OK", result: (result as Record<string, unknown>) ?? null };
  } catch (error) {
    const failure = mapUseCaseFailure(error, operationId);
    setResponseStatus(event, failure.status);
    return failure.body;
  }
}
