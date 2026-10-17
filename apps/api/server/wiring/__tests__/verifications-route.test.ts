// H4 follow-ups on POST /v1/verifications against the real route handler on a
// loopback server: a v2 request with a body `hostId` is a 400 (the host comes
// from the installation, never the caller), and a v2 installation with no
// verifier role falls back to the orchestrator host instead of refusing, so
// verification runs locally. The implementer seat is read from a seeded
// attempt; the verification executor has no allow-listed procedures, so no
// subprocess runs and the receipts carry the host the route selected.
import "./nitro-globals.js";

import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createApp, createRouter, toNodeListener } from "h3";
import { createError } from "h3";
import { afterEach, afterAll, beforeAll, describe, expect, it } from "vitest";

import { parseInstallation, type FleetInstallation } from "@fleet/installation";
import { AttemptRepositoryAdapter } from "@fleet/work-execution";

import {
  configureEvidenceUseCases,
  createConfiguredEvidenceUseCases,
} from "../evidence/composition";
import {
  configureWorkComposition,
  createConfiguredWorkComposition,
} from "../work/composition";
import verificationsIndexPost from "../../routes/v1/verifications/index.post";

// The route references Nitro's auto-imported createError; a unit test must
// provide it before the handler runs.
Object.assign(globalThis, { createError });

/** Parse one v2 installation through the loader; a failure fails the test. */
function parseV2(file: unknown): FleetInstallation {
  const result = parseInstallation(file);
  if (!result.ok) {
    throw new Error(
      `test installation failed to parse: ${JSON.stringify(result.errors)}`,
    );
  }
  return result.installation;
}

/** A v2 installation with no verifier role: verification falls back local. */
function noVerifierInstallation(): FleetInstallation {
  return parseV2({
    schemaVersion: 2,
    forge: { mode: "none" },
    hosts: {
      here: {
        transport: "local",
        worktreeRoot: "/srv/fleet/worktrees",
        roles: ["orchestrator", "lane-runner"],
        runner: { kind: "opencode", port: 46000 },
      },
    },
  });
}

const createdDirs = new Set<string>();

async function makeTempDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "fleet-verifications-route-"));
  createdDirs.add(directory);
  return directory;
}

let apiBaseUrl = "";
let apiServer: Server;

beforeAll(async () => {
  const router = createRouter();
  router.add("/v1/verifications", verificationsIndexPost, "post");
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
  configureEvidenceUseCases(null);
});

async function callVerifications(body: unknown): Promise<{
  status: number;
  payload: unknown;
}> {
  const response = await fetch(`${apiBaseUrl}/v1/verifications`, {
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

describe("POST /v1/verifications with a v2 installation (H4 follow-ups)", () => {
  it("answers 400 when the body carries a hostId", async () => {
    const stateDir = await makeTempDir();
    const installation = noVerifierInstallation();
    configureWorkComposition(
      createConfiguredWorkComposition({ stateDir, installation }),
    );
    configureEvidenceUseCases(
      createConfiguredEvidenceUseCases({ stateDir, installation }),
    );

    const response = await callVerifications({
      assessmentId: "assess-400",
      projectId: "proj",
      attemptId: "att-400",
      candidateHeadSha: "a".repeat(40),
      policyRevision: "policy-1",
      hostId: "operator-typed-host",
      requiredChecks: ["gate"],
    });
    expect(response.status).toBe(400);
    expect(response.payload).toMatchObject({
      statusCode: 400,
      statusMessage: expect.stringContaining(
        "hostId is not accepted for a v2 installation",
      ),
    });
  });

  it("falls back to the orchestrator host when no host is a verifier", async () => {
    const stateDir = await makeTempDir();
    const installation = noVerifierInstallation();
    // The route binds the implementer seat from the attempt's own record.
    const attempts = new AttemptRepositoryAdapter({ stateDir });
    await attempts.saveAttempt({
      id: "att-nv",
      workOrderId: "wo-nv",
      kind: "initial",
      fixNumber: 0,
      priorAttemptId: null,
      worktreePath: "/srv/fleet/worktrees/att-nv",
      baseCommit: "0".repeat(40),
      state: "ended",
      outcome: "done",
      briefDigest: null,
      briefPackagePath: null,
      sessionId: null,
      completionReceipt: null,
      artifacts: null,
      runner: {
        kind: "opencode",
        remotePort: 46000,
        host: null,
        hostName: "here",
        agent: "lane",
        model: "provider/glm-5.3",
        variant: null,
      },
      createdAtIso: "2026-10-17T08:00:00.000Z",
      updatedAtIso: "2026-10-17T08:00:00.000Z",
    });
    configureWorkComposition(
      createConfiguredWorkComposition({ stateDir, installation }),
    );
    configureEvidenceUseCases(
      createConfiguredEvidenceUseCases({ stateDir, installation }),
    );

    const response = await callVerifications({
      assessmentId: "assess-nv",
      projectId: "proj",
      attemptId: "att-nv",
      candidateHeadSha: "a".repeat(40),
      policyRevision: "policy-1",
      requiredChecks: ["gate"],
    });
    expect(response.status).toBe(200);
    const envelope = response.payload as {
      code: string;
      result: {
        outcome: string;
        receipts: ReadonlyArray<{ hostId: string; result: string }>;
      };
    };
    expect(envelope.code).toBe("OK");
    expect(envelope.result.outcome).toBe("completed");
    // The orchestrator host is recorded as the verification host, so the
    // checks run locally instead of the request being refused.
    expect(envelope.result.receipts[0]?.hostId).toBe("here");
    expect(envelope.result.receipts[0]?.result).toBe("unknown");
  });
});
