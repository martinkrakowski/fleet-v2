import { send, setResponseHeader, setResponseStatus } from "h3";
import { defineNitroErrorHandler } from "nitropack/runtime";

/** The fixed reason phrase for a 4xx code the handler knows; any other 4xx answers "Request Error". */
const REASON_PHRASES: Readonly<Record<number, string>> = {
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  405: "Method Not Allowed",
  409: "Conflict",
  413: "Payload Too Large",
  415: "Unsupported Media Type",
  422: "Unprocessable Entity",
  429: "Too Many Requests",
};

/**
 * True when `value` holds a control character the response body must never carry:
 * C0 (U+0000–U+001F), DEL (U+007F), C1 (U+0080–U+009F), U+2028 or U+2029.
 */
function hasForbiddenControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codePoint = value.codePointAt(index);
    if (
      codePoint !== undefined &&
      (codePoint <= 0x1f ||
        codePoint === 0x7f ||
        (codePoint >= 0x80 && codePoint <= 0x9f) ||
        codePoint === 0x2028 ||
        codePoint === 0x2029)
    ) {
      return true;
    }
  }
  return false;
}

/** A statusMessage the body may carry verbatim: non-empty, at most 200 characters, no control characters. */
function isAcceptableStatusMessage(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 200 &&
    !hasForbiddenControlCharacter(value)
  );
}

/** The only fields an @fleet/api error body may carry. */
export function errorBody(error: { statusCode?: unknown; statusMessage?: unknown }): {
  statusCode: number;
  statusMessage: string;
} {
  const statusCode =
    typeof error.statusCode === "number" &&
    Number.isInteger(error.statusCode) &&
    error.statusCode >= 400 &&
    error.statusCode <= 599
      ? error.statusCode
      : 500;

  let statusMessage: string;
  if (statusCode >= 500) {
    statusMessage = "Internal Server Error";
  } else if (statusCode === 404 || statusCode === 405) {
    // h3's own 404 and 405 name the path or the method ("Cannot find any route matching <path>",
    // "Method <m> is not allowed on this route."): never echo them.
    statusMessage = REASON_PHRASES[statusCode] ?? "Request Error";
  } else if (isAcceptableStatusMessage(error.statusMessage)) {
    statusMessage = error.statusMessage;
  } else {
    statusMessage = REASON_PHRASES[statusCode] ?? "Request Error";
  }

  return { statusCode, statusMessage };
}

export default defineNitroErrorHandler((error, event) => {
  // A response already sent (or streamed) cannot be rewritten; returning keeps Nitro's default
  // handler, which echoes the URL, from running after a throw here.
  if (event.handled) {
    return;
  }
  const body = errorBody(error);
  setResponseStatus(event, body.statusCode, body.statusMessage);
  setResponseHeader(event, "content-type", "application/json; charset=utf-8");
  return send(event, JSON.stringify(body));
});
