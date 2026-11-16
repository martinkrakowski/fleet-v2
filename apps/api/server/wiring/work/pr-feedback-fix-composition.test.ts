// CO24c: PreparePullRequestFeedbackFixUseCase composed in the API work composition.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { FleetInstallation } from "@fleet/installation";
import { AttemptRepositoryAdapter } from "@fleet/work-execution";
import type { AttemptRecord, ForgeActionDelegate } from "@fleet/work-execution";

import {
  configureWorkComposition,
  createConfiguredWorkComposition,
  workComposition,
  type WorkCompositionOptions,
} from "./composition";

const HEAD = "1".repeat(40);
const FIXED_HEAD = "2".repeat(40);
const SECOND_HEAD = "3".repeat(40);
const KEY = "pr-feedback/7@111111111111";
const FIX_ATTEMPT_ID = "pr-feedback-7-111111111111";
const BRANCH = "feat/lane-api-test";
const WORK_ORDER_ID = "wo-co24c-1";
const PRIOR_ATTEMPT_ID = "att-co24c-init";
const REPOSITORY = { owner: "org", repo: "repo" };
const OTHER_REPOSITORY = { owner: "other", repo: "repo" };
const GITHUB_FORGE = { mode: "github", owner: "org", repo: "repo" };
const MISMATCH = { outcome: "refused", code: "repository-mismatch" };
const NOT_CONFIGURED = { outcome: "refused", code: "not-configured" };
const PREPARED = { outcome: "prepared", key: KEY, fixAttemptId: FIX_ATTEMPT_ID, findingCount: 1 };

type GhCall = readonly [readonly string[], string | undefined, number | undefined];

/** The gh stub's state: every call it received, the pull request's head, how it answers, and the thread body. */
interface GhState {
  calls: GhCall[];
  head: string;
  mode: "ok" | "reject" | "exit-fail" | "garbage" | "empty";
  body: string;
}

function ghState(overrides: Partial<GhState> = {}): GhState {
  return { calls: [], head: HEAD, mode: "ok", body: "Rename this.", ...overrides };
}

function findingsAnswer(state: GhState): string {
  return JSON.stringify({
    data: {
      repository: {
        pullRequest: {
          state: "OPEN",
          headRefOid: state.head,
          headRefName: BRANCH,
          headRepository: { name: "repo", owner: { login: "org" } },
          reviewThreads: {
            totalCount: 1,
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [
              {
                id: "PRRT_unresolved",
                isResolved: false,
                path: "src/widget.ts",
                line: 12,
                comments: { nodes: [{ body: state.body, author: { __typename: "User" } }] },
              },
            ],
          },
        },
      },
    },
  });
}

function ghStub(state: GhState): NonNullable<ForgeActionDelegate["runGh"]> {
  return async (args, ghConfigDir, timeoutMs) => {
    state.calls.push([args, ghConfigDir, timeoutMs]);
    if (state.mode === "reject") {
      throw new Error("spawn failed");
    }
    if (state.mode === "exit-fail") {
      return { exitCode: 1, stdout: "", stderr: "gh api graphql failed" };
    }
    if (state.mode === "garbage") {
      return { exitCode: 0, stdout: "not json at all", stderr: "" };
    }
    if (state.mode === "empty") {
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    return { exitCode: 0, stdout: findingsAnswer(state), stderr: "" };
  };
}

function installation(forge: Record<string, string>): FleetInstallation {
  return {
    schemaVersion: 2,
    forge,
    hosts: {
      "host-1": {
        transport: "local",
        worktreeRoot: "/tmp/worktrees",
        roles: ["orchestrator", "lane-runner", "verifier"],
      },
    },
  } as unknown as FleetInstallation;
}

function priorAttempt(): AttemptRecord {
  return {
    id: PRIOR_ATTEMPT_ID,
    workOrderId: WORK_ORDER_ID,
    kind: "initial",
    fixNumber: 0,
    priorAttemptId: null,
    worktreePath: "/tmp/opencode/lanes/co24c",
    baseCommit: "0".repeat(40),
    state: "collected",
    outcome: "done",
    briefDigest: null,
    briefPackagePath: null,
    sessionId: null,
    completionReceipt: null,
    artifacts: null,
    createdAtIso: "2026-11-16T09:00:00.000Z",
    updatedAtIso: "2026-11-16T09:00:00.000Z",
  };
}

function prepareRequest(overrides: Record<string, unknown> = {}) {
  return {
    repository: REPOSITORY,
    pullRequestNumber: 7,
    headSha: HEAD,
    branchName: BRANCH,
    workOrderId: WORK_ORDER_ID,
    priorAttemptId: PRIOR_ATTEMPT_ID,
    ...overrides,
  };
}

function pushRequest(overrides: Record<string, unknown> = {}) {
  return {
    repository: REPOSITORY,
    pullRequestNumber: 7,
    branchName: BRANCH,
    expectedHeadSha: HEAD,
    fixedHeadSha: FIXED_HEAD,
    workOrderId: WORK_ORDER_ID,
    attemptId: FIX_ATTEMPT_ID,
    grantId: "grant-co24c-push",
    ...overrides,
  };
}

function pushRefusal(code: string) {
  return { outcome: "refused", key: KEY, headSha: FIXED_HEAD, code };
}

/** The composed use case behind a forge delegate that runs `gh` and names `repository`. */
function composed(gh: GhState, options: WorkCompositionOptions = {}, repository = REPOSITORY) {
  return createConfiguredWorkComposition(options, {
    forge: { runGh: ghStub(gh), repository },
  }).preparePullRequestFeedbackFix;
}

const tempDirs: string[] = [];

/** A temporary state directory holding the collected prior attempt. */
async function seededStateDir(): Promise<string> {
  const stateDir = await mkdtemp(join(tmpdir(), "fleet-co24c-"));
  tempDirs.push(stateDir);
  await new AttemptRepositoryAdapter({ stateDir }).saveAttempt(priorAttempt());
  return stateDir;
}

async function fixAttemptIds(stateDir: string): Promise<readonly string[]> {
  const all = await new AttemptRepositoryAdapter({ stateDir }).listAttemptsByWorkOrder(WORK_ORDER_ID);
  return all.filter((attempt) => attempt.kind === "fix").map((attempt) => attempt.id);
}

afterEach(async () => {
  configureWorkComposition(null);
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("CO24c: PreparePullRequestFeedbackFixUseCase in the API work composition", () => {
  it("prepares one intent-recorded fix attempt, passes gh the 30 s timeout as third argument, and answers already-prepared on replay", async () => {
    const stateDir = await seededStateDir();
    const gh = ghState();
    const fix = composed(gh, { stateDir });

    expect(await fix.preparePullRequestFeedbackFix(prepareRequest())).toEqual(PREPARED);
    expect(gh.calls).toHaveLength(1);
    const [args, ghConfigDir, timeoutMs] = gh.calls[0];
    expect(args.slice(0, 2)).toEqual(["api", "graphql"]);
    expect(args).toContain("owner=org");
    expect(args).toContain("name=repo");
    expect(ghConfigDir).toBeUndefined();
    expect(timeoutMs).toBe(30_000);

    const stored = await new AttemptRepositoryAdapter({ stateDir }).findAttemptById(FIX_ATTEMPT_ID);
    expect([stored?.kind, stored?.state, stored?.priorAttemptId]).toEqual([
      "fix",
      "intent-recorded",
      PRIOR_ATTEMPT_ID,
    ]);

    expect(await fix.preparePullRequestFeedbackFix(prepareRequest())).toEqual({
      ...PREPARED,
      outcome: "already-prepared",
    });
    expect(await fixAttemptIds(stateDir)).toEqual([FIX_ATTEMPT_ID]);
  });

  it("refuses a second distinct round on the work order through the pending-fix guard and stores no second fix attempt", async () => {
    const stateDir = await seededStateDir();
    const gh = ghState();
    const fix = composed(gh, { stateDir });
    expect(await fix.preparePullRequestFeedbackFix(prepareRequest())).toEqual(PREPARED);

    gh.head = SECOND_HEAD;
    expect(await fix.preparePullRequestFeedbackFix(prepareRequest({ headSha: SECOND_HEAD }))).toEqual({
      outcome: "refused",
      code: "fix-attempt-refused",
      detail: "refused",
    });
    expect(await fixAttemptIds(stateDir)).toEqual([FIX_ATTEMPT_ID]);
  });

  it("refuses repository-mismatch without a gh call when the request names another repository", async () => {
    const gh = ghState();
    const fix = composed(gh);

    expect(
      await fix.preparePullRequestFeedbackFix(prepareRequest({ repository: OTHER_REPOSITORY })),
    ).toEqual(MISMATCH);
    expect(
      await fix.pushPullRequestFeedbackFix(pushRequest({ repository: OTHER_REPOSITORY })),
    ).toEqual(pushRefusal("repository-mismatch"));
    expect(gh.calls).toHaveLength(0);
  });

  it("refuses repository-mismatch for both repositories when the installation and the forge delegate disagree", async () => {
    const gh = ghState();
    const fix = composed(gh, { installation: installation(GITHUB_FORGE) }, OTHER_REPOSITORY);

    for (const repository of [REPOSITORY, OTHER_REPOSITORY]) {
      expect(await fix.preparePullRequestFeedbackFix(prepareRequest({ repository }))).toEqual(MISMATCH);
    }
    expect(gh.calls).toHaveLength(0);
  });

  it("refuses repository-mismatch without a gh call when the forge delegate runs gh but names no repository", async () => {
    const gh = ghState();
    const fix = createConfiguredWorkComposition(
      { installation: installation(GITHUB_FORGE) },
      { forge: { runGh: ghStub(gh) } },
    ).preparePullRequestFeedbackFix;

    expect(await fix.preparePullRequestFeedbackFix(prepareRequest())).toEqual(MISMATCH);
    expect(gh.calls).toHaveLength(0);
  });

  it("refuses not-configured for the installation's repository and repository-mismatch for another when no forge delegate is bound", async () => {
    const fix = createConfiguredWorkComposition({
      installation: installation(GITHUB_FORGE),
    }).preparePullRequestFeedbackFix;

    expect(await fix.preparePullRequestFeedbackFix(prepareRequest())).toEqual(NOT_CONFIGURED);
    expect(await fix.pushPullRequestFeedbackFix(pushRequest())).toEqual(pushRefusal("not-configured"));
    expect(
      await fix.preparePullRequestFeedbackFix(prepareRequest({ repository: OTHER_REPOSITORY })),
    ).toEqual(MISMATCH);
  });

  it("refuses not-configured when the forge delegate names the repository but binds no runGh", async () => {
    const fix = createConfiguredWorkComposition(
      {},
      { forge: { repository: REPOSITORY } },
    ).preparePullRequestFeedbackFix;

    expect(await fix.preparePullRequestFeedbackFix(prepareRequest())).toEqual(NOT_CONFIGURED);
    expect(await fix.pushPullRequestFeedbackFix(pushRequest())).toEqual(pushRefusal("not-configured"));
  });

  it("refuses repository-mismatch when neither a forge delegate nor an installation is given", async () => {
    const fix = createConfiguredWorkComposition().preparePullRequestFeedbackFix;
    expect(await fix.preparePullRequestFeedbackFix(prepareRequest())).toEqual(MISMATCH);
  });

  it("refuses not-configured without a gh call when the installation's forge mode is none", async () => {
    const gh = ghState();
    const fix = composed(gh, { installation: installation({ mode: "none" }) });

    expect(await fix.preparePullRequestFeedbackFix(prepareRequest())).toEqual(NOT_CONFIGURED);
    expect(gh.calls).toHaveLength(0);
  });

  it("refuses forge-unreadable and stores nothing when gh rejects, fails, answers garbage or answers nothing, and the next healthy pass prepares", async () => {
    const stateDir = await seededStateDir();
    for (const mode of ["reject", "exit-fail", "garbage", "empty"] as const) {
      const gh = ghState({ mode });
      const fix = composed(gh, { stateDir });
      expect(await fix.preparePullRequestFeedbackFix(prepareRequest())).toEqual({
        outcome: "refused",
        code: "forge-unreadable",
      });
      expect(gh.calls).toHaveLength(1);
      expect(await fixAttemptIds(stateDir)).toEqual([]);
    }

    const healthy = composed(ghState(), { stateDir });
    expect(await healthy.preparePullRequestFeedbackFix(prepareRequest())).toEqual(PREPARED);
  });

  it("answers already-pushed from one graphql read when the pull request is already at the fixed head", async () => {
    const gh = ghState({ head: FIXED_HEAD });
    const fix = composed(gh);

    expect(await fix.pushPullRequestFeedbackFix(pushRequest())).toEqual({
      outcome: "already-pushed",
      key: KEY,
      headSha: FIXED_HEAD,
    });
    expect(gh.calls.map(([args]) => args.slice(0, 2))).toEqual([["api", "graphql"]]);
  });

  it("refuses a push without a grant id as grant-missing before any gh call", async () => {
    const gh = ghState();
    const fix = composed(gh);
    const withoutGrant: Record<string, unknown> = pushRequest();
    delete withoutGrant.grantId;

    expect(await fix.pushPullRequestFeedbackFix(withoutGrant as never)).toEqual(
      pushRefusal("grant-missing"),
    );
    expect(gh.calls).toHaveLength(0);
  });

  it("answers invalid-request for malformed requests without throwing, invoking a getter or calling gh", async () => {
    const gh = ghState();
    const fix = composed(gh);
    let invoked = false;
    const withGetter = { ...prepareRequest() };
    Object.defineProperty(withGetter, "repository", {
      enumerable: true,
      get() {
        invoked = true;
        throw new Error("getter ran");
      },
    });

    for (const request of [null, 7, withGetter, prepareRequest({ pullRequestNumber: 0 })]) {
      expect(await fix.preparePullRequestFeedbackFix(request as never)).toEqual({
        outcome: "refused",
        code: "invalid-request",
      });
    }
    expect(invoked).toBe(false);
    expect(gh.calls).toHaveLength(0);
  });

  it("rejects with Not implemented when the work composition is unconfigured", async () => {
    configureWorkComposition(null);
    await expect(
      workComposition().preparePullRequestFeedbackFix.preparePullRequestFeedbackFix(prepareRequest()),
    ).rejects.toThrow("Not implemented: PreparePullRequestFeedbackFixUseCase");
  });

  it("refuses a secret-shaped finding body as redaction-refused and stores no fix attempt", async () => {
    const stateDir = await seededStateDir();
    const fix = composed(ghState({ body: "use " + "ghp_" + "x".repeat(30) }), { stateDir });

    expect(await fix.preparePullRequestFeedbackFix(prepareRequest())).toEqual({
      outcome: "refused",
      code: "redaction-refused",
    });
    expect(await fixAttemptIds(stateDir)).toEqual([]);
  });
});
