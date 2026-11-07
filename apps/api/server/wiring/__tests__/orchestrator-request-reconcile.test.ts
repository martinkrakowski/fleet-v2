import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { configureFleetApiRuntime } from "../runtime.js";
import { getOperatorComposition } from "../operator/composition.js";
import { OrchestratorRequest } from "@fleet/operator-coordination";
import { LaneRunJournalAdapter } from "@fleet/work-execution";

const ID = "01JB0000000000000000000000";
const ORCH = "orch-example-1";
const PROJECT = "example-project";
const HOST = "example-host";

const PROFILE_REQUEST = {
  projectId: PROJECT,
  displayName: "Example",
  repository: "example/example",
  designatedDispatcherHost: HOST,
  policyRevision: "policy@rev-1",
  maxConcurrentLanes: 2,
  runnerCapabilities: {},
};

const SESSION_BODY = {
  orchestratorId: ORCH,
  cliKind: "conductor",
  model: null,
  host: HOST,
  projects: [PROJECT],
  claims: ["start-lane-run"],
};

describe("createConfiguredOperatorComposition reconciles a real stored start-lane-run through run-journal.json", () => {
  let tempDir: string;

  afterEach(() => {
    if (tempDir !== undefined) {
      rmSync(tempDir, { recursive: true, force: true });
    }
    configureFleetApiRuntime(null);
  });

  it("claim -> intent -> unchanged intent -> result completes and a later claim is already-dispatched", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "fleet-api-reconcile-"));
    configureFleetApiRuntime({ stateDir: tempDir });
    const composition = getOperatorComposition();

    const profiled = await composition.registerProjectProfile.execute(PROFILE_REQUEST);
    expect(profiled.outcome).toBe("registered");

    const registered = await composition.registerOrchestratorSession.registerOrchestratorSession(
      SESSION_BODY,
      ["orchestrate"],
      "shared-bearer",
    );
    expect(registered.outcome).toBe("registered");

    const opened = OrchestratorRequest.open(
      {
        requestId: ID,
        kind: "start-lane-run",
        projectId: PROJECT,
        target: { workOrderId: "work-order-example-1" },
      },
      { via: "web", sessionId: "session-example-1" },
      new Date().toISOString(),
    );
    expect(opened.success).toBe(true);
    if (!opened.success) {
      return;
    }
    const saved = await composition.orchestratorRequestRepository.save(opened.value.toRecord(), 0);
    expect(saved.outcome).toBe("saved");

    const claimed = await composition.reconcileOrchestratorRequest.execute("claim", {
      requestId: ID,
      orchestratorId: ORCH,
      expectedRevision: 1,
    });
    expect(claimed).toEqual({ outcome: "claimed", requestId: ID, revision: 2, fence: 1 });

    const intent = await composition.reconcileOrchestratorRequest.execute("record-intent", {
      requestId: ID,
      orchestratorId: ORCH,
      expectedRevision: 2,
      fence: 1,
    });
    expect(intent).toEqual({ outcome: "intent-recorded", requestId: ID });

    // A crash after the intent leaves no result; a retried record-intent must
    // be unchanged and must not append a second intent.
    const intentAgain = await composition.reconcileOrchestratorRequest.execute("record-intent", {
      requestId: ID,
      orchestratorId: ORCH,
      expectedRevision: 2,
      fence: 1,
    });
    expect(intentAgain).toEqual({ outcome: "unchanged", requestId: ID });

    const completed = await composition.reconcileOrchestratorRequest.execute("record-result", {
      requestId: ID,
      orchestratorId: ORCH,
      expectedRevision: 2,
      fence: 1,
      outcome: "completed",
      reasonCode: null,
      reasonKind: null,
      linkedId: "run-example-1",
    });
    expect(completed).toEqual({ outcome: "result-recorded", requestId: ID });

    // The bytes on disk are exactly what the production adapters wrote.
    const journal = new LaneRunJournalAdapter({ stateDir: tempDir });
    const entries = await journal.listForKey(`request/${ID}`);
    const intents = entries.filter((entry) => entry.kind === "intent");
    const results = entries.filter((entry) => entry.kind === "result");
    expect(intents).toHaveLength(1);
    expect(results).toHaveLength(1);
    expect(intents[0].digest).toMatch(/^[0-9a-f]{64}$/);

    const stored = await composition.orchestratorRequestRepository.get(ID);
    expect(stored.outcome).toBe("found");
    if (stored.outcome === "found") {
      expect(stored.request.state).toBe("dispatched");
      expect(stored.request.linked?.journalKey).toBe(`request/${ID}`);
    }

    const laterClaim = await composition.reconcileOrchestratorRequest.execute("claim", {
      requestId: ID,
      orchestratorId: ORCH,
      expectedRevision: 3,
    });
    expect(laterClaim).toEqual({ outcome: "already-dispatched", requestId: ID });
  });
});
