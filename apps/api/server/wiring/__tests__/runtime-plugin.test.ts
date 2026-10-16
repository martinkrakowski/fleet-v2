import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { configureFleetApiRuntime } from "../runtime";
import { bootstrapFleetApiFromEnv } from "../../plugins/runtime";

describe("API runtime installation bootstrap", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "fleet-api-test-"));
  });

  afterEach(() => {
    configureFleetApiRuntime(null);
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns false and does not configure runtime when installation file is invalid", () => {
    const invalidFilePath = join(tempDir, "invalid-fleet.json");
    writeFileSync(
      invalidFilePath,
      JSON.stringify({
        schemaVersion: 1,
        UNKNOWN_SENTINEL_FIELD: "secret-value",
      }),
    );

    const configured = bootstrapFleetApiFromEnv({
      FLEET_STATE_DIR: tempDir,
      FLEET_INSTALLATION_FILE: invalidFilePath,
    });

    expect(configured).toBe(false);
  });

  it("returns true and configures runtime when installation file is absent and state dir is set", () => {
    const absentFilePath = join(tempDir, "non-existent-fleet.json");

    const configured = bootstrapFleetApiFromEnv({
      FLEET_STATE_DIR: tempDir,
      FLEET_INSTALLATION_FILE: absentFilePath,
    });

    expect(configured).toBe(true);
  });

  it("returns false when FLEET_STATE_DIR is unset", () => {
    const configured = bootstrapFleetApiFromEnv({});
    expect(configured).toBe(false);
  });

  it("returns true and configures runtime when installation file is valid and state dir is set", () => {
    const validFilePath = join(tempDir, "valid-fleet.json");
    writeFileSync(
      validFilePath,
      JSON.stringify({
        schemaVersion: 1,
        runner: {
          agent: "api-test-agent",
          model: "api-test-model",
        },
      }),
    );

    const configured = bootstrapFleetApiFromEnv({
      FLEET_STATE_DIR: tempDir,
      FLEET_INSTALLATION_FILE: validFilePath,
    });

    expect(configured).toBe(true);
  });
});
