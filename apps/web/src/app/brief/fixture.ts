import type { WorkOrderBriefList } from "./brief-wire";

export {
  type WorkOrderFixture,
  type ProposalFixture,
  type FrozenPackageFixture,
  type BriefFixture,
  BRIEF_FIXTURE as FIXTURE,
} from "../../fixtures/station-fixture";

/**
 * Test-only wire fixture for the work-order list (shape from
 * `docs/planning/2026-10-27_web-ui-interactivity-plan.md`). No page or loader
 * imports it; tests use it as input.
 */
export const WORK_ORDER_BRIEF_LIST_FIXTURE: WorkOrderBriefList = {
  entries: [
    {
      workOrder: {
        id: "wo-0144",
        projectId: "fleet-v2",
        taskId: "task-0144",
        laneId: "lane-0144",
        state: "ready",
        revision: 3,
        baseCommit: "0123456789abcdef0123456789abcdef01234567",
        baseBranch: "main",
        policyRevision: 2,
        risk: "standard",
        ownedPaths: ["apps/web/src/app/brief"],
        prerequisiteWorkOrderIds: [],
        pullRequestTitle: "feat(web): brief viewer",
        createdAtIso: "2026-11-01T10:00:00.000Z",
        updatedAtIso: "2026-11-01T11:00:00.000Z",
      },
      latestAttempt: {
        id: "att-0144-1",
        workOrderId: "wo-0144",
        kind: "initial",
        fixNumber: 0,
        state: "ended",
        outcome: "committed",
        baseCommit: "0123456789abcdef0123456789abcdef01234567",
        briefDigest: null,
        ownerDecisionReferences: null,
        createdAtIso: "2026-11-01T10:30:00.000Z",
        updatedAtIso: "2026-11-01T11:00:00.000Z",
      },
      briefMarkdown: "# wo-0144\n\nRead-only **brief** text with `code`.",
    },
    {
      workOrder: {
        id: "wo-0145",
        projectId: "fleet-v2",
        taskId: "task-0145",
        laneId: "lane-0145",
        state: "draft",
        revision: 1,
        baseCommit: "fedcba9876543210fedcba9876543210fedcba98",
        policyRevision: 2,
        ownedPaths: [],
        prerequisiteWorkOrderIds: ["wo-0144"],
        createdAtIso: "2026-11-01T12:00:00.000Z",
        updatedAtIso: "2026-11-01T12:00:00.000Z",
      },
      latestAttempt: null,
      briefMarkdown: null,
    },
  ],
};
