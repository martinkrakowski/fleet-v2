/**
 * H3b: for a v2 installation the CLI roots read the selected host and never
 * take a host name from the operator. The reserve and verification hosts come
 * from the installation's hosts entry, an operator-supplied `hostId` is a
 * usage error (exit 2), and the routing environment is ignored.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { parseInstallation, type FleetInstallation } from "@fleet/installation";

import {
  createFleetCliRuntime,
  resolveRunnerSettings,
  type FleetCliRuntime,
} from "../composition.js";
import { runCli, type CliIo } from "../index.js";

/** A single-machine v2 installation: one local host carrying every role. */
function parseV2(file: unknown): FleetInstallation {
  const result = parseInstallation(file);
  if (!result.ok || result.installation === undefined) {
    throw new Error(
      `fixture failed to parse: ${result.ok ? "missing installation" : JSON.stringify(result.errors)}`,
    );
  }
  return result.installation;
}

const v2Installation = parseV2({
  schemaVersion: 2,
  forge: { mode: "none" },
  hosts: {
    here: {
      transport: "local",
      worktreeRoot: "/srv/fleet/worktrees",
      roles: ["orchestrator", "lane-runner", "verifier"],
      runner: {
        kind: "opencode",
        port: 46000,
        authFile: "/run/fleet/opencode-auth",
      },
    },
  },
});

describe("v2 CLI host selection (H3b)", () => {
  let stateDir: string;
  let runtime: FleetCliRuntime;

  afterAll(() => {
    if (stateDir !== undefined) {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  function compose(): void {
    stateDir = mkdtempSync(path.join(tmpdir(), "fleet-v2-host-"));
    runtime = createFleetCliRuntime({ stateDir, installation: v2Installation });
  }

  function mockIo(): { io: CliIo; stdout: string[]; stderr: string[] } {
    const stdout: string[] = [];
    const stderr: string[] = [];
    return {
      io: { stdout: (t) => stdout.push(t), stderr: (t) => stderr.push(t) },
      stdout,
      stderr,
    };
  }

  it("refuses an operator hostId for capacity reserve with a usage error naming the installation field", async () => {
    compose();
    const { io, stderr } = mockIo();
    const code = await runCli(
      [
        "capacity",
        "reserve",
        "--json",
        JSON.stringify({
          reservationId: "res-v2-1",
          attemptId: "attempt-v2-1",
          workOrderId: "wo-v2-1",
          hostId: "operator-typed-host",
          worktreePath: stateDir,
        }),
      ],
      io,
      runtime,
    );
    expect(code).toBe(2);
    expect(stderr.join("")).toContain(
      "'hostId' is not accepted for a v2 installation; the host comes from the installation's hosts entry",
    );
  });

  it("records the installation lane-runner host name when the operator passes none", async () => {
    compose();
    const { io, stdout } = mockIo();
    const code = await runCli(
      [
        "capacity",
        "reserve",
        "--json",
        JSON.stringify({
          reservationId: "res-v2-2",
          attemptId: "attempt-v2-2",
          workOrderId: "wo-v2-2",
          worktreePath: stateDir,
          seatTool: "opencode",
        }),
      ],
      io,
      runtime,
    );
    expect(code).toBe(0);
    const result = JSON.parse(stdout.join("")) as {
      outcome: string;
      reservation: { hostId: string };
    };
    expect(result.outcome).toBe("reserved");
    expect(result.reservation.hostId).toBe("here");
  });

  it("refuses an operator hostId for evidence request-verification with a usage error", async () => {
    compose();
    const { io, stderr } = mockIo();
    const code = await runCli(
      [
        "evidence",
        "request-verification",
        "--json",
        JSON.stringify({
          assessmentId: "assess-v2-1",
          projectId: "proj-v2-1",
          attemptId: "attempt-v2-1",
          candidateHeadSha: "a".repeat(40),
          policyRevision: "policy-1",
          hostId: "operator-typed-host",
          requiredChecks: [],
        }),
      ],
      io,
      runtime,
    );
    expect(code).toBe(2);
    expect(stderr.join("")).toContain(
      "'hostId' is not accepted for a v2 installation; the host comes from the installation's hosts entry",
    );
  });

  it("ignores the routing environment and the worktreeSshHost override for v2", () => {
    const resolved = resolveRunnerSettings(
      {
        installation: v2Installation,
        worktreeSshHost: "operator-override",
        runnerRemotePort: 1234,
        runnerRemoteHost: "operator-tunnel",
      },
      undefined,
      {
        OCM_REMOTE_PORT: "59999",
        OCM_HOST: "stale-tunnel-host",
        FLEET_WORKTREE_SSH_HOST: "stale-worktree-host",
        FLEET_RUNNER_AGENT: "stale-agent",
        FLEET_OCM_RUN_BIN: "/opt/env/ocm-run",
      },
    );
    // Only the ocm-run binary path stays environmental; every routing value
    // is absent and the host entry is the sole source.
    expect(resolved).toEqual({ ocmRunBin: "/opt/env/ocm-run" });
  });

  it("falls back to the orchestrator host for local verification when no host is a verifier (H4 follow-up)", async () => {
    const installation = parseV2({
      schemaVersion: 2,
      forge: { mode: "none" },
      hosts: {
        here: {
          transport: "local",
          worktreeRoot: "/srv/fleet/worktrees",
          roles: ["orchestrator", "lane-runner"],
          runner: { kind: "opencode", port: 46000 },
        },
      },
    });
    stateDir = mkdtempSync(path.join(tmpdir(), "fleet-v2-host-"));
    runtime = createFleetCliRuntime({ stateDir, installation });
    await runtime.execution.attemptRepository.saveAttempt({
      id: "attempt-nv-1",
      workOrderId: "wo-nv-1",
      kind: "initial",
      fixNumber: 0,
      priorAttemptId: null,
      worktreePath: "/srv/fleet/worktrees/attempt-nv-1",
      baseCommit: "0".repeat(40),
      state: "ended",
      outcome: "done",
      briefDigest: null,
      briefPackagePath: null,
      sessionId: null,
      completionReceipt: null,
      artifacts: null,
      runner: {
        kind: "opencode",
        remotePort: 46000,
        host: null,
        hostName: "here",
        agent: "lane",
        model: "provider/glm-5.3",
        variant: null,
      },
      createdAtIso: "2026-10-17T08:00:00.000Z",
      updatedAtIso: "2026-10-17T08:00:00.000Z",
    });
    const { io, stdout, stderr } = mockIo();
    const code = await runCli(
      [
        "evidence",
        "request-verification",
        "--json",
        JSON.stringify({
          assessmentId: "assess-nv-1",
          projectId: "proj-nv-1",
          attemptId: "attempt-nv-1",
          candidateHeadSha: "a".repeat(40),
          policyRevision: "policy-nv-1",
          requiredChecks: ["gate"],
        }),
      ],
      io,
      runtime,
    );
    // No refusal: the request records the orchestrator host as the
    // verification host, and the receipts carry it.
    expect(code).toBe(0);
    expect(stderr.join("")).not.toContain("declares no verifier host");
    const result = JSON.parse(stdout.join("")) as {
      outcome: string;
      receipts: ReadonlyArray<{ hostId: string }>;
    };
    expect(result.outcome).toBe("completed");
    expect(result.receipts[0]?.hostId).toBe("here");
  });
});
