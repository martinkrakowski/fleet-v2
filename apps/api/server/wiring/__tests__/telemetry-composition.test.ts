// Telemetry wiring (OT2b): the API runtime configures telemetry's own read-only
// receipt read; reset clears it back to null.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { configureFleetApiRuntime } from "../runtime";
import { getTelemetryReadComposition } from "../telemetry/composition";

const createdDirs = new Set<string>();

afterAll(async () => {
  await Promise.all(
    [...createdDirs].map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function makeTempDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "fleet-telemetry-api-"));
  createdDirs.add(directory);
  return directory;
}

describe("telemetry read composition", () => {
  it("is null before any configuration and after a reset", () => {
    configureFleetApiRuntime(null);
    expect(getTelemetryReadComposition()).toBeNull();
  });

  it("configures a composition whose read answers none for an unknown attempt", async () => {
    const stateDir = await makeTempDir();
    configureFleetApiRuntime({ stateDir });
    try {
      const composition = getTelemetryReadComposition();
      expect(composition).not.toBeNull();
      if (composition !== null) {
        const result = await composition.acceptanceReceiptRead.readReceiptsForHead(
          "example-attempt-unknown",
          "example-head-unknown",
        );
        expect(result).toEqual({ outcome: "none" });
      }
    } finally {
      configureFleetApiRuntime(null);
    }
    expect(getTelemetryReadComposition()).toBeNull();
  });
});
