// Lane OT3b-2: the real OTLP/HTTP transport behind the adapter's `OtlpPost`
// seam (plan §3.5 "Send", §3.9): the endpoint loopback rule, the token-file
// read, one fetch POST with `AbortSignal.timeout`, and the retry/deadline
// wrapper. Nothing here logs, echoes an endpoint, a token, a header or a body:
// every failure is reported as a fixed reason string or a fixed outcome kind,
// and the token exists only inside a single send's local scope (§3.9 "never
// committed, never logged").
/**
 * Transport helpers for `OtlpHttpRunTelemetryAdapter`:
 *
 * - `checkOtlpEndpoint` — the pure endpoint rule: `https:` anywhere, `http:`
 *   only to the loopback hosts `127.0.0.1` and `[::1]`, no credentials, no
 *   other scheme.
 * - `readOtlpTokenFile` — one `node:fs` read of the bearer token file; the
 *   token is never logged, never placed in a reason and never returned from
 *   any other function.
 * - `createFetchOtlpPost` — one POST of the payload with a timeout signal
 *   (optionally combined with a stop signal); the result is an `OtlpPostOutcome`
 *   that carries no request or response text.
 * - `withOtlpRetry` — retries 429/502/503/504 at most twice (1 s then 4 s, or
 *   `Retry-After` capped at 30 s) and never sleeps or posts past the deadline.
 * - `otlpRetrySleep` — the retry wait: a `setTimeout` that is `unref()`'d so a
 *   pending wait never holds the event loop open (plan §3.3 "Exporter
 *   lifetime").
 */

import { readFileSync } from 'node:fs';
import type {
  RunTelemetrySendDeadline,
} from '../../application/ports/out/RunTelemetryPort.out-port.js';
import type { OtlpPost, OtlpPostOutcome } from './OtlpHttpRunTelemetryAdapter.adapter.js';

/** Fixed refusal reasons: they never echo the refused input (plan §3.9). */
export type OtlpEndpointCheck =
  | { ok: true; url: URL }
  | { ok: false; reason: 'endpoint-invalid' | 'endpoint-needs-https' };

/** The loopback hostnames `http:` may target (plan §3.5 "Transport safety"). */
const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', '[::1]']);

/**
 * Validates an operator-supplied endpoint string (plan §3.5 "Transport
 * safety"): it must parse as a URL, carry no username or password, and be
 * either `https:` anywhere or `http:` to exactly `127.0.0.1` or `[::1]`.
 * Every other scheme is refused. The reasons are fixed strings; the input is
 * never echoed back.
 */
export function checkOtlpEndpoint(raw: unknown): OtlpEndpointCheck {
  if (typeof raw !== 'string' || raw.length === 0) {
    return { ok: false, reason: 'endpoint-invalid' };
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: 'endpoint-invalid' };
  }
  if (url.username !== '' || url.password !== '') {
    return { ok: false, reason: 'endpoint-invalid' };
  }
  if (url.protocol === 'https:') {
    return { ok: true, url };
  }
  if (url.protocol === 'http:' && LOOPBACK_HOSTNAMES.has(url.hostname)) {
    return { ok: true, url };
  }
  if (url.protocol === 'http:') {
    return { ok: false, reason: 'endpoint-needs-https' };
  }
  return { ok: false, reason: 'endpoint-invalid' };
}

/** Fixed refusal reasons for the token file; they never carry file content. */
export type OtlpTokenFileRead =
  | { ok: true; token: string }
  | { ok: false; reason: 'token-file-unreadable' | 'token-empty' };

/**
 * Reads the bearer token file once with `node:fs` at build time (plan §3.9):
 * trailing whitespace is trimmed, and an empty token or one that still
 * contains a newline or a space is refused. The token is returned only here;
 * it is never logged, never placed in a reason and never exposed elsewhere.
 */
export function readOtlpTokenFile(path: unknown): OtlpTokenFileRead {
  if (typeof path !== 'string' || path.length === 0) {
    return { ok: false, reason: 'token-file-unreadable' };
  }
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return { ok: false, reason: 'token-file-unreadable' };
  }
  const token = raw.replace(/\s+$/, '');
  if (token.length === 0 || /\s/.test(token)) {
    return { ok: false, reason: 'token-empty' };
  }
  return { ok: true, token };
}

export interface CreateFetchOtlpPostOptions {
  /** The validated endpoint URL from `checkOtlpEndpoint`. */
  readonly url: URL;
  /**
   * Reads the bearer token for each send (the token-file read bound to the
   * path); the token is kept only in that call's local scope, never in this
   * closure (§3.9).
   */
  readonly tokenReader: () => OtlpTokenFileRead;
  /** Injected fetch for tests; the global `fetch` by default. */
  readonly fetchImpl?: typeof fetch;
  /** An optional stop signal combined with the timeout signal. */
  readonly stopSignal?: AbortSignal;
  /** The per-request timeout in milliseconds (plan §3.3); 5000 by default. */
  readonly timeoutMs?: number;
  /**
   * The send deadline in epoch milliseconds, or null when unbounded; read per
   * post, it bounds the in-flight request alongside `timeoutMs`.
   */
  readonly deadlineMs?: () => number | null;
  /** Injected clock for the `Retry-After` date conversion; `Date.now` by default. */
  readonly nowMs?: () => number;
}

/** The largest prefix of a 2xx response body inspected for `partialSuccess`. */
const MAX_BODY_BYTES = 65_536;

/** Parses `partialSuccess.rejectedSpans` from a response body prefix; null when absent or unparsable. */
function parseRejectedSpans(text: string): number | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') {
    return null;
  }
  const partialSuccess = (parsed as Record<string, unknown>)['partialSuccess'];
  if (partialSuccess === null || typeof partialSuccess !== 'object') {
    return null;
  }
  const raw = (partialSuccess as Record<string, unknown>)['rejectedSpans'];
  // OTLP/JSON sends the count as a string or a number (plan §3.5).
  const value = typeof raw === 'string' && /^\d+$/.test(raw) ? Number.parseInt(raw, 10) : raw;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    return null;
  }
  return value;
}

/** Reads at most 64 KiB of the response body as text, reporting whether it stopped at the cap. */
async function readBodyPrefix(response: Response): Promise<{ text: string; truncated: boolean }> {
  const reader = response.body?.getReader();
  if (!reader) {
    return { text: '', truncated: false };
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done || value === undefined) {
        break;
      }
      chunks.push(value);
      total += value.byteLength;
      if (total >= MAX_BODY_BYTES) {
        truncated = true;
        break;
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // Cancelling an already-finished reader is harmless.
    }
  }
  const bytes = new Uint8Array(Math.min(total, MAX_BODY_BYTES));
  let offset = 0;
  for (const chunk of chunks) {
    if (offset >= bytes.byteLength) {
      break;
    }
    bytes.set(chunk.subarray(0, Math.min(chunk.byteLength, bytes.byteLength - offset)), offset);
    offset += Math.min(chunk.byteLength, bytes.byteLength - offset);
  }
  return { text: new TextDecoder().decode(bytes), truncated };
}

/** Converts a `Retry-After` header value to integer seconds against `nowMs`; null when unparsable. */
function parseRetryAfter(raw: string | null, nowMs: number): number | null {
  if (raw === null) {
    return null;
  }
  const trimmed = raw.trim();
  if (/^\d+$/.test(trimmed)) {
    return Math.max(0, Number.parseInt(trimmed, 10));
  }
  // RFC 9110 §5.6.7 HTTP-date shapes carry alphabetic weekday/month tokens;
  // anything else (e.g. "1.5", "-1") is not a date and yields null so the
  // default backoff is used.
  if (!/[a-zA-Z]/.test(trimmed)) {
    return null;
  }
  const dateMs = Date.parse(trimmed);
  if (Number.isNaN(dateMs)) {
    return null;
  }
  return Math.max(0, Math.ceil((dateMs - nowMs) / 1000));
}

/**
 * Builds the real `OtlpPost`: one POST of the payload with
 * `content-type: application/json` and `authorization: Bearer <token>`, under
 * `AbortSignal.timeout(min(timeoutMs, deadlineMs() - now))` combined with the
 * optional stop signal (plan §3.3 "Exporter lifetime", §3.5 "Two paths, two
 * deadlines") — the deadline bounds the in-flight request, and a deadline
 * already reached posts nothing. The token is read per send and kept only in
 * that call's local scope. It never throws, and nothing it returns carries the
 * body, a header, the token or the URL: a response maps to
 * `{ kind: 'http', status, retryAfterSeconds, rejectedSpans }` — except an
 * oversized 2xx whose truncated prefix does not parse to a complete
 * `partialSuccess` answer, which maps to `{ kind: 'network' }` so it can never
 * be read as full acceptance — an abort or timeout to `{ kind: 'timeout' }`,
 * anything else to `{ kind: 'network' }`.
 */
export function createFetchOtlpPost(options: CreateFetchOtlpPostOptions): OtlpPost {
  const { url, tokenReader, stopSignal } = options;
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 5000;
  const nowMs = options.nowMs ?? (() => Date.now());
  return async (payload: Uint8Array): Promise<OtlpPostOutcome> => {
    // The token is read per send and stays in this call's local scope; an
    // unreadable or empty token file is not attributable to the spans.
    const tokenRead = tokenReader();
    if (!tokenRead.ok) {
      return { kind: 'network' };
    }
    const token = tokenRead.token;
    const deadlineMs = options.deadlineMs?.() ?? null;
    let effectiveTimeoutMs = timeoutMs;
    if (deadlineMs !== null) {
      const remainingMs = deadlineMs - nowMs();
      if (remainingMs <= 0) {
        return { kind: 'timeout' };
      }
      effectiveTimeoutMs = Math.min(timeoutMs, remainingMs);
    }
    const signals: AbortSignal[] = [AbortSignal.timeout(effectiveTimeoutMs)];
    if (stopSignal !== undefined) {
      signals.push(stopSignal);
    }
    const signal = signals.length === 1 ? signals[0] : AbortSignal.any(signals);
    try {
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: new Uint8Array(payload),
        signal,
        // Never follow a redirect: the endpoint is validated, and a 3xx is a
        // non-HTTP-result outcome, not a new destination to POST to.
        redirect: 'manual',
      });
      const status = response.status;
      const retryAfterSeconds = parseRetryAfter(response.headers.get('retry-after'), nowMs());
      if (status >= 200 && status < 300) {
        const body = await readBodyPrefix(response);
        const rejectedSpans = parseRejectedSpans(body.text);
        // A truncated prefix that does not parse to a complete `partialSuccess`
        // answer proves nothing: the result is never an `http` outcome that a
        // full acceptance could be read from.
        if (body.truncated && rejectedSpans === null) {
          return { kind: 'network' };
        }
        return { kind: 'http', status, retryAfterSeconds, rejectedSpans };
      }
      // A non-2xx body is cancelled, never read: releasing the unread stream
      // back to the pool without consuming it (plan §3.5).
      await response.body?.cancel().catch(() => undefined);
      return { kind: 'http', status, retryAfterSeconds, rejectedSpans: null };
    } catch (error: unknown) {
      // An abort of the combined signal — the request timeout or the stop
      // signal, whatever its reason — is a timeout, never a network failure.
      if (signal.aborted) {
        return { kind: 'timeout' };
      }
      const name = error instanceof Error ? error.name : '';
      if (name === 'AbortError' || name === 'TimeoutError') {
        return { kind: 'timeout' };
      }
      return { kind: 'network' };
    }
  };
}

export interface WithOtlpRetryOptions {
  /**
   * The send deadline, resolved per attempt: the value itself or a getter (the
   * adapter factory supplies a getter fed from each `send` call).
   */
  readonly deadline: RunTelemetrySendDeadline | (() => RunTelemetrySendDeadline);
  /** Injected clock; `Date.now` by default. */
  readonly nowMs?: () => number;
  /** Injected wait for tests; `otlpRetrySleep` by default. */
  readonly sleep?: (ms: number) => Promise<void>;
  /**
   * An optional stop signal: an abort during a retry wait wakes it immediately
   * so `exporter.stop()` never stalls on a `Retry-After` sleep (plan §3.3
   * "Exporter lifetime").
   */
  readonly stopSignal?: AbortSignal;
}

/** The statuses retried at most twice (plan §3.5 "Send"). */
const RETRYABLE_STATUSES = new Set([429, 502, 503, 504]);

/** The fixed backoff waits in milliseconds: 1 s then 4 s. */
const RETRY_BACKOFF_MS = [1_000, 4_000];

/** The cap applied to a `Retry-After` wait (plan §3.5). */
const RETRY_AFTER_CAP_MS = 30_000;

/**
 * The retry wait: a `setTimeout` that is `unref()`'d, so a pending retry never
 * holds the event loop open (plan §3.3 "Exporter lifetime"). Tests inject a
 * fake through `withOtlpRetry` instead of using this.
 */
export function otlpRetrySleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
}

/**
 * Waits for `sleepMs(ms)` but resolves early when `signal` aborts, so a stop
 * never has to wait out a retry backoff. Without a signal it is the sleep.
 */
function sleepUntil(signal: AbortSignal | undefined, sleepMs: (ms: number) => Promise<void>, ms: number): Promise<void> {
  if (signal === undefined) {
    return sleepMs(ms);
  }
  if (signal.aborted) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (): void => {
      if (!settled) {
        settled = true;
        signal!.removeEventListener('abort', onAbort);
        resolve();
      }
    };
    const fail = (error: unknown): void => {
      if (!settled) {
        settled = true;
        signal!.removeEventListener('abort', onAbort);
        reject(error);
      }
    };
    const onAbort = (): void => finish();
    signal.addEventListener('abort', onAbort, { once: true });
    sleepMs(ms).then(finish, fail);
  });
}

/**
 * Wraps an `OtlpPost` with the retry and deadline rules (plan §3.5 "Send"):
 * 429, 502, 503 and 504 are retried at most twice, waiting 1 s then 4 s or the
 * `Retry-After` seconds capped at 30 s, and nothing ever sleeps or posts past
 * `deadline.atMs` — a deadline reached before a post or before a wait ends the
 * call with `{ kind: 'timeout' }`.
 */
export function withOtlpRetry(post: OtlpPost, options: WithOtlpRetryOptions): OtlpPost {
  const nowMs = options.nowMs ?? (() => Date.now());
  const sleepMs = options.sleep ?? otlpRetrySleep;
  const deadlineAt = (): RunTelemetrySendDeadline =>
    typeof options.deadline === 'function' ? options.deadline() : options.deadline;
  return async (payload: Uint8Array): Promise<OtlpPostOutcome> => {
    let attempt = 0;
    for (;;) {
      const before = deadlineAt();
      if (before !== null && nowMs() >= before.atMs) {
        return { kind: 'timeout' };
      }
      const outcome = await post(payload);
      if (outcome.kind !== 'http' || !RETRYABLE_STATUSES.has(outcome.status) || attempt >= RETRY_BACKOFF_MS.length) {
        return outcome;
      }
      const waitMs =
        outcome.retryAfterSeconds === null
          ? RETRY_BACKOFF_MS[attempt]
          : Math.min(outcome.retryAfterSeconds * 1_000, RETRY_AFTER_CAP_MS);
      const after = deadlineAt();
      if (after !== null && nowMs() + waitMs >= after.atMs) {
        return { kind: 'timeout' };
      }
      await sleepUntil(options.stopSignal, sleepMs, waitMs);
      if (options.stopSignal !== undefined && options.stopSignal.aborted) {
        // The stop signal fired during the retry wait: nothing more is posted
        // and the call ends as a timeout (plan §3.3 "Exporter lifetime").
        return { kind: 'timeout' };
      }
      attempt += 1;
    }
  };
}
