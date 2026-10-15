// HTTP boundary helpers for the evidence-and-acceptance routes.
// Maps the use cases' "Not implemented" failure to HTTP 501 per the plan.
import { setResponseStatus, type H3Event } from "h3";

export interface ApiEnvelope {
  operationId: string;
  code: string;
  result: object | null;
}

export interface EvidenceUseCase {
  execute(input: unknown): Promise<unknown>;
}

export function isNotImplemented(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith("Not implemented:");
}

export interface ApiErrorMapping {
  status: number;
  code: string;
}

export function mapEvidenceError(error: unknown): ApiErrorMapping | null {
  if (!isNotImplemented(error)) {
    return null;
  }
  return { status: 501, code: "NOT_IMPLEMENTED" };
}

export async function evidenceResponse(
  event: H3Event,
  useCase: EvidenceUseCase,
  operationId: string,
): Promise<ApiEnvelope> {
  try {
    const result = await useCase.execute(undefined);
    return { operationId, code: "OK", result: (result as object) ?? null };
  } catch (error) {
    if (isNotImplemented(error)) {
      setResponseStatus(event, 501);
      return { operationId, code: "NOT_IMPLEMENTED", result: null };
    }
    setResponseStatus(event, 500);
    return { operationId, code: "INTERNAL_ERROR", result: null };
  }
}
