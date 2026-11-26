import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  ALLOWED_WEBHOOK_EVENT_TYPES,
  MAX_SEEN_DELIVERY_IDS,
  MAX_WEBHOOK_PAYLOAD_BYTES,
  WEBHOOK_MAX_AGE_MS,
  WEBHOOK_MAX_FUTURE_SKEW_MS,
  decideWebhookDelivery,
  type WebhookDeliveryDecision,
  type WebhookWakeRecord,
} from "../webhook-delivery.js";
import { MAX_STRING_LENGTH } from "../entities/record-guards.js";

const SOURCE = readFileSync(new URL("../webhook-delivery.ts", import.meta.url), "utf8");

const RECEIVED = "2026-11-26T12:00:00.000Z";
const SIGNED = "2026-11-26T11:57:30.000Z";
const DELIVERY_ID = "delivery-0001";
const ORGANIZATION_ID = "org-42";
const EVENT_TYPE = "push";

type Input = Record<string, unknown>;

const baseInput = (overrides: Record<string, unknown> = {}): Input => ({
  deliveryId: DELIVERY_ID,
  organizationId: ORGANIZATION_ID,
  eventType: EVENT_TYPE,
  receivedAtIso: RECEIVED,
  signedAtIso: SIGNED,
  signatureVerified: true,
  seenDeliveryIds: [],
  payloadBytes: 1024,
  ...overrides,
});

/**
 * Production passes the trusted `types.isProxy` predicate from
 * infrastructure; the tests stand in for that with a side-effect-free
 * detector unless a specific one is being exercised.
 */
const TRUSTED_DETECTOR = (): boolean => false;

const accept = (input: unknown, isProxy?: (value: unknown) => boolean): WebhookWakeRecord => {
  const result = decideWebhookDelivery(input, isProxy ?? TRUSTED_DETECTOR);
  if (result.outcome !== "accepted") {
    throw new Error(`expected accepted, got ${JSON.stringify(result)}`);
  }
  return result.wakeRecord;
};

const refuseReason = (input: unknown, isProxy?: (value: unknown) => boolean): string => {
  const result = decideWebhookDelivery(input, isProxy ?? TRUSTED_DETECTOR);
  if (result.outcome !== "refused") {
    throw new Error(`expected refused, got ${JSON.stringify(result)}`);
  }
  return result.reason;
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
      has() {
        throw new Error("trap");
      },
    },
  );
}

describe("webhook-delivery module purity", () => {
  it("contains no clock, randomness, network, crypto, or node imports in source", () => {
    expect(SOURCE).not.toMatch(/Date\.now/);
    expect(SOURCE).not.toMatch(/new Date\(\s*\)/);
    expect(SOURCE).not.toMatch(/Math\.random/);
    expect(SOURCE).not.toMatch(/\bcrypto\b/);
    expect(SOURCE).not.toMatch(/node:/);
    expect(SOURCE).not.toMatch(/require\(/);
    expect(SOURCE).not.toMatch(/from ["']node/);
  });

  it("never echoes deliveryId in any refusal result", () => {
    const secret = "SECRET-DELIVERY-ID";
    const hostile = [
      null,
      throwingProxy(),
      baseInput({ signatureVerified: false, deliveryId: secret }),
      baseInput({ deliveryId: secret, seenDeliveryIds: [secret] }),
      baseInput({ payloadBytes: MAX_WEBHOOK_PAYLOAD_BYTES + 1, deliveryId: secret }),
      baseInput({ eventType: "SECRET-EVENT", deliveryId: secret }),
      baseInput({ organizationId: "SECRET-ORG", deliveryId: secret }),
      baseInput({ signedAtIso: "2026-11-26T10:00:00.000Z", deliveryId: secret }),
    ];
    for (const input of hostile) {
      const result = decideWebhookDelivery(input);
      expect(result.outcome).toBe("refused");
      expect(JSON.stringify(result)).not.toContain("SECRET");
      // A refusal carries exactly the two agreed keys and nothing else.
      expect(Object.keys(result).sort()).toEqual(["outcome", "reason"]);
    }
  });
});

describe("decideWebhookDelivery — accepted wake record", () => {
  it("accepts a valid verified delivery with exactly the four wake-record keys", () => {
    const wakeRecord = accept(baseInput());
    expect(Object.keys(wakeRecord).sort()).toEqual([
      "deliveryId",
      "eventType",
      "organizationId",
      "receivedAtIso",
    ]);
    expect(wakeRecord).toEqual({
      organizationId: ORGANIZATION_ID,
      eventType: EVENT_TYPE,
      deliveryId: DELIVERY_ID,
      receivedAtIso: RECEIVED,
    });
  });

  it("accepts each allowed eventType in ALLOWED_WEBHOOK_EVENT_TYPES with exactly four keys on wakeRecord", () => {
    for (const eventType of ALLOWED_WEBHOOK_EVENT_TYPES) {
      const wakeRecord = accept(baseInput({ eventType }));
      expect(wakeRecord.eventType).toBe(eventType);
      expect(Object.keys(wakeRecord)).toHaveLength(4);
    }
  });

  it("accepts seenDeliveryIds at the 10000-entry boundary", () => {
    const seen = Array.from({ length: MAX_SEEN_DELIVERY_IDS }, (_, i) => `seen-${i}`);
    expect(seen).toHaveLength(10_000);
    const wakeRecord = accept(baseInput({ seenDeliveryIds: seen }));
    expect(wakeRecord.deliveryId).toBe(DELIVERY_ID);
  });
});

describe("decideWebhookDelivery — hostile input and isProxy", () => {
  it("refuses hostile input shapes and non-function isProxy without invoking getters or Proxy traps", () => {
    const getterInput = Object.defineProperty(baseInput(), "deliveryId", {
      get() {
        throw new Error("getter must never run");
      },
      enumerable: true,
    });
    const sparse: unknown[] = new Array(2);
    sparse[1] = "seen-1";
    const getterSeen = baseInput({
      seenDeliveryIds: Object.defineProperty(["seen-0"], "0", {
        get() {
          throw new Error("getter must never run");
        },
        enumerable: true,
      }),
    });
    const hostileInputs: unknown[] = [
      null,
      undefined,
      42,
      "str",
      true,
      [baseInput()],
      { length: 3 },
      new Date(),
      new Map(),
      getterInput,
      throwingProxy(),
      // missing key
      (() => {
        const rest = baseInput();
        delete rest.seenDeliveryIds;
        return rest;
      })(),
      // extra unknown key
      { ...baseInput(), extra: 1 },
      // symbol key
      Object.assign(baseInput(), { [Symbol("s")]: 1 }),
      // non-enumerable key
      Object.defineProperty(baseInput(), "deliveryId", { value: DELIVERY_ID, enumerable: false }),
      // array-like with length key
      { ...baseInput(), length: 3 },
      // prototype-polluting keys
      Object.defineProperty(baseInput(), "__proto__", { value: null, enumerable: true }),
      Object.defineProperty(baseInput(), "constructor", { value: 1, enumerable: true }),
      Object.defineProperty(baseInput(), "prototype", { value: 1, enumerable: true }),
      // seenDeliveryIds variants
      baseInput({ seenDeliveryIds: null }),
      baseInput({ seenDeliveryIds: {} }),
      baseInput({ seenDeliveryIds: "id-1" }),
      baseInput({ seenDeliveryIds: { length: 1, 0: "id-1" } }),
      baseInput({ seenDeliveryIds: sparse }),
      getterSeen,
      baseInput({ seenDeliveryIds: [42] }),
      baseInput({ seenDeliveryIds: [""] }),
      baseInput({ seenDeliveryIds: Array.from({ length: MAX_SEEN_DELIVERY_IDS + 1 }, (_, i) => `seen-${i}`) }),
    ];
    for (const input of hostileInputs) {
      expect(refuseReason(input)).toBe("invalid-input");
    }
    for (const badDetector of [42, null, {}, "x"]) {
      const result = decideWebhookDelivery(baseInput(), badDetector as never);
      expect(result).toEqual({ outcome: "refused", reason: "invalid-input" });
    }
  });

  it("refuses an object input when isProxy is omitted, including a calm Proxy wrapping valid input, without running any trap", () => {
    // No trusted detector, no snapshot: every object input is refused before
    // snapshotPlainData can touch it, so a Proxy's traps can never run.
    expect(decideWebhookDelivery(baseInput()).outcome).toBe("refused");
    const reason = (decideWebhookDelivery(baseInput()) as { reason: string }).reason;
    expect(reason).toBe("invalid-input");

    // A calm Proxy wrapping valid input is refused, not accepted.
    const calmProxy = new Proxy(baseInput(), {});
    expect(decideWebhookDelivery(calmProxy).outcome).toBe("refused");
    expect((decideWebhookDelivery(calmProxy) as { reason: string }).reason).toBe("invalid-input");

    // A trap with side effects never runs: the trap records any invocation
    // and would make the test fail even though the result is still a refusal.
    let trapsRun = 0;
    const sideEffectProxy = new Proxy(baseInput(), {
      get() {
        trapsRun += 1;
        return undefined;
      },
      getOwnPropertyDescriptor() {
        trapsRun += 1;
        return undefined;
      },
      getPrototypeOf() {
        trapsRun += 1;
        return Object.prototype;
      },
      ownKeys() {
        trapsRun += 1;
        return [];
      },
      has() {
        trapsRun += 1;
        return false;
      },
    });
    expect(decideWebhookDelivery(sideEffectProxy).outcome).toBe("refused");
    expect(trapsRun).toBe(0);

    // Primitives and null are not proxiable and keep their existing refusal
    // without a detector.
    for (const primitive of [null, 42, "str", true, undefined]) {
      expect(refuseReason(primitive, undefined)).toBe("invalid-input");
    }
  });

  it("refuses Proxy input when isProxy detector returns true", () => {
    const detector = (value: unknown): boolean => value === trappingProxy;
    const trappingProxy = throwingProxy();
    expect(refuseReason(trappingProxy, detector)).toBe("invalid-input");
    // Even a calm proxy is refused when the detector says so.
    const calm = new Proxy(baseInput(), {});
    expect(refuseReason(calm, detector === undefined ? undefined : (v) => v === calm)).toBe(
      "invalid-input",
    );
  });
});

describe("decideWebhookDelivery — malformed scalar fields", () => {
  it("refuses malformed deliveryId, organizationId, eventType, timestamps, signatureVerified, and payloadBytes as invalid-input", () => {
    const badDeliveryIds = [42, null, "", " ".repeat(4), "a".repeat(257), `bad\nid`, `bad\tid`, "id\u007f"];
    for (const deliveryId of badDeliveryIds) {
      expect(refuseReason(baseInput({ deliveryId }))).toBe("invalid-input");
    }
    const badOrganizations = ["", "ORG-42", "org_42", "org/42", "a".repeat(65), "-org", 42, null];
    for (const organizationId of badOrganizations) {
      expect(refuseReason(baseInput({ organizationId }))).toBe("invalid-input");
    }
    const badEventTypes = ["", 42, null, "a".repeat(129)];
    for (const eventType of badEventTypes) {
      expect(refuseReason(baseInput({ eventType }))).toBe("invalid-input");
    }
    const badTimestamps = ["", "not-a-date", "2026-02-31T12:00:00.000Z", "2026-11-26 12:00:00", 42, null, "a".repeat(65)];
    for (const field of ["receivedAtIso", "signedAtIso"]) {
      for (const value of badTimestamps) {
        expect(refuseReason(baseInput({ [field]: value }))).toBe("invalid-input");
      }
    }
    const badSignatureVerified = ["true", 1, 0, null, undefined];
    for (const signatureVerified of badSignatureVerified) {
      expect(refuseReason(baseInput({ signatureVerified }))).toBe("invalid-input");
    }
    const badPayloadBytes = [-1, -0, 1.5, NaN, Infinity, -Infinity, "1024", null, 2 ** 53];
    for (const payloadBytes of badPayloadBytes) {
      expect(refuseReason(baseInput({ payloadBytes }))).toBe("invalid-input");
    }
  });
});

describe("decideWebhookDelivery — signature check", () => {
  it("refuses unverified signature as signature-invalid", () => {
    expect(refuseReason(baseInput({ signatureVerified: false }))).toBe("signature-invalid");
  });
});

describe("decideWebhookDelivery — freshness window", () => {
  it("refuses signedAtIso more than 5 minutes before receivedAtIso as stale and accepts at 5-minute boundary", () => {
    expect(WEBHOOK_MAX_AGE_MS).toBe(300_000);
    const oneTooOld = new Date(Date.parse(RECEIVED) - WEBHOOK_MAX_AGE_MS - 1).toISOString();
    const atBoundary = new Date(Date.parse(RECEIVED) - WEBHOOK_MAX_AGE_MS).toISOString();
    expect(refuseReason(baseInput({ signedAtIso: oneTooOld }))).toBe("stale");
    expect(accept(baseInput({ signedAtIso: atBoundary })).deliveryId).toBe(DELIVERY_ID);
  });

  it("refuses signedAtIso more than 60 seconds after receivedAtIso as stale and accepts at 60-second boundary", () => {
    expect(WEBHOOK_MAX_FUTURE_SKEW_MS).toBe(60_000);
    const oneTooFar = new Date(Date.parse(RECEIVED) + WEBHOOK_MAX_FUTURE_SKEW_MS + 1).toISOString();
    const atBoundary = new Date(Date.parse(RECEIVED) + WEBHOOK_MAX_FUTURE_SKEW_MS).toISOString();
    expect(refuseReason(baseInput({ signedAtIso: oneTooFar }))).toBe("stale");
    expect(accept(baseInput({ signedAtIso: atBoundary })).deliveryId).toBe(DELIVERY_ID);
  });

  it("refuses sub-millisecond excess beyond the 60-second future-skew limit that Date.parse alone would hide", () => {
    // 60 s + 1 μs: Date.parse truncates the μs and sees exactly 60 s, but the
    // real skew exceeds the limit, so this must be `stale`.
    expect(
      refuseReason(
        baseInput({ receivedAtIso: "2026-11-26T12:00:00.000Z", signedAtIso: "2026-11-26T12:01:00.000001Z" }),
      ),
    ).toBe("stale");
    // Exactly 60 s with a truncated zero fraction is accepted.
    expect(
      accept(
        baseInput({ receivedAtIso: "2026-11-26T12:00:00.000Z", signedAtIso: "2026-11-26T12:01:00.000000Z" }),
      ).deliveryId,
    ).toBe(DELIVERY_ID);
    // 1 μs inside the limit (60 s − 1 μs) is accepted.
    expect(
      accept(
        baseInput({ receivedAtIso: "2026-11-26T12:00:00.000Z", signedAtIso: "2026-11-26T12:00:59.999999Z" }),
      ).deliveryId,
    ).toBe(DELIVERY_ID);
  });

  it("refuses sub-millisecond excess beyond the 5-minute age limit that Date.parse alone would hide", () => {
    // Received fraction pushes the real age past 5 minutes while both parsed
    // stamps sit exactly on the boundary.
    expect(
      refuseReason(
        baseInput({ receivedAtIso: "2026-11-26T12:00:00.000001Z", signedAtIso: "2026-11-26T11:55:00.000000Z" }),
      ),
    ).toBe("stale");
    // The signed fraction pulling the real age back inside the window is
    // accepted.
    expect(
      accept(
        baseInput({ receivedAtIso: "2026-11-26T12:00:00.000000Z", signedAtIso: "2026-11-26T11:55:00.000001Z" }),
      ).deliveryId,
    ).toBe(DELIVERY_ID);
  });
});

describe("decideWebhookDelivery — replay, payload size, event allow-list", () => {
  it("refuses deliveryId already present in seenDeliveryIds as replay", () => {
    expect(refuseReason(baseInput({ seenDeliveryIds: [DELIVERY_ID] }))).toBe("replay");
  });

  it("refuses payloadBytes above 1048576 as payload-too-large and accepts at exact boundary", () => {
    expect(MAX_WEBHOOK_PAYLOAD_BYTES).toBe(1_048_576);
    expect(refuseReason(baseInput({ payloadBytes: MAX_WEBHOOK_PAYLOAD_BYTES + 1 }))).toBe(
      "payload-too-large",
    );
    expect(accept(baseInput({ payloadBytes: MAX_WEBHOOK_PAYLOAD_BYTES })).deliveryId).toBe(DELIVERY_ID);
  });

  it("refuses disallowed eventType including __proto__ and constructor as event-not-allowed", () => {
    for (const eventType of ["deployment", "__proto__", "constructor", "prototype"]) {
      expect(refuseReason(baseInput({ eventType }))).toBe("event-not-allowed");
    }
  });
});

describe("decideWebhookDelivery — fixed refusal order", () => {
  it("enforces fixed refusal order when two faults occur simultaneously", () => {
    const cases: Array<[Input, string]> = [
      // invalid-input beats signature-invalid
      [baseInput({ deliveryId: "", signatureVerified: false }), "invalid-input"],
      // signature-invalid beats stale
      [
        baseInput({
          signatureVerified: false,
          signedAtIso: new Date(Date.parse(RECEIVED) - WEBHOOK_MAX_AGE_MS - 60_000).toISOString(),
        }),
        "signature-invalid",
      ],
      // stale beats replay
      [
        baseInput({
          signedAtIso: new Date(Date.parse(RECEIVED) - WEBHOOK_MAX_AGE_MS - 1).toISOString(),
          seenDeliveryIds: [DELIVERY_ID],
        }),
        "stale",
      ],
      // replay beats payload-too-large
      [
        baseInput({
          seenDeliveryIds: [DELIVERY_ID],
          payloadBytes: MAX_WEBHOOK_PAYLOAD_BYTES + 1,
        }),
        "replay",
      ],
      // payload-too-large beats event-not-allowed
      [
        baseInput({ payloadBytes: MAX_WEBHOOK_PAYLOAD_BYTES + 1, eventType: "deployment" }),
        "payload-too-large",
      ],
    ];
    for (const [input, expected] of cases) {
      expect(refuseReason(input)).toBe(expected);
    }
  });
});

describe("webhook-delivery constants and types", () => {
  it("exports the agreed bounds and allow-list", () => {
    expect(WEBHOOK_MAX_AGE_MS).toBe(300_000);
    expect(WEBHOOK_MAX_FUTURE_SKEW_MS).toBe(60_000);
    expect(MAX_SEEN_DELIVERY_IDS).toBe(10_000);
    expect(MAX_WEBHOOK_PAYLOAD_BYTES).toBe(1_048_576);
    expect([...ALLOWED_WEBHOOK_EVENT_TYPES]).toEqual([
      "push",
      "pull_request",
      "check_suite",
      "installation",
    ]);
    expect(MAX_STRING_LENGTH).toBe(4096);
  });

  it("produces a decision value that typechecks against the union shape", () => {
    const decision: WebhookDeliveryDecision = decideWebhookDelivery(baseInput(), TRUSTED_DETECTOR);
    expect(decision.outcome).toBe("accepted");
  });
});
