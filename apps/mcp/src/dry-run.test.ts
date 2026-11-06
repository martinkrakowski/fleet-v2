// Dry-run and preview-digest helper tests (MX6a; plan §3.4.2, D11): the
// digest is a canonical SHA-256 of the body, unaffected by key order, and
// digestMatches only accepts the exact 64-lowercase-hex echo of it.
import { describe, expect, it } from "vitest";
import {
  canonicalRequestBody,
  digestMatches,
  DRY_RUN_DEFAULT,
  previewDigest,
  VALIDATED_SCHEMA_ONLY,
  VALIDATED_SERVER,
} from "./dry-run.js";

describe("dry-run digest helper (D11)", () => {
  it("the digest is 64 lowercase hex characters", () => {
    expect(previewDigest({ a: 1 })).toMatch(/^[0-9a-f]{64}$/);
  });

  it("key order does not change the digest", () => {
    expect(previewDigest({ a: 1, b: 2 })).toBe(
      previewDigest({ b: 2, a: 1 }),
    );
  });

  it("a changed value changes the digest", () => {
    expect(previewDigest({ a: 1 })).not.toBe(previewDigest({ a: 2 }));
  });

  it("nested objects are canonicalised too", () => {
    expect(previewDigest({ x: { b: 1, a: 2 } })).toBe(
      previewDigest({ x: { a: 2, b: 1 } }),
    );
    expect(JSON.parse(canonicalRequestBody({ x: { b: 1, a: 2 } }))).toEqual({
      x: { a: 2, b: 1 },
    });
  });

  it("digestMatches accepts the computed digest", () => {
    const body = { a: 1 };
    expect(digestMatches(previewDigest(body), previewDigest(body))).toBe(true);
  });

  it("digestMatches refuses a different, malformed or missing digest", () => {
    const body = { a: 1 };
    const digest = previewDigest(body);
    const flipped = (digest[0] === "0" ? "1" : "0") + digest.slice(1);
    expect(digestMatches(digest, flipped)).toBe(false);
    expect(digestMatches(digest, "abc")).toBe(false);
    expect(digestMatches(digest, undefined)).toBe(false);
  });

  it("the validated markers are exactly server and schema-only", () => {
    expect(VALIDATED_SERVER).toBe("server");
    expect(VALIDATED_SCHEMA_ONLY).toBe("schema-only");
    expect(DRY_RUN_DEFAULT).toBe(true);
  });
});
