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

export function errorEnvelope(operationId: string, error: unknown): OperatorErrorResponse {
  if (error instanceof Error && error.message.startsWith("Not implemented:")) {
    return { statusCode: 501, body: { operationId, code: "NOT_IMPLEMENTED", result: null } };
  }
  return { statusCode: 500, body: { operationId, code: "INTERNAL_ERROR", result: null } };
}
