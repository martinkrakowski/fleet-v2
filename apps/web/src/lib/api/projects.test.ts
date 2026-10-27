import { describe, expect, it } from "vitest";
import { projectListPath } from "./projects";

describe("projectListPath", () => {
  it("returns the plain path when no query is given", () => {
    expect(projectListPath({})).toBe("/v1/projects");
  });

  it("serializes the status param", () => {
    expect(projectListPath({ status: "retired" })).toBe(
      "/v1/projects?status=retired",
    );
  });
});
