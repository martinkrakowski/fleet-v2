export interface OperatorEnvelope {
  operationId: string;
  code: string;
  result: object | null;
}

export interface OperatorErrorResponse {
  statusCode: number;
  body: OperatorEnvelope;
}

export function newOperationId(): string {
  return crypto.randomUUID();
}

export function successEnvelope(operationId: string, result: object | null): OperatorEnvelope {
  return { operationId, code: "OK", result };
}

export interface ApiErrorMapping {
  status: number;
  code: string;
}

export function mapOperatorError(error: unknown): ApiErrorMapping | null {
  if (!(error instanceof Error && error.message.startsWith("Not implemented:"))) {
    return null;
  }
  return { status: 501, code: "NOT_IMPLEMENTED" };
}

export function errorEnvelope(operationId: string, error: unknown): OperatorErrorResponse {
  if (error instanceof Error && error.message.startsWith("Not implemented:")) {
    return { statusCode: 501, body: { operationId, code: "NOT_IMPLEMENTED", result: null } };
  }
  // eslint-disable-next-line no-console -- application boundary: log the error class only; the message may carry caller paths
  console.error(`operator error: ${error instanceof Error ? error.name : typeof error}`);
  return { statusCode: 500, body: { operationId, code: "INTERNAL_ERROR", result: null } };
}
