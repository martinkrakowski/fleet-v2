import { describe, expect, it } from "vitest";
import type { ConductorPassView } from "./map-passes";
import {
  buildReservationStepPoints,
  buildReservationStepSegments,
  computeTimelineDomain,
  derivePassOverlaySamples,
  positionSessionMarks,
  scaleCountY,
  scaleTimeX,
} from "./timeline-scale";

function pass(overrides: Partial<ConductorPassView> = {}): ConductorPassView {
  return {
    passId: "pass-0001",
    nowIso: "2026-10-31T13:41:08.000Z",
    halted: false,
    progressed: true,
    maxActiveRuns: 4,
    passConcurrency: 2,
    dispatchStaggerMs: 250,
    runs: [],
    attention: [],
    ...overrides,
  };
}

describe("computeTimelineDomain", () => {
  it("is null when nothing parses", () => {
    expect(computeTimelineDomain([])).toBeNull();
    expect(computeTimelineDomain([{ atIso: "not-a-time" }])).toBeNull();
  });

  it("spans the parseable point times", () => {
    expect(
      computeTimelineDomain([
        { atIso: "2026-10-20T09:00:00.000Z" },
        { atIso: "2026-10-20T09:10:00.000Z" },
      ]),
    ).toEqual([
      Date.parse("2026-10-20T09:00:00.000Z"),
      Date.parse("2026-10-20T09:10:00.000Z"),
    ]);
  });

  it("adds the anchor when the only point is the anchor itself", () => {
    const anchor = "2026-10-20T09:05:00.000Z";
    expect(computeTimelineDomain([{ atIso: anchor }], anchor)).toEqual([
      Date.parse(anchor),
      Date.parse(anchor),
    ]);
  });
});

describe("scaleTimeX", () => {
  it("is linear over the domain", () => {
    const scale = scaleTimeX([0, 100], [10, 110]);
    expect(scale(0)).toBe(10);
    expect(scale(50)).toBe(60);
    expect(scale(100)).toBe(110);
  });

  it("clamps to the range", () => {
    const scale = scaleTimeX([0, 100], [10, 110]);
    expect(scale(-5)).toBe(10);
    expect(scale(500)).toBe(110);
  });

  it("maps a zero-width domain to the middle", () => {
    expect(scaleTimeX([5, 5], [10, 110])(5)).toBe(60);
  });
});

describe("scaleCountY", () => {
  it("maps 0 to the bottom of the range and max to the top", () => {
    const scale = scaleCountY(4, [10, 110]);
    expect(scale(0)).toBe(110);
    expect(scale(4)).toBe(10);
    expect(scale(2)).toBe(60);
  });

  it("clamps and maps a non-positive max to the middle", () => {
    expect(scaleCountY(4, [10, 110])(8)).toBe(10);
    expect(scaleCountY(0, [10, 110])(2)).toBe(60);
  });
});

describe("buildReservationStepPoints", () => {
  it("is empty for empty input", () => {
    expect(buildReservationStepPoints([])).toEqual([]);
  });

  it("keeps a single-instant point as one step", () => {
    expect(
      buildReservationStepPoints([
        { atIso: "2026-10-31T13:41:08.000Z", held: 3 },
      ]),
    ).toEqual([
      { atIso: "2026-10-31T13:41:08.000Z", held: 3 },
    ]);
  });

  it("builds a held-then-released step series from intervals", () => {
    expect(
      buildReservationStepPoints([
        {
          reservedAtIso: "2026-10-31T13:40:00.000Z",
          releasedAtIso: "2026-10-31T13:50:00.000Z",
        },
        {
          reservedAtIso: "2026-10-31T13:45:00.000Z",
          releasedAtIso: null,
        },
      ]),
    ).toEqual([
      { atIso: "2026-10-31T13:40:00.000Z", held: 1 },
      { atIso: "2026-10-31T13:45:00.000Z", held: 2 },
      { atIso: "2026-10-31T13:50:00.000Z", held: 1 },
    ]);
  });

  it("skips unparseable, negative and release-before-reserve inputs", () => {
    expect(
      buildReservationStepPoints([
        { reservedAtIso: "not-a-time", releasedAtIso: null },
        {
          reservedAtIso: "2026-10-31T13:50:00.000Z",
          releasedAtIso: "2026-10-31T13:40:00.000Z",
        },
        { atIso: "2026-10-31T13:55:00.000Z", held: -1 },
      ]),
    ).toEqual([]);
  });

  it("sorts point input by time", () => {
    expect(
      buildReservationStepPoints([
        { atIso: "2026-10-31T13:45:00.000Z", held: 1 },
        { atIso: "2026-10-31T13:40:00.000Z", held: 0 },
      ]),
    ).toEqual([
      { atIso: "2026-10-31T13:40:00.000Z", held: 0 },
      { atIso: "2026-10-31T13:45:00.000Z", held: 1 },
    ]);
  });
});

describe("buildReservationStepSegments", () => {
  it("draws the plateau at the previous count, then the riser", () => {
    const points = [
      { atIso: "2026-10-31T13:40:00.000Z", held: 2 },
      { atIso: "2026-10-31T13:45:00.000Z", held: 2 },
      { atIso: "2026-10-31T13:50:00.000Z", held: 0 },
    ];
    const scaleX = scaleTimeX(
      [Date.parse(points[0].atIso), Date.parse(points[2].atIso)],
      [0, 100],
    );
    const scaleY = scaleCountY(2, [10, 110]);

    const segments = buildReservationStepSegments(points, scaleX, scaleY);
    expect(segments).toEqual([
      // Plateau at held 2 from the first time to the second.
      expect.objectContaining({ x1: 0, y1: 10, x2: 50, y2: 10 }),
      // Riser at the second time (no change in count).
      expect.objectContaining({ x1: 50, y1: 10, x2: 50, y2: 10 }),
      // Plateau at held 2 from the second time to the third.
      expect.objectContaining({ x1: 50, y1: 10, x2: 100, y2: 10 }),
      // Riser down to held 0 at the third time.
      expect.objectContaining({ x1: 100, y1: 10, x2: 100, y2: 110 }),
    ]);
  });

  it("is empty for fewer than two points", () => {
    const scale = (_value: number) => 0;
    expect(
      buildReservationStepSegments(
        [{ atIso: "2026-10-31T13:40:00.000Z", held: 1 }],
        scale,
        scale,
      ),
    ).toEqual([]);
  });
});

describe("derivePassOverlaySamples", () => {
  it("is empty before the first traced pass", () => {
    expect(derivePassOverlaySamples([])).toEqual([]);
  });

  it("counts advanced runs as active and traced waiting steps by reason", () => {
    const traced = pass({
      passId: "pass-0002",
      nowIso: "2026-10-31T13:52:04.000Z",
      runs: [
        {
          runId: "run-1",
          report: {
            outcome: "advanced",
            steps: [
              { outcome: "waiting", reason: "admission" },
              { outcome: "waiting", reason: "session-stagger" },
            ],
          },
        },
        {
          runId: "run-2",
          report: {
            outcome: "advanced",
            steps: [{ outcome: "waiting", reason: "admission" }],
          },
        },
        {
          runId: "run-3",
          report: { outcome: "skipped", reason: "halted" },
        },
      ],
    });

    const samples = derivePassOverlaySamples([traced]);
    expect(samples).toHaveLength(1);
    expect(samples[0]).toMatchObject({
      passId: "pass-0002",
      atIso: "2026-10-31T13:52:04.000Z",
      active: 2,
      totalWaits: 3,
    });
    expect(samples[0].waits).toEqual({
      admission: 2,
      "session-stagger": 1,
    });
  });

  it("never counts an unknown wait reason", () => {
    const traced = pass({
      runs: [
        {
          runId: "run-1",
          report: {
            outcome: "advanced",
            steps: [{ outcome: "waiting", reason: "not-a-reason" }],
          },
        },
      ],
    });
    const samples = derivePassOverlaySamples([traced]);
    expect(samples[0].active).toBe(1);
    expect(samples[0].totalWaits).toBe(0);
    expect(samples[0].waits).toEqual({});
  });

  it("keeps passes in wire order and never sorts", () => {
    const older = pass({ passId: "pass-0001" });
    const newer = pass({ passId: "pass-0002" });
    expect(derivePassOverlaySamples([older, newer]).map((s) => s.passId)).toEqual([
      "pass-0001",
      "pass-0002",
    ]);
  });
});

describe("positionSessionMarks", () => {
  it("is empty when the domain is null", () => {
    expect(positionSessionMarks([], 250)).toEqual([]);
  });

  it("marks underStagger only when a stagger is supplied", () => {
    const marks = [
      {
        runId: "run-1",
        step: "dispatch",
        recordedAtIso: "2026-10-31T13:40:00.000Z",
        gapMs: null,
      },
      {
        runId: "run-2",
        step: "dispatch",
        recordedAtIso: "2026-10-31T13:40:10.000Z",
        gapMs: 10_000,
      },
      {
        runId: "run-3",
        step: "brief-check",
        recordedAtIso: "2026-10-31T13:40:20.000Z",
        gapMs: 10_000,
      },
    ];

    const unknown = positionSessionMarks(marks, null);
    expect(unknown.map((m) => m.underStagger)).toEqual([null, null, null]);

    const known = positionSessionMarks(marks, 20_000);
    expect(known.map((m) => m.underStagger)).toEqual([null, true, true]);
    expect(known[0].x).toBe(0);
    expect(known[2].x).toBe(1);
  });

  it("keeps a wire-recorded underStagger flag instead of recomputing", () => {
    const marks = [
      {
        runId: "run-1",
        step: "dispatch",
        recordedAtIso: "2026-10-31T13:40:00.000Z",
        gapMs: 30_000,
        underStagger: true,
      },
    ];
    expect(positionSessionMarks(marks, null)[0].underStagger).toBe(true);
  });

  it("lays marks on a shared domain between the held points' positions", () => {
    const domain: readonly [number, number] = [
      Date.parse("2026-10-31T13:40:00.000Z"),
      Date.parse("2026-10-31T13:50:00.000Z"),
    ];
    const marks = [
      {
        runId: "run-1",
        step: "dispatch",
        recordedAtIso: "2026-10-31T13:45:00.000Z",
        gapMs: null,
      },
    ];
    const x = scaleTimeX(domain, [0, 1]);
    const laid = positionSessionMarks(marks, 20_000, domain);
    expect(laid).toHaveLength(1);
    expect(laid[0].x).toBeGreaterThan(x(domain[0]));
    expect(laid[0].x).toBeLessThan(x(domain[1]));
    expect(laid[0].x).toBe(0.5);
  });
});
