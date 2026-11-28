import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  ALLOWED_WEBHOOK_EVENT_TYPES,
  MAX_SEEN_DELIVERY_IDS,
  MAX_WEBHOOK_PAYLOAD_BYTES,
  WEBHOOK_MAX_AGE_MS,
  WEBHOOK_MAX_FUTURE_SKEW_MS,
  decideWebhookDelivery,
} from "../webhook-delivery.js";

const SOURCE = readFileSync(new URL("../webhook-delivery.ts", import.meta.url), "utf8");

const RECEIVED = "2026-11-27T12:00:00.000Z";
const SIGNED = "2026-11-27T11:59:30.000Z";

const baseInput = () => ({
  deliveryId: "delivery-0001",
  organizationId: "org-1",
  eventType: "push",
  receivedAtIso: RECEIVED,
  signedAtIso: SIGNED,
  signatureVerified: true,
  seenDeliveryIds: ["delivery-0000"],
  payloadBytes: 512,
});

/**
 * The trusted, accurate, side-effect-free detector the production caller
 * supplies (in production, the runtime's `types.isProxy`). In these tests it
 * reports nothing as a Proxy except where a test injects a flagging one.
 */
const NO_PROXY = (): boolean => false;

const accept = (overrides: Record<string, unknown> = {}) =>
  decideWebhookDelivery({ ...baseInput(), ...overrides }, NO_PROXY);

const refused = (overrides: Record<string, unknown> = {}) => {
  const result = decideWebhookDelivery({ ...baseInput(), ...overrides }, NO_PROXY);
  if (result.outcome !== "refused") {
    throw new Error("expected refused");
  }
  return result;
};

/** A Proxy whose every trap throws: the reader must never invoke it. */
function throwingProxy(): object {
  return new Proxy(
    {},
    {
      get() {
        throw new Error("trap");
      },
      getOwnPropertyDescriptor() {
        throw new Error("trap");
      },
      getPrototypeOf() {
        throw new Error("trap");
      },
      ownKeys() {
        throw new Error("trap");
      },
    },
  );
}

/** An object whose `deliveryId` is a getter that throws when run. */
function getterInput(): object {
  const input = baseInput() as Record<string, unknown>;
  return Object.defineProperty(input, "deliveryId", {
    get() {
      throw new Error("getter must never run");
    },
    enumerable: true,
  });
}

describe("webhook-delivery module purity", () => {
  it("contains no clock, randomness, network, crypto, or node imports in source", () => {
    expect(SOURCE).not.toMatch(/Date\.now/);
    expect(SOURCE).not.toMatch(/new Date\(\s*\)/);
    expect(SOURCE).not.toMatch(/Math\.random/);
    expect(SOURCE).not.toMatch(/\bcrypto\b/);
    expect(SOURCE).not.toMatch(/\bprocess\b/);
    expect(SOURCE).not.toMatch(/node:/);
    expect(SOURCE).not.toMatch(/\bfetch\b/);
    expect(SOURCE).not.toMatch(/require\(/);
  });
});

describe("decideWebhookDelivery", () => {
  it("accepts a verified, fresh, unseen delivery and returns a four-field wake record", () => {
    const result = accept();
    expect(result.outcome).toBe("accepted");
    if (result.outcome !== "accepted") throw new Error("unreachable");
    expect(Object.keys(result.wakeRecord).sort()).toEqual([
      "deliveryId",
      "eventType",
      "organizationId",
      "receivedAtIso",
    ]);
    expect(result.wakeRecord).toEqual({
      organizationId: "org-1",
      eventType: "push",
      deliveryId: "delivery-0001",
      receivedAtIso: RECEIVED,
    });
    // No payload, no URL, no body-derived field on the wake record.
    expect("payloadBytes" in result.wakeRecord).toBe(false);
    expect("seenDeliveryIds" in result.wakeRecord).toBe(false);
    expect("signedAtIso" in result.wakeRecord).toBe(false);
    expect("signatureVerified" in result.wakeRecord).toBe(false);
  });

  it("accepts each allowed eventType in ALLOWED_WEBHOOK_EVENT_TYPES with exactly four keys on wakeRecord", () => {
    for (const eventType of ALLOWED_WEBHOOK_EVENT_TYPES) {
      const result = accept({ eventType });
      expect(result.outcome).toBe("accepted");
      if (result.outcome !== "accepted") throw new Error("unreachable");
      expect(Object.keys(result.wakeRecord)).toHaveLength(4);
      expect(result.wakeRecord.eventType).toBe(eventType);
    }
  });

  it("refuses hostile input shapes and non-function isProxy without invoking getters or Proxy traps", () => {
    const hostileInputs: unknown[] = [
      null,
      undefined,
      42,
      "str",
      true,
      [baseInput()],
      { ...baseInput(), length: 3 },
      new Date(),
      new Map(),
      getterInput(),
      throwingProxy(),
      Object.defineProperty({ ...baseInput() }, "__proto__", { value: null, enumerable: true }),
      Object.defineProperty({ ...baseInput() }, "constructor", { value: 1, enumerable: true }),
      Object.defineProperty({ ...baseInput() }, "prototype", { value: 1, enumerable: true }),
      // missing keys
      (() => {
        const rest: Record<string, unknown> = { ...baseInput() };
        delete rest.payloadBytes;
        return rest;
      })(),
      (() => {
        const rest: Record<string, unknown> = { ...baseInput() };
        delete rest.signedAtIso;
        return rest;
      })(),
      // extra unknown key
      { ...baseInput(), extra: 1 },
      // symbol key
      (() => {
        const input = baseInput() as Record<string, unknown>;
        return Object.defineProperty(input, "symbolKey", { value: 1, enumerable: true });
      })(),
      // non-enumerable key
      (() => {
        const input = baseInput() as Record<string, unknown>;
        return Object.defineProperty(input, "hidden", { value: 1, enumerable: false });
      })(),
      // getter on seenDeliveryIds index
      (() => {
        const input = baseInput() as Record<string, unknown>;
        input.seenDeliveryIds = Object.defineProperty(["delivery-0000"], "0", {
          get() {
            throw new Error("getter must never run");
          },
          enumerable: true,
        });
        return input;
      })(),
    ];
    for (const hostile of hostileInputs) {
      const result = decideWebhookDelivery(hostile, NO_PROXY);
      expect(result).toEqual({ outcome: "refused", reason: "invalid-input" });
    }
    for (const isProxy of [42, null, {}, "fn", true]) {
      expect(decideWebhookDelivery(baseInput(), isProxy as never)).toEqual({
        outcome: "refused",
        reason: "invalid-input",
      });
    }
  });

  it("refuses Proxy input when isProxy detector returns true", () => {
    const detector = (value: unknown): boolean => typeof value === "object" && value !== null;
    expect(decideWebhookDelivery(baseInput(), detector)).toEqual({
      outcome: "refused",
      reason: "invalid-input",
    });
    // A plain input with the same detector is still refused: the detector
    // flags the root object itself as a Proxy.
    expect(decideWebhookDelivery(baseInput(), () => false).outcome).toBe("accepted");
  });

  it("refuses input when no isProxy detector is supplied instead of treating Proxies as plain data", () => {
    // The trusted detector is required: with the detector omitted at the
    // call site (a JS caller can bypass the type), a Proxy over otherwise
    // valid input would be snapshotted as plain data and could be accepted,
    // with its reflection traps free to run during snapshotting.
    const omitted = (): unknown =>
      // The omitted-argument shape is exactly what a JS caller produces.
      (decideWebhookDelivery as unknown as (input: unknown) => unknown)(baseInput());
    expect(omitted()).toEqual({ outcome: "refused", reason: "invalid-input" });
    expect(decideWebhookDelivery(baseInput(), undefined as never)).toEqual({
      outcome: "refused",
      reason: "invalid-input",
    });
    // The same input with a trusted detector is still accepted: only the
    // missing detector is refused.
    expect(decideWebhookDelivery(baseInput(), NO_PROXY).outcome).toBe("accepted");
  });

  it("refuses malformed deliveryId, organizationId, eventType, timestamps, signatureVerified, and payloadBytes as invalid-input", () => {
    const badDeliveryIds = [
      "",
      "a".repeat(257),
      "id\nwith newline",
      "id\u0000",
      "id\u007f",
      "   ",
      42,
      null,
    ];
    for (const deliveryId of badDeliveryIds) {
      expect(refused({ deliveryId }).reason).toBe("invalid-input");
    }
    for (const organizationId of ["", "Org-1", "org_1", "-org", "a".repeat(65), 42, null]) {
      expect(refused({ organizationId }).reason).toBe("invalid-input");
    }
    for (const eventType of ["", "a".repeat(129), 42, null]) {
      expect(refused({ eventType }).reason).toBe("invalid-input");
    }
    for (const field of ["receivedAtIso", "signedAtIso"] as const) {
      for (const value of [
        "",
        "not-a-date",
        "2026-02-31T12:00:00.000Z",
        "2026-11-27T12:00:00",
        42,
        null,
      ]) {
        expect(refused({ [field]: value }).reason).toBe("invalid-input");
      }
    }
    for (const signatureVerified of ["true", 1, null, undefined]) {
      expect(refused({ signatureVerified }).reason).toBe("invalid-input");
    }
    for (const payloadBytes of [-1, 1.5, NaN, Infinity, -Infinity, "512", null, -0]) {
      expect(refused({ payloadBytes }).reason).toBe("invalid-input");
    }
  });

  it("refuses non-array, sparse array with hole, getter element, non-string element, and 10001-entry seenDeliveryIds as invalid-input", () => {
    for (const seenDeliveryIds of [
      null,
      {},
      "id-1",
      { length: 1, 0: "id-1" },
      // A real hole: index 0 is never defined.
      (() => {
        const holey = new Array<string | undefined>(2);
        holey[1] = "id-1";
        return holey;
      })(),
      Object.defineProperty(["delivery-0000"], "0", {
        get() {
          throw new Error("getter must never run");
        },
        enumerable: true,
      }),
      ["delivery-0000", 42],
      [""],
      Array.from({ length: MAX_SEEN_DELIVERY_IDS + 1 }, (_, i) => `id-${i}`),
    ]) {
      const result = decideWebhookDelivery({ ...baseInput(), seenDeliveryIds }, NO_PROXY);
      expect(result).toEqual({ outcome: "refused", reason: "invalid-input" });
    }
  });

  it("accepts seenDeliveryIds at the 10000-entry boundary", () => {
    const seenDeliveryIds = Array.from(
      { length: MAX_SEEN_DELIVERY_IDS },
      (_, i) => `id-${i}`,
    );
    const result = decideWebhookDelivery({ ...baseInput(), seenDeliveryIds }, NO_PROXY);
    expect(result.outcome).toBe("accepted");
  });

  it("refuses unverified signature as signature-invalid", () => {
    for (const signatureVerified of [false]) {
      expect(refused({ signatureVerified })).toEqual({
        outcome: "refused",
        reason: "signature-invalid",
      });
    }
  });

  it("refuses signedAtIso more than 5 minutes before receivedAtIso as stale and accepts at 5-minute boundary", () => {
    const tooOld = new Date(Date.parse(RECEIVED) - WEBHOOK_MAX_AGE_MS - 1).toISOString();
    const atBoundary = new Date(Date.parse(RECEIVED) - WEBHOOK_MAX_AGE_MS).toISOString();
    expect(refused({ signedAtIso: tooOld })).toEqual({ outcome: "refused", reason: "stale" });
    expect(accept({ signedAtIso: atBoundary }).outcome).toBe("accepted");
  });

  it("refuses signedAtIso more than 60 seconds after receivedAtIso as stale and accepts at 60-second boundary", () => {
    const tooFuture = new Date(Date.parse(RECEIVED) + WEBHOOK_MAX_FUTURE_SKEW_MS + 1).toISOString();
    const atBoundary = new Date(Date.parse(RECEIVED) + WEBHOOK_MAX_FUTURE_SKEW_MS).toISOString();
    expect(refused({ signedAtIso: tooFuture })).toEqual({ outcome: "refused", reason: "stale" });
    expect(accept({ signedAtIso: atBoundary }).outcome).toBe("accepted");
  });

  it("refuses deliveryId already present in seenDeliveryIds as replay", () => {
    expect(refused({ seenDeliveryIds: ["delivery-0001", "other"] })).toEqual({
      outcome: "refused",
      reason: "replay",
    });
  });

  it("refuses payloadBytes above 1048576 as payload-too-large and accepts at exact boundary", () => {
    expect(refused({ payloadBytes: MAX_WEBHOOK_PAYLOAD_BYTES + 1 })).toEqual({
      outcome: "refused",
      reason: "payload-too-large",
    });
    expect(accept({ payloadBytes: MAX_WEBHOOK_PAYLOAD_BYTES }).outcome).toBe("accepted");
  });

  it("refuses disallowed eventType including __proto__ and constructor as event-not-allowed", () => {
    for (const eventType of ["deployment", "__proto__", "constructor", "prototype", "PUSH"]) {
      expect(refused({ eventType })).toEqual({
        outcome: "refused",
        reason: "event-not-allowed",
      });
    }
  });

  it("enforces fixed refusal order when two faults occur simultaneously", () => {
    // invalid-input before signature-invalid
    expect(refused({ signatureVerified: false, deliveryId: "" }).reason).toBe("invalid-input");
    // signature-invalid before stale
    expect(
      refused({ signatureVerified: false, signedAtIso: "2020-01-01T00:00:00.000Z" }).reason,
    ).toBe("signature-invalid");
    // stale before replay
    expect(
      refused({ signedAtIso: "2020-01-01T00:00:00.000Z", seenDeliveryIds: ["delivery-0001"] })
        .reason,
    ).toBe("stale");
    // replay before payload-too-large
    expect(
      refused({ seenDeliveryIds: ["delivery-0001"], payloadBytes: MAX_WEBHOOK_PAYLOAD_BYTES + 1 })
        .reason,
    ).toBe("replay");
    // payload-too-large before event-not-allowed
    expect(
      refused({ payloadBytes: MAX_WEBHOOK_PAYLOAD_BYTES + 1, eventType: "deployment" }).reason,
    ).toBe("payload-too-large");
  });

  it("never echoes deliveryId in any refusal result", () => {
    const deliveryId = "delivery-secret-0001";
    const results = [
      refused({ signatureVerified: false }),
      refused({ deliveryId, signatureVerified: false }),
      refused({ deliveryId, signedAtIso: "2020-01-01T00:00:00.000Z" }),
      refused({ deliveryId, seenDeliveryIds: [deliveryId] }),
      refused({ deliveryId, payloadBytes: MAX_WEBHOOK_PAYLOAD_BYTES + 1 }),
      refused({ deliveryId, eventType: "deployment" }),
      decideWebhookDelivery(null, NO_PROXY),
      decideWebhookDelivery(42, NO_PROXY),
      decideWebhookDelivery(baseInput(), 42 as never),
    ];
    for (const result of results) {
      expect(result.outcome).toBe("refused");
      expect(Object.keys(result).sort()).toEqual(["outcome", "reason"]);
      expect(JSON.stringify(result)).toMatch(/^\{"outcome":"refused","reason":"[a-z-]+"\}$/);
      expect(JSON.stringify(result)).not.toContain(deliveryId);
    }
  });
});
