import { describe, expect, it } from "vitest";
import { attemptJournalPath, attemptListPath } from "./attempts";

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

describe("attemptJournalPath", () => {
  it("returns the plain path for a plain id", () => {
    expect(attemptJournalPath("att_live_1")).toBe(
      "/v1/attempts/att_live_1/journal",
    );
  });

  it("encodes unsafe characters in the id", () => {
    expect(attemptJournalPath("a b/../x")).toBe(
      "/v1/attempts/a%20b%2F..%2Fx/journal",
    );
  });
});
