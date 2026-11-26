import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  MAX_OPERATOR_REASON_LENGTH,
  OPERATOR_ACCESS_MAX_DURATION_MS,
  decideOperatorAccess,
  parseOperatorAccessGrant,
  type OperatorAccessGrant,
} from "../operator-access.js";

const SOURCE = readFileSync(
  new URL("../operator-access.ts", import.meta.url),
  "utf8",
);

const ORG_A = "org-a";
const ORG_B = "org-b";
const NOW = "2026-11-26T12:00:00.000Z";

const validGrant: OperatorAccessGrant = {
  actor: "operator@example.com",
  organizationId: ORG_A,
  reason: "incident-42",
  grantedAtIso: "2026-11-26T10:00:00.000Z",
  // Exactly the 4-hour maximum.
  expiresAtIso: "2026-11-26T14:00:00.000Z",
};

const validEnvelope = (): Record<string, unknown> => ({
  grant: { ...validGrant },
  organizationId: ORG_A,
  nowIso: NOW,
});

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

/** A plain object whose `actor` field is a getter that throws when run. */
function getterGrant(base: OperatorAccessGrant): object {
  return Object.defineProperty({ ...base }, "actor", {
    get() {
      throw new Error("getter must never run");
    },
    enumerable: true,
  });
}

/** A sparse array (index 1 is a hole). */
function sparseGrant(): unknown {
  const sparse: unknown[] = new Array(3);
  sparse[0] = { ...validGrant };
  sparse[2] = "hole-below";
  return sparse;
}

function expectRefusedGrant(
  result: ReturnType<typeof parseOperatorAccessGrant>,
): void {
  expect(result).toEqual({ outcome: "refused", reason: "invalid-grant" });
}

function expectRefused(
  result: ReturnType<typeof decideOperatorAccess>,
  reason: string,
): void {
  expect(result.outcome).toBe("refused");
  if (result.outcome !== "refused") throw new Error("unreachable");
  expect(result.reason).toBe(reason);
}

describe("operator-access module purity", () => {
  it("contains no clock, randomness, process, or Node imports in operator-access.ts", () => {
    expect(SOURCE).not.toMatch(/Date\.now/);
    expect(SOURCE).not.toMatch(/new Date\(\s*\)/);
    expect(SOURCE).not.toMatch(/Math\.random/);
    expect(SOURCE).not.toMatch(/\bcrypto\b/);
    expect(SOURCE).not.toMatch(/\bprocess\b/);
    expect(SOURCE).not.toMatch(/node:/);
    expect(SOURCE).not.toMatch(/require\(/);
    expect(SOURCE).not.toMatch(/\bchild_process\b/);
    expect(SOURCE).not.toMatch(/\bnode:fs\b/);
    expect(SOURCE).not.toMatch(/\bnode:net\b/);
    expect(SOURCE).not.toMatch(/\bnode:http\b/);
  });
});

describe("parseOperatorAccessGrant", () => {
  it("parses every valid grant into a frozen grant object", () => {
    const result = parseOperatorAccessGrant({ ...validGrant });
    expect(result.outcome).toBe("parsed");
    if (result.outcome !== "parsed") throw new Error("unreachable");
    expect(result.grant).toEqual(validGrant);
    expect(Object.isFrozen(result.grant)).toBe(true);
    // No detector: a Proxy-free input still parses.
    expect(parseOperatorAccessGrant({ ...validGrant }, undefined).outcome).toBe("parsed");
    expect(
      parseOperatorAccessGrant({ ...validGrant }, () => false).outcome,
    ).toBe("parsed");
  });

  it("accepts a grant at exactly the 4-hour maximum duration", () => {
    expect(parseOperatorAccessGrant({ ...validGrant }).outcome).toBe("parsed");
    expect(OPERATOR_ACCESS_MAX_DURATION_MS).toBe(4 * 60 * 60 * 1000);
    expect(MAX_OPERATOR_REASON_LENGTH).toBe(512);
  });

  it("refuses hostile raw grant shapes (null, undefined, primitive, array, hole, array-like, non-plain prototype, getter, Proxy, polluting keys, extra/missing keys) as invalid-grant without invoking getters", () => {
    const { reason: _reason, ...withoutReason } = validGrant;
    void _reason;
    const withSymbol: object = Object.defineProperty(
      { ...validGrant },
      Symbol("s"),
      { value: 1 },
    );
    const hostile: unknown[] = [
      null,
      undefined,
      42,
      "grant",
      true,
      [validGrant],
      sparseGrant(),
      { ...validGrant, length: 5 },
      Object.setPrototypeOf({ ...validGrant }, { hostile: true }),
      getterGrant(validGrant),
      throwingProxy(),
      Object.defineProperty({ ...validGrant }, "__proto__", {
        value: null,
        enumerable: true,
      }),
      Object.defineProperty({ ...validGrant }, "constructor", {
        value: 1,
        enumerable: true,
      }),
      Object.defineProperty({ ...validGrant }, "prototype", {
        value: 1,
        enumerable: true,
      }),
      { ...validGrant, extra: 1 },
      withoutReason,
      withSymbol,
      { ...validGrant, reason: "x".repeat(4097) },
      { ...validGrant, actor: undefined },
    ];
    for (const raw of hostile) {
      expectRefusedGrant(parseOperatorAccessGrant(raw));
    }
  });

  it("refuses non-function or throwing isProxy detector without throwing", () => {
    for (const badDetector of [42, "no", null, true, {}] as unknown[]) {
      expectRefusedGrant(
        parseOperatorAccessGrant({ ...validGrant }, badDetector as never),
      );
    }
    const throwing = (): boolean => {
      throw new Error("detector");
    };
    expectRefusedGrant(parseOperatorAccessGrant({ ...validGrant }, throwing));
  });

  it("refuses invalid actor, organizationId, empty/oversized/control-char reason, and invalid timestamps as invalid-grant", () => {
    const badActors: unknown[] = ["", "a".repeat(129), "bad actor", "a/b", 42, null];
    for (const actor of badActors) {
      expectRefusedGrant(parseOperatorAccessGrant({ ...validGrant, actor }));
    }
    const badOrgIds: unknown[] = ["", "A".repeat(63), "a".repeat(64), "UPPER", "a b", 7, null];
    for (const organizationId of badOrgIds) {
      expectRefusedGrant(
        parseOperatorAccessGrant({ ...validGrant, organizationId }),
      );
    }
    const badReasons: unknown[] = [
      "",
      "x".repeat(MAX_OPERATOR_REASON_LENGTH + 1),
      "with\u0000null",
      "line\nbreak",
      42,
      null,
    ];
    for (const reason of badReasons) {
      expectRefusedGrant(parseOperatorAccessGrant({ ...validGrant, reason }));
    }
    const badTimestamps: unknown[] = [
      "not-a-date",
      "2026-02-31T12:00:00.000Z",
      "2026-11-26T12:00:00",
      "2026-11-26T12:00:00+00:00:00",
      42,
      null,
      undefined,
    ];
    for (const grantedAtIso of badTimestamps) {
      expectRefusedGrant(
        parseOperatorAccessGrant({ ...validGrant, grantedAtIso }),
      );
      expectRefusedGrant(
        parseOperatorAccessGrant({ ...validGrant, expiresAtIso: grantedAtIso }),
      );
    }
  });

  it("refuses grant whose expiry is at or before grantedAtIso or exceeds 4 hours (including 5-hour grant) as invalid-grant", () => {
    // Expiry exactly at the grant instant.
    expectRefusedGrant(
      parseOperatorAccessGrant({
        ...validGrant,
        expiresAtIso: "2026-11-26T10:00:00.000Z",
      }),
    );
    // Expiry before the grant instant.
    expectRefusedGrant(
      parseOperatorAccessGrant({
        ...validGrant,
        expiresAtIso: "2026-11-26T09:00:00.000Z",
      }),
    );
    // A 5-hour grant.
    expectRefusedGrant(
      parseOperatorAccessGrant({
        ...validGrant,
        expiresAtIso: "2026-11-26T15:00:00.000Z",
      }),
    );
    // 4 hours + 1 ms.
    expectRefusedGrant(
      parseOperatorAccessGrant({
        ...validGrant,
        expiresAtIso: "2026-11-26T14:00:00.001Z",
      }),
    );
    // 4 hours + 1 ns: the parsed millisecond difference lands exactly on the
    // maximum while the sub-millisecond digits push the true duration past it.
    expectRefusedGrant(
      parseOperatorAccessGrant({
        ...validGrant,
        grantedAtIso: "2026-11-26T10:00:00.000100000Z",
        expiresAtIso: "2026-11-26T14:00:00.000100001Z",
      }),
    );
    // The same shape with equal sub-millisecond digits is still fine.
    expect(
      parseOperatorAccessGrant({
        ...validGrant,
        grantedAtIso: "2026-11-26T10:00:00.000100000Z",
        expiresAtIso: "2026-11-26T14:00:00.000100000Z",
      }).outcome,
    ).toBe("parsed");
  });
});

describe("decideOperatorAccess", () => {
  it("allows a valid grant inside its window and returns one frozen audit row", () => {
    const result = decideOperatorAccess(validEnvelope());
    expect(result.outcome).toBe("allowed");
    if (result.outcome !== "allowed") throw new Error("unreachable");
    expect(result.actor).toBe("operator@example.com");
    expect(result.organizationId).toBe(ORG_A);
    expect(result.audit).toEqual({
      actor: "operator@example.com",
      organizationId: ORG_A,
      reason: "incident-42",
      atIso: NOW,
    });
    expect(Object.isFrozen(result.audit)).toBe(true);
  });

  it("allows at grantedAtIso and before expiresAtIso, and refuses at exact expiresAtIso and after as expired", () => {
    const atGrant = decideOperatorAccess({
      ...validEnvelope(),
      nowIso: validGrant.grantedAtIso,
    });
    expect(atGrant.outcome).toBe("allowed");
    const justBefore = decideOperatorAccess({
      ...validEnvelope(),
      nowIso: "2026-11-26T13:59:59.999Z",
    });
    expect(justBefore.outcome).toBe("allowed");
    const atExpiry = decideOperatorAccess({
      ...validEnvelope(),
      nowIso: validGrant.expiresAtIso,
    });
    expectRefused(atExpiry, "expired");
    if (atExpiry.outcome === "refused") {
      expect(atExpiry.audit).toEqual({
        actor: "operator@example.com",
        organizationId: ORG_A,
        reason: "expired",
        atIso: validGrant.expiresAtIso,
      });
    }
    const afterExpiry = decideOperatorAccess({
      ...validEnvelope(),
      nowIso: "2026-11-26T14:00:00.001Z",
    });
    expectRefused(afterExpiry, "expired");
  });

  it("refuses access before grantedAtIso as not-yet-valid", () => {
    const result = decideOperatorAccess({
      ...validEnvelope(),
      nowIso: "2026-11-26T09:59:59.999Z",
    });
    expectRefused(result, "not-yet-valid");
    if (result.outcome === "refused") {
      expect(result.audit).toEqual({
        actor: "operator@example.com",
        organizationId: ORG_A,
        reason: "not-yet-valid",
        atIso: "2026-11-26T09:59:59.999Z",
      });
    }
  });

  it("refuses a valid grant for org A when evaluated against org B as wrong-organization and records requested org and grant actor in audit", () => {
    const result = decideOperatorAccess({
      ...validEnvelope(),
      organizationId: ORG_B,
    });
    expectRefused(result, "wrong-organization");
    if (result.outcome !== "refused") throw new Error("unreachable");
    expect(result.audit).toEqual({
      actor: "operator@example.com",
      organizationId: ORG_B,
      reason: "wrong-organization",
      atIso: NOW,
    });
  });

  it("refuses hostile grant inside decideOperatorAccess (including getter, Proxy, hole, and polluting key) as invalid-grant", () => {
    const { reason: _grantReason, ...withoutReason } = validGrant;
    void _grantReason;
    const hostileGrants: unknown[] = [
      null,
      undefined,
      42,
      "grant",
      [validGrant],
      sparseGrant(),
      { ...validGrant, length: 5 },
      getterGrant(validGrant),
      throwingProxy(),
      Object.defineProperty({ ...validGrant }, "__proto__", {
        value: null,
        enumerable: true,
      }),
      { ...validGrant, extra: 1 },
      withoutReason,
      { ...validGrant, reason: "x".repeat(4097) },
      { ...validGrant, expiresAtIso: "2026-11-26T15:00:00.000Z" },
    ];
    for (const grant of hostileGrants) {
      const result = decideOperatorAccess({ ...validEnvelope(), grant });
      expectRefused(result, "invalid-grant");
      if (result.outcome !== "refused") throw new Error("unreachable");
      // When the hostile grant fails the envelope snapshot itself at
      // `grant`/`grant.*` (getter, Proxy, array, oversized string), the audit
      // is all "unknown"; when the envelope snapshots cleanly and the grant
      // fails its own parse, the audit keeps the validated org and now.
      const allUnknown = {
        actor: "unknown",
        organizationId: "unknown",
        reason: "invalid-grant",
        atIso: "unknown",
      };
      const withEnvelope = {
        actor: "unknown",
        organizationId: ORG_A,
        reason: "invalid-grant",
        atIso: NOW,
      };
      const matches =
        JSON.stringify(result.audit) === JSON.stringify(allUnknown) ||
        JSON.stringify(result.audit) === JSON.stringify(withEnvelope);
      expect(matches).toBe(true);
    }
    // A missing grant key is invalid-grant once the envelope itself is valid.
    const { grant: _grant, ...noGrant } = validEnvelope();
    void _grant;
    expectRefused(decideOperatorAccess(noGrant), "invalid-grant");
  });

  it("refuses hostile input envelopes, invalid organizationId, and invalid nowIso as invalid-input", () => {
    const { organizationId: _org, ...withoutOrg } = validEnvelope();
    void _org;
    const { nowIso: _now, ...withoutNow } = validEnvelope();
    void _now;
    const hostileEnvelopes: unknown[] = [
      null,
      undefined,
      42,
      "envelope",
      [validEnvelope()],
      throwingProxy(),
      getterGrant(validGrant as never),
      Object.defineProperty({ ...validEnvelope() }, "extra", {
        value: 1,
        enumerable: true,
      }),
      Object.defineProperty({ ...validEnvelope() }, "__proto__", {
        value: null,
        enumerable: true,
      }),
      Object.defineProperty({ ...validEnvelope() }, "length", {
        value: 5,
        enumerable: true,
      }),
      withoutOrg,
      withoutNow,
      { ...validEnvelope(), organizationId: "INVALID" },
      { ...validEnvelope(), organizationId: 42 },
      { ...validEnvelope(), nowIso: "not-a-date" },
      { ...validEnvelope(), nowIso: "2026-02-31T12:00:00.000Z" },
      { ...validEnvelope(), nowIso: 42 },
    ];
    for (const envelope of hostileEnvelopes) {
      const result = decideOperatorAccess(envelope);
      expectRefused(result, "invalid-input");
      if (result.outcome !== "refused") throw new Error("unreachable");
      // The audit row still names all four fields.
      expect(Object.keys(result.audit).sort()).toEqual([
        "actor",
        "atIso",
        "organizationId",
        "reason",
      ]);
    }
    // With a valid organizationId but invalid nowIso the audit keeps the org.
    const result = decideOperatorAccess({ ...validEnvelope(), nowIso: "bad" });
    if (result.outcome !== "refused") throw new Error("unreachable");
    expect(result.audit.organizationId).toBe(ORG_A);
    expect(result.audit.atIso).toBe("unknown");
  });

  it("refuses non-function or throwing isProxy detector without throwing", () => {
    for (const badDetector of [42, "no", null, true, {}] as unknown[]) {
      const result = decideOperatorAccess(
        validEnvelope(),
        badDetector as never,
      );
      expectRefused(result, "invalid-input");
      if (result.outcome !== "refused") throw new Error("unreachable");
      expect(result.audit).toEqual({
        actor: "unknown",
        organizationId: "unknown",
        reason: "invalid-input",
        atIso: "unknown",
      });
    }
    const throwing = (): boolean => {
      throw new Error("detector");
    };
    const result = decideOperatorAccess(validEnvelope(), throwing);
    expectRefused(result, "invalid-input");
  });

  it("emits one audit row per decision and never echoes grant reason or rejected values in any refusal", () => {
    const secretReason = "secret-reason";
    const grant = { ...validGrant, reason: secretReason };
    const envelope = { ...validEnvelope(), grant };
    const decisions: ReturnType<typeof decideOperatorAccess>[] = [
      decideOperatorAccess(envelope),
      decideOperatorAccess({ ...envelope, organizationId: ORG_B }),
      decideOperatorAccess({
        ...envelope,
        nowIso: "2026-11-26T09:00:00.000Z",
      }),
      decideOperatorAccess({ ...envelope, nowIso: "2026-11-26T15:00:00.000Z" }),
      decideOperatorAccess({ ...envelope, grant: null }),
      decideOperatorAccess({ ...envelope, nowIso: "bad" }),
      decideOperatorAccess(null),
      decideOperatorAccess({ ...validEnvelope(), actor: "nope" }),
    ];
    for (const decision of decisions) {
      expect(Object.keys(decision)).toContain("audit");
      if (decision.outcome === "refused") {
        // No refusal ever echoes grant.reason or any rejected value.
        const text = JSON.stringify(decision);
        expect(text).not.toContain(secretReason);
        expect(text).not.toContain("bad");
      } else {
        // The allowed decision is the only one that carries grant.reason.
        expect(JSON.stringify(decision)).toContain(secretReason);
      }
    }
  });

  it("keeps the envelope snapshot at its fixed hostile-input bound", () => {
    // maxArrayLength: 0 refuses any nested array on the envelope.
    const result = decideOperatorAccess({
      ...validEnvelope(),
      organizationId: [ORG_A],
    });
    expectRefused(result, "invalid-input");
    // An envelope carrying extra benign keys is refused (unknown key), not
    // silently processed.
    expectRefused(
      decideOperatorAccess({ ...validEnvelope(), noise: 1 }),
      "invalid-input",
    );
  });
});
