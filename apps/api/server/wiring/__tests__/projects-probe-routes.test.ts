// Project probe and unregistered routes: proves POST /v1/projects/:id/probe
// maps probed/not-found/rejected to HTTP statuses with the projectId from the
// route parameter, GET /v1/projects/unregistered lists work-order-only
// projects, the work-order guard rejects projects without a profile, and both
// routes answer 501 while unconfigured.
import "./nitro-globals.js";

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createApp,
  createRouter,
  toNodeListener,
  type EventHandler,
} from "h3";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { RegisterWorkOrderUseCase } from "@fleet/work-execution/use-cases";
import {
  WorkOrderRepositoryAdapter,
  type ProbeProjectRequest,
  type ProbeProjectResult,
} from "@fleet/work-execution";

import securityMiddleware from "../../middleware/security.js";
import { setActiveApiToken } from "../token.js";
import { createConfiguredOperatorComposition } from "../operator/composition";
import { configureFleetApiRuntime } from "../runtime.js";
import {
  configureWorkComposition,
  createConfiguredWorkComposition,
} from "../work/composition";

const VALID_TOKEN = "a".repeat(32);

function v2Installation() {
  return {
    schemaVersion: 2 as const,
    hosts: {
      orch: {
        transport: "local" as const,
        worktreeRoot: "/srv/fleet/orch",
        roles: ["orchestrator"] as const,
      },
      "runner-1": {
        transport: "local" as const,
        worktreeRoot: "/srv/fleet/runner-1",
        roles: ["lane-runner"] as const,
      },
    },
    forge: { mode: "none" as const },
    verification: { procedures: { verify: { command: "yarn verify" } } },
  };
}

function registerBody(
  projectId = "proj-a",
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    projectId,
    displayName: "Project A",
    repository: "fleet",
    designatedDispatcherHost: "orch",
    policyRevision: "policy-1",
    maxConcurrentLanes: 2,
    runnerCapabilities: { networkEgressRestricted: true },
    ...overrides,
  };
}

const WORK_ORDER_BODY = {
  workOrderId: "wo-guard-1",
  projectId: "proj-guard-1",
  taskId: "task-guard-1",
  laneId: "lane-guard-1",
  repository: "fleet",
  baseCommit: "abc1234",
  policyRevision: "policy-1",
  ownedPaths: ["apps/api/**"],
};

interface EnvelopeResult {
  outcome?: string;
  reason?: string;
  recorded?: boolean;
  report?: {
    checks?: Array<{ name: string; host: string | null; result: string; detail: string }>;
  };
  profile?: Record<string, unknown>;
  projects?: Array<{ projectId: string }>;
}

interface EnvelopeResponse {
  code?: string;
  result?: EnvelopeResult | null;
}

describe("project probe and unregistered routes", () => {
  let tempDir: string;
  let server: Server;
  let baseUrl: string;

  let projectsPostHandler: EventHandler;
  let projectGetHandler: EventHandler;
  let projectProbeHandler: EventHandler;
  let projectsUnregisteredHandler: EventHandler;
  let workOrdersPostHandler: EventHandler;

  beforeAll(async () => {
    projectsPostHandler = (await import("../../routes/v1/projects/index.post.js")).default;
    projectGetHandler = (await import("../../routes/v1/projects/[id].get.js")).default;
    projectProbeHandler = (
      await import("../../routes/v1/projects/[id]/probe.post.js")
    ).default;
    projectsUnregisteredHandler = (
      await import("../../routes/v1/projects/unregistered.get.js")
    ).default;
    workOrdersPostHandler = (await import("../../routes/v1/work-orders/index.post.js")).default;
  });

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "fleet-api-probe-"));
    setActiveApiToken(VALID_TOKEN);

    const app = createApp();
    app.use(securityMiddleware);
    const router = createRouter();
    router.post("/v1/projects", projectsPostHandler);
    router.get("/v1/projects/unregistered", projectsUnregisteredHandler);
    router.get("/v1/projects/:id", projectGetHandler);
    router.post("/v1/projects/:id/probe", projectProbeHandler);
    router.post("/v1/work-orders", workOrdersPostHandler);
    app.use(router.handler);

    server = createServer(toNodeListener(app));
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(tempDir, { recursive: true, force: true });
    configureFleetApiRuntime(null);
    setActiveApiToken(null);
    vi.restoreAllMocks();
  });

  function authHeaders(): Record<string, string> {
    return { authorization: `Bearer ${VALID_TOKEN}` };
  }

  async function call(method: string, path: string, body?: unknown) {
    const isGet = method === "GET";
    const payload = isGet ? undefined : JSON.stringify(body ?? {});
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: isGet
        ? authHeaders()
        : { ...authHeaders(), "content-type": "application/json" },
      body: payload,
    });
    return { status: res.status, body: (await res.json()) as EnvelopeResponse };
  }

  it("answers 404 for a probe of an unknown project", async () => {
    configureFleetApiRuntime({ stateDir: tempDir, installation: v2Installation() });

    const probed = await call("POST", "/v1/projects/unknown-project/probe");
    expect(probed.status).toBe(404);
    expect(probed.body.code).toBe("NOT_FOUND");
    expect(probed.body.result).toBeNull();
  });

  it("probes a registered project whose clone host is not in the installation and records the receipt", async () => {
    // The profile is seeded through an operator composition without an
    // installation, so a clone host outside the installation's hosts is
    // accepted; the runtime then loads the v2 installation for the probe.
    const seedOperator = createConfiguredOperatorComposition({ stateDir: tempDir });
    const seeded = await seedOperator.registerProjectProfile.execute(
      registerBody("proj-probe", {
        clones: {
          "missing-host": {
            path: "/srv/repos/proj-probe",
            worktreeRoot: "/srv/worktrees/proj-probe",
          },
        },
      }),
    );
    expect(seeded.outcome).toBe("registered");
    configureFleetApiRuntime({ stateDir: tempDir, installation: v2Installation() });

    const probed = await call("POST", "/v1/projects/proj-probe/probe");
    expect(probed.status).toBe(200);
    expect(probed.body.code).toBe("OK");
    expect(probed.body.result!.outcome).toBe("probed");
    expect(probed.body.result!.recorded).toBe(true);
    const hostReachable = probed.body.result!.report!.checks!.find(
      (check) => check.name === "host-reachable" && check.host === "missing-host",
    );
    expect(hostReachable).toBeDefined();
    expect(hostReachable!.result).toBe("unknown");
    expect(hostReachable!.detail).toBe("host missing-host is not in the installation");

    const read = await call("GET", "/v1/projects/proj-probe");
    expect(read.status).toBe(200);
    expect(read.body.result!.outcome).toBe("found");
    expect(read.body.result!.profile!.lastProbe).not.toBeNull();
  });

  it("lists a project that has work orders but no profile", async () => {
    configureFleetApiRuntime({ stateDir: tempDir, installation: v2Installation() });

    // Register the work order through a composition without the guard.
    const unguarded = new RegisterWorkOrderUseCase({
      workOrderRepo: new WorkOrderRepositoryAdapter({ stateDir: tempDir }),
    });
    const registered = await unguarded.registerWorkOrder({
      workOrderId: "wo-unregistered-1",
      projectId: "proj-unregistered-1",
      taskId: "task-1",
      laneId: "lane-1",
      repository: "https://example.com/unregistered.git",
      baseCommit: "abc1234",
      ownedPaths: ["packages/unregistered"],
      policyRevision: "policy-1",
    });
    expect(registered.outcome).toBe("registered");

    const listed = await call("GET", "/v1/projects/unregistered");
    expect(listed.status).toBe(200);
    expect(listed.body.result!.outcome).toBe("listed");
    expect(listed.body.result!.projects!.map((project) => project.projectId)).toContain(
      "proj-unregistered-1",
    );
  });

  it("refuses a work order for a project without a profile and registers it after the profile exists", async () => {
    configureFleetApiRuntime({ stateDir: tempDir, installation: v2Installation() });

    const refused = await call("POST", "/v1/work-orders", WORK_ORDER_BODY);
    expect(refused.status).toBe(200);
    expect(refused.body.result!.outcome).toBe("rejected");
    expect(refused.body.result!.reason).toContain("has no profile");

    const profiled = await call("POST", "/v1/projects", registerBody(WORK_ORDER_BODY.projectId));
    expect(profiled.status).toBe(200);
    expect(profiled.body.result!.outcome).toBe("registered");

    const registered = await call("POST", "/v1/work-orders", WORK_ORDER_BODY);
    expect(registered.status).toBe(200);
    expect(registered.body.result!.outcome).toBe("registered");
  });

  it("answers 501 on both routes while unconfigured", async () => {
    configureFleetApiRuntime(null);

    const probed = await call("POST", "/v1/projects/proj-x/probe");
    expect(probed.status).toBe(501);
    expect(probed.body.code).toBe("NOT_IMPLEMENTED");

    const listed = await call("GET", "/v1/projects/unregistered");
    expect(listed.status).toBe(501);
    expect(listed.body.code).toBe("NOT_IMPLEMENTED");
  });

  it("refuses a concurrent probe of the same project, padded or not, and caps probes overall", async () => {
    const composition = createConfiguredWorkComposition({ stateDir: tempDir });
    const releases = new Map<string, (result: ProbeProjectResult) => void>();
    const startedIds: string[] = [];
    let notifyStarted: () => void = () => undefined;

    const probedReport = {
      probedAtIso: "2026-10-25T00:00:00.000Z",
      probedFrom: "orchestrator" as const,
      checks: [
        { name: "host-reachable", host: null, result: "pass" as const, detail: "ok" },
      ],
      defaultBranch: "main",
      detectedScripts: [],
    };
    const done = (projectId: string): ProbeProjectResult => ({
      outcome: "probed",
      projectId,
      report: probedReport,
      recorded: true,
    });

    vi.spyOn(composition.probeProject, "execute").mockImplementation(
      async (input) => {
        const request = input as ProbeProjectRequest;
        if (request.projectId.startsWith("proj-held")) {
          startedIds.push(request.projectId);
          notifyStarted();
          return new Promise<ProbeProjectResult>((resolve) => {
            releases.set(request.projectId, resolve);
          });
        }
        return done(request.projectId);
      },
    );
    configureWorkComposition(composition);

    const waitForStarts = (count: number) =>
      new Promise<void>((resolve) => {
        notifyStarted = () => {
          if (startedIds.length >= count) resolve();
        };
        notifyStarted();
      });

    const firstPending = call("POST", "/v1/projects/proj-held/probe");
    let secondHeld: Promise<Awaited<ReturnType<typeof call>>> | undefined;
    try {
      await waitForStarts(1);

      const same = await call("POST", "/v1/projects/proj-held/probe");
      expect(same.status).toBe(409);
      expect(same.body.code).toBe("BUSY");
      expect(same.body.result!.reason).toBe("a probe of proj-held is already running");

      // A padded id is the same project: the use case trims it, so must the limiter.
      const padded = await call("POST", "/v1/projects/%20proj-held/probe");
      expect(padded.status).toBe(409);

      const other = await call("POST", "/v1/projects/proj-other/probe");
      expect(other.status).toBe(200);
      expect(other.body.code).toBe("OK");

      // A second held probe takes the last global slot; a third project is 429.
      secondHeld = call("POST", "/v1/projects/proj-held-2/probe");
      await waitForStarts(2);
      const over = await call("POST", "/v1/projects/proj-third/probe");
      expect(over.status).toBe(429);
      expect(over.body.code).toBe("BUSY");
      expect(over.body.result!.reason).toBe("probe capacity is busy; retry shortly");
    } finally {
      for (const [projectId, release] of releases) release(done(projectId));
    }
    const first = await firstPending;
    expect(first.status).toBe(200);
    if (secondHeld) expect((await secondHeld).status).toBe(200);
  });
});
