import { describe, expect, it } from "vitest";
import { questionListPath } from "./coordination";

describe("questionListPath", () => {
  it("returns /v1/questions for an empty query", () => {
    expect(questionListPath({})).toBe("/v1/questions");
  });

  it("appends the state query to /v1/questions", () => {
    expect(questionListPath({ state: "open" })).toBe("/v1/questions?state=open");
  });
});
