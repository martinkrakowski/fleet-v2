// Shared HTTP request-input helpers for the /v1 route handlers. Every route
// forwards the parsed request to exactly one bound use case; nothing here
// invents parameters, aliases them or orchestrates across use cases.
import { createError, getQuery, readBody, type H3Event } from "h3";

/** A JSON request body or query payload is a plain object, never an array. */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Read the request body as a JSON object. An absent body resolves to `{}` so a
 * configured runtime answers the use case's own validation; a non-object body
 * (primitive or array) is a client error, never a silent empty request.
 */
export async function readObjectBody(event: H3Event): Promise<Record<string, unknown>> {
  const body = await readBody(event).catch(() => undefined);
  if (body === undefined || body === null || body === "") {
    return {};
  }
  if (isPlainObject(body)) {
    return body;
  }
  throw createError({ statusCode: 400, statusMessage: "Invalid JSON object body" });
}

/** The parsed query as a plain record, forwarded without renaming. */
export function readQueryRecord(event: H3Event): Record<string, unknown> {
  return getQuery(event) as Record<string, unknown>;
}
