// The /v1/reviews route binds the implementer seat to the attempt's recorded
// seat. Independence is a fact about the lane, so a caller never supplies the
// implementer model: a supplied value may only restate the recorded seat, an
// attempt with no recorded seat is refused, and the unconfigured runtime still
// answers 501. The real H3 route handler is served on a loopback HTTP server
// against the real composition roots; no review transport runs, so every
// assertion below is the boundary's own answer.
import "./nitro-globals.js";

import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createApp, createRouter, toNodeListener } from "h3";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { AttemptRepositoryAdapter } from "@fleet/work-execution";

import reviewsIndexPost from "../../routes/v1/reviews/index.post";
import { configureFleetApiRuntime } from "../runtime";

const ATTEMPT_ID = "attempt-seat-1";
const UNKNOWN_ATTEMPT_ID = "attempt-never-dispatched";
const HEAD_SHA = "0123456789abcdef0123456789abcdef01234567";
const SEAT_MODEL = "nvidia/z-ai/glm-5.3";
const PROJECT_ID = "proj-seat-1";
const POLICY_REVISION = "policy-1";

interface Envelope {
  readonly code: string;
  readonly result: { readonly outcome?: string; readonly reason?: string } | null;
}

const createdDirs = new Set<string>();

async function makeTempDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "fleet-reviews-seat-"));
  createdDirs.add(directory);
  return directory;
}

/** Seed one collected attempt whose recorded runner seat is the implementer. */
async function seedAttempt(stateDir: string, withSeat: boolean): Promise<void> {
  const repo = new AttemptRepositoryAdapter({ stateDir });
  await repo.saveAttempt({
    id: ATTEMPT_ID,
    workOrderId: "wo-seat-1",
    kind: "initial",
    fixNumber: 0,
    priorAttemptId: null,
    worktreePath: join(stateDir, "lanes", ATTEMPT_ID),
    baseCommit: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    state: "collected",
    outcome: "done",
    briefDigest: "digest-1",
    briefPackagePath: null,
    sessionId: "session-1",
    completionReceipt: null,
    artifacts: {
      headCommit: HEAD_SHA,
      commitsSinceBase: [],
      collectedArtifactPaths: [],
      notes: "missing",
    },
    runner: withSeat
      ? { remotePort: 4166, host: null, agent: null, model: SEAT_MODEL, variant: null }
      : null,
    createdAtIso: "2026-10-16T08:00:00.000Z",
    updatedAtIso: "2026-10-16T08:30:00.000Z",
  });
}

let apiBaseUrl = "";
let apiServer: Server;

beforeAll(async () => {
  const router = createRouter();
  router.add("/v1/reviews", reviewsIndexPost, "post");
  const app = createApp();
  app.use(router);
  apiServer = createServer(toNodeListener(app));
  await new Promise<void>((resolve) => apiServer.listen(0, "127.0.0.1", () => resolve()));
  const address = apiServer.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
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
    [...createdDirs].map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

afterEach(() => {
  configureFleetApiRuntime(null);
});

async function callReviews(body: unknown): Promise<{ status: number; envelope: Envelope }> {
  const response = await fetch(`${apiBaseUrl}/v1/reviews`, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = (await response.json()) as Envelope;
  return { status: response.status, envelope: payload };
}

function reviewRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    assessmentId: `assessment-${ATTEMPT_ID}`,
    projectId: PROJECT_ID,
    attemptId: ATTEMPT_ID,
    candidateHeadSha: HEAD_SHA,
    policyRevision: POLICY_REVISION,
    reviewerModel: "openrouter/anthropic/claude-sonnet-4.5",
    ...overrides,
  };
}

describe("POST /v1/reviews implementer seat binding", () => {
  it("answers 501 while unconfigured, because no seat can be resolved", async () => {
    configureFleetApiRuntime(null);

    const response = await callReviews(reviewRequest());

    expect(response.status).toBe(501);
    expect(response.envelope.code).toBe("NOT_IMPLEMENTED");
  });

  it("binds the implementer model to the attempt seat without being told one", async () => {
    const stateDir = await makeTempDir();
    await seedAttempt(stateDir, true);
    configureFleetApiRuntime({ stateDir });

    // No `implementerModel` in the body: the recorded seat is bound and the
    // request reaches the evidence use case, which refuses it for its own
    // reason (no assessment exists yet), never for a missing implementer model.
    const response = await callReviews(reviewRequest());

    expect(response.status).toBe(200);
    expect(response.envelope.code).toBe("OK");
    expect(response.envelope.result?.outcome).toBe("rejected");
    expect(response.envelope.result?.reason).toContain("No assessment exists for assessmentId");
  });

  it("refuses a supplied implementerModel that differs from the recorded seat", async () => {
    const stateDir = await makeTempDir();
    await seedAttempt(stateDir, true);
    configureFleetApiRuntime({ stateDir });

    const response = await callReviews(
      reviewRequest({ implementerModel: "opencode/longcat-2.5-preview-free" }),
    );

    expect(response.status).toBe(200);
    expect(response.envelope.result?.outcome).toBe("rejected");
    expect(response.envelope.result?.reason).toContain("implementerModel");
    expect(response.envelope.result?.reason).toContain(
      `attempt '${ATTEMPT_ID}' was dispatched on seat '${SEAT_MODEL}'`,
    );
  });

  it("refuses a reviewer on the recorded seat reached through another provider", async () => {
    const stateDir = await makeTempDir();
    await seedAttempt(stateDir, true);
    configureFleetApiRuntime({ stateDir });

    const response = await callReviews(reviewRequest({ reviewerModel: "openrouter/z-ai/glm-5.3" }));

    expect(response.status).toBe(200);
    expect(response.envelope.result?.outcome).toBe("rejected");
    expect(response.envelope.result?.reason).toContain("share the same underlying model");
    expect(response.envelope.result?.reason).toContain(SEAT_MODEL);
  });

  it("refuses an attempt that records no implementer seat", async () => {
    const stateDir = await makeTempDir();
    await seedAttempt(stateDir, false);
    configureFleetApiRuntime({ stateDir });

    const response = await callReviews(reviewRequest());

    expect(response.status).toBe(200);
    expect(response.envelope.result?.outcome).toBe("rejected");
    expect(response.envelope.result?.reason).toBe(
      `Attempt ${ATTEMPT_ID} records no implementer seat: neither the dispatched runner model nor the frozen brief manifest's model assignment is known`,
    );
  });

  it("refuses an attempt that was never dispatched", async () => {
    const stateDir = await makeTempDir();
    configureFleetApiRuntime({ stateDir });

    const response = await callReviews(reviewRequest({ attemptId: UNKNOWN_ATTEMPT_ID }));

    expect(response.status).toBe(200);
    expect(response.envelope.result?.outcome).toBe("rejected");
    expect(response.envelope.result?.reason).toBe(`Attempt not found: '${UNKNOWN_ATTEMPT_ID}'`);
  });
});
