// Lane VC25: direct unit tests for isSafeBranchName, the branch-name guard in
// front of every forge push and branch action. No production change; this file
// pins the predicate's accepted and refused inputs, including the cost bound.

import { describe, expect, it } from "vitest";

import { isSafeBranchName } from "../ForgeActionAdapter.adapter.js";

describe("isSafeBranchName", () => {
  it("accepts well-formed branch names", () => {
    expect(isSafeBranchName("main")).toBe(true);
    expect(isSafeBranchName("feature/x-1")).toBe(true);
    expect(isSafeBranchName("a.b_c")).toBe(true);
    expect(isSafeBranchName("release/1.2.3")).toBe(true);
    expect(isSafeBranchName("x")).toBe(true);
    expect(isSafeBranchName("refs/heads/x")).toBe(true);
  });

  it("refuses an empty branch name", () => {
    expect(isSafeBranchName("")).toBe(false);
  });

  it.each([
    "-x",
    "/x",
    " main",
    "a..b",
    "a/",
    "a.",
    "a.lock",
    "a b",
    "a\tb",
    "a~1",
    "a^",
    "a:b",
    "a?b",
    "a*b",
    "a[b",
    "a\\b",
    "@{x}",
    "\u00e9x",
  ])("refuses %j", (name) => {
    expect(isSafeBranchName(name)).toBe(false);
  });

  it("refuses a trailing newline or carriage return", () => {
    expect(isSafeBranchName("main\n")).toBe(false);
    expect(isSafeBranchName("main\r")).toBe(false);
  });

  it("accepts empty or .lock interior path segments under current regex (observed behaviour)", () => {
    // Pinned, not fixed: the regex allows an interior segment that is empty
    // (`a//b`) or named `.lock` (`a.lock/b`); only the ends of the string are
    // guarded by the includes/endsWith checks.
    expect(isSafeBranchName("a//b")).toBe(true);
    expect(isSafeBranchName("a.lock/b")).toBe(true);
  });

  it("stays linear-cost on an enormous branch name", () => {
    // One `includes`, three `endsWith`, and one anchored linear regex
    // (/^[A-Za-z0-9][A-Za-z0-9._/-]*$/ with no backtracking) on 1,000,000
    // characters.
    expect(isSafeBranchName("a".repeat(1_000_000))).toBe(true);
  });
});
