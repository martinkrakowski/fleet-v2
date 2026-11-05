/**
 * Lane MX7 (plan §3.7 row MX7): the `POST /v1/briefs/preview` route over the
 * BP1 `previewBriefPackage` use case. A rejected outcome is a result, not an
 * HTTP error. The marker strings below must never appear anywhere in the
 * response: the preview shows no argv element, owned path, allowed path
 * prefix, expected-artifact path or worktree path, and writes nothing.
 */
import * as h3 from "h3";
import { createApp, createRouter, eventHandler, toNodeListener } from "h3";
import type { Server } from "node:http";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  PrepareBriefPackageUseCase,
} from "@fleet/work-execution/use-cases";
import type {
  AttemptArtifactPort,
  BriefAuthoringPort,
  BriefKnowledgePort,
  VerifyIgnoredPathsRequest,
  VerifyIgnoredPathsResult,
} from "@fleet/work-execution";
import { sha256HexDigest } from "@fleet/work-execution";

import {
  configureWorkComposition,
  createConfiguredWorkComposition,
} from "../server/wiring/work/composition.js";

// Nitro auto-imports h3 utilities into the global scope at build time;
// vitest does not, so stub them globally before loading route modules.
for (const [key, value] of Object.entries(h3)) {
  if (typeof value === "function") {
    vi.stubGlobal(key, value);
  }
}
Object.assign(globalThis, {
  defineEventHandler: h3.defineEventHandler,
  getRouterParam: h3.getRouterParam,
  setResponseStatus: h3.setResponseStatus,
  readBody: h3.readBody,
  createError: h3.createError,
});

/** Markers that must never leave the preview: argv, owned path, prefix, artifact path, worktree path, note text. */
const MARKERS = [
  "MARK-ARGV-1",
  "MARK-ARGV-2",
  "MARK-OWNED-1",
  "MARK-PREFIX-1",
  "MARK-ARTIFACT-1",
  "MARK-WORKTREE-1",
  "MARK-NOTE-1",
] as const;

function expectNoMarkers(text: string): void {
  for (const marker of MARKERS) {
    expect(text, `marker ${marker} leaked into the preview response`).not.toContain(marker);
  }
}

const EXAMPLE_HEAD = "1".repeat(40);

interface PreviewHarness {
  ignoredOutcome: VerifyIgnoredPathsResult;
  placeFrozenBriefCalls: number;
  recordContextSelectionCalls: number;
}

function makeFakes(harness: PreviewHarness): {
  briefAuthoring: BriefAuthoringPort;
  artifactPort: AttemptArtifactPort;
  briefKnowledge: BriefKnowledgePort;
} {
  const briefAuthoring: BriefAuthoringPort = {
    // The request always carries proseMarkdown, so authoring is skipped.
    authorBrief: vi.fn(async () => {
      throw new Error("authorBrief must not be called when proseMarkdown is supplied");
    }),
  };
  const artifactPort: AttemptArtifactPort = {
    async verifyIgnoredPaths(_request: VerifyIgnoredPathsRequest) {
      return harness.ignoredOutcome;
    },
    async placeFrozenBrief() {
      harness.placeFrozenBriefCalls += 1;
      throw new Error("preview must not place a frozen brief");
    },
    async collectCompletedAttemptArtifacts() {
      throw new Error("preview must not collect artifacts");
    },
  };
  const briefKnowledge: BriefKnowledgePort = {
    async requestBriefContextProposals() {
      return { outcome: "proposed", proposals: [] };
    },
    async recordContextSelection() {
      harness.recordContextSelectionCalls += 1;
      throw new Error("preview must not record a context selection");
    },
    async forwardCompletedAttemptNotes() {
      throw new Error("preview must not forward notes");
    },
  };
  return { briefAuthoring, artifactPort, briefKnowledge };
}

function markerRequest(): Record<string, unknown> {
  return {
    workOrderId: "wo-preview-1",
    projectId: "project-preview-1",
    taskId: "task-preview-1",
    laneId: "lane-preview-1",
    repository: "example-repository",
    baseCommit: EXAMPLE_HEAD,
    policyRevision: "policy-preview-1",
    modelAssignment: {
      model: "example-provider/glm-5.3",
      variant: "default",
      fallbackModel: "example-provider/grok-4.7",
      seatTool: "opencode",
    },
    proseMarkdown: "Frozen brief prose mentioning MARK-NOTE-1.",
    prNotes: {
      hardToUndo: "hard to undo: MARK-NOTE-1",
      assumptions: "assumption with MARK-NOTE-1",
      challengeThis: "challenge this: MARK-NOTE-1",
    },
    seatPlan: {
      version: 1,
      "first-pass": [
        { id: "fp-a", model: "example-provider/glm-5.3", tool: "opencode" },
      ],
      fix: [{ id: "fp-b", model: "example-provider/glm-5.3", tool: "opencode" }],
      review: [{ id: "rv-a", model: "example-provider/grok-4.7" }],
    },
    independentReviewer: "example-provider/grok-4.7",
    ownedPaths: ["packages/example/**", "MARK-OWNED-1"],
    allowedPathPrefixes: ["packages/example", "MARK-PREFIX-1"],
    permissions: ["filesystem:worktree"],
    acceptanceChecks: ["example-check", "example-check-2"],
    acceptanceSpec: {
      commitRequired: true,
      diffCheck: true,
      commands: [
        { argv: ["corepack", "yarn", "build-MARK-ARGV-1"] },
        { argv: ["corepack", "yarn", "test-MARK-ARGV-2"] },
      ],
    },
    stepLimit: 40,
    timeLimitSeconds: 3600,
    resourceBounds: { cpu: "2" },
    expectedArtifacts: ["docs/MARK-ARTIFACT-1.md"],
    ownerDecisionReferences: ["decision-preview-1"],
    contextDecisions: [
      {
        proposalId: "proposal-preview-1",
        knowledgeEntryId: "knowledge-preview-1",
        version: "1",
        proposedBecause: "retrieval matched",
        accepted: true,
        decisionBecause: "owner accepted",
      },
    ],
    worktreePath: "/tmp/MARK-WORKTREE-1",
  };
}

interface PreviewResponse {
  status: number;
  body: Record<string, unknown>;
  text: string;
}

async function postBriefPreview(
  baseUrl: string,
  body: unknown,
): Promise<PreviewResponse> {
  const response = await fetch(`${baseUrl}/v1/briefs/preview`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: JSON.parse(text), text };
}

describe("POST /v1/briefs/preview", () => {
  let server: Server;
  let baseUrl: string;
  let harness: PreviewHarness;

  const configureWithFakes = (): void => {
    const fakes = makeFakes(harness);
    configureWorkComposition({
      ...createConfiguredWorkComposition({}),
      prepareBriefPackage: new PrepareBriefPackageUseCase({
        briefAuthoring: fakes.briefAuthoring,
        artifactPort: fakes.artifactPort,
        briefKnowledge: fakes.briefKnowledge,
        computeDigest: sha256HexDigest,
      }),
    });
  };

  beforeAll(async () => {
    const handler = (await import("../server/routes/v1/briefs/preview.post.js"))
      .default;
    const app = createApp();
    const router = createRouter();
    router.post("/v1/briefs/preview", eventHandler(handler));
    app.use(router.handler);
    server = createServer(toNodeListener(app));
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    harness = {
      ignoredOutcome: { outcome: "ignored", checkedPaths: [] },
      placeFrozenBriefCalls: 0,
      recordContextSelectionCalls: 0,
    };
    configureWorkComposition(null);
  });

  it("a. refuses with 501 NOT_IMPLEMENTED when the composition is unconfigured", async () => {
    const response = await postBriefPreview(baseUrl, markerRequest());
    expect(response.status).toBe(501);
    expect(response.body).toMatchObject({ code: "NOT_IMPLEMENTED" });
  });

  it("b. previews a valid request: OK, previewed, digest and counts, no marker anywhere", async () => {
    configureWithFakes();
    const response = await postBriefPreview(baseUrl, markerRequest());
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ code: "OK" });
    const result = response.body.result as {
      outcome: string;
      preview?: Record<string, unknown>;
    };
    expect(result.outcome).toBe("previewed");
    const preview = result.preview as Record<string, unknown>;
    expect(preview.briefDigest).toMatch(/^[0-9a-f]{64}$/);
    const acceptance = preview.acceptance as Record<string, unknown>;
    expect(acceptance.commandCount).toBe(2);
    expect(acceptance.commandDigests).toHaveLength(2);
    expectNoMarkers(response.text);
  });

  it("c. rejection when a path is not ignored keeps no marker", async () => {
    configureWithFakes();
    harness.ignoredOutcome = {
      outcome: "not-ignored",
      offendingPaths: ["docs/unexpected.txt"],
    };
    const response = await postBriefPreview(baseUrl, markerRequest());
    expect(response.status).toBe(200);
    const result = response.body.result as { outcome: string; reason: string };
    expect(result.outcome).toBe("rejected");
    expect(typeof result.reason).toBe("string");
    expect(result.reason.length).toBeGreaterThan(0);
    expectNoMarkers(response.text);
  });

  it("c. rejection when the first argv is a shell names reasonClass acceptance-spec-shell and keeps no marker", async () => {
    configureWithFakes();
    const request = markerRequest() as {
      acceptanceSpec: { commands: Array<{ argv: string[] }> };
    };
    request.acceptanceSpec.commands = [
      { argv: ["/bin/sh", "-c", "echo MARK-ARGV-1 MARK-ARGV-2"] },
    ];
    const response = await postBriefPreview(baseUrl, request);
    expect(response.status).toBe(200);
    const result = response.body.result as {
      outcome: string;
      reason: string;
      reasonClass?: string;
    };
    expect(result.outcome).toBe("rejected");
    expect(result.reasonClass).toBe("acceptance-spec-shell");
    expectNoMarkers(response.text);
  });

  it("d. writes nothing: no frozen brief placed, no context selection recorded", async () => {
    configureWithFakes();
    const response = await postBriefPreview(baseUrl, markerRequest());
    expect(response.status).toBe(200);
    expect(harness.placeFrozenBriefCalls).toBe(0);
    expect(harness.recordContextSelectionCalls).toBe(0);
    expectNoMarkers(response.text);
  });

  it("e. an empty body gives 200 OK with a rejected outcome, never a 500", async () => {
    configureWithFakes();
    const response = await postBriefPreview(baseUrl, {});
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ code: "OK" });
    const result = response.body.result as { outcome: string };
    expect(result.outcome).toBe("rejected");
    expectNoMarkers(response.text);
  });
});
