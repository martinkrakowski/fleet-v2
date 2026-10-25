// Project routes: proves the /v1/projects read, register, edit and retire
// routes forward to exactly one operator use case, map the outcome envelopes to
// HTTP statuses, override any body projectId with the route parameter, and
// answer 501 while unconfigured. A v2 installation with hosts `orch`,
// `runner-1` and procedure `verify` is loaded so the registration and update
// name checks are exercised.
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

import securityMiddleware from "../../middleware/security.js";
import { setActiveApiToken } from "../token.js";
import { configureFleetApiRuntime } from "../runtime.js";

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

describe("project routes", () => {
  let tempDir: string;
  let server: Server;
  let baseUrl: string;

  let projectsGetHandler: EventHandler;
  let projectGetHandler: EventHandler;
  let projectsPostHandler: EventHandler;
  let projectPatchHandler: EventHandler;
  let projectRetireHandler: EventHandler;

  beforeAll(async () => {
    projectsGetHandler = (await import("../../routes/v1/projects/index.get.js")).default;
    projectGetHandler = (await import("../../routes/v1/projects/[id].get.js")).default;
    projectsPostHandler = (await import("../../routes/v1/projects/index.post.js")).default;
    projectPatchHandler = (await import("../../routes/v1/projects/[id].patch.js")).default;
    projectRetireHandler = (
      await import("../../routes/v1/projects/[id]/retire.post.js")
    ).default;
  });

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "fleet-api-projects-"));
    setActiveApiToken(VALID_TOKEN);
    configureFleetApiRuntime({ stateDir: tempDir, installation: v2Installation() });

    const app = createApp();
    app.use(securityMiddleware);
    const router = createRouter();
    router.get("/v1/projects", projectsGetHandler);
    router.get("/v1/projects/:id", projectGetHandler);
    router.post("/v1/projects", projectsPostHandler);
    router.patch("/v1/projects/:id", projectPatchHandler);
    router.post("/v1/projects/:id/retire", projectRetireHandler);
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

  interface EnvelopeResult {
    outcome?: string;
    reason?: string;
    profile?: Record<string, unknown>;
    profiles?: Array<Record<string, unknown>>;
  }

  interface EnvelopeResponse {
    code?: string;
    result?: EnvelopeResult | null;
  }

  async function registerProject(
    body: Record<string, unknown>,
  ): Promise<{ status: number; body: EnvelopeResponse }> {
    const res = await fetch(`${baseUrl}/v1/projects`, {
      method: "POST",
      headers: { ...authHeaders(), "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as EnvelopeResponse };
  }

  it("refuses a GET without a bearer token with 401", async () => {
    const res = await fetch(`${baseUrl}/v1/projects/proj-a`);
    expect(res.status).toBe(401);
  });

  it("refuses a PATCH without a bearer token with 401", async () => {
    const res = await fetch(`${baseUrl}/v1/projects/proj-a`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expectedRevision: 0,
        changes: { displayName: "Unauthorized" },
      }),
    });
    expect(res.status).toBe(401);
  });

  it("refuses a PATCH without content-type: application/json with 415", async () => {
    const res = await fetch(`${baseUrl}/v1/projects/proj-a`, {
      method: "PATCH",
      headers: authHeaders(),
      body: JSON.stringify({
        expectedRevision: 0,
        changes: { displayName: "Unsupported Media Type" },
      }),
    });
    expect(res.status).toBe(415);
  });

  it("refuses POST /v1/projects with an array JSON body with 400 BAD_REQUEST", async () => {
    const res = await fetch(`${baseUrl}/v1/projects`, {
      method: "POST",
      headers: { ...authHeaders(), "content-type": "application/json" },
      body: JSON.stringify([]),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("BAD_REQUEST");
    expect(body.result).toBeNull();
  });

  it("registers a project and reads it back by id with revision 0", async () => {
    const registered = await registerProject(registerBody());
    expect(registered.status).toBe(200);
    expect(registered.body.code).toBe("OK");
    expect(registered.body.result!.outcome).toBe("registered");
    expect(registered.body.result!.profile!.revision).toBe(0);

    const read = await fetch(`${baseUrl}/v1/projects/proj-a`, {
      headers: authHeaders(),
    });
    expect(read.status).toBe(200);
    const readBody = await read.json();
    expect(readBody.result.outcome).toBe("found");
    expect(readBody.result.profile.projectId).toBe("proj-a");
    expect(readBody.result.profile.revision).toBe(0);
  });

  it("refuses registering the same id again with the already registered reason", async () => {
    await registerProject(registerBody());

    const duplicate = await registerProject(registerBody());
    expect(duplicate.status).toBe(422);
    expect(duplicate.body.code).toBe("REFUSED");
    expect(duplicate.body.result!.reason).toContain("already registered");
  });

  it("refuses registering an unknown dispatcher host with the installation-name reason", async () => {
    const refused = await registerProject(
      registerBody("proj-b", { designatedDispatcherHost: "bogus-host" }),
    );
    expect(refused.status).toBe(422);
    expect(refused.body.code).toBe("REFUSED");
    expect(refused.body.result!.reason).toContain("not a host in the installation");
  });

  it("answers 404 for an unknown project id", async () => {
    const missing = await fetch(`${baseUrl}/v1/projects/unknown-id`, {
      headers: authHeaders(),
    });
    expect(missing.status).toBe(404);
    const missingBody = await missing.json();
    expect(missingBody.code).toBe("NOT_FOUND");
    expect(missingBody.result).toBeNull();
  });

  it("lists active profiles and refuses a bogus status with 422", async () => {
    await registerProject(registerBody());

    const list = await fetch(`${baseUrl}/v1/projects?status=active`, {
      headers: authHeaders(),
    });
    expect(list.status).toBe(200);
    const listBody = await list.json();
    expect(listBody.result.outcome).toBe("listed");
    expect(listBody.result.profiles).toHaveLength(1);
    expect(listBody.result.profiles[0].projectId).toBe("proj-a");

    const bogus = await fetch(`${baseUrl}/v1/projects?status=bogus`, {
      headers: authHeaders(),
    });
    expect(bogus.status).toBe(422);
    const bogusBody = await bogus.json();
    expect(bogusBody.code).toBe("REFUSED");
    expect(bogusBody.result.reason).toContain("status must be active or retired");
  });

  it("PATCHes with the read revision and bumps to revision 1", async () => {
    await registerProject(registerBody());

    const updated = await fetch(`${baseUrl}/v1/projects/proj-a`, {
      method: "PATCH",
      headers: { ...authHeaders(), "content-type": "application/json" },
      body: JSON.stringify({
        expectedRevision: 0,
        changes: { displayName: "Project A Updated" },
      }),
    });
    expect(updated.status).toBe(200);
    const updatedBody = await updated.json();
    expect(updatedBody.result.outcome).toBe("updated");
    expect(updatedBody.result.profile.displayName).toBe("Project A Updated");
    expect(updatedBody.result.profile.revision).toBe(1);
  });

  it("refuses a stale PATCH revision with the revision reason", async () => {
    await registerProject(registerBody());

    const stale = await fetch(`${baseUrl}/v1/projects/proj-a`, {
      method: "PATCH",
      headers: { ...authHeaders(), "content-type": "application/json" },
      body: JSON.stringify({
        expectedRevision: 5,
        changes: { displayName: "Stale" },
      }),
    });
    expect(stale.status).toBe(422);
    const staleBody = await stale.json();
    expect(staleBody.code).toBe("REFUSED");
    expect(staleBody.result.reason).toContain("revision");

    const read = await fetch(`${baseUrl}/v1/projects/proj-a`, {
      headers: authHeaders(),
    });
    expect(read.status).toBe(200);
    const readBody = await read.json();
    expect(readBody.result.profile.revision).toBe(0);
    expect(readBody.result.profile.displayName).toBe("Project A");
  });

  it("refuses forbidden or unknown PATCH changes and leaves revision at 0", async () => {
    await registerProject(registerBody());

    for (const changes of [
      { status: "retired" },
      { revision: 9 },
      { lastProbe: null },
      { runnerCapabilities: { apiToken: true } },
    ]) {
      const refused = await fetch(`${baseUrl}/v1/projects/proj-a`, {
        method: "PATCH",
        headers: { ...authHeaders(), "content-type": "application/json" },
        body: JSON.stringify({
          expectedRevision: 0,
          changes,
        }),
      });
      expect(refused.status).toBe(422);
      const refusedBody = await refused.json();
      expect(refusedBody.code).toBe("REFUSED");

      const read = await fetch(`${baseUrl}/v1/projects/proj-a`, {
        headers: authHeaders(),
      });
      expect(read.status).toBe(200);
      const readBody = await read.json();
      expect(readBody.result.profile.revision).toBe(0);
    }
  });

  it("lets the route id override a differing body projectId on PATCH", async () => {
    await registerProject(registerBody());

    const updated = await fetch(`${baseUrl}/v1/projects/proj-a`, {
      method: "PATCH",
      headers: { ...authHeaders(), "content-type": "application/json" },
      body: JSON.stringify({
        projectId: "other-project",
        expectedRevision: 0,
        changes: { displayName: "Route Wins" },
      }),
    });
    expect(updated.status).toBe(200);
    const updatedBody = await updated.json();
    expect(updatedBody.result.outcome).toBe("updated");
    expect(updatedBody.result.profile.projectId).toBe("proj-a");
    expect(updatedBody.result.profile.displayName).toBe("Route Wins");

    // The body's projectId was discarded: the other id never got a profile.
    const other = await fetch(`${baseUrl}/v1/projects/other-project`, {
      headers: authHeaders(),
    });
    expect(other.status).toBe(404);
  });

  it("refuses a stale retire with the revision reason and leaves the profile active", async () => {
    await registerProject(registerBody());

    const stale = await fetch(`${baseUrl}/v1/projects/proj-a/retire`, {
      method: "POST",
      headers: { ...authHeaders(), "content-type": "application/json" },
      body: JSON.stringify({ expectedRevision: 5 }),
    });
    expect(stale.status).toBe(422);
    const staleBody = await stale.json();
    expect(staleBody.code).toBe("REFUSED");
    expect(staleBody.result.reason).toContain("revision");

    const read = await fetch(`${baseUrl}/v1/projects/proj-a`, {
      headers: authHeaders(),
    });
    expect(read.status).toBe(200);
    const readBody = await read.json();
    expect(readBody.result.profile.status).toBe("active");
    expect(readBody.result.profile.revision).toBe(0);
  });

  it("retires a project and refuses a second retire", async () => {
    await registerProject(registerBody());

    const retired = await fetch(`${baseUrl}/v1/projects/proj-a/retire`, {
      method: "POST",
      headers: { ...authHeaders(), "content-type": "application/json" },
      body: JSON.stringify({ expectedRevision: 0 }),
    });
    expect(retired.status).toBe(200);
    const retiredBody = await retired.json();
    expect(retiredBody.result.outcome).toBe("retired");
    expect(retiredBody.result.profile.status).toBe("retired");
    expect(retiredBody.result.profile.revision).toBe(1);

    const again = await fetch(`${baseUrl}/v1/projects/proj-a/retire`, {
      method: "POST",
      headers: { ...authHeaders(), "content-type": "application/json" },
      body: JSON.stringify({ expectedRevision: 1 }),
    });
    expect(again.status).toBe(422);
    const againBody = await again.json();
    expect(againBody.code).toBe("REFUSED");
    expect(againBody.result.reason).toContain("already retired");
  });

  it("answers 501 on a list while unconfigured", async () => {
    configureFleetApiRuntime(null);

    const res = await fetch(`${baseUrl}/v1/projects`);
    expect(res.status).toBe(501);
    const body = await res.json();
    expect(body.code).toBe("NOT_IMPLEMENTED");
  });
});
