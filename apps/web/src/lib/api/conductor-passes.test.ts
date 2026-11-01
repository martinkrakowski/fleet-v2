import { describe, expect, it } from "vitest";
import { conductorPassesPath } from "./conductor-passes";

describe("conductorPassesPath", () => {
  it("returns the plain path when no query is given", () => {
    expect(conductorPassesPath({})).toBe("/v1/runs/passes");
  });

  it("serializes a limit param", () => {
    expect(conductorPassesPath({ limit: 32 })).toBe(
      "/v1/runs/passes?limit=32",
    );
  });
});
