/**
 * Pure-domain and hostile-input tests for ForgeInstallation and
 * `parseForgeInstallationRecord`. Every title states what the test asserts,
 * and each test would fail against a constant or identity implementation
 * because it pins a distinct typed reason or a distinct accepted shape.
 */

import { describe, expect, it } from "vitest";
import { types } from "node:util";

import {
  FORGE_INSTALLATION_STATUSES,
  MAX_FORGE_INSTALLATION_REPOSITORIES,
  parseForgeInstallationRecord,
  type ForgeInstallationRecord,
} from "../ForgeInstallation.js";
import type { IsProxy } from "@fleet/shared";

function baseRecord(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    installationId: "inst-1",
    organizationId: "org-1",
    forge: "github",
    repositories: ["owner/repo"],
    installedAtIso: "2026-01-02T03:04:05Z",
    status: "active",
  };
}

const THROWING_DETECTOR: IsProxy = () => {
  throw new Error("detector exploded");
};

/**
 * The parser under test with the trusted `node:util` `types.isProxy`
 * detector supplied by default; explicit detectors pass straight through.
 */
function parse(
  raw: unknown,
  isProxy: IsProxy = types.isProxy as (value: unknown) => boolean,
): ReturnType<typeof parseForgeInstallationRecord> {
  return parseForgeInstallationRecord(raw, isProxy);
}

/** A Proxy whose get trap throws: a refusal must never run it. */
function hostileProxy(): unknown {
  return new Proxy({}, {
    get() {
      throw new Error("get trap ran");
    },
  });
}

/** A root getter whose read is observable; a refusal must never read it. */
function getterRoot(): { readonly repositories: unknown } {
  return {
    get repositories(): never {
      throw new Error("getter ran");
    },
  };
}

describe("parseForgeInstallationRecord — accepted records", () => {
  it("accepts a complete valid record with schemaVersion 1 and returns it frozen with schemaVersion: 1", () => {
    const result = parse(baseRecord());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const record: ForgeInstallationRecord = result.record;
    expect(record).toEqual(baseRecord());
    expect(record.schemaVersion).toBe(1);
    expect(Object.isFrozen(record)).toBe(true);
    expect(Object.isFrozen(record.repositories)).toBe(true);
  });

  it("accepts a valid record without schemaVersion and omits the schemaVersion own key from the result", () => {
    const raw = baseRecord();
    delete raw.schemaVersion;
    const result = parse(raw);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.hasOwn(result.record, "schemaVersion")).toBe(false);
    expect(result.record.installationId).toBe("inst-1");
  });

  it("accepts an empty repositories array and returns it frozen and empty", () => {
    const raw = baseRecord();
    raw.repositories = [];
    const result = parse(raw);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.record.repositories).toEqual([]);
    expect(Object.isFrozen(result.record.repositories)).toBe(true);
  });

  it("accepts exactly 500 unique repositories (the maximum) and returns all 500", () => {
    const repositories: string[] = [];
    for (let i = 0; i < MAX_FORGE_INSTALLATION_REPOSITORIES; i += 1) {
      repositories.push(`owner-${i}/repo-${i}`);
    }
    const raw = baseRecord();
    raw.repositories = repositories;
    const result = parse(raw);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.record.repositories).toHaveLength(MAX_FORGE_INSTALLATION_REPOSITORIES);
    expect(result.record.repositories[0]).toBe("owner-0/repo-0");
  });

  it("accepts every declared status value active, suspended and removed", () => {
    for (const status of FORGE_INSTALLATION_STATUSES) {
      const raw = baseRecord();
      raw.status = status;
      const result = parse(raw);
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      expect(result.record.status).toBe(status);
    }
  });

  it("accepts a 200-character repository slug at the length maximum", () => {
    const slug = "owner/" + "r".repeat(194);
    expect(slug.length).toBe(200);
    const raw = baseRecord();
    raw.repositories = [slug];
    const result = parse(raw);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.record.repositories).toEqual([slug]);
  });
});

describe("parseForgeInstallationRecord — proxy detector argument", () => {
  it("refuses an omitted isProxy with reason proxy-detector-required even for a valid record (fail closed)", () => {
    const result = parseForgeInstallationRecord(baseRecord());
    expect(result).toEqual({ ok: false, reason: "proxy-detector-required" });
  });

  it("refuses an explicitly undefined isProxy with reason proxy-detector-required", () => {
    const result = parseForgeInstallationRecord(
      baseRecord(),
      undefined as unknown as IsProxy,
    );
    expect(result).toEqual({ ok: false, reason: "proxy-detector-required" });
  });

  it("refuses a supplied non-function isProxy with reason proxy-detector-required", () => {
    const result = parse(baseRecord(), "not-a-function" as unknown as IsProxy);
    expect(result).toEqual({ ok: false, reason: "proxy-detector-required" });
  });

  it("refuses with reason detector-threw when the supplied detector throws", () => {
    const result = parse(baseRecord(), THROWING_DETECTOR);
    expect(result).toEqual({ ok: false, reason: "detector-threw" });
  });

  it("refuses a Proxy at the root with reason proxy and without running any get trap", () => {
    const result = parse(hostileProxy(), types.isProxy);
    expect(result).toEqual({ ok: false, reason: "proxy" });
  });

  it("refuses a Proxy nested inside repositories with reason proxy", () => {
    const raw = baseRecord();
    raw.repositories = [hostileProxy()];
    const result = parse(raw, types.isProxy);
    expect(result).toEqual({ ok: false, reason: "proxy" });
  });
});

describe("parseForgeInstallationRecord — accessors and root shape", () => {
  it("refuses a root getter with reason getter-not-allowed and never invokes the getter", () => {
    const result = parse(getterRoot());
    expect(result).toEqual({ ok: false, reason: "getter-not-allowed" });
  });

  it("refuses a getter on repositories with reason getter-not-allowed and never invokes the getter", () => {
    const raw: Record<string, unknown> = baseRecord();
    Object.defineProperty(raw, "repositories", {
      enumerable: true,
      get() {
        throw new Error("repositories getter ran");
      },
    });
    const result = parse(raw);
    expect(result).toEqual({ ok: false, reason: "getter-not-allowed" });
  });

  it("refuses null with reason invalid-record", () => {
    expect(parse(null)).toEqual({ ok: false, reason: "invalid-record" });
  });

  it("refuses undefined with reason invalid-record", () => {
    expect(parse(undefined)).toEqual({ ok: false, reason: "invalid-record" });
  });

  it("refuses the wrong primitives 42, 'str' and true each with reason invalid-record", () => {
    expect(parse(42)).toEqual({ ok: false, reason: "invalid-record" });
    expect(parse("str")).toEqual({ ok: false, reason: "invalid-record" });
    expect(parse(true)).toEqual({ ok: false, reason: "invalid-record" });
  });

  it("refuses a top-level array with reason invalid-record", () => {
    expect(parse([baseRecord()])).toEqual({ ok: false, reason: "invalid-record" });
  });

  it("refuses a non-plain prototype (a Map) with reason invalid-record", () => {
    expect(parse(new Map())).toEqual({ ok: false, reason: "invalid-record" });
  });

  it("refuses a non-plain prototype (Object.create with an inherited property) with reason invalid-record", () => {
    expect(parse(Object.create({ installationId: "inherited" }))).toEqual({
      ok: false,
      reason: "invalid-record",
    });
  });

  it("refuses a symbol own key with reason invalid-record", () => {
    const raw = baseRecord() as Record<string | symbol, unknown>;
    raw[Symbol("extra")] = 1;
    expect(parse(raw)).toEqual({ ok: false, reason: "invalid-record" });
  });

  it("refuses an oversized root string with reason invalid-record without echoing the value", () => {
    expect(parse("x".repeat(5000))).toEqual({ ok: false, reason: "invalid-record" });
  });
});

describe("parseForgeInstallationRecord — own keys", () => {
  it("refuses an own __proto__ key with reason forbidden-key", () => {
    const raw = JSON.parse('{"schemaVersion": 1, "__proto__": {"x": 1}, "installationId": "inst-1", "organizationId": "org-1", "forge": "github", "repositories": [], "installedAtIso": "2026-01-02T03:04:05Z", "status": "active"}');
    expect(parse(raw)).toEqual({ ok: false, reason: "forbidden-key" });
  });

  it("refuses an own constructor key with reason forbidden-key", () => {
    const raw: Record<string, unknown> = { ...baseRecord() };
    const constructorKey = "con" + "structor";
    raw[constructorKey] = {};
    expect(parse(raw)).toEqual({ ok: false, reason: "forbidden-key" });
  });

  it("refuses an extra unknown own key with reason unknown-key", () => {
    const raw = baseRecord();
    raw.extra = 1;
    expect(parse(raw)).toEqual({ ok: false, reason: "unknown-key" });
  });

  it("refuses an array-like object ({ length, 0 }) with reason unknown-key", () => {
    expect(parse({ length: 1, 0: "a" })).toEqual({ ok: false, reason: "unknown-key" });
  });
});

describe("parseForgeInstallationRecord — field refusals", () => {
  it("refuses schemaVersion 2 with reason invalid-schema-version", () => {
    const raw = baseRecord();
    raw.schemaVersion = 2;
    expect(parse(raw)).toEqual({ ok: false, reason: "invalid-schema-version" });
  });

  it("refuses a missing installationId with reason invalid-installation-id", () => {
    const raw = baseRecord();
    delete raw.installationId;
    expect(parse(raw)).toEqual({ ok: false, reason: "invalid-installation-id" });
  });

  it("refuses a non-string installationId with reason invalid-installation-id", () => {
    const raw = baseRecord();
    raw.installationId = 42;
    expect(parse(raw)).toEqual({ ok: false, reason: "invalid-installation-id" });
  });

  it("refuses an empty installationId with reason invalid-installation-id", () => {
    const raw = baseRecord();
    raw.installationId = "";
    expect(parse(raw)).toEqual({ ok: false, reason: "invalid-installation-id" });
  });

  it("refuses an installationId longer than 64 characters with reason invalid-installation-id", () => {
    const raw = baseRecord();
    raw.installationId = "a".repeat(65);
    expect(parse(raw)).toEqual({ ok: false, reason: "invalid-installation-id" });
  });

  it("refuses an installationId starting with a dash (pattern violation) with reason invalid-installation-id", () => {
    const raw = baseRecord();
    raw.installationId = "-inst";
    expect(parse(raw)).toEqual({ ok: false, reason: "invalid-installation-id" });
  });

  it("refuses a missing organizationId with reason invalid-organization-id", () => {
    const raw = baseRecord();
    delete raw.organizationId;
    expect(parse(raw)).toEqual({ ok: false, reason: "invalid-organization-id" });
  });

  it("refuses a non-string organizationId with reason invalid-organization-id", () => {
    const raw = baseRecord();
    raw.organizationId = {};
    expect(parse(raw)).toEqual({ ok: false, reason: "invalid-organization-id" });
  });

  it("refuses an organizationId violating ORGANIZATION_ID_PATTERN (uppercase, leading dash) with reason invalid-organization-id", () => {
    const raw = baseRecord();
    raw.organizationId = "-ORG";
    expect(parse(raw)).toEqual({ ok: false, reason: "invalid-organization-id" });
  });

  it("refuses a missing forge with reason invalid-forge", () => {
    const raw = baseRecord();
    delete raw.forge;
    expect(parse(raw)).toEqual({ ok: false, reason: "invalid-forge" });
  });

  it("refuses forge 'gitlab' with reason invalid-forge", () => {
    const raw = baseRecord();
    raw.forge = "gitlab";
    expect(parse(raw)).toEqual({ ok: false, reason: "invalid-forge" });
  });

  it("refuses a missing repositories field with reason invalid-repositories", () => {
    const raw = baseRecord();
    delete raw.repositories;
    expect(parse(raw)).toEqual({ ok: false, reason: "invalid-repositories" });
  });

  it("refuses a non-array repositories value with reason invalid-repositories", () => {
    const raw = baseRecord();
    raw.repositories = "owner/repo";
    expect(parse(raw)).toEqual({ ok: false, reason: "invalid-repositories" });
  });

  it("refuses a sparse repositories array (an array hole) with reason invalid-repositories", () => {
    const raw = baseRecord();
    const sparse: unknown[] = ["owner/repo", "placeholder"];
    delete sparse[1];
    raw.repositories = sparse;
    expect(parse(raw)).toEqual({ ok: false, reason: "invalid-repositories" });
  });

  it("refuses a repositories array longer than 500 with reason invalid-repositories", () => {
    const repositories: string[] = [];
    for (let i = 0; i <= MAX_FORGE_INSTALLATION_REPOSITORIES; i += 1) {
      repositories.push(`owner-${i}/repo-${i}`);
    }
    const raw = baseRecord();
    raw.repositories = repositories;
    expect(parse(raw)).toEqual({ ok: false, reason: "invalid-repositories" });
  });

  it("refuses a non-string item at repositories[0] with reason invalid-repositories", () => {
    const raw = baseRecord();
    raw.repositories = [42];
    expect(parse(raw)).toEqual({ ok: false, reason: "invalid-repositories" });
  });

  it("refuses a repository slug without an owner/name slash with reason invalid-repositories", () => {
    const raw = baseRecord();
    raw.repositories = ["noslash"];
    expect(parse(raw)).toEqual({ ok: false, reason: "invalid-repositories" });
  });

  it("refuses a repository slug whose owner segment is '.' with reason invalid-repositories", () => {
    const raw = baseRecord();
    raw.repositories = ["./repo"];
    expect(parse(raw)).toEqual({ ok: false, reason: "invalid-repositories" });
  });

  it("refuses a repository slug whose name segment is '..' with reason invalid-repositories", () => {
    const raw = baseRecord();
    raw.repositories = ["owner/.."];
    expect(parse(raw)).toEqual({ ok: false, reason: "invalid-repositories" });
  });

  it("refuses a repository slug containing a control character with reason invalid-repositories", () => {
    const raw = baseRecord();
    raw.repositories = ["ow\u0000ner/repo"];
    expect(parse(raw)).toEqual({ ok: false, reason: "invalid-repositories" });
  });

  it("refuses a duplicate repository entry with reason invalid-repositories", () => {
    const raw = baseRecord();
    raw.repositories = ["owner/repo", "owner/repo"];
    expect(parse(raw)).toEqual({ ok: false, reason: "invalid-repositories" });
  });

  it("refuses a missing installedAtIso with reason invalid-installed-at", () => {
    const raw = baseRecord();
    delete raw.installedAtIso;
    expect(parse(raw)).toEqual({ ok: false, reason: "invalid-installed-at" });
  });

  it("refuses a non-string installedAtIso with reason invalid-installed-at", () => {
    const raw = baseRecord();
    raw.installedAtIso = 1234;
    expect(parse(raw)).toEqual({ ok: false, reason: "invalid-installed-at" });
  });

  it("refuses an installedAtIso longer than 64 characters with reason invalid-installed-at", () => {
    const raw = baseRecord();
    raw.installedAtIso = `2026-01-02T03:04:05.${"9".repeat(60)}Z`;
    expect(parse(raw)).toEqual({ ok: false, reason: "invalid-installed-at" });
  });

  it("refuses a non-calendar installedAtIso (February 31) with reason invalid-installed-at", () => {
    const raw = baseRecord();
    raw.installedAtIso = "2026-02-31T03:04:05Z";
    expect(parse(raw)).toEqual({ ok: false, reason: "invalid-installed-at" });
  });

  it("refuses an unzoned installedAtIso (no offset) with reason invalid-installed-at", () => {
    const raw = baseRecord();
    raw.installedAtIso = "2026-01-02T03:04:05";
    expect(parse(raw)).toEqual({ ok: false, reason: "invalid-installed-at" });
  });

  it("refuses a missing status with reason invalid-status", () => {
    const raw = baseRecord();
    delete raw.status;
    expect(parse(raw)).toEqual({ ok: false, reason: "invalid-status" });
  });

  it("refuses an unknown status 'deleted' with reason invalid-status", () => {
    const raw = baseRecord();
    raw.status = "deleted";
    expect(parse(raw)).toEqual({ ok: false, reason: "invalid-status" });
  });
});
