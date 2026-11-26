/**
 * Scaffold tests for @fleet/tenancy (FC2B).
 *
 * Cost bounds: the manifest test reads one small package.json once (O(k) over
 * its keys) and filters its dependency names (O(d), d = dependency count); the
 * runtime-exports test imports one module namespace object and enumerates its
 * keys once (O(m), m = export count). Both are constant-sized for this
 * scaffold package.
 *
 * Hostile-input posture: the manifest content is untrusted file content. The
 * test refuses non-object parses (null, arrays, primitives) explicitly and
 * reads `dependencies` only through a plain-object check, so a malformed
 * manifest is a failed assertion, never a pass. No getter or Proxy can reach
 * these assertions because JSON.parse cannot produce either.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// Two levels up (src/__tests__/ or dist/__tests__/) is the package root.
const PACKAGE_ROOT = fileURLToPath(new URL("../../", import.meta.url));

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function fleetDependencyNames(pkg: Record<string, unknown>): string[] {
  const dependencies = pkg.dependencies;
  if (!isPlainObject(dependencies)) {
    throw new Error("package.json dependencies is not a plain object");
  }
  return Object.keys(dependencies).filter((name) =>
    name.startsWith("@fleet/"),
  );
}

describe("@fleet/tenancy scaffold", () => {
  it(
    "@fleet/tenancy package.json declares name @fleet/tenancy, private true, and only @fleet/shared among @fleet/* dependencies",
    () => {
      const parsed: unknown = JSON.parse(
        readFileSync(`${PACKAGE_ROOT}package.json`, "utf8"),
      );
      // Refuse a null, array or primitive manifest before reading fields.
      if (!isPlainObject(parsed)) {
        throw new Error(
          `package.json parsed to ${parsed === null ? "null" : typeof parsed}, not an object`,
        );
      }
      expect(parsed.name).toBe("@fleet/tenancy");
      expect(parsed.private).toBe(true);
      expect(fleetDependencyNames(parsed)).toEqual(["@fleet/shared"]);
    },
  );

  it("@fleet/tenancy src/index.ts exports nothing at runtime", async () => {
    const mod = await import("../index.js");
    expect(Object.keys(mod)).toEqual([]);
  });
});
