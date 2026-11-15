// Domain tests for `parseLaneDiffCliArgs`, the pure `lane diff-check`
// argument parser. Every hostile input refuses with the typed `usage` result
// and never throws; no usage reason is ever a string taken from the input.

import { describe, expect, it } from "vitest";

import { parseLaneDiffCliArgs } from "../lane-diff-check.js";

const SHA = "a".repeat(40);
const READY = {
  kind: "ready",
  worktreePath: "/wt",
  allowedPathPrefixes: ["packages/x"],
  baseline: { allowance: "trusted", baseCommit: SHA },
} as const;

function ready(argv: unknown): Record<string, unknown> {
  const parsed = parseLaneDiffCliArgs(argv);
  if (parsed.kind !== "ready") throw new Error(`expected ready, got usage`);
  return parsed as unknown as Record<string, unknown>;
}

function expectUsage(argv: unknown): void {
  expect(parseLaneDiffCliArgs(argv)).toEqual({ kind: "usage" });
}

describe("parseLaneDiffCliArgs", () => {
  it("parses a ready invocation with a trusted base", () => {
    expect(
      ready([`${"/wt"}`, "--allowed-path-prefixes", '["packages/x"]', "--base", SHA]),
    ).toEqual(READY);
  });

  it("a forty-character lowercase sha is the only trusted base", () => {
    const parsed = ready(["/wt", "--allowed-path-prefixes", '["p"]', "--base", SHA]);
    expect(parsed.baseline).toEqual({ allowance: "trusted", baseCommit: SHA });
  });

  it("a sixty-four character sha is allowance off", () => {
    const parsed = ready([
      "/wt",
      "--allowed-path-prefixes",
      '["p"]',
      "--base",
      "a".repeat(64),
    ]);
    expect(parsed.baseline).toEqual({ allowance: "off" });
  });

  it("an uppercase hex sha and a ref name are allowance off", () => {
    for (const value of ["A".repeat(40), "HEAD", "origin/main"]) {
      const parsed = ready(["/wt", "--allowed-path-prefixes", '["p"]', "--base", value]);
      expect(parsed.baseline).toEqual({ allowance: "off" });
    }
  });

  it("an absent base is allowance off and omits the policy paths", () => {
    const parsed = ready(["/wt", "--allowed-path-prefixes", '["p"]']);
    expect(parsed.baseline).toEqual({ allowance: "off" });
    expect("policyProtectedPaths" in parsed).toBe(false);
  });

  it("optional policy paths parse as a possibly empty array", () => {
    const parsed = ready([
      "/wt",
      "--allowed-path-prefixes",
      '["p"]',
      "--policy-protected-paths",
      '["deploy"]',
    ]);
    expect(parsed.policyProtectedPaths).toEqual(["deploy"]);
    const empty = ready([
      "/wt",
      "--allowed-path-prefixes",
      '["p"]',
      "--policy-protected-paths",
      "[]",
    ]);
    expect(empty.policyProtectedPaths).toEqual([]);
  });

  it("a null argv refuses with a typed result", () => {
    expectUsage(null);
  });

  it("an undefined argv refuses with a typed result", () => {
    expectUsage(undefined);
  });

  it("a non-iterable value where the argv array is declared refuses with a typed result", () => {
    expectUsage(42);
  });

  it("an array hole refuses with a typed result", () => {
    const holed: string[] = ["a", "b", "c"];
    delete holed[1];
    expectUsage(holed);
  });

  it("a wrong primitive for the worktree refuses with a typed result", () => {
    expectUsage([7, "--allowed-path-prefixes", '["p"]']);
    expectUsage([true, "--allowed-path-prefixes", '["p"]']);
  });

  it("a hostile object whose getter throws refuses with a typed result", () => {
    const hostile = {
      get length(): never {
        throw new Error("hostile getter");
      },
    };
    expectUsage(hostile);
  });

  it("a Proxy whose get trap throws refuses with a typed result", () => {
    const proxy = new Proxy([], {
      get(): never {
        throw new Error("hostile trap");
      },
    });
    expectUsage(proxy);
  });

  it("an array-like object that is not an array refuses with a typed result", () => {
    expectUsage({ 0: "/wt", 1: "--allowed-path-prefixes", length: 2 });
  });

  it("an argv length above 64 refuses before any index is read", () => {
    expectUsage(new Array(65).fill("x"));
    const huge: unknown[] = [];
    Object.defineProperty(huge, "length", { value: 100000 });
    expectUsage(huge);
  });

  it("a prototype-polluting prefix refuses with a typed result", () => {
    for (const bad of ["__proto__", "constructor", "prototype"]) {
      expectUsage(["/wt", "--allowed-path-prefixes", JSON.stringify([bad])]);
    }
  });

  it("a JSON object that carries __proto__ refuses with a typed result", () => {
    expectUsage(["/wt", "--allowed-path-prefixes", '{"__proto__": ["p"]}']);
  });

  it("a null element inside the prefix array refuses with a typed result", () => {
    expectUsage(["/wt", "--allowed-path-prefixes", "[null]"]);
  });

  it("an empty prefix array, invalid JSON, a non-array, and a non-string element refuse", () => {
    expectUsage(["/wt", "--allowed-path-prefixes", "[]"]);
    expectUsage(["/wt", "--allowed-path-prefixes", "not json"]);
    expectUsage(["/wt", "--allowed-path-prefixes", '{"a":1}']);
    expectUsage(["/wt", "--allowed-path-prefixes", '["p", 5]']);
  });

  it("a prefix validateAllowedPathPrefix rejects refuses with a typed result", () => {
    expectUsage(["/wt", "--allowed-path-prefixes", '["/abs"]']);
    expectUsage(["/wt", "--allowed-path-prefixes", '["../up"]']);
    expectUsage(["/wt", "--allowed-path-prefixes", '[".lane"]']);
    expectUsage(["/wt", "--allowed-path-prefixes", '[""]']);
  });

  it("a prefix longer than 200 characters or more than 32 prefixes refuse", () => {
    expectUsage(["/wt", "--allowed-path-prefixes", JSON.stringify(["a".repeat(201)])]);
    expectUsage([
      "/wt",
      "--allowed-path-prefixes",
      JSON.stringify(Array.from({ length: 33 }, (_, i) => `p${i}`)),
    ]);
  });

  it("a worktree that is empty, too long, or carries a newline or NUL refuses", () => {
    expectUsage(["", "--allowed-path-prefixes", '["p"]']);
    expectUsage(["/".repeat(4097), "--allowed-path-prefixes", '["p"]']);
    expectUsage(["/a\nb", "--allowed-path-prefixes", '["p"]']);
    expectUsage(["/a\u0000b", "--allowed-path-prefixes", '["p"]']);
  });

  it("an unknown flag, a second positional, zero positionals, and a repeated base refuse", () => {
    expectUsage(["/wt", "--allowed-path-prefixes", '["p"]', "--other"]);
    expectUsage(["/wt", "/wt2", "--allowed-path-prefixes", '["p"]']);
    expectUsage(["--allowed-path-prefixes", '["p"]']);
    expectUsage(["/wt", "--allowed-path-prefixes", '["p"]', "--base", SHA, "--base", SHA]);
  });

  it("a flag with no value, an empty value, or a missing flag value refuses", () => {
    expectUsage(["/wt", "--allowed-path-prefixes"]);
    expectUsage(["/wt", "--allowed-path-prefixes", ""]);
    expectUsage(["/wt", "--allowed-path-prefixes", '["p"]', "--base"]);
    expectUsage(["/wt", "--allowed-path-prefixes", '["p"]', "--base", ""]);
  });

  it("a second allowed-path-prefixes flag refuses", () => {
    expectUsage(["/wt", "--allowed-path-prefixes", '["p"]', "--allowed-path-prefixes", '["q"]']);
  });

  it("the parser never throws a named error", () => {
    // Every hostile input above returns the same typed object; one sweep of
    // assorted garbage must all land on `usage`.
    for (const argv of [NaN, {}, [], () => {}, Symbol("x"), ["--base"], [{}]]) {
      expect(parseLaneDiffCliArgs(argv)).toEqual({ kind: "usage" });
    }
  });
});
