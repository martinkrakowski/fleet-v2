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

const API_REVIEWER_MODEL = "example-vendor/review-api-1";
const API_BASE_URL_OK = "http://10.60.0.1:4176/inception/v1";

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

const INSTALLATION_API_REVIEWER: FleetInstallation = {
  schemaVersion: 2,
  hosts: INSTALLATION.hosts,
  tools: ["opencode", "api"],
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
      id: "reviewer-api",
      tool: "api",
      model: API_REVIEWER_MODEL,
      roles: ["reviewer"],
      costClass: "paid",
    },
  ],
  chains: {
    implementer: [{ seatId: "implementer" }],
    reviewer: [{ seatId: "reviewer-api" }],
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

/** Set the two api review variables for one call and restore them afterwards. */
async function withApiReviewEnv(
  values: { baseUrl?: string; schema?: string },
  run: () => Promise<void>,
): Promise<void> {
  const previousBase = process.env.FLEET_REVIEW_API_BASE_URL;
  const previousSchema = process.env.FLEET_REVIEW_API_SCHEMA;
  const restore = (name: string, previous: string | undefined): void => {
    if (previous === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = previous;
    }
  };
  if (values.baseUrl === undefined) {
    delete process.env.FLEET_REVIEW_API_BASE_URL;
  } else {
    process.env.FLEET_REVIEW_API_BASE_URL = values.baseUrl;
  }
  if (values.schema === undefined) {
    delete process.env.FLEET_REVIEW_API_SCHEMA;
  } else {
    process.env.FLEET_REVIEW_API_SCHEMA = values.schema;
  }
  try {
    await run();
  } finally {
    restore("FLEET_REVIEW_API_BASE_URL", previousBase);
    restore("FLEET_REVIEW_API_SCHEMA", previousSchema);
  }
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
    const previousPort = process.env.OCM_REMOTE_PORT;
    process.env.OCM_REMOTE_PORT = "59999";
    try {
      const response = await callReviews(reviewRequest({ candidateHeadSha: head }));

      expect(response.status).toBe(200);
      expect(response.envelope.result?.outcome).toBe("reviewed");
      // RV4: the idle --wait probe is spawned first, then the review.
      expect(calls).toHaveLength(2);
      expect(calls[0].args.slice(0, 3)).toEqual(["--wait", "--dir", repoDir]);
      const call = calls[1];
      expect(call.args).toContain("--dir");
      expect(call.args[call.args.indexOf("--dir") + 1]).toBe(repoDir);
      expect(call.args).toContain("-m");
      expect(call.args[call.args.indexOf("-m") + 1]).toBe(REVIEWER_MODEL);
      expect(call.env.OCM_REMOTE_PORT).toBe("46000");
      expect(call.env.OCM_HOST).toBe("");
    } finally {
      if (previousPort === undefined) {
        delete process.env.OCM_REMOTE_PORT;
      } else {
        process.env.OCM_REMOTE_PORT = previousPort;
      }
    }
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
      expect(calls).toHaveLength(2);
      expect(calls[1].env.OCM_HOST).toBe("");
    } finally {
      if (previous === undefined) {
        delete process.env.OCM_HOST;
      } else {
        process.env.OCM_HOST = previous;
      }
    }
  });

  it("hides host names and paths when the review transport fails", async () => {
    const { dir: repoDir, base, head } = await makeGitRepo();
    const stateDir = await makeTempDir();
    await seedAttempt(stateDir, repoDir, base, head);
    await seedAssessment(stateDir, head);
    // A spy whose spawned ocm-run fails: the transport's refusal carries the
    // worktree path, and a locator refusal would carry the recorded host.
    const spy: OcmReviewTransportSpawn = async () => ({
      exitCode: 1,
      stdout: "",
      stderr: `spawn failed for ${repoDir} on this-machine`,
    });
    configureFleetApiRuntime({ stateDir, installation: INSTALLATION, reviewSpawn: spy });

    const response = await callReviews(reviewRequest({ candidateHeadSha: head }));

    expect(response.status).toBe(200);
    expect(response.envelope.result?.outcome).toBe("rejected");
    expect(response.envelope.result?.reason).toBe("review transport unavailable");
    expect(response.envelope.result?.reason).not.toContain(repoDir);
    expect(response.envelope.result?.reason).not.toContain("this-machine");
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

  it("passes an api configuration problem through with its text", async () => {
    const { dir: repoDir, base, head } = await makeGitRepo();
    const stateDir = await makeTempDir();
    await seedAttempt(stateDir, repoDir, base, head);
    await seedAssessment(stateDir, head);
    await withApiReviewEnv({ baseUrl: API_BASE_URL_OK, schema: "tool" }, async () => {
      const { spy } = makeSpy();
      configureFleetApiRuntime({
        stateDir,
        installation: INSTALLATION_API_REVIEWER,
        reviewSpawn: spy,
      });

      const response = await callReviews(
        reviewRequest({ candidateHeadSha: head, reviewerModel: API_REVIEWER_MODEL }),
      );

      expect(response.envelope.result?.outcome).toBe("rejected");
      const reason = response.envelope.result?.reason ?? "";
      // An operator typo surfaces as a typo, not as "not configured".
      expect(reason).toContain("FLEET_REVIEW_API_SCHEMA");
      expect(reason).toContain("must be one of");
      expect(reason).not.toBe("review transport unavailable");
      // ...and nothing else rides along: no seat id, no host, no path.
      expect(reason).not.toContain("reviewer-api");
      expect(reason).not.toContain("this-machine");
      expect(reason).not.toContain(repoDir);
    });
  });

  it("never echoes the rejected endpoint value of a configuration problem", async () => {
    const { dir: repoDir, base, head } = await makeGitRepo();
    const stateDir = await makeTempDir();
    await seedAttempt(stateDir, repoDir, base, head);
    await seedAssessment(stateDir, head);
    await withApiReviewEnv(
      { baseUrl: "http://operator:sk-secret@10.0.0.1/v1", schema: "json-object" },
      async () => {
        const { spy } = makeSpy();
        configureFleetApiRuntime({
          stateDir,
          installation: INSTALLATION_API_REVIEWER,
          reviewSpawn: spy,
        });

        const response = await callReviews(
          reviewRequest({ candidateHeadSha: head, reviewerModel: API_REVIEWER_MODEL }),
        );

        const reason = response.envelope.result?.reason ?? "";
        expect(reason).toContain("must not embed credentials");
        expect(reason).not.toContain("sk-secret");
        expect(reason).not.toContain("10.0.0.1");
        expect(reason).not.toContain("operator");
      },
    );
  });

  it("collapses a review timeout to the fixed reason", async () => {
    const { dir: repoDir, base, head } = await makeGitRepo();
    const stateDir = await makeTempDir();
    await seedAttempt(stateDir, repoDir, base, head);
    await seedAssessment(stateDir, head);
    let call = 0;
    const spy: OcmReviewTransportSpawn = async () => {
      call += 1;
      if (call === 1) {
        // The idle --wait probe answers; the review itself then times out.
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      return {
        exitCode: null,
        stdout: "",
        stderr: `timed out reviewing ${repoDir} on this-machine`,
        timedOut: true,
      };
    };
    configureFleetApiRuntime({ stateDir, installation: INSTALLATION, reviewSpawn: spy });

    const response = await callReviews(reviewRequest({ candidateHeadSha: head }));

    expect(response.envelope.result?.outcome).toBe("rejected");
    expect(response.envelope.result?.reason).toBe("review transport unavailable");
  });

  it("collapses a busy seat refusal to the fixed reason", async () => {
    const { dir: repoDir, base, head } = await makeGitRepo();
    const stateDir = await makeTempDir();
    await seedAttempt(stateDir, repoDir, base, head);
    await seedAssessment(stateDir, head);
    // Exit 75 from the --wait probe is the busy-worktree refusal.
    const spy: OcmReviewTransportSpawn = async () => ({ exitCode: 75, stdout: "", stderr: "" });
    configureFleetApiRuntime({ stateDir, installation: INSTALLATION, reviewSpawn: spy });

    const response = await callReviews(reviewRequest({ candidateHeadSha: head }));

    expect(response.envelope.result?.outcome).toBe("rejected");
    expect(response.envelope.result?.reason).toBe("review transport unavailable");
    expect(response.envelope.result?.reason).not.toContain("busy");
  });
});
