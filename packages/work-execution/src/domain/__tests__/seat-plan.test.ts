import { describe, expect, it } from "vitest";

import { SeatPlan } from "../value-objects/SeatPlan.vo.js";

function seat(id: string, model: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, model, tool: "opencode", ...extra };
}

const validRaw = {
  version: 1,
  "first-pass": [seat("a1", "alpha-1"), seat("a2", "alpha-2")],
  fix: [seat("b1", "beta-1"), seat("b2", "beta-2")],
  review: [seat("r1", "rho-1")],
};

describe("SeatPlan.create", () => {
  it("round-trips a valid plan", () => {
    const plan = SeatPlan.create(validRaw).value!;
    expect(plan.toJSON()).toEqual(validRaw);
  });

  it("trims id and model values", () => {
    const plan = SeatPlan.create({
      version: 1,
      "first-pass": [seat(" m1 ", " m1 ")],
      fix: [seat("f1", "fix-1")],
    }).value!;
    expect(plan.toJSON()["first-pass"][0].id).toBe("m1");
    expect(plan.toJSON()["first-pass"][0].model).toBe("m1");
  });

  it("reads an absent review list as empty", () => {
    const plan = SeatPlan.create({
      version: 1,
      "first-pass": [seat("a1", "alpha-1")],
      fix: [seat("b1", "beta-1")],
    }).value!;
    expect(plan.getSeats("review")).toEqual([]);
    expect(plan.toJSON().review).toEqual([]);
  });

  it.each([
    ["a non-object", "nope"],
    ["null", null],
    ["version 2", { ...validRaw, version: 2 }],
    ["an unknown top-level key", { ...validRaw, extra: 1 }],
    ["an empty first-pass", { version: 1, "first-pass": [], fix: validRaw.fix }],
    ["an empty fix", { version: 1, "first-pass": validRaw["first-pass"], fix: [] }],
    [
      "a first-pass seat with an undeclared tool",
      { ...validRaw, "first-pass": [seat("a1", "alpha-1", { tool: "claude" })] },
    ],
    [
      "a fix seat with no tool",
      { version: 1, "first-pass": validRaw["first-pass"], fix: [{ id: "b1", model: "beta-1" }] },
    ],
    [
      "a seat with an unknown key",
      { ...validRaw, "first-pass": [seat("a1", "alpha-1", { bogus: 1 })] },
    ],
    [
      "a repeated id in one role",
      { version: 1, "first-pass": [seat("a1", "alpha-1"), seat("a1", "alpha-2")], fix: validRaw.fix },
    ],
    [
      "an empty on list",
      { ...validRaw, "first-pass": [seat("a1", "alpha-1", { on: [] })] },
    ],
    [
      "an on list containing none",
      { ...validRaw, "first-pass": [seat("a1", "alpha-1", { on: ["none"] })] },
    ],
    [
      "an on list with a duplicate trigger",
      { ...validRaw, "first-pass": [seat("a1", "alpha-1", { on: ["timeout", "timeout"] })] },
    ],
    [
      "a blank variant",
      { ...validRaw, "first-pass": [seat("a1", "alpha-1", { variant: "   " })] },
    ],
  ])("refuses %s", (_label, raw) => {
    expect(SeatPlan.create(raw).success).toBe(false);
  });

  it("accepts a review seat without a tool", () => {
    const result = SeatPlan.create({
      version: 1,
      "first-pass": [seat("a1", "alpha-1")],
      fix: [seat("b1", "beta-1")],
      review: [{ id: "r1", model: "rho-1" }],
    });
    expect(result.success).toBe(true);
  });

  it("accepts the same id in two different roles", () => {
    const result = SeatPlan.create({
      version: 1,
      "first-pass": [seat("x", "alpha-1")],
      fix: [seat("x", "beta-1")],
    });
    expect(result.success).toBe(true);
  });
});
