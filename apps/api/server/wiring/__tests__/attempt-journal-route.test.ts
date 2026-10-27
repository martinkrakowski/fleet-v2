// A-J: GET /v1/attempts/:id/journal lists one attempt's action journal through
// the real route handler on a loopback server with a temp state dir.
import "./nitro-globals.js";

import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createApp, createRouter, toNodeListener } from "h3";
import { afterEach, afterAll, beforeAll, describe, expect, it } from "vitest";

import { AttemptRepositoryAdapter, ExecutionJournalAdapter } from "@fleet/work-execution";

import {
  configureWorkComposition,
  createConfiguredWorkComposition,
} from "../work/composition";
import attemptJournalGet from "../../routes/v1/attempts/[id]/journal.get";

const createdDirs = new Set<string>();

async function makeTempDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "fleet-attempt-journal-route-"));
  createdDirs.add(directory);
  return directory;
}

let apiBaseUrl = "";
let apiServer: Server;

beforeAll(async () => {
  const router = createRouter();
  router.get("/v1/attempts/:id/journal", attemptJournalGet);
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

async function seedState(stateDir: string, withJournal = true): Promise<void> {
  const attemptRepo = new AttemptRepositoryAdapter({ stateDir });
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

  if (withJournal) {
    const journal = new ExecutionJournalAdapter({ stateDir });
    await journal.appendJournalEntry({
      id: "j-1",
      attemptId: "att-1",
      workOrderId: "wo-1",
      action: "dispatch",
      baseCommit: "0".repeat(40),
      recordedAtIso: "2026-10-20T09:00:00.000Z",
      status: "intent-recorded",
      sessionId: null,
      detail: null,
    });
    await journal.appendJournalEntry({
      id: "j-2",
      attemptId: "att-1",
      workOrderId: "wo-1",
      action: "dispatch",
      baseCommit: "0".repeat(40),
      recordedAtIso: "2026-10-20T09:01:00.000Z",
      status: "completed",
      sessionId: null,
      detail: null,
    });
    await journal.appendJournalEntry({
      id: "j-3",
      attemptId: "att-other",
      workOrderId: "wo-1",
      action: "dispatch",
      baseCommit: "0".repeat(40),
      recordedAtIso: "2026-10-20T10:00:00.000Z",
      status: "intent-recorded",
      sessionId: null,
      detail: null,
    });
  }
}

async function callJournal(attemptId: string): Promise<{ status: number; payload: unknown }> {
  const response = await fetch(`${apiBaseUrl}/v1/attempts/${attemptId}/journal`, {
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

describe("GET /v1/attempts/:id/journal", () => {
  it("lists an attempt's journal entries in recorded order with no operations block", async () => {
    const stateDir = await makeTempDir();
    await seedState(stateDir);
    configureWorkComposition(createConfiguredWorkComposition({ stateDir }));

    const response = await callJournal("att-1");
    expect(response.status).toBe(200);
    const payload = response.payload as {
      operationId: string;
      code: string;
      result: {
        outcome: string;
        attemptId: string;
        entries: ReadonlyArray<{ id: string }>;
      };
    };
    expect(payload.code).toBe("OK");
    expect(payload.result.outcome).toBe("listed");
    expect(payload.result.attemptId).toBe("att-1");
    expect(payload.result.entries.map((entry) => entry.id)).toEqual(["j-1", "j-2"]);
    expect(payload).not.toHaveProperty("operations");
    expect(payload.result).not.toHaveProperty("operations");
  });

  it("answers 404 NOT_FOUND for an unknown attempt", async () => {
    const stateDir = await makeTempDir();
    await seedState(stateDir);
    configureWorkComposition(createConfiguredWorkComposition({ stateDir }));

    const response = await callJournal("att-unknown");
    expect(response.status).toBe(404);
    expect(response.payload).toMatchObject({ code: "NOT_FOUND", result: null });
  });

  it("answers 501 NOT_IMPLEMENTED with the unconfigured composition", async () => {
    const response = await callJournal("att-1");
    expect(response.status).toBe(501);
    expect(response.payload).toMatchObject({ code: "NOT_IMPLEMENTED" });
  });

  it("lists empty entries for a known attempt with no journal entries", async () => {
    const stateDir = await makeTempDir();
    await seedState(stateDir, false);
    configureWorkComposition(createConfiguredWorkComposition({ stateDir }));

    const response = await callJournal("att-1");
    expect(response.status).toBe(200);
    expect(response.payload).toMatchObject({
      code: "OK",
      result: { outcome: "listed", attemptId: "att-1", entries: [] },
    });
  });
});
