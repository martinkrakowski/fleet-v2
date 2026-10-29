import { describe, expect, it } from "vitest";

import {
  parseStopReason,
  SEAT_TRIGGER_CLASSES,
  StopReason,
  STOP_REASONS,
} from "../value-objects/StopReason.vo.js";

describe("parseStopReason", () => {
  it.each(STOP_REASONS.map((value) => [value, value]))(
    "returns the declared class %j unchanged",
    (value, expected) => {
      expect(parseStopReason(value)).toBe(expected);
    },
  );

  it.each([
    ["undefined", undefined],
    ["null", null],
    ["empty string", ""],
    ["wrong case", "Rate-Limited"],
    ["number", 42],
    ["object", {}],
  ])("reads undeclared input %s as unknown", (_label, value) => {
    expect(parseStopReason(value)).toBe("unknown");
  });
});

describe("SEAT_TRIGGER_CLASSES", () => {
  it("contains neither none nor unknown and has 10 entries", () => {
    expect(SEAT_TRIGGER_CLASSES).not.toContain("none");
    expect(SEAT_TRIGGER_CLASSES).not.toContain("unknown");
    expect(SEAT_TRIGGER_CLASSES).toHaveLength(10);
  });
});

describe("StopReason", () => {
  it("accepts a declared class", () => {
    expect(StopReason.create("timeout").success).toBe(true);
  });

  it("refuses an undeclared class", () => {
    expect(StopReason.create("later").success).toBe(false);
  });
});
