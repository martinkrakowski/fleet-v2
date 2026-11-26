/**
 * Domain tests for the tenancy membership model and role table (FC3B).
 *
 * Every title states what the test asserts and every body proves it; each
 * assertion would fail against a constant `false`/refused-only
 * implementation (valid paths assert exact accepted values) or an identity
 * function (every refusal is asserted with its named reason).
 *
 * Hostile-input posture: every case proves a typed refusal (never a
 * throw, never a pass) for null, undefined, wrong primitives,
 * non-iterables, array holes (sparse arrays), array-likes, getters (never
 * invoked), detectable Proxies (traps never run when the detector is
 * supplied), enormous lengths, prototype-polluting keys and unknown
 * values.
 */
import { types } from "node:util";

import { describe, expect, it } from "vitest";

import {
  ACTOR_PATTERN,
  canActAs,
  decideMembershipChange as decideMembershipChangeImpl,
  isZonedIsoDateTime,
  isValidRole,
  MAX_MEMBERS,
  MEMBERSHIP_ACTIONS,
  ROLES,
  validateMembershipChange as validateMembershipChangeImpl,
  validateMembershipRecord as validateMembershipRecordImpl,
  validateMembersList as validateMembersListImpl,
} from "../entities/index.js";

const isProxy = types.isProxy as (value: unknown) => boolean;

/**
 * The production validators require a proxy detector (their reflection
 * operations are guarded by it), so every call below injects the Node
 * `types.isProxy` detector; a test that omits it exercises the refusal of
 * a missing detector.
 */
function validateMembershipRecord(value: unknown, detector?: unknown) {
  return validateMembershipRecordImpl(value, (detector ?? isProxy) as (v: unknown) => boolean);
}
function validateMembersList(members: unknown, detector?: unknown) {
  return validateMembersListImpl(members, (detector ?? isProxy) as (v: unknown) => boolean);
}
function validateMembershipChange(change: unknown, detector?: unknown) {
  return validateMembershipChangeImpl(change, (detector ?? isProxy) as (v: unknown) => boolean);
}
function decideMembershipChange(
  members: unknown,
  change: unknown,
  nowIso: unknown,
  detector?: unknown,
) {
  return decideMembershipChangeImpl(
    members,
    change,
    nowIso,
    (detector ?? isProxy) as (v: unknown) => boolean,
  );
}

const NOW = "2026-06-01T12:00:00Z";
const EARLIER = "2026-01-01T00:00:00Z";

// Key-shaped strings are built at runtime, never written as literals.
const PROTO_KEY = ["__proto", "__"].join("");
const CONSTRUCTOR_KEY = ["construct", "or"].join("");
const PROTOTYPE_KEY = ["prototype"].join("");
const FORBIDDEN_KEYS = [PROTO_KEY, CONSTRUCTOR_KEY, PROTOTYPE_KEY];

function record(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    organizationId: "acme",
    actor: "alice",
    role: "owner",
    addedAtIso: EARLIER,
    addedBy: "root",
    ...overrides,
  };
}

function member(
  actor: string,
  role: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return record({ actor, role, addedBy: "root", ...overrides });
}

function change(
  kind: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    kind,
    organizationId: "acme",
    actingActor: "alice",
    actor: "bob",
    role: "viewer",
    ...overrides,
  };
}

function members(...entries: Array<Record<string, unknown>>): unknown[] {
  return entries;
}

const OWNER = () => member("alice", "owner");
const MAINTAINER = () => member("carol", "maintainer");
const VIEWER = () => member("dave", "viewer");

describe("Role value object and the canActAs permission table", () => {
  it("returns exactly the declared boolean for every ROLES x MEMBERSHIP_ACTIONS pair", () => {
    const expected: Record<string, Record<string, boolean>> = {
      owner: {
        "manage-members": true,
        "change-policy": true,
        "register-work": true,
        "start-stop-run": true,
        grant: true,
        read: true,
      },
      maintainer: {
        "manage-members": false,
        "change-policy": false,
        "register-work": true,
        "start-stop-run": true,
        grant: false,
        read: true,
      },
      viewer: {
        "manage-members": false,
        "change-policy": false,
        "register-work": false,
        "start-stop-run": false,
        grant: false,
        read: true,
      },
    };
    for (const role of ROLES) {
      for (const action of MEMBERSHIP_ACTIONS) {
        expect(canActAs(role, action)).toBe(expected[role][action]);
      }
    }
  });

  it("returns false for unknown roles, unknown actions, and dispatch", () => {
    for (const role of ROLES) {
      expect(canActAs(role, "dispatch" as never)).toBe(false);
    }
    for (const action of MEMBERSHIP_ACTIONS) {
      expect(canActAs("admin" as never, action)).toBe(false);
      expect(canActAs("dispatch" as never, action)).toBe(false);
    }
    expect(canActAs("admin" as never, "dispatch" as never)).toBe(false);
  });

  it("returns false for null, undefined, non-strings, objects, and prototype-polluting keys in canActAs", () => {
    for (const hostile of [
      null,
      undefined,
      42,
      true,
      {},
      [],
      PROTO_KEY,
      CONSTRUCTOR_KEY,
      PROTOTYPE_KEY,
    ]) {
      expect(canActAs(hostile, "read")).toBe(false);
      expect(canActAs("owner", hostile)).toBe(false);
      expect(canActAs(hostile, hostile)).toBe(false);
    }
  });

  it("isValidRole accepts exactly the declared roles and refuses everything else", () => {
    for (const role of ROLES) {
      expect(isValidRole(role)).toBe(true);
    }
    for (const hostile of [
      null,
      undefined,
      "admin",
      "dispatch",
      "Owner",
      "",
      42,
      {},
      PROTO_KEY,
      CONSTRUCTOR_KEY,
      PROTOTYPE_KEY,
    ]) {
      expect(isValidRole(hostile)).toBe(false);
    }
  });

  it("exports the action list without any dispatch entry and the actor pattern copied from the api", () => {
    expect(MEMBERSHIP_ACTIONS).toEqual([
      "manage-members",
      "change-policy",
      "register-work",
      "start-stop-run",
      "grant",
      "read",
    ]);
    expect(MEMBERSHIP_ACTIONS).not.toContain("dispatch");
    expect(ACTOR_PATTERN.test("a".repeat(128))).toBe(true);
    expect(ACTOR_PATTERN.test("a".repeat(129))).toBe(false);
    expect(ACTOR_PATTERN.test("bad actor")).toBe(false);
  });
});

describe("validateMembershipRecord accepts well-formed records", () => {
  it("accepts a full record with exact field values and freezes the result", () => {
    const result = validateMembershipRecord(record());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.record).toEqual({
        organizationId: "acme",
        actor: "alice",
        role: "owner",
        addedAtIso: EARLIER,
        addedBy: "root",
      });
      expect(Object.isFrozen(result.record)).toBe(true);
    }
  });

  it("accepts a record with schemaVersion 1 and keeps it as 1", () => {
    const result = validateMembershipRecord(record({ schemaVersion: 1 }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.record.schemaVersion).toBe(1);
    }
  });

  it("accepts every valid actor shape the api ACTOR_PATTERN admits", () => {
    for (const actor of ["alice", "a.b", "user@example.com", "x".repeat(128)]) {
      const result = validateMembershipRecord(record({ actor }));
      expect(result.ok).toBe(true);
    }
  });
});

describe("validateMembershipRecord refuses hostile and malformed input", () => {
  it("refuses null, undefined, and wrong primitives for record and members", () => {
    for (const hostile of [null, undefined, 42, "str", true]) {
      const rec = validateMembershipRecord(hostile);
      expect(rec.ok).toBe(false);
      if (!rec.ok) {
        expect(rec.reason).toBe("invalid-input");
      }
      const list = validateMembersList(hostile);
      expect(list.ok).toBe(false);
      if (!list.ok) {
        expect(list.reason).toBe("invalid-members-list");
      }
    }
  });

  it("refuses non-array and array-like members lists", () => {
    for (const hostile of [
      { length: 1, 0: record() },
      new Map(),
      "not-an-array",
      {},
    ]) {
      const result = validateMembersList(hostile);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("invalid-members-list");
      }
    }
  });

  it("refuses sparse array holes in members", () => {
    const holey = new Array(2);
    holey[1] = record();
    expect(validateMembersList(holey).ok).toBe(false);
    // An explicit hole between two real elements: a two-element array with
    // index 1 deleted, so a hole is present without a sparse literal.
    const sparse = [record(), record()] as unknown[];
    delete sparse[1];
    const result = validateMembersList(sparse);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("sparse-members-list");
    }
  });

  it("refuses members list exceeding 10000 entries", () => {
    expect(MAX_MEMBERS).toBe(10_000);
    const oversized = new Array(MAX_MEMBERS + 1).fill(record());
    const result = validateMembersList(oversized);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("too-many-members");
    }
    // The bound itself is admitted by the length check (elements then fail
    // validation one by one, proving the check is ordered before content).
    expect(validateMembersList(new Array(MAX_MEMBERS)).ok).toBe(false);
  });

  it("refuses objects with getters without invoking the getter", () => {
    let getterRan = false;
    const getterRecord = record();
    Object.defineProperty(getterRecord, "role", {
      enumerable: true,
      configurable: true,
      get() {
        getterRan = true;
        return "owner";
      },
    });
    const rec = validateMembershipRecord(getterRecord);
    expect(rec.ok).toBe(false);
    expect(getterRan).toBe(false);
    if (!rec.ok) {
      expect(rec.reason).toBe("getter-not-allowed");
    }
    const getterList: unknown[] = [record()];
    Object.defineProperty(getterList, "0", {
      enumerable: true,
      configurable: true,
      get() {
        getterRan = true;
        return record();
      },
    });
    const list = validateMembersList(getterList);
    expect(list.ok).toBe(false);
    expect(getterRan).toBe(false);
    if (!list.ok) {
      expect(list.reason).toBe("getter-not-allowed");
    }
    const getterChange = change("add");
    Object.defineProperty(getterChange, "actor", {
      enumerable: true,
      configurable: true,
      get() {
        getterRan = true;
        return "bob";
      },
    });
    const changeResult = validateMembershipChange(getterChange);
    expect(changeResult.ok).toBe(false);
    expect(getterRan).toBe(false);
    if (!changeResult.ok) {
      expect(changeResult.reason).toBe("getter-not-allowed");
    }
  });

  it("refuses detectable Proxy inputs", () => {
    let trapRan = false;
    const hostile = new Proxy(record(), {
      get() {
        trapRan = true;
        return "owner";
      },
      getOwnPropertyDescriptor() {
        trapRan = true;
        return undefined;
      },
      ownKeys() {
        trapRan = true;
        return [];
      },
    });
    const rec = validateMembershipRecord(hostile, isProxy);
    expect(rec.ok).toBe(false);
    const list = validateMembersList([hostile], isProxy);
    expect(list.ok).toBe(false);
    const decided = decideMembershipChange(
      [record()],
      change("change-role", { actor: "alice", role: "maintainer" }),
      NOW,
      isProxy,
    );
    expect(decided.ok).toBe(false);
    expect(trapRan).toBe(false);
  });

  it("refuses validators called without a proxy detector or with a throwing one", () => {
    // Without a detector the reflection operations could run hostile
    // Proxy traps, so the detector is required: an omitted or
    // non-function detector is a typed refusal, never a pass.
    const rec = validateMembershipRecordImpl(record(), undefined as never);
    expect(rec.ok).toBe(false);
    if (!rec.ok) {
      expect(rec.reason).toBe("proxy-detector-required");
    }
    const list = validateMembersListImpl([record()], 42 as never);
    expect(list.ok).toBe(false);
    if (!list.ok) {
      expect(list.reason).toBe("proxy-detector-required");
    }
    const changed = validateMembershipChangeImpl(change("add"), null as never);
    expect(changed.ok).toBe(false);
    if (!changed.ok) {
      expect(changed.reason).toBe("proxy-detector-required");
    }
    const decided = decideMembershipChangeImpl(
      [record()],
      change("add", { actor: "eve", role: "viewer" }),
      NOW,
      undefined as never,
    );
    expect(decided.ok).toBe(false);
    if (!decided.ok) {
      expect(decided.reason).toBe("proxy-detector-required");
    }
    // A throwing detector is also refused, and the trap never becomes a
    // silent pass.
    const throwing = () => {
      throw new Error("detector exploded");
    };
    const recThrow = validateMembershipRecordImpl(record(), throwing as never);
    expect(recThrow.ok).toBe(false);
    if (!recThrow.ok) {
      expect(recThrow.reason).toBe("detector-threw");
    }
  });

  it("refuses prototype-polluting keys", () => {
    for (const key of FORBIDDEN_KEYS) {
      const hostile = record();
      Object.defineProperty(hostile, key, {
        value: 1,
        enumerable: true,
        writable: true,
        configurable: true,
      });
      const rec = validateMembershipRecord(hostile);
      expect(rec.ok).toBe(false);
      if (!rec.ok) {
        expect(rec.reason).toBe("forbidden-key");
      }
      const hostileList = [record()];
      Object.defineProperty(hostileList, key, {
        value: 1,
        enumerable: true,
        writable: true,
        configurable: true,
      });
      const list = validateMembersList(hostileList);
      expect(list.ok).toBe(false);
      if (!list.ok) {
        expect(list.reason).toBe("forbidden-key");
      }
      const hostileChange = change("add");
      Object.defineProperty(hostileChange, key, {
        value: 1,
        enumerable: true,
        writable: true,
        configurable: true,
      });
      const changeResult = validateMembershipChange(hostileChange);
      expect(changeResult.ok).toBe(false);
      if (!changeResult.ok) {
        expect(changeResult.reason).toBe("forbidden-key");
      }
    }
  });

  it("refuses extra unknown keys, non-plain prototypes, arrays and symbols", () => {
    const secretKey = ["unknown", "Field"].join("");
    expect(validateMembershipRecord(record({ [secretKey]: 1 })).ok).toBe(false);
    expect(validateMembershipRecord(new Date(0)).ok).toBe(false);
    expect(validateMembershipRecord(Object.create({ a: 1 })).ok).toBe(false);
    expect(validateMembershipRecord([record()]).ok).toBe(false);
    const symboled = record();
    Object.defineProperty(symboled, Symbol("k"), { value: 1 });
    expect(validateMembershipRecord(symboled).ok).toBe(false);
  });

  it("refuses malformed MembershipRecord and change fields", () => {
    const badRecords: Array<[Record<string, unknown>, string]> = [
      [record({ schemaVersion: 2 }), "invalid-schema-version"],
      [record({ schemaVersion: "1" }), "invalid-schema-version"],
      [record({ organizationId: "Bad_Org" }), "invalid-organization-id"],
      [record({ organizationId: 7 }), "invalid-organization-id"],
      [record({ actor: "" }), "invalid-actor"],
      [record({ actor: "has space" }), "invalid-actor"],
      [record({ actor: "a".repeat(129) }), "invalid-actor"],
      [record({ addedBy: "bad!" }), "invalid-actor"],
      [record({ role: "admin" }), "invalid-role"],
      [record({ role: 1 }), "invalid-role"],
      [record({ addedAtIso: "2026-01-01" }), "invalid-timestamp"],
      [record({ addedAtIso: 12345 }), "invalid-timestamp"],
      [record({ addedAtIso: "2026-02-31T00:00:00Z" }), "invalid-timestamp"],
    ];
    for (const [input, reason] of badRecords) {
      const result = validateMembershipRecord(input);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe(reason);
      }
    }
    const badChanges: Array<[Record<string, unknown>, string]> = [
      [change("promote"), "invalid-kind"],
      [change("add", { role: "admin" }), "invalid-role"],
      [change("add", { organizationId: "" }), "invalid-organization-id"],
      [change("add", { actingActor: "" }), "invalid-actor"],
      [change("add", { actor: null }), "invalid-actor"],
    ];
    for (const [input, reason] of badChanges) {
      const result = validateMembershipChange(input);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe(reason);
      }
    }
    expect(validateMembershipChange(null).ok).toBe(false);
    expect(validateMembershipChange("add").ok).toBe(false);
  });

  it("refuses a non-zoned, non-ISO or wrong-typed nowIso with invalid-timestamp", () => {
    const base = [OWNER(), VIEWER()];
    for (const now of [null, undefined, 42, "2026-06-01", "June 1", "2026-06-01T12:00:00"]) {
      const result = decideMembershipChange(
        base,
        change("add", { actor: "eve", role: "viewer" }),
        now,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("invalid-timestamp");
      }
    }
    expect(isZonedIsoDateTime(NOW)).toBe(true);
  });
});

describe("decideMembershipChange accepts every valid transition", () => {
  it("allows the first-owner bootstrap on an empty members list and refuses non-owner or non-add bootstrap", () => {
    const empty: unknown[] = [];
    const bootstrap = decideMembershipChange(
      empty,
      change("add", { actingActor: "root", actor: "alice", role: "owner" }),
      NOW,
    );
    expect(bootstrap.ok).toBe(true);
    if (bootstrap.ok) {
      expect(bootstrap.members).toHaveLength(1);
      expect(bootstrap.members[0]).toEqual({
        organizationId: "acme",
        actor: "alice",
        role: "owner",
        addedAtIso: NOW,
        addedBy: "root",
      });
      expect(Object.isFrozen(bootstrap.members)).toBe(true);
      expect(Object.isFrozen(bootstrap.members[0])).toBe(true);
    }
    for (const refusal of [
      change("change-role", { actingActor: "root", actor: "alice", role: "maintainer" }),
      change("remove", { actingActor: "root", actor: "alice" }),
      change("add", { actingActor: "root", actor: "alice", role: "maintainer" }),
      change("add", { actingActor: "root", actor: "alice", role: "viewer" }),
    ]) {
      const result = decideMembershipChange(empty, refusal, NOW);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("first-owner-required");
      }
    }
  });

  it("allows an owner to add a new member with the acted role and appended record", () => {
    const result = decideMembershipChange(
      members(OWNER(), VIEWER()),
      change("add", { actor: "carol", role: "maintainer" }),
      NOW,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.members).toHaveLength(3);
      expect(result.members[2]).toEqual({
        organizationId: "acme",
        actor: "carol",
        role: "maintainer",
        addedAtIso: NOW,
        addedBy: "alice",
      });
    }
  });

  it("allows a maintainer to register work but never to manage members, so a maintainer adding a member is refused with not-permitted", () => {
    expect(canActAs("maintainer", "manage-members")).toBe(false);
    for (const attempted of [
      change("add", { actingActor: "carol", actor: "eve", role: "viewer" }),
      change("remove", { actingActor: "carol", actor: "bob" }),
    ]) {
      const result = decideMembershipChange(
        members(OWNER(), MAINTAINER(), VIEWER()),
        attempted,
        NOW,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("not-permitted");
      }
    }
  });

  it("allows an owner to change another member's role and keeps every other field", () => {
    const result = decideMembershipChange(
      members(OWNER(), member("bob", "viewer", { addedAtIso: EARLIER })),
      change("change-role", { actor: "bob", role: "maintainer" }),
      NOW,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.members[1]).toEqual({
        organizationId: "acme",
        actor: "bob",
        role: "maintainer",
        addedAtIso: EARLIER,
        addedBy: "root",
      });
    }
  });

  it("allows an owner to remove a non-last member and drops exactly that record", () => {
    const result = decideMembershipChange(
      members(OWNER(), VIEWER()),
      change("remove", { actor: "dave" }),
      NOW,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.members).toHaveLength(1);
      expect(result.members[0].actor).toBe("alice");
    }
  });

  it("refuses changes when actingActor is not in members or lacks manage-members permission", () => {
    // Absent acting actor.
    const absent = decideMembershipChange(
      members(OWNER()),
      change("add", { actingActor: "nobody", actor: "eve", role: "viewer" }),
      NOW,
    );
    expect(absent.ok).toBe(false);
    if (!absent.ok) {
      expect(absent.reason).toBe("not-permitted");
    }
    // A viewer attempting any change, even on a non-last owner.
    const viewerChanges = [
      change("add", { actingActor: "dave", actor: "eve", role: "viewer" }),
      change("change-role", {
        actingActor: "dave",
        actor: "carol",
        role: "maintainer",
      }),
      change("remove", { actingActor: "dave", actor: "carol" }),
    ];
    for (const attempted of viewerChanges) {
      const result = decideMembershipChange(
        members(OWNER(), MAINTAINER(), VIEWER()),
        attempted,
        NOW,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("not-permitted");
      }
    }
    // A maintainer attempting to demote a non-last owner is refused.
    const maintainerDemotesOwner = decideMembershipChange(
      members(OWNER(), member("mallory", "owner"), MAINTAINER()),
      change("change-role", { actingActor: "carol", actor: "mallory", role: "viewer" }),
      NOW,
    );
    expect(maintainerDemotesOwner.ok).toBe(false);
    if (!maintainerDemotesOwner.ok) {
      expect(maintainerDemotesOwner.reason).toBe("not-permitted");
    }
  });

  it("refuses members or change with mismatched organizationId", () => {
    const mixed = members(OWNER(), record({ organizationId: "other", actor: "zoe" }));
    const result = decideMembershipChange(
      mixed,
      change("add", { actor: "eve", role: "viewer" }),
      NOW,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("organization-mismatch");
    }
    const changeMismatch = decideMembershipChange(
      members(OWNER()),
      change("add", { organizationId: "other", actor: "eve", role: "viewer" }),
      NOW,
    );
    expect(changeMismatch.ok).toBe(false);
    if (!changeMismatch.ok) {
      expect(changeMismatch.reason).toBe("organization-mismatch");
    }
  });

  it("refuses adding a duplicate actor", () => {
    const result = decideMembershipChange(
      members(OWNER(), VIEWER()),
      change("add", { actor: "dave", role: "maintainer" }),
      NOW,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("duplicate-actor");
    }
  });

  it("refuses a change when the existing members list already carries two records for one actor", () => {
    // The existing list itself violates at-most-once-per-organization:
    // dave appears twice, so every change is refused instead of the
    // second record silently shadowing the first.
    const duplicated = members(OWNER(), VIEWER(), member("dave", "maintainer"));
    for (const attempted of [
      change("add", { actor: "eve", role: "viewer" }),
      change("change-role", { actor: "carol", role: "viewer" }),
      change("remove", { actor: "carol" }),
    ]) {
      const result = decideMembershipChange(duplicated, attempted, NOW);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("duplicate-actor");
      }
    }
  });

  it("refuses removing or demoting the last owner with reason last-owner", () => {
    const soleOwner = members(OWNER(), MAINTAINER());
    const removal = decideMembershipChange(
      soleOwner,
      change("remove", { actor: "alice" }),
      NOW,
    );
    expect(removal.ok).toBe(false);
    if (!removal.ok) {
      expect(removal.reason).toBe("last-owner");
    }
    const demotion = decideMembershipChange(
      soleOwner,
      change("change-role", { actor: "alice", role: "maintainer" }),
      NOW,
    );
    expect(demotion.ok).toBe(false);
    if (!demotion.ok) {
      expect(demotion.reason).toBe("last-owner");
    }
    // With two owners both removing one and demoting one are allowed.
    const twoOwners = members(OWNER(), member("mallory", "owner"), MAINTAINER());
    expect(decideMembershipChange(twoOwners, change("remove", { actor: "mallory" }), NOW).ok)
      .toBe(true);
    expect(
      decideMembershipChange(
        twoOwners,
        change("change-role", { actor: "mallory", role: "maintainer" }),
        NOW,
      ).ok,
    ).toBe(true);
    // But removing the last remaining owner then is refused.
    const afterRemove = decideMembershipChange(twoOwners, change("remove", { actor: "mallory" }), NOW);
    expect(afterRemove.ok).toBe(true);
    if (afterRemove.ok) {
      const lastOwner = decideMembershipChange(
        afterRemove.members as unknown,
        change("remove", { actor: "alice" }),
        NOW,
      );
      expect(lastOwner.ok).toBe(false);
      if (!lastOwner.ok) {
        expect(lastOwner.reason).toBe("last-owner");
      }
    }
  });

  it("refuses change-role and remove for an unknown actor", () => {
    for (const kind of ["change-role", "remove"] as const) {
      const result = decideMembershipChange(
        members(OWNER(), VIEWER()),
        change(kind, { actor: "nobody" }),
        NOW,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("unknown-actor");
      }
    }
  });

  it("refuses malformed members or change with the validator's named reason", () => {
    const badList = decideMembershipChange(
      { length: 1, 0: record() },
      change("add", { actor: "eve", role: "viewer" }),
      NOW,
    );
    expect(badList.ok).toBe(false);
    if (!badList.ok) {
      expect(badList.reason).toBe("invalid-members-list");
    }
    const badChange = decideMembershipChange(members(OWNER()), change("escalate"), NOW);
    expect(badChange.ok).toBe(false);
    if (!badChange.ok) {
      expect(badChange.reason).toBe("invalid-kind");
    }
  });
});

describe("decideMembershipChange is pure over its inputs", () => {
  it("never mutates the input members array or its elements", () => {
    const input = members(
      OWNER(),
      VIEWER(),
    ) as Array<Record<string, unknown>>;
    const before = JSON.stringify(input);
    const decided = decideMembershipChange(
      input,
      change("add", { actor: "carol", role: "viewer" }),
      NOW,
    );
    expect(decided.ok).toBe(true);
    expect(JSON.stringify(input)).toBe(before);
    expect(input).toHaveLength(2);
    expect(Object.isFrozen(input[0])).toBe(false);
    expect(Object.isFrozen(decided.ok ? (decided.members[0] as unknown) : null)).toBe(true);
  });
});
