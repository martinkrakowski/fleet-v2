/**
 * FC7C: pure forge webhook delivery decision (FC-7.7). The caller performs
 * the cryptographic signature verification externally and passes only the
 * boolean outcome; this module decides whether the delivery wakes work and,
 * when it does, returns a four-field wake record with no payload, no URL and
 * no body-derived field (FC-R16). Pure domain code: no Node, filesystem,
 * subprocess, network, database or vendor imports; no clock, no randomness,
 *
 * Hostile-input rule (every public function): the input is read exactly once
 * through `snapshotPlainData`, which refuses null-hostile shapes, accessors
 * (getters never run), Proxies (via the caller-supplied trusted detector),
 * symbol
 * keys, sparse arrays, cycles, oversized strings and non-plain prototypes
 * with a typed refusal. Every snapshot refusal path, a missing required key,
 * an extra or unknown key and a prototype-polluting key
 * (`__proto__`, `constructor`, `prototype`) map to `invalid-input`. After the
 * snapshot the root is verified to be a non-null non-array plain object with
 * exactly the eight required own keys — the snapshot copies an own
 * `__proto__` key as data, so the key screen is what catches it. Every
 * failure path returns `{ outcome: "refused", reason }` — never a throw,
 * never a pass — and no rejected value (`deliveryId`, `organizationId`,
 * `eventType` or any other) is ever echoed into a refusal.
 *
 * Cost bounds:
 * - the `isProxy` shape check and every scalar field check: O(1);
 * - `snapshotPlainData` and the `seenDeliveryIds` validation and replay
 *   check: O(K) where `K <= MAX_SEEN_DELIVERY_IDS` (10,000) and every string
 *   is bounded by `maxStringLength` (4096) — the snapshot node budget
 *   (1 root + 8 fields + at most 10,000 array items = 10,009 nodes) is
 *   sized so the whole traversal is admitted;
 * - timestamp parsing and comparison and the event allow-list `Set.has`:
 *   O(1).
 */

import { snapshotPlainData, type IsProxy } from "@fleet/shared";

import {
  isZonedIsoDateTime,
  MAX_STRING_LENGTH,
  ORGANIZATION_ID_PATTERN,
} from "./entities/record-guards.js";

/** A webhook delivery is stale once the signature is this old. */
export const WEBHOOK_MAX_AGE_MS = 5 * 60 * 1000;

/** A signed-in-the-future timestamp is tolerated up to this skew. */
export const WEBHOOK_MAX_FUTURE_SKEW_MS = 60 * 1000;

/** At most this many previously seen delivery ids are accepted for replay screening. */
export const MAX_SEEN_DELIVERY_IDS = 10_000;

/** The declared payload size may not exceed 1 MiB. */
export const MAX_WEBHOOK_PAYLOAD_BYTES = 1_048_576;

/** The only forge event types this wake path accepts. */
export const ALLOWED_WEBHOOK_EVENT_TYPES = [
  "push",
  "pull_request",
  "check_suite",
  "installation",
] as const;

export type WebhookEventType = (typeof ALLOWED_WEBHOOK_EVENT_TYPES)[number];

/**
 * The accepted wake record: exactly four fields, no payload, no URL and no
 * body-derived field (FC-R16).
 */
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

const EVENT_TYPE_SET: ReadonlySet<string> = new Set<string>(ALLOWED_WEBHOOK_EVENT_TYPES);

/** The exactly-eight own keys the input root may carry. */
const REQUIRED_KEYS: readonly string[] = [
  "deliveryId",
  "organizationId",
  "eventType",
  "receivedAtIso",
  "signedAtIso",
  "signatureVerified",
  "seenDeliveryIds",
  "payloadBytes",
];

/** Key names refused outright, screened against the snapshotted own keys. */
const FORBIDDEN_KEYS: ReadonlySet<string> = new Set<string>([
  "__proto__",
  "constructor",
  "prototype",
  "length",
]);

const MAX_DELIVERY_ID_LENGTH = 256;
const MAX_EVENT_TYPE_LENGTH = 128;
const MAX_ISO_LENGTH = 64;

const SNAPSHOT_LIMITS = Object.freeze({
  maxDepth: 2,
  maxKeys: 8,
  maxArrayLength: MAX_SEEN_DELIVERY_IDS,
  maxNodes: MAX_SEEN_DELIVERY_IDS + 20,
  maxStringLength: MAX_STRING_LENGTH,
});

const INVALID: WebhookDeliveryDecision = { outcome: "refused", reason: "invalid-input" };

/**
 * A bounded, non-empty, control-character-free identifier string (a
 * `deliveryId` or a `seenDeliveryIds` item). Cost bound: O(1) in the string
 * length bound (256) — one length check and one bounded scan.
 */
function isValidDeliveryId(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_DELIVERY_ID_LENGTH) {
    return false;
  }
  return !hasControlChar(value) && value.trim().length > 0;
}

/** True when the string carries a control character (`<= 0x1f` or `0x7f`). O(1) in the length bound. */
function hasControlChar(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) {
      return true;
    }
  }
  return false;
}

/** A zoned ISO-8601 timestamp, length-checked before the regex. O(1). */
function isValidTimestamp(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_ISO_LENGTH && isZonedIsoDateTime(value);
}

/**
 * Validate the `seenDeliveryIds` field of an already-snapshotted record: a
 * dense array of at most `MAX_SEEN_DELIVERY_IDS` non-empty, bounded,
 * control-character-free strings. Cost bound: O(K), `K <= MAX_SEEN_DELIVERY_IDS`.
 */
function isValidSeenDeliveryIds(value: unknown): value is readonly string[] {
  if (!Array.isArray(value) || value.length > MAX_SEEN_DELIVERY_IDS) {
    return false;
  }
  for (const item of value) {
    if (!isValidDeliveryId(item)) {
      return false;
    }
  }
  return true;
}

/**
 * Screen an already-snapshotted plain object's own keys: exactly the eight
 * required keys, no prototype-polluting name and no `length` key. The
 * snapshot has already refused symbol keys and non-enumerable keys, so
 * `Object.keys` over the frozen plain copy sees every own key. Cost bound:
 * O(1) — one pass over at most 8 keys.
 */
function hasExactRequiredKeys(snap: Record<string, unknown>): boolean {
  const ownKeys = Object.keys(snap);
  if (ownKeys.length !== REQUIRED_KEYS.length) {
    return false;
  }
  for (const key of ownKeys) {
    if (FORBIDDEN_KEYS.has(key)) {
      return false;
    }
    if (!REQUIRED_KEYS.includes(key)) {
      return false;
    }
  }
  return true;
}

/**
 * Decide whether one forge webhook delivery wakes work. Pure. The caller
 * verifies the signature externally and passes the boolean outcome as
 * `signatureVerified`; this module never sees the payload, the URL or the
 * raw body.
 *
 * Fixed order:
 *
 * 1. snapshot and validate the input (any failure is `invalid-input`);
 * 2. `signatureVerified !== true` is `signature-invalid`;
 * 3. outside the freshness window is `stale`;
 * 4. an already-seen `deliveryId` is `replay`;
 * 5. `payloadBytes` above 1 MiB is `payload-too-large`;
 * 6. a disallowed `eventType` is `event-not-allowed`;
 * 7. otherwise the delivery is accepted with a four-field wake record.
 *
 * `isProxy` is a required, separate positional parameter (never a field of
 * an options object — `snapshotPlainData` refuses function values). It must
 * be a trusted, accurate, side-effect-free Proxy detector: with no detector
 * supplied, a Proxy over otherwise-valid input would be snapshotted as plain
 * data and could be accepted, and the missed Proxy's reflection traps could
 * run during snapshotting — so a missing, `undefined` or otherwise
 * non-function detector is refused as `invalid-input` and no snapshot is
 * attempted. A refusal never echoes `deliveryId` or any rejected value.
 */
export function decideWebhookDelivery(input: unknown, isProxy: IsProxy): WebhookDeliveryDecision {
  if (typeof isProxy !== "function") {
    return INVALID;
  }
  const snapshot = snapshotPlainData(input, isProxy, SNAPSHOT_LIMITS);
  if (!snapshot.ok) {
    return INVALID;
  }
  const snap = snapshot.value;
  if (typeof snap !== "object" || snap === null || Array.isArray(snap)) {
    return INVALID;
  }
  const record = snap as Record<string, unknown>;
  if (!hasExactRequiredKeys(record)) {
    return INVALID;
  }
  if (
    !isValidDeliveryId(record.deliveryId)
    || typeof record.organizationId !== "string"
    || !ORGANIZATION_ID_PATTERN.test(record.organizationId)
    || typeof record.eventType !== "string"
    || record.eventType.length === 0
    || record.eventType.length > MAX_EVENT_TYPE_LENGTH
    || !isValidTimestamp(record.receivedAtIso)
    || !isValidTimestamp(record.signedAtIso)
    || typeof record.signatureVerified !== "boolean"
    || !isValidSeenDeliveryIds(record.seenDeliveryIds)
    || typeof record.payloadBytes !== "number"
    || !Number.isSafeInteger(record.payloadBytes)
    || record.payloadBytes < 0
  ) {
    return INVALID;
  }
  if (record.signatureVerified !== true) {
    return { outcome: "refused", reason: "signature-invalid" };
  }
  const signedMs = Date.parse(record.signedAtIso);
  const receivedMs = Date.parse(record.receivedAtIso);
  if (receivedMs - signedMs > WEBHOOK_MAX_AGE_MS || signedMs - receivedMs > WEBHOOK_MAX_FUTURE_SKEW_MS) {
    return { outcome: "refused", reason: "stale" };
  }
  if ((record.seenDeliveryIds as readonly string[]).includes(record.deliveryId)) {
    return { outcome: "refused", reason: "replay" };
  }
  if (record.payloadBytes > MAX_WEBHOOK_PAYLOAD_BYTES) {
    return { outcome: "refused", reason: "payload-too-large" };
  }
  if (!EVENT_TYPE_SET.has(record.eventType)) {
    return { outcome: "refused", reason: "event-not-allowed" };
  }
  return {
    outcome: "accepted",
    wakeRecord: {
      organizationId: record.organizationId,
      eventType: record.eventType as WebhookEventType,
      deliveryId: record.deliveryId,
      receivedAtIso: record.receivedAtIso,
    },
  };
}
