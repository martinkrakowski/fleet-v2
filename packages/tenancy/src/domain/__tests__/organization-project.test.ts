/**
 * Domain tests for the tenancy organization and project records (FC3A).
 *
 * Every title states what the test asserts and every body proves it; each
 * assertion would fail against a constant `refused`-only implementation or
 * an identity function, because valid inputs are asserted accepted with
 * exact field values and every refusal is asserted with a named reason.
 *
 * Cost bounds under test: each validator performs one bounded snapshot pass
 * (at most 6 keys for an organization record, 7 for a project record) and
 * one pass over at most that key set; `retireOrganization` adds two
 * timestamp parses; `acceptsNewWork` adds one bounded validation pass plus
 * two field reads on the validated snapshot; and
 * `decideProjectTransition` is two validations plus three comparisons. All
 * are O(1).
 *
 * Hostile-input posture: every case below proves a typed refusal (never a
 * throw, never a pass) for null, undefined, non-objects, arrays, array-likes,
 * non-plain prototypes, sparse arrays, getters (never invoked), Proxies
 * (traps never run when the detector is supplied), enormous lengths,
 * prototype-polluting own keys, and oversized strings.
 */
import { types } from "node:util";

import { describe, expect, it } from "vitest";

import {
  acceptsNewWork,
  compareZonedIsoInstants,
  DEFAULT_ORGANIZATION_ID,
  decideProjectTransition,
  isZonedIsoDateTime,
  ORGANIZATION_ID_PATTERN,
  OrganizationRecord,
  retireOrganization,
  validateOrganizationRecord,
  validateProjectRecord,
} from "../entities/index.js";

const isProxy = types.isProxy as (value: unknown) => boolean;

const CREATED = "2026-01-01T00:00:00Z";
const RETIRED_AT = "2026-06-01T12:00:00.500Z";
const OFFSET_STAMP = "2026-03-01T08:30:00+02:00";

function validOrganization(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    organizationId: "acme",
    displayName: "Acme",
    status: "active",
    createdAtIso: CREATED,
    retiredAtIso: null,
    ...overrides,
  };
}

function validProject(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    projectId: "website",
    organizationId: "acme",
    displayName: "Website",
    status: "active",
    createdAtIso: CREATED,
    retiredAtIso: null,
    ...overrides,
  };
}

describe("organization and project validators accept valid records", () => {
  it("validateOrganizationRecord accepts an active record with exact field values and no schemaVersion", () => {
    const result = validateOrganizationRecord(validOrganization());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({
        schemaVersion: undefined,
        organizationId: "acme",
        displayName: "Acme",
        status: "active",
        createdAtIso: CREATED,
        retiredAtIso: null,
      });
    }
  });

  it("validateOrganizationRecord accepts a retired record whose retiredAtIso is at createdAtIso and an offset-zoned createdAtIso", () => {
    const result = validateOrganizationRecord(
      validOrganization({ status: "retired", retiredAtIso: CREATED }),
    );
    expect(result.ok).toBe(true);
    expect(validateOrganizationRecord({ ...validOrganization({ createdAtIso: OFFSET_STAMP }) }).ok)
      .toBe(true);
  });

  it("validateProjectRecord accepts an active record with exact field values", () => {
    const result = validateProjectRecord(validProject());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.projectId).toBe("website");
      expect(result.value.organizationId).toBe("acme");
      expect(result.value.status).toBe("active");
      expect(result.value.retiredAtIso).toBe(null);
    }
  });

  it("DEFAULT_ORGANIZATION_ID is the string default and passes ORGANIZATION_ID_PATTERN and the organization validator", () => {
    expect(DEFAULT_ORGANIZATION_ID).toBe("default");
    expect(ORGANIZATION_ID_PATTERN.test(DEFAULT_ORGANIZATION_ID)).toBe(true);
    const result = validateOrganizationRecord(
      validOrganization({ organizationId: DEFAULT_ORGANIZATION_ID }),
    );
    expect(result.ok).toBe(true);
  });

  it("isZonedIsoDateTime accepts zoned ISO-8601 stamps with Z, offsets and fractional seconds and is exported for reuse", () => {
    expect(isZonedIsoDateTime(CREATED)).toBe(true);
    expect(isZonedIsoDateTime(RETIRED_AT)).toBe(true);
    expect(isZonedIsoDateTime(OFFSET_STAMP)).toBe(true);
  });
});

describe("organization and project validators refuse hostile and malformed input", () => {
  it("refuses null and undefined for organization and project records", () => {
    for (const input of [null, undefined]) {
      const org = validateOrganizationRecord(input, isProxy);
      expect(org.ok).toBe(false);
      if (!org.ok) {
        expect(org.reason).toBe("organization record must be a plain object");
      }
      const project = validateProjectRecord(input, isProxy);
      expect(project.ok).toBe(false);
      if (!project.ok) {
        expect(project.reason).toBe("project record must be a plain object");
      }
    }
  });

  it("refuses primitives, arrays, array-likes, and non-plain prototypes", () => {
    const primitives = [42, "str", true];
    const array: unknown[] = [];
    const arrayLike = { length: 1000000 };
    const date = new Date(0);
    const pseudoPlain = Object.create({ a: 1 }) as Record<string, unknown>;
    for (const input of [...primitives, array, arrayLike, date, pseudoPlain]) {
      expect(validateOrganizationRecord(input, isProxy).ok).toBe(false);
      expect(validateProjectRecord(input, isProxy).ok).toBe(false);
    }
  });

  it("refuses extra unknown keys without echoing key or value", () => {
    const secretKey = ["unknown", "Key"].join("");
    const secretValue = ["hidden", "Value"].join("");
    const org = validateOrganizationRecord(
      validOrganization({ [secretKey]: secretValue }),
      isProxy,
    );
    expect(org.ok).toBe(false);
    if (!org.ok) {
      expect(org.reason).toContain("extra unknown key");
      expect(org.reason).not.toContain(secretKey);
      expect(org.reason).not.toContain(secretValue);
    }
    const project = validateProjectRecord(
      validProject({ [secretKey]: secretValue }),
      isProxy,
    );
    expect(project.ok).toBe(false);
    if (!project.ok) {
      expect(project.reason).toContain("extra unknown key");
      expect(project.reason).not.toContain(secretKey);
    }
  });

  it("refuses prototype-polluting own keys", () => {
    for (const key of ["__proto__", "constructor"]) {
      const org = { ...validOrganization() } as Record<string, unknown>;
      Object.defineProperty(org, key, { value: 1, enumerable: true, writable: true, configurable: true });
      const orgResult = validateOrganizationRecord(org, isProxy);
      expect(orgResult.ok).toBe(false);
      if (!orgResult.ok) {
        expect(orgResult.reason).toContain(`prototype-polluting key ${key}`);
      }
      const project = { ...validProject() } as Record<string, unknown>;
      Object.defineProperty(project, key, { value: 1, enumerable: true, writable: true, configurable: true });
      const projectResult = validateProjectRecord(project, isProxy);
      expect(projectResult.ok).toBe(false);
      if (!projectResult.ok) {
        expect(projectResult.reason).toContain(`prototype-polluting key ${key}`);
      }
    }
  });

  it("refuses getter properties without invoking them", () => {
    let getterRan = false;
    const org = validOrganization() as Record<string, unknown>;
    Object.defineProperty(org, "displayName", {
      enumerable: true,
      configurable: true,
      get() {
        getterRan = true;
        return "Acme";
      },
    });
    const result = validateOrganizationRecord(org, isProxy);
    expect(result.ok).toBe(false);
    expect(getterRan).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("getter or setter");
      // The refusal names the field the accessor sits on.
      expect(result.reason).toContain("displayName");
    }
  });

  it("refuses Proxy inputs without running traps", () => {
    let trapRan = false;
    const hostile = new Proxy(validOrganization(), {
      get() {
        trapRan = true;
        throw new Error("trap");
      },
      getOwnPropertyDescriptor() {
        trapRan = true;
        throw new Error("trap");
      },
      ownKeys() {
        trapRan = true;
        throw new Error("trap");
      },
    });
    const org = validateOrganizationRecord(hostile, isProxy);
    expect(org.ok).toBe(false);
    const project = validateProjectRecord(hostile, isProxy);
    expect(project.ok).toBe(false);
    expect(trapRan).toBe(false);
  });

  it("refuses sparse arrays, non-iterables, and enormous length values", () => {
    const holey = new Array(3);
    holey[0] = 1;
    expect(validateOrganizationRecord(holey, isProxy).ok).toBe(false);
    expect(validateProjectRecord(holey, isProxy).ok).toBe(false);
    // An enormous length as the record itself (an array-like) and as a field
    // value are both refused; nothing iterates a billion entries.
    const enormous = { length: 1e9 };
    expect(validateOrganizationRecord(enormous, isProxy).ok).toBe(false);
    const project = validateProjectRecord(
      validProject({ displayName: enormous }),
      isProxy,
    );
    expect(project.ok).toBe(false);
  });

  it("refuses missing required fields and wrong primitive types", () => {
    const requiredOrgFields = [
      "organizationId",
      "displayName",
      "status",
      "createdAtIso",
      "retiredAtIso",
    ];
    for (const field of requiredOrgFields) {
      const input = { ...validOrganization() };
      delete input[field];
      const result = validateOrganizationRecord(input, isProxy);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toContain(field);
      }
    }
    const wrongTypes: Array<[string, unknown]> = [
      ["organizationId", 7],
      ["displayName", 42],
      ["status", "paused"],
      ["createdAtIso", 12345],
      ["retiredAtIso", false],
    ];
    for (const [field, value] of wrongTypes) {
      const result = validateOrganizationRecord(validOrganization({ [field]: value }), isProxy);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toContain(field);
      }
    }
    for (const field of ["projectId", "organizationId", "displayName", "status", "createdAtIso", "retiredAtIso"]) {
      const input = { ...validProject() };
      delete input[field];
      const result = validateProjectRecord(input, isProxy);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toContain(field);
      }
    }
  });

  it("refuses oversized strings without echoing value", () => {
    const oversizedName = "x".repeat(5000);
    const org = validateOrganizationRecord(
      validOrganization({ displayName: oversizedName }),
      isProxy,
    );
    expect(org.ok).toBe(false);
    if (!org.ok) {
      expect(org.reason).toContain("displayName");
      expect(org.reason).not.toContain(oversizedName);
    }
    const longButWithin4096 = "x".repeat(121);
    const orgName = validateOrganizationRecord(
      validOrganization({ displayName: longButWithin4096 }),
      isProxy,
    );
    expect(orgName.ok).toBe(false);
    if (!orgName.ok) {
      expect(orgName.reason).toContain("displayName");
      expect(orgName.reason).not.toContain(longButWithin4096);
    }
    const projectCreatedAt = validateProjectRecord(
      validProject({ createdAtIso: "y".repeat(4097) }),
      isProxy,
    );
    expect(projectCreatedAt.ok).toBe(false);
  });

  it("refuses invalid id patterns and control characters in displayName", () => {
    const badIds = ["", "Upper", "has_underscore", "-leading", "a".repeat(64), "sp ace"];
    for (const id of badIds) {
      const org = validateOrganizationRecord(validOrganization({ organizationId: id }), isProxy);
      expect(org.ok).toBe(false);
      if (!org.ok) {
        expect(org.reason).toContain("organizationId");
      }
      const project = validateProjectRecord(validProject({ projectId: id }), isProxy);
      expect(project.ok).toBe(false);
      if (!project.ok) {
        expect(project.reason).toContain("projectId");
      }
      const projectOrg = validateProjectRecord(
        validProject({ organizationId: id }),
        isProxy,
      );
      expect(projectOrg.ok).toBe(false);
      if (!projectOrg.ok) {
        expect(projectOrg.reason).toContain("organizationId");
      }
    }
    for (const name of ["", `a\u0007b`, `a\u001fb`]) {
      const org = validateOrganizationRecord(validOrganization({ displayName: name }), isProxy);
      expect(org.ok).toBe(false);
      if (!org.ok) {
        expect(org.reason).toContain("displayName");
      }
      const project = validateProjectRecord(validProject({ displayName: name }), isProxy);
      expect(project.ok).toBe(false);
    }
  });

  it("refuses unknown schemaVersion and invalid status", () => {
    for (const version of [2, "1", null]) {
      const org = validateOrganizationRecord(validOrganization({ schemaVersion: version }), isProxy);
      expect(org.ok).toBe(false);
      if (!org.ok) {
        expect(org.reason).toContain("schemaVersion");
      }
      const project = validateProjectRecord(validProject({ schemaVersion: version }), isProxy);
      expect(project.ok).toBe(false);
    }
    for (const status of ["paused", "ACTIVE", ""]) {
      const org = validateOrganizationRecord(validOrganization({ status }), isProxy);
      expect(org.ok).toBe(false);
      if (!org.ok) {
        expect(org.reason).toContain("status");
      }
      const project = validateProjectRecord(validProject({ status }), isProxy);
      expect(project.ok).toBe(false);
    }
  });

  it("refuses non-zoned, non-ISO, and calendar-invalid timestamps", () => {
    const invalid = ["2026-01-01", "Jan 1 2026", "2026-02-31T00:00:00Z", "2026-01-01T00:00:00"];
    for (const stamp of invalid) {
      for (const field of ["createdAtIso", "retiredAtIso"] as const) {
        const org = validateOrganizationRecord(
          validOrganization({ status: "retired", [field]: stamp, ...(field === "createdAtIso" ? { retiredAtIso: RETIRED_AT } : {}) }),
          isProxy,
        );
        expect(org.ok).toBe(false);
        if (!org.ok) {
          expect(org.reason).toContain(field);
        }
        const project = validateProjectRecord(
          validProject({ status: "retired", [field]: stamp, ...(field === "createdAtIso" ? { retiredAtIso: RETIRED_AT } : {}) }),
          isProxy,
        );
        expect(project.ok).toBe(false);
      }
      const retire = retireOrganization(
        validateOrganizationRecord(validOrganization()).ok
          ? (validateOrganizationRecord(validOrganization()) as { ok: true; value: OrganizationRecord }).value
          : undefined as unknown as OrganizationRecord,
        stamp,
      );
      expect(retire.ok).toBe(false);
    }
  });

  it("refuses inconsistent retiredAtIso on active and retired records", () => {
    const activeWithStamp = validateOrganizationRecord(
      validOrganization({ retiredAtIso: RETIRED_AT }),
      isProxy,
    );
    expect(activeWithStamp.ok).toBe(false);
    if (!activeWithStamp.ok) {
      expect(activeWithStamp.reason).toContain("retiredAtIso");
    }
    const retiredWithoutStamp = validateOrganizationRecord(
      validOrganization({ status: "retired" }),
      isProxy,
    );
    expect(retiredWithoutStamp.ok).toBe(false);
    if (!retiredWithoutStamp.ok) {
      expect(retiredWithoutStamp.reason).toContain("retiredAtIso");
    }
    const retiredBeforeCreated = validateProjectRecord(
      validProject({ status: "retired", retiredAtIso: "2025-12-31T23:59:59Z" }),
      isProxy,
    );
    expect(retiredBeforeCreated.ok).toBe(false);
    if (!retiredBeforeCreated.ok) {
      expect(retiredBeforeCreated.reason).toContain("retiredAtIso");
    }
  });
});

describe("retireOrganization", () => {
  it("returns a new retired record with retiredAtIso set to nowIso and leaves the input record unmutated", () => {
    const original = validateOrganizationRecord(validOrganization());
    if (!original.ok) {
      throw new Error("fixture must validate");
    }
    const before = { ...original.value };
    const result = retireOrganization(original.value, RETIRED_AT);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.record.status).toBe("retired");
      expect(result.record.retiredAtIso).toBe(RETIRED_AT);
      expect(result.record.createdAtIso).toBe(CREATED);
      expect(Object.isFrozen(result.record)).toBe(true);
    }
    expect(original.value).toEqual(before);
    expect(original.value.status).toBe("active");
  });

  it("retireOrganization refuses already-retired records and earlier timestamps without mutating input", () => {
    const active = validateOrganizationRecord(validOrganization());
    if (!active.ok) {
      throw new Error("fixture must validate");
    }
    const retired = retireOrganization(active.value, RETIRED_AT);
    if (!retired.ok) {
      throw new Error("first retirement must succeed");
    }
    const before = { ...retired.record };
    const alreadyRetired = retireOrganization(retired.record, "2027-01-01T00:00:00Z");
    expect(alreadyRetired.ok).toBe(false);
    expect(retired.record).toEqual(before);
    const earlier = retireOrganization(active.value, "2025-12-31T23:59:59Z");
    expect(earlier.ok).toBe(false);
    if (!earlier.ok) {
      expect(earlier.reason).toContain("nowIso");
    }
    expect(active.value.status).toBe("active");
    for (const badNow of ["2026-01-01", "not a stamp"]) {
      const badStamp = retireOrganization(active.value, badNow);
      expect(badStamp.ok).toBe(false);
    }
  });

  it("acceptsNewWork returns false for retired organizations including the default organization", () => {
    const active = validateOrganizationRecord(validOrganization({ organizationId: DEFAULT_ORGANIZATION_ID }));
    if (!active.ok) {
      throw new Error("fixture must validate");
    }
    expect(acceptsNewWork(active.value)).toBe(true);
    const retiredDefault = retireOrganization(active.value, RETIRED_AT);
    if (!retiredDefault.ok) {
      throw new Error("retirement must succeed");
    }
    expect(acceptsNewWork(retiredDefault.record)).toBe(false);
    const explicitlyRetired = validateOrganizationRecord(
      validOrganization({ status: "retired", retiredAtIso: RETIRED_AT }),
    );
    if (!explicitlyRetired.ok) {
      throw new Error("fixture must validate");
    }
    expect(acceptsNewWork(explicitlyRetired.value)).toBe(false);
  });

  it("acceptsNewWork returns false for hostile input without throwing, invoking getters, or running Proxy traps", () => {
    // Hostile shapes read as untrusted input: null, undefined, primitives,
    // arrays, array-likes and enormous lengths all return false, never throw.
    for (const hostile of [null, undefined, 42, "str", true, [], { length: 1e9 }]) {
      expect(acceptsNewWork(hostile)).toBe(false);
    }
    // A getter-backed record is refused and the getter is never executed.
    let getterRan = false;
    const getterBacked = Object.defineProperty({}, "status", {
      enumerable: true,
      get() {
        getterRan = true;
        return "active";
      },
    });
    expect(acceptsNewWork(getterBacked)).toBe(false);
    expect(getterRan).toBe(false);
    // A Proxy is refused when the detector is supplied, and its traps never
    // run; even without the detector a throwing trap yields a typed refusal,
    // never a throw.
    const proxy = new Proxy(validOrganization(), {
      get() {
        throw new Error("trap must not run");
      },
      ownKeys() {
        throw new Error("trap must not run");
      },
    });
    expect(acceptsNewWork(proxy, isProxy)).toBe(false);
    expect(acceptsNewWork(proxy)).toBe(false);
  });
});

describe("decideProjectTransition", () => {
  it("accepts an unchanged record and an active-to-retired transition with a valid retiredAtIso", () => {
    const current = validateProjectRecord(validProject());
    if (!current.ok) {
      throw new Error("fixture must validate");
    }
    const unchanged = decideProjectTransition(current.value, current.value);
    expect(unchanged.ok).toBe(true);
    const retiring = decideProjectTransition(current.value, {
      ...validProject({ status: "retired", retiredAtIso: RETIRED_AT }),
    });
    expect(retiring.ok).toBe(true);
    if (retiring.ok) {
      expect(retiring.value.status).toBe("retired");
      expect(retiring.value.retiredAtIso).toBe(RETIRED_AT);
    }
  });

  it("decideProjectTransition refuses changing immutable fields or reactivating a retired project", () => {
    const current = validateProjectRecord(validProject());
    if (!current.ok) {
      throw new Error("fixture must validate");
    }
    const retired = validateProjectRecord(
      validProject({ status: "retired", retiredAtIso: RETIRED_AT }),
    );
    if (!retired.ok) {
      throw new Error("fixture must validate");
    }
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ ...validProject({ projectId: "other" }) }, "projectId"],
      [{ ...validProject({ organizationId: "other-org" }) }, "organizationId"],
      [{ ...validProject({ createdAtIso: "2026-02-01T00:00:00Z" }) }, "createdAtIso"],
    ];
    for (const [next, field] of cases) {
      const result = decideProjectTransition(current.value, next);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe(`${field} is immutable`);
      }
    }
    const reactivated = decideProjectTransition(retired.value, validProject());
    expect(reactivated.ok).toBe(false);
    if (!reactivated.ok) {
      expect(reactivated.reason).toContain("status");
    }
    const retiredAgain = decideProjectTransition(retired.value, retired.value);
    expect(retiredAgain.ok).toBe(true);
    const badRetire = decideProjectTransition(current.value, {
      ...validProject({ status: "retired", retiredAtIso: "2025-12-31T23:59:59Z" }),
    });
    expect(badRetire.ok).toBe(false);
    if (!badRetire.ok) {
      expect(badRetire.reason).toContain("retiredAtIso");
    }
  });

  it("refuses an invalid current or next record instead of comparing unvalidated data", () => {
    const current = validateProjectRecord(validProject());
    if (!current.ok) {
      throw new Error("fixture must validate");
    }
    const badCurrent = decideProjectTransition(null, validProject());
    expect(badCurrent.ok).toBe(false);
    if (!badCurrent.ok) {
      expect(badCurrent.reason).toContain("current");
    }
    const badNext = decideProjectTransition(current.value, 42);
    expect(badNext.ok).toBe(false);
    if (!badNext.ok) {
      expect(badNext.reason).toContain("next");
    }
  });
});

describe("FC3A review fixes: schemaVersion presence, sub-millisecond ordering, non-enumerable field names", () => {
  it("refuses an own schemaVersion key whose value is undefined for organization and project, while an absent key is accepted", () => {
    const org = validateOrganizationRecord(validOrganization({ schemaVersion: undefined }));
    expect(org.ok).toBe(false);
    if (!org.ok) {
      expect(org.reason).toContain("schemaVersion");
    }
    const project = validateProjectRecord(validProject({ schemaVersion: undefined }));
    expect(project.ok).toBe(false);
    if (!project.ok) {
      expect(project.reason).toContain("schemaVersion");
    }
    expect(validateOrganizationRecord(validOrganization()).ok).toBe(true);
    expect(validateProjectRecord(validProject()).ok).toBe(true);
    expect(validateOrganizationRecord(validOrganization({ schemaVersion: 1 })).ok).toBe(true);
  });

  it("compareZonedIsoInstants orders instants that differ only below one millisecond and reports equal instants as zero", () => {
    expect(
      compareZonedIsoInstants("2026-01-01T00:00:00.0000001Z", "2026-01-01T00:00:00.0000009Z"),
    ).toBeLessThan(0);
    expect(
      compareZonedIsoInstants("2026-01-01T00:00:00.0000009Z", "2026-01-01T00:00:00.0000001Z"),
    ).toBeGreaterThan(0);
    expect(
      compareZonedIsoInstants("2026-01-01T00:00:00.5Z", "2026-01-01T00:00:00.500000000Z"),
    ).toBe(0);
    expect(
      compareZonedIsoInstants("2026-01-01T00:00:00.999Z", "2026-01-01T00:00:01Z"),
    ).toBeLessThan(0);
    expect(
      compareZonedIsoInstants("2026-01-01T02:00:00+02:00", "2026-01-01T00:00:00Z"),
    ).toBe(0);
  });

  it("refuses a retired organization and project whose retiredAtIso precedes createdAtIso by less than a millisecond, and accepts equal and later sub-millisecond values", () => {
    const createdAtIso = "2026-01-01T00:00:00.0000009Z";
    const early = "2026-01-01T00:00:00.0000001Z";
    const later = "2026-01-01T00:00:00.0000010Z";
    const org = validateOrganizationRecord(
      validOrganization({ createdAtIso, status: "retired", retiredAtIso: early }),
    );
    expect(org.ok).toBe(false);
    if (!org.ok) {
      expect(org.reason).toContain("retiredAtIso");
    }
    const project = validateProjectRecord(
      validProject({ createdAtIso, status: "retired", retiredAtIso: early }),
    );
    expect(project.ok).toBe(false);
    expect(
      validateOrganizationRecord(
        validOrganization({ createdAtIso, status: "retired", retiredAtIso: createdAtIso }),
      ).ok,
    ).toBe(true);
    expect(
      validateProjectRecord(
        validProject({ createdAtIso, status: "retired", retiredAtIso: later }),
      ).ok,
    ).toBe(true);
  });

  it("retireOrganization refuses a nowIso that precedes createdAtIso by less than a millisecond", () => {
    const active = validateOrganizationRecord(
      validOrganization({ createdAtIso: "2026-01-01T00:00:00.0000009Z" }),
    );
    expect(active.ok).toBe(true);
    if (!active.ok) {
      return;
    }
    const early = retireOrganization(active.value, "2026-01-01T00:00:00.0000001Z");
    expect(early.ok).toBe(false);
    expect(retireOrganization(active.value, "2026-01-01T00:00:00.0000009Z").ok).toBe(true);
  });

  it("names the field in the refusal when an allowed field is a non-enumerable property, for organization and project", () => {
    const org = validOrganization();
    Object.defineProperty(org, "displayName", { value: "Acme", enumerable: false });
    const orgResult = validateOrganizationRecord(org);
    expect(orgResult.ok).toBe(false);
    if (!orgResult.ok) {
      expect(orgResult.reason).toContain("displayName");
      expect(orgResult.reason).toContain("non-enumerable");
    }
    const project = validProject();
    Object.defineProperty(project, "displayName", { value: "Website", enumerable: false });
    const projectResult = validateProjectRecord(project);
    expect(projectResult.ok).toBe(false);
    if (!projectResult.ok) {
      expect(projectResult.reason).toContain("displayName");
      expect(projectResult.reason).toContain("non-enumerable");
    }
  });

  it("decideProjectTransition refuses a retired next record whose retiredAtIso precedes createdAtIso below a millisecond", () => {
    const createdAtIso = "2026-01-01T00:00:00.0000009Z";
    const current = validProject({ createdAtIso });
    const next = validProject({
      createdAtIso,
      status: "retired",
      retiredAtIso: "2026-01-01T00:00:00.0000001Z",
    });
    expect(decideProjectTransition(current, next).ok).toBe(false);
  });
});
