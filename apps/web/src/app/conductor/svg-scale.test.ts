import { describe, expect, it } from "vitest";
import { markLayout, stripDomain, timeScale } from "./svg-scale";

describe("timeScale", () => {
  const scale = timeScale([0, 100], [10, 110]);

  it("is linear over the domain", () => {
    expect(scale(50)).toBe(60);
    expect(scale(0)).toBe(10);
    expect(scale(100)).toBe(110);
  });

  it("clamps to the range", () => {
    expect(scale(-5)).toBe(10);
    expect(scale(500)).toBe(110);
  });

  it("maps a zero-width domain to the middle of the range", () => {
    expect(timeScale([5, 5], [10, 110])(5)).toBe(60);
    expect(timeScale([5, 5], [10, 110])(900)).toBe(60);
  });

  it("maps a non-finite input to the start of the range", () => {
    expect(scale(Number.NaN)).toBe(10);
  });
});

describe("stripDomain", () => {
  it("is null when nothing parses", () => {
    expect(stripDomain([])).toBeNull();
    expect(stripDomain([{ recordedAtIso: "not-a-time" }])).toBeNull();
  });

  it("spans the parseable times", () => {
    expect(
      stripDomain([
        { recordedAtIso: "2026-10-20T09:00:00.000Z" },
        { recordedAtIso: "2026-10-20T09:10:00.000Z" },
        { recordedAtIso: "2026-10-20T09:05:00.000Z" },
      ]),
    ).toEqual([
      Date.parse("2026-10-20T09:00:00.000Z"),
      Date.parse("2026-10-20T09:10:00.000Z"),
    ]);
  });
});

describe("markLayout", () => {
  it("is empty when the domain is null", () => {
    expect(markLayout([], 200, 10)).toEqual([]);
  });

  it("places two marks 10 s apart across the padded width", () => {
    const t0 = "2026-10-20T09:00:00.000Z";
    const t1 = "2026-10-20T09:00:10.000Z";
    const layout = markLayout(
      [
        { runId: "run-1", step: "dispatch", underStagger: null, recordedAtIso: t0 },
        { runId: "run-2", step: "dispatch", underStagger: true, recordedAtIso: t1 },
      ],
      200,
      10,
    );
    expect(layout.map((m) => m.x)).toEqual([10, 190]);
    expect(layout[1].underStagger).toBe(true);
  });
});
