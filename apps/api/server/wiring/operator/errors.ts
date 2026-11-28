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

const NOT_IMPLEMENTED_PREFIX = "Not implemented:";

/** A safe `instanceof Error`: a hostile Proxy may throw from `getPrototypeOf`. */
function isErrorInstance(value: unknown): boolean {
  try {
    return value instanceof Error;
  } catch {
    return false;
  }
}

/**
 * Single own-property descriptor lookup, O(1). Never invokes `get` or `has`
 * traps or prototype getters; a hostile Proxy trap that throws yields
 * `undefined`.
 */
function readOwnDataDescriptor(target: object, key: string): unknown {
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(target, key);
  } catch {
    return undefined;
  }
  return descriptor !== undefined && Object.prototype.hasOwnProperty.call(descriptor, "value")
    ? descriptor.value
    : undefined;
}

function readOwnString(target: object, key: string): string | null {
  const value = readOwnDataDescriptor(target, key);
  return typeof value === "string" ? value : null;
}

function readOwnClientStatusCode(target: object, key: string): number | null {
  const value = readOwnDataDescriptor(target, key);
  return typeof value === "number" && Number.isInteger(value) && value >= 400 && value <= 499
    ? value
    : null;
}

/** O(16): slices at most 16 code units, never scans or copies a large message. */
function isNotImplementedError(error: unknown): boolean {
  if (!isErrorInstance(error)) {
    return false;
  }
  const message = readOwnString(error as object, "message");
  return message !== null && message.slice(0, NOT_IMPLEMENTED_PREFIX.length) === NOT_IMPLEMENTED_PREFIX;
}

/**
 * Log-safe class label: walks at most 8 prototypes and accepts only an own
 * data-descriptor string `name` matching a plain identifier shape; inherited
 * class getters never run and any other value falls back to "Error".
 */
function safeErrorName(error: object): string | null {
  let current: object | null = error;
  for (let depth = 0; depth < 8 && current !== null; depth += 1) {
    const name = readOwnString(current, "name");
    if (name !== null) {
      return /^[A-Za-z][A-Za-z0-9_$]{0,63}$/.test(name) ? name : null;
    }
    try {
      current = Object.getPrototypeOf(current);
    } catch {
      return null;
    }
  }
  return null;
}

function errorLabel(error: unknown): string {
  if (!isErrorInstance(error)) {
    return typeof error;
  }
  return safeErrorName(error as object) ?? "Error";
}

export function mapOperatorError(error: unknown): ApiErrorMapping | null {
  if (!isNotImplementedError(error)) {
    return null;
  }
  return { status: 501, code: "NOT_IMPLEMENTED" };
}

/** A use case refused the request on its own terms: a client error, not a fault. */
export function refusedEnvelope(operationId: string, reason: string): OperatorErrorResponse {
  return { statusCode: 422, body: { operationId, code: "REFUSED", result: { reason } } };
}

/** The presenting token may not perform this operation: a client error, never a fault. */
export function forbiddenEnvelope(operationId: string, reason: string): OperatorErrorResponse {
  return { statusCode: 403, body: { operationId, code: "FORBIDDEN", result: { reason } } };
}

/** Known absence: the named aggregate does not exist. */
export function notFoundEnvelope(operationId: string): OperatorErrorResponse {
  return { statusCode: 404, body: { operationId, code: "NOT_FOUND", result: null } };
}

export function errorEnvelope(operationId: string, error: unknown): OperatorErrorResponse {
  if (isNotImplementedError(error)) {
    return { statusCode: 501, body: { operationId, code: "NOT_IMPLEMENTED", result: null } };
  }
  if (typeof error === "object" && error !== null) {
    const statusCode = readOwnClientStatusCode(error, "statusCode");
    if (statusCode !== null) {
      return {
        statusCode,
        body: { operationId, code: "BAD_REQUEST", result: null },
      };
    }
  }
  // eslint-disable-next-line no-console -- application boundary: log the error class only; the message may carry caller paths
  console.error(`operator error: ${errorLabel(error)}`);
  return { statusCode: 500, body: { operationId, code: "INTERNAL_ERROR", result: null } };
}
