// EX-1c: POST /v1/attempts/:id/cancel-prepared — the API undo for a
// prepared, never-dispatched attempt. It copies EX-1a's CLI refusal while a
// live conducted run owns the attempt, lets a stray one through, and keeps
// the route-level single-flight and the configured/unconfigured root
// behaviour of the sibling attempt routes.
import "./nitro-globals.js";

import { createServer, type Server } from "node:http";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

import { createApp, createRouter, toNodeListener } from "h3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AttemptRepositoryAdapter,
  LaneRunJournalAdapter,
  LaneRunRepositoryAdapter,
  laneRunConductEntry,
  type AttemptRecord,
  type CancelPreparedAttemptResult,
  type LaneRunRecord,
  type LaneRunStateValue,
} from "@fleet/work-execution";

import securityMiddleware from "../../middleware/security.js";
import { setActiveApiToken } from "../token.js";
import { configureFleetApiRuntime } from "../runtime.js";
import {
  configureWorkComposition,
  createConfiguredWorkComposition,
} from "../work/composition";
import cancelPreparedPost from "../../routes/v1/attempts/[id]/cancel-prepared.post";

const VALID_TOKEN = "b".repeat(32);
const NOW = "2026-10-27T10:00:00.000Z";

interface EnvelopeResponse {
  code?: string;
  result?: { outcome?: string; reason?: string; runId?: string } | null;
}

function makeAttempt(
  id: string,
  overrides: Partial<AttemptRecord> = {},
): AttemptRecord {
  return {
    id,
    workOrderId: "wo-example-1",
    kind: "initial",
    fixNumber: 0,
    priorAttemptId: null,
    worktreePath: "/wt/example",
    baseCommit: "a".repeat(40),
    state: "intent-recorded",
    outcome: null,
    briefDigest: null,
    briefPackagePath: null,
    sessionId: null,
    completionReceipt: null,
    artifacts: null,
    createdAtIso: NOW,
    updatedAtIso: NOW,
    ...overrides,
  } as AttemptRecord;
}

function runRecord(
  runId: string,
  attemptIds: string[],
  overrides: Partial<LaneRunRecord> = {},
): LaneRunRecord {
  return {
    version: 1,
    runId,
    workOrderId: "wo-example-1",
    tier: 2,
    seatPlanRef: "a".repeat(64),
    cursors: { "first-pass": null, fix: null, review: null },
    round: 0,
    attemptIds,
    prNumber: null,
    parked: null,
    parkCount: 0,
    lease: null,
    revision: 1,
    runPolicyRevision: "policy-example-1",
    ...overrides,
  } as LaneRunRecord;
}

async function seedPreparedAttempt(
  stateDir: string,
  attemptId: string,
): Promise<void> {
  const attemptRepo = new AttemptRepositoryAdapter({ stateDir });
  await attemptRepo.saveAttempt(makeAttempt(attemptId));
}

async function seedRun(
  stateDir: string,
  runId: string,
  attemptIds: string[],
  state: LaneRunStateValue,
  entryId: string,
): Promise<void> {
  const runs = new LaneRunRepositoryAdapter({ stateDir });
  const created = await runs.create(runRecord(runId, attemptIds));
  expect(created.outcome).toBe("saved");
  const journal = new LaneRunJournalAdapter({ stateDir });
  const appended = await journal.append(
    laneRunConductEntry(entryId, runId, state, NOW),
  );
  expect(appended.outcome).toBe("appended");
}

async function persistedAttempt(stateDir: string, attemptId: string): Promise<AttemptRecord | undefined> {
  const persisted = JSON.parse(
    readFileSync(join(stateDir, "attempts.json"), "utf8"),
  ) as AttemptRecord[];
  return persisted.find((record) => record.id === attemptId);
}

describe("cancel-prepared route", () => {
  let tempDir: string;
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "fleet-api-cancel-prepared-"));
    setActiveApiToken(VALID_TOKEN);
    configureFleetApiRuntime({ stateDir: tempDir });

    const app = createApp();
    app.use(securityMiddleware);
    const router = createRouter();
    router.post(
      "/v1/attempts/:id/cancel-prepared",
      cancelPreparedPost as never,
    );
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
    path: string,
    authenticated = true,
  ): Promise<{ status: number; body: EnvelopeResponse }> {
    const res = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: authenticated
        ? { ...authHeaders(), "content-type": "application/json" }
        : { "content-type": "application/json" },
      body: "{}",
    });
    return { status: res.status, body: (await res.json()) as EnvelopeResponse };
  }

  it("cancels a stray prepared attempt", async () => {
    await seedPreparedAttempt(tempDir, "att-stray-1");

    const response = await call("/v1/attempts/att-stray-1/cancel-prepared");
    expect(response.status).toBe(200);
    expect(response.body.code).toBe("OK");
    expect(response.body.result!.outcome).toBe("cancelled");

    expect((await persistedAttempt(tempDir, "att-stray-1"))?.state).toBe(
      "cancelled",
    );
  });

  it("refuses a non-prepared attempt", async () => {
    const attemptRepo = new AttemptRepositoryAdapter({ stateDir: tempDir });
    await attemptRepo.saveAttempt(
      makeAttempt("att-collected-1", { state: "collected", revision: 1 }),
    );

    const response = await call("/v1/attempts/att-collected-1/cancel-prepared");
    expect(response.status).toBe(200);
    expect(response.body.code).toBe("OK");
    expect(response.body.result!.outcome).toBe("refused");
    expect(response.body.result!.reason).toBe("not-prepared");
  });

  it("single-flights cancel-prepared per attempt id: a concurrent second call answers 409 BUSY", async () => {
    const composition = createConfiguredWorkComposition({ stateDir: tempDir });
    let notifyStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      notifyStarted = resolve;
    });
    let release: (result: CancelPreparedAttemptResult) => void = () => undefined;
    const held = new Promise<CancelPreparedAttemptResult>((resolve) => {
      release = resolve;
    });
    const refused: CancelPreparedAttemptResult = {
      outcome: "refused",
      reason: "not-prepared",
    };
    const execute = vi
      .spyOn(composition.cancelPreparedAttempt, "cancelPreparedAttempt")
      .mockImplementation(() => {
        notifyStarted();
        return held;
      });
    configureWorkComposition(composition);

    const firstPending = call("/v1/attempts/att-held/cancel-prepared");
    await started;
    const second = await call("/v1/attempts/att-held/cancel-prepared");
    expect(second.status).toBe(409);
    expect(second.body.code).toBe("BUSY");
    expect(second.body.result!.reason).toBe(
      "a cancel of att-held is already running",
    );
    expect(execute).toHaveBeenCalledTimes(1);

    release(refused);
    const first = await firstPending;
    expect(first.status).toBe(200);
    expect(first.body.code).toBe("OK");
  });

  it("refuses while a live conducted run owns the attempt", async () => {
    await seedPreparedAttempt(tempDir, "att-live-1");
    await seedRun(
      tempDir,
      "run-01JB0000000000000000000001",
      ["att-live-1"],
      "running",
      "01JB0000000000000000000002",
    );
    const attemptsBefore = readFileSync(join(tempDir, "attempts.json"));

    const response = await call("/v1/attempts/att-live-1/cancel-prepared");
    expect(response.status).toBe(200);
    expect(response.body.code).toBe("OK");
    expect(response.body.result!.outcome).toBe("refused");
    expect(response.body.result!.reason).toBe("run-active");
    expect(response.body.result!.runId).toBe(
      "run-01JB0000000000000000000001",
    );
    expect(readFileSync(join(tempDir, "attempts.json"))).toEqual(attemptsBefore);
  });

  it("allows a terminal (stopped) run that lists the attempt", async () => {
    await seedPreparedAttempt(tempDir, "att-stopped-1");
    await seedRun(
      tempDir,
      "run-01JB0000000000000000000003",
      ["att-stopped-1"],
      "stopped",
      "01JB0000000000000000000004",
    );

    const response = await call("/v1/attempts/att-stopped-1/cancel-prepared");
    expect(response.status).toBe(200);
    expect(response.body.code).toBe("OK");
    expect(response.body.result!.outcome).toBe("cancelled");

    expect((await persistedAttempt(tempDir, "att-stopped-1"))?.state).toBe(
      "cancelled",
    );
  });

  it("keeps an unauthenticated call behind the bearer token", async () => {
    const response = await call("/v1/attempts/att-1/cancel-prepared", false);
    expect(response.status).toBe(401);
  });

  it("answers 501 NOT_IMPLEMENTED from the unconfigured root", async () => {
    configureWorkComposition(null);

    const response = await call("/v1/attempts/att-1/cancel-prepared");
    expect(response.status).toBe(501);
    expect(response.body.code).toBe("NOT_IMPLEMENTED");
  });

  it("fails closed when lane-runs.json is unreadable", async () => {
    await seedPreparedAttempt(tempDir, "att-bad-runs-1");
    const attemptsBefore = readFileSync(join(tempDir, "attempts.json"));
    writeFileSync(join(tempDir, "lane-runs.json"), "{ not json");
    const filesBefore = readdirSync(tempDir).sort();

    const response = await call("/v1/attempts/att-bad-runs-1/cancel-prepared");
    expect(response.status).toBe(500);
    expect(readFileSync(join(tempDir, "attempts.json"))).toEqual(attemptsBefore);
    expect(readdirSync(tempDir).sort()).toEqual(filesBefore);
  });
});
