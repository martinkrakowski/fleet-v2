/**
 * CLI-boundary tests for the composed gate wiring (lane GP-wire): the
 * dedicated gate instance is exposed as `execution.attemptGate`, auto-merge
 * evaluates it, and `attempt accept` keeps its own instance. The gate is
 * injected through the runtime's test option, the forge is a recording fake,
 * and no test spawns a process or touches the network.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { createFleetCliRuntime } from "../composition.js";
import { runCli } from "../index.js";
import { loadInstallation, type FleetInstallation, type LoadResult } from "@fleet/installation";
import type {
  AttemptRecord,
  EvaluateAttemptGatePort,
  EvaluateAttemptGateResult,
  WorkOrderRecord,
} from "@fleet/work-execution";

const HEAD = "1111111111111111111111111111111111111111";
const BASE = "0000000000000000000000000000000000000000";
const ATTEMPT_ID = "attempt-example-1";
const WORK_ORDER_ID = "wo-example-1";
const PROJECT_ID = "project-example-1";
const POLICY_REVISION = "pol-1";
const IMPLEMENTER_MODEL = "provider-a/glm-5.3";

const createdDirs: string[] = [];

afterAll(() => {
  for (const directory of createdDirs) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "fleet-attempt-gate-wiring-"));
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
  attemptGate?: EvaluateAttemptGatePort;
}): ReturnType<typeof createFleetCliRuntime> {
  return createFleetCliRuntime({
    stateDir: options.stateDir,
    installation: options.installation,
    loadInstallationForAutoMerge: options.load,
    forgeGhRunner: options.forgeGhRunner,
    ...(options.attemptGate !== undefined ? { attemptGate: options.attemptGate } : {}),
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

describe("fleet-v2 attempt gate wiring (GP-wire)", () => {
  it("predicates are wired: the gate no longer answers 'Gate predicates are not wired'", async () => {
    const dir = makeTempDir();
    const stateDir = path.join(dir, "state");
    mkdirSync(stateDir);
    const runtime = createFleetCliRuntime({ stateDir });

    const result = await runtime.execution.attemptGate.evaluateAttemptGate({
      attemptId: "attempt-missing",
      candidateHeadSha: "1".repeat(40),
    });
    expect(result).toEqual({ verdict: "unknown", reason: "Attempt not found" });
  });

  it("attempt accept keeps its own instance: requestAttemptAcceptance is not attemptGate", async () => {
    const dir = makeTempDir();
    const stateDir = path.join(dir, "state");
    mkdirSync(stateDir);
    const installation = makeInstallation();
    const { load } = setupInstallFile(dir, installation);
    const gh = recordingGhRunner();
    const runtime = makeRuntime({ stateDir, installation, load, forgeGhRunner: gh.runner });

    expect(runtime.execution.requestAttemptAcceptance).not.toBe(runtime.execution.attemptGate);
  });

  it.todo(
    "the composed grant path reaches the policy grant — the merge path's verifyCurrentHeadSha delegate runs a live `git rev-parse` on the attempt's worktree before the gh stub can answer, so a test reaching the grant would perform a live git invocation, which the lane rules forbid",
  );

  it("a failing gate stops auto-merge with gate-not-passed and no forge call", async () => {
    const dir = makeTempDir();
    const stateDir = path.join(dir, "state");
    mkdirSync(stateDir);
    const installation = makeInstallation({
      autoMerge: { enabled: true, allowHighRisk: false, onBlocked: "ask-owner" },
    });
    const { load } = setupInstallFile(dir, installation);
    const gh = recordingGhRunner();
    const gate: EvaluateAttemptGatePort = {
      evaluateAttemptGate: async (): Promise<EvaluateAttemptGateResult> => ({
        verdict: "failed",
        reason: "predicate failed",
      }),
    };
    const runtime = makeRuntime({
      stateDir,
      installation,
      load,
      forgeGhRunner: gh.runner,
      attemptGate: gate,
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
    expect(result.reason).toBe("gate-not-passed");
    expect(gh.calls).toHaveLength(0);
  });

  it("off stays off: the gate stub is never called", async () => {
    const dir = makeTempDir();
    const stateDir = path.join(dir, "state");
    mkdirSync(stateDir);
    const installation = makeInstallation();
    const { load } = setupInstallFile(dir, installation);
    const gh = recordingGhRunner();
    const calls = { gate: 0 };
    const runtime = makeRuntime({
      stateDir,
      installation,
      load,
      forgeGhRunner: gh.runner,
      attemptGate: {
        evaluateAttemptGate: async () => {
          calls.gate += 1;
          return { verdict: "passed" };
        },
      },
    });
    await runtime.execution.workOrderRepository.saveWorkOrder(makeWorkOrder());
    await runtime.execution.attemptRepository.saveAttempt(makeAttempt());

    const { io, out } = collectIo();
    const code = await runCli(
      ["attempt", "auto-merge", "--json", JSON.stringify({ attemptId: ATTEMPT_ID })],
      io,
      runtime,
    );
    expect(code).toBe(0);
    const result = JSON.parse(out.join("")) as { outcome: string };
    expect(result.outcome).toBe("off");
    expect(calls.gate).toBe(0);
  });

  it("settings are re-read on every call: a runtime that answered off merges the setting on the next call", async () => {
    const dir = makeTempDir();
    const stateDir = path.join(dir, "state");
    mkdirSync(stateDir);
    const installation = makeInstallation();
    const { file, load } = setupInstallFile(dir, installation);
    const gh = recordingGhRunner();
    const gate: EvaluateAttemptGatePort = {
      evaluateAttemptGate: async (): Promise<EvaluateAttemptGateResult> => ({
        verdict: "failed",
        reason: "predicate failed",
      }),
    };
    const runtime = makeRuntime({
      stateDir,
      installation,
      load,
      forgeGhRunner: gh.runner,
      attemptGate: gate,
    });
    await runtime.execution.workOrderRepository.saveWorkOrder(makeWorkOrder());
    await runtime.execution.attemptRepository.saveAttempt(makeAttempt());

    const firstIo = collectIo();
    const firstCode = await runCli(
      ["attempt", "auto-merge", "--json", JSON.stringify({ attemptId: ATTEMPT_ID })],
      firstIo.io,
      runtime,
    );
    expect(firstCode).toBe(0);
    const first = JSON.parse(firstIo.out.join("")) as { outcome: string };
    expect(first.outcome).toBe("off");

    const enabled = makeInstallation({
      autoMerge: { enabled: true, allowHighRisk: false, onBlocked: "ask-owner" },
    });
    writeFileSync(file, `${JSON.stringify(enabled, null, 2)}\n`, "utf8");

    const secondIo = collectIo();
    const secondCode = await runCli(
      ["attempt", "auto-merge", "--json", JSON.stringify({ attemptId: ATTEMPT_ID })],
      secondIo.io,
      runtime,
    );
    expect(secondCode).toBe(1);
    const second = JSON.parse(secondIo.out.join("")) as { outcome: string; reason: string };
    expect(second.outcome).not.toBe("off");
    expect(second.outcome).toBe("not-merged");
    expect(second.reason).toBe("gate-not-passed");
    expect(gh.calls).toHaveLength(0);
  });
});
