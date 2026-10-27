/**
 * The pure domain of run telemetry ids (plan §3.2 "Ids", §3.3 dispositions,
 * §3.4 deterministic ids): everything sent to a telemetry route is derived,
 * never propagated. `v1` of the schema is in every hash input through
 * TELEMETRY_HASH_PREFIX. The domain never sees the installation's salt: the
 * HMAC-SHA256 function arrives as a `TelemetryHmac` built by infrastructure,
 * the domain builds every message string, slices the bytes, hex-encodes them
 * and applies the all-zero rule. Operator-chosen ids, journalled keys, trace
 * roots and span identities are opaque tokens (frozen empty objects whose text
 * lives in a module-private WeakMap), so nothing serialisable carries a raw id
 * out of this module.
 */

import { parseLaneRunKey, REQUEST_ID_PATTERN } from './lane-run-keys.js';
import { LANE_RUN_ID_PATTERN, LANE_RUN_MAX_ROUND } from './lane-run-records.js';

/** `fleet.telemetry.schema`; a mapping change that must replace sent spans bumps it with the prefix (plan §3.4). */
export const TELEMETRY_SCHEMA_VERSION = 1 as const;
/** In every hash input (plan §3.4). */
export const TELEMETRY_HASH_PREFIX = 'fleet-telemetry/v1';

export const TELEMETRY_DIGEST_PATTERN = /^[0-9a-f]{16}$/;
export const TELEMETRY_TRACE_ID_PATTERN = /^[0-9a-f]{32}$/;
export const TELEMETRY_SPAN_ID_PATTERN = /^[0-9a-f]{16}$/;
export const TELEMETRY_FINGERPRINT_PATTERN = /^[0-9a-f]{8}$/;

/** The longest raw id or key a hash input accepts (UTF-16 code units). */
export const TELEMETRY_HASH_INPUT_MAX_LENGTH = 1024;

/**
 * HMAC-SHA256 keyed with the installation's telemetry salt (plan §3.2, D14), built by infrastructure.
 * It returns the 32-byte MAC of the UTF-8 bytes of `message`. The domain never sees the salt.
 */
export type TelemetryHmac = (message: string) => Uint8Array;

/** The `<kind>` of a digest's hash input (plan §3.2). A prior attempt uses `attempt`. */
export const TELEMETRY_DIGEST_KINDS = ['work-order', 'attempt', 'project'] as const;
export type TelemetryDigestKind = (typeof TELEMETRY_DIGEST_KINDS)[number];

declare const HASH_INPUT_BRAND: unique symbol;
declare const TRACE_ROOT_BRAND: unique symbol;
declare const SPAN_IDENTITY_BRAND: unique symbol;

/** An operator-chosen id or a journalled key: hash input only, never serialisable (`JSON.stringify` gives `{}`). */
export type TelemetryHashInput = { readonly [HASH_INPUT_BRAND]: true };
/** `run/<runId>` or `attempt/<attemptId>` (plan §3.4 "Trace root"). */
export type TelemetryTraceRoot = { readonly [TRACE_ROOT_BRAND]: true };
/** One identity of the §3.4 table. */
export type TelemetrySpanIdentity = { readonly [SPAN_IDENTITY_BRAND]: true };

const HASH_INPUT_TEXT = new WeakMap<object, string>();
const TRACE_ROOT_TEXT = new WeakMap<object, string>();
const SPAN_IDENTITY_TEXT = new WeakMap<object, string>();

/** A frozen empty object registered with its text; the only way a token is made. */
function mint<T>(registry: WeakMap<object, string>, text: string): T {
  const token = Object.freeze({});
  registry.set(token, text);
  return token as unknown as T;
}

/** The registered text of a token, or null for anything this module did not mint. */
function readText(registry: WeakMap<object, string>, token: unknown): string | null {
  if (typeof token !== 'object' || token === null) {
    return null;
  }
  return registry.get(token) ?? null;
}

/** Wrap a raw operator id or journalled key. Null unless a non-empty string of at most 1024 code units. */
export function telemetryHashInput(value: unknown): TelemetryHashInput | null {
  try {
    if (typeof value !== 'string' || value.length === 0 || value.length > TELEMETRY_HASH_INPUT_MAX_LENGTH) {
      return null;
    }
    return mint(HASH_INPUT_TEXT, value);
  } catch {
    return null;
  }
}

/** Calls `hmac(message)`: null when it throws or the result is not a Uint8Array of at least 32 bytes. */
function macOf(hmac: TelemetryHmac, message: string): Uint8Array | null {
  try {
    const mac = hmac(message);
    if (!(mac instanceof Uint8Array) || mac.length < 32) {
      return null;
    }
    return mac;
  } catch {
    return null;
  }
}

/** The first `count` bytes as lowercase hex. */
function hexOf(bytes: Uint8Array, count: number): string {
  return Array.from(bytes.subarray(0, count), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * The first `count` bytes as hex with the all-zero rule applied: when every
 * copied byte is 0, the last bit of the last byte flips, because an all-zero
 * id is invalid in OTLP (plan §3.4). Only trace and span ids use this rule;
 * digests and the fingerprint do not.
 */
function idHexOf(bytes: Uint8Array, count: number): string {
  const copy = bytes.slice(0, count);
  let allZero = true;
  for (const byte of copy) {
    if (byte !== 0) {
      allZero = false;
      break;
    }
  }
  if (allZero) {
    copy[count - 1] ^= 1;
  }
  return hexOf(copy, count);
}

/** First 16 hex of HMAC-SHA256(salt, kind + ':' + id) (plan §3.2, D14). Null on any bad input. */
export function telemetryDigest(
  hmac: TelemetryHmac,
  kind: TelemetryDigestKind,
  input: TelemetryHashInput,
): string | null {
  try {
    if (!(TELEMETRY_DIGEST_KINDS as readonly string[]).includes(kind)) {
      return null;
    }
    const text = readText(HASH_INPUT_TEXT, input);
    if (text === null) {
      return null;
    }
    const mac = macOf(hmac, kind + ':' + text);
    if (mac === null) {
      return null;
    }
    return hexOf(mac, 8);
  } catch {
    return null;
  }
}

/** First 8 hex of HMAC-SHA256(salt, 'fleet-telemetry/v1/fingerprint') (plan §3.2). */
export function telemetrySaltFingerprint(hmac: TelemetryHmac): string | null {
  try {
    const mac = macOf(hmac, TELEMETRY_HASH_PREFIX + '/fingerprint');
    if (mac === null) {
      return null;
    }
    return hexOf(mac, 4);
  } catch {
    return null;
  }
}

/** `run/<runId>`; null unless runId matches LANE_RUN_ID_PATTERN. */
export function runTraceRoot(runId: unknown): TelemetryTraceRoot | null {
  try {
    if (typeof runId !== 'string' || !LANE_RUN_ID_PATTERN.test(runId)) {
      return null;
    }
    return mint(TRACE_ROOT_TEXT, 'run/' + runId);
  } catch {
    return null;
  }
}

/** `attempt/<attemptId>` for a hand-run attempt (plan §3.1, §3.4). */
export function attemptTraceRoot(attemptId: TelemetryHashInput): TelemetryTraceRoot | null {
  try {
    const text = readText(HASH_INPUT_TEXT, attemptId);
    if (text === null) {
      return null;
    }
    return mint(TRACE_ROOT_TEXT, 'attempt/' + text);
  } catch {
    return null;
  }
}

/** First 16 bytes (32 hex) of HMAC-SHA256(salt, 'fleet-telemetry/v1/trace/' + root), all-zero rule applied. */
export function telemetryTraceId(hmac: TelemetryHmac, root: TelemetryTraceRoot): string | null {
  try {
    const text = readText(TRACE_ROOT_TEXT, root);
    if (text === null) {
      return null;
    }
    const mac = macOf(hmac, TELEMETRY_HASH_PREFIX + '/trace/' + text);
    if (mac === null) {
      return null;
    }
    return idHexOf(mac, 16);
  } catch {
    return null;
  }
}

/** First 8 bytes (16 hex) of HMAC-SHA256(salt, 'fleet-telemetry/v1/span/' + root + '/' + identity), all-zero rule applied. */
export function telemetrySpanId(
  hmac: TelemetryHmac,
  root: TelemetryTraceRoot,
  identity: TelemetrySpanIdentity,
): string | null {
  try {
    const rootText = readText(TRACE_ROOT_TEXT, root);
    const identityText = readText(SPAN_IDENTITY_TEXT, identity);
    if (rootText === null || identityText === null) {
      return null;
    }
    const mac = macOf(hmac, TELEMETRY_HASH_PREFIX + '/span/' + rootText + '/' + identityText);
    if (mac === null) {
      return null;
    }
    return idHexOf(mac, 8);
  } catch {
    return null;
  }
}

// A span kind added later must name its durable source in plan §3.4's table
// and get its own builder here before it ships.

/** `root`: the root span of a conducted run. */
export function runRootIdentity(): TelemetrySpanIdentity {
  return mint(SPAN_IDENTITY_TEXT, 'root');
}

/** `attempt/<attemptId>`: the attempt AGENT span (both trace kinds) and the root of a hand-run trace. */
export function attemptIdentity(attemptId: TelemetryHashInput): TelemetrySpanIdentity | null {
  try {
    const text = readText(HASH_INPUT_TEXT, attemptId);
    if (text === null) {
      return null;
    }
    return mint(SPAN_IDENTITY_TEXT, 'attempt/' + text);
  } catch {
    return null;
  }
}

/** `round/r<round>`; round an integer 0..LANE_RUN_MAX_ROUND. */
export function roundIdentity(round: unknown): TelemetrySpanIdentity | null {
  try {
    if (typeof round !== 'number' || !Number.isInteger(round) || round < 0 || round > LANE_RUN_MAX_ROUND) {
      return null;
    }
    return mint(SPAN_IDENTITY_TEXT, 'round/r' + round);
  } catch {
    return null;
  }
}

/** `key/<key>`: a keyed step or a stop request; only a key parseLaneRunKey reads as kind `step` or `stop`. */
export function journalKeyIdentity(key: TelemetryHashInput): TelemetrySpanIdentity | null {
  try {
    const text = readText(HASH_INPUT_TEXT, key);
    if (text === null) {
      return null;
    }
    const parsed = parseLaneRunKey(text);
    if (parsed === null || (parsed.kind !== 'step' && parsed.kind !== 'stop')) {
      return null;
    }
    return mint(SPAN_IDENTITY_TEXT, 'key/' + text);
  } catch {
    return null;
  }
}

/** `usage/<attemptId>`: the usage aggregate. */
export function usageIdentity(attemptId: TelemetryHashInput): TelemetrySpanIdentity | null {
  try {
    const text = readText(HASH_INPUT_TEXT, attemptId);
    if (text === null) {
      return null;
    }
    return mint(SPAN_IDENTITY_TEXT, 'usage/' + text);
  } catch {
    return null;
  }
}

/** `usage/<attemptId>/msg/<messageId>`: one per-call LLM span (OT6). */
export function usageCallIdentity(
  attemptId: TelemetryHashInput,
  messageId: TelemetryHashInput,
): TelemetrySpanIdentity | null {
  try {
    const attemptText = readText(HASH_INPUT_TEXT, attemptId);
    const messageText = readText(HASH_INPUT_TEXT, messageId);
    if (attemptText === null || messageText === null) {
      return null;
    }
    return mint(SPAN_IDENTITY_TEXT, 'usage/' + attemptText + '/msg/' + messageText);
  } catch {
    return null;
  }
}

/** `ci/<entryId>`: the CI wait opened by a `watching-ci` conduct entry; entryId must match REQUEST_ID_PATTERN (a ULID). */
export function ciWaitIdentity(entryId: unknown): TelemetrySpanIdentity | null {
  try {
    if (typeof entryId !== 'string' || !REQUEST_ID_PATTERN.test(entryId)) {
      return null;
    }
    return mint(SPAN_IDENTITY_TEXT, 'ci/' + entryId);
  } catch {
    return null;
  }
}

/** `verification/<receiptId>`: a gate receipt of a hand-run trace. */
export function verificationReceiptIdentity(receiptId: TelemetryHashInput): TelemetrySpanIdentity | null {
  try {
    const text = readText(HASH_INPUT_TEXT, receiptId);
    if (text === null) {
      return null;
    }
    return mint(SPAN_IDENTITY_TEXT, 'verification/' + text);
  } catch {
    return null;
  }
}

/** `review/<receiptId>`: a review receipt of a hand-run trace. */
export function reviewReceiptIdentity(receiptId: TelemetryHashInput): TelemetrySpanIdentity | null {
  try {
    const text = readText(HASH_INPUT_TEXT, receiptId);
    if (text === null) {
      return null;
    }
    return mint(SPAN_IDENTITY_TEXT, 'review/' + text);
  } catch {
    return null;
  }
}

export const TELEMETRY_ROUTES = ['collector', 'phoenix'] as const;
export type TelemetryRoute = (typeof TELEMETRY_ROUTES)[number];
/** Why a span was rejected: a class, never a value or a response body. */
export const TELEMETRY_REJECT_REASONS = ['invalid', 'too-large', 'partial-rejected', 'http-4xx'] as const;
export type TelemetryRejectReason = (typeof TELEMETRY_REJECT_REASONS)[number];
/** What a failed export records: never the endpoint, a header or a body (plan §3.2 test 6, §3.5). */
export const TELEMETRY_ERROR_KINDS = ['timeout', 'network', 'auth', 'http-4xx', 'http-5xx', 'partial', 'salt-mismatch'] as const;
export type TelemetryErrorKind = (typeof TELEMETRY_ERROR_KINDS)[number];

export type SpanDisposition =
  | { readonly state: 'pending' }
  | { readonly state: 'exported'; readonly route: TelemetryRoute }
  | { readonly state: 'rejected'; readonly reason: TelemetryRejectReason };

/** `pending`, `exported@<route>` or `rejected:<reason>`. */
export function spanDispositionText(disposition: SpanDisposition): string {
  if (disposition.state === 'exported') {
    return 'exported@' + disposition.route;
  }
  if (disposition.state === 'rejected') {
    return 'rejected:' + disposition.reason;
  }
  return 'pending';
}

/** The inverse; null for anything else (case-sensitive, no whitespace). */
export function parseSpanDispositionText(value: unknown): SpanDisposition | null {
  try {
    if (typeof value !== 'string') {
      return null;
    }
    if (value === 'pending') {
      return { state: 'pending' };
    }
    if (value.startsWith('exported@')) {
      const route = value.slice('exported@'.length);
      if ((TELEMETRY_ROUTES as readonly string[]).includes(route)) {
        return { state: 'exported', route: route as TelemetryRoute };
      }
      return null;
    }
    if (value.startsWith('rejected:')) {
      const reason = value.slice('rejected:'.length);
      if ((TELEMETRY_REJECT_REASONS as readonly string[]).includes(reason)) {
        return { state: 'rejected', reason: reason as TelemetryRejectReason };
      }
      return null;
    }
    return null;
  } catch {
    return null;
  }
}

/** True for `exported` and `rejected`: an export never selects such a span again (plan §3.3). */
export function isFinalSpanDisposition(disposition: SpanDisposition): boolean {
  return disposition.state !== 'pending';
}
