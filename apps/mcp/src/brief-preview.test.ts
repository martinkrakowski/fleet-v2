// Tests for the fleet_brief_preview tool (MX7): kind and scope are read, the
// strict input schema refuses extra keys and missing fields, a valid input
// makes exactly one POST /v1/briefs/preview call with the parsed input, the
// result is the allow-list projection (no argv element, owned path, allowed
// prefix, artifact path or worktree path survives, and only 64-hex digests
// are kept), a rejection reason that names a supplied value is replaced by
// the fixed withheld text, and a client failure is an error with no marker.
import { describe, expect, it } from "vitest";
import type { ApiClientResult, FleetApiClient } from "./client.js";
import { buildRegistry, type FleetRegistry } from "./registry.js";

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
    expect(text, `marker ${marker} leaked into the tool result`).not.toContain(marker);
  }
}

const MARKER_INPUT = {
  workOrderId: "wo-1",
  projectId: "project-1",
  taskId: "task-1",
  laneId: "lane-1",
  repository: "example-repository",
  baseCommit: "1".repeat(40),
  policyRevision: "policy-1",
  worktreePath: "/tmp/MARK-WORKTREE-1",
  modelAssignment: {
    model: "example-provider/glm-5.3",
    variant: "default",
    fallbackModel: "example-provider/grok-4.7",
    seatTool: "opencode",
  },
  proseMarkdown: "prose mentioning MARK-NOTE-1",
  prNotes: {
    hardToUndo: "hard to undo MARK-NOTE-1",
    assumptions: "assumption MARK-NOTE-1",
    challengeThis: "challenge MARK-NOTE-1",
  },
  independentReviewer: "example-provider/grok-4.7",
  ownedPaths: ["packages/example/**", "MARK-OWNED-1"],
  allowedPathPrefixes: ["packages/example", "MARK-PREFIX-1"],
  permissions: ["filesystem:worktree"],
  acceptanceChecks: ["check-1", "check-2"],
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
  ownerDecisionReferences: ["decision-1"],
  contextDecisions: [
    {
      proposalId: "proposal-1",
      knowledgeEntryId: "knowledge-1",
      version: "1",
      proposedBecause: "retrieval matched",
      decisionBecause: "owner accepted",
      accepted: true,
    },
  ],
};

interface RecordedCall {
  method: "GET" | "POST";
  path: string;
  body: unknown;
}

function fakeClient(result: ApiClientResult): FleetApiClient & { calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  return {
    calls,
    get: async (path: string) => {
      calls.push({ method: "GET", path, body: undefined });
      return result;
    },
    post: async (path: string, body: unknown) => {
      calls.push({ method: "POST", path, body });
      return result;
    },
  };
}

function briefPreviewTool(registry: FleetRegistry) {
  const tool = registry.tools.find((entry) => entry.name === "fleet_brief_preview");
  if (!tool) {
    throw new Error("registry is missing fleet_brief_preview");
  }
  return tool;
}

function resultText(result: { content: Array<{ type: string; text: string }>; isError?: boolean }): string {
  return result.content.map((entry) => entry.text).join("\n");
}

describe("fleet_brief_preview tool", () => {
  it("a. is a read tool with read scope and read-only annotations", () => {
    const registry = buildRegistry(fakeClient({ operationId: "op-1", code: "OK", result: {} }));
    const tool = briefPreviewTool(registry);
    expect(tool.kind).toBe("read");
    expect(tool.scope).toBe("read");
    expect(tool.annotations.readOnlyHint).toBe(true);
    expect(tool.annotations.destructiveHint).toBe(false);
  });

  it("b. refuses invalid input with invalid-input and never calls the client", async () => {
    const client = fakeClient({ operationId: "op-1", code: "OK", result: {} });
    const registry = buildRegistry(client);
    const tool = briefPreviewTool(registry);

    const extraKey = await tool.handler({ ...MARKER_INPUT, path: "/etc/passwd", url: "http://example.invalid" });
    expect(resultText(extraKey)).toContain("invalid-input");
    expect(extraKey.isError).toBe(true);

    const withoutWorktreePath = { ...MARKER_INPUT } as Record<string, unknown>;
    delete withoutWorktreePath.worktreePath;
    const missingField = await tool.handler(withoutWorktreePath);
    expect(resultText(missingField)).toContain("invalid-input");
    expect(missingField.isError).toBe(true);

    const notCommitRequired = await tool.handler({
      ...MARKER_INPUT,
      acceptanceSpec: {
        ...MARKER_INPUT.acceptanceSpec,
        commitRequired: false,
      },
    });
    expect(resultText(notCommitRequired)).toContain("invalid-input");
    expect(notCommitRequired.isError).toBe(true);

    expect(client.calls).toEqual([]);
  });

  it("c. posts exactly once to /v1/briefs/preview with the parsed input", async () => {
    const client = fakeClient({
      operationId: "op-1",
      code: "OK",
      result: { outcome: "rejected", reason: "refused", reasonClass: null },
    });
    const registry = buildRegistry(client);
    const tool = briefPreviewTool(registry);
    await tool.handler(MARKER_INPUT);
    expect(client.calls).toEqual([
      { method: "POST", path: "/v1/briefs/preview", body: MARKER_INPUT },
    ]);
  });

  it("d. drops every leaky field and keeps only the allow-list projection", async () => {
    const client = fakeClient({
      operationId: "op-2",
      code: "OK",
      result: {
        outcome: "previewed",
        preview: {
          attemptId: "att-1",
          briefDigest: "a".repeat(64),
          modelAssignment: {
            model: "example-provider/glm-5.3",
            variant: "default",
            seatTool: "opencode",
          },
          seatPlan: {
            version: 1,
            "first-pass": [
              { id: "fp-a", model: "m-1", tool: "opencode", on: ["host-a"] },
            ],
            fix: [],
            review: [],
          },
          acceptance: {
            commitRequired: true,
            diffCheck: true,
            commandCount: 2,
            commandDigests: ["b".repeat(64), "MARK-ARGV-1"],
          },
          prNotesPresent: true,
          selectedKnowledgeVersions: [{ knowledgeEntryId: "ke-1", version: "1" }],
          ownedPaths: ["MARK-OWNED-1"],
          allowedPathPrefixes: ["MARK-PREFIX-1"],
          expectedArtifacts: ["MARK-ARTIFACT-1"],
          worktreePath: "/tmp/MARK-WORKTREE-1",
          acceptanceSpecCommands: [{ argv: ["yarn", "build-MARK-ARGV-1"] }],
          manifestJson: "{}",
          prosePath: ".lane/brief.md",
        },
      },
    });
    const registry = buildRegistry(client);
    const tool = briefPreviewTool(registry);
    const result = await tool.handler(MARKER_INPUT);
    const text = resultText(result);
    expectNoMarkers(text);
    expect(result.isError).toBeUndefined();
    const payload = JSON.parse(text) as {
      result: { outcome: string; preview: Record<string, unknown> };
    };
    expect(payload.result.outcome).toBe("previewed");
    expect(payload.result.preview.attemptId).toBe("att-1");
    expect(payload.result.preview.briefDigest).toBe("a".repeat(64));
    const acceptance = payload.result.preview.acceptance as Record<string, unknown>;
    expect(acceptance.commandCount).toBe(2);
    expect(acceptance.commandDigests).toEqual(["b".repeat(64)]);
  });

  it("e. replaces a rejection reason that names a supplied argv value with the withheld text", async () => {
    const client = fakeClient({
      operationId: "op-3",
      code: "OK",
      result: {
        outcome: "rejected",
        reason: "refused because argv included build-MARK-ARGV-1",
        reasonClass: "acceptance-spec-shell",
      },
    });
    const registry = buildRegistry(client);
    const tool = briefPreviewTool(registry);
    const result = await tool.handler(MARKER_INPUT);
    const text = resultText(result);
    expectNoMarkers(text);
    expect(text).toContain(
      "the brief request was refused; the reason named a supplied value and was withheld",
    );
  });

  it("f. a client failure is an error and never echoes an input marker", async () => {
    const client = fakeClient({
      ok: false,
      code: "NOT_IMPLEMENTED",
      message: "Not implemented: PrepareBriefPackageUseCase.",
      operationId: "op-4",
    });
    const registry = buildRegistry(client);
    const tool = briefPreviewTool(registry);
    const result = await tool.handler(MARKER_INPUT);
    expect(result.isError).toBe(true);
    expectNoMarkers(resultText(result));
  });
});
