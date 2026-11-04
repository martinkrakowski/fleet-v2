/**
 * A host-free reason for a failed request: the raw message can name the API host (an ENOTFOUND
 * message, a URL), and this text reaches the page. Keep only a plain-words message ("fetch failed")
 * and the system error code (ENOTFOUND, ECONNREFUSED), never the original text.
 *
 * Shared by the API transport and the live change relay.
 */

const PLAIN_WORDS = /^[A-Za-z ]{1,80}$/;
const ERROR_CODE = /^[A-Z][A-Z0-9_]{1,40}$/;

export function describeFailure(error: unknown): string {
  if (!(error instanceof Error)) {
    return "unknown error";
  }
  const words = PLAIN_WORDS.test(error.message)
    ? error.message
    : "request failed";
  const cause = (error as { readonly cause?: unknown }).cause;
  const code =
    typeof cause === "object" && cause !== null
      ? (cause as { readonly code?: unknown }).code
      : undefined;
  if (typeof code === "string" && ERROR_CODE.test(code)) {
    return words + " (" + code + ")";
  }
  return words;
}
