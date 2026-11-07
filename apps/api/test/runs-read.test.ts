import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, createRouter, eventHandler, toNodeListener, type EventHandler } from "h3";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import securityMiddleware from "../server/middleware/security.js";
import { configureFleetApiRuntime } from "../server/wiring/runtime.js";
import { setActiveApiToken } from "../server/wiring/token.js";
import { configurePresentedTokenResolver } from "../server/wiring/presented-token.js";
import { configureWorkComposition } from "../server/wiring/work/composition.js";
import {
  AttemptRepositoryAdapter,
  LaneRun,
  laneRunConductEntry,
  LaneRunJournalAdapter,
  LaneRunRepositoryAdapter,
  WorkOrderRepositoryAdapter,
  type LaneRunRecord,
  type WorkOrderRecord,
} from "@fleet/work-execution";

const VALID_TOKEN = "a".repeat(32);
const MAX_KEY_LENGTH = 256;
const RUN_ID = "run-01JB0000000000000000000000";
const RUN_ID_2 = "run-01JB0000000000000000000001";
const RUN_ID_MISSING = "run-01JB0000000000000000000002";
const ATTEMPT_ID = "attempt-1";
const ENTRY_1 = "01JB0000000000000000000001";
const ENTRY_2 = "01JB0000000000000000000002";
const NOW = "2026-11-06T10:00:00.000Z";
const WO_ID = "wo-acme-repo";

function runRecord(runId: string, attemptIds: readonly string[] = []): LaneRunRecord {
  const result = LaneRun.create({
    version: 1,
    runId,
    workOrderId: WO_ID,
    tier: 2,
    seatPlanRef: "a".repeat(64),
    cursors: { "first-pass": 0, fix: null, review: null },
    round: 0,
    attemptIds: [...attemptIds],
    prNumber: null,
    parked: null,
    parkCount: 0,
    lease: null,
    revision: 1,
    runPolicyRevision: "policy-example-1",
  });
  if (!result.success) {
    throw new Error("fixture must be a valid LaneRun record");
  }
  return result.value.toRecord();
}

const WORK_ORDER: WorkOrderRecord = {
  id: WO_ID,
  projectId: "project-acme",
  taskId: "task-1",
  laneId: "lane-1",
  repository: "acme/repo",
  baseCommit: "a".repeat(40),
  ownedPaths: ["packages/a/x.ts"],
  policyRevision: "policy-example-1",
  prerequisiteWorkOrderIds: [],
  state: "approved",
  revision: 1,
  createdAtIso: NOW,
  updatedAtIso: NOW,
};

async function seedState(stateDir: string): Promise<void> {
  const workOrderRepo = new WorkOrderRepositoryAdapter({ stateDir });
  const attemptRepo = new AttemptRepositoryAdapter({ stateDir });
  const laneRunRepo = new LaneRunRepositoryAdapter({ stateDir });
  const laneRunJournal = new LaneRunJournalAdapter({ stateDir });

  await workOrderRepo.saveWorkOrder(WORK_ORDER);
  await attemptRepo.saveAttempt({
    id: ATTEMPT_ID,
    workOrderId: WO_ID,
    kind: "initial",
    fixNumber: 0,
    priorAttemptId: null,
    worktreePath: "/srv/wt/attempt-1",
    baseCommit: "a".repeat(40),
    state: "running",
    revision: 1,
    outcome: null,
    briefDigest: null,
    briefPackagePath: null,
    sessionId: null,
    completionReceipt: null,
    artifacts: null,
    runner: { kind: "opencode", remotePort: 4166, host: null, agent: "lane", model: "m-1", variant: null },
    createdAtIso: NOW,
    updatedAtIso: NOW,
  });
  await laneRunRepo.create(runRecord(RUN_ID, [ATTEMPT_ID]));
  await laneRunRepo.create(runRecord(RUN_ID_2));
  await laneRunJournal.append(laneRunConductEntry(ENTRY_1, RUN_ID, "running", NOW));
  await laneRunJournal.append(laneRunConductEntry(ENTRY_2, RUN_ID_2, "stopped", NOW));
}

describe("GET /v1/runs* (A-R)", () => {
  let tempDir: string;
  let server: Server;
  let baseUrl: string;
  let runsIndexGet: EventHandler;
  let runsPassesGet: EventHandler;
  let runsJournalGet: EventHandler;
  let runGet: EventHandler;
  let runJournalGet: EventHandler;

  beforeAll(async () => {
    [runsIndexGet, runsPassesGet, runsJournalGet, runGet, runJournalGet] = await Promise.all([
      import("../server/routes/v1/runs/index.get.js").then((m) => m.default),
      import("../server/routes/v1/runs/passes.get.js").then((m) => m.default),
      import("../server/routes/v1/runs/journal.get.js").then((m) => m.default),
      import("../server/routes/v1/runs/[id].get.js").then((m) => m.default),
      import("../server/routes/v1/runs/[id]/journal.get.js").then((m) => m.default),
    ]);
  });

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "fleet-api-runs-read-test-"));
    configureFleetApiRuntime(null);
    setActiveApiToken(null);
    configurePresentedTokenResolver(null);
    configureWorkComposition(null);
    delete process.env.FLEET_STATE_DIR;

    const app = createApp();
    app.use(securityMiddleware);
    const router = createRouter();
    router.get("/v1/runs", eventHandler((event) => runsIndexGet(event)));
    router.get("/v1/runs/passes", eventHandler((event) => runsPassesGet(event)));
    router.get("/v1/runs/journal", eventHandler((event) => runsJournalGet(event)));
    router.get("/v1/runs/:id", eventHandler((event) => runGet(event)));
    router.get("/v1/runs/:id/journal", eventHandler((event) => runJournalGet(event)));
    app.use(router.handler);

    server = createServer(toNodeListener(app));
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    rmSync(tempDir, { recursive: true, force: true });
    configureFleetApiRuntime(null);
    setActiveApiToken(null);
    configurePresentedTokenResolver(null);
    configureWorkComposition(null);
  });

  function configureApi(scope: "read" | "operate" = "read"): void {
    setActiveApiToken(VALID_TOKEN);
    configureFleetApiRuntime({ stateDir: tempDir });
    configurePresentedTokenResolver(() => ({
      tokenId: "test-session",
      scopes: [scope],
    }));
  }

  async function get(path: string, headers: Record<string, string> = {}): Promise<Response> {
    return fetch(`${baseUrl}${path}`, {
      headers: { authorization: `Bearer ${VALID_TOKEN}`, ...headers },
    });
  }

  async function getNoAuth(path: string): Promise<Response> {
    return fetch(`${baseUrl}${path}`);
  }

  async function envelopeOf(response: Response): Promise<{ code: string; result: unknown; operationId: string }> {
    return (await response.json()) as { code: string; result: unknown; operationId: string };
  }

  it("answers 501 NOT_IMPLEMENTED when the work composition is unconfigured", async () => {
    const index = await getNoAuth("/v1/runs");
    expect(index.status).toBe(501);
    expect((await envelopeOf(index)).code).toBe("NOT_IMPLEMENTED");
    const journal = await getNoAuth(`/v1/runs/journal?key=${encodeURIComponent(`request/${ENTRY_1}`)}`);
    expect(journal.status).toBe(501);
    expect((await envelopeOf(journal)).code).toBe("NOT_IMPLEMENTED");
  });

  it("refuses an unauthenticated request with 401 and a non-read scope with 403", async () => {
    configureApi("read");
    const unauthenticated = await getNoAuth("/v1/runs");
    expect(unauthenticated.status).toBe(401);

    configureApi("operate");
    const forbidden = await get("/v1/runs");
    expect(forbidden.status).toBe(403);
    expect((await forbidden.json() as { error: string }).error).toBe("Forbidden: scope required");
  });

  it("serves schedule-compatible fields and runs cards on GET /v1/runs", async () => {
    configureApi();
    await seedState(tempDir);

    const response = await get("/v1/runs");
    expect(response.status).toBe(200);
    const body = await envelopeOf(response);
    expect(body.code).toBe("OK");
    const result = body.result as {
      outcome: string;
      schedule: Record<string, unknown>;
      sessionStarts: unknown[];
      truncated: boolean;
      runs: Array<Record<string, unknown>>;
      runsTruncated: boolean;
    };
    expect(result.outcome).toBe("listed");
    expect(result.runsTruncated).toBe(false);
    expect(result.truncated).toBe(false);
    // parseScheduleEnvelope-compatible schedule fields.
    expect(typeof result.schedule.observedAtIso).toBe("string");
    expect(["clear", "halted", "unreadable"]).toContain(result.schedule.halt);
    expect(Array.isArray(result.schedule.rows)).toBe(true);
    expect(Array.isArray(result.schedule.queues)).toBe(true);
    expect(Array.isArray(result.schedule.hosts)).toBe(true);
    expect(typeof result.schedule.admission).toBe("object");
    expect(result.runs.map((card) => card.runId)).toEqual([RUN_ID, RUN_ID_2]);
    expect(result.runs[0]).toMatchObject({
      runId: RUN_ID,
      state: "running",
      attemptCount: 1,
      latestAttemptId: ATTEMPT_ID,
      seatsByRole: { "first-pass": null, fix: null, review: null },
      wouldAct: [],
    });
  });

  it("keeps static /v1/runs/journal and /v1/runs/passes separate from /v1/runs/:id", async () => {
    configureApi();
    await seedState(tempDir);

    const passes = await get("/v1/runs/passes");
    expect(passes.status).toBe(200);
    expect((await envelopeOf(passes)).code).toBe("OK");

    const journalNoKey = await get("/v1/runs/journal");
    expect(journalNoKey.status).toBe(400);
    expect((await envelopeOf(journalNoKey)).code).toBe("INVALID_REQUEST");

    const key = `request/${ENTRY_1}`;
    const journal = await get(`/v1/runs/journal?key=${encodeURIComponent(key)}`);
    expect(journal.status).toBe(200);
    const journalBody = await envelopeOf(journal);
    expect(journalBody.code).toBe("OK");
    expect((journalBody.result as { keyKind: string }).keyKind).toBe("request");

    const malformedId = await get(`/v1/runs/${encodeURIComponent("not-a-run-id")}`);
    expect(malformedId.status).toBe(400);

    const detail = await get(`/v1/runs/${RUN_ID}`);
    expect(detail.status).toBe(200);
  });

  it("answers 200 OK and 404 NOT_FOUND on detail and per-run journal routes", async () => {
    configureApi();
    await seedState(tempDir);

    const detail = await get(`/v1/runs/${RUN_ID}`);
    expect(detail.status).toBe(200);
    const detailBody = await envelopeOf(detail);
    expect(detailBody.code).toBe("OK");
    expect((detailBody.result as { run: { runId: string } }).run.runId).toBe(RUN_ID);
    expect(Array.isArray((detailBody.result as { journal: unknown[] }).journal)).toBe(true);

    const missingDetail = await get(`/v1/runs/${RUN_ID_MISSING}`);
    expect(missingDetail.status).toBe(404);
    expect((await envelopeOf(missingDetail)).code).toBe("NOT_FOUND");

    const journal = await get(`/v1/runs/${RUN_ID}/journal`);
    expect(journal.status).toBe(200);
    const journalBody = await envelopeOf(journal);
    expect(journalBody.code).toBe("OK");
    expect((journalBody.result as { entries: unknown[] }).entries).toHaveLength(1);

    const missingJournal = await get(`/v1/runs/${RUN_ID_MISSING}/journal`);
    expect(missingJournal.status).toBe(404);
    expect((await envelopeOf(missingJournal)).code).toBe("NOT_FOUND");
  });

  it("reads URL-encoded slash keys through GET /v1/runs/journal", async () => {
    configureApi();
    await seedState(tempDir);

    const requestKey = `request/${ENTRY_1}`;
    const stepKey = `${RUN_ID}/r0/collect/0/a1`;
    for (const key of [requestKey, stepKey]) {
      const response = await get(`/v1/runs/journal?key=${encodeURIComponent(key)}`);
      expect(response.status).toBe(200);
      const body = await envelopeOf(response);
      expect(body.code).toBe("OK");
      expect((body.result as { key: string }).key).toBe(key);
    }
  });

  it("returns 400 INVALID_REQUEST on malformed runId, missing or invalid key, non-decimal limits and unknown query parameters", async () => {
    configureApi();
    await seedState(tempDir);

    // Board limits and unknown query parameters.
    for (const query of ["?limit=abc", "?limit=0", "?limit=-1", "?limit=1&limit=2", "?extra=1"]) {
      const response = await get(`/v1/runs${query}`);
      expect(response.status).toBe(400);
      expect((await envelopeOf(response)).code).toBe("INVALID_REQUEST");
    }

    // Malformed run ids never echo.
    const secretRunId = ["ghp", "x".repeat(28)].join("_");
    const malformed = await get(`/v1/runs/${encodeURIComponent(secretRunId)}`);
    expect(malformed.status).toBe(400);
    expect(await malformed.text()).not.toContain(secretRunId);

    // Journal route: missing, over-long, secret-shaped and malformed keys, bad limits, unknown params.
    const noKey = await get("/v1/runs/journal");
    expect(noKey.status).toBe(400);

    const overLong = await get(`/v1/runs/journal?key=${"a".repeat(MAX_KEY_LENGTH + 1)}`);
    expect(overLong.status).toBe(400);

    const secretKey = ["ghp", "x".repeat(28)].join("_");
    const secret = await get(`/v1/runs/journal?key=${encodeURIComponent(secretKey)}`);
    expect(secret.status).toBe(400);
    expect(await secret.text()).not.toContain(secretKey);

    const badStep = await get(`/v1/runs/journal?key=${encodeURIComponent(`${RUN_ID}/r9/notastep/0`)}`);
    expect(badStep.status).toBe(400);

    const validKey = encodeURIComponent(`request/${ENTRY_1}`);
    for (const query of [`?key=${validKey}&limit=abc`, `?key=${validKey}&limit=0`, `?key=${validKey}&extra=1`]) {
      const response = await get(`/v1/runs/journal${query}`);
      expect(response.status).toBe(400);
      expect((await envelopeOf(response)).code).toBe("INVALID_REQUEST");
    }
  });

  it("answers 200 OK with outcome unknown and never empty or 500 on corrupt or schemaVersion 99 state files", async () => {
    configureApi();
    await seedState(tempDir);

    writeFileSync(join(tempDir, "lane-runs.json"), '[{"schemaVersion":99}]');
    const index = await get("/v1/runs");
    expect(index.status).toBe(200);
    const indexBody = await envelopeOf(index);
    expect(indexBody.code).toBe("OK");
    expect(indexBody.result).toMatchObject({ outcome: "unknown", reason: "unknown-schema-version" });

    const detail = await get(`/v1/runs/${RUN_ID}`);
    expect(detail.status).toBe(200);
    expect((await envelopeOf(detail)).result).toMatchObject({ outcome: "unknown", reason: "unknown-schema-version" });

    // A corrupt attempts store is reported unreadable, never an empty board or a 500.
    writeFileSync(join(tempDir, "lane-runs.json"), JSON.stringify([runRecord(RUN_ID, [ATTEMPT_ID])]));
    writeFileSync(join(tempDir, "attempts.json"), "{not json at all");
    const corrupt = await get("/v1/runs");
    expect(corrupt.status).toBe(200);
    const corruptBody = await envelopeOf(corrupt);
    expect(corruptBody.code).toBe("OK");
    expect(corruptBody.result).toMatchObject({ outcome: "unknown", reason: "store-unreadable" });
  });

  it("never mutates or quarantines corrupt state files across repeated GETs", async () => {
    configureApi();
    await seedState(tempDir);
    writeFileSync(join(tempDir, "reservations.json"), "{corrupt reservations");
    writeFileSync(join(tempDir, "journal.json"), "{corrupt journal");
    writeFileSync(join(tempDir, "attempts.json"), "{corrupt attempts");

    // readdirSync recursive returns strings; compare names only (no quarantine dir should appear).
    const before = readdirSync(tempDir, { recursive: true }).sort();
    const first = await get("/v1/runs");
    expect(first.status).toBe(200);
    expect((await envelopeOf(first)).result).toMatchObject({ outcome: "unknown" });
    const second = await get("/v1/runs");
    expect(second.status).toBe(200);
    const after = readdirSync(tempDir, { recursive: true }).sort();
    expect(after).toEqual(before);
    expect(after.some((name) => name.includes("quarantine"))).toBe(false);
  });

  it("never echoes secret-shaped or path-shaped input, attempt paths or store file paths in any /v1/runs response", async () => {
    configureApi();
    await seedState(tempDir);

    const texts: string[] = [];
    texts.push(await (await get("/v1/runs")).text());
    texts.push(await (await get(`/v1/runs/${RUN_ID}`)).text());
    texts.push(await (await get(`/v1/runs/${RUN_ID}/journal`)).text());
    texts.push(await (await get(`/v1/runs/journal?key=${encodeURIComponent(`request/${ENTRY_1}`)}`)).text());
    for (const text of texts) {
      expect(text).not.toContain(tempDir);
      expect(text).not.toContain("/srv/wt/");
      expect(text).not.toContain("attempts.json");
      expect(text).not.toContain("lane-runs.json");
      expect(text).not.toContain("run-journal.json");
    }
  });
});
