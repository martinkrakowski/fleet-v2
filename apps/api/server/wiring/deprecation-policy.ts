// If a later unit stores these records it must write schemaVersion: 1, read an absent schemaVersion as 1 forever, and refuse an unknown schemaVersion with StateFileUnknownVersionError (bytes untouched, nothing quarantined).

import { normalizePath } from "./route-scopes.js";

const MAX_ENTRIES = 256;
const MAX_PATH_CHARS = 256;
const MAX_PATH_SEGMENTS = 64;

const ALLOWED_METHODS: ReadonlySet<string> = new Set([
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
]);

const ALLOWED_ENTRY_KEYS: ReadonlySet<string> = new Set([
  "method",
  "path",
  "deprecatedAtMs",
  "sunsetAtMs",
  "successorPath",
]);

export interface DeprecationEntry {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  deprecatedAtMs: number;
  sunsetAtMs?: number;
  successorPath?: string;
}

export interface DeprecationHeaders {
  deprecation?: string;
  sunset?: string;
  link?: string;
}

export type DeprecationTableResult =
  | { ok: true; table: readonly DeprecationEntry[] }
  | { ok: false; reason: string };

export const API_DEPRECATIONS: readonly DeprecationEntry[] = Object.freeze(
  [] as readonly DeprecationEntry[],
);

function refuse(reason: string): { ok: false; reason: string } {
  return { ok: false, reason };
}

function isAccessorDescriptor(desc: PropertyDescriptor): boolean {
  return "get" in desc || "set" in desc;
}

function isForbiddenKey(key: string): boolean {
  return key === "__proto__" || key === "constructor" || key === "prototype";
}

function isPlainRecord(value: unknown): value is object {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isAllowedMethod(value: unknown): value is DeprecationEntry["method"] {
  return typeof value === "string" && ALLOWED_METHODS.has(value);
}

// Cost bound: one scan, and the caller already capped the string at 256 characters.
function hasControlChar(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) {
      return true;
    }
  }
  return false;
}

// Cost bound: stops once the count passes 64, so a long slash run is not fully scanned.
function segmentCount(path: string): number {
  let count = 1;
  for (let i = 0; i < path.length; i++) {
    if (path.charCodeAt(i) === 47) {
      count += 1;
      if (count > MAX_PATH_SEGMENTS) {
        return count;
      }
    }
  }
  return count;
}

function isValidRoutePath(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_PATH_CHARS) {
    return false;
  }
  if (value[0] !== "/") {
    return false;
  }
  if (segmentCount(value) > MAX_PATH_SEGMENTS) {
    return false;
  }
  if (
    value.includes("..") ||
    value.includes("?") ||
    value.includes("#") ||
    value.includes("\\")
  ) {
    return false;
  }
  return !hasControlChar(value);
}

function isValidSuccessorPath(value: unknown): value is string {
  if (typeof value !== "string" || value.length > MAX_PATH_CHARS || !value.startsWith("/v1/")) {
    return false;
  }
  if (value.includes(">") || hasControlChar(value) || /\s/.test(value)) {
    return false;
  }
  return true;
}

function readArrayLength(
  table: object,
): { ok: true; length: number } | { ok: false; reason: string } {
  const desc = Object.getOwnPropertyDescriptor(table, "length");
  if (desc === undefined || isAccessorDescriptor(desc)) {
    return refuse("table-accessor");
  }
  const length = desc.value;
  if (
    typeof length !== "number" ||
    !Number.isSafeInteger(length) ||
    length < 0 ||
    length > MAX_ENTRIES
  ) {
    return refuse("table-too-large");
  }
  return { ok: true, length };
}

function validateEntry(
  entry: unknown,
):
  | { ok: true; entry: DeprecationEntry; method: DeprecationEntry["method"]; path: string }
  | { ok: false; reason: string } {
  if (!isPlainRecord(entry)) {
    return refuse("entry-not-plain");
  }
  const keys = Reflect.ownKeys(entry);
  // More than the five known fields cannot be a valid entry. Refuse before reading values.
  if (keys.length > ALLOWED_ENTRY_KEYS.size) {
    return refuse("entry-unknown-key");
  }
  const fields = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    const desc = Object.getOwnPropertyDescriptor(entry, key);
    if (desc === undefined || isAccessorDescriptor(desc)) {
      return refuse("entry-accessor");
    }
    if (typeof key !== "string" || isForbiddenKey(key)) {
      return refuse("entry-forbidden-key");
    }
    if (!ALLOWED_ENTRY_KEYS.has(key)) {
      return refuse("entry-unknown-key");
    }
    fields[key] = desc.value;
  }
  const method = fields.method;
  if (!isAllowedMethod(method)) {
    return refuse("method-invalid");
  }
  const path = fields.path;
  if (!isValidRoutePath(path)) {
    return refuse("path-invalid");
  }
  const deprecatedAtMs = fields.deprecatedAtMs;
  if (!isNonNegativeSafeInteger(deprecatedAtMs)) {
    return refuse("deprecated-at-invalid");
  }
  const sanitized: DeprecationEntry = {
    method,
    path,
    deprecatedAtMs,
  };
  const sunsetAtMs = fields.sunsetAtMs;
  if (sunsetAtMs !== undefined) {
    if (!isNonNegativeSafeInteger(sunsetAtMs)) {
      return refuse("sunset-at-invalid");
    }
    if (sunsetAtMs <= deprecatedAtMs) {
      return refuse("sunset-at-invalid");
    }
    sanitized.sunsetAtMs = sunsetAtMs;
  }
  const successorPath = fields.successorPath;
  if (successorPath !== undefined) {
    if (!isValidSuccessorPath(successorPath)) {
      return refuse("successor-path-invalid");
    }
    sanitized.successorPath = successorPath;
  }
  return { ok: true, entry: sanitized, method, path };
}

// Cost bound: one pass over at most 256 entries and at most 64 path segments per call.
export function validateDeprecationTable(table: unknown): DeprecationTableResult {
  if (!Array.isArray(table)) {
    return refuse("table-not-array");
  }
  const lengthResult = readArrayLength(table);
  if (!lengthResult.ok) {
    return lengthResult;
  }
  const rows: DeprecationEntry[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < lengthResult.length; i++) {
    if (!Object.prototype.hasOwnProperty.call(table, i)) {
      return refuse("table-hole");
    }
    const desc = Object.getOwnPropertyDescriptor(table, i);
    if (desc === undefined || isAccessorDescriptor(desc)) {
      return refuse("table-accessor");
    }
    const validated = validateEntry(desc.value);
    if (!validated.ok) {
      return validated;
    }
    const routeKey = validated.method + "\0" + validated.path;
    if (seen.has(routeKey)) {
      return refuse("duplicate-route");
    }
    seen.add(routeKey);
    rows.push(validated.entry);
  }
  return { ok: true, table: rows };
}

function normalizeRequestPath(requestPath: string): string {
  return normalizePath(requestPath).replace(/\/+/g, "/");
}

function requestMatchesEntry(entryPath: string, normalizedRequest: string): boolean {
  const entrySegments = entryPath.split("/");
  const requestSegments = normalizedRequest.split("/");
  if (
    entrySegments.length !== requestSegments.length ||
    entrySegments.length > MAX_PATH_SEGMENTS
  ) {
    return false;
  }
  for (let i = 0; i < entrySegments.length; i++) {
    const expected = entrySegments[i] ?? "";
    const actual = requestSegments[i] ?? "";
    if (expected.startsWith(":") && expected.length > 1) {
      if (actual.length === 0) {
        return false;
      }
      continue;
    }
    if (expected !== actual) {
      return false;
    }
  }
  return true;
}

function headersForEntry(entry: DeprecationEntry, nowMs: number): DeprecationHeaders {
  // Sent whether nowMs is before or after deprecatedAtMs.
  const headers: DeprecationHeaders = {
    deprecation: "@" + String(Math.floor(entry.deprecatedAtMs / 1000)),
  };
  if (entry.sunsetAtMs !== undefined) {
    headers.sunset = new Date(entry.sunsetAtMs).toUTCString();
  }
  if (entry.successorPath !== undefined) {
    headers.link = `<${entry.successorPath}>; rel="successor-version"`;
  }
  if (nowMs < entry.deprecatedAtMs) {
    return headers;
  }
  return headers;
}

export function deprecationHeadersFor(
  method: string,
  requestPath: string,
  table: readonly DeprecationEntry[],
  nowMs: number,
): DeprecationHeaders {
  if (typeof method !== "string" || typeof requestPath !== "string") {
    return {};
  }
  const validated = validateDeprecationTable(table);
  if (!validated.ok) {
    return {};
  }
  // Cost bound: one normalize and slash-collapse of the request, then one pass
  // over at most 256 entries and at most 64 path segments.
  const normalized = normalizeRequestPath(requestPath);
  if (segmentCount(normalized) > MAX_PATH_SEGMENTS) {
    return {};
  }
  for (const entry of validated.table) {
    // method matching is exact and case-sensitive ("get" vs "GET" matches nothing).
    if (entry.method !== method) {
      continue;
    }
    if (!requestMatchesEntry(entry.path, normalized)) {
      continue;
    }
    return headersForEntry(entry, nowMs);
  }
  return {};
}
