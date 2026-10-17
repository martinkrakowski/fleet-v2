// H8 follow-ups on the reserve and brief-prepare routes against real route
// handlers on a loopback server: a missing or undeclared `seatTool` is a 400
// on both request bodies (the seat tool is required and never defaulted), and
// a valid body reaches the reserve use case and records the seat tool.
import "./nitro-globals.js";

import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createApp, createRouter, toNodeListener } from "h3";
import { createError } from "h3";
import { afterEach, afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  configureWorkComposition,
  createConfiguredWorkComposition,
} from "../work/composition";
import capacityReservePost from "../../routes/v1/capacity/reserve.post";
import briefsPreparePost from "../../routes/v1/briefs/prepare.post";

// The routes reference Nitro's auto-imported createError; a unit test must
// provide it before the handler runs.
Object.assign(globalThis, { createError });

const createdDirs = new Set<string>();

async function makeTempDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "fleet-seat-tool-routes-"));
  createdDirs.add(directory);
  return directory;
}

let apiBaseUrl = "";
let apiServer: Server;

beforeAll(async () => {
  const router = createRouter();
  router.add("/v1/capacity/reserve", capacityReservePost, "post");
  router.add("/v1/briefs/prepare", briefsPreparePost, "post");
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

async function post(
  route: string,
  body: unknown,
): Promise<{ status: number; payload: unknown }> {
  const response = await fetch(`${apiBaseUrl}${route}`, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify(body),
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

const validReserveBody = {
  reservationId: "res-seat-1",
  attemptId: "att-seat-1",
  workOrderId: "wo-seat-1",
  hostId: "host-1",
  worktreePath: "/srv/fleet/worktrees/att-seat-1",
  maxSlots: 2,
  seatTool: "opencode",
};

describe("POST /v1/capacity/reserve with a required seatTool (H8)", () => {
  it.each([
    ["missing", undefined],
    ["blank", ""],
    ["unknown", "claude"],
    ["wrong case", "OpenCode"],
  ])("answers 400 for a %s seatTool", async (_label, seatTool) => {
    const response = await post("/v1/capacity/reserve", {
      ...validReserveBody,
      seatTool,
    });
    expect(response.status).toBe(400);
    expect(response.payload).toMatchObject({
      statusCode: 400,
      statusMessage: expect.stringContaining("seatTool is required"),
    });
  });

  it("reserves with a declared seat tool and records it", async () => {
    const stateDir = await makeTempDir();
    configureWorkComposition(createConfiguredWorkComposition({ stateDir }));

    const response = await post("/v1/capacity/reserve", validReserveBody);
    expect(response.status).toBe(200);
    expect(response.payload).toMatchObject({
      code: "OK",
      result: {
        outcome: "reserved",
        reservation: { attemptId: "att-seat-1", seatTool: "opencode" },
      },
    });
  });
});

describe("POST /v1/briefs/prepare with a required seatTool (H8)", () => {
  it.each([
    ["missing", undefined],
    ["blank", ""],
    ["unknown", "claude"],
    ["wrong case", "OpenCode"],
  ])("answers 400 for a %s seatTool", async (_label, seatTool) => {
    const response = await post("/v1/briefs/prepare", {
      workOrderId: "wo-seat-2",
      seatTool,
    });
    expect(response.status).toBe(400);
    expect(response.payload).toMatchObject({
      statusCode: 400,
      statusMessage: expect.stringContaining("seatTool is required"),
    });
  });
});
