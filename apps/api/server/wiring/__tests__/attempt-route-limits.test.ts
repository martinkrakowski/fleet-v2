// EX-1b: route-level limits for the attempt actions. Proves the API refuses a
// fix when a pending fix sibling exists on the work order (b), single-flights
// stop per attempt id (c), caps attempt actions globally (d), keeps
// unauthenticated calls behind the bearer token (e) and keeps the unconfigured
// root answering 501 as today (f).
import "./nitro-globals.js";

import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

import { createApp, createRouter, toNodeListener } from "h3";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  AttemptRepositoryAdapter,
  WorkOrderRepositoryAdapter,
  type AttemptRecord,
  type StopAttemptResult,
} from "@fleet/work-execution";

import securityMiddleware from "../../middleware/security.js";
import { setActiveApiToken } from "../token.js";
import { configureFleetApiRuntime } from "../runtime.js";
import {
  configureWorkComposition,
  createConfiguredWorkComposition,
} from "../work/composition";

const VALID_TOKEN = "b".repeat(32);

interface EnvelopeResponse {
  code?: string;
  result?: { outcome?: string; reason?: string } | null;
}

const BASE_RECORD: Omit<AttemptRecord, "id" | "kind" | "fixNumber" | "priorAttemptId" | "state"> = {
  workOrderId: "wo-1",
  worktreePath: "/tmp/opencode/lanes/wo-1",
  baseCommit: "0".repeat(40),
  outcome: null,
  briefDigest: null,
  briefPackagePath: null,
  sessionId: null,
  completionReceipt: null,
  artifacts: null,
  createdAtIso: "2026-10-31T09:00:00.000Z",
  updatedAtIso: "2026-10-31T09:00:00.000Z",
};

function attemptRecord(
  id: string,
  overrides: Partial<AttemptRecord> = {},
): AttemptRecord {
  return {
    ...BASE_RECORD,
    id,
    kind: "initial",
    fixNumber: 0,
    priorAttemptId: null,
    state: "running",
    ...overrides,
  };
}

function fixRecord(id: string, state: AttemptRecord["state"]): AttemptRecord {
  return attemptRecord(id, {
    kind: "fix",
    fixNumber: 1,
    priorAttemptId: "att-1",
    state,
  });
}

async function seedPendingFix(stateDir: string): Promise<void> {
  const workOrderRepo = new WorkOrderRepositoryAdapter({ stateDir });
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
    createdAtIso: "2026-10-31T08:00:00.000Z",
    updatedAtIso: "2026-10-31T08:00:00.000Z",
  });
  const attemptRepo = new AttemptRepositoryAdapter({ stateDir });
  await attemptRepo.saveAttempt(attemptRecord("att-1", { state: "collected" }));
  await attemptRepo.saveAttempt(fixRecord("fix-held", "intent-recorded"));
}

describe("attempt route limits", () => {
  let tempDir: string;
  let server: Server;
  let baseUrl: string;

  let stopHandler: unknown;
  let reconcileHandler: unknown;
  let fixHandler: unknown;

  beforeAll(async () => {
    stopHandler = (await import("../../routes/v1/attempts/[id]/stop.post.js")).default;
    reconcileHandler = (
      await import("../../routes/v1/attempts/[id]/reconcile.post.js")
    ).default;
    fixHandler = (await import("../../routes/v1/attempts/[id]/fix.post.js")).default;
  });

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "fleet-api-attempt-limits-"));
    setActiveApiToken(VALID_TOKEN);
    configureFleetApiRuntime({ stateDir: tempDir });

    const app = createApp();
    app.use(securityMiddleware);
    const router = createRouter();
    router.post("/v1/attempts/:id/stop", stopHandler as never);
    router.post("/v1/attempts/:id/reconcile", reconcileHandler as never);
    router.post("/v1/attempts/:id/fix", fixHandler as never);
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
    configureWorkComposition(null);
    setActiveApiToken(null);
    vi.restoreAllMocks();
  });

  function authHeaders(): Record<string, string> {
    return { authorization: `Bearer ${VALID_TOKEN}` };
  }

  async function call(
    method: string,
    path: string,
    body?: unknown,
    authenticated = true,
  ) {
    const payload = JSON.stringify(body ?? {});
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: authenticated
        ? { ...authHeaders(), "content-type": "application/json" }
        : { "content-type": "application/json" },
      body: payload,
    });
    return { status: res.status, body: (await res.json()) as EnvelopeResponse };
  }

  function fixBody(fixAttemptId = "fix-new"): Record<string, unknown> {
    return {
      fixAttemptId,
      workOrderId: "wo-1",
      numberedFixes: ["fix the thing"],
    };
  }

  it("refuses a fix over the API when a pending fix sibling exists, without recording a second fix", async () => {
    await seedPendingFix(tempDir);
    configureWorkComposition(createConfiguredWorkComposition({ stateDir: tempDir }));

    const response = await call("POST", "/v1/attempts/att-1/fix", fixBody());
    expect(response.status).toBe(200);
    expect(response.body.code).toBe("OK");
    expect(response.body.result!.outcome).toBe("refused");
    expect(response.body.result!.reason).toBe("pending-fix-exists: fix-held");

    const persisted = JSON.parse(
      readFileSync(join(tempDir, "attempts.json"), "utf8"),
    ) as AttemptRecord[];
    expect(persisted.filter((record) => record.kind === "fix")).toHaveLength(1);
  });

  it("single-flights stop per attempt id: a concurrent second stop answers 409 BUSY", async () => {
    const composition = createConfiguredWorkComposition({ stateDir: tempDir });
    let notifyStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      notifyStarted = resolve;
    });
    let release: (result: StopAttemptResult) => void = () => undefined;
    const held = new Promise<StopAttemptResult>((resolve) => {
      release = resolve;
    });
    const refused: StopAttemptResult = { outcome: "refused", reason: "test hold" };
    const execute = vi
      .spyOn(composition.stopAttempt, "execute")
      .mockImplementation(() => {
        notifyStarted();
        return held;
      });
    configureWorkComposition(composition);

    const firstPending = call("POST", "/v1/attempts/att-held/stop", {});
    await started;
    const second = await call("POST", "/v1/attempts/att-held/stop", {});
    expect(second.status).toBe(409);
    expect(second.body.code).toBe("BUSY");
    expect(second.body.result!.reason).toBe(
      "a stop of att-held is already running",
    );
    expect(execute).toHaveBeenCalledTimes(1);

    release(refused);
    const first = await firstPending;
    expect(first.status).toBe(200);
    expect(first.body.code).toBe("OK");
  });

  it("caps attempt actions globally: a fifth call with four in flight answers 429 BUSY", async () => {
    const composition = createConfiguredWorkComposition({ stateDir: tempDir });
    const startedIds: string[] = [];
    let notifyStarted: () => void = () => undefined;
    const releases = new Map<string, (result: StopAttemptResult) => void>();
    const refused: StopAttemptResult = { outcome: "refused", reason: "test hold" };
    vi.spyOn(composition.stopAttempt, "execute").mockImplementation(
      async (input) => {
        const attemptId = (input as { attemptId: string }).attemptId;
        startedIds.push(attemptId);
        notifyStarted();
        return new Promise<StopAttemptResult>((resolve) => {
          releases.set(attemptId, resolve);
        });
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

    const inFlight = [1, 2, 3, 4].map((index) =>
      call("POST", `/v1/attempts/att-held-${index}/stop`, {}),
    );
    try {
      await waitForStarts(4);
      const over = await call("POST", "/v1/attempts/att-held-5/stop", {});
      expect(over.status).toBe(429);
      expect(over.body.code).toBe("BUSY");
      expect(over.body.result!.reason).toBe(
        "attempt capacity is busy; retry shortly",
      );
    } finally {
      for (const [, release] of releases) release(refused);
    }
    for (const pending of inFlight) {
      expect((await pending).status).toBe(200);
    }
  });

  it("keeps an unauthenticated call behind the bearer token", async () => {
    const response = await call("POST", "/v1/attempts/att-1/fix", fixBody(), false);
    expect(response.status).toBe(401);
  });

  it("answers 501 NOT_IMPLEMENTED from the unconfigured root", async () => {
    configureWorkComposition(null);

    const stopped = await call("POST", "/v1/attempts/att-1/stop", {});
    expect(stopped.status).toBe(501);
    expect(stopped.body.code).toBe("NOT_IMPLEMENTED");

    const fixed = await call("POST", "/v1/attempts/att-1/fix", fixBody());
    expect(fixed.status).toBe(501);
    expect(fixed.body.code).toBe("NOT_IMPLEMENTED");
  });
});
