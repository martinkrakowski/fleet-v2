/**
 * Scaffold tests for @fleet/billing (FC2C). Cost bound: one small
 * package.json read and one module namespace enumeration, O(k + m) over its
 * keys and exports. The manifest is parsed JSON, so it can carry neither a
 * getter nor a Proxy; a null, array or primitive parse and a non-plain
 * dependencies map are refused explicitly rather than read.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const manifestPath = fileURLToPath(new URL("../../package.json", import.meta.url));

function readManifest(): Record<string, unknown> {
  const parsed: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("package.json is not a plain object");
  }
  return parsed as Record<string, unknown>;
}

describe("@fleet/billing scaffold", () => {
  it("package.json declares name @fleet/billing, private true, license MIT and only @fleet/shared among @fleet/* dependencies", () => {
    const manifest = readManifest();
    expect(manifest.name).toBe("@fleet/billing");
    expect(manifest.private).toBe(true);
    expect(manifest.license).toBe("MIT");
    const dependencies = manifest.dependencies;
    if (typeof dependencies !== "object" || dependencies === null || Array.isArray(dependencies)) {
      throw new Error("package.json dependencies is not a plain object");
    }
    const fleetNames = Object.keys(dependencies).filter((name) => name.startsWith("@fleet/"));
    expect(fleetNames).toEqual(["@fleet/shared"]);
  });

  it("src/index.ts exports nothing at runtime", async () => {
    const mod = await import("../index.js");
    expect(Object.keys(mod)).toEqual([]);
  });
});
