// H3b parity: for the same v2 installation, the CLI and API roots build an
// identical ExecutionRunnerHost, with every routing variable set in the
// environment and ignored (plan section 3, "Runtime reads the selected host,
// never the environment").

import { afterEach, describe, expect, it } from "vitest";

import { parseInstallation, type FleetInstallation } from "@fleet/installation";

import { createFleetCliRuntime } from "../../../../cli/src/composition.js";
import {
  createConfiguredWorkComposition,
  resolveWorkRunnerSettings,
} from "../work/composition";

/** Every routing variable the roots must ignore for a v2 installation. */
const ROUTING_ENV: Record<string, string> = {
  OCM_REMOTE_PORT: "59999",
  OCM_HOST: "stale-tunnel-host",
  FLEET_WORKTREE_SSH_HOST: "stale-worktree-host",
  FLEET_RUNNER_AGENT: "stale-agent",
  FLEET_RUNNER_MODEL: "stale/model",
  FLEET_RUNNER_VARIANT: "stale-variant",
};

const savedEnv: Record<string, string | undefined> = {};

function withRoutingEnv(): void {
  for (const [key, value] of Object.entries(ROUTING_ENV)) {
    savedEnv[key] = process.env[key];
    process.env[key] = value;
  }
}

function restoreEnv(): void {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

/** Parse one v2 installation through the loader; a failure fails the test. */
function parseV2(file: unknown): FleetInstallation {
  const result = parseInstallation(file);
  if (!result.ok) {
    throw new Error(
      `test installation failed to parse: ${JSON.stringify(result.errors)}`,
    );
  }
  return result.installation;
}

describe("v2 runner-host parity between the CLI and API roots", () => {
  afterEach(restoreEnv);

  it("builds an identical ExecutionRunnerHost for a single-machine v2 installation", () => {
    withRoutingEnv();
    const installation = parseV2({
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

    const cli = createFleetCliRuntime({ installation });
    const api = createConfiguredWorkComposition({ installation });

    expect(api.runnerHost).toBeDefined();
    expect(cli.execution.runnerHost).toEqual(api.runnerHost);
    expect(cli.execution.runnerHost).toEqual({
      hostName: "here",
      transport: "local",
      remotePort: 46000,
      authFile: "/run/fleet/opencode-auth",
    });
    // The environment is ignored: the port comes from the host entry, and a
    // local host is dialled directly (no OCM_HOST alias from the environment).
    expect(cli.execution.runner.configuredRemotePort()).toBe(46000);
    expect(cli.execution.runner.configuredRemoteHost()).toBeNull();
  });

  it("builds an identical ExecutionRunnerHost for a multi-machine v2 installation", () => {
    withRoutingEnv();
    const installation = parseV2({
      schemaVersion: 2,
      forge: { mode: "none" },
      hosts: {
        here: {
          transport: "local",
          worktreeRoot: "/srv/fleet/worktrees",
          roles: ["orchestrator", "verifier"],
        },
        midnight: {
          transport: "ssh",
          sshAlias: "m",
          worktreeRoot: "/mnt/pool/cloud-services/projects/.worktrees/fleet-v2",
          roles: ["lane-runner"],
          runner: {
            kind: "opencode",
            port: 4166,
            authFile: "/run/fleet/midnight-auth",
          },
        },
      },
    });

    const cli = createFleetCliRuntime({ installation });
    const api = createConfiguredWorkComposition({ installation });

    expect(api.runnerHost).toBeDefined();
    expect(cli.execution.runnerHost).toEqual(api.runnerHost);
    expect(cli.execution.runnerHost).toEqual({
      hostName: "midnight",
      transport: "ssh",
      sshAlias: "m",
      remotePort: 4166,
      authFile: "/run/fleet/midnight-auth",
    });
    // The stale environment alias never routes the lane to another machine.
    expect(cli.execution.runner.configuredRemoteHost()).toBe("m");
  });

  it("keeps legacy mode (no host) for a v1 installation in both roots", () => {
    withRoutingEnv();
    const installation = parseV2({
      schemaVersion: 1,
      runner: {
        agent: "lane-glm",
        model: "glm-5.3",
        remotePort: 4321,
        host: "tunnel-host",
      },
      worktree: { sshHost: "midnight" },
      forge: { owner: "o", repo: "r" },
    });

    const cli = createFleetCliRuntime({ installation });
    const api = createConfiguredWorkComposition({ installation });

    expect(cli.execution.runnerHost).toBeUndefined();
    expect(api.runnerHost).toBeUndefined();
    // Legacy mode keeps today's environment-based behaviour: the recorded
    // installation runner port wins over the (stale) environment in both
    // roots, and the parity object is absent in both.
    expect(cli.execution.runner.configuredRemotePort()).toBe(4321);
  });
});

describe("v2 API runner settings ignore the routing environment (H3b)", () => {
  it("resolves only the ocm-run binary path for a v2 installation", () => {
    withRoutingEnv();
    const installation = parseV2({
      schemaVersion: 2,
      forge: { mode: "none" },
      hosts: {
        here: {
          transport: "local",
          worktreeRoot: "/srv/fleet/worktrees",
          roles: ["orchestrator", "lane-runner", "verifier"],
          runner: { kind: "opencode", port: 46000 },
        },
      },
    });
    const resolved = resolveWorkRunnerSettings(
      {
        installation,
        worktreeSshHost: "operator-override",
        runnerRemotePort: 1234,
        runnerRemoteHost: "operator-tunnel",
      },
      undefined,
      { ...ROUTING_ENV, FLEET_OCM_RUN_BIN: "/opt/env/ocm-run" },
    );
    expect(resolved).toEqual({ ocmRunBin: "/opt/env/ocm-run" });
  });
});
