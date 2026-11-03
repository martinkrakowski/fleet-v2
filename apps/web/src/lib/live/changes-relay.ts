/**
 * Server-side relay for the API boundary's `/v1/changes` JSON-lines stream.
 *
 * The web server opens the upstream stream with the bearer it already holds and
 * republishes every parsed signal as a same-origin SSE frame. The browser never
 * sees the token, the upstream `stream` id or the upstream `at` timestamp: a
 * relayed frame carries only `{seq, kind, id}`.
 *
 * This module imports no `node:*` module, so the browser can import its pure
 * helpers; the token is passed in, never read here.
 */

export interface ChangeSignal {
  readonly seq: number;
  readonly kind: string;
  readonly id: string | null;
}

/** null for a keep-alive blank line, an unparseable line, or a line without a
 *  numeric seq and a string kind. */
export function parseChangeSignal(line: string): ChangeSignal | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const record = parsed as { readonly seq?: unknown; readonly kind?: unknown; readonly id?: unknown };
  if (typeof record.seq !== "number" || typeof record.kind !== "string") {
    return null;
  }
  return {
    seq: record.seq,
    kind: record.kind,
    id: typeof record.id === "string" ? record.id : null,
  };
}

/** One SSE frame: "event: change" and a data line carrying only {seq, kind, id}. */
export function toServerSentEvent(signal: ChangeSignal): string {
  return `event: change\ndata: ${JSON.stringify({
    seq: signal.seq,
    kind: signal.kind,
    id: signal.id,
  })}\n\n`;
}

export interface ChangeRelayOptions {
  /** The API origin, no trailing slash. */
  readonly url: string;
  /** The bearer, or null when the web has none. */
  readonly token: string | null;
  readonly fetchImpl?: typeof fetch;
}

export type ChangeRelay =
  | { readonly status: "streaming"; readonly body: ReadableStream<Uint8Array> }
  | { readonly status: "unavailable"; readonly reason: string };

const PLAIN_WORDS = /^[A-Za-z ]{1,80}$/;
const ERROR_CODE = /^[A-Z][A-Z0-9_]{1,40}$/;

/**
 * A host-free reason for a failed request: the raw message can name the API host (an ENOTFOUND
 * message, a URL), and this text reaches the page. Keep only a plain-words message ("fetch failed")
 * and the system error code (ENOTFOUND, ECONNREFUSED), never the original text.
 *
 * Copied from `apps/web/src/lib/api/transport.ts` (this lane may not edit that file).
 */
function describeFailure(error: unknown): string {
  if (!(error instanceof Error)) {
    return "unknown error";
  }
  const words = PLAIN_WORDS.test(error.message) ? error.message : "request failed";
  const cause = (error as { readonly cause?: unknown }).cause;
  const code =
    typeof cause === "object" && cause !== null ? (cause as { readonly code?: unknown }).code : undefined;
  if (typeof code === "string" && ERROR_CODE.test(code)) {
    return words + " (" + code + ")";
  }
  return words;
}

export async function createChangeRelay(
  options: ChangeRelayOptions,
): Promise<ChangeRelay> {
  const { url, token, fetchImpl = fetch } = options;

  const headers: Record<string, string> = {
    accept: "application/x-ndjson",
    cache: "no-store",
  };
  if (token !== null) {
    headers.authorization = `Bearer ${token}`;
  }
  const abort = new AbortController();

  let upstream: Response;
  try {
    upstream = await fetchImpl(`${url}/v1/changes`, {
      headers,
      cache: "no-store",
      signal: abort.signal,
    });
  } catch (error) {
    return {
      status: "unavailable",
      reason: `api boundary is unreachable: ${describeFailure(error)}`,
    };
  }

  if (upstream.status !== 200 || upstream.body === null) {
    return {
      status: "unavailable",
      reason: `the api boundary answered ${upstream.status} for /v1/changes`,
    };
  }

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const enqueueSignal = (signal: ChangeSignal | null) => {
        if (signal !== null) {
          controller.enqueue(encoder.encode(toServerSentEvent(signal)));
        }
      };
      const closeQuietly = () => {
        try {
          controller.close();
        } catch {
          // Already closed by a downstream cancel; nothing to report.
        }
      };
      const readUpstream = async (): Promise<void> => {
        let buffer = "";
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) {
              break;
            }
            buffer += decoder.decode(value, { stream: true });
            let newline = buffer.indexOf("\n");
            while (newline >= 0) {
              const line = buffer.slice(0, newline);
              buffer = buffer.slice(newline + 1);
              enqueueSignal(parseChangeSignal(line));
              newline = buffer.indexOf("\n");
            }
          }
          buffer += decoder.decode();
          enqueueSignal(parseChangeSignal(buffer));
          closeQuietly();
        } catch {
          // The upstream ended or errored: close, never error. The browser
          // reconnects and re-reads.
          closeQuietly();
        }
      };
      void readUpstream();
    },
    cancel() {
      abort.abort();
      void reader.cancel().catch(() => {
        // The upstream is going away either way; nothing to report.
      });
    },
  });

  return { status: "streaming", body };
}
