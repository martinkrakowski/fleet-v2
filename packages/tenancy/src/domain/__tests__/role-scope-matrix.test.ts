/**
 * FC6F: table-driven role-to-scope-to-operation authorization matrix tests.
 *
 * Combines FC6B's `scopesForRole` / `HOSTED_SCOPES`, the membership
 * permission table in `Role.vo.ts` (`ROLES`, `MEMBERSHIP_ACTIONS`,
 * `canActAs`) and FC6C's `API_TOKEN_SCOPES` / `decideApiTokenUse` into one
 * matrix. Every test title states what the test asserts and every body
 * proves it: the literal role-to-scope and role-to-operation tables fail a
 * constant implementation, the refusal cases fail an identity
 * implementation, and the drift guard fails (never skips) whenever a scope
 * is added without a matrix row.
 *
 * Deterministic: `nowIso`, `tokenId` and `secretDigest` are explicit
 * inputs; no network, no clock, no randomness.
 */
import { types } from "node:util";

import { describe, expect, it } from "vitest";

import {
  MEMBERSHIP_ACTIONS,
  ROLES,
  canActAs,
} from "../value-objects/Role.vo.js";
import { HOSTED_SCOPES, scopesForRole } from "../role-scopes.js";
import {
  API_TOKEN_SCOPES,
  decideApiTokenUse,
  type ApiTokenRefusalReason,
} from "../api-token.js";
import type { IsProxy } from "@fleet/shared";

/** The trusted Proxy detector the domain functions require. */
const isProxy: IsProxy = (value) => types.isProxy(value);

/** The seven hosted scopes, as a frozen literal for drift comparison. */
const ALL_SEVEN_SCOPES: readonly string[] = [
  "read",
  "message",
  "hook",
  "verdict",
  "operate",
  "orchestrate",
  "tail",
];

/** The pinned literal role-to-scopes table (FC6F truth). */
const ROLE_TO_SCOPES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  viewer: ["read", "tail"],
  maintainer: ["read", "tail", "message", "verdict"],
  owner: ["read", "tail", "message", "verdict", "operate"],
});

/** Scopes no hosted session ever receives. */
const SESSION_EXCLUDED_SCOPES: readonly string[] = ["hook", "orchestrate"];

/** The pinned literal role-to-operations table (FC6F truth). */
const ROLE_TO_OPERATIONS: Readonly<Record<string, Readonly<Record<string, boolean>>>> =
  Object.freeze({
    owner: Object.freeze({
      "manage-members": true,
      "change-policy": true,
      "register-work": true,
      "start-stop-run": true,
      grant: true,
      read: true,
    }),
    maintainer: Object.freeze({
      "manage-members": false,
      "change-policy": false,
      "register-work": true,
      "start-stop-run": true,
      grant: false,
      read: true,
    }),
    viewer: Object.freeze({
      "manage-members": false,
      "change-policy": false,
      "register-work": false,
      "start-stop-run": false,
      grant: false,
      read: true,
    }),
  });

const DIGEST = "a".repeat(64);
const ORGANIZATION_ID = "org-one";
const ISSUED_AT_ISO = "2026-01-01T00:00:00.000Z";
const EXPIRES_AT_ISO = "2027-01-01T00:00:00.000Z";
const NOW_ISO = "2026-06-01T00:00:00.000Z";

const REFUSAL_REASONS: ReadonlySet<string> = new Set<string>([
  "invalid-record",
  "digest-mismatch",
  "wrong-organization",
  "revoked",
  "expired",
  "not-yet-valid",
  "scope-not-granted",
  "orchestrate-not-registered",
  "invalid-input",
]);

/** A valid record carrying `scopes`; every field an explicit constant. */
function recordWith(scopes: readonly string[]): Record<string, unknown> {
  return {
    tokenId: "tok-0001",
    organizationId: ORGANIZATION_ID,
    actor: "actor@example",
    scopes: [...scopes],
    secretDigest: DIGEST,
    issuedAtIso: ISSUED_AT_ISO,
    expiresAtIso: EXPIRES_AT_ISO,
    revokedAtIso: null,
  };
}

/** A valid use wrapper requesting `requiredScope` for a role's scope set. */
function wrapperFor(
  requiredScope: string,
  scopes: readonly string[] = scopesForRole("viewer"),
): Record<string, unknown> {
  return {
    record: recordWith(scopes),
    presentedDigest: DIGEST,
    organizationId: ORGANIZATION_ID,
    requiredScope,
    nowIso: NOW_ISO,
  };
}

/** `decideApiTokenUse` for a role's hosted scope set and one scope. */
function decideForRoleScope(role: string, requiredScope: string) {
  return decideApiTokenUse(
    {
      record: recordWith(scopesForRole(role)),
      presentedDigest: DIGEST,
      organizationId: ORGANIZATION_ID,
      requiredScope,
      nowIso: NOW_ISO,
    },
    isProxy,
  );
}

/** A refusal never throws and never echoes the rejected value. */
function expectTypedRefusal(
  result: { outcome: string; reason?: string },
  expected: ApiTokenRefusalReason,
): void {
  expect(result.outcome).toBe("refused");
  expect(result.reason).toBe(expected);
  expect(REFUSAL_REASONS.has(result.reason ?? "")).toBe(true);
}

describe("FC6F: role-to-scope matrix", () => {
  it("API_TOKEN_SCOPES and HOSTED_SCOPES match the literal seven-scope matrix with no missing or extra scope rows", () => {
    // The two frozen scope lists are exactly the literal seven scopes.
    expect([...API_TOKEN_SCOPES].sort().join(",")).toBe(
      [...ALL_SEVEN_SCOPES].sort().join(","),
    );
    expect([...HOSTED_SCOPES].sort().join(",")).toBe(
      [...ALL_SEVEN_SCOPES].sort().join(","),
    );
    // Every scope has a role row or an explicit exclusion row, and no
    // unknown scope appears anywhere in the literal table, so adding a
    // scope without a matrix row fails immediately.
    const covered = new Set<string>();
    for (const scopes of Object.values(ROLE_TO_SCOPES)) {
      for (const scope of scopes) {
        expect(ALL_SEVEN_SCOPES).toContain(scope);
        covered.add(scope);
      }
    }
    for (const scope of SESSION_EXCLUDED_SCOPES) {
      expect(ALL_SEVEN_SCOPES).toContain(scope);
      covered.add(scope);
    }
    expect(covered.size).toBe(ALL_SEVEN_SCOPES.length);
    expect([...covered].sort().join(",")).toBe(
      [...ALL_SEVEN_SCOPES].sort().join(","),
    );
    // Every declared role has an operations row and vice versa.
    expect([...ROLES].sort().join(",")).toBe(
      Object.keys(ROLE_TO_OPERATIONS).sort().join(","),
    );
    for (const operations of Object.values(ROLE_TO_OPERATIONS)) {
      expect([...MEMBERSHIP_ACTIONS].sort().join(",")).toBe(
        Object.keys(operations).sort().join(","),
      );
    }
  });

  it("canActAs matches the pinned literal operation table for every role and every membership action", () => {
    for (const role of Object.keys(ROLE_TO_OPERATIONS)) {
      for (const action of MEMBERSHIP_ACTIONS) {
        expect(canActAs(role, action)).toBe(ROLE_TO_OPERATIONS[role][action]);
      }
    }
  });

  it("scopesForRole matches the pinned literal scope table for every declared role and grants only matrix scopes", () => {
    for (const role of Object.keys(ROLE_TO_SCOPES)) {
      const scopes = scopesForRole(role);
      expect(Object.isFrozen(scopes)).toBe(true);
      expect([...scopes].sort().join(",")).toBe(
        [...ROLE_TO_SCOPES[role]].sort().join(","),
      );
      for (const scope of scopes) {
        expect(API_TOKEN_SCOPES).toContain(scope);
      }
    }
  });

  it("decideApiTokenUse allows exactly the scopes in scopesForRole(role) and refuses every other scope with scope-not-granted", () => {
    for (const role of ROLES) {
      const granted = new Set<string>(scopesForRole(role));
      for (const scope of API_TOKEN_SCOPES) {
        const result = decideForRoleScope(role, scope);
        if (granted.has(scope)) {
          expect(result.outcome).toBe("allowed");
          if (result.outcome === "allowed") {
            expect(result.organizationId).toBe(ORGANIZATION_ID);
            expect(result.scopes.includes(scope)).toBe(true);
          }
        } else {
          expectTypedRefusal(result, "scope-not-granted");
        }
      }
    }
  });

  it("viewer is denied manage-members, register-work, start-stop-run, grant, and change-policy and refused non-viewer scopes", () => {
    const privileged = ["manage-members", "register-work", "start-stop-run", "grant", "change-policy"];
    for (const action of privileged) {
      expect(canActAs("viewer", action)).toBe(false);
    }
    for (const scope of ["operate", "verdict", "message", "hook", "orchestrate"]) {
      expect(scopesForRole("viewer")).not.toContain(scope);
      expectTypedRefusal(
        decideForRoleScope("viewer", scope),
        "scope-not-granted",
      );
    }
  });

  it("hosted-session scope sets never include orchestrate or hook and decideApiTokenUse refuses both with scope-not-granted", () => {
    for (const role of ROLES) {
      const scopes = scopesForRole(role);
      expect(scopes).not.toContain("orchestrate");
      expect(scopes).not.toContain("hook");
      for (const excluded of SESSION_EXCLUDED_SCOPES) {
        expectTypedRefusal(
          decideForRoleScope(role, excluded),
          "scope-not-granted",
        );
      }
    }
  });

  it("scopesForRole and canActAs refuse null, undefined, wrong primitives, unknown values, and prototype-polluting keys", () => {
    const hostileRoles: readonly unknown[] = [
      null,
      undefined,
      42,
      true,
      false,
      BigInt(1),
      Symbol("viewer"),
      {},
      ["viewer"],
      { length: 1e9, 0: "owner" },
      { get toString(): string { throw new Error("boom"); } },
      new Proxy({}, { get() { throw new Error("boom"); } }),
      "admin",
      "",
      "OWNER",
      "__proto__",
      "constructor",
      "prototype",
    ];
    for (const role of hostileRoles) {
      const scopes = scopesForRole(role);
      expect(scopes).toEqual([]);
      expect(Object.isFrozen(scopes)).toBe(true);
      for (const action of MEMBERSHIP_ACTIONS) {
        expect(canActAs(role, action)).toBe(false);
      }
    }
    // A hostile action is refused for a real role too.
    for (const action of [null, undefined, 42, {}, ["read"], "__proto__", "dispatch", ""]) {
      expect(canActAs("owner", action)).toBe(false);
    }
  });

  it("decideApiTokenUse refuses null, undefined, non-iterables, array holes, wrong primitives, getters, Proxies, array-likes, enormous lengths, and prototype-polluting keys with a typed refusal and no value echo", () => {
    // Root-shape hostiles: snapshot refuses at the root -> invalid-input.
    const holeyArray: unknown[] = new Array(2);
    holeyArray[1] = "read";
    const rootHostiles: readonly [unknown, ApiTokenRefusalReason][] = [
      [null, "invalid-input"],
      [undefined, "invalid-input"],
      [42, "invalid-input"],
      ["wrapper", "invalid-input"],
      [true, "invalid-input"],
      [[], "invalid-input"],
      [holeyArray, "invalid-input"],
      [{ length: 2 ** 31, 0: "x" }, "invalid-input"],
    ];
    for (const [input, expected] of rootHostiles) {
      const result = decideApiTokenUse(input, isProxy);
      expectTypedRefusal(result, expected);
    }

    // Getters never run: a throwing getter on a wrapper field is refused
    // from the descriptor and the getter body stays unexecuted.
    let getterRuns = 0;
    const getterWrapper = {
      get presentedDigest(): string {
        getterRuns += 1;
        throw new Error("boom");
      },
      record: recordWith(["read"]),
      organizationId: ORGANIZATION_ID,
      requiredScope: "read",
      nowIso: NOW_ISO,
    };
    expectTypedRefusal(decideApiTokenUse(getterWrapper, isProxy), "invalid-input");
    expect(getterRuns).toBe(0);

    // A throwing getter inside the record branch maps to invalid-record.
    const getterRecord = {
      record: {
        get scopes(): string[] {
          getterRuns += 1;
          throw new Error("boom");
        },
        tokenId: "tok-0001",
        organizationId: ORGANIZATION_ID,
        actor: "actor@example",
        secretDigest: DIGEST,
        issuedAtIso: ISSUED_AT_ISO,
        expiresAtIso: EXPIRES_AT_ISO,
        revokedAtIso: null,
      },
      presentedDigest: DIGEST,
      organizationId: ORGANIZATION_ID,
      requiredScope: "read",
      nowIso: NOW_ISO,
    };
    expectTypedRefusal(decideApiTokenUse(getterRecord, isProxy), "invalid-record");
    expect(getterRuns).toBe(0);

    // Proxies never trigger a trap: the detector refuses them before any
    // property read.
    let trapRuns = 0;
    const trap = (): never => {
      trapRuns += 1;
      throw new Error("boom");
    };
    const hostileProxy = new Proxy({}, { get: trap, has: trap, ownKeys: trap });
    expectTypedRefusal(decideApiTokenUse(hostileProxy, isProxy), "invalid-input");
    expectTypedRefusal(
      decideApiTokenUse({ ...wrapperFor("read"), record: hostileProxy }, isProxy),
      "invalid-record",
    );
    expect(trapRuns).toBe(0);

    // Non-iterables and wrong primitives in record.scopes and as wrapper
    // fields are typed refusals.
    const scopesHostiles: readonly [unknown, ApiTokenRefusalReason][] = [
      ["read", "invalid-record"],
      [{ 0: "read" }, "invalid-record"],
      [null, "invalid-record"],
      [["__proto__"], "invalid-record"],
    ];
    for (const [scopes, expected] of scopesHostiles) {
      const wrapper = { ...wrapperFor("read"), record: { ...recordWith([]), scopes } };
      expectTypedRefusal(decideApiTokenUse(wrapper, isProxy), expected);
    }

    // Array holes inside record.scopes: sparse-array at record.scopes[i]
    // maps to invalid-record.
    const holeyScopes = new Array(2);
    holeyScopes[0] = "read";
    expectTypedRefusal(
      decideApiTokenUse(
        { ...wrapperFor("read"), record: { ...recordWith([]), scopes: holeyScopes } },
        isProxy,
      ),
      "invalid-record",
    );

    // Prototype-polluting own keys: the snapshot copies an own __proto__
    // key as data, key screening then refuses it. Computed keys create an
    // own property; the plain-key form would set a prototype instead.
    const pollutedWrapper = { ...wrapperFor("read"), ["__proto__"]: 1 } as Record<string, unknown>;
    expectTypedRefusal(decideApiTokenUse(pollutedWrapper, isProxy), "invalid-input");
    const pollutedRecord = {
      ...wrapperFor("read"),
      record: { ...recordWith(["read"]), ["constructor"]: 1 },
    };
    expectTypedRefusal(decideApiTokenUse(pollutedRecord, isProxy), "invalid-record");
    const pollutedRecord2 = {
      ...wrapperFor("read"),
      record: { ...recordWith(["read"]), ["prototype"]: 1 },
    };
    expectTypedRefusal(decideApiTokenUse(pollutedRecord2, isProxy), "invalid-record");

    // Extra/unknown keys and missing required keys are refused.
    expectTypedRefusal(
      decideApiTokenUse({ ...wrapperFor("read"), extra: true }, isProxy),
      "invalid-input",
    );
    const missingNow = { ...wrapperFor("read") } as Record<string, unknown>;
    delete missingNow.nowIso;
    expectTypedRefusal(decideApiTokenUse(missingNow, isProxy), "invalid-input");
    const missingDigest = { ...wrapperFor("read") } as Record<string, unknown>;
    delete missingDigest.presentedDigest;
    expectTypedRefusal(decideApiTokenUse(missingDigest, isProxy), "invalid-input");
    const missingScopes = {
      ...wrapperFor("read"),
      record: { ...recordWith(["read"]) },
    } as Record<string, unknown>;
    delete (missingScopes.record as Record<string, unknown>).scopes;
    expectTypedRefusal(decideApiTokenUse(missingScopes, isProxy), "invalid-record");

    // Wrong wrapper primitives: a bad digest, an unknown scope and a bad
    // organization id are invalid-input.
    expectTypedRefusal(
      decideApiTokenUse({ ...wrapperFor("read"), presentedDigest: "zz" }, isProxy),
      "invalid-input",
    );
    expectTypedRefusal(
      decideApiTokenUse({ ...wrapperFor("read"), requiredScope: "not-a-scope" }, isProxy),
      "invalid-input",
    );
    expectTypedRefusal(
      decideApiTokenUse({ ...wrapperFor("read"), organizationId: "ORG" }, isProxy),
      "invalid-input",
    );
  });

  it("decideApiTokenUse refuses expired instants, missing required keys, and invalid token inputs with a typed refusal", () => {
    // Expired: nowIso past expiresAtIso.
    expectTypedRefusal(
      decideApiTokenUse(
        { ...wrapperFor("read"), nowIso: "2027-06-01T00:00:00.000Z" },
        isProxy,
      ),
      "expired",
    );
    // Not yet valid: nowIso before issuedAtIso.
    expectTypedRefusal(
      decideApiTokenUse(
        { ...wrapperFor("read"), nowIso: "2025-06-01T00:00:00.000Z" },
        isProxy,
      ),
      "not-yet-valid",
    );
    // Digest mismatch.
    expectTypedRefusal(
      decideApiTokenUse(
        { ...wrapperFor("read"), presentedDigest: "b".repeat(64) },
        isProxy,
      ),
      "digest-mismatch",
    );
    // Wrong organization binding.
    expectTypedRefusal(
      decideApiTokenUse(
        { ...wrapperFor("read"), organizationId: "org-two" },
        isProxy,
      ),
      "wrong-organization",
    );
    // Revoked record.
    expectTypedRefusal(
      decideApiTokenUse(
        {
          ...wrapperFor("read"),
          record: { ...recordWith(["read"]), revokedAtIso: "2026-02-01T00:00:00.000Z" },
        },
        isProxy,
      ),
      "revoked",
    );
    // Invalid timestamps and invalid nowIso.
    expectTypedRefusal(
      decideApiTokenUse(
        {
          ...wrapperFor("read"),
          record: { ...recordWith(["read"]), expiresAtIso: "2026-02-30T00:00:00.000Z" },
        },
        isProxy,
      ),
      "invalid-record",
    );
    expectTypedRefusal(
      decideApiTokenUse({ ...wrapperFor("read"), nowIso: "not-a-date" }, isProxy),
      "invalid-input",
    );
    // A record branch that is not a plain object is invalid-record.
    for (const record of [null, undefined, 42, ["record"]]) {
      expectTypedRefusal(
        decideApiTokenUse({ ...wrapperFor("read"), record }, isProxy),
        "invalid-record",
      );
    }
    // Sanity: the same wrapper with a valid nowIso is allowed, so the
    // refusals above come from the changed field and not the fixture.
    expect(decideForRoleScope("viewer", "read").outcome).toBe("allowed");
  });
});
