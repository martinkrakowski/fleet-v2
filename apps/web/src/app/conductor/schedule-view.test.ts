import { describe, expect, it } from "vitest";
import type { ScheduleRowView, ScheduleView } from "./map-schedule";
import {
  capNote,
  filterRows,
  gaugeFraction,
  gaugeText,
  placementText,
} from "./schedule-view";

function row(overrides: Partial<ScheduleRowView> = {}): ScheduleRowView {
  return {
    runId: "run-1",
    workOrderId: "wo-1",
    tier: 2,
    state: "running",
    round: 0,
    placement: "running",
    pendingStep: null,
    park: null,
    leaseLapsed: false,
    packageKeys: ["packages/a"],
    workOrderUnreadable: false,
    overlapsWith: [],
    slot: null,
    admissionWait: null,
    ...overrides,
  };
}

function schedule(overrides: Partial<ScheduleView> = {}): ScheduleView {
  return {
    observedAtIso: "2026-10-20T09:00:00.000Z",
    halt: "clear",
    driverLeaseLapsed: null,
    rows: [],
    hosts: [],
    admission: { active: 1, inFlight: 0, maxActiveRuns: null },
    caps: null,
    trace: "none",
    sessionStarts: [],
    truncated: false,
    ...overrides,
  };
}

describe("placementText", () => {
  it("spells both admission waits", () => {
    expect(placementText(row({ admissionWait: "cap" }))).toBe(
      "admission wait (cap)",
    );
    expect(placementText(row({ admissionWait: "package-overlap" }))).toBe(
      "admission wait (package overlap)",
    );
  });

  it("covers running, halted, parked and the neutral waiting line", () => {
    expect(placementText(row({ placement: "running" }))).toBe("running");
    expect(placementText(row({ placement: "halted" }))).toBe("halted");
    expect(placementText(row({ placement: "parked", park: null }))).toBe(
      "parked",
    );
    expect(
      placementText(
        row({ placement: "parked", park: { reason: "blocked", qualifier: "q" } }),
      ),
    ).toBe("parked · blocked");
    expect(placementText(row({ placement: "waiting" }))).toBe(
      "waiting (reason recorded per pass once traces exist)",
    );
  });
});

describe("gauge helpers", () => {
  it("reports a missing cap in words", () => {
    expect(gaugeText({ active: 2, inFlight: 1, maxActiveRuns: null })).toContain(
      "cap not recorded",
    );
    expect(gaugeFraction({ active: 2, inFlight: 1, maxActiveRuns: null })).toBe(
      null,
    );
  });

  it("reports held vs cap and clamps the fraction", () => {
    expect(
      gaugeText({ active: 2, inFlight: 1, maxActiveRuns: 4 }),
    ).toBe("3 of 4 held (2 active, 1 in flight)");
    expect(gaugeFraction({ active: 3, inFlight: 0, maxActiveRuns: 2 })).toBe(1);
  });
});

describe("capNote", () => {
  it("marks a missing cap and an unreadable trace", () => {
    expect(capNote(schedule())).toBe("cap not recorded");
    expect(
      capNote(schedule({ trace: "unreadable" })),
    ).toContain("pass trace unreadable");
  });

  it("reports the recording time when caps exist", () => {
    expect(
      capNote(
        schedule({
          caps: {
            maxActiveRuns: 4,
            passConcurrency: 2,
            dispatchStaggerMs: 500,
            recordedAtIso: "2026-10-20T08:00:00.000Z",
          },
        }),
      ),
    ).toBe("cap recorded 2026-10-20T08:00:00.000Z");
  });
});

describe("filterRows", () => {
  it("keeps only parked rows for the parked filter", () => {
    const rows = [
      row({ runId: "r1" }),
      row({ runId: "r2", placement: "parked" }),
      row({ runId: "r3", placement: "parked", admissionWait: "cap" }),
      row({ runId: "r4", placement: "waiting" }),
    ];
    expect(filterRows(rows, "parked").map((r) => r.runId)).toEqual([
      "r2",
      "r3",
    ]);
    expect(filterRows(rows, "all").length).toBe(4);
  });
});
