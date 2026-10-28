// Shared HTTP request-input helpers for the /v1 route handlers. Every route
// forwards the parsed request to exactly one bound use case; nothing here
// invents parameters, aliases them or orchestrates across use cases.
import {
  createError,
  getMethod,
  getQuery,
  getRequestHeader,
  readBody,
  readRawBody,
  type H3Event,
} from "h3";

/** A JSON request body or query payload is a plain object, never an array. */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The largest JSON request body any /v1 route reads, in bytes. */
export const MAX_JSON_BODY_BYTES = 64 * 1024;

const PAYLOAD_METHODS: ReadonlySet<string> = new Set(["PATCH", "POST", "PUT", "DELETE"]);
/** h3's own raw-body cache key (h3 1.15.11 dist/index.mjs 363, 368): readBody reuses what is stored here. */
const H3_RAW_BODY = Symbol.for("h3RawBody");

function bodyTooLarge(): Error {
  return createError({ statusCode: 413, statusMessage: "Request body too large" });
}

function declaredLengthExceeds(event: H3Event, limit: number): boolean {
  const value = getRequestHeader(event, "content-length");
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    return false;
  }
  return Number(value) > limit;
}

function announcesBody(event: H3Event): boolean {
  const contentLength = getRequestHeader(event, "content-length");
  if (Number.parseInt(contentLength ?? "", 10) > 0) {
    return true;
  }
  const transferEncoding = getRequestHeader(event, "transfer-encoding");
  return transferEncoding !== undefined && /\bchunked\b/i.test(transferEncoding);
}

function hasAttachedBody(event: H3Event): boolean {
  const req = event.node.req as unknown as Record<string | symbol, unknown>;
  return Boolean(
    event._requestBody ||
      event.web?.request?.body ||
      req[H3_RAW_BODY] ||
      req.rawBody ||
      req.body,
  );
}

function collectAtMost(stream: NodeJS.ReadableStream, limit: number): Promise<Buffer | undefined> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let total = 0;
    const chunks: Buffer[] = [];
    const onData = (chunk: unknown) => {
      if (settled) {
        return;
      }
      total += Buffer.byteLength(chunk as Buffer);
      if (total > limit) {
        settled = true;
        chunks.length = 0;
        reject(bodyTooLarge());
        return;
      }
      chunks.push(Buffer.from(chunk as Buffer));
    };
    const onEnd = () => {
      if (!settled) {
        settled = true;
        resolve(Buffer.concat(chunks));
      }
    };
    const onStop = () => {
      if (!settled) {
        settled = true;
        resolve(undefined);
      }
    };
    stream.on("data", onData);
    stream.on("end", onEnd);
    stream.on("error", onStop);
    stream.on("close", onStop);
  });
}

/**
 * The request body's bytes, refused with 413 past `limit`: a declared content-length over the limit is
 * refused before any byte is read, and the bytes actually received are counted, so a chunked or
 * understated body is refused as soon as it passes the limit. A non-payload method or no announced body is
 * undefined. The bytes are stored in h3's raw-body cache so readBody parses exactly these bytes.
 */
export async function readBoundedRawBody(event: H3Event, limit: number): Promise<Buffer | undefined> {
  if (!PAYLOAD_METHODS.has(getMethod(event))) {
    return undefined;
  }
  if (declaredLengthExceeds(event, limit)) {
    throw bodyTooLarge();
  }
  if (hasAttachedBody(event)) {
    const attached = await readRawBody(event, false).catch(() => undefined);
    if (attached !== undefined && attached.byteLength > limit) {
      throw bodyTooLarge();
    }
    return attached;
  }
  if (!announcesBody(event)) {
    return undefined;
  }
  const bytes = await collectAtMost(event.node.req, limit);
  if (bytes instanceof Buffer) {
    (event.node.req as unknown as Record<symbol, unknown>)[H3_RAW_BODY] = Promise.resolve(bytes);
  }
  return bytes;
}

/**
 * Read the request body as a JSON object. An absent body resolves to `{}` so a
 * configured runtime answers the use case's own validation; a non-object body
 * (primitive or array) or a body that is not valid JSON is a client error (400),
 * never a silent empty request. A body
 * over `MAX_JSON_BODY_BYTES` is refused with 413 before it is parsed.
 */
export async function readObjectBody(event: H3Event): Promise<Record<string, unknown>> {
  const raw = await readBoundedRawBody(event, MAX_JSON_BODY_BYTES);
  if (raw === undefined || raw.byteLength === 0) {
    return {};
  }
  // Owner decision 2026-10-27: a body that is present but is not valid JSON is a
  // client error (400), never a silent empty request. The body is never echoed.
  let body: unknown;
  try {
    body = await readBody(event);
  } catch {
    throw createError({ statusCode: 400, statusMessage: "Invalid JSON body" });
  }
  if (body === undefined || body === null || body === "") {
    return {};
  }
  if (isPlainObject(body)) {
    const rest = { ...body };
    delete rest.nowIso;
    return rest;
  }
  throw createError({ statusCode: 400, statusMessage: "Invalid JSON object body" });
}

/** The parsed query as a plain record with wire timestamps stripped. */
export function readQueryRecord(event: H3Event): Record<string, unknown> {
  const rest = { ...(getQuery(event) as Record<string, unknown>) };
  delete rest.nowIso;
  return rest;
}
