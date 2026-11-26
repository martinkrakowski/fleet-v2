/**
 * Pure forge webhook wake-record decision (FC-7.7). The caller verifies the
 * signature externally and passes the boolean outcome as
 * `signatureVerified`; this module never touches a secret, a hash or a
 * network. On acceptance the decision returns only a four-field wake record
 * — `organizationId`, `eventType`, `deliveryId`, `receivedAtIso` — with no
 * payload, no URL and no body-derived field (FC-R16).
 *
 * Pure domain code: no Node, filesystem, subprocess, network or vendor
 * imports; no clock reads, no randomness, no secret material —
 * instants arrive as `receivedAtIso` and `signedAtIso`, and `Date.parse` on
 * already-validated strings is the only time arithmetic.
 *
 * Hostile-input posture (every public function): null, undefined, wrong
 * primitives, arrays, array-likes, non-plain prototypes, getters/setters
 * (never invoked — `snapshotPlainData` reads through property descriptors
 * only), throwing Proxy traps, sparse array holes, symbol keys, cycles,
 * oversized strings and prototype-polluting own keys are each refused with
 * `{ outcome: 'refused', reason: 'invalid-input' }`, never a throw and never
 * a pass. Refusals never echo the rejected `deliveryId`, `organizationId`,
 * `eventType` or any other rejected value.
 */

import { snapshotPlainData, type IsProxy } from "@fleet/shared";

import {
  MAX_STRING_LENGTH,
  ORGANIZATION_ID_PATTERN,
  isZonedIsoDateTime,
} from "./entities/record-guards.js";

/** A webhook is stale once its signed age exceeds five minutes. */
export const WEBHOOK_MAX_AGE_MS = 5 * 60 * 1000;

/** A signature stamped more than 60 seconds in the future is refused. */
export const WEBHOOK_MAX_FUTURE_SKEW_MS = 60 * 1000;

/** At most this many previously seen delivery ids are remembered per call. */
export const MAX_SEEN_DELIVERY_IDS = 10_000;

/** A payload above one mebibyte is refused before any body work. */
export const MAX_WEBHOOK_PAYLOAD_BYTES = 1_048_576;

/** The forge event types this webhook reacts to. */
export const ALLOWED_WEBHOOK_EVENT_TYPES = [
  "push",
  "pull_request",
  "check_suite",
  "installation",
] as const;

export type WebhookEventType = (typeof ALLOWED_WEBHOOK_EVENT_TYPES)[number];

/** The only record an accepted webhook yields: four plain data fields. */
export type WebhookWakeRecord = {
  readonly organizationId: string;
  readonly eventType: WebhookEventType;
  readonly deliveryId: string;
  readonly receivedAtIso: string;
};

export type WebhookDeliveryRefusalReason =
  | "invalid-input"
  | "signature-invalid"
  | "stale"
  | "replay"
  | "payload-too-large"
  | "event-not-allowed";

export type WebhookDeliveryDecision =
  | { readonly outcome: "accepted"; readonly wakeRecord: WebhookWakeRecord }
  | { readonly outcome: "refused"; readonly reason: WebhookDeliveryRefusalReason };

const REQUIRED_KEYS = [
  "deliveryId",
  "organizationId",
  "eventType",
  "receivedAtIso",
  "signedAtIso",
  "signatureVerified",
  "seenDeliveryIds",
  "payloadBytes",
] as const;

/** Own-property names refused outright, checked without value reads. */
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/** The allow-list as a Set: a property lookup on a plain object would admit `__proto__` and `constructor`. */
const ALLOWED_EVENT_TYPE_SET: ReadonlySet<string> = new Set<string>(ALLOWED_WEBHOOK_EVENT_TYPES);

const MAX_ID_LENGTH = 256;
const MAX_EVENT_TYPE_LENGTH = 128;
const MAX_ISO_LENGTH = 64;

/**
 * A bounded identifier: non-empty, at most 256 characters, no control
 * characters (C0 or DEL) and not whitespace-only. Cost bound: O(n) in the
 * string length, which the length check bounds at 256 — O(1) for practical
 * purposes and bounded regardless of the input's declared length.
 */
function isBoundedId(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_ID_LENGTH) {
    return false;
  }
  if (value.trim().length === 0) {
    return false;
  }
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) {
      return false;
    }
  }
  return true;
}

/** An organisation id matching the tenancy pattern, length-checked first. O(1). */
function isOrganizationId(value: unknown): value is string {
  return typeof value === "string" && value.length <= 64 && ORGANIZATION_ID_PATTERN.test(value);
}

/** A bounded event type string: non-empty, at most 128 characters. O(1). */
function isBoundedEventType(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= MAX_EVENT_TYPE_LENGTH;
}

/** A zoned ISO-8601 timestamp, length-checked before the regex. O(1). */
function isBoundedZonedIso(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_ISO_LENGTH && isZonedIsoDateTime(value);
}

/** A safe non-negative integer: rejects negative, fractional, NaN, Infinity, -0. O(1). */
function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Decide whether a verified forge webhook delivery yields a wake record, in a
 * fixed order:
 *
 * 1. validate `isProxy` and snapshot `input` — any hostile shape, wrong key
 *    set or malformed field is `invalid-input` before anything else;
 * 2. `signatureVerified !== true` is `signature-invalid`;
 * 3. outside the freshness window (`signedAtIso` more than
 *    `WEBHOOK_MAX_AGE_MS` before `receivedAtIso`, or more than
 *    `WEBHOOK_MAX_FUTURE_SKEW_MS` after it) is `stale`;
 * 4. a `deliveryId` already present in `seenDeliveryIds` is `replay`;
 * 5. `payloadBytes > MAX_WEBHOOK_PAYLOAD_BYTES` is `payload-too-large`;
 * 6. an `eventType` outside `ALLOWED_WEBHOOK_EVENT_TYPES` is
 *    `event-not-allowed`;
 * 7. otherwise accepted, with exactly the four-field wake record.
 *
 * No refusal ever echoes the rejected `deliveryId`, `organizationId`,
 * `eventType` or any other input value.
 *
 * Cost bounds:
 * - the `isProxy` check and every scalar field check: O(1);
 * - `snapshotPlainData` and the `seenDeliveryIds` validation/replay check:
 *   O(K) where K <= MAX_SEEN_DELIVERY_IDS (10,000) and every string is
 *   bounded (<= MAX_STRING_LENGTH characters) — the one super-constant step,
 *   sized by the exported constants, not by the input;
 * - timestamp parsing/comparison and the allow-list `Set.has`: O(1).
 */
export function decideWebhookDelivery(input: unknown, isProxy?: IsProxy): WebhookDeliveryDecision {
  const INVALID: WebhookDeliveryDecision = { outcome: "refused", reason: "invalid-input" };

  // Step 1 — validate isProxy and snapshot input.
  if (isProxy !== undefined && typeof isProxy !== "function") {
    return INVALID;
  }
  const detector: IsProxy = isProxy ?? (() => false);
  const snapshot = snapshotPlainData(input, detector, {
    maxDepth: 2,
    maxKeys: 8,
    maxArrayLength: MAX_SEEN_DELIVERY_IDS,
    maxNodes: MAX_SEEN_DELIVERY_IDS + 20,
    maxStringLength: MAX_STRING_LENGTH,
  });
  if (!snapshot.ok) {
    // Every snapshot refusal path (proxy, accessor, not-plain, sparse-array,
    // symbol-key, cycle, too-deep, too-many-*, too-long, unsupported-type,
    // detector-threw, hostile, …) maps to the single typed `invalid-input`.
    return INVALID;
  }
  const root = snapshot.value;
  if (typeof root !== "object" || root === null || Array.isArray(root)) {
    return INVALID;
  }
  // The root's own keys must be exactly the eight required keys, without
  // value reads. Cost: O(K) bounded by the snapshot's maxNodes (10,020).
  let ownKeys: readonly PropertyKey[];
  try {
    ownKeys = Reflect.ownKeys(root);
  } catch {
    return INVALID;
  }
  if (ownKeys.length !== REQUIRED_KEYS.length) {
    return INVALID;
  }
  for (const key of ownKeys) {
    if (typeof key !== "string") {
      return INVALID;
    }
    if (FORBIDDEN_KEYS.has(key) || key === "length") {
      return INVALID;
    }
    if (!(REQUIRED_KEYS as readonly string[]).includes(key)) {
      return INVALID;
    }
  }
  const record = root as Record<string, unknown>;
  if (
    REQUIRED_KEYS.some((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(record, key);
      return descriptor === undefined || descriptor.get !== undefined || !descriptor.enumerable;
    })
  ) {
    return INVALID;
  }

  const deliveryId = record.deliveryId;
  const organizationId = record.organizationId;
  const eventType = record.eventType;
  const receivedAtIso = record.receivedAtIso;
  const signedAtIso = record.signedAtIso;
  const signatureVerified = record.signatureVerified;
  const seenDeliveryIds = record.seenDeliveryIds;
  const payloadBytes = record.payloadBytes;

  if (!isBoundedId(deliveryId) || !isOrganizationId(organizationId) || !isBoundedEventType(eventType)) {
    return INVALID;
  }
  if (!isBoundedZonedIso(receivedAtIso) || !isBoundedZonedIso(signedAtIso)) {
    return INVALID;
  }
  if (typeof signatureVerified !== "boolean") {
    return INVALID;
  }
  if (!Array.isArray(seenDeliveryIds) || seenDeliveryIds.length > MAX_SEEN_DELIVERY_IDS) {
    return INVALID;
  }
  for (const seen of seenDeliveryIds) {
    if (!isBoundedId(seen)) {
      return INVALID;
    }
  }
  if (!isNonNegativeSafeInteger(payloadBytes)) {
    return INVALID;
  }

  // Step 2 — signature check.
  if (signatureVerified !== true) {
    return { outcome: "refused", reason: "signature-invalid" };
  }

  // Step 3 — freshness window. Both strings already passed the calendar and
  // zoned checks, so Date.parse is exact here. O(1).
  const signedMs = Date.parse(signedAtIso as string);
  const receivedMs = Date.parse(receivedAtIso as string);
  if (receivedMs - signedMs > WEBHOOK_MAX_AGE_MS || signedMs - receivedMs > WEBHOOK_MAX_FUTURE_SKEW_MS) {
    return { outcome: "refused", reason: "stale" };
  }

  // Step 4 — replay check. O(K), bounded.
  const seenSet = new Set<string>(seenDeliveryIds as string[]);
  if (seenSet.has(deliveryId as string)) {
    return { outcome: "refused", reason: "replay" };
  }

  // Step 5 — payload size. O(1).
  if ((payloadBytes as number) > MAX_WEBHOOK_PAYLOAD_BYTES) {
    return { outcome: "refused", reason: "payload-too-large" };
  }

  // Step 6 — event allow-list. Set membership, never a property lookup: a
  // plain-object map would admit `__proto__` and `constructor`. O(1).
  if (!ALLOWED_EVENT_TYPE_SET.has(eventType as string)) {
    return { outcome: "refused", reason: "event-not-allowed" };
  }

  // Step 7 — accept with exactly the four wake-record keys.
  const wakeRecord: WebhookWakeRecord = {
    organizationId: organizationId as string,
    eventType: eventType as WebhookEventType,
    deliveryId: deliveryId as string,
    receivedAtIso: receivedAtIso as string,
  };
  return { outcome: "accepted", wakeRecord };
}
