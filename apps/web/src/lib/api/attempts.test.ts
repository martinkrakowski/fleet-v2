import { describe, expect, it } from "vitest";
import { attemptListPath } from "./attempts";

describe("attemptListPath", () => {
  it("returns the plain path when no query is given", () => {
    expect(attemptListPath({})).toBe("/v1/attempts");
  });

  it("serializes limit and projectId params", () => {
    expect(attemptListPath({ limit: 5, projectId: "a b" })).toBe(
      "/v1/attempts?limit=5&projectId=a+b",
    );
  });

  it("serializes only the provided params", () => {
    expect(attemptListPath({ projectId: "p" })).toBe(
      "/v1/attempts?projectId=p",
    );
  });
});
