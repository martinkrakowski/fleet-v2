/**
 * `capacity reserve` refusals and host selection at the CLI boundary. The
 * runtime's reserve use case is replaced by a fake that records every request,
 * so each refusal is proved by an exit code of 2 together with an empty call
 * log. Fixture hosts are neutral names, never real machines.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { parseInstallation, type FleetInstallation } from "@fleet/installation";
import type {
  ReserveExecutionCapacityRequest,
  ReserveExecutionCapacityResult,
} from "@fleet/work-execution";

import { createFleetCliRuntime, type FleetCliRuntime } from "../composition.js";
import { laneRunnerCandidateHosts } from "../conductor-wiring.js";
import { runCli, type CliIo } from "../index.js";

function parseV2(file: unknown): FleetInstallation {
  const result = parseInstallation(file);
  if (!result.ok || result.installation === undefined) {
    throw new Error(
      `fixture failed to parse: ${result.ok ? "missing installation" : JSON.stringify(result.errors)}`,
    );
  }
  return result.installation;
}

const laneRunnerInstallation = parseV2({
  schemaVersion: 2,
  forge: { mode: "none" },
  hosts: {
    "host-a": {
      transport: "local",
      worktreeRoot: "/srv/fleet/worktrees",
      roles: ["orchestrator", "lane-runner", "verifier"],
      runner: { kind: "opencode", port: 46000, authFile: "/run/fleet/opencode-auth" },
    },
  },
});

// The parser demands a lane-runner host, so the "declares none" shape is the
// valid installation with its host demoted to an orchestrator-only role.
const noLaneRunnerInstallation = {
  ...laneRunnerInstallation,
  hosts: {
    "host-b": {
      transport: "local",
      worktreeRoot: "/srv/fleet/worktrees",
      roles: ["orchestrator"],
    },
  },
} as unknown as FleetInstallation;

const BASE_PAYLOAD = {
  reservationId: "res-1",
  attemptId: "attempt-1",
  workOrderId: "wo-1",
};

type Fake = {
  calls: ReserveExecutionCapacityRequest[];
  result: ReserveExecutionCapacityResult | Error;
};

describe("capacity reserve refusals and host selection", () => {
  const stateDirs: string[] = [];

  afterEach(() => {
    for (const dir of stateDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function compose(
    installation: FleetInstallation | undefined,
    runnerMaxLanes: number | undefined,
    result: ReserveExecutionCapacityResult | Error,
  ): { runtime: FleetCliRuntime; fake: Fake } {
    const stateDir = mkdtempSync(path.join(tmpdir(), "fleet-v2-capacity-"));
    stateDirs.push(stateDir);
    const runtime = createFleetCliRuntime({ stateDir, installation });
    const fake: Fake = { calls: [], result };
    (runtime.execution as { reserveExecutionCapacity: unknown }).reserveExecutionCapacity = {
      reserveExecutionCapacity: async (request: ReserveExecutionCapacityRequest) => {
        fake.calls.push(request);
        if (fake.result instanceof Error) {
          throw fake.result;
        }
        return fake.result;
      },
    };
    (runtime.execution as { runnerMaxLanes?: number }).runnerMaxLanes = runnerMaxLanes;
    return { runtime, fake };
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

  async function reserve(
    runtime: FleetCliRuntime,
    payload: Record<string, unknown>,
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    const { io, stdout, stderr } = mockIo();
    const code = await runCli(
      ["capacity", "reserve", "--json", JSON.stringify({ ...BASE_PAYLOAD, ...payload })],
      io,
      runtime,
    );
    return { code, stdout: stdout.join(""), stderr: stderr.join("") };
  }

  const reservedResult = {
    outcome: "reserved",
    reservation: {
      hostId: "host-a",
      hostName: "host-a",
      hostKind: "opencode",
      worktreePath: "/srv/fleet/worktrees/0123456789abcdef0123456789abcdef",
    },
  } as unknown as ReserveExecutionCapacityResult;

  const v1Reserved = { outcome: "reserved", reservation: {} } as unknown as ReserveExecutionCapacityResult;
  const v1Payload = { hostId: "host-1", worktreePath: "/srv/fleet/wt", seatTool: "opencode" };

  it("v2 installation: reserves with the installation's lane-runner candidate hosts and reports the chosen host fields", async () => {
    const { runtime, fake } = compose(laneRunnerInstallation, undefined, reservedResult);
    const { code, stdout } = await reserve(runtime, { seatTool: "opencode" });
    expect(code).toBe(0);
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.candidateHosts).toEqual(laneRunnerCandidateHosts(laneRunnerInstallation));
    expect(fake.calls[0]?.candidateHosts?.map((h) => h.name)).toEqual(["host-a"]);
    expect(fake.calls[0]?.seatTool).toBe("opencode");
    const out = JSON.parse(stdout) as Record<string, unknown>;
    expect(out["chosenHost"]).toBe("host-a");
    expect(out["chosenHostKind"]).toBe("opencode");
    expect(out["worktreePath"]).toBe("/srv/fleet/worktrees/0123456789abcdef0123456789abcdef");
  });

  it("v2 installation: refuses --hostId with exit 2 and never calls reserveExecutionCapacity", async () => {
    const { runtime, fake } = compose(laneRunnerInstallation, undefined, reservedResult);
    const { code, stderr } = await reserve(runtime, { seatTool: "opencode", hostId: "host-x" });
    expect(code).toBe(2);
    expect(stderr).toContain("'hostId' is not accepted for a v2 installation");
    expect(fake.calls).toEqual([]);
  });

  it("v2 installation: refuses --maxSlots with exit 2 and never calls reserveExecutionCapacity", async () => {
    const { runtime, fake } = compose(laneRunnerInstallation, undefined, reservedResult);
    const { code, stderr } = await reserve(runtime, { seatTool: "opencode", maxSlots: 2 });
    expect(code).toBe(2);
    expect(stderr).toContain("'maxSlots' is not accepted for a v2 installation");
    expect(fake.calls).toEqual([]);
  });

  it("v2 installation: refuses --worktreePath with exit 2 and never calls reserveExecutionCapacity", async () => {
    const { runtime, fake } = compose(laneRunnerInstallation, undefined, reservedResult);
    const { code, stderr } = await reserve(runtime, { seatTool: "opencode", worktreePath: "/srv/x" });
    expect(code).toBe(2);
    expect(stderr).toContain("'worktreePath' is not accepted for a v2 installation");
    expect(fake.calls).toEqual([]);
  });

  it("v2 installation: refuses when no lane-runner host is declared with exit 2 and never calls reserveExecutionCapacity", async () => {
    expect(laneRunnerCandidateHosts(noLaneRunnerInstallation)).toEqual([]);
    const { runtime, fake } = compose(noLaneRunnerInstallation, undefined, reservedResult);
    const { code, stderr } = await reserve(runtime, { seatTool: "opencode" });
    expect(code).toBe(2);
    expect(stderr).toContain("the installation declares no lane-runner host");
    expect(fake.calls).toEqual([]);
  });

  it("v2 installation: refuses absent --seatTool with exit 2 and never calls reserveExecutionCapacity", async () => {
    const { runtime, fake } = compose(laneRunnerInstallation, undefined, reservedResult);
    const { code, stderr } = await reserve(runtime, {});
    expect(code).toBe(2);
    expect(stderr).toContain("capacity reserve requires --seatTool");
    expect(fake.calls).toEqual([]);
  });

  it("v2 installation: refuses undeclared --seatTool with exit 2 and never calls reserveExecutionCapacity", async () => {
    for (const seatTool of ["", "  ", "unknown-tool", "OPENCODE"]) {
      const { runtime, fake } = compose(laneRunnerInstallation, undefined, reservedResult);
      const { code, stderr } = await reserve(runtime, { seatTool });
      expect(code).toBe(2);
      expect(stderr).toContain("capacity reserve requires --seatTool");
      expect(fake.calls).toEqual([]);
    }
  });

  it("v2 installation: returns exit 1 without chosenHost fields when outcome is not reserved", async () => {
    const outcomes: ReserveExecutionCapacityResult[] = [
      { outcome: "no-capacity" },
      { outcome: "no-free-slot", heldCount: 1, maxSlots: 1 },
      { outcome: "busy-worktree", blockingAttemptId: "attempt-0" },
      { outcome: "refused", reason: "no candidate matches the seat tool" },
    ];
    for (const result of outcomes) {
      const { runtime, fake } = compose(laneRunnerInstallation, undefined, result);
      const { code, stdout } = await reserve(runtime, { seatTool: "opencode" });
      expect(code).toBe(1);
      expect(fake.calls).toHaveLength(1);
      const out = JSON.parse(stdout) as Record<string, unknown>;
      expect(out["outcome"]).toBe(result.outcome);
      expect(out).not.toHaveProperty("chosenHost");
      expect(out).not.toHaveProperty("chosenHostKind");
      expect(out).not.toHaveProperty("worktreePath");
    }
  });

  it("v1 / no installation: passes the declared runnerMaxLanes as maxSlots when --maxSlots matches or is omitted", async () => {
    for (const extra of [{ maxSlots: 3 }, {}]) {
      const { runtime, fake } = compose(undefined, 3, v1Reserved);
      const { code } = await reserve(runtime, { ...v1Payload, ...extra });
      expect(code).toBe(0);
      expect(fake.calls).toHaveLength(1);
      expect(fake.calls[0]?.maxSlots).toBe(3);
      expect(fake.calls[0]?.candidateHosts).toBeUndefined();
    }
  });

  it("v1 / no installation: uses --maxSlots when no runnerMaxLanes is declared and defaults to 1 when both are absent", async () => {
    const withSlots = compose(undefined, undefined, v1Reserved);
    expect((await reserve(withSlots.runtime, { ...v1Payload, maxSlots: 4 })).code).toBe(0);
    expect(withSlots.fake.calls[0]?.maxSlots).toBe(4);

    const without = compose(undefined, undefined, v1Reserved);
    expect((await reserve(without.runtime, v1Payload)).code).toBe(0);
    expect(without.fake.calls[0]?.maxSlots).toBe(1);
  });

  it("v1 / no installation: refuses --maxSlots conflicting with declared runnerMaxLanes with exit 2 and never calls reserveExecutionCapacity", async () => {
    const { runtime, fake } = compose(undefined, 2, v1Reserved);
    const { code, stderr } = await reserve(runtime, { ...v1Payload, maxSlots: 5 });
    expect(code).toBe(2);
    expect(stderr).toContain("'--maxSlots 5' conflicts with the runner's declared maxLanes 2");
    expect(fake.calls).toEqual([]);
  });

  it("v1 / no installation: refuses absent --seatTool with exit 2 and never calls reserveExecutionCapacity", async () => {
    const { runtime, fake } = compose(undefined, undefined, v1Reserved);
    const { code, stderr } = await reserve(runtime, { hostId: "host-1", worktreePath: "/srv/fleet/wt" });
    expect(code).toBe(2);
    expect(stderr).toContain("capacity reserve requires --seatTool");
    expect(fake.calls).toEqual([]);
  });

  it("v1 / no installation: refuses undeclared --seatTool with exit 2 and never calls reserveExecutionCapacity", async () => {
    for (const seatTool of ["", "unknown-tool", "OPENCODE"]) {
      const { runtime, fake } = compose(undefined, undefined, v1Reserved);
      const { code, stderr } = await reserve(runtime, { ...v1Payload, seatTool });
      expect(code).toBe(2);
      expect(stderr).toContain("capacity reserve requires --seatTool");
      expect(fake.calls).toEqual([]);
    }
  });

  it("returns exit 1 and writes error to stderr when reserveExecutionCapacity rejects", async () => {
    const { runtime, fake } = compose(laneRunnerInstallation, undefined, new Error("journal unavailable"));
    const { code, stdout, stderr } = await reserve(runtime, { seatTool: "opencode" });
    expect(code).toBe(1);
    expect(fake.calls).toHaveLength(1);
    expect(stderr).toBe("error: journal unavailable\n");
    expect(stdout).toBe("");
  });
});
