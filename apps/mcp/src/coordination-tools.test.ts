// Tests for the coordination read tools (MX2-2): the evidence, owner-question
// and project tools. Every tool calls exactly its /v1 route through the fake
// client, invalid input is refused before any call, and the results are
// projections: marker fields are dropped, kept fields are present and correct.
import { describe, expect, it } from "vitest";
import type { ApiClientResult, FleetApiClient } from "./client.js";
import { buildRegistry, type FleetRegistry } from "./registry.js";

const HEAD = "0".repeat(40);
const ISO_EXAMPLE = "2026-10-28T00:00:00.000Z";

interface RecordedCall {
  method: "GET" | "POST";
  path: string;
}

function fakeClient(
  responses: Record<string, ApiClientResult>,
): FleetApiClient & { calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const respond = (path: string): ApiClientResult =>
    responses[path] ?? {
      ok: false,
      code: "unmocked-route",
      message: `no canned response for ${path}`,
    };
  return {
    calls,
    get: async (path: string) => {
      calls.push({ method: "GET", path });
      return respond(path);
    },
    post: async (path: string, _body: unknown) => {
      calls.push({ method: "POST", path });
      return respond(path);
    },
  };
}

function toolNamed(registry: FleetRegistry, name: string) {
  const tool = registry.tools.find((entry) => entry.name === name);
  if (!tool) {
    throw new Error(`registry is missing tool ${name}`);
  }
  return tool;
}

const FAILURE: ApiClientResult = {
  ok: false,
  code: "NOT_IMPLEMENTED",
  message: "Not implemented: inspectAcceptanceEvidence.",
  operationId: "op-failure",
};

const HEAD_EVIDENCE_ENVELOPE: ApiClientResult = {
  operationId: "op-head-evidence",
  code: "OK",
  result: {
    outcome: "found",
    assessment: {
      id: "assessment-example-1",
      projectId: "project-example-1",
      attemptId: "attempt-example-1",
      candidateHeadSha: HEAD,
      policyRevision: "policy-example-1",
      implementerModel: "example-provider/glm-5.3",
      requestedReviewerModel: "example-provider/glm-5.3",
      requiredChecks: ["typecheck", "test"],
      state: "accepted",
      forgeEvidence: "not-configured",
      verificationReceipts: [
        {
          id: "verification-example-1",
          hostId: "MARKER-HOST",
          procedureName: "typecheck",
          result: "passed",
          exitCode: 0,
          coverage: "MARKER-COVERAGE",
          evidenceRef: "MARKER-REF",
          completedAtIso: ISO_EXAMPLE,
        },
      ],
      reviewReceipts: [
        {
          id: "review-example-1",
          reviewerModel: "example-provider/glm-5.3",
          result: "approved",
          findings: [
            {
              findingId: "finding-example-1",
              severity: "major",
              summary: "MARKER-SUMMARY",
              filePath: "MARKER-PATH",
              line: 12,
              state: "unresolved",
            },
            {
              findingId: "finding-example-2",
              severity: "nit",
              summary: "MARKER-SUMMARY",
              filePath: "MARKER-PATH",
              line: 14,
              state: "fixed",
            },
          ],
          evidenceRef: "MARKER-REF",
          kind: "review",
          requestId: "request-example-1",
          completedAtIso: ISO_EXAMPLE,
        },
      ],
      findingDispositions: [
        {
          dispositionId: "disposition-example-1",
          findingId: "finding-example-2",
          state: "fixed",
          dispositionReason: "MARKER-REASON",
          dispositionEvidenceRef: "MARKER-DISPOSITION-REF",
          recordedBy: "example-provider/glm-5.3",
          recordedAtIso: ISO_EXAMPLE,
        },
      ],
      acceptanceReceiptId: "acceptance-example-1",
      blockers: ["MARKER-BLOCKER"],
      revision: 1,
      updatedAtIso: ISO_EXAMPLE,
    },
  },
};

const QUESTION_ENVELOPE: ApiClientResult = {
  operationId: "op-question",
  code: "OK",
  result: {
    outcome: "found",
    question: {
      questionId: "question-example-1",
      revision: 2,
      askedBy: "example-provider/glm-5.3",
      title: "Which base branch?",
      body: "Work may start from either branch.",
      options: [
        {
          id: "option-a",
          label: "Option A",
          consequence: "Option A is chosen.",
        },
        {
          id: "option-b",
          label: "Option B",
          consequence: "Option B is chosen.",
        },
      ],
      recommendation: {
        optionId: "option-a",
        because: "Because option A is the safer path.",
      },
      doorKind: "two-way",
      linkedRequestId: "request-example-1",
      blocks: [{ kind: "plan", ref: "plan-example-1" }],
      state: "answered",
      askedAt: ISO_EXAMPLE,
      expiresAt: ISO_EXAMPLE,
      answer: {
        shape: "accept",
        optionId: "option-a",
        text: "MARKER-ANSWER",
        reason: "MARKER-ANSWER-REASON",
        questionRevision: 2,
        answeredVia: "web",
        answeredAt: ISO_EXAMPLE,
        sessionId: "MARKER-SESSION",
      },
      acknowledgement: { by: "owner-example-1", at: ISO_EXAMPLE },
      idempotencyKey: "MARKER-IDEMPOTENCY",
    },
  },
};

const QUESTION_LIST_ENVELOPE: ApiClientResult = {
  operationId: "op-question-list",
  code: "OK",
  result: {
    questions: [
      (QUESTION_ENVELOPE.result as { question: unknown }).question,
    ],
  },
};

const PROJECT_LIST_ENVELOPE: ApiClientResult = {
  operationId: "op-project-list",
  code: "OK",
  result: {
    outcome: "listed",
    profiles: [
      {
        projectId: "project-example-1",
        displayName: "Example Project",
        repository: "MARKER-REPO",
        designatedDispatcherHost: "MARKER-DISPATCH",
        policyRevision: "policy-example-1",
        maxConcurrentLanes: 3,
        runnerCapabilities: { MARKER_CAPABILITY: true },
        revision: 1,
        updatedAtIso: ISO_EXAMPLE,
        status: "active",
        defaultBranch: "main",
        clones: { "clone-example-1": { path: "MARKER-CLONE" } },
        gateProcedures: ["MARKER-GATE"],
        defaultAllowedPathPrefixes: ["MARKER-PREFIX"],
        lastProbe: { probedFrom: "MARKER-PROBE", checks: [] },
      },
    ],
  },
};

const HEAD_EVIDENCE_PROJECTED = {
  operationId: "op-head-evidence",
  code: "OK",
  result: {
    outcome: "found",
    assessment: {
      id: "assessment-example-1",
      projectId: "project-example-1",
      attemptId: "attempt-example-1",
      candidateHeadSha: HEAD,
      state: "accepted",
      policyRevision: "policy-example-1",
      acceptanceReceiptId: "acceptance-example-1",
      revision: 1,
      updatedAtIso: ISO_EXAMPLE,
      requiredCheckCount: 2,
      blockerCount: 1,
      verification: [
        {
          id: "verification-example-1",
          procedureName: "typecheck",
          result: "passed",
          exitCode: 0,
          completedAtIso: ISO_EXAMPLE,
        },
      ],
      reviews: [
        {
          id: "review-example-1",
          reviewerModel: "example-provider/glm-5.3",
          kind: "review",
          requestId: "request-example-1",
          result: "approved",
          completedAtIso: ISO_EXAMPLE,
          findings: {
            total: 2,
            bySeverity: { blocker: 0, major: 1, minor: 0, nit: 1 },
            unresolved: 1,
          },
        },
      ],
    },
  },
};

const QUESTION_PROJECTED = {
  questionId: "question-example-1",
  revision: 2,
  state: "answered",
  doorKind: "two-way",
  askedBy: "example-provider/glm-5.3",
  askedAt: ISO_EXAMPLE,
  expiresAt: ISO_EXAMPLE,
  linkedRequestId: "request-example-1",
  blocks: [{ kind: "plan", ref: "plan-example-1" }],
  recommendation: { optionId: "option-a" },
  answer: {
    shape: "accept",
    optionId: "option-a",
    answeredVia: "web",
    answeredAt: ISO_EXAMPLE,
  },
  asked: {
    source: "owner-question",
    askedBy: "example-provider/glm-5.3",
    title: "Which base branch?",
    body: "Work may start from either branch.",
    options: [
      { id: "option-a", label: "Option A", consequence: "Option A is chosen." },
      { id: "option-b", label: "Option B", consequence: "Option B is chosen." },
    ],
    recommendationBecause: "Because option A is the safer path.",
  },
};

const QUESTION_PROJECTED_ENVELOPE = {
  operationId: "op-question",
  code: "OK",
  result: { outcome: "found", question: QUESTION_PROJECTED },
};

const QUESTION_LIST_PROJECTED_ENVELOPE = {
  operationId: "op-question-list",
  code: "OK",
  result: { questions: [QUESTION_PROJECTED] },
};

const PROJECT_LIST_PROJECTED_ENVELOPE = {
  operationId: "op-project-list",
  code: "OK",
  result: {
    outcome: "listed",
    profiles: [
      {
        projectId: "project-example-1",
        displayName: "Example Project",
        status: "active",
        defaultBranch: "main",
        policyRevision: "policy-example-1",
        maxConcurrentLanes: 3,
        revision: 1,
        updatedAtIso: ISO_EXAMPLE,
      },
    ],
  },
};

describe("fleet_head_evidence tool", () => {
  it("calls exactly GET /v1/heads/<headSha>/evidence and returns the projected assessment", async () => {
    const client = fakeClient({
      [`/v1/heads/${HEAD}/evidence`]: HEAD_EVIDENCE_ENVELOPE,
    });
    const registry = buildRegistry(client);
    const result = await toolNamed(registry, "fleet_head_evidence").handler({
      headSha: HEAD,
    });
    expect(client.calls).toEqual([
      { method: "GET", path: `/v1/heads/${HEAD}/evidence` },
    ]);
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0]?.text ?? "")).toEqual(
      HEAD_EVIDENCE_PROJECTED,
    );
  });

  it("drops every marker field: hostId, evidenceRef, finding text, dispositions and blocker text", async () => {
    const client = fakeClient({
      [`/v1/heads/${HEAD}/evidence`]: HEAD_EVIDENCE_ENVELOPE,
    });
    const registry = buildRegistry(client);
    const result = await toolNamed(registry, "fleet_head_evidence").handler({
      headSha: HEAD,
    });
    expect(result.content[0]?.text ?? "").not.toContain("MARKER");
    expect(result.content[0]?.text ?? "").not.toContain("implementerModel");
    expect(result.content[0]?.text ?? "").not.toContain("forgeEvidence");
    expect(result.content[0]?.text ?? "").not.toContain("findingDispositions");
    expect(result.content[0]?.text ?? "").not.toContain("blockers");
  });

  it.each([
    ["39 characters", { headSha: "0".repeat(39) }],
    ["uppercase head", { headSha: "0".repeat(39) + "A" }],
    ["extra key", { headSha: HEAD, path: "/v1/relays" }],
  ])("refuses %s without calling the client", async (_label, input) => {
    const client = fakeClient({
      [`/v1/heads/${HEAD}/evidence`]: HEAD_EVIDENCE_ENVELOPE,
    });
    const registry = buildRegistry(client);
    const result = await toolNamed(registry, "fleet_head_evidence").handler(
      input,
    );
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]?.text ?? "")).toEqual({
      code: "invalid-input",
      message: "Input does not match the tool schema.",
    });
    expect(client.calls).toEqual([]);
  });

  it("maps a client failure to isError", async () => {
    const client = fakeClient({
      [`/v1/heads/${HEAD}/evidence`]: FAILURE,
    });
    const registry = buildRegistry(client);
    const result = await toolNamed(registry, "fleet_head_evidence").handler({
      headSha: HEAD,
    });
    expect(client.calls).toEqual([
      { method: "GET", path: `/v1/heads/${HEAD}/evidence` },
    ]);
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]?.text ?? "")).toEqual({
      code: "NOT_IMPLEMENTED",
      message: "Not implemented: inspectAcceptanceEvidence.",
      operationId: "op-failure",
    });
  });

  it("projects a not-found outcome without the query text", async () => {
    const client = fakeClient({
      [`/v1/heads/${HEAD}/evidence`]: {
        operationId: "op-head-evidence",
        code: "OK",
        result: { outcome: "not-found", query: HEAD },
      },
    });
    const registry = buildRegistry(client);
    const result = await toolNamed(registry, "fleet_head_evidence").handler({
      headSha: HEAD,
    });
    expect(JSON.parse(result.content[0]?.text ?? "")).toEqual({
      operationId: "op-head-evidence",
      code: "OK",
      result: { outcome: "not-found", assessment: null },
    });
  });
});

describe("fleet_question_list tool", () => {
  it("calls exactly GET /v1/questions with no filters when the input is empty", async () => {
    const client = fakeClient({ "/v1/questions": QUESTION_LIST_ENVELOPE });
    const registry = buildRegistry(client);
    const result = await toolNamed(registry, "fleet_question_list").handler({});
    expect(client.calls).toEqual([{ method: "GET", path: "/v1/questions" }]);
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0]?.text ?? "")).toEqual(
      QUESTION_LIST_PROJECTED_ENVELOPE,
    );
  });

  it("builds the query only from the given fields", async () => {
    const client = fakeClient({
      [`/v1/questions?state=open&since=${encodeURIComponent(ISO_EXAMPLE)}`]:
        QUESTION_LIST_ENVELOPE,
    });
    const registry = buildRegistry(client);
    const result = await toolNamed(registry, "fleet_question_list").handler({
      state: "open",
      since: ISO_EXAMPLE,
    });
    expect(client.calls).toEqual([
      {
        method: "GET",
        path: `/v1/questions?state=open&since=${encodeURIComponent(ISO_EXAMPLE)}`,
      },
    ]);
    expect(result.isError).toBeUndefined();
  });

  it("builds the query from since alone", async () => {
    const client = fakeClient({
      [`/v1/questions?since=${encodeURIComponent(ISO_EXAMPLE)}`]:
        QUESTION_LIST_ENVELOPE,
    });
    const registry = buildRegistry(client);
    const result = await toolNamed(registry, "fleet_question_list").handler({
      since: ISO_EXAMPLE,
    });
    expect(client.calls).toEqual([
      {
        method: "GET",
        path: `/v1/questions?since=${encodeURIComponent(ISO_EXAMPLE)}`,
      },
    ]);
    expect(result.isError).toBeUndefined();
  });

  it("projects the questions and drops the answer's text, reason and sessionId", async () => {
    const client = fakeClient({ "/v1/questions": QUESTION_LIST_ENVELOPE });
    const registry = buildRegistry(client);
    const result = await toolNamed(registry, "fleet_question_list").handler({});
    const text = result.content[0]?.text ?? "";
    expect(text).not.toContain("MARKER");
    expect(text).not.toContain("acknowledgement");
    expect(text).not.toContain("idempotencyKey");
    expect(JSON.parse(text).result).toEqual(
      QUESTION_LIST_PROJECTED_ENVELOPE.result,
    );
  });

  it.each([
    ["unknown state", { state: "finished" }],
    ["non-canonical since", { since: "2026-10-28" }],
    ["extra key", { state: "open", path: "/v1/relays" }],
  ])("refuses %s without calling the client", async (_label, input) => {
    const client = fakeClient({ "/v1/questions": QUESTION_LIST_ENVELOPE });
    const registry = buildRegistry(client);
    const result = await toolNamed(registry, "fleet_question_list").handler(
      input,
    );
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]?.text ?? "")).toEqual({
      code: "invalid-input",
      message: "Input does not match the tool schema.",
    });
    expect(client.calls).toEqual([]);
  });

  it("maps a client failure to isError", async () => {
    const client = fakeClient({ "/v1/questions": FAILURE });
    const registry = buildRegistry(client);
    const result = await toolNamed(registry, "fleet_question_list").handler({});
    expect(client.calls).toEqual([{ method: "GET", path: "/v1/questions" }]);
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]?.text ?? "")).toEqual({
      code: "NOT_IMPLEMENTED",
      message: "Not implemented: inspectAcceptanceEvidence.",
      operationId: "op-failure",
    });
  });
});

describe("fleet_question tool", () => {
  it("calls exactly GET /v1/questions/<questionId> and returns the projected question", async () => {
    const client = fakeClient({
      "/v1/questions/question-example-1": QUESTION_ENVELOPE,
    });
    const registry = buildRegistry(client);
    const result = await toolNamed(registry, "fleet_question").handler({
      questionId: "question-example-1",
    });
    expect(client.calls).toEqual([
      { method: "GET", path: "/v1/questions/question-example-1" },
    ]);
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0]?.text ?? "")).toEqual(
      QUESTION_PROJECTED_ENVELOPE,
    );
  });

  it("drops the answer's text, reason and sessionId", async () => {
    const client = fakeClient({
      "/v1/questions/question-example-1": QUESTION_ENVELOPE,
    });
    const registry = buildRegistry(client);
    const result = await toolNamed(registry, "fleet_question").handler({
      questionId: "question-example-1",
    });
    const text = result.content[0]?.text ?? "";
    expect(text).not.toContain("MARKER");
    expect(text).not.toContain("acknowledgement");
    expect(text).not.toContain("idempotencyKey");
    expect(text).toContain("owner-question");
  });

  it("refuses an extra key without calling the client", async () => {
    const client = fakeClient({
      "/v1/questions/question-example-1": QUESTION_ENVELOPE,
    });
    const registry = buildRegistry(client);
    const result = await toolNamed(registry, "fleet_question").handler({
      questionId: "question-example-1",
      path: "/v1/relays",
    });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]?.text ?? "")).toEqual({
      code: "invalid-input",
      message: "Input does not match the tool schema.",
    });
    expect(client.calls).toEqual([]);
  });

  it("maps a client failure to isError", async () => {
    const client = fakeClient({
      "/v1/questions/question-example-1": FAILURE,
    });
    const registry = buildRegistry(client);
    const result = await toolNamed(registry, "fleet_question").handler({
      questionId: "question-example-1",
    });
    expect(client.calls).toEqual([
      { method: "GET", path: "/v1/questions/question-example-1" },
    ]);
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]?.text ?? "")).toEqual({
      code: "NOT_IMPLEMENTED",
      message: "Not implemented: inspectAcceptanceEvidence.",
      operationId: "op-failure",
    });
  });
});

describe("fleet_project_list tool", () => {
  it("calls exactly GET /v1/projects with no filters when the input is empty", async () => {
    const client = fakeClient({ "/v1/projects": PROJECT_LIST_ENVELOPE });
    const registry = buildRegistry(client);
    const result = await toolNamed(registry, "fleet_project_list").handler({});
    expect(client.calls).toEqual([{ method: "GET", path: "/v1/projects" }]);
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0]?.text ?? "")).toEqual(
      PROJECT_LIST_PROJECTED_ENVELOPE,
    );
  });

  it("builds the query only from the given status", async () => {
    const client = fakeClient({
      "/v1/projects?status=active": PROJECT_LIST_ENVELOPE,
    });
    const registry = buildRegistry(client);
    const result = await toolNamed(registry, "fleet_project_list").handler({
      status: "active",
    });
    expect(client.calls).toEqual([
      { method: "GET", path: "/v1/projects?status=active" },
    ]);
    expect(result.isError).toBeUndefined();
  });

  it("drops repository, dispatcher host, clones, gates, prefixes, capabilities and lastProbe", async () => {
    const client = fakeClient({ "/v1/projects": PROJECT_LIST_ENVELOPE });
    const registry = buildRegistry(client);
    const result = await toolNamed(registry, "fleet_project_list").handler({});
    const text = result.content[0]?.text ?? "";
    expect(text).not.toContain("MARKER");
    expect(text).not.toContain("repository");
    expect(text).not.toContain("designatedDispatcherHost");
    expect(text).not.toContain("clones");
    expect(text).not.toContain("gateProcedures");
    expect(text).not.toContain("defaultAllowedPathPrefixes");
    expect(text).not.toContain("runnerCapabilities");
    expect(text).not.toContain("lastProbe");
    expect(JSON.parse(text).result).toEqual(
      PROJECT_LIST_PROJECTED_ENVELOPE.result,
    );
  });

  it("refuses an unknown status and an extra key without calling the client", async () => {
    const client = fakeClient({ "/v1/projects": PROJECT_LIST_ENVELOPE });
    const registry = buildRegistry(client);
    for (const input of [{ status: "archived" }, { status: "active", path: "/v1/relays" }]) {
      const result = await toolNamed(registry, "fleet_project_list").handler(
        input,
      );
      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content[0]?.text ?? "")).toEqual({
        code: "invalid-input",
        message: "Input does not match the tool schema.",
      });
    }
    expect(client.calls).toEqual([]);
  });

  it("maps a client failure to isError", async () => {
    const client = fakeClient({ "/v1/projects": FAILURE });
    const registry = buildRegistry(client);
    const result = await toolNamed(registry, "fleet_project_list").handler({});
    expect(client.calls).toEqual([{ method: "GET", path: "/v1/projects" }]);
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]?.text ?? "")).toEqual({
      code: "NOT_IMPLEMENTED",
      message: "Not implemented: inspectAcceptanceEvidence.",
      operationId: "op-failure",
    });
  });
});
