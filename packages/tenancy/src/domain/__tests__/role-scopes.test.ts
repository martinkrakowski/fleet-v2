/**
 * FC6B tests: the pure hosted-session role-to-scope table.
 *
 * Every test title states what the test asserts and every body proves it:
 * the literal per-role expectations fail a constant implementation, the
 * refusal cases fail an identity implementation, and the drift guard fails
 * (never skips) whenever the frozen API scope lists drift from the domain
 * table.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { ROLES } from "../value-objects/Role.vo.js";
import {
  HOSTED_SCOPES,
  extractScopeList,
  scopesForRole,
} from "../role-scopes.js";

/** Set equality without order: scope lists are sets of grants. */
const sameScopes = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && [...a].sort().join(",") === [...b].sort().join(",");

describe("scopesForRole", () => {
  it("grants exactly read and tail to the viewer role", () => {
    expect(sameScopes(scopesForRole("viewer"), ["read", "tail"])).toBe(true);
  });

  it("grants read, tail, message and verdict to the maintainer role", () => {
    expect(
      sameScopes(scopesForRole("maintainer"), [
        "read",
        "tail",
        "message",
        "verdict",
      ]),
    ).toBe(true);
  });

  it("grants read, tail, message, verdict and operate — but not hook or orchestrate — to the owner role", () => {
    const scopes = scopesForRole("owner");
    expect(sameScopes(scopes, ["read", "tail", "message", "verdict", "operate"])).toBe(
      true,
    );
    expect(scopes).not.toContain("hook");
    expect(scopes).not.toContain("orchestrate");
  });

  it("returns a non-empty scope list drawn from HOSTED_SCOPES for every declared role, never hook or orchestrate", () => {
    for (const role of ROLES) {
      const scopes = scopesForRole(role);
      expect(scopes.length).toBeGreaterThan(0);
      for (const scope of scopes) {
        expect(HOSTED_SCOPES).toContain(scope);
      }
      expect(scopes).not.toContain("orchestrate");
      expect(scopes).not.toContain("hook");
    }
  });

  it("contains the role scope lists as a strict subset chain viewer < maintainer < owner with sizes 2 < 4 < 5", () => {
    const viewer = scopesForRole("viewer");
    const maintainer = scopesForRole("maintainer");
    const owner = scopesForRole("owner");
    expect(viewer.length).toBe(2);
    expect(maintainer.length).toBe(4);
    expect(owner.length).toBe(5);
    for (const scope of viewer) {
      expect(maintainer).toContain(scope);
    }
    for (const scope of maintainer) {
      expect(owner).toContain(scope);
    }
  });

  it("returns an empty frozen array for unknown role strings", () => {
    for (const role of ["admin", "", "OWNER", "  ", "viewer "]) {
      const scopes = scopesForRole(role);
      expect(scopes).toEqual([]);
      expect(Object.isFrozen(scopes)).toBe(true);
    }
  });

  it("returns an empty frozen array for null and undefined", () => {
    for (const role of [null, undefined]) {
      const scopes = scopesForRole(role);
      expect(scopes).toEqual([]);
      expect(Object.isFrozen(scopes)).toBe(true);
    }
  });

  it("returns an empty frozen array for non-string primitives", () => {
    for (const role of [42, true, false, BigInt(1), Symbol("viewer")]) {
      const scopes = scopesForRole(role);
      expect(scopes).toEqual([]);
      expect(Object.isFrozen(scopes)).toBe(true);
    }
  });

  it("refuses prototype-polluting keys with an empty frozen array", () => {
    for (const role of [
      "__proto__",
      "constructor",
      "prototype",
      "toString",
      "valueOf",
    ]) {
      const scopes = scopesForRole(role);
      expect(scopes).toEqual([]);
      expect(Object.isFrozen(scopes)).toBe(true);
    }
  });

  it("refuses objects with throwing getters or coercion traps without invoking them", () => {
    const throwingGetter = {
      get toString(): string {
        throw new Error("boom");
      },
    };
    const coercionTrap = {
      [Symbol.toPrimitive](): string {
        throw new Error("boom");
      },
    };
    for (const role of [throwingGetter, coercionTrap]) {
      const scopes = scopesForRole(role);
      expect(scopes).toEqual([]);
      expect(Object.isFrozen(scopes)).toBe(true);
    }
  });

  it("refuses Proxy inputs without triggering traps", () => {
    const role = new Proxy(
      {},
      {
        get() {
          throw new Error("boom");
        },
      },
    );
    const scopes = scopesForRole(role);
    expect(scopes).toEqual([]);
    expect(Object.isFrozen(scopes)).toBe(true);
  });

  it("refuses arrays, array holes, array-likes with enormous length, and non-iterables in O(1) without reading length", () => {
    const enormous = { length: 1e9, 0: "owner" };
    for (const role of [[undefined], new Array(1), enormous, {}]) {
      const scopes = scopesForRole(role);
      expect(scopes).toEqual([]);
      expect(Object.isFrozen(scopes)).toBe(true);
    }
  });

  it("returns a fresh frozen array on every call so mutating one result never affects another", () => {
    const first = scopesForRole("maintainer") as unknown as string[];
    const second = scopesForRole("maintainer");
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(second)).toBe(true);
    expect(() => {
      first.push("operate");
    }).toThrow();
    expect(() => {
      (first as unknown as Record<string, string>)["0"] = "operate";
    }).toThrow();
    expect(second).not.toBe(first);
    expect(second.length).toBe(4);
  });
});

describe("extractScopeList", () => {
  /** Built at runtime; the declaration never appears as a hostile literal. */
  const SCOPE_TEXT = [
    'export const',
    " FROZEN_SCOPES = [",
    '"read",',
    '"message",',
    '"tail"',
    "] as const;",
  ].join("");

  it("extracts the quoted string elements of a well-formed scope list declaration", () => {
    const result = extractScopeList(SCOPE_TEXT, "FROZEN_SCOPES");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(sameScopes(result.scopes, ["read", "message", "tail"])).toBe(true);
    expect(Object.isFrozen(result.scopes)).toBe(true);
  });

  it("accepts a single trailing comma, as TypeScript style allows", () => {
    const result = extractScopeList(
      'export const FROZEN_SCOPES = ["read", "tail",];',
      "FROZEN_SCOPES",
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(sameScopes(result.scopes, ["read", "tail"])).toBe(true);
  });

  it("returns a typed refusal when source text cannot be parsed", () => {
    for (const text of [
      "",
      "const OTHER = [];",
      'export const FROZEN_SCOPES = [123];',
      'export const FROZEN_SCOPES = ["',
      'export const FROZEN_SCOPES = [];',
      // Missing separator between elements.
      'export const FROZEN_SCOPES = ["read" "tail"];',
      // A hole between elements.
      'export const FROZEN_SCOPES = ["read",, "tail"];',
      // A bare-word element after a valid first element.
      'export const FROZEN_SCOPES = ["read", tail];',
    ]) {
      const result = extractScopeList(text, "FROZEN_SCOPES");
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.reason).toBe("could not parse scope list");
    }
  });

  it("returns a typed refusal when the scope list name is empty, oversized, or not an identifier", () => {
    for (const name of ["", "a".repeat(129), "1abc", "has space", "has-dash"]) {
      const result = extractScopeList(SCOPE_TEXT, name);
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.reason).toBe("invalid scope list name");
    }
  });

  it("refuses a valid-identifier name only because the declaration is absent", () => {
    for (const name of ["__proto__", "constructor", "toString"]) {
      const result = extractScopeList(SCOPE_TEXT, name);
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.reason).toBe("could not parse scope list");
    }
  });

  it("refuses non-string, oversized, and adversarial inputs with a typed reason without throwing or invoking traps", () => {
    const throwingGetter = {
      get toString(): string {
        throw new Error("boom");
      },
    };
    const trap = new Proxy(
      {},
      {
        get() {
          throw new Error("boom");
        },
      },
    );
    const cases: ReadonlyArray<[unknown, unknown, string]> = [
      // Non-string text, including the remaining wrong primitives.
      [null, "FROZEN_SCOPES", "invalid input"],
      [undefined, "FROZEN_SCOPES", "invalid input"],
      [42, "FROZEN_SCOPES", "invalid input"],
      [true, "FROZEN_SCOPES", "invalid input"],
      [BigInt(1), "FROZEN_SCOPES", "invalid input"],
      [Symbol("read"), "FROZEN_SCOPES", "invalid input"],
      // Arrays, array holes and array-likes are non-strings too: refused in
      // O(1) without reading `.length` or iterating.
      [["read"], "FROZEN_SCOPES", "invalid input"],
      [new Array(1), "FROZEN_SCOPES", "invalid input"],
      [{ length: 1e9 }, "FROZEN_SCOPES", "invalid input"],
      // Non-string name, including the remaining wrong primitives.
      [SCOPE_TEXT, null, "invalid input"],
      [SCOPE_TEXT, undefined, "invalid input"],
      [SCOPE_TEXT, 42, "invalid input"],
      [SCOPE_TEXT, true, "invalid input"],
      [SCOPE_TEXT, BigInt(1), "invalid input"],
      [SCOPE_TEXT, Symbol("FROZEN_SCOPES"), "invalid input"],
      [SCOPE_TEXT, ["FROZEN_SCOPES"], "invalid input"],
      [SCOPE_TEXT, new Array(1), "invalid input"],
      [SCOPE_TEXT, { length: 1e9, 0: "FROZEN_SCOPES" }, "invalid input"],
      // Getters and Proxies: the typeof check short-circuits, so no trap or
      // getter is ever invoked and nothing throws.
      [throwingGetter, "FROZEN_SCOPES", "invalid input"],
      [trap, "FROZEN_SCOPES", "invalid input"],
      [SCOPE_TEXT, throwingGetter, "invalid input"],
      [SCOPE_TEXT, trap, "invalid input"],
      // Size bound and identifier bound, with their specific reasons.
      ["x".repeat(1_000_001), "FROZEN_SCOPES", "source text exceeds size bound"],
      [SCOPE_TEXT, "", "invalid scope list name"],
      [SCOPE_TEXT, "a".repeat(129), "invalid scope list name"],
      [SCOPE_TEXT, "1abc", "invalid scope list name"],
    ];
    for (const [text, name, reason] of cases) {
      const result = extractScopeList(text, name);
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.reason).toBe(reason);
    }
  });
});

describe("drift guard", () => {
  /**
   * Resolve the repo root by walking up from this file's directory until
   * the two frozen scope sources exist (never `process.cwd()`). Bounded to
   * 10 steps; the drift guard fails when the files cannot be found.
   */
  const repoRoot = (() => {
    let dir = join(fileURLToPath(import.meta.url), "..");
    for (let step = 0; step < 10; step += 1) {
      try {
        readFileSync(
          join(dir, "apps/api/server/wiring/route-scopes.ts"),
          "utf8",
        );
        return dir;
      } catch {
        const parent = join(dir, "..");
        if (parent === dir) break;
        dir = parent;
      }
    }
    return dir;
  })();
  const readSource = (relativePath: string): string => {
    try {
      return readFileSync(join(repoRoot, relativePath), "utf8");
    } catch (error) {
      throw new Error(
        `drift guard could not read ${relativePath}: ${String(error)}`,
      );
    }
  };

  it("HOSTED_SCOPES matches FROZEN_SCOPES and MINTABLE_SESSION_SCOPES plus orchestrate", () => {
    const routeScopesText = readSource(
      "apps/api/server/wiring/route-scopes.ts",
    );
    const sessionExchangeText = readSource(
      "apps/api/server/wiring/session-exchange.ts",
    );
    const frozen = extractScopeList(routeScopesText, "FROZEN_SCOPES");
    const mintable = extractScopeList(sessionExchangeText, "MINTABLE_SESSION_SCOPES");
    expect(frozen.ok).toBe(true);
    expect(mintable.ok).toBe(true);
    if (!frozen.ok || !mintable.ok) return;
    expect(
      sameScopes(HOSTED_SCOPES, frozen.scopes),
    ).toBe(true);
    expect(
      sameScopes(HOSTED_SCOPES, [...mintable.scopes, "orchestrate"]),
    ).toBe(true);
  });
});
