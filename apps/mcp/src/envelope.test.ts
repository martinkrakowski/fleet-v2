// Envelope-mapping tests: success → pretty JSON capped at 256 KiB with a
// truncation marker; failure → isError payload with code, message and
// operationId when present, and nothing else.
import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import {
  capResultText,
  errorPayload,
  MAX_RESULT_BYTES,
  toResourceResult,
  toToolResult,
  TRUNCATION_MARKER,
} from "./envelope.js";

const OK_ENVELOPE = {
  operationId: "op-1",
  code: "OK",
  result: { outstanding: [{ id: "wo-1" }] },
};

describe("toToolResult", () => {
  it("maps a successful envelope to pretty-printed JSON content", () => {
    const result = toToolResult(OK_ENVELOPE);
    expect(result.isError).toBeUndefined();
    expect(result.content).toEqual([
      { type: "text", text: JSON.stringify(OK_ENVELOPE, null, 2) },
    ]);
  });

  it("maps a client failure to isError with code, message and operationId", () => {
    const result = toToolResult({
      ok: false,
      code: "INTERNAL_ERROR",
      message: "API request failed.",
      operationId: "op-9",
    });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]?.text ?? "")).toEqual({
      code: "INTERNAL_ERROR",
      message: "API request failed.",
      operationId: "op-9",
    });
  });

  it("carries only the error fields — never a token, URL or raw body", () => {
    const result = toToolResult({
      ok: false,
      code: "transport-error",
      message: "API unreachable.",
    });
    const parsed = JSON.parse(result.content[0]?.text ?? "") as Record<
      string,
      unknown
    >;
    expect(Object.keys(parsed).sort()).toEqual(["code", "message"]);
  });
});

describe("toResourceResult", () => {
  it("maps a successful envelope to JSON resource contents at the given URI", () => {
    const result = toResourceResult(OK_ENVELOPE, "fleet://coordination");
    expect(result.contents).toEqual([
      {
        uri: "fleet://coordination",
        mimeType: "application/json",
        text: JSON.stringify(OK_ENVELOPE, null, 2),
      },
    ]);
  });

  it("maps a client failure to the error payload as contents", () => {
    const result = toResourceResult(
      { ok: false, code: "timeout", message: "API unreachable: request timed out." },
      "fleet://capabilities",
    );
    expect(result.contents[0]?.uri).toBe("fleet://capabilities");
    expect(JSON.parse(result.contents[0]?.text ?? "")).toEqual({
      code: "timeout",
      message: "API unreachable: request timed out.",
    });
  });
});

describe("errorPayload", () => {
  it("includes operationId only when present", () => {
    expect(
      errorPayload({ ok: false, code: "a", message: "b", operationId: "op-3" }),
    ).toEqual({ code: "a", message: "b", operationId: "op-3" });
    expect(errorPayload({ ok: false, code: "a", message: "b" })).toEqual({
      code: "a",
      message: "b",
    });
  });
});

describe("capResultText", () => {
  it("leaves text under the cap untouched", () => {
    const text = JSON.stringify(OK_ENVELOPE, null, 2);
    expect(capResultText(text)).toBe(text);
    expect(text.endsWith(TRUNCATION_MARKER)).toBe(false);
  });

  it("caps oversized text at 256 KiB and appends the marker", () => {
    const text = JSON.stringify(
      { operationId: "op-1", code: "OK", result: { blob: "x".repeat(400 * 1024) } },
      null,
      2,
    );
    const capped = capResultText(text);
    expect(Buffer.byteLength(capped, "utf8")).toBeLessThanOrEqual(
      MAX_RESULT_BYTES,
    );
    expect(capped.endsWith(TRUNCATION_MARKER)).toBe(true);
    expect(capped.startsWith(text.slice(0, 64))).toBe(true);
  });

  it("caps by UTF-8 bytes, not characters", () => {
    // 200 000 two-byte characters = 400 000 bytes: over the cap even though
    // well under 256 Ki *characters*.
    const text = JSON.stringify(
      { result: { blob: "é".repeat(200_000) } },
      null,
      2,
    );
    const capped = capResultText(text);
    expect(text.length).toBeLessThan(MAX_RESULT_BYTES);
    expect(Buffer.byteLength(capped, "utf8")).toBeLessThanOrEqual(
      MAX_RESULT_BYTES,
    );
    expect(capped.endsWith(TRUNCATION_MARKER)).toBe(true);
  });

  it("does not split a surrogate pair at the cut point", () => {
    const text = JSON.stringify(
      { result: { blob: "🎯".repeat(100_000) } },
      null,
      2,
    );
    const capped = capResultText(text);
    const prefix = capped.slice(0, capped.length - TRUNCATION_MARKER.length);
    // A truncated prefix must not end with an unpaired high surrogate.
    expect(prefix).not.toMatch(/[\uD800-\uDBFF]$/);
    expect(Buffer.byteLength(capped, "utf8")).toBeLessThanOrEqual(
      MAX_RESULT_BYTES,
    );
  });
});
