// VZ3: GET /v1/runs serves the read-only conductor schedule through the real
// route handler on a loopback server with a temp state dir. In record mode
// (FLEET_RECORD_FIXTURES=1) it writes fixtures/v1-runs.recorded.json, which
// VZ4's web parity test reads.
import "./nitro-globals.js";

import { createServer, type Server } from "node:http";
import { mkdtemp, readdir, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { createApp, createRouter, toNodeListener } from "h3";
import { afterEach, afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  AttemptRepositoryAdapter,
  ExecutionJournalAdapter,
  LaneRunJournalAdapter,
  LaneRunRepositoryAdapter,
  LaneRun,
  WorkOrderRepositoryAdapter,
  buildLaneRunStepKey,
  laneRunConductEntry,
  laneRunIntentEntry,
  type CapacityReservationRecord,
  type LaneRunRecord,
  type WorkOrderRecord,
} from "@fleet/work-execution";

import {
  configureWorkComposition,
  createConfiguredWorkComposition,
} from "../work/composition";
import runsIndexGet from "../../routes/v1/runs/index.get";

const RUN_0 = "run-01JB0000000000000000000000";
const RUN_1 = "run-01JB0000000000000000000001";
const RUN_2 = "run-01JB0000000000000000000002";
const SEED_NOW = "2026-10-20T09:00:00.000Z";
const DISPATCH_AT = "2026-10-20T09:00:00.000Z";

const fixtureDir = join(dirnameOf(import.meta.url), "fixtures");
const fixturePath = join(fixtureDir, "v1-runs.recorded.json");

function dirnameOf(url: string): string {
  return fileURLToPath(new URL(".", url));
}

const createdDirs = new Set<string>();

async function makeTempDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "fleet-runs-list-route-"));
  createdDirs.add(directory);
  return directory;
}

let apiBaseUrl = "";
let apiServer: Server;

beforeAll(async () => {
  const router = createRouter();
  router.add("/v1/runs", runsIndexGet, "get");
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

function runRecord(
  runId: string,
  workOrderId: string,
  attemptIds: readonly string[],
  lease: LaneRunRecord["lease"],
): LaneRunRecord {
  const result = LaneRun.create({
    version: 1,
    runId,
    workOrderId,
    tier: 2,
    seatPlanRef: "a".repeat(64),
    cursors: { "first-pass": 0, fix: null, review: null },
    round: 0,
    attemptIds: [...attemptIds],
    prNumber: null,
    parked: null,
    parkCount: 0,
    lease,
    revision: 1,
    runPolicyRevision: "policy-1",
  });
  expect(result.success).toBe(true);
  if (!result.success) {
    throw new Error("fixture must be a valid LaneRun record");
  }
  return result.value.toRecord();
}

function workOrderRecord(id: string, ownedPaths: readonly string[]): WorkOrderRecord {
  return {
    id,
    projectId: "proj-a",
    taskId: `task-${id}`,
    laneId: `lane-${id}`,
    repository: "acme/repo",
    baseCommit: "0".repeat(40),
    ownedPaths: [...ownedPaths],
    policyRevision: "policy-1",
    prerequisiteWorkOrderIds: [],
    state: "approved",
    revision: 1,
    createdAtIso: SEED_NOW,
    updatedAtIso: SEED_NOW,
  };
}

function attemptRecord(
  id: string,
  workOrderId: string,
  worktreePath: string,
): Parameters<AttemptRepositoryAdapter["saveAttempt"]>[0] {
  return {
    id,
    workOrderId,
    kind: "initial",
    fixNumber: 0,
    priorAttemptId: null,
    worktreePath,
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
    createdAtIso: SEED_NOW,
    updatedAtIso: SEED_NOW,
  };
}

function dispatchKeyFor(runId: string): string {
  const key = buildLaneRunStepKey({
    runId,
    round: 0,
    step: "dispatch",
    seatIndex: 0,
    attemptOrdinal: 1,
    head12: null,
    retry: null,
  });
  expect(key.ok).toBe(true);
  if (!key.ok) {
    throw new Error("fixture must be a valid lane-run step key");
  }
  return key.key;
}

const RESERVATION: CapacityReservationRecord = {
  id: "res-att-1",
  attemptId: "att-1",
  hostId: "sol",
  hostName: "sol",
  hostKind: "opencode",
  slotIndex: 0,
  held: true,
  seatTool: "opencode",
  transport: "ssh",
  sshAlias: "alias-secret",
  port: 4166,
  worktreePath: "/srv/wt/att-1",
  reservedAtIso: "2026-10-20T08:59:00.000Z",
  releasedAtIso: null,
};

async function seedState(stateDir: string): Promise<void> {
  const workOrderRepo = new WorkOrderRepositoryAdapter({ stateDir });
  const attemptRepo = new AttemptRepositoryAdapter({ stateDir });
  const journal = new ExecutionJournalAdapter({ stateDir });
  const laneRunRepo = new LaneRunRepositoryAdapter({ stateDir });
  const laneRunJournal = new LaneRunJournalAdapter({ stateDir });

  await workOrderRepo.saveWorkOrder(workOrderRecord("wo-1", ["packages/a/x.ts"]));
  await workOrderRepo.saveWorkOrder(workOrderRecord("wo-2", ["packages/a/y.ts"]));
  await attemptRepo.saveAttempt(attemptRecord("att-1", "wo-1", "/tmp/opencode/lanes/att-1"));
  await attemptRepo.saveAttempt(attemptRecord("att-2", "wo-2", "/tmp/opencode/lanes/att-2"));
  await journal.saveCapacityReservation(RESERVATION);

  const runSaves = [
    await laneRunRepo.create(runRecord(RUN_0, "wo-1", ["att-1"], null)),
    await laneRunRepo.create(runRecord(RUN_1, "wo-2", ["att-2"], null)),
    await laneRunRepo.create(runRecord(RUN_2, "wo-1", [], null)),
  ];
  for (const save of runSaves) {
    expect(save).toMatchObject({ outcome: "saved" });
  }

  // The acquire port caps a lease at 10 minutes from now, so the 2099 driver
  // lease enters through the store file directly: domain record validation
  // accepts it, and the schedule read never re-derives it from `nowIso`.
  const storePath = join(stateDir, "lane-runs.json");
  const records = JSON.parse(await readFile(storePath, "utf8")) as LaneRunRecord[];
  const leased = records.map((record) =>
    record.runId === RUN_0
      ? {
          ...record,
          lease: {
            holderId: "driver-secret-1",
            fence: 1,
            leaseUntilIso: "2099-01-01T00:00:00.000Z",
          },
        }
      : record,
  );
  await writeFile(storePath, `${JSON.stringify(leased, null, 2)}\n`);

  const appends = [
    await laneRunJournal.append(laneRunIntentEntry("01JB0000000000000000000001", RUN_0, dispatchKeyFor(RUN_0), null, DISPATCH_AT)),
    await laneRunJournal.append(laneRunConductEntry("01JB0000000000000000000002", RUN_0, "running", SEED_NOW)),
    await laneRunJournal.append(laneRunConductEntry("01JB0000000000000000000003", RUN_1, "ready", SEED_NOW)),
    await laneRunJournal.append(laneRunConductEntry("01JB0000000000000000000004", RUN_2, "stopped", SEED_NOW)),
  ];
  for (const appended of appends) {
    expect(appended).toMatchObject({ outcome: "appended" });
  }
}

async function callList(): Promise<{ status: number; payload: unknown; text: string }> {
  const response = await fetch(`${apiBaseUrl}/v1/runs`, {
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
  return { status: response.status, payload, text };
}

/** Snapshot every file in the state dir: sorted relative paths and their bytes. */
async function snapshotState(stateDir: string): Promise<string[]> {
  const names = (await readdir(stateDir, { recursive: true })).filter(
    (name) => name.endsWith(".json"),
  ).sort();
  return Promise.all(
    names.map(async (name) =>
      `${name}:${(await readFile(join(stateDir, name))).toString("base64")}`,
    ),
  );
}

type RunsEnvelope = {
  code: string;
  operationId: string;
  result: {
    outcome: string;
    schedule: {
      observedAtIso: string;
      admission: { active: number; inFlight: number; maxActiveRuns: number | null };
      rows: ReadonlyArray<{
        runId: string;
        placement: string;
        admissionWait: string | null;
        slot: { hostName: string; slotIndex: number } | null;
        overlapsWith: readonly string[];
      }>;
    };
    sessionStarts: ReadonlyArray<unknown>;
    truncated: boolean;
  };
};

/** Replace volatile values so the response is comparable to the fixture. */
function normalise(payload: unknown): unknown {
  const envelope = structuredClone(payload) as RunsEnvelope;
  envelope.operationId = "<operation-id>";
  envelope.result.schedule.observedAtIso = "<observed-at>";
  return envelope;
}

describe("GET /v1/runs", () => {
  it("lists the conductor schedule, redacted", async () => {
    const stateDir = await makeTempDir();
    await seedState(stateDir);
    configureWorkComposition(createConfiguredWorkComposition({ stateDir }));

    const response = await callList();
    expect(response.status).toBe(200);
    const envelope = response.payload as RunsEnvelope;
    expect(envelope.code).toBe("OK");
    expect(typeof envelope.operationId).toBe("string");
    expect(envelope.result.outcome).toBe("listed");
    expect(envelope.result.schedule.rows.map((row) => row.runId)).toEqual([RUN_0, RUN_1]);
    expect(envelope.result.schedule.rows[0]?.slot).toEqual({ hostName: "sol", slotIndex: 0 });
    expect(envelope.result.schedule.rows[0]?.placement).toBe("running");
    expect(envelope.result.schedule.rows[0]?.overlapsWith).toEqual([RUN_1]);
    expect(envelope.result.schedule.rows[1]?.placement).toBe("waiting");
    expect(envelope.result.schedule.rows[1]?.admissionWait).toBe("package-overlap");
    expect(envelope.result.schedule.admission).toEqual({
      active: 1,
      inFlight: 0,
      maxActiveRuns: null,
    });
    expect(envelope.result.sessionStarts).toHaveLength(1);

    // b. Redaction: no secret or transport detail in the raw response.
    for (const secret of [
      "alias-secret",
      "4166",
      "/srv/wt/att-1",
      "driver-secret-1",
      "holderId",
      "sshAlias",
      "transport",
      "worktreePath",
    ]) {
      expect(response.text).not.toContain(secret);
    }

    // e. Fixture: record it once, then compare against the committed file.
    const body = normalise(response.payload);
    if (process.env.FLEET_RECORD_FIXTURES === "1") {
      await mkdir(fixtureDir, { recursive: true });
      await writeFile(fixturePath, `${JSON.stringify(body, null, 2)}\n`);
    } else {
      const fileText = await readFile(fixturePath, "utf8");
      expect(body).toEqual(JSON.parse(fileText));
    }
  });

  it("answers 501 NOT_IMPLEMENTED with the unconfigured composition", async () => {
    const response = await callList();
    expect(response.status).toBe(501);
    expect(response.payload).toMatchObject({ code: "NOT_IMPLEMENTED", result: null });
  });

  it("writes nothing to the state dir", async () => {
    const stateDir = await makeTempDir();
    await seedState(stateDir);
    configureWorkComposition(createConfiguredWorkComposition({ stateDir }));

    const before = await snapshotState(stateDir);
    const response = await callList();
    expect(response.status).toBe(200);
    const after = await snapshotState(stateDir);
    expect(after).toEqual(before);
  });
});
