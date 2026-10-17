// Maps /v1 client results to MCP results (work order item 3).
//
// A successful /v1 envelope becomes MCP content holding the envelope as
// pretty-printed JSON, capped at 256 KiB and truncated with an explicit
// marker. A client failure becomes an error payload with the envelope's
// code, message and operationId when present — never the token, the URL's
// userinfo or the raw HTTP body: only the fields below are serialized.
import { Buffer } from "node:buffer";
import type { ApiClientError, ApiClientResult } from "./client.js";

/** MCP `content` entry; the only kind this server produces is text. */
export interface McpTextContent {
  type: "text";
  text: string;
}

/** MCP `CallToolResult`, treated structurally (the SDK is loaded at runtime). */
export interface McpToolResult {
  content: McpTextContent[];
  isError?: boolean;
}

/** MCP resource `contents` entry, treated structurally. */
export interface McpResourceContents {
  uri: string;
  mimeType: "application/json";
  text: string;
}

/** MCP `ReadResourceResult`, treated structurally. */
export interface McpResourceResult {
  contents: McpResourceContents[];
}

/** Hard cap for any text this server returns, in UTF-8 bytes. */
export const MAX_RESULT_BYTES = 256 * 1024;

export const TRUNCATION_MARKER = "\n[fleet-v2-mcp: truncated at 256 KiB]";

/** Cap text at `MAX_RESULT_BYTES` bytes, appending the truncation marker when cut. */
export function capResultText(text: string): string {
  if (Buffer.byteLength(text, "utf8") <= MAX_RESULT_BYTES) {
    return text;
  }
  const budget = MAX_RESULT_BYTES - Buffer.byteLength(TRUNCATION_MARKER, "utf8");
  let lo = 1;
  let hi = text.length;
  let best = 0;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (Buffer.byteLength(text.slice(0, mid), "utf8") <= budget) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  // Never split a UTF-16 surrogate pair at the cut point.
  if (best > 0) {
    const code = text.charCodeAt(best - 1);
    if (code >= 0xd800 && code <= 0xdbff) {
      best -= 1;
    }
  }
  return text.slice(0, best) + TRUNCATION_MARKER;
}

function isFailure(result: ApiClientResult): result is ApiClientError {
  return "ok" in result && result.ok === false;
}

/** The JSON payload for a client failure: code, message, operationId when present. */
export function errorPayload(error: ApiClientError): Record<string, string> {
  const payload: Record<string, string> = {
    code: error.code,
    message: error.message,
  };
  if (error.operationId !== undefined) {
    payload.operationId = error.operationId;
  }
  return payload;
}

/** Map a `/v1` client result to a tool result. */
export function toToolResult(result: ApiClientResult): McpToolResult {
  if (isFailure(result)) {
    return {
      content: [
        { type: "text", text: capResultText(JSON.stringify(errorPayload(result), null, 2)) },
      ],
      isError: true,
    };
  }
  return {
    content: [{ type: "text", text: capResultText(JSON.stringify(result, null, 2)) }],
  };
}

/**
 * Map a `/v1` client result to a resource result. MCP resources have no
 * isError channel, so a client failure is returned as the error payload
 * itself: a failure is never rendered as coordination data.
 */
export function toResourceResult(
  result: ApiClientResult,
  uri: string,
): McpResourceResult {
  const text = isFailure(result)
    ? capResultText(JSON.stringify(errorPayload(result), null, 2))
    : capResultText(JSON.stringify(result, null, 2));
  return { contents: [{ uri, mimeType: "application/json", text }] };
}
