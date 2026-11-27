/**
 * Scaffold tests for @fleet/cloud-runtime (FC2D). Cost bound: one small
 * package.json read and one module namespace enumeration; the manifest is read
 * once through snapshotPlainData, O(own keys) bounded by package.json size and
 * DEFAULT_PLAIN_DATA_LIMITS, and the module check is one enumeration of the
 * exports.
 */
import { readFileSync } from "node:fs";
import { isProxy } from "node:util/types";
import { fileURLToPath } from "node:url";

import { snapshotPlainData } from "@fleet/shared";
import { describe, expect, it } from "vitest";

const manifestPath = fileURLToPath(new URL("../../package.json", import.meta.url));

const PROTOTYPE_POLLUTING_KEYS = ["__proto__", "constructor", "prototype"];

function readManifest(): Record<string, unknown> {
  const snapshot = snapshotPlainData(JSON.parse(readFileSync(manifestPath, "utf8")), isProxy);
  if (!snapshot.ok) {
    throw new Error(`package.json refused: ${snapshot.reason} at ${snapshot.path ?? "<root>"}`);
  }
  const value = snapshot.value;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("package.json is not a plain object");
  }
  return value as Record<string, unknown>;
}

describe("@fleet/cloud-runtime scaffold", () => {
  it("package.json declares name @fleet/cloud-runtime, private true, license MIT and exactly @fleet/shared and @fleet/work-execution among @fleet/* dependencies", () => {
    const manifest = readManifest();
    expect(manifest.name).toBe("@fleet/cloud-runtime");
    expect(manifest.private).toBe(true);
    expect(manifest.license).toBe("MIT");
    const dependencies = manifest.dependencies;
    if (typeof dependencies !== "object" || dependencies === null || Array.isArray(dependencies)) {
      throw new Error("package.json dependencies is not a plain object");
    }
    const fleetNames = Object.keys(dependencies)
      .filter((name) => name.startsWith("@fleet/"))
      .sort();
    expect(fleetNames).toEqual(["@fleet/shared", "@fleet/work-execution"]);
  });

  it("package.json has no own prototype-polluting key at the top level or in dependencies", () => {
    const manifest = readManifest();
    const dependencies = manifest.dependencies as Record<string, unknown>;
    for (const key of PROTOTYPE_POLLUTING_KEYS) {
      expect(Object.hasOwn(manifest, key)).toBe(false);
      expect(Object.hasOwn(dependencies, key)).toBe(false);
    }
  });

  it("snapshotPlainData refuses a Proxy and an accessor, the hostile shapes the manifest read relies on it to refuse", () => {
    const hostile = new Proxy({}, {});
    expect(snapshotPlainData(hostile, isProxy).ok).toBe(false);
    const withGetter = Object.defineProperty({}, "name", { enumerable: true, get: () => "x" });
    expect(snapshotPlainData(withGetter, isProxy).ok).toBe(false);
  });

  it("the built entrypoint exports no runtime symbols, so the scaffold imports cleanly but grants nothing", async () => {
    const mod = await import("../index.js");
    expect(Object.keys(mod)).toEqual([]);
  });

  it("the domain barrel exports exactly decideMigrationRun, checksumOfMigration, MIGRATION_ID_PATTERN, MAX_MIGRATIONS and MAX_SQL_LENGTH", async () => {
    const mod = await import("../domain/index.js");
    expect(Object.keys(mod).sort()).toEqual(
      [
        "checksumOfMigration",
        "decideMigrationRun",
        "MIGRATION_ID_PATTERN",
        "MAX_MIGRATIONS",
        "MAX_SQL_LENGTH",
      ].sort(),
    );
  });
});
