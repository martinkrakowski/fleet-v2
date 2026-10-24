// L17a: GET /v1/attempts lists recorded attempts through the real route
// handler on a loopback server with a temp state dir.
import "./nitro-globals.js";

import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createApp, createRouter, toNodeListener } from "h3";
import { afterEach, afterAll, beforeAll, describe, expect, it } from "vitest";

import { AttemptRepositoryAdapter, WorkOrderRepositoryAdapter } from "@fleet/work-execution";

import {
  configureWorkComposition,
  createConfiguredWorkComposition,
} from "../work/composition";
import attemptsIndexGet from "../../routes/v1/attempts/index.get";

const createdDirs = new Set<string>();

async function makeTempDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "fleet-attempts-list-route-"));
  createdDirs.add(directory);
  return directory;
}

let apiBaseUrl = "";
let apiServer: Server;

beforeAll(async () => {
  const router = createRouter();
  router.add("/v1/attempts", attemptsIndexGet, "get");
  const app = createApp();
  app.use(router);
  apiServer = createServer(toNodeListener(app));
  await new Promise<void>((resolve) =>
    apiServer.listen(0, "127.0.0.1", () => resolve()),
  );
  const address = apiServer.address();
  const port =
    typeof address === "object" && address !== null ? address.port : 0;
  apiBaseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  apiServer.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    apiServer.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
  await Promise.all(
    [...createdDirs].map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

afterEach(() => {
  configureWorkComposition(null);
});

async function seedState(stateDir: string): Promise<void> {
  const workOrderRepo = new WorkOrderRepositoryAdapter({ stateDir });
  const attemptRepo = new AttemptRepositoryAdapter({ stateDir });

  await workOrderRepo.saveWorkOrder({
    id: "wo-1",
    projectId: "proj-a",
    taskId: "task-1",
    laneId: "lane-1",
    repository: "acme/repo",
    baseCommit: "0".repeat(40),
    ownedPaths: [],
    policyRevision: "policy-1",
    prerequisiteWorkOrderIds: [],
    state: "approved",
    revision: 1,
    createdAtIso: "2026-10-20T08:00:00.000Z",
    updatedAtIso: "2026-10-20T08:00:00.000Z",
  });

  await attemptRepo.saveAttempt({
    id: "att-1",
    workOrderId: "wo-1",
    kind: "initial",
    fixNumber: 0,
    priorAttemptId: null,
    worktreePath: "/tmp/opencode/lanes/att-1",
    baseCommit: "0".repeat(40),
    state: "running",
    revision: 1,
    outcome: null,
    briefDigest: null,
    briefPackagePath: null,
    sessionId: null,
    completionReceipt: null,
    artifacts: null,
    runner: {
      kind: "opencode",
      remotePort: 4166,
      host: null,
      agent: "lane",
      model: "nvidia/z-ai/glm-5.3",
      variant: null,
    },
    createdAtIso: "2026-10-20T09:00:00.000Z",
    updatedAtIso: "2026-10-20T09:30:00.000Z",
  });

  await attemptRepo.saveAttempt({
    id: "att-2",
    workOrderId: "wo-1",
    kind: "initial",
    fixNumber: 0,
    priorAttemptId: null,
    worktreePath: "/tmp/opencode/lanes/att-2",
    baseCommit: "0".repeat(40),
    state: "running",
    revision: 1,
    outcome: null,
    briefDigest: null,
    briefPackagePath: null,
    sessionId: null,
    completionReceipt: null,
    artifacts: null,
    runner: {
      kind: "opencode",
      remotePort: 4166,
      host: null,
      agent: "lane",
      model: "nvidia/z-ai/glm-5.3",
      variant: null,
    },
    createdAtIso: "2026-10-20T10:00:00.000Z",
    updatedAtIso: "2026-10-20T10:30:00.000Z",
  });
}

async function callList(query: string): Promise<{ status: number; payload: unknown }> {
  const response = await fetch(`${apiBaseUrl}/v1/attempts${query}`, {
    method: "GET",
    headers: { accept: "application/json" },
  });
  const text = await response.text();
  let payload: unknown = null;
  if (text.length > 0) {
    try {
      payload = JSON.parse(text) as unknown;
    } catch {
      payload = text;
    }
  }
  return { status: response.status, payload };
}

describe("GET /v1/attempts", () => {
  it("lists recorded attempts with limit and truncation", async () => {
    const stateDir = await makeTempDir();
    await seedState(stateDir);
    configureWorkComposition(createConfiguredWorkComposition({ stateDir }));

    const response = await callList("?limit=1");
    expect(response.status).toBe(200);
    const envelope = response.payload as {
      code: string;
      result: {
        outcome: string;
        total: number;
        truncated: boolean;
        attempts: ReadonlyArray<{
          attempt: { id: string };
          workOrder: unknown;
          reservation: unknown;
        }>;
      };
    };
    expect(envelope.code).toBe("OK");
    expect(envelope.result.outcome).toBe("listed");
    expect(envelope.result.total).toBe(2);
    expect(envelope.result.truncated).toBe(true);
    expect(envelope.result.attempts).toHaveLength(1);
    expect(envelope.result.attempts[0]?.attempt.id).toBe("att-2");
  });

  it("rejects an invalid limit with 400 INVALID_REQUEST", async () => {
    const stateDir = await makeTempDir();
    await seedState(stateDir);
    configureWorkComposition(createConfiguredWorkComposition({ stateDir }));

    const response = await callList("?limit=0");
    expect(response.status).toBe(400);
    expect(response.payload).toMatchObject({
      code: "INVALID_REQUEST",
      result: {
        outcome: "rejected",
        reason: "limit must be an integer from 1 to 500",
      },
    });
  });

  it("answers 501 NOT_IMPLEMENTED with the unconfigured composition", async () => {
    const response = await callList("");
    expect(response.status).toBe(501);
    expect(response.payload).toMatchObject({ code: "NOT_IMPLEMENTED" });
  });
});
