// Jev decision client (lane DT-V1, plan 2026-10-31_daemon-tick-plan §5, Jev
// record §5.4). I/O only through the injected fetch; the key is a
// caller-supplied string.
//
// The transport hygiene previously duplicated in brief-knowledge's ranking and
// triage adapters lives here: one deadline covering the fetch and the body
// read, non-2xx → `transport`, abort → `timeout`, response bodies over the
// 64 KiB cap (by header or by accumulated bytes) or unparsable JSON →
// `shape`. Authorization, request bodies and response content never appear in
// thrown errors or returned values; the receipt is extracted as soon as the
// body parses, so a paid call that later fails validation still reports its
// cost.

import type { JevWireQuestion } from './types.js';
import { isValidIdOrModel } from './validators.js';

const JEV_DECISIONS_URL = 'https://openrouter.ai/api/alpha/decisions';
const DEFAULT_JEV_TIMEOUT_MS = 3000;
/** Response bodies larger than this many bytes are refused as a shape failure. */
const MAX_RESPONSE_BODY_BYTES = 65536;

/** Per-call receipt for the decision receipt journal. */
export interface JevDecisionReceipt {
  readonly requestId: string;
  /**
   * Reported cost in USD; `undefined` when the response carried no usable
   * usage cost (callers pass `undefined`, never `0`, to the journal).
   */
  readonly costUsd?: number;
  /** Served model id as reported; recorded, never trusted. */
  readonly servedModel: string;
  readonly stateSha256: string;
}

export interface JevDecisionClientRequest {
  readonly fetch: typeof fetch;
  /** Already read by the caller; never logged, never returned. */
  readonly key: string;
  readonly model: string;
  readonly stateJson: string;
  /**
   * Wire question shapes the consumers actually send. The kernel's
   * `JevWireQuestion` models `choice` via `criteria` and `score` via
   * `levels`; the ranking consumer sends score levels as `criteria` (a flat
   * array), so the client accepts both spellings.
   */
  readonly questions: Readonly<
    Record<
      string,
      | JevWireQuestion
      | { type: 'score'; instructions: string; criteria: readonly string[] }
    >
  >;
  readonly stateSha256: string;
  readonly timeoutMs?: number; // default 3000
}

export type JevDecisionClientResult =
  | { ok: true; parsed: unknown; receipt: JevDecisionReceipt }
  | { ok: false; reason: 'timeout' | 'transport' | 'shape' };

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Result of reading a response body under the byte cap. */
type BoundedBodyRead =
  | { ok: true; text: string }
  | { ok: false; reason: 'shape' | 'timeout' | 'transport' };

/**
 * Read `response.body` with a reader, accumulating bytes. Refuses (`shape`)
 * as soon as the accumulated bytes exceed the cap and cancels the reader; an
 * abort during the read maps to `timeout`, any other read error to
 * `transport`. Decoded with TextDecoder.
 */
async function readBoundedBody(response: Response): Promise<BoundedBodyRead> {
  const stream = response.body;
  if (!stream) {
    return { ok: false, reason: 'transport' };
  }
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let text = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > MAX_RESPONSE_BODY_BYTES) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, reason: 'shape' };
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } catch (error) {
    return { ok: false, reason: isAbortError(error) ? 'timeout' : 'transport' };
  }
  return { ok: true, text };
}

/** Extract the receipt fields without trusting or re-serving the body. */
function extractReceipt(parsed: unknown, stateSha256: string): JevDecisionReceipt {
  const requestId = isPlainObject(parsed) && isValidIdOrModel(parsed.id) ? parsed.id : '';
  const usage = isPlainObject(parsed) && isPlainObject(parsed.usage) ? parsed.usage : {};
  // Absent or non-finite cost stays undefined, never 0: the journal would
  // otherwise record a real paid cost of zero.
  const costUsd = typeof usage.cost === 'number' && Number.isFinite(usage.cost) ? usage.cost : undefined;
  const servedModel =
    isPlainObject(parsed) && isValidIdOrModel(parsed.model) ? parsed.model : '';
  return { requestId, costUsd, servedModel, stateSha256 };
}

/**
 * Post one Jev decision request. The key is a caller-supplied string and is
 * never logged, embedded in an error, or returned. One deadline covers the
 * fetch and the body read; the receipt is extracted as soon as the body
 * parses, so a paid call that later fails validation still reports its cost.
 */
export async function postJevDecision(
  request: JevDecisionClientRequest,
): Promise<JevDecisionClientResult> {
  const body = JSON.stringify({
    model: request.model,
    state: request.stateJson,
    questions: request.questions,
  });

  // One deadline covers the fetch AND the body read; the timer is cleared
  // only after the body is fully read (or the attempt has already failed).
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), request.timeoutMs ?? DEFAULT_JEV_TIMEOUT_MS);
  try {
    const response = await request.fetch(JEV_DECISIONS_URL, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${request.key}`,
        'content-type': 'application/json',
      },
      body,
      redirect: 'error',
      signal: controller.signal,
    });

    if (!(response as { ok?: boolean }).ok) {
      // HTTP status only; never the body. Release the connection.
      await response.body?.cancel().catch(() => undefined);
      return { ok: false, reason: 'transport' };
    }

    const contentLengthHeader = response.headers.get('content-length');
    if (contentLengthHeader !== null) {
      const contentLength = Number(contentLengthHeader);
      if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BODY_BYTES) {
        // Refuse before reading a single byte of an oversized body.
        await response.body?.cancel().catch(() => undefined);
        return { ok: false, reason: 'shape' };
      }
    }

    const read = await readBoundedBody(response);
    if (!read.ok) {
      return { ok: false, reason: read.reason };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(read.text) as unknown;
    } catch {
      return { ok: false, reason: 'shape' };
    }

    return {
      ok: true,
      parsed,
      receipt: extractReceipt(parsed, request.stateSha256),
    };
  } catch (error) {
    if (isAbortError(error)) {
      return { ok: false, reason: 'timeout' };
    }
    return { ok: false, reason: 'transport' };
  } finally {
    clearTimeout(timer);
  }
}
