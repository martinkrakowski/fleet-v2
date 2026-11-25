// Stored-record rule (Q5a/Q5b): this unit stores nothing; if a later unit stores these records it must write `schemaVersion: 1`, read an absent `schemaVersion` as `1` forever, and refuse an unknown `schemaVersion` with `StateFileUnknownVersionError` (bytes untouched, nothing quarantined).
// Inbound webhook verification, pure half: HMAC-SHA256 over the raw body and a
// bounded in-memory replay cache. No route, store, network, clock or logging; the
// caller supplies `nowMs` and the raw body bytes.
//
// The replay cache only deduplicates delivery IDs. A captured body sent with a new
// ID, or with the same ID after `ttlMs` or after eviction, passes. Call `check` only
// after `verifyWebhookSignature` returned `ok: true`, so unauthenticated senders
// cannot fill or evict the cache.
//
// No result or error ever echoes a secret, a header value or a body byte.
import { createHmac, timingSafeEqual } from "node:crypto";
import { types } from "node:util";

const DEFAULT_MAX_BODY_BYTES = 1048576;
const MIN_SECRET_BYTES = 16;
// Keys beyond a few KiB add nothing; the ceiling bounds the cost of validating a secret.
const MAX_SECRET_BYTES = 4096;
const SIGNATURE_PREFIX = "sha256=";
const SIGNATURE_LENGTH = 71;
const SIGNATURE_PATTERN = /^sha256=[0-9a-f]{64}$/;
const MAX_CAPACITY = 10000;
const MAX_TTL_MS = 86400000;
const DELIVERY_ID_PATTERN = /^[A-Za-z0-9-]{8,64}$/;
const MAX_DELIVERY_ID_LENGTH = 64;

/** Sentinel for a property that is an accessor or whose descriptor could not be read. */
const UNREADABLE = Symbol("unreadable");

const typedArrayByteLengthGetter = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype) as object,
  "byteLength",
)?.get;

export type WebhookSignatureRefusal =
  | "secret-invalid"
  | "header-missing"
  | "header-malformed"
  | "body-invalid"
  | "body-too-large"
  | "mismatch";

export type WebhookSignatureResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: WebhookSignatureRefusal };

export type ReplayVerdict = "fresh" | "replay" | "invalid";

export interface ReplayCache {
  check(deliveryId: unknown, nowMs: number): ReplayVerdict;
  size(): number;
}

function refuse(reason: WebhookSignatureRefusal): WebhookSignatureResult {
  return { ok: false, reason };
}

// Reads an OWN data property without running anything: an accessor, a throwing
// descriptor lookup or a missing key never reaches a getter. Cost: O(1).
function readOwnDataProperty(source: object, key: string): unknown {
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(source, key);
  } catch {
    return UNREADABLE;
  }
  if (descriptor === undefined) {
    return undefined;
  }
  return "value" in descriptor ? descriptor.value : UNREADABLE;
}

// Byte length of a genuine Uint8Array through the intrinsic getter, so a subclass
// override is never run. A Proxy is not a Uint8Array to `types`, and any throw is
// refused as null. Cost: O(1).
function byteLengthOf(value: unknown): number | null {
  if (!types.isUint8Array(value) || typedArrayByteLengthGetter === undefined) {
    return null;
  }
  try {
    const length: unknown = Reflect.apply(typedArrayByteLengthGetter, value, []);
    return typeof length === "number" && Number.isSafeInteger(length) && length >= 0
      ? length
      : null;
  } catch {
    return null;
  }
}

function isValidSecret(secret: unknown): secret is string | Uint8Array {
  if (typeof secret === "string") {
    // The length guard keeps Buffer.byteLength O(MAX_SECRET_BYTES): UTF-8 bytes >= UTF-16 units.
    return (
      secret.length <= MAX_SECRET_BYTES &&
      Buffer.byteLength(secret, "utf8") >= MIN_SECRET_BYTES &&
      Buffer.byteLength(secret, "utf8") <= MAX_SECRET_BYTES
    );
  }
  const length = byteLengthOf(secret);
  return length !== null && length >= MIN_SECRET_BYTES && length <= MAX_SECRET_BYTES;
}

function resolveMaxBodyBytes(requested: unknown): number {
  // May only LOWER the default; anything else keeps the default.
  return typeof requested === "number" &&
    Number.isSafeInteger(requested) &&
    requested > 0 &&
    requested <= DEFAULT_MAX_BODY_BYTES
    ? requested
    : DEFAULT_MAX_BODY_BYTES;
}

/**
 * Verifies `signatureHeader` (`sha256=<64 lowercase hex>`) as HMAC-SHA256 of the raw
 * `body` under `secret`. `input` is untrusted: only own data properties `secret`,
 * `body`, `signatureHeader` and `maxBodyBytes` are read, each once, and no getter,
 * Proxy trap or inherited value is ever run or consulted. Unusable `input` reports
 * `secret-invalid`, the first field validated; an unreadable `maxBodyBytes` fails
 * closed as `body-too-large`.
 */
export function verifyWebhookSignature(input: unknown): WebhookSignatureResult {
  if (typeof input !== "object" || input === null || types.isProxy(input)) {
    return refuse("secret-invalid");
  }
  const secret = readOwnDataProperty(input, "secret");
  const body = readOwnDataProperty(input, "body");
  const signatureHeader = readOwnDataProperty(input, "signatureHeader");
  const maxBodyBytes = readOwnDataProperty(input, "maxBodyBytes");

  if (!isValidSecret(secret)) {
    return refuse("secret-invalid");
  }
  if (!types.isUint8Array(body)) {
    return refuse("body-invalid");
  }
  const bodyLength = byteLengthOf(body);
  if (bodyLength === null) {
    return refuse("body-invalid");
  }
  if (maxBodyBytes === UNREADABLE) {
    return refuse("body-too-large");
  }
  // Size check BEFORE any hashing: an oversized payload must not cost O(body) HMAC work.
  if (bodyLength > resolveMaxBodyBytes(maxBodyBytes)) {
    return refuse("body-too-large");
  }
  if (signatureHeader === undefined || signatureHeader === null || signatureHeader === "") {
    return refuse("header-missing");
  }
  if (
    typeof signatureHeader !== "string" ||
    signatureHeader.length !== SIGNATURE_LENGTH ||
    !SIGNATURE_PATTERN.test(signatureHeader)
  ) {
    return refuse("header-malformed");
  }
  // Cost: O(body.byteLength), bounded by the 1 MiB cap above; the rest is constant.
  const expected = createHmac("sha256", secret).update(body).digest();
  const actual = Buffer.from(signatureHeader.slice(SIGNATURE_PREFIX.length), "hex");
  if (actual.length !== expected.length) {
    return refuse("header-malformed");
  }
  return timingSafeEqual(actual, expected) ? { ok: true } : refuse("mismatch");
}

function isIntegerInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
}

/**
 * Bounded in-memory delivery-ID cache. State is a `Map<string, number>` (insertion
 * ordered, immune to prototype-polluting keys such as `__proto__`, `constructor`
 * and `prototype`). `check` is O(1) amortised: one lookup, at most one delete and
 * one insert. `options` is untrusted: own data properties only, never a getter.
 */
export function createReplayCache(options: unknown): ReplayCache {
  if (typeof options !== "object" || options === null || types.isProxy(options)) {
    throw new RangeError("createReplayCache: options must be an object with capacity and ttlMs");
  }
  const capacity = readOwnDataProperty(options, "capacity");
  const ttlMs = readOwnDataProperty(options, "ttlMs");
  if (!isIntegerInRange(capacity, 1, MAX_CAPACITY)) {
    throw new RangeError("createReplayCache: capacity must be an integer in 1..10000");
  }
  if (!isIntegerInRange(ttlMs, 1, MAX_TTL_MS)) {
    throw new RangeError("createReplayCache: ttlMs must be an integer in 1..86400000");
  }
  const maxEntries: number = capacity;
  const ttl: number = ttlMs;
  const seen = new Map<string, number>();
  return {
    check(deliveryId: unknown, nowMs: number): ReplayVerdict {
      if (typeof nowMs !== "number" || !Number.isSafeInteger(nowMs) || nowMs < 0) {
        return "invalid";
      }
      if (
        typeof deliveryId !== "string" ||
        deliveryId.length > MAX_DELIVERY_ID_LENGTH ||
        !DELIVERY_ID_PATTERN.test(deliveryId)
      ) {
        return "invalid";
      }
      const seenAt = seen.get(deliveryId);
      if (seenAt !== undefined) {
        // A `nowMs` earlier than `seenAt` gives a negative age, so it is a replay.
        if (nowMs - seenAt < ttl) {
          return "replay";
        }
        // Expired: delete first so the re-insert moves the ID to the newest slot.
        seen.delete(deliveryId);
        seen.set(deliveryId, nowMs);
        return "fresh";
      }
      if (seen.size >= maxEntries) {
        const oldest = seen.keys().next();
        if (!oldest.done) {
          seen.delete(oldest.value);
        }
      }
      seen.set(deliveryId, nowMs);
      return "fresh";
    },
    size(): number {
      return seen.size;
    },
  };
}
