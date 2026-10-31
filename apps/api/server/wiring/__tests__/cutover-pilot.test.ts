// Cutover pilot: proves the API's Nitro startup plugin (`FLEET_STATE_DIR`), the
// 501-vs-validation split across all four bounded contexts, exact `/v1/*` route
// payload forwarding, the cross-process persistence of acceptance receipts and
// authorization coordinates across a runtime restart, and the web client's
// `FLEET_API_URL` binding — all against the real H3 route handlers served on a
// loopback HTTP server. No runner, forge or verification subprocess is invoked:
// the wiring adapters answer the seeded stations honestly.
import "./nitro-globals.js";

import { readdirSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createApp, createRouter, toNodeListener, type EventHandler } from "h3";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { createFleetWebApiClient } from "../../../../web/src/lib/api-client.js";
import { createConfiguredEvidenceUseCases } from "../evidence/composition";
import {
  createConfiguredOperatorComposition,
  getOperatorComposition,
} from "../operator/composition";
import {
  configureFleetApiRuntime,
  persistAcceptedReceiptsToState,
  persistAuthorizationCoordinatesToState,
  readAcceptedReceiptsFromState,
  readAuthorizationCoordinatesFromState,
} from "../runtime";
import { createConfiguredWorkComposition, workComposition } from "../work/composition";
import { bootstrapFleetApiFromEnv } from "../../plugins/runtime";

import attentionGet from "../../routes/v1/attention.get";
import capabilitiesGet from "../../routes/v1/capabilities.get";
import coordinationGet from "../../routes/v1/coordination.get";
import forgeIndexPost from "../../routes/v1/forge/index.post";
import decisionsIndexPost from "../../routes/v1/decisions/index.post";
import projectsIndexGet from "../../routes/v1/projects/index.get";
import projectsIndexPost from "../../routes/v1/projects/index.post";
import projectsUnregisteredGet from "../../routes/v1/projects/unregistered.get";
import projectIdGet from "../../routes/v1/projects/[id].get";
import projectIdPatch from "../../routes/v1/projects/[id].patch";
import projectProbePost from "../../routes/v1/projects/[id]/probe.post";
import projectRetirePost from "../../routes/v1/projects/[id]/retire.post";
import observationsIndexPost from "../../routes/v1/observations/index.post";
import relaysIndexPost from "../../routes/v1/relays/index.post";
import verificationsIndexPost from "../../routes/v1/verifications/index.post";
import reviewsIndexPost from "../../routes/v1/reviews/index.post";
import knowledgeChecksPost from "../../routes/v1/knowledge/checks.post";
import knowledgeProposalsPost from "../../routes/v1/knowledge/proposals.post";
import knowledgeSelectionsPost from "../../routes/v1/knowledge/selections.post";
import attemptIdGet from "../../routes/v1/attempts/[id].get";
import attemptArtifactsPost from "../../routes/v1/attempts/[id]/artifacts.post";
import attemptFixPost from "../../routes/v1/attempts/[id]/fix.post";
import attemptStopPost from "../../routes/v1/attempts/[id]/stop.post";
import attemptAcceptancePost from "../../routes/v1/attempts/[id]/acceptance.post";
import attemptNotesPost from "../../routes/v1/attempts/[id]/notes.post";
import workOrderIdGet from "../../routes/v1/work-orders/[id].get";
import workOrdersIndexPost from "../../routes/v1/work-orders/index.post";
import verificationReceiptPost from "../../routes/v1/verifications/[id]/receipt.post";
import reviewReceiptPost from "../../routes/v1/reviews/[id]/receipt.post";
import findingDispositionPost from "../../routes/v1/findings/[id]/disposition.post";
import headAssessmentPost from "../../routes/v1/heads/[sha]/assessment.post";
import headEvidenceGet from "../../routes/v1/heads/[sha]/evidence.get";
import knowledgeDispositionPost from "../../routes/v1/knowledge/[id]/disposition.post";
import knowledgePublishPost from "../../routes/v1/knowledge/[id]/publish.post";
import knowledgeReusePost from "../../routes/v1/knowledge/[id]/reuse.post";
import knowledgeSupersedePost from "../../routes/v1/knowledge/[id]/supersede.post";
import authorizationsResolvePost from "../../routes/v1/authorizations/resolve.post";
import authorizationsConsumePost from "../../routes/v1/authorizations/[id]/consume.post";
import relaysAcknowledgementPost from "../../routes/v1/relays/[id]/acknowledgement.post";

const createdDirs = new Set<string>();

async function makeTempDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "fleet-cutover-pilot-"));
  createdDirs.add(directory);
  return directory;
}

/** The API's uniform envelope: `{ operationId, code, result }`. */
interface ViewEnvelope {
  readonly operationId: string;
  readonly code: string;
  readonly result: unknown;
}

const ENVELOPE_FALLBACK: ViewEnvelope = { operationId: "", code: "", result: null };

async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

// ---------------------------------------------------------------------------
// Loopback HTTP server mounting the real /v1 route handlers.
// ---------------------------------------------------------------------------

let apiBaseUrl = "";
let apiServer: Server;

beforeAll(async () => {
  const router = createRouter();
  const registrations: ReadonlyArray<readonly [string, "get" | "post" | "patch", EventHandler]> = [
    ["/v1/attention", "get", attentionGet],
    ["/v1/capabilities", "get", capabilitiesGet],
    ["/v1/coordination", "get", coordinationGet],
    ["/v1/work-orders/:id", "get", workOrderIdGet],
    ["/v1/attempts/:id", "get", attemptIdGet],
    ["/v1/heads/:sha/evidence", "get", headEvidenceGet],
    ["/v1/work-orders", "post", workOrdersIndexPost],
    ["/v1/verifications", "post", verificationsIndexPost],
    ["/v1/verifications/:id/receipt", "post", verificationReceiptPost],
    ["/v1/reviews", "post", reviewsIndexPost],
    ["/v1/reviews/:id/receipt", "post", reviewReceiptPost],
    ["/v1/findings/:id/disposition", "post", findingDispositionPost],
    ["/v1/heads/:sha/assessment", "post", headAssessmentPost],
    ["/v1/knowledge/checks", "post", knowledgeChecksPost],
    ["/v1/knowledge/proposals", "post", knowledgeProposalsPost],
    ["/v1/knowledge/selections", "post", knowledgeSelectionsPost],
    ["/v1/knowledge/:id/disposition", "post", knowledgeDispositionPost],
    ["/v1/knowledge/:id/publish", "post", knowledgePublishPost],
    ["/v1/knowledge/:id/reuse", "post", knowledgeReusePost],
    ["/v1/knowledge/:id/supersede", "post", knowledgeSupersedePost],
    ["/v1/projects", "get", projectsIndexGet],
    ["/v1/projects", "post", projectsIndexPost],
    ["/v1/projects/unregistered", "get", projectsUnregisteredGet],
    ["/v1/projects/:id", "get", projectIdGet],
    ["/v1/projects/:id", "patch", projectIdPatch],
    ["/v1/projects/:id/probe", "post", projectProbePost],
    ["/v1/projects/:id/retire", "post", projectRetirePost],
    ["/v1/decisions", "post", decisionsIndexPost],
    ["/v1/authorizations/resolve", "post", authorizationsResolvePost],
    ["/v1/authorizations/:id/consume", "post", authorizationsConsumePost],
    ["/v1/observations", "post", observationsIndexPost],
    ["/v1/relays", "post", relaysIndexPost],
    ["/v1/relays/:id/acknowledgement", "post", relaysAcknowledgementPost],
    ["/v1/attempts/:id/artifacts", "post", attemptArtifactsPost],
    ["/v1/attempts/:id/fix", "post", attemptFixPost],
    ["/v1/attempts/:id/stop", "post", attemptStopPost],
    ["/v1/attempts/:id/acceptance", "post", attemptAcceptancePost],
    ["/v1/attempts/:id/notes", "post", attemptNotesPost],
    ["/v1/forge", "post", forgeIndexPost],
  ];
  for (const [path, method, handler] of registrations) {
    router.add(path, handler, method);
  }
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

/** Call one route; POST and PATCH bodies default to the empty object `{}`. */
async function callRoute(
  method: "get" | "post" | "patch",
  path: string,
  body?: unknown,
): Promise<{ status: number; payload: unknown }> {
  const hasBody = body !== undefined;
  const response = await fetch(`${apiBaseUrl}${path}`, {
    method: method.toUpperCase(),
    headers: hasBody
      ? { accept: "application/json", "content-type": "application/json" }
      : { accept: "application/json" },
    body: hasBody ? JSON.stringify(body) : undefined,
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

function envelopeOf(payload: unknown): { code: string; result: Record<string, unknown> | null } {
  const envelope = payload as { code?: string; result?: Record<string, unknown> | null };
  return { code: envelope?.code ?? "", result: envelope?.result ?? null };
}

// ---------------------------------------------------------------------------
// Pilot identities.
// ---------------------------------------------------------------------------

const PILOT_HEAD = "0123456789abcdef";
const MATRIX_HEAD = "aaaabbbbccccdddd";

const PILOT_PROFILE_REQUEST = {
  projectId: "proj-pilot-1",
  displayName: "Fleet Cutover Pilot",
  repository: "fleet",
  designatedDispatcherHost: "host-pilot-1",
  policyRevision: "policy-pilot-1",
  maxConcurrentLanes: 2,
  runnerCapabilities: { networkEgressRestricted: true },
};

const PILOT_WORK_ORDER_REQUEST = {
  workOrderId: "wo-pilot-1",
  projectId: "proj-pilot-1",
  taskId: "task-pilot-1",
  laneId: "lane-pilot-1",
  repository: "fleet",
  baseCommit: "0000000000000000",
  policyRevision: "policy-pilot-1",
  ownedPaths: ["apps/api/**"],
};

const PILOT_DECISION_REQUEST = {
  requestId: "req-decision-pilot-1",
  projectId: "proj-pilot-1",
  kind: "action-decision",
  actionScope: "wo-pilot-1/merge-pr",
  proposalDigest: "digest-pilot-1",
  policyRevision: "policy-pilot-1",
  expectedHeadSha: PILOT_HEAD,
};

const PILOT_OBSERVATION_REQUEST = {
  observationId: "observation-pilot-1",
  projectId: "proj-pilot-1",
  eventKind: "attempt-collected",
  sourceAttemptId: "attempt-pilot-1",
  payloadSummary: "attempt collected and accepted for merge",
};

/** The attempt an earlier process dispatched and collected for `PILOT_HEAD`. */
const PILOT_ATTEMPT = {
  id: "attempt-pilot-1",
  workOrderId: "wo-pilot-1",
  ownerDecisionReferences: [],
  kind: "initial",
  fixNumber: 0,
  priorAttemptId: null,
  worktreePath: "/tmp/opencode/fleet-pilot-worktrees/attempt-pilot-1",
  baseCommit: "0000000000000000",
  state: "collected",
  outcome: "done",
  briefDigest: null,
  briefPackagePath: null,
  sessionId: null,
  completionReceipt: null,
  artifacts: {
    headCommit: PILOT_HEAD,
    commitsSinceBase: [PILOT_HEAD],
    collectedArtifactPaths: [],
    notes: "missing",
  },
  createdAtIso: "2026-10-15T07:00:00.000Z",
  updatedAtIso: "2026-10-15T07:30:00.000Z",
};

/** The assessment an earlier process carried all the way to acceptance. */
const PILOT_ACCEPTED_ASSESSMENT = {
  id: "assessment-attempt-pilot-1",
  projectId: "proj-pilot-1",
  attemptId: "attempt-pilot-1",
  candidateHeadSha: PILOT_HEAD,
  policyRevision: "policy-pilot-1",
  requiredChecks: ["typecheck"],
  state: "accepted",
  verificationReceipts: [
    {
      id: "vr-pilot-1",
      assessmentId: "assessment-attempt-pilot-1",
      projectId: "proj-pilot-1",
      attemptId: "attempt-pilot-1",
      candidateHeadSha: PILOT_HEAD,
      hostId: "host-pilot-1",
      procedureName: "typecheck",
      result: "pass",
      exitCode: 0,
      evidenceRef: `seed@${PILOT_HEAD}`,
      policyRevision: "policy-pilot-1",
      completedAtIso: "2026-10-15T09:00:00.000Z",
    },
  ],
  reviewReceipts: [
    {
      id: "rr-pilot-1",
      assessmentId: "assessment-attempt-pilot-1",
      projectId: "proj-pilot-1",
      attemptId: "attempt-pilot-1",
      candidateHeadSha: PILOT_HEAD,
      reviewerModel: "seat-pilot/reviewer-model",
      implementerModel: "seat-pilot/implementer-model",
      readOnlyVerified: true,
      result: "pass",
      findings: [],
      evidenceRef: `review-seed@${PILOT_HEAD}`,
      policyRevision: "policy-pilot-1",
      completedAtIso: "2026-10-15T09:05:00.000Z",
    },
  ],
  findingDispositions: [],
  acceptanceReceiptId: "acc-pilot-1",
  blockers: [],
  revision: 1,
  updatedAtIso: "2026-10-15T09:10:00.000Z",
};

/** The approved decision whose grant authorizes exactly one merge. */
const PILOT_APPROVED_GRANT_REQUEST = {
  id: "req-grant-pilot-1",
  projectId: "proj-pilot-1",
  kind: "action-decision",
  state: "approved",
  actionScope: "wo-pilot-1/merge-pr",
  expectedHeadSha: PILOT_HEAD,
  proposalDigest: "digest-grant-pilot-1",
  policyRevision: "policy-pilot-1",
  decisionRevision: "decision-pilot-1",
  grantId: "grant-pilot-1",
  consumptions: [],
  acknowledgements: [],
  deliveryStatus: "delivered",
  deliveryGapReason: null,
  revision: 1,
  createdAtIso: "2026-10-15T08:00:00.000Z",
  updatedAtIso: "2026-10-15T08:05:00.000Z",
};

const MATRIX_VERIFICATION_REQUEST = {
  assessmentId: "assessment-matrix-1",
  projectId: "proj-matrix-1",
  attemptId: "attempt-matrix-1",
  candidateHeadSha: MATRIX_HEAD,
  policyRevision: "policy-matrix-1",
  hostId: "host-matrix-1",
  implementerModel: "seat-matrix/implementer-model",
  requiredChecks: ["typecheck"],
};

// ---------------------------------------------------------------------------
// Route matrix tables.
// ---------------------------------------------------------------------------

const ALL_ROUTES: ReadonlyArray<{ method: "get" | "post" | "patch"; path: string }> = [
  { method: "get", path: "/v1/work-orders/wo-matrix" },
  { method: "get", path: "/v1/attempts/attempt-matrix" },
  { method: "get", path: "/v1/heads/aaaabbbbccccdddd/evidence" },
  { method: "get", path: "/v1/capabilities" },
  { method: "get", path: "/v1/attention" },
  { method: "get", path: "/v1/coordination" },
  { method: "post", path: "/v1/work-orders" },
  { method: "post", path: "/v1/attempts/attempt-matrix/artifacts" },
  { method: "post", path: "/v1/attempts/attempt-matrix/fix" },
  { method: "post", path: "/v1/attempts/attempt-matrix/stop" },
  { method: "post", path: "/v1/attempts/attempt-matrix/acceptance" },
  { method: "post", path: "/v1/attempts/attempt-matrix/notes" },
  { method: "post", path: "/v1/forge" },
  { method: "post", path: "/v1/verifications" },
  { method: "post", path: "/v1/verifications/vr-matrix/receipt" },
  { method: "post", path: "/v1/reviews" },
  { method: "post", path: "/v1/reviews/rr-matrix/receipt" },
  { method: "post", path: "/v1/findings/f-matrix/disposition" },
  { method: "post", path: "/v1/heads/aaaabbbbccccdddd/assessment" },
  { method: "post", path: "/v1/knowledge/checks" },
  { method: "post", path: "/v1/knowledge/proposals" },
  { method: "post", path: "/v1/knowledge/selections" },
  { method: "post", path: "/v1/knowledge/ke-matrix/disposition" },
  { method: "post", path: "/v1/knowledge/ke-matrix/publish" },
  { method: "post", path: "/v1/knowledge/ke-matrix/reuse" },
  { method: "post", path: "/v1/knowledge/ke-matrix/supersede" },
  { method: "get", path: "/v1/projects" },
  { method: "post", path: "/v1/projects" },
  { method: "get", path: "/v1/projects/unregistered" },
  { method: "get", path: "/v1/projects/proj-matrix" },
  { method: "patch", path: "/v1/projects/proj-matrix" },
  { method: "post", path: "/v1/projects/proj-matrix/probe" },
  { method: "post", path: "/v1/projects/proj-matrix/retire" },
  { method: "post", path: "/v1/decisions" },
  { method: "post", path: "/v1/authorizations/resolve" },
  { method: "post", path: "/v1/authorizations/grant-matrix/consume" },
  { method: "post", path: "/v1/observations" },
  { method: "post", path: "/v1/relays" },
  { method: "post", path: "/v1/relays/relay-matrix/acknowledgement" },
];

/**
 * While configured, every route answers an empty `{}` body (or empty query)
 * with the bound use case's structured domain outcome instead of
 * `501 NOT_IMPLEMENTED`. Most answer HTTP 200 with the OK envelope; a route
 * that maps a rejected outcome to a client error carries its own status and
 * envelope code.
 */
const CONFIGURED_EMPTY_BODY_ROUTES: ReadonlyArray<{
  method: "get" | "post" | "patch";
  path: string;
  outcome: string;
  status?: number;
  code?: string;
}> = [
  { method: "post", path: "/v1/work-orders", outcome: "rejected" },
  { method: "get", path: "/v1/work-orders/wo-matrix", outcome: "not-found" },
  { method: "get", path: "/v1/attempts/attempt-matrix", outcome: "not-found" },
  { method: "post", path: "/v1/attempts/attempt-matrix/artifacts", outcome: "refused" },
  { method: "post", path: "/v1/attempts/attempt-matrix/fix", outcome: "refused" },
  { method: "post", path: "/v1/attempts/attempt-matrix/stop", outcome: "refused" },
  { method: "post", path: "/v1/attempts/attempt-matrix/acceptance", outcome: "rejected" },
  { method: "post", path: "/v1/attempts/attempt-matrix/notes", outcome: "rejected" },
  { method: "post", path: "/v1/forge", outcome: "refused" },
  { method: "post", path: "/v1/verifications", outcome: "rejected" },
  { method: "post", path: "/v1/verifications/vr-matrix/receipt", outcome: "rejected" },
  { method: "post", path: "/v1/reviews", outcome: "rejected" },
  { method: "post", path: "/v1/reviews/rr-matrix/receipt", outcome: "rejected" },
  { method: "post", path: "/v1/findings/f-matrix/disposition", outcome: "rejected" },
  { method: "post", path: "/v1/heads/aaaabbbbccccdddd/assessment", outcome: "rejected" },
  { method: "get", path: "/v1/heads/0f0f0f0f0f0f0f0f/evidence", outcome: "not-found" },
  { method: "post", path: "/v1/knowledge/checks", outcome: "rejected" },
  { method: "post", path: "/v1/knowledge/proposals", outcome: "rejected" },
  { method: "post", path: "/v1/knowledge/selections", outcome: "rejected" },
  { method: "post", path: "/v1/knowledge/ke-matrix/disposition", outcome: "rejected" },
  { method: "post", path: "/v1/knowledge/ke-matrix/publish", outcome: "rejected" },
  { method: "post", path: "/v1/knowledge/ke-matrix/reuse", outcome: "rejected" },
  { method: "post", path: "/v1/knowledge/ke-matrix/supersede", outcome: "rejected" },
  { method: "get", path: "/v1/projects", outcome: "listed" },
  { method: "post", path: "/v1/projects", outcome: "rejected", status: 422, code: "REFUSED" },
  { method: "get", path: "/v1/projects/unregistered", outcome: "listed" },
  {
    method: "get",
    path: "/v1/projects/proj-matrix",
    outcome: "not-found",
    status: 404,
    code: "NOT_FOUND",
  },
  {
    method: "patch",
    path: "/v1/projects/proj-matrix",
    outcome: "rejected",
    status: 422,
    code: "REFUSED",
  },
  {
    method: "post",
    path: "/v1/projects/proj-matrix/probe",
    outcome: "not-found",
    status: 404,
    code: "NOT_FOUND",
  },
  {
    method: "post",
    path: "/v1/projects/proj-matrix/retire",
    outcome: "rejected",
    status: 422,
    code: "REFUSED",
  },
  { method: "get", path: "/v1/capabilities", outcome: "not-found" },
  { method: "post", path: "/v1/decisions", outcome: "rejected" },
  { method: "post", path: "/v1/authorizations/resolve", outcome: "blocked" },
  { method: "post", path: "/v1/authorizations/grant-matrix/consume", outcome: "refused" },
  { method: "post", path: "/v1/observations", outcome: "delivery-gap" },
  { method: "get", path: "/v1/attention", outcome: "unavailable" },
  { method: "post", path: "/v1/relays", outcome: "rejected" },
  { method: "post", path: "/v1/relays/relay-matrix/acknowledgement", outcome: "rejected" },
];

// ---------------------------------------------------------------------------
// Cross-context state persistence helpers.
// ---------------------------------------------------------------------------

describe("cross-context state persistence helpers", () => {
  it("persists and reloads acceptance receipts with merge semantics", async () => {
    const stateDir = await makeTempDir();

    expect(readAcceptedReceiptsFromState(stateDir)).toEqual({});

    await persistAcceptedReceiptsToState(stateDir, { "head-a": "acc-a" });
    await persistAcceptedReceiptsToState(stateDir, { "head-b": "acc-b" });

    // The second write merges instead of dropping the first process's receipt.
    expect(readAcceptedReceiptsFromState(stateDir)).toEqual({
      "head-a": "acc-a",
      "head-b": "acc-b",
    });
    expect(readdirSync(stateDir).filter((name) => name.includes(".tmp-"))).toEqual([]);
  });

  it("persists and reloads authorization coordinates with merge semantics", async () => {
    const stateDir = await makeTempDir();

    expect(readAuthorizationCoordinatesFromState(stateDir).size).toBe(0);

    await persistAuthorizationCoordinatesToState(
      stateDir,
      new Map([
        ["grant-a", { attemptId: "attempt-a", expectedHeadSha: "head-a" }],
      ]),
    );
    await persistAuthorizationCoordinatesToState(
      stateDir,
      new Map([
        ["grant-b", { attemptId: "attempt-b", expectedHeadSha: "head-b" }],
      ]),
    );

    const reloaded = readAuthorizationCoordinatesFromState(stateDir);
    expect(reloaded.get("grant-a")).toEqual({
      attemptId: "attempt-a",
      expectedHeadSha: "head-a",
    });
    expect(reloaded.get("grant-b")).toEqual({
      attemptId: "attempt-b",
      expectedHeadSha: "head-b",
    });
    expect(readdirSync(stateDir).filter((name) => name.includes(".tmp-"))).toEqual([]);
  });

  it("refuses malformed persisted state instead of reading it as empty", async () => {
    // A corrupt file must never be read as empty: the next locked write would
    // replace the whole history with one record (Fable pass on #45).
    const stateDir = await makeTempDir();

    await writeFile(join(stateDir, "accepted-receipts.json"), "not json", "utf8");
    await writeFile(join(stateDir, "authorization-coordinates.json"), "{not json", "utf8");

    expect(() => readAcceptedReceiptsFromState(stateDir)).toThrow();
    expect(() => readAuthorizationCoordinatesFromState(stateDir)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Nitro startup plugin.
// ---------------------------------------------------------------------------

describe("bootstrapFleetApiFromEnv (Nitro startup plugin)", () => {
  afterEach(() => {
    configureFleetApiRuntime(null);
  });

  it("stays unconfigured when FLEET_STATE_DIR is unset or blank", async () => {
    configureFleetApiRuntime(null);

    expect(bootstrapFleetApiFromEnv({})).toBe(false);
    expect(bootstrapFleetApiFromEnv({ FLEET_STATE_DIR: "   " })).toBe(false);

    // Every use case still refuses with "Not implemented" (HTTP 501).
    await expect(
      workComposition().registerWorkOrder.execute(PILOT_WORK_ORDER_REQUEST),
    ).rejects.toThrow("Not implemented: RegisterWorkOrderUseCase");
  });

  it("configures the runtime when FLEET_STATE_DIR is set", async () => {
    const stateDir = await makeTempDir();
    const tokenFile = join(stateDir, "api-token");
    await writeFile(tokenFile, "a".repeat(32) + "\n", { mode: 0o600 });
    await chmod(tokenFile, 0o600);
    configureFleetApiRuntime(null);

    // Stays unconfigured without a valid token file.
    expect(bootstrapFleetApiFromEnv({ FLEET_STATE_DIR: `  ${stateDir}  ` })).toBe(false);

    expect(
      bootstrapFleetApiFromEnv({
        FLEET_STATE_DIR: `  ${stateDir}  `,
        FLEET_API_TOKEN_FILE: tokenFile,
      }),
    ).toBe(true);

    // The work-order guard needs a profile; register one through the runtime's
    // operator context first.
    const profiled = await getOperatorComposition().registerProjectProfile.execute(
      PILOT_PROFILE_REQUEST,
    );
    expect(profiled.outcome).toBe("registered");

    const registered = await workComposition().registerWorkOrder.execute(
      PILOT_WORK_ORDER_REQUEST,
    );
    expect(registered.outcome).toBe("registered");
  });
});

// ---------------------------------------------------------------------------
// 501-vs-validation matrix.
// ---------------------------------------------------------------------------

describe("501-vs-validation matrix", () => {
  let matrixStateDir: string;

  beforeAll(async () => {
    matrixStateDir = await makeTempDir();
    // A prior process seeded one assessment the receipt routes can record
    // against; the runtime below reloads it from disk at configuration time.
    const evidence = createConfiguredEvidenceUseCases({ stateDir: matrixStateDir });
    const verified = await evidence.requestVerification.execute(MATRIX_VERIFICATION_REQUEST);
    expect(verified.outcome).toBe("completed");
  });

  afterEach(() => {
    configureFleetApiRuntime(null);
  });

  it("returns 501 NOT_IMPLEMENTED on every /v1 route while unconfigured", async () => {
    configureFleetApiRuntime(null);

    for (const route of ALL_ROUTES) {
      const response = await callRoute(
        route.method,
        route.path,
        route.method === "get" ? undefined : {},
      );
      expect(response.status, `${route.method} ${route.path}`).toBe(501);
      expect(envelopeOf(response.payload).code, `${route.method} ${route.path}`).toBe(
        "NOT_IMPLEMENTED",
      );
    }

    // M11 removed POST /v1/attempts; with no handler mounted it reports 404
    // while unconfigured instead of the 501 every remaining route reports.
    const removed = await callRoute("post", "/v1/attempts", {});
    expect(removed.status).toBe(404);
  });

  it("answers empty bodies with domain outcomes while configured", async () => {
    configureFleetApiRuntime({ stateDir: matrixStateDir });

    for (const route of CONFIGURED_EMPTY_BODY_ROUTES) {
      const response = await callRoute(
        route.method,
        route.path,
        route.method === "get" ? undefined : {},
      );
      expect(response.status, `${route.method} ${route.path}`).toBe(route.status ?? 200);
      const envelope = envelopeOf(response.payload);
      expect(envelope.code, `${route.method} ${route.path}`).toBe(route.code ?? "OK");
      if (route.status === 404) {
        expect(envelope.result, `${route.method} ${route.path}`).toBeNull();
      } else if (route.status !== undefined && route.status >= 400) {
        // A client-error envelope carries a reason instead of a domain outcome.
        expect(typeof envelope.result?.reason, `${route.method} ${route.path}`).toBe("string");
      } else {
        expect(envelope.result?.outcome, `${route.method} ${route.path}`).toBe(route.outcome);
      }
    }

    // The coordination read answers a fleet-wide list for an empty query.
    const coordination = await callRoute("get", "/v1/coordination");
    expect(coordination.status).toBe(200);
    const coordinationResult = envelopeOf(coordination.payload).result as {
      undecidedProposals?: unknown[];
      unknownActions?: unknown[];
      undeliveredObservations?: unknown[];
      unacknowledgedRelays?: unknown[];
    };
    expect(coordinationResult.undecidedProposals).toEqual([]);
    expect(coordinationResult.unknownActions).toEqual([]);
    expect(coordinationResult.undeliveredObservations).toEqual([]);
    expect(coordinationResult.unacknowledgedRelays).toEqual([]);

    // M11 removed POST /v1/attempts; while configured it reports 404.
    const scaffold = await callRoute("post", "/v1/attempts", {});
    expect(scaffold.status).toBe(404);
  });

  it("preserves body.assessmentId and merges :id on the evidence receipt routes", async () => {
    configureFleetApiRuntime({ stateDir: matrixStateDir });

    // POST /v1/verifications/:id/receipt — `:id` becomes `receipt.id`.
    const verification = await callRoute("post", "/v1/verifications/vr-merged-1/receipt", {
      assessmentId: "assessment-matrix-1",
      receipt: {
        id: "discarded-by-merge",
        assessmentId: "assessment-matrix-1",
        projectId: "proj-matrix-1",
        attemptId: "attempt-matrix-1",
        candidateHeadSha: MATRIX_HEAD,
        hostId: "host-matrix-1",
        procedureName: "typecheck",
        result: "pass",
        exitCode: 0,
        evidenceRef: `receipt@${MATRIX_HEAD}`,
        policyRevision: "policy-matrix-1",
        completedAtIso: "2026-10-15T10:30:00.000Z",
      },
    });
    expect(verification.status).toBe(200);
    const verificationResult = envelopeOf(verification.payload).result as {
      outcome?: string;
      assessment?: { verificationReceipts?: Array<{ id?: string; procedureName?: string }> };
    };
    // "recorded" proves body.assessmentId was forwarded untouched; the
    // receipt id proves the route parameter was merged.
    expect(verificationResult.outcome).toBe("recorded");
    const typecheck = verificationResult.assessment?.verificationReceipts?.find(
      (receipt) => receipt.procedureName === "typecheck",
    );
    expect(typecheck?.id).toBe("vr-merged-1");

    // POST /v1/reviews/:id/receipt — `:id` becomes `receipt.id`.
    const review = await callRoute("post", "/v1/reviews/rr-merged-1/receipt", {
      assessmentId: "assessment-matrix-1",
      receipt: {
        id: "discarded-by-merge",
        assessmentId: "assessment-matrix-1",
        projectId: "proj-matrix-1",
        attemptId: "attempt-matrix-1",
        candidateHeadSha: MATRIX_HEAD,
        reviewerModel: "seat-matrix/reviewer-model",
        implementerModel: "seat-matrix/implementer-model",
        readOnlyVerified: true,
        result: "pass",
        findings: [
          {
            findingId: "f-matrix-1",
            severity: "minor",
            summary: "sample finding for the disposition merge",
            state: "unresolved",
            filePath: null,
            line: null,
            dispositionReason: null,
            dispositionEvidenceRef: null,
          },
        ],
        evidenceRef: `review@${MATRIX_HEAD}`,
        policyRevision: "policy-matrix-1",
        completedAtIso: "2026-10-15T10:35:00.000Z",
      },
    });
    expect(review.status).toBe(200);
    const reviewResult = envelopeOf(review.payload).result as {
      outcome?: string;
      assessment?: { reviewReceipts?: Array<{ id?: string }> };
    };
    expect(reviewResult.outcome).toBe("recorded");
    expect(reviewResult.assessment?.reviewReceipts?.map((receipt) => receipt.id)).toContain(
      "rr-merged-1",
    );

    // POST /v1/findings/:id/disposition — `:id` becomes `disposition.findingId`.
    // KF-33b1c: a recorded receipt scopes its finding ids as <receiptId>:<findingId>.
    const disposition = await callRoute("post", "/v1/findings/rr-merged-1:f-matrix-1/disposition", {
      assessmentId: "assessment-matrix-1",
      disposition: {
        id: "fd-matrix-1",
        findingId: "discarded-by-merge",
        assessmentId: "assessment-matrix-1",
        candidateHeadSha: MATRIX_HEAD,
        state: "fixed",
        reason: "fixed on the exact assessed head",
        evidenceRef: `fix@${MATRIX_HEAD}`,
        recordedBy: "checker-matrix-1",
        recordedAtIso: "2026-10-15T10:40:00.000Z",
      },
    });
    expect(disposition.status).toBe(200);
    const dispositionResult = envelopeOf(disposition.payload).result as {
      outcome?: string;
      assessment?: {
        findingDispositions?: Array<{ findingId?: string; state?: string }>;
        reviewReceipts?: Array<{
          id?: string;
          findings?: Array<{ findingId?: string; state?: string }>;
        }>;
      };
    };
    expect(dispositionResult.outcome).toBe("recorded");
    expect(dispositionResult.assessment?.findingDispositions?.[0]?.findingId).toBe("rr-merged-1:f-matrix-1");
    const finding = dispositionResult.assessment?.reviewReceipts
      ?.flatMap((receipt) => receipt.findings ?? [])
      .find((entry) => entry.findingId === "rr-merged-1:f-matrix-1");
    expect(finding?.state).toBe("fixed");
  });
});

// ---------------------------------------------------------------------------
// Restarted API + web client loopback pilot.
// ---------------------------------------------------------------------------

describe("restarted API and web client loopback pilot", () => {
  let pilotStateDir: string;

  beforeAll(async () => {
    pilotStateDir = await makeTempDir();

    // --- durable state an earlier process (a CLI run) left on disk ---
    await writeJsonFile(join(pilotStateDir, "attempts.json"), [PILOT_ATTEMPT]);
    await writeJsonFile(join(pilotStateDir, "assessments.json"), [PILOT_ACCEPTED_ASSESSMENT]);
    await writeJsonFile(join(pilotStateDir, "accepted-receipts.json"), {
      [PILOT_HEAD]: "acc-pilot-1",
    });
    await writeJsonFile(join(pilotStateDir, "coordination-requests.json"), [
      PILOT_APPROVED_GRANT_REQUEST,
    ]);
    await writeJsonFile(join(pilotStateDir, "authorization-coordinates.json"), {
      "grant-pilot-1": { attemptId: "attempt-pilot-1", expectedHeadSha: PILOT_HEAD },
    });

    // --- records the earlier process wrote through its own compositions ---
    const operator = createConfiguredOperatorComposition({ stateDir: pilotStateDir });
    expect((await operator.registerProjectProfile.execute(PILOT_PROFILE_REQUEST)).outcome).toBe(
      "registered",
    );
    expect((await operator.requestScopedDecision.execute(PILOT_DECISION_REQUEST)).outcome).toBe(
      "requested",
    );
    expect((await operator.publishProjectObservation.execute(PILOT_OBSERVATION_REQUEST)).outcome)
      .toBe("published");

    const work = createConfiguredWorkComposition(
      { stateDir: pilotStateDir },
      {
        projectProfile: {
          inspect: async (request) => operator.inspectProjectProfile.execute(request),
          record: async (request) => operator.recordProjectProbe.execute(request),
        },
      },
    );
    expect((await work.registerWorkOrder.registerWorkOrder(PILOT_WORK_ORDER_REQUEST)).outcome)
      .toBe("registered");

    // Simulate the API process restart against `stateDir` on disk: the fresh
    // runtime starts with empty in-memory receipt and coordinate maps, so
    // everything below can only come from the persisted files.
    configureFleetApiRuntime(null);
    configureFleetApiRuntime({ stateDir: pilotStateDir });
  });

  afterEach(() => {
    delete process.env.FLEET_API_URL;
    configureFleetApiRuntime(null);
  });

  it("serves the persisted records to the web client and survives the restart", async () => {
    process.env.FLEET_API_URL = apiBaseUrl;
    const client = createFleetWebApiClient();

    const workOrderView = await client.fetchWorkOrderView("wo-pilot-1", ENVELOPE_FALLBACK);
    expect(workOrderView.source).toBe("api");
    expect(workOrderView.status).toBe(200);
    expect(workOrderView.fallbackReason).toBeNull();
    const workResult = workOrderView.data.result as {
      outcome?: string;
      workOrder?: { id?: string; projectId?: string; state?: string };
      attempts?: Array<{ id?: string }>;
    };
    expect(workResult.outcome).toBe("found");
    expect(workResult.workOrder?.id).toBe("wo-pilot-1");
    expect(workResult.workOrder?.projectId).toBe("proj-pilot-1");
    expect(workResult.attempts?.map((attempt) => attempt.id)).toContain("attempt-pilot-1");

    const headView = await client.fetchHeadEvidenceView(PILOT_HEAD, ENVELOPE_FALLBACK);
    expect(headView.source).toBe("api");
    expect(headView.status).toBe(200);
    expect(headView.fallbackReason).toBeNull();
    const headResult = headView.data.result as {
      outcome?: string;
      assessment?: {
        id?: string;
        state?: string;
        acceptanceReceiptId?: string | null;
        candidateHeadSha?: string;
      };
    };
    expect(headResult.outcome).toBe("found");
    expect(headResult.assessment?.id).toBe("assessment-attempt-pilot-1");
    expect(headResult.assessment?.candidateHeadSha).toBe(PILOT_HEAD);
    expect(headResult.assessment?.state).toBe("accepted");
    expect(headResult.assessment?.acceptanceReceiptId).toBe("acc-pilot-1");

    const coordinationView = await client.fetchCoordinationView(ENVELOPE_FALLBACK);
    expect(coordinationView.source).toBe("api");
    expect(coordinationView.status).toBe(200);
    expect(coordinationView.fallbackReason).toBeNull();
    const coordinationResult = coordinationView.data.result as {
      undecidedProposals?: Array<{ id?: string }>;
    };
    expect(
      coordinationResult.undecidedProposals?.map((request) => request.id),
    ).toContain("req-decision-pilot-1");

    const attentionView = await client.fetchAttentionView(ENVELOPE_FALLBACK);
    expect(attentionView.source).toBe("api");
    expect(attentionView.status).toBe(200);
    expect(attentionView.fallbackReason).toBeNull();
    const attentionResult = attentionView.data.result as { outcome?: string };
    expect(attentionResult.outcome).toBe("unavailable");

    // --- acceptedReceiptByHead survived the restart ---
    // The restarted runtime's in-memory receipt registry is empty, so this
    // merge request passes the acceptance-receipt gate only through the
    // `<stateDir>/accepted-receipts.json` reload. Under M10, an unconfigured
    // forge delegate refuses with 'unavailable' without consuming; reaching
    // that readiness refusal proves the receipt was accepted for PILOT_HEAD.
    const receiptOnly = await callRoute("post", "/v1/forge", {
      actionId: "action-merge-control",
      attemptId: "attempt-pilot-1",
      workOrderId: "wo-pilot-1",
      kind: "merge-pr",
      expectedHeadSha: PILOT_HEAD,
      authorizationGrantId: "grant-unknown",
    });
    expect(receiptOnly.status).toBe(200);
    const controlResult = envelopeOf(receiptOnly.payload).result as {
      outcome?: string;
      reason?: string;
    };
    expect(controlResult.outcome).toBe("refused");
    expect(controlResult.reason).toBe("unavailable");

    // --- M10: unconfigured forge delegate leaves grant unconsumed ---
    // The forge subprocess delegate is unbound in this runtime; under M10,
    // execution refuses with unavailable WITHOUT consuming the grant.
    const merge = await callRoute("post", "/v1/forge", {
      actionId: "action-merge-pilot-1",
      attemptId: "attempt-pilot-1",
      workOrderId: "wo-pilot-1",
      kind: "merge-pr",
      expectedHeadSha: PILOT_HEAD,
      authorizationGrantId: "grant-pilot-1",
    });
    expect(merge.status).toBe(200);
    const mergeResult = envelopeOf(merge.payload).result as {
      outcome?: string;
      reason?: string;
    };
    expect(mergeResult.outcome).toBe("refused");
    expect(mergeResult.reason).toBe("unavailable");

    const storedRequests = JSON.parse(
      await readFile(join(pilotStateDir, "coordination-requests.json"), "utf8"),
    ) as Array<{
      id?: string;
      state?: string;
      consumptions?: Array<{
        actionId?: string;
        attemptId?: string;
        expectedHeadSha?: string;
      }>;
    }>;
    const grantRequest = storedRequests.find((request) => request.id === "req-grant-pilot-1");
    expect(grantRequest?.state).toBe("approved");
    expect(grantRequest?.consumptions).toHaveLength(0);
  });
});
