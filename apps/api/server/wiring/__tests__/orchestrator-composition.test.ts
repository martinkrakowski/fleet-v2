import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { configureFleetApiRuntime, getChangeFeed } from "../runtime.js";
import { getOperatorComposition } from "../operator/composition.js";

const BODY = {
  orchestratorId: "orch-example-1",
  cliKind: "claude-code",
  model: "example-provider/example-model",
  host: "example-host",
  projects: ["example-project"],
  claims: ["dispatch-attempt"],
};

describe("orchestrator composition", () => {
  let tempDir: string;

  afterEach(() => {
    if (tempDir !== undefined) {
      rmSync(tempDir, { recursive: true, force: true });
    }
    configureFleetApiRuntime(null);
  });

  it("registered session lands in the feed, heartbeats stay out, retire and list follow", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "fleet-api-orchestrators-"));
    configureFleetApiRuntime({ stateDir: tempDir });
    const feed = getChangeFeed()!;
    let cursor = feed.read(null).cursor;
    const composition = getOperatorComposition();

    const registered = await composition.registerOrchestratorSession.registerOrchestratorSession(
      BODY,
      ["orchestrate"],
      "shared-bearer",
    );
    expect(registered.outcome).toBe("registered");

    const read = feed.read(cursor);
    expect(read.kind).toBe("entries");
    if (read.kind === "entries") {
      expect(read.entries).toHaveLength(1);
      expect(read.entries[0].kind).toBe("orchestrator");
      expect(read.entries[0].id).toBe("orch-example-1");
    }
    cursor = read.cursor;
    expect(existsSync(join(tempDir, "orchestrators.json"))).toBe(true);

    const renewed = await composition.heartbeatOrchestratorSession.heartbeatOrchestratorSession(
      { orchestratorId: "orch-example-1" },
      "shared-bearer",
    );
    expect(renewed.outcome).toBe("renewed");

    const afterHeartbeat = feed.read(cursor);
    expect(afterHeartbeat).toEqual({ kind: "entries", entries: [], cursor });

    const foreign = await composition.heartbeatOrchestratorSession.heartbeatOrchestratorSession(
      { orchestratorId: "orch-example-1" },
      "token-example-2",
    );
    expect(foreign.outcome).toBe("not-owner");

    const retired = await composition.retireOrchestratorSession.retireOrchestratorSession(
      { orchestratorId: "orch-example-1" },
      "shared-bearer",
    );
    expect(retired.outcome).toBe("retired");

    const afterRetire = feed.read(cursor);
    expect(afterRetire.kind).toBe("entries");
    if (afterRetire.kind === "entries") {
      expect(afterRetire.entries).toHaveLength(1);
      expect(afterRetire.entries[0].kind).toBe("orchestrator");
      expect(afterRetire.entries[0].id).toBe("orch-example-1");
    }

    const listed = await composition.listOrchestratorSessions.listOrchestratorSessions({});
    expect(listed.sessions).toHaveLength(1);
    expect(listed.sessions[0].attached).toBe(false);
  });

  it("an in-memory runtime registers without a change feed", async () => {
    configureFleetApiRuntime({});
    const composition = getOperatorComposition();
    const registered = await composition.registerOrchestratorSession.registerOrchestratorSession(
      BODY,
      ["orchestrate"],
      "shared-bearer",
    );
    expect(registered.outcome).toBe("registered");
    expect(getChangeFeed()).toBeNull();
  });

  it("unconfigured use cases report not implemented", async () => {
    configureFleetApiRuntime(null);
    const composition = getOperatorComposition();
    await expect(
      composition.registerOrchestratorSession.registerOrchestratorSession(
        BODY,
        ["orchestrate"],
        "shared-bearer",
      ),
    ).rejects.toThrow("Not implemented: RegisterOrchestratorSessionUseCase");
    await expect(
      composition.heartbeatOrchestratorSession.heartbeatOrchestratorSession(
        { orchestratorId: "orch-example-1" },
        "shared-bearer",
      ),
    ).rejects.toThrow("Not implemented: HeartbeatOrchestratorSessionUseCase");
    await expect(
      composition.retireOrchestratorSession.retireOrchestratorSession(
        { orchestratorId: "orch-example-1" },
        "shared-bearer",
      ),
    ).rejects.toThrow("Not implemented: RetireOrchestratorSessionUseCase");
    await expect(
      composition.listOrchestratorSessions.listOrchestratorSessions({}),
    ).rejects.toThrow("Not implemented: ListOrchestratorSessionsUseCase");
  });
});
