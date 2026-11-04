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

import { describeFailure } from "../api/describe-failure";

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
  const record = parsed as {
    readonly seq?: unknown;
    readonly kind?: unknown;
    readonly id?: unknown;
  };
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
    upstream = await fetchImpl(`${url.replace(/\/+$/, "")}/v1/changes`, {
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
    abort.abort();
    try {
      await upstream.body?.cancel();
    } catch {
      // The upstream is discarded; cancel failure never changes the result.
    }
    return {
      status: "unavailable",
      reason: `the api boundary answered ${upstream.status} for /v1/changes`,
    };
  }

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  let buffer = "";
  let finished = false;
  // Every complete line in the buffer becomes a frame; returns whether any frame was enqueued.
  const drainLines = (
    controller: ReadableStreamDefaultController<Uint8Array>,
  ): boolean => {
    let enqueued = false;
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const signal = parseChangeSignal(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      if (signal !== null) {
        controller.enqueue(encoder.encode(toServerSentEvent(signal)));
        enqueued = true;
      }
      newline = buffer.indexOf("\n");
    }
    return enqueued;
  };
  const closeQuietly = (
    controller: ReadableStreamDefaultController<Uint8Array>,
  ) => {
    try {
      controller.close();
    } catch {
      // Already closed by a downstream cancel; nothing to report.
    }
  };

  // Pull-based: the upstream is read only when the consumer asks for more, so a slow or stalled browser applies
  // backpressure to the API stream instead of growing an unbounded queue of frames.
  const body = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        if (finished) {
          closeQuietly(controller);
          return;
        }
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) {
              buffer += decoder.decode() + "\n";
              drainLines(controller);
              finished = true;
              closeQuietly(controller);
              return;
            }
            buffer += decoder.decode(value, { stream: true });
            if (drainLines(controller)) {
              return;
            }
          }
        } catch {
          // The upstream ended or errored: close, never error. The browser reconnects and re-reads.
          finished = true;
          closeQuietly(controller);
        }
      },
      cancel() {
        finished = true;
        abort.abort();
        void reader.cancel().catch(() => {
          // The upstream is going away either way; nothing to report.
        });
      },
    },
    { highWaterMark: 1 },
  );

  return { status: "streaming", body };
}
