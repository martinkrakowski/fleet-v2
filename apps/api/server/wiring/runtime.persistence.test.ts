import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  persistAcceptedReceiptsToState,
  persistAuthorizationCoordinatesToState,
  readAcceptedReceiptsFromState,
  readAuthorizationCoordinatesFromState,
  type FleetAuthorizationCoordinate,
} from "./runtime";

describe("Fleet API runtime wiring cross-process safe persistence", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "fleet-api-runtime-test-"));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  it("handles concurrent accepted receipt saves without dropping entries", async () => {
    // Two concurrent calls attempting to persist receipts
    const saveA = persistAcceptedReceiptsToState(tempDir, {
      "head-commit-1": "receipt-id-1",
    });

    const saveB = persistAcceptedReceiptsToState(tempDir, {
      "head-commit-2": "receipt-id-2",
    });

    await Promise.all([saveA, saveB]);

    const persisted = readAcceptedReceiptsFromState(tempDir);
    expect(persisted["head-commit-1"]).toBe("receipt-id-1");
    expect(persisted["head-commit-2"]).toBe("receipt-id-2");
  });

  it("handles concurrent authorization coordinate saves without dropping entries", async () => {
    const coord1: FleetAuthorizationCoordinate = {
      attemptId: "att-1",
      expectedHeadSha: "commit-sha-1",
    };
    const coord2: FleetAuthorizationCoordinate = {
      attemptId: "att-2",
      expectedHeadSha: "commit-sha-2",
    };

    const saveA = persistAuthorizationCoordinatesToState(
      tempDir,
      new Map([["grant-1", coord1]]),
    );

    const saveB = persistAuthorizationCoordinatesToState(
      tempDir,
      new Map([["grant-2", coord2]]),
    );

    await Promise.all([saveA, saveB]);

    const persisted = readAuthorizationCoordinatesFromState(tempDir);
    expect(persisted.get("grant-1")).toEqual(coord1);
    expect(persisted.get("grant-2")).toEqual(coord2);
  });

  it("throws and leaves corrupt accepted-receipts.json unchanged on write attempt", async () => {
    const receiptsPath = path.join(tempDir, "accepted-receipts.json");
    const corruptContent = "CORRUPT_NOT_JSON_{{";
    await fs.writeFile(receiptsPath, corruptContent, "utf8");

    await expect(
      persistAcceptedReceiptsToState(tempDir, {
        "head-commit-new": "receipt-id-new",
      }),
    ).rejects.toThrow();

    const contentAfter = await fs.readFile(receiptsPath, "utf8");
    expect(contentAfter).toBe(corruptContent);
  });
});
