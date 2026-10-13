import { randomUUID } from "node:crypto";

export const NOT_IMPLEMENTED_STATUS = 501;
export const NOT_IMPLEMENTED_CODE = "NOT_IMPLEMENTED";

export interface ApiEnvelope {
  operationId: string;
  code: string;
  result: object | null;
}

export function newOperationId(): string {
  return randomUUID();
}

export function envelope(
  operationId: string,
  code: string,
  result: object | null = null,
): ApiEnvelope {
  return { operationId, code, result };
}

export function isNotImplementedError(error: unknown): boolean {
  return (
    error instanceof Error && error.message.startsWith("Not implemented")
  );
}

export interface ApiErrorMapping {
  status: number;
  code: string;
}

export function mapWorkError(error: unknown): ApiErrorMapping | null {
  if (!isNotImplementedError(error)) {
    return null;
  }
  return { status: NOT_IMPLEMENTED_STATUS, code: NOT_IMPLEMENTED_CODE };
}
