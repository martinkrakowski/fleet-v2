import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { types } from "node:util";
import {
  validateHostedForgeConfig,
  type HostedForgeValidationResult,
} from "../hosted-forge-config.js";

function jsonOf(result: HostedForgeValidationResult): string {
  return JSON.stringify(result);
}

describe("validateHostedForgeConfig", () => {
  it("accepts a minimal github-app config and returns a frozen config object", () => {
    const result = validateHostedForgeConfig({ kind: "github-app", installationId: "12345" });
    expect(result).toEqual({
      ok: true,
      config: { kind: "github-app", installationId: "12345" },
    });
    expect(Object.isFrozen((result as { config: object }).config)).toBe(true);
  });

  it("accepts a full github-app config and returns a frozen config object", () => {
    const result = validateHostedForgeConfig({
      kind: "github-app",
      installationId: "12345",
      appId: "678",
      owner: "acme-org",
      apiBaseUrl: "https://api.github.com",
    });
    expect(result).toEqual({
      ok: true,
      config: {
        kind: "github-app",
        installationId: "12345",
        appId: "678",
        owner: "acme-org",
        apiBaseUrl: "https://api.github.com",
      },
    });
    expect(Object.isFrozen((result as { config: object }).config)).toBe(true);
  });

  it("refuses personal-token kind with personal-credential-refused and field kind", () => {
    const result = validateHostedForgeConfig({
      kind: "personal-token",
      installationId: "12345",
    });
    expect(result).toEqual({ ok: false, reason: "personal-credential-refused", field: "kind" });
  });

  it("refuses missing or unsupported forge kind with unsupported-forge-kind and field kind", () => {
    for (const kind of ["oauth", "ssh", "", 123, null]) {
      const result = validateHostedForgeConfig({ kind, installationId: "12345" });
      expect(result).toEqual({ ok: false, reason: "unsupported-forge-kind", field: "kind" });
    }
    expect(validateHostedForgeConfig({ installationId: "12345" })).toEqual({
      ok: false,
      reason: "unsupported-forge-kind",
      field: "kind",
    });
  });

  it("refuses top-level and nested credential-named keys case-insensitively without echoing key or value", () => {
    const inputs: unknown[] = [
      { kind: "github-app", installationId: "1", apiToken: "x" },
      { kind: "github-app", installationId: "1", PAT: "x" },
      { kind: "github-app", installationId: "1", clientSecret: "x" },
      { kind: "github-app", installationId: "1", nested: { dbPassword: "x" } },
      { kind: "github-app", installationId: "1", items: [{ auth_token: "x" }] },
    ];
    for (const input of inputs) {
      const result = validateHostedForgeConfig(input);
      expect(result).toEqual({ ok: false, reason: "personal-credential-refused" });
      const text = jsonOf(result);
      expect(text).not.toContain("x");
      expect(text).not.toMatch(/token|pat|password|secret/i);
    }
  });

  it("refuses arrays, nested sparse arrays, and inherited keys with invalid-forge-config", () => {
    expect(validateHostedForgeConfig([])).toEqual({ ok: false, reason: "invalid-forge-config" });
    const holey: unknown[] = new Array(1);
    const sparseParent = { kind: "github-app", installationId: "1", items: holey };
    expect(validateHostedForgeConfig(sparseParent)).toEqual({
      ok: false,
      reason: "invalid-forge-config",
    });
    expect(
      validateHostedForgeConfig(Object.create({ token: "x", kind: "github-app", installationId: "1" })),
    ).toEqual({ ok: false, reason: "invalid-forge-config" });
    const proto = { kind: "github-app", installationId: "1" };
    expect(validateHostedForgeConfig(Object.create(proto))).toEqual({
      ok: false,
      reason: "invalid-forge-config",
    });
  });

  it("refuses Proxy inputs via injected isProxy detector without running traps", () => {
    const target = { kind: "github-app", installationId: "12345" };
    const proxied = new Proxy(target, {});
    expect(validateHostedForgeConfig(proxied, types.isProxy)).toEqual({
      ok: false,
      reason: "invalid-forge-config",
    });
    let trapRan = false;
    const throwing = new Proxy(target, {
      get(): unknown {
        trapRan = true;
        throw new Error("trap");
      },
      ownKeys(): string[] {
        trapRan = true;
        throw new Error("trap");
      },
    });
    expect(() => validateHostedForgeConfig(throwing, types.isProxy)).not.toThrow();
    expect(validateHostedForgeConfig(throwing, types.isProxy)).toEqual({
      ok: false,
      reason: "invalid-forge-config",
    });
    expect(trapRan).toBe(false);
  });

  it("refuses non-function isProxy detector with proxy-detector-required", () => {
    const result = validateHostedForgeConfig(
      { kind: "github-app", installationId: "12345" },
      "not-a-function" as unknown as () => boolean,
    );
    expect(result).toEqual({ ok: false, reason: "proxy-detector-required" });
  });

  it("refuses null, undefined, and non-object primitives without throwing", () => {
    for (const input of [null, undefined, 42, true, "github-app", Symbol("s"), 10n]) {
      expect(validateHostedForgeConfig(input as unknown)).toEqual({
        ok: false,
        reason: "invalid-forge-config",
      });
    }
  });

  it("refuses getter properties without invoking them", () => {
    let getterRan = false;
    const input = {
      kind: "github-app",
      installationId: "12345",
      get extra(): string {
        getterRan = true;
        return "x";
      },
    };
    expect(() => validateHostedForgeConfig(input)).not.toThrow();
    expect(validateHostedForgeConfig(input)).toEqual({ ok: false, reason: "invalid-forge-config" });
    expect(getterRan).toBe(false);
  });

  it("refuses plain-object array-likes with unsupported-forge-kind or unknown-key", () => {
    expect(validateHostedForgeConfig({ length: 1000000000 })).toEqual({
      ok: false,
      reason: "unsupported-forge-kind",
      field: "kind",
    });
    expect(
      validateHostedForgeConfig({ kind: "github-app", installationId: "12345", length: 1000000000 }),
    ).toEqual({ ok: false, reason: "unknown-key" });
  });

  it("refuses oversized strings, cycles, symbol keys, non-enumerable keys, and over-limit objects", () => {
    const long = "a".repeat(5000);
    expect(
      validateHostedForgeConfig({ kind: "github-app", installationId: "1", owner: long }),
    ).toEqual({ ok: false, reason: "invalid-forge-config", field: "owner" });
    const cycle: Record<string, unknown> = { kind: "github-app", installationId: "1" };
    cycle.self = cycle;
    expect(validateHostedForgeConfig(cycle)).toEqual({ ok: false, reason: "invalid-forge-config" });
    const sym = Symbol("k");
    expect(
      validateHostedForgeConfig({ kind: "github-app", installationId: "1", [sym]: "x" }),
    ).toEqual({ ok: false, reason: "invalid-forge-config" });
    const nonEnum = { kind: "github-app", installationId: "1" };
    Object.defineProperty(nonEnum, "hidden", { value: "x", enumerable: false });
    expect(validateHostedForgeConfig(nonEnum)).toEqual({ ok: false, reason: "invalid-forge-config" });
    const tooManyKeys: Record<string, unknown> = { kind: "github-app", installationId: "1" };
    for (let i = 0; i < 40; i += 1) {
      tooManyKeys[`extra${i}`] = i;
    }
    expect(validateHostedForgeConfig(tooManyKeys)).toEqual({ ok: false, reason: "invalid-forge-config" });
  });

  it("refuses prototype-polluting keys at root and nested levels with forbidden-key", () => {
    for (const key of ["__proto__", "constructor", "prototype"]) {
      const root: Record<string, unknown> = { kind: "github-app", installationId: "1" };
      Object.defineProperty(root, key, { value: "x", enumerable: true, writable: true, configurable: true });
      expect(validateHostedForgeConfig(root)).toEqual({ ok: false, reason: "forbidden-key" });
      const nested = { kind: "github-app", installationId: "1", nested: { [key]: "x" } };
      expect(validateHostedForgeConfig(nested)).toEqual({ ok: false, reason: "forbidden-key" });
    }
  });

  it("refuses invalid installationId and invalid optional github-app fields", () => {
    expect(validateHostedForgeConfig({ kind: "github-app" })).toEqual({
      ok: false,
      reason: "invalid-forge-config",
      field: "installationId",
    });
    expect(validateHostedForgeConfig({ kind: "github-app", installationId: "" })).toEqual({
      ok: false,
      reason: "invalid-forge-config",
      field: "installationId",
    });
    expect(validateHostedForgeConfig({ kind: "github-app", installationId: "a b" })).toEqual({
      ok: false,
      reason: "invalid-forge-config",
      field: "installationId",
    });
    expect(
      validateHostedForgeConfig({ kind: "github-app", installationId: "1", appId: "bad id" }),
    ).toEqual({ ok: false, reason: "invalid-forge-config", field: "appId" });
    expect(
      validateHostedForgeConfig({ kind: "github-app", installationId: "1", owner: "-bad-" }),
    ).toEqual({ ok: false, reason: "invalid-forge-config", field: "owner" });
    expect(
      validateHostedForgeConfig({ kind: "github-app", installationId: "1", owner: "a".repeat(40) }),
    ).toEqual({ ok: false, reason: "invalid-forge-config", field: "owner" });
    expect(
      validateHostedForgeConfig({ kind: "github-app", installationId: "1", apiBaseUrl: "http://x" }),
    ).toEqual({ ok: false, reason: "invalid-forge-config", field: "apiBaseUrl" });
    expect(
      validateHostedForgeConfig({
        kind: "github-app",
        installationId: "1",
        apiBaseUrl: "https://user:pass@host",
      }),
    ).toEqual({ ok: false, reason: "invalid-forge-config", field: "apiBaseUrl" });
  });

  it("refuses unknown top-level keys without echoing key name or value", () => {
    const result = validateHostedForgeConfig({
      kind: "github-app",
      installationId: "12345",
      sneakyExtra: "value",
    });
    expect(result).toEqual({ ok: false, reason: "unknown-key" });
    const text = jsonOf(result);
    expect(text).not.toContain("sneakyExtra");
    expect(text).not.toContain("value");
  });
});

describe("hosted-forge-config import boundary", () => {
  it("does not import @fleet/installation, packages/installation paths, or node: builtins", () => {
    const source = readFileSync(
      new URL("../hosted-forge-config.ts", import.meta.url),
      "utf8",
    );
    expect(source).not.toMatch(/@fleet\/installation/);
    expect(source).not.toMatch(/packages\/installation/);
    expect(source).not.toMatch(/node:/);
  });
});
