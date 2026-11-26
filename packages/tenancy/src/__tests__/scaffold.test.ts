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
 * manifest is a failed assertion, never a pass. A dependencies map carrying a
 * prototype-polluting own key (`__proto__`, `constructor` or `prototype`) is
 * refused with a named error, never silently filtered away. No getter or
 * Proxy can reach these assertions because JSON.parse cannot produce either.
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

// An own key with one of these names in a parsed dependencies map is a
// prototype-polluting shape, so the scan refuses the whole map with a named
// error instead of filtering the key away and passing. The set is
// constant-sized, so the check costs one O(k) pass over the k own keys with
// a constant-time membership test per key.
const PROTOTYPE_POLLUTING_KEYS: ReadonlySet<string> = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

function fleetDependencyNames(pkg: Record<string, unknown>): string[] {
  const dependencies = pkg.dependencies;
  if (!isPlainObject(dependencies)) {
    throw new Error("package.json dependencies is not a plain object");
  }
  const names = Object.keys(dependencies);
  for (const name of names) {
    if (PROTOTYPE_POLLUTING_KEYS.has(name)) {
      throw new Error(
        `package.json dependencies contains the prototype-polluting key ${name}`,
      );
    }
  }
  return names.filter((name) => name.startsWith("@fleet/"));
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

  it(
    "the dependency scan refuses a dependencies map with an own prototype-polluting key (__proto__, constructor, prototype) as a named error instead of filtering the key away",
    () => {
      // Built at runtime: JSON.parse defines a real own data property for
      // each hostile key, the shape a hostile manifest would carry.
      for (const hostileKey of ["__proto__", "constructor", "prototype"]) {
        const hostile = JSON.parse(
          `{"${hostileKey}": {"polluted": true}, "@fleet/shared": "workspace:*"}`,
        ) as Record<string, unknown>;
        expect(() =>
          fleetDependencyNames({ dependencies: hostile }),
        ).toThrowError(
          new RegExp(
            `dependencies contains the prototype-polluting key ${hostileKey}`,
          ),
        );
      }
    },
  );

  it("@fleet/tenancy src/index.ts exports nothing at runtime", async () => {
    const mod = await import("../index.js");
    expect(Object.keys(mod)).toEqual([]);
  });
});
