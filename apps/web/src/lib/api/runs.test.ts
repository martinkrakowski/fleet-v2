import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RUN_SCHEDULE_PATH, createRunReaders } from "./runs";
import { parseScheduleEnvelope } from "../../app/conductor/map-schedule";

describe("createRunReaders", () => {
  it("calls read with the /v1/runs path", async () => {
    const paths: string[] = [];
    const read = async <T>(path: string, fallback: T) => {
      paths.push(path);
      return {
        source: "fixture-fallback" as const,
        status: null,
        data: fallback,
        fallbackReason: "unused",
      };
    };
    const readers = createRunReaders(read);
    const result = await readers.fetchRunSchedule?.(null);

    expect(paths).toEqual([RUN_SCHEDULE_PATH]);
    expect(RUN_SCHEDULE_PATH).toBe("/v1/runs");
    expect(result?.data).toBeNull();
  });
});

describe("recorded /v1/runs wire parity", () => {
  const fixturePath = join(
    import.meta.dirname,
    "../../../../api/server/wiring/__tests__/fixtures/v1-runs.recorded.json",
  );
  const envelope: unknown = JSON.parse(readFileSync(fixturePath, "utf8"));

  it("parses the recorded envelope", () => {
    const schedule = parseScheduleEnvelope(envelope);
    expect(schedule).not.toBeNull();
  });

  it("keeps every recorded row with a known placement", () => {
    const schedule = parseScheduleEnvelope(envelope);
    expect(schedule).not.toBeNull();
    const recorded = (
      envelope as {
        result: { schedule: { rows: unknown[] } };
      }
    ).result.schedule.rows;
    expect(schedule?.rows.length).toBe(recorded.length);
    for (const row of schedule?.rows ?? []) {
      expect(["running", "waiting", "parked", "halted"]).toContain(
        row.placement,
      );
    }
  });

  it("keeps admission.maxActiveRuns null as recorded", () => {
    const schedule = parseScheduleEnvelope(envelope);
    expect(schedule?.admission.maxActiveRuns).toBeNull();
  });
});
