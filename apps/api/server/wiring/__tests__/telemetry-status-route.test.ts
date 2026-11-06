// MX8: GET /v1/telemetry/status serves the telemetry status envelope through
// the real route handler on a loopback server with a temp state dir: the 501
// unconfigured answer, the status object for an enabled and a disabled
// installation, the plan-named fingerprint, that nothing is written to the
// state dir, and that the salt never crosses the boundary.
import "./nitro-globals.js";

import { createHmac } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createApp, createRouter, toNodeListener } from "h3";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { FleetInstallation } from "@fleet/installation";

import { configureTelemetryReadComposition } from "../telemetry/composition";
import telemetryStatusGet from "../../routes/v1/telemetry/status.get";

const SALT = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const ENABLED_INSTALLATION: FleetInstallation = {
  schemaVersion: 2,
  hosts: {
    orch: {
      transport: "local",
      worktreeRoot: "/srv/fleet/orch",
      roles: ["orchestrator"],
    },
  },
  forge: { mode: "none" },
  policy: {
    telemetry: {
      enabled: true,
      route: "collector",
      salt: SALT,
    },
  },
};

const DISABLED_INSTALLATION: FleetInstallation = {
  schemaVersion: 2,
  hosts: {},
  forge: { mode: "none" },
};

const createdDirs = new Set<string>();

async function makeTempDir(): Promise<string> {
  const directory = await mkdtemp(
    join(tmpdir(), "fleet-telemetry-status-route-"),
  );
  createdDirs.add(directory);
  return directory;
}

let apiBaseUrl = "";
let apiServer: Server;

beforeAll(async () => {
  const router = createRouter();
  router.add("/v1/telemetry/status", telemetryStatusGet, "get");
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
  configureTelemetryReadComposition(null);
});

async function callStatus(): Promise<{
  status: number;
  payload: unknown;
  text: string;
}> {
  const response = await fetch(`${apiBaseUrl}/v1/telemetry/status`, {
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

/** The relative names of every file under the state dir, sorted. */
async function snapshotStateNames(stateDir: string): Promise<string[]> {
  return (await readdir(stateDir, { recursive: true })).sort();
}

interface TelemetryStatusResult {
  outcome: string;
  enabled: boolean;
  saltFingerprint: string | null;
  recordedSaltFingerprint: string | null;
  fingerprintMatch: boolean | null;
  schemaVersion: number;
  hashPrefix: string;
  route: string;
  lastExportAtIso: string | null;
  spans: Record<string, number>;
  counters: Record<string, number>;
}

interface TelemetryStatusEnvelope {
  code: string;
  operationId: string;
  result: TelemetryStatusResult;
}

describe("GET /v1/telemetry/status", () => {
  it("answers 501 NOT_IMPLEMENTED with the unconfigured composition", async () => {
    const response = await callStatus();
    expect(response.status).toBe(501);
    const envelope = response.payload as {
      code: string;
      operationId: string;
      result: null;
    };
    expect(envelope.code).toBe("NOT_IMPLEMENTED");
    expect(envelope.result).toBeNull();
    expect(typeof envelope.operationId).toBe("string");
  });

  it("serves the status object for an enabled installation", async () => {
    const stateDir = await makeTempDir();
    configureTelemetryReadComposition({
      stateDir,
      installation: ENABLED_INSTALLATION,
    });

    const response = await callStatus();
    expect(response.status).toBe(200);
    const envelope = response.payload as TelemetryStatusEnvelope;
    expect(envelope.code).toBe("OK");
    expect(envelope.result.outcome).toBe("status");
    expect(envelope.result.enabled).toBe(true);
    expect(envelope.result.route).toBe("collector");
    expect(envelope.result.schemaVersion).toBe(1);
    expect(envelope.result.hashPrefix).toBe("fleet-telemetry/v1");
    expect(envelope.result.recordedSaltFingerprint).toBeNull();
    expect(envelope.result.fingerprintMatch).toBeNull();
    expect(envelope.result.lastExportAtIso).toBeNull();
    expect(envelope.result.spans.pending).toBe(0);
    expect(envelope.result.spans["exported@collector"]).toBe(0);
    expect(envelope.result.counters["queue-drops"]).toBe(0);
  });

  it("reports the fingerprint the plan names", async () => {
    const stateDir = await makeTempDir();
    configureTelemetryReadComposition({
      stateDir,
      installation: ENABLED_INSTALLATION,
    });
    const expectedFingerprint = Buffer.from(
      createHmac("sha256", Buffer.from(SALT, "hex"))
        .update("fleet-telemetry/v1/fingerprint", "utf8")
        .digest()
        .subarray(0, 4),
    ).toString("hex");

    const response = await callStatus();
    expect(response.status).toBe(200);
    const envelope = response.payload as TelemetryStatusEnvelope;
    expect(envelope.result.saltFingerprint).toBe(expectedFingerprint);
    expect(envelope.result.saltFingerprint).toMatch(/^[0-9a-f]{8}$/);
  });

  it("serves a disabled installation with no salt", async () => {
    const stateDir = await makeTempDir();
    configureTelemetryReadComposition({
      stateDir,
      installation: DISABLED_INSTALLATION,
    });

    const response = await callStatus();
    expect(response.status).toBe(200);
    const envelope = response.payload as TelemetryStatusEnvelope;
    expect(envelope.result.enabled).toBe(false);
    expect(envelope.result.saltFingerprint).toBeNull();
  });

  it("writes nothing to the state dir", async () => {
    const stateDir = await makeTempDir();
    configureTelemetryReadComposition({
      stateDir,
      installation: ENABLED_INSTALLATION,
    });

    const before = await snapshotStateNames(stateDir);
    const response = await callStatus();
    expect(response.status).toBe(200);
    const after = await snapshotStateNames(stateDir);
    expect(after).toEqual(before);
  });

  it("never carries the salt, the endpoint or a token", async () => {
    const stateDir = await makeTempDir();
    configureTelemetryReadComposition({
      stateDir,
      installation: ENABLED_INSTALLATION,
    });

    const response = await callStatus();
    expect(response.status).toBe(200);
    expect(response.text).not.toContain(SALT);
  });
});
