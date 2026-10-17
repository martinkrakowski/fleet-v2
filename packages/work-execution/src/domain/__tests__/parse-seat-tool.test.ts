// parseSeatTool table (H8): only the declared kinds are accepted; a blank,
// unknown, wrong-case or non-string value is `undefined`, never a default.
import { describe, expect, it } from "vitest";

import { parseSeatTool } from "../execution-records.js";

describe("parseSeatTool", () => {
  it.each([
    ["opencode", "opencode"],
    ["agy", "agy"],
  ])("accepts the declared kind %j", (value, expected) => {
    expect(parseSeatTool(value)).toBe(expected);
  });

  it.each([
    ["blank string", ""],
    ["whitespace only", "   "],
    ["unknown kind", "claude"],
    ["wrong case", "OpenCode"],
    ["wrong case agy", "AGY"],
    ["padded declared kind", " opencode"],
    ["null", null],
    ["undefined", undefined],
    ["number", 1],
    ["object", { kind: "opencode" }],
  ])("refuses %s", (_label, value) => {
    expect(parseSeatTool(value)).toBeUndefined();
  });
});
