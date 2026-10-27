// The /v1/reviews route binds the installation's reviewer seat through the
// review transport router, exactly as the CLI does: the router selects the
// seat by exact model, locates the attempt through its recorded host, and
// runs `ocm-run` on that host's opencode server. The real route handler is
// served on a loopback HTTP server against the real composition roots; the
// ocm-run subprocess is a spy, so the assertions below cover the wiring, the
// routing source (the v2 installation's hosts, never the environment) and the
// refusal paths.
import "./nitro-globals.js";

import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createApp, createRouter, toNodeListener } from "h3";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { AttemptRepositoryAdapter } from "@fleet/work-execution";
import {
  EvidenceAssessmentRepositoryAdapter,
  type OcmReviewTransportSpawn,
} from "@fleet/evidence-and-acceptance";
import type { FleetInstallation } from "@fleet/installation";

import reviewsIndexPost from "../../routes/v1/reviews/index.post";
import { configureFleetApiRuntime } from "../runtime";

const ATTEMPT_ID = "attempt-rw3-1";
const ASSESSMENT_ID = "assessment-attempt-rw3-1";
const PROJECT_ID = "proj-rw3-1";
const POLICY_REVISION = "policy-1";
const IMPLEMENTER_MODEL = "example-provider/glm-5.3";
const REVIEWER_MODEL = "example-provider/grok-4.7";

const INSTALLATION: FleetInstallation = {
  schemaVersion: 2,
  hosts: {
    "this-machine": {
      transport: "local",
      worktreeRoot: "/home/developer/fleet-worktrees",
      tmpDir: "/home/developer/fleet-worktrees/.tmp",
      roles: ["orchestrator", "lane-runner", "verifier"],
      runner: {
        kind: "opencode",
        port: 46000,
        capabilities: {
          networkEgressRestricted: false,
          cpuAndMemoryLimited: false,
          processTreeTermination: false,
          filesystemScope: "inherited-directory",
        },
        maxLanes: 1,
      },
    },
  },
  tools: ["opencode"],
  seats: [
    {
      id: "implementer",
      tool: "opencode",
      model: IMPLEMENTER_MODEL,
      agent: "example-agent",
      roles: ["implementer"],
      costClass: "plan-quota",
    },
    {
      id: "reviewer",
      tool: "opencode",
      model: REVIEWER_MODEL,
      agent: "example-agent",
      roles: ["reviewer"],
      costClass: "paid",
    },
  ],
  chains: {
    implementer: [{ seatId: "implementer" }],
    reviewer: [{ seatId: "reviewer" }],
  },
  shelf: { provider: "local" },
  forge: { mode: "none" },
};

const INSTALLATION_NO_REVIEWER: FleetInstallation = {
  schemaVersion: 2,
  hosts: INSTALLATION.hosts,
  tools: ["opencode"],
  seats: [
    {
      id: "implementer",
      tool: "opencode",
      model: IMPLEMENTER_MODEL,
      agent: "example-agent",
      roles: ["implementer"],
      costClass: "plan-quota",
    },
  ],
  chains: {
    implementer: [{ seatId: "implementer" }],
  },
  shelf: { provider: "local" },
  forge: { mode: "none" },
};

interface Envelope {
  readonly code: string;
  readonly result: { readonly outcome?: string; readonly reason?: string } | null;
}

const createdDirs = new Set<string>();

async function makeTempDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "fleet-reviews-transport-"));
  createdDirs.add(directory);
  return directory;
}

/** Create a real temporary git repository with two commits (base, head). */
async function makeGitRepo(): Promise<{ dir: string; base: string; head: string }> {
  const dir = await makeTempDir();
  execFileSync("git", ["init", "-q", dir], { stdio: "ignore" });
  writeFileSync(join(dir, "file.txt"), "base\n");
  execFileSync("git", ["-C", dir, "add", "."], { stdio: "ignore" });
  execFileSync(
    "git",
    [
      "-C",
      dir,
      "-c",
      "user.email=test@example.com",
      "-c",
      "user.name=Fleet Test",
      "-c",
      "commit.gpgSign=false",
      "commit",
      "-q",
      "-m",
      "base",
    ],
    { stdio: "ignore" },
  );
  const base = execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  writeFileSync(join(dir, "file.txt"), "head\n");
  execFileSync("git", ["-C", dir, "add", "."], { stdio: "ignore" });
  execFileSync(
    "git",
    [
      "-C",
      dir,
      "-c",
      "user.email=test@example.com",
      "-c",
      "user.name=Fleet Test",
      "-c",
      "commit.gpgSign=false",
      "commit",
      "-q",
      "-m",
      "head",
    ],
    { stdio: "ignore" },
  );
  const head = execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  return { dir, base, head };
}

/** Seed the attempt whose recorded runner seat is the implementer on this-machine. */
async function seedAttempt(
  stateDir: string,
  repoDir: string,
  baseCommit: string,
  headCommit: string,
): Promise<void> {
  const repo = new AttemptRepositoryAdapter({ stateDir });
  await repo.saveAttempt({
    id: ATTEMPT_ID,
    workOrderId: "wo-rw3-1",
    kind: "initial",
    fixNumber: 0,
    priorAttemptId: null,
    worktreePath: repoDir,
    baseCommit,
    state: "collected",
    outcome: "done",
    briefDigest: "digest-1",
    briefPackagePath: null,
    sessionId: "session-1",
    completionReceipt: null,
    artifacts: {
      headCommit,
      commitsSinceBase: [],
      collectedArtifactPaths: [],
      notes: "missing",
    },
    runner: {
      kind: "opencode",
      remotePort: 46000,
      host: null,
      hostName: "this-machine",
      agent: "example-agent",
      model: IMPLEMENTER_MODEL,
      variant: null,
    },
    createdAtIso: "2026-10-16T08:00:00.000Z",
    updatedAtIso: "2026-10-16T08:30:00.000Z",
  });
}

/** Seed the pending assessment for the attempt at the exact head. */
async function seedAssessment(stateDir: string, headCommit: string): Promise<void> {
  await new EvidenceAssessmentRepositoryAdapter({ stateDir }).saveAssessment({
    id: ASSESSMENT_ID,
    projectId: PROJECT_ID,
    attemptId: ATTEMPT_ID,
    candidateHeadSha: headCommit,
    policyRevision: POLICY_REVISION,
    implementerModel: IMPLEMENTER_MODEL,
    requiredChecks: [],
    state: "pending",
    verificationReceipts: [],
    reviewReceipts: [],
    findingDispositions: [],
    acceptanceReceiptId: null,
    blockers: [],
    revision: 0,
    updatedAtIso: "2026-10-16T08:30:00.000Z",
  });
}

interface SpawnCall {
  readonly file: string;
  readonly args: readonly string[];
  readonly env: Record<string, string>;
}

/** A spy ocm-run spawn that reports a clean read-only PASS review. */
function makeSpy(): { spy: OcmReviewTransportSpawn; calls: SpawnCall[] } {
  const calls: SpawnCall[] = [];
  const spy: OcmReviewTransportSpawn = async (file, args, env) => {
    calls.push({ file, args, env });
    return {
      exitCode: 0,
      stdout:
        '{"type":"step_start","part":{"type":"step-start"}}\n' +
        '{"type":"text","part":{"type":"text","text":"VERDICT: PASS\\n"}}',
      stderr: "",
    };
  };
  return { spy, calls };
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
    assessmentId: ASSESSMENT_ID,
    projectId: PROJECT_ID,
    attemptId: ATTEMPT_ID,
    candidateHeadSha: "0123456789abcdef0123456789abcdef01234567",
    policyRevision: POLICY_REVISION,
    reviewerModel: REVIEWER_MODEL,
    ...overrides,
  };
}

describe("POST /v1/reviews review transport wiring", () => {
  it("runs the review through ocm-run on the recorded host's port", async () => {
    const { dir: repoDir, base, head } = await makeGitRepo();
    const stateDir = await makeTempDir();
    await seedAttempt(stateDir, repoDir, base, head);
    await seedAssessment(stateDir, head);
    const { spy, calls } = makeSpy();
    configureFleetApiRuntime({ stateDir, installation: INSTALLATION, reviewSpawn: spy });

    const response = await callReviews(reviewRequest({ candidateHeadSha: head }));

    expect(response.status).toBe(200);
    expect(response.envelope.result?.outcome).toBe("reviewed");
    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call.args).toContain("--dir");
    expect(call.args[call.args.indexOf("--dir") + 1]).toBe(repoDir);
    expect(call.args).toContain("-m");
    expect(call.args[call.args.indexOf("-m") + 1]).toBe(REVIEWER_MODEL);
    expect(call.env.OCM_REMOTE_PORT).toBe("46000");
    expect(call.env.OCM_HOST).toBe("");
  });

  it("never reads OCM_HOST from the environment on a v2 installation", async () => {
    const { dir: repoDir, base, head } = await makeGitRepo();
    const stateDir = await makeTempDir();
    await seedAttempt(stateDir, repoDir, base, head);
    await seedAssessment(stateDir, head);
    const previous = process.env.OCM_HOST;
    process.env.OCM_HOST = "leak.example";
    try {
      const { spy, calls } = makeSpy();
      configureFleetApiRuntime({ stateDir, installation: INSTALLATION, reviewSpawn: spy });

      const response = await callReviews(reviewRequest({ candidateHeadSha: head }));

      expect(response.envelope.result?.outcome).toBe("reviewed");
      expect(calls).toHaveLength(1);
      expect(calls[0].env.OCM_HOST).toBe("");
    } finally {
      if (previous === undefined) {
        delete process.env.OCM_HOST;
      } else {
        process.env.OCM_HOST = previous;
      }
    }
  });

  it("reports no transport when the installation names no reviewer seat", async () => {
    const { dir: repoDir, base, head } = await makeGitRepo();
    const stateDir = await makeTempDir();
    await seedAttempt(stateDir, repoDir, base, head);
    await seedAssessment(stateDir, head);
    const { spy, calls } = makeSpy();
    configureFleetApiRuntime({
      stateDir,
      installation: INSTALLATION_NO_REVIEWER,
      reviewSpawn: spy,
    });

    const response = await callReviews(reviewRequest({ candidateHeadSha: head }));

    expect(response.envelope.result?.outcome).toBe("rejected");
    expect(response.envelope.result?.reason).toBe("No independent review transport is configured");
    expect(calls).toHaveLength(0);
  });

  it("refuses a reviewer model no seat serves", async () => {
    const { dir: repoDir, base, head } = await makeGitRepo();
    const stateDir = await makeTempDir();
    await seedAttempt(stateDir, repoDir, base, head);
    await seedAssessment(stateDir, head);
    const { spy, calls } = makeSpy();
    configureFleetApiRuntime({ stateDir, installation: INSTALLATION, reviewSpawn: spy });

    const response = await callReviews(
      reviewRequest({
        candidateHeadSha: head,
        reviewerModel: "example-provider/claude-sonnet-4.5",
      }),
    );

    expect(response.envelope.result?.outcome).toBe("rejected");
    expect(response.envelope.result?.reason).toContain(
      "No reviewer seat in the installation serves model",
    );
    expect(calls).toHaveLength(0);
  });

  it("refuses a reviewer in the implementer's model family", async () => {
    const { dir: repoDir, base, head } = await makeGitRepo();
    const stateDir = await makeTempDir();
    await seedAttempt(stateDir, repoDir, base, head);
    await seedAssessment(stateDir, head);
    const { spy, calls } = makeSpy();
    configureFleetApiRuntime({ stateDir, installation: INSTALLATION, reviewSpawn: spy });

    const response = await callReviews(
      reviewRequest({ candidateHeadSha: head, reviewerModel: "other-provider/glm-5.3-flash" }),
    );

    expect(response.envelope.result?.outcome).toBe("rejected");
    expect(response.envelope.result?.reason).toContain("share the same underlying model");
    expect(calls).toHaveLength(0);
  });
});
