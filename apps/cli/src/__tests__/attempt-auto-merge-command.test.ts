/**
 * CLI-boundary tests for the auto-merge wiring (lane AM5-3): `attempt
 * auto-merge` and the trigger inside `attempt accept`. The settings binding
 * reads a fresh temp installation on every call (A7); the forge is a recording
 * fake injected through the runtime's test options, so no test spawns a
 * process or touches the network.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { assessmentIdForAttempt, createFleetCliRuntime } from "../composition.js";
import { runCli } from "../index.js";
import { loadInstallation, type FleetInstallation, type LoadResult } from "@fleet/installation";
import type { AttemptRecord, WorkOrderRecord } from "@fleet/work-execution";
import type { EvidenceAssessmentRecord } from "@fleet/evidence-and-acceptance";

const HEAD = "1111111111111111111111111111111111111111";
const BASE = "0000000000000000000000000000000000000000";
const ATTEMPT_ID = "attempt-example-1";
const WORK_ORDER_ID = "wo-example-1";
const PROJECT_ID = "project-example-1";
const POLICY_REVISION = "pol-1";
const IMPLEMENTER_MODEL = "provider-a/glm-5.3";
const REVIEWER_MODEL = "provider-b/grok-4.7";

const createdDirs: string[] = [];

afterAll(() => {
  for (const directory of createdDirs) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "fleet-attempt-auto-merge-"));
  createdDirs.push(directory);
  return directory;
}

function collectIo(): {
  out: string[];
  err: string[];
  io: { stdout: (t: string) => void; stderr: (t: string) => void };
} {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    io: { stdout: (t) => out.push(t), stderr: (t) => err.push(t) },
  };
}

interface AutoMergeBlock {
  readonly enabled: boolean;
  readonly allowHighRisk: boolean;
  readonly onBlocked: "ask-owner" | "hold";
}

function makeInstallation(options: {
  autoMerge?: AutoMergeBlock;
  forgeMode?: "github" | "none";
} = {}): FleetInstallation {
  const forge =
    options.forgeMode === "none"
      ? { mode: "none" as const }
      : { mode: "github" as const, owner: "example-org", repo: "example-repo" };
  return {
    schemaVersion: 2,
    forge,
    hosts: {
      here: {
        transport: "local",
        worktreeRoot: "/tmp/wt",
        roles: ["orchestrator", "lane-runner", "verifier"],
        runner: { kind: "opencode", port: 46000 },
      },
    },
    ...(options.autoMerge !== undefined ? { policy: { autoMerge: options.autoMerge } } : {}),
  };
}

function setupInstallFile(dir: string, installation: FleetInstallation): {
  file: string;
  load: () => LoadResult;
} {
  const file = path.join(dir, "fleet.json");
  writeFileSync(file, `${JSON.stringify(installation, null, 2)}\n`, "utf8");
  return { file, load: () => loadInstallation({ file }) };
}

function makeRuntime(options: {
  stateDir: string;
  installation: FleetInstallation;
  load: () => LoadResult;
  forgeGhRunner: (args: readonly string[]) => Promise<GhResult>;
}): ReturnType<typeof createFleetCliRuntime> {
  return createFleetCliRuntime({
    stateDir: options.stateDir,
    installation: options.installation,
    loadInstallationForAutoMerge: options.load,
    forgeGhRunner: options.forgeGhRunner,
  });
}

function makeWorkOrder(): WorkOrderRecord {
  return {
    id: WORK_ORDER_ID,
    projectId: PROJECT_ID,
    taskId: "task-example-1",
    laneId: "lane-example-1",
    repository: "example-org/example-repo",
    baseCommit: BASE,
    ownedPaths: ["src/example.ts"],
    policyRevision: POLICY_REVISION,
    prerequisiteWorkOrderIds: [],
    state: "ready-to-merge",
    revision: 1,
    createdAtIso: "2026-10-28T09:00:00.000Z",
    updatedAtIso: "2026-10-28T09:00:00.000Z",
    risk: "standard",
  };
}

function makeAttempt(): AttemptRecord {
  return {
    id: ATTEMPT_ID,
    workOrderId: WORK_ORDER_ID,
    kind: "initial",
    fixNumber: 0,
    priorAttemptId: null,
    state: "collected",
    outcome: "done",
    baseCommit: BASE,
    worktreePath: "/tmp/wt/attempt-example-1",
    briefDigest: "digest-example-1",
    briefPackagePath: null,
    sessionId: null,
    completionReceipt: null,
    ownerDecisionReferences: [],
    artifacts: {
      headCommit: HEAD,
      commitsSinceBase: [HEAD],
      collectedArtifactPaths: ["/tmp/patch.diff"],
      notes: "present",
    },
    runner: {
      kind: "opencode",
      remotePort: null,
      host: null,
      agent: null,
      model: IMPLEMENTER_MODEL,
      variant: null,
    },
    createdAtIso: "2026-10-28T09:00:00.000Z",
    updatedAtIso: "2026-10-28T09:30:00.000Z",
  };
}

function makeAssessment(): EvidenceAssessmentRecord {
  return {
    id: assessmentIdForAttempt(ATTEMPT_ID),
    projectId: PROJECT_ID,
    attemptId: ATTEMPT_ID,
    candidateHeadSha: HEAD,
    policyRevision: POLICY_REVISION,
    implementerModel: IMPLEMENTER_MODEL,
    requiredChecks: [],
    state: "pending",
    verificationReceipts: [],
    reviewReceipts: [
      {
        id: "rr-example-1",
        assessmentId: assessmentIdForAttempt(ATTEMPT_ID),
        projectId: PROJECT_ID,
        attemptId: ATTEMPT_ID,
        candidateHeadSha: HEAD,
        reviewerModel: REVIEWER_MODEL,
        implementerModel: IMPLEMENTER_MODEL,
        readOnlyVerified: true,
        result: "pass",
        findings: [],
        evidenceRef: "evidence://review-example-1",
        policyRevision: POLICY_REVISION,
        completedAtIso: "2026-10-28T09:00:00.000Z",
      },
    ],
    findingDispositions: [],
    acceptanceReceiptId: null,
    blockers: [],
    revision: 1,
    updatedAtIso: "2026-10-28T09:00:00.000Z",
  };
}

type GhResult = { exitCode: number; stdout: string; stderr: string };

/** A forge runner that fails the test if it is ever invoked. */
function recordingGhRunner(): { calls: string[][]; runner: (args: readonly string[]) => Promise<GhResult> } {
  const calls: string[][] = [];
  return {
    calls,
    runner: async (args: readonly string[]) => {
      calls.push([...args]);
      throw new Error("gh unexpectedly invoked");
    },
  };
}

/** A passing gh runner for the acceptance setup under forge mode github. */
function passingGhRunner(): (args: readonly string[]) => Promise<GhResult> {
  return async (args: readonly string[]) => {
    if (args[0] === "api" && typeof args[1] === "string" && args[1].startsWith("repos/")) {
      return {
        exitCode: 0,
        stdout: JSON.stringify([{ state: "open", head: { sha: HEAD }, number: 7 }]),
        stderr: "",
      };
    }
    if (args[0] === "pr") {
      return { exitCode: 0, stdout: JSON.stringify([{ bucket: "pass" }]), stderr: "" };
    }
    return {
      exitCode: 0,
      stdout: JSON.stringify({
        data: {
          repository: { pullRequest: { reviewThreads: { totalCount: 0, nodes: [] } } },
        },
      }),
      stderr: "",
    };
  };
}

describe("fleet-v2 attempt auto-merge (AM5-3)", () => {
  it("returns off when policy.autoMerge is absent and never calls the forge", async () => {
    const dir = makeTempDir();
    const stateDir = path.join(dir, "state");
    mkdirSync(stateDir);
    const installation = makeInstallation();
    const { load } = setupInstallFile(dir, installation);
    const gh = recordingGhRunner();
    const runtime = makeRuntime({ stateDir, installation, load, forgeGhRunner: gh.runner });

    const { io, out } = collectIo();
    const code = await runCli(
      ["attempt", "auto-merge", "--json", JSON.stringify({ attemptId: ATTEMPT_ID })],
      io,
      runtime,
    );
    expect(code).toBe(0);
    const result = JSON.parse(out.join("")) as { outcome: string };
    expect(result.outcome).toBe("off");
    expect(gh.calls).toHaveLength(0);
  });

  it("not-merged with exit 1 when the setting is on but no gate predicates are bound", async () => {
    const dir = makeTempDir();
    const stateDir = path.join(dir, "state");
    mkdirSync(stateDir);
    const installation = makeInstallation({
      autoMerge: { enabled: true, allowHighRisk: false, onBlocked: "hold" },
    });
    const { load } = setupInstallFile(dir, installation);
    const gh = recordingGhRunner();
    const runtime = makeRuntime({ stateDir, installation, load, forgeGhRunner: gh.runner });
    await runtime.execution.workOrderRepository.saveWorkOrder(makeWorkOrder());
    await runtime.execution.attemptRepository.saveAttempt(makeAttempt());

    const { io, out } = collectIo();
    const code = await runCli(
      ["attempt", "auto-merge", "--json", JSON.stringify({ attemptId: ATTEMPT_ID })],
      io,
      runtime,
    );
    expect(code).toBe(1);
    const result = JSON.parse(out.join("")) as { outcome: string; reason: string };
    expect(result.outcome).toBe("not-merged");
    expect(result.reason).toBe("gate-not-passed");
    expect(gh.calls).toHaveLength(0);
  });

  it("an invalid temp installation read by the settings binding is settings-unreadable", async () => {
    const dir = makeTempDir();
    const stateDir = path.join(dir, "state");
    mkdirSync(stateDir);
    const file = path.join(dir, "fleet.json");
    writeFileSync(file, `{"schemaVersion": 2,\n`, "utf8");
    const installation = makeInstallation();
    const gh = recordingGhRunner();
    const runtime = makeRuntime({
      stateDir,
      installation,
      load: () => loadInstallation({ file }),
      forgeGhRunner: gh.runner,
    });
    await runtime.execution.workOrderRepository.saveWorkOrder(makeWorkOrder());
    await runtime.execution.attemptRepository.saveAttempt(makeAttempt());

    const { io, out } = collectIo();
    const code = await runCli(
      ["attempt", "auto-merge", "--json", JSON.stringify({ attemptId: ATTEMPT_ID })],
      io,
      runtime,
    );
    expect(code).toBe(1);
    const result = JSON.parse(out.join("")) as { outcome: string; reason: string };
    expect(result.outcome).toBe("not-merged");
    expect(result.reason).toBe("settings-unreadable");
    expect(gh.calls).toHaveLength(0);
  });

  it("attempt accept on an accepted attempt prints the exact result when auto-merge is off", async () => {
    const dir = makeTempDir();
    const stateDir = path.join(dir, "state");
    mkdirSync(stateDir);
    const installation = makeInstallation();
    const { load } = setupInstallFile(dir, installation);
    const runtime = makeRuntime({ stateDir, installation, load, forgeGhRunner: passingGhRunner() });
    await runtime.execution.workOrderRepository.saveWorkOrder(makeWorkOrder());
    await runtime.execution.attemptRepository.saveAttempt(makeAttempt());
    await runtime.evidence.evidenceAssessmentRepository.saveAssessment(makeAssessment());

    const assessIo = collectIo();
    const assessCode = await runCli(
      [
        "evidence",
        "assess",
        "--json",
        JSON.stringify({
          attemptId: ATTEMPT_ID,
          candidateHeadSha: HEAD,
          policyRevision: POLICY_REVISION,
        }),
      ],
      assessIo.io,
      runtime,
    );
    expect(assessCode).toBe(0);
    const assessed = JSON.parse(assessIo.out.join("")) as { outcome: string };
    expect(assessed.outcome).toBe("accepted");

    const acceptIo = collectIo();
    const acceptCode = await runCli(
      [
        "attempt",
        "accept",
        "--json",
        JSON.stringify({
          attemptId: ATTEMPT_ID,
          candidateHeadSha: HEAD,
          reviewerModel: REVIEWER_MODEL,
        }),
      ],
      acceptIo.io,
      runtime,
    );
    expect(acceptCode).toBe(0);
    const result = JSON.parse(acceptIo.out.join("")) as Record<string, unknown>;
    expect(result.outcome).toBe("accepted");
    expect(Object.hasOwn(result, "autoMerge")).toBe(false);
  });
});
