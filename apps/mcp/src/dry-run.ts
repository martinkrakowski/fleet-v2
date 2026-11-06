// The dry-run and preview-digest helper for mutating MCP tools
// (MCP tooling plan §3.4.2, D11). A tool computes the digest of the body it
// would write, returns it with the preview, and a write must echo the same
// digest back. Nothing here calls the API.

import { createHash, timingSafeEqual } from "node:crypto";
import { Buffer } from "node:buffer";

/** `dry_run` defaults to true (D11). */
export const DRY_RUN_DEFAULT = true;

/** The server ran the same validation a write would run (D11). */
export const VALIDATED_SERVER = "server";

/** Only the tool's own schema was checked (D11). */
export const VALIDATED_SCHEMA_ONLY = "schema-only";

export type Validated = typeof VALIDATED_SERVER | typeof VALIDATED_SCHEMA_ONLY;

const HEX_DIGEST_PATTERN = /^[0-9a-f]{64}$/;

/**
 * Rebuild `value` so that JSON.stringify of it is canonical: object keys are
 * sorted with the default string sort at every level, arrays keep their
 * order, `undefined` object members are dropped, and `undefined` as the whole
 * body is treated as `null`.
 */
function canonicalize(value: unknown): unknown {
  if (value === undefined) {
    return null;
  }
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .map(([key, entry]) => [key, canonicalize(entry)] as const)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return Object.fromEntries(entries);
  }
  return value;
}

/** Canonical JSON of a request body: object keys sorted at every level, arrays in order, no whitespace. */
export function canonicalRequestBody(body: unknown): string {
  return JSON.stringify(canonicalize(body));
}

/** SHA-256 of the canonical body: 64 lowercase hex digits. */
export function previewDigest(body: unknown): string {
  return createHash("sha256")
    .update(canonicalRequestBody(body), "utf8")
    .digest("hex");
}

/** True only when `echoed` is exactly `expected` (both 64 lowercase hex digits). */
export function digestMatches(expected: string, echoed: string | undefined): boolean {
  if (typeof echoed !== "string" || !HEX_DIGEST_PATTERN.test(echoed)) {
    return false;
  }
  if (typeof expected !== "string" || !HEX_DIGEST_PATTERN.test(expected)) {
    return false;
  }
  return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(echoed, "hex"));
}
