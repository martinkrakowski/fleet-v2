import { describe, expect, it } from "vitest";
import type {
  ActionJournalEntryRecord,
  AttemptRecord,
  CapacityReservationRecord,
  WorkOrderRecord,
} from "../../domain/execution-records.js";
import type {
  ActionAuthorizationPort,
  ConsumeActionAuthorizationRequest,
  ConsumeActionAuthorizationResult,
} from "../ports/out/ActionAuthorizationPort.out-port.js";
import type { AttemptRepositoryPort } from "../ports/out/AttemptRepositoryPort.out-port.js";
import type {
  ExecutionJournalPort,
  ReserveCapacityAtomicallyRequest,
} from "../ports/out/ExecutionJournalPort.out-port.js";
import type {
  ForgeActionPort,
  ForgeActionRequest,
  ForgeActionResult,
  OpenPullRequestsByHeadResult,
} from "../ports/out/ForgeActionPort.out-port.js";
import type { WorkOrderRepositoryPort } from "../ports/out/WorkOrderRepositoryPort.out-port.js";
import type {
  AcceptanceEvidencePort,
  ReadAcceptanceRequest,
  ReadAcceptanceResult,
} from "../ports/out/AcceptanceEvidencePort.out-port.js";
import type { AttemptOwnerDecisionPort } from "../ports/out/AttemptOwnerDecisionPort.out-port.js";
import type { OwnerDecisionPort } from "../ports/out/OwnerDecisionPort.out-port.js";
import { ExecuteAuthorizedForgeActionUseCase } from "./ExecuteAuthorizedForgeActionUseCase.use-case.js";
import {
  decideMergeRecord,
  type MergeRecordRecord,
} from "../../domain/entities/MergeRecord.js";
import {
  decidePullRequestLink,
  pullRequestLinkConflictKey,
  pullRequestLinkKey,
} from "../../domain/entities/PullRequestLink.js";
import type {
  LanePlanRecord,
  PullRequestLinkConflictRecord,
  PullRequestLinkRecord,
} from "../../domain/lane-plan-records.js";
import type {
  LanePlanRepositoryPort,
  SaveLanePlanResult,
  SavePullRequestLinkConflictResult,
  SavePullRequestLinkResult,
} from "../ports/out/LanePlanRepositoryPort.out-port.js";
import type { MergeRecordRepositoryPort } from "../ports/out/MergeRecordRepositoryPort.out-port.js";
import type {
  PullRequestSnapshot,
  ReadPullRequestRequest,
  ReadPullRequestResult,
} from "../ports/out/ForgeReadPort.out-port.js";
import type { MergeRecordSaveOutcome } from "../ports/out/MergeRecordRepositoryPort.out-port.js";

/**
 * A pull-request read that answers any number as open on `feat/lane-auth` at
 * the shared head (WB5b2): the verification of a request-only number passes.
 */
const OPEN_READER = {
  async readPullRequest(
    request: ReadPullRequestRequest,
  ): Promise<ReadPullRequestResult> {
    return {
      outcome: "found",
      pullRequest: {
        number: request.ref.kind === "number" ? request.ref.number : 0,
        state: "open",
        mergeState: "clean",
        headSha: "1111111111111111111111111111111111111111",
        headRef: "feat/lane-auth",
        isCrossRepository: false,
        headRepositoryOwner: 'org',
        baseRef: "main",
        mergedAtIso: null,
        closedAtIso: null,
        mergeCommitSha: null,
      },
    };
  },
};

class InMemoryAcceptanceEvidencePort implements AcceptanceEvidencePort {
  constructor(private readonly result: ReadAcceptanceResult) {}

  async readAcceptance(
    _request: ReadAcceptanceRequest,
  ): Promise<ReadAcceptanceResult> {
    return this.result;
  }
}

class InMemoryAttemptRepo implements AttemptRepositoryPort {
  constructor(private attempt: AttemptRecord | null) {}

  async findAttemptById(_id: string): Promise<AttemptRecord | null> {
    return this.attempt;
  }
  async saveAttempt(record: AttemptRecord): Promise<void> {
    this.attempt = record;
  }
  async listAttemptsByWorkOrder(
    workOrderId: string,
  ): Promise<readonly AttemptRecord[]> {
    return this.attempt && this.attempt.workOrderId === workOrderId
      ? [this.attempt]
      : [];
  }
  async listAllAttempts(): Promise<readonly AttemptRecord[]> {
    return this.attempt ? [this.attempt] : [];
  }
}

class InMemoryWorkOrderRepo implements WorkOrderRepositoryPort {
  constructor(private workOrder: WorkOrderRecord | null) {}

  async findWorkOrderById(_id: string): Promise<WorkOrderRecord | null> {
    return this.workOrder;
  }
  async saveWorkOrder(record: WorkOrderRecord): Promise<void> {
    this.workOrder = record;
  }
  async listWorkOrdersByProject(
    projectId?: string,
  ): Promise<readonly WorkOrderRecord[]> {
    if (!this.workOrder) return [];
    if (projectId && this.workOrder.projectId !== projectId) return [];
    return [this.workOrder];
  }
}

class InMemoryJournal implements ExecutionJournalPort {
  readonly entries: ActionJournalEntryRecord[] = [];
  private seenIds = new Set<string>();

  async appendJournalEntry(entry: ActionJournalEntryRecord): Promise<void> {
    if (this.seenIds.has(entry.id)) {
      throw new Error(`Duplicate journal entry id: ${entry.id}`);
    }
    this.seenIds.add(entry.id);
    this.entries.push(entry);
  }

  async listJournalEntriesForAttempt(
    attemptId: string,
  ): Promise<readonly ActionJournalEntryRecord[]> {
    return this.entries.filter((e) => e.attemptId === attemptId);
  }

  async saveCapacityReservation(): Promise<void> {}
  async listActiveReservations(): Promise<readonly []> {
    return [];
  }
  async releaseCapacityReservation(): Promise<boolean> {
    return false;
  }
  async reserveCapacityAtomically(request: ReserveCapacityAtomicallyRequest) {
    const reservation: CapacityReservationRecord = {
      ...request.record!,
      slotIndex: 0,
    };
    return { outcome: "reserved" as const, reservation };
  }
}

function makeAttemptRecord(): AttemptRecord {
  return {
    id: "att-001",
    ownerDecisionReferences: [],
    workOrderId: "wo-001",
    kind: "initial",
    fixNumber: 0,
    priorAttemptId: null,
    state: "collected",
    outcome: "done",
    baseCommit: "base-000",
    worktreePath: "/tmp/worktree",
    briefDigest: "sha256-brief",
    briefPackagePath: null,
    sessionId: null,
    completionReceipt: null,
    artifacts: {
      headCommit: "1111111111111111111111111111111111111111",
      commitsSinceBase: ["1111111111111111111111111111111111111111"],
      collectedArtifactPaths: ["/tmp/patch.diff"],
      notes: "present",
    },
    createdAtIso: "2026-10-15T10:00:00Z",
    updatedAtIso: "2026-10-15T10:30:00Z",
  };
}

/** An attempt-owner-decision port backed by one attempt repository. */
function attemptDoorsFrom(
  repo: AttemptRepositoryPort,
): AttemptOwnerDecisionPort {
  return {
    async readAttemptOwnerDecisionReferences({ attemptId }) {
      const record = await repo.findAttemptById(attemptId);
      if (record === null) {
        return {
          outcome: "unknown",
          reason: `No attempt is recorded for ${attemptId}`,
        };
      }
      if (record.ownerDecisionReferences === undefined) {
        return {
          outcome: "unknown",
          reason: `attempt ${attemptId} was recorded before owner decision references were frozen`,
        };
      }
      return {
        outcome: "recorded",
        ownerDecisionReferences: record.ownerDecisionReferences,
      };
    },
  };
}

function makeWorkOrderRecord(): WorkOrderRecord {
  return {
    id: "wo-001",
    projectId: "proj-001",
    taskId: "task-001",
    laneId: "lane-auth",
    repository: "github.com/org/repo",
    state: "approved",
    revision: 1,
    baseCommit: "base-000",
    ownedPaths: ["src/"],
    policyRevision: "pol-1",
    prerequisiteWorkOrderIds: [],
    createdAtIso: "2026-10-15T09:00:00Z",
    updatedAtIso: "2026-10-15T10:35:00Z",
  };
}

describe("ExecuteAuthorizedForgeActionUseCase", () => {
  describe("forge mode none (D6)", () => {
    it("refuses every forge action before any grant is consumed, journalled or executed", async () => {
      const journal = new InMemoryJournal();
      const attemptRepo = new InMemoryAttemptRepo(makeAttemptRecord());
      const workOrderRepo = new InMemoryWorkOrderRepo(makeWorkOrderRecord());

      let consumed = false;
      const authorizationPort: ActionAuthorizationPort = {
        async resolveActionAuthorization() {
          return { outcome: "granted", authorizationGrantId: "g-1" };
        },
        async consumeActionAuthorization(
          _req: ConsumeActionAuthorizationRequest,
        ): Promise<ConsumeActionAuthorizationResult> {
          consumed = true;
          return { outcome: "consumed", actionId: _req.actionId };
        },
      };
      const forgePort: ForgeActionPort = {
        isConfigured: () => true,
        boundRepository: () => ({ owner: 'org', repo: 'repo' }),
        async performForgeAction(): Promise<ForgeActionResult> {
          throw new Error("Should never be called");
        },
      };

      const useCase = new ExecuteAuthorizedForgeActionUseCase({
        mergeRecordRepo: new FakeMergeRecordRepo([]),
        forgeRead: OPEN_READER,
        attemptRepo,
        workOrderRepo,
        journal,
        authorizationPort,
        forgePort,
        forgeMode: "none",
      });

      const result = await useCase.executeAuthorizedForgeAction({
        actionId: "forge-att-001",
        attemptId: "att-001",
        workOrderId: "wo-001",
        kind: "push-and-open-pr",
        expectedHeadSha: "1111111111111111111111111111111111111111",
        authorizationGrantId: "grant-001",
      });

      expect(result.outcome).toBe("refused");
      if (result.outcome === "refused") {
        expect(result.reason).toContain("Forge mode is 'none'");
      }
      expect(consumed).toBe(false);
      expect(journal.entries).toHaveLength(0);
    });
  });

  describe("M7: journal sequence derivation across use case instances", () => {
    it("two use-case instances on the same journal, the second after a refusal, produce distinct ids and a typed result, no throw", async () => {
      const journal = new InMemoryJournal();
      const attemptRepo = new InMemoryAttemptRepo(makeAttemptRecord());
      const workOrderRepo = new InMemoryWorkOrderRepo(makeWorkOrderRecord());

      let consumeCalls = 0;
      const authorizationPort: ActionAuthorizationPort = {
        async resolveActionAuthorization() {
          return { outcome: "granted", authorizationGrantId: "g-1" };
        },
        async consumeActionAuthorization(
          _req: ConsumeActionAuthorizationRequest,
        ): Promise<ConsumeActionAuthorizationResult> {
          consumeCalls++;
          return { outcome: "refused", reason: "grant scope does not match" };
        },
      };

      const forgePort: ForgeActionPort = {
        isConfigured: () => true,
        boundRepository: () => ({ owner: 'org', repo: 'repo' }),
        async performForgeAction(
          _req: ForgeActionRequest,
        ): Promise<ForgeActionResult> {
          return {
            outcome: "executed",
            headSha: "1111111111111111111111111111111111111111",
          };
        },
      };

      const req = {
        actionId: "forge-att-001",
        attemptId: "att-001",
        workOrderId: "wo-001",
        kind: "merge-pr" as const,
        pullRequestNumber: 7,
        expectedHeadSha: "1111111111111111111111111111111111111111",
        authorizationGrantId: "grant-001",
      };

      // Instance 1 runs and is refused by authorization
      const defaultAcceptancePort = new InMemoryAcceptanceEvidencePort({
        outcome: "found",
        assessment: {
          candidateHeadSha: "1111111111111111111111111111111111111111",
          policyRevision: "pol-1",
          state: "accepted",
          acceptanceReceiptId: "receipt-001",
        },
      });

      const instance1 = new ExecuteAuthorizedForgeActionUseCase({
        mergeRecordRepo: new FakeMergeRecordRepo([]),
        forgeRead: OPEN_READER,
        attemptRepo,
        attemptOwnerDecisionPort: attemptDoorsFrom(attemptRepo),
        workOrderRepo,
        journal,
        authorizationPort,
        forgePort,
        acceptedReceiptByHead: {
          "1111111111111111111111111111111111111111": "receipt-001",
        },
        acceptanceEvidencePort: defaultAcceptancePort,
      });
      const result1 = await instance1.executeAuthorizedForgeAction(req);
      expect(result1.outcome).toBe("refused");
      expect(consumeCalls).toBe(1);
      expect(journal.entries).toHaveLength(1);
      expect(journal.entries[0]?.id).toBe("forge:forge-att-001:refused:1");

      // Instance 2 simulates a second process running with a fresh use case instance on the same journal
      const instance2 = new ExecuteAuthorizedForgeActionUseCase({
        mergeRecordRepo: new FakeMergeRecordRepo([]),
        forgeRead: OPEN_READER,
        attemptRepo,
        attemptOwnerDecisionPort: attemptDoorsFrom(attemptRepo),
        workOrderRepo,
        journal,
        authorizationPort,
        forgePort,
        acceptedReceiptByHead: {
          "1111111111111111111111111111111111111111": "receipt-001",
        },
        acceptanceEvidencePort: defaultAcceptancePort,
      });
      // This should NOT throw a duplicate key error!
      const result2 = await instance2.executeAuthorizedForgeAction(req);
      expect(result2.outcome).toBe("refused");
      expect(consumeCalls).toBe(2);
      expect(journal.entries).toHaveLength(2);
      expect(journal.entries[1]?.id).toBe("forge:forge-att-001:refused:2");
      expect(journal.entries[0]?.id).not.toBe(journal.entries[1]?.id);
    });
  });

  describe("M10: forge readiness before consumption", () => {
    it("refuses with unavailable and leaves grant unconsumed when forgePort is not configured", async () => {
      const journal = new InMemoryJournal();
      const attemptRepo = new InMemoryAttemptRepo(makeAttemptRecord());
      const workOrderRepo = new InMemoryWorkOrderRepo(makeWorkOrderRecord());

      let consumed = false;
      const authorizationPort: ActionAuthorizationPort = {
        async resolveActionAuthorization() {
          return { outcome: "granted", authorizationGrantId: "g-1" };
        },
        async consumeActionAuthorization(
          _req: ConsumeActionAuthorizationRequest,
        ): Promise<ConsumeActionAuthorizationResult> {
          consumed = true;
          return { outcome: "consumed", actionId: _req.actionId };
        },
      };

      // Unconfigured forge port (e.g. no delegate bound)
      const unconfiguredForgePort: ForgeActionPort = {
        isConfigured: () => false,
        boundRepository: () => ({ owner: 'org', repo: 'repo' }),
        async performForgeAction(): Promise<ForgeActionResult> {
          throw new Error("Should never be called");
        },
      };

      const useCase = new ExecuteAuthorizedForgeActionUseCase({
        mergeRecordRepo: new FakeMergeRecordRepo([]),
        forgeRead: OPEN_READER,
        attemptRepo,
        attemptOwnerDecisionPort: attemptDoorsFrom(attemptRepo),
        workOrderRepo,
        journal,
        authorizationPort,
        forgePort: unconfiguredForgePort,
        acceptedReceiptByHead: {
          "1111111111111111111111111111111111111111": "receipt-001",
        },
        acceptanceEvidencePort: new InMemoryAcceptanceEvidencePort({
          outcome: "found",
          assessment: {
            candidateHeadSha: "1111111111111111111111111111111111111111",
            policyRevision: "pol-1",
            state: "accepted",
            acceptanceReceiptId: "receipt-001",
          },
        }),
      });

      const result = await useCase.executeAuthorizedForgeAction({
        actionId: "act-1",
        attemptId: "att-001",
        workOrderId: "wo-001",
        kind: "merge-pr",
        pullRequestNumber: 7,
        expectedHeadSha: "1111111111111111111111111111111111111111",
        authorizationGrantId: "grant-001",
      });

      expect(result).toEqual({ outcome: "refused", reason: "unavailable" });
      expect(consumed).toBe(false);
      expect(journal.entries).toHaveLength(0);
    });
  });

  describe("M12: acceptance evidence verification before merge-pr", () => {
    const validAssessment = {
      candidateHeadSha: "1111111111111111111111111111111111111111",
      policyRevision: "pol-1",
      state: "accepted" as const,
      acceptanceReceiptId: "receipt-001",
    };

    const mergeReq = {
      actionId: "forge-act-1",
      attemptId: "att-001",
      workOrderId: "wo-001",
      kind: "merge-pr" as const,
      pullRequestNumber: 7,
      expectedHeadSha: "1111111111111111111111111111111111111111",
      authorizationGrantId: "grant-001",
    };

    const successfulAuthPort: ActionAuthorizationPort = {
      async resolveActionAuthorization() {
        return { outcome: "granted", authorizationGrantId: "grant-001" };
      },
      async consumeActionAuthorization(req) {
        return { outcome: "consumed", actionId: req.actionId };
      },
    };

    const successfulForgePort: ForgeActionPort = {
      isConfigured: () => true,
      boundRepository: () => ({ owner: 'org', repo: 'repo' }),
      async performForgeAction() {
        return {
          outcome: "executed",
          headSha: "1111111111111111111111111111111111111111",
        };
      },
    };

    it("stale assessment with a receipt in the map -> merge refused", async () => {
      const journal = new InMemoryJournal();
      const attemptRepo = new InMemoryAttemptRepo(makeAttemptRecord());
      const workOrderRepo = new InMemoryWorkOrderRepo(makeWorkOrderRecord());

      const acceptanceEvidencePort = new InMemoryAcceptanceEvidencePort({
        outcome: "found",
        assessment: {
          ...validAssessment,
          state: "stale",
        },
      });

      const useCase = new ExecuteAuthorizedForgeActionUseCase({
        mergeRecordRepo: new FakeMergeRecordRepo([]),
        forgeRead: OPEN_READER,
        attemptRepo,
        attemptOwnerDecisionPort: attemptDoorsFrom(attemptRepo),
        workOrderRepo,
        journal,
        authorizationPort: successfulAuthPort,
        forgePort: successfulForgePort,
        acceptedReceiptByHead: {
          "1111111111111111111111111111111111111111": "receipt-001",
        },
        acceptanceEvidencePort,
      });

      const result = await useCase.executeAuthorizedForgeAction(mergeReq);
      expect(result.outcome).toBe("refused");
      expect((result as { reason: string }).reason).toContain("stale");
    });

    it("policy moved -> merge refused", async () => {
      const journal = new InMemoryJournal();
      const attemptRepo = new InMemoryAttemptRepo(makeAttemptRecord());
      const workOrderRepo = new InMemoryWorkOrderRepo(makeWorkOrderRecord()); // has policyRevision: 'pol-1'

      const acceptanceEvidencePort = new InMemoryAcceptanceEvidencePort({
        outcome: "found",
        assessment: {
          ...validAssessment,
          policyRevision: "pol-old-0",
        },
      });

      const useCase = new ExecuteAuthorizedForgeActionUseCase({
        mergeRecordRepo: new FakeMergeRecordRepo([]),
        forgeRead: OPEN_READER,
        attemptRepo,
        attemptOwnerDecisionPort: attemptDoorsFrom(attemptRepo),
        workOrderRepo,
        journal,
        authorizationPort: successfulAuthPort,
        forgePort: successfulForgePort,
        acceptedReceiptByHead: {
          "1111111111111111111111111111111111111111": "receipt-001",
        },
        acceptanceEvidencePort,
      });

      const result = await useCase.executeAuthorizedForgeAction(mergeReq);
      expect(result.outcome).toBe("refused");
      expect((result as { reason: string }).reason).toContain(
        "policy revision",
      );
    });

    it("blocked assessment -> merge refused", async () => {
      const journal = new InMemoryJournal();
      const attemptRepo = new InMemoryAttemptRepo(makeAttemptRecord());
      const workOrderRepo = new InMemoryWorkOrderRepo(makeWorkOrderRecord());

      const acceptanceEvidencePort = new InMemoryAcceptanceEvidencePort({
        outcome: "found",
        assessment: {
          ...validAssessment,
          state: "blocked",
        },
      });

      const useCase = new ExecuteAuthorizedForgeActionUseCase({
        mergeRecordRepo: new FakeMergeRecordRepo([]),
        forgeRead: OPEN_READER,
        attemptRepo,
        attemptOwnerDecisionPort: attemptDoorsFrom(attemptRepo),
        workOrderRepo,
        journal,
        authorizationPort: successfulAuthPort,
        forgePort: successfulForgePort,
        acceptedReceiptByHead: {
          "1111111111111111111111111111111111111111": "receipt-001",
        },
        acceptanceEvidencePort,
      });

      const result = await useCase.executeAuthorizedForgeAction(mergeReq);
      expect(result.outcome).toBe("refused");
      expect((result as { reason: string }).reason).toContain("blocked");
    });

    it("missing assessment in evidence context -> merge refused", async () => {
      const journal = new InMemoryJournal();
      const attemptRepo = new InMemoryAttemptRepo(makeAttemptRecord());
      const workOrderRepo = new InMemoryWorkOrderRepo(makeWorkOrderRecord());

      const acceptanceEvidencePort = new InMemoryAcceptanceEvidencePort({
        outcome: "not-found",
        reason: "no acceptance assessment recorded for the attempt head",
      });

      const useCase = new ExecuteAuthorizedForgeActionUseCase({
        mergeRecordRepo: new FakeMergeRecordRepo([]),
        forgeRead: OPEN_READER,
        attemptRepo,
        attemptOwnerDecisionPort: attemptDoorsFrom(attemptRepo),
        workOrderRepo,
        journal,
        authorizationPort: successfulAuthPort,
        forgePort: successfulForgePort,
        acceptedReceiptByHead: {
          "1111111111111111111111111111111111111111": "receipt-001",
        },
        acceptanceEvidencePort,
      });

      const result = await useCase.executeAuthorizedForgeAction(mergeReq);
      expect(result.outcome).toBe("refused");
      expect((result as { reason: string }).reason).toContain("not found");
    });

    it("assessment head mismatch -> merge refused", async () => {
      const journal = new InMemoryJournal();
      const attemptRepo = new InMemoryAttemptRepo(makeAttemptRecord());
      const workOrderRepo = new InMemoryWorkOrderRepo(makeWorkOrderRecord());

      const acceptanceEvidencePort = new InMemoryAcceptanceEvidencePort({
        outcome: "found",
        assessment: {
          ...validAssessment,
          candidateHeadSha: "2222222222222222222222222222222222222222",
        },
      });

      const useCase = new ExecuteAuthorizedForgeActionUseCase({
        mergeRecordRepo: new FakeMergeRecordRepo([]),
        forgeRead: OPEN_READER,
        attemptRepo,
        attemptOwnerDecisionPort: attemptDoorsFrom(attemptRepo),
        workOrderRepo,
        journal,
        authorizationPort: successfulAuthPort,
        forgePort: successfulForgePort,
        acceptedReceiptByHead: {
          "1111111111111111111111111111111111111111": "receipt-001",
        },
        acceptanceEvidencePort,
      });

      const result = await useCase.executeAuthorizedForgeAction(mergeReq);
      expect(result.outcome).toBe("refused");
      expect((result as { reason: string }).reason).toContain(
        "does not match expectedHeadSha",
      );
    });

    it("null acceptance receipt ID -> merge refused", async () => {
      const journal = new InMemoryJournal();
      const attemptRepo = new InMemoryAttemptRepo(makeAttemptRecord());
      const workOrderRepo = new InMemoryWorkOrderRepo(makeWorkOrderRecord());

      const acceptanceEvidencePort = new InMemoryAcceptanceEvidencePort({
        outcome: "found",
        assessment: {
          ...validAssessment,
          acceptanceReceiptId: null,
        },
      });

      const useCase = new ExecuteAuthorizedForgeActionUseCase({
        mergeRecordRepo: new FakeMergeRecordRepo([]),
        forgeRead: OPEN_READER,
        attemptRepo,
        attemptOwnerDecisionPort: attemptDoorsFrom(attemptRepo),
        workOrderRepo,
        journal,
        authorizationPort: successfulAuthPort,
        forgePort: successfulForgePort,
        acceptedReceiptByHead: {
          "1111111111111111111111111111111111111111": "receipt-001",
        },
        acceptanceEvidencePort,
      });

      const result = await useCase.executeAuthorizedForgeAction(mergeReq);
      expect(result.outcome).toBe("refused");
      expect((result as { reason: string }).reason).toContain("no receipt ID");
    });

    it("an acceptance evidence read that throws -> merge refused, never forged", async () => {
      const journal = new InMemoryJournal();
      const attemptRepo = new InMemoryAttemptRepo(makeAttemptRecord());
      const workOrderRepo = new InMemoryWorkOrderRepo(makeWorkOrderRecord());

      let consumed = false;
      const authorizationPort: ActionAuthorizationPort = {
        async resolveActionAuthorization() {
          return { outcome: "granted", authorizationGrantId: "grant-001" };
        },
        async consumeActionAuthorization() {
          consumed = true;
          return { outcome: "consumed", actionId: "act-1" };
        },
      };

      let forgeCalls = 0;
      const forgePort: ForgeActionPort = {
        isConfigured: () => true,
        boundRepository: () => ({ owner: 'org', repo: 'repo' }),
        async performForgeAction() {
          forgeCalls += 1;
          return {
            outcome: "executed",
            headSha: "1111111111111111111111111111111111111111",
          };
        },
      };

      const acceptanceEvidencePort: AcceptanceEvidencePort = {
        async readAcceptance(): Promise<ReadAcceptanceResult> {
          throw new Error("evidence store is unreadable");
        },
      };

      const useCase = new ExecuteAuthorizedForgeActionUseCase({
        mergeRecordRepo: new FakeMergeRecordRepo([]),
        forgeRead: OPEN_READER,
        attemptRepo,
        attemptOwnerDecisionPort: attemptDoorsFrom(attemptRepo),
        workOrderRepo,
        journal,
        authorizationPort,
        forgePort,
        acceptanceEvidencePort,
      });

      const result = await useCase.executeAuthorizedForgeAction({
        actionId: "act-1",
        attemptId: "att-001",
        workOrderId: "wo-001",
        kind: "merge-pr",
        pullRequestNumber: 7,
        expectedHeadSha: "1111111111111111111111111111111111111111",
        authorizationGrantId: "grant-001",
      });

      expect(result.outcome).toBe("refused");
      expect((result as { reason: string }).reason).toContain(
        "acceptance evidence could not be read: evidence store is unreadable",
      );
      expect(consumed).toBe(false);
      expect(forgeCalls).toBe(0);
      expect(journal.entries).toHaveLength(0);
    });

    it("executes merge when assessment is accepted, head and policy match, and receipt ID exists", async () => {
      const journal = new InMemoryJournal();
      const attemptRepo = new InMemoryAttemptRepo(makeAttemptRecord());
      const workOrderRepo = new InMemoryWorkOrderRepo(makeWorkOrderRecord());

      const acceptanceEvidencePort = new InMemoryAcceptanceEvidencePort({
        outcome: "found",
        assessment: validAssessment,
      });

      const useCase = new ExecuteAuthorizedForgeActionUseCase({
        mergeRecordRepo: new FakeMergeRecordRepo([]),
        forgeRead: OPEN_READER,
        attemptRepo,
        attemptOwnerDecisionPort: attemptDoorsFrom(attemptRepo),
        workOrderRepo,
        journal,
        authorizationPort: successfulAuthPort,
        forgePort: successfulForgePort,
        acceptedReceiptByHead: {
          "1111111111111111111111111111111111111111": "receipt-001",
        },
        acceptanceEvidencePort,
      });

      const result = await useCase.executeAuthorizedForgeAction(mergeReq);
      expect(result.outcome).toBe("executed");
      expect((result as { headSha: string }).headSha).toBe(
        "1111111111111111111111111111111111111111",
      );
      expect(journal.entries).toHaveLength(2); // intent-recorded + completed
    });
  });

  describe("one-way door re-check at forge time", () => {
    const HEAD = "1111111111111111111111111111111111111111";
    const mergeReq = {
      actionId: "forge-att-001",
      attemptId: "att-001",
      workOrderId: "wo-001",
      kind: "merge-pr" as const,
      pullRequestNumber: 7,
      expectedHeadSha: HEAD,
      authorizationGrantId: "grant-001",
    };

    function acceptancePortFound() {
      return new InMemoryAcceptanceEvidencePort({
        outcome: "found",
        assessment: {
          candidateHeadSha: HEAD,
          policyRevision: "pol-1",
          state: "accepted",
          acceptanceReceiptId: "receipt-001",
        },
      });
    }

    function ownerPortWith(
      result:
        | { outcome: "approved"; decisionId: string }
        | { outcome: "not-approved"; reason: string }
        | { outcome: "unknown"; reason: string },
      calls: { resolve: number },
    ): OwnerDecisionPort {
      return {
        async resolveOwnerDecision() {
          calls.resolve++;
          return result;
        },
      };
    }

    function baseDeps(attempt: AttemptRecord, ownerPort?: OwnerDecisionPort) {
      const authPort: ActionAuthorizationPort = {
        async resolveActionAuthorization() {
          return { outcome: "granted", authorizationGrantId: "grant-001" };
        },
        async consumeActionAuthorization(req) {
          return { outcome: "consumed", actionId: req.actionId };
        },
      };
      const forgePort: ForgeActionPort = {
        isConfigured: () => true,
        boundRepository: () => ({ owner: 'org', repo: 'repo' }),
        async performForgeAction() {
          return { outcome: "executed", headSha: HEAD };
        },
      };
      const attemptRepo = new InMemoryAttemptRepo(attempt);
      return {
        attemptRepo,
        workOrderRepo: new InMemoryWorkOrderRepo(makeWorkOrderRecord()),
        journal: new InMemoryJournal(),
        authorizationPort: authPort,
        forgePort,
        mergeRecordRepo: new FakeMergeRecordRepo([]),
        forgeRead: OPEN_READER,
        acceptedReceiptByHead: { [HEAD]: "receipt-001" },
        acceptanceEvidencePort: acceptancePortFound(),
        attemptOwnerDecisionPort: attemptDoorsFrom(attemptRepo),
        ...(ownerPort !== undefined ? { ownerDecisionPort: ownerPort } : {}),
      };
    }

    function attemptWithDoors(
      doors: readonly string[] | undefined,
    ): AttemptRecord {
      const record = makeAttemptRecord();
      if (doors === undefined) {
        // An attempt recorded before the field existed.
        const { ownerDecisionReferences: _omitted, ...rest } = record;
        void _omitted;
        return rest as AttemptRecord;
      }
      return { ...record, ownerDecisionReferences: doors };
    }

    it("journals an ambiguous outcome and rethrows when the forge call throws", async () => {
      const forgeError = new Error("forge subprocess exploded");
      const deps = baseDeps(attemptWithDoors([]));
      const throwingForgePort: ForgeActionPort = {
        isConfigured: () => true,
        boundRepository: () => ({ owner: 'org', repo: 'repo' }),
        async performForgeAction() {
          throw forgeError;
        },
      };
      const useCase = new ExecuteAuthorizedForgeActionUseCase({
        ...deps,
        forgePort: throwingForgePort,
      });
      await expect(useCase.executeAuthorizedForgeAction(mergeReq)).rejects.toBe(
        forgeError,
      );
      const statuses = deps.journal.entries.map((entry) => entry.status);
      expect(statuses).toEqual(["intent-recorded", "ambiguous"]);
      const ambiguous = deps.journal.entries[1]!;
      expect(ambiguous.id).toBe("forge:forge-att-001:ambiguous:2");
      expect(ambiguous.detail).toBe("forge subprocess exploded");
      expect(ambiguous).not.toHaveProperty("authorizedBy");
    });

    it("the ambiguous entry carries authorizedBy when the request names it", async () => {
      const forgeError = new Error("forge subprocess exploded");
      const deps = baseDeps(attemptWithDoors([]));
      const throwingForgePort: ForgeActionPort = {
        isConfigured: () => true,
        boundRepository: () => ({ owner: 'org', repo: 'repo' }),
        async performForgeAction() {
          throw forgeError;
        },
      };
      const useCase = new ExecuteAuthorizedForgeActionUseCase({
        ...deps,
        forgePort: throwingForgePort,
      });
      await expect(
        useCase.executeAuthorizedForgeAction({
          ...mergeReq,
          authorizedBy: "policy:autoMerge@0123456789ab",
        }),
      ).rejects.toBe(forgeError);
      const ambiguous = deps.journal.entries[1]!;
      expect(ambiguous.status).toBe("ambiguous");
      expect(ambiguous.authorizedBy).toBe("policy:autoMerge@0123456789ab");
    });

    it("rethrows the original forge error even when the ambiguous journal append throws", async () => {
      const forgeError = new Error("forge subprocess exploded");
      const deps = baseDeps(attemptWithDoors([]));
      const throwingForgePort: ForgeActionPort = {
        isConfigured: () => true,
        boundRepository: () => ({ owner: 'org', repo: 'repo' }),
        async performForgeAction() {
          throw forgeError;
        },
      };
      const journal = deps.journal as InMemoryJournal;
      const baseAppend = journal.appendJournalEntry.bind(journal);
      journal.appendJournalEntry = async (entry) => {
        if (entry.status === "ambiguous") {
          throw new Error("journal unavailable");
        }
        await baseAppend(entry);
      };
      const useCase = new ExecuteAuthorizedForgeActionUseCase({
        ...deps,
        journal,
        forgePort: throwingForgePort,
      });
      await expect(useCase.executeAuthorizedForgeAction(mergeReq)).rejects.toBe(
        forgeError,
      );
      expect(deps.journal.entries.map((entry) => entry.status)).toEqual([
        "intent-recorded",
      ]);
    });

    it("an approved door does not block the merge", async () => {
      const calls = { resolve: 0 };
      const useCase = new ExecuteAuthorizedForgeActionUseCase(
        baseDeps(
          attemptWithDoors(["req-door-1"]),
          ownerPortWith(
            { outcome: "approved", decisionId: "req-door-1" },
            calls,
          ),
        ),
      );
      const result = await useCase.executeAuthorizedForgeAction(mergeReq);
      expect(result.outcome).toBe("executed");
      expect(calls.resolve).toBe(1);
    });

    it("an undecided or declined door refuses before the grant is consumed", async () => {
      for (const decision of [
        { outcome: "not-approved" as const, reason: "awaiting decision" },
        { outcome: "unknown" as const, reason: "no recorded decision" },
      ]) {
        const calls = { resolve: 0 };
        const consumed: { value: boolean } = { value: false };
        const authPort: ActionAuthorizationPort = {
          async resolveActionAuthorization() {
            return { outcome: "granted", authorizationGrantId: "grant-001" };
          },
          async consumeActionAuthorization(req) {
            consumed.value = true;
            return { outcome: "consumed", actionId: req.actionId };
          },
        };
        const deps = {
          ...baseDeps(
            attemptWithDoors(["req-door-open"]),
            ownerPortWith(decision, calls),
          ),
          authorizationPort: authPort,
        };
        const useCase = new ExecuteAuthorizedForgeActionUseCase(deps);
        const result = await useCase.executeAuthorizedForgeAction(mergeReq);
        expect(result.outcome).toBe("refused");
        expect((result as { reason: string }).reason).toContain(
          `'req-door-open' is ${decision.outcome === "not-approved" ? "not approved" : "unknown"}`,
        );
        expect(consumed.value).toBe(false);
        expect(calls.resolve).toBe(1);
      }
    });

    it("an attempt recorded before doors were frozen refuses without resolving anything", async () => {
      const calls = { resolve: 0 };
      const useCase = new ExecuteAuthorizedForgeActionUseCase(
        baseDeps(
          attemptWithDoors(undefined),
          ownerPortWith({ outcome: "approved", decisionId: "x" }, calls),
        ),
      );
      const result = await useCase.executeAuthorizedForgeAction(mergeReq);
      expect(result.outcome).toBe("refused");
      expect((result as { reason: string }).reason).toContain("are unknown");
      expect(calls.resolve).toBe(0);
    });

    it("recorded doors with no owner decision port refuse", async () => {
      const useCase = new ExecuteAuthorizedForgeActionUseCase(
        baseDeps(attemptWithDoors(["req-door-1"])),
      );
      const result = await useCase.executeAuthorizedForgeAction(mergeReq);
      expect(result.outcome).toBe("refused");
      expect((result as { reason: string }).reason).toContain(
        "no owner decision port is configured",
      );
    });

    it("an empty door list does not require the port and executes", async () => {
      const useCase = new ExecuteAuthorizedForgeActionUseCase(
        baseDeps(attemptWithDoors([])),
      );
      const result = await useCase.executeAuthorizedForgeAction(mergeReq);
      expect(result.outcome).toBe("executed");
    });
  });

  describe("PR title and body forwarding (K6-2)", () => {
    const HEAD = "1111111111111111111111111111111111111111";

    function capturingDeps() {
      const seen: Array<Record<string, unknown>> = [];
      const journal = new InMemoryJournal();
      const attemptRepo = new InMemoryAttemptRepo(makeAttemptRecord());
      const workOrderRepo = new InMemoryWorkOrderRepo(makeWorkOrderRecord());
      const authorizationPort: ActionAuthorizationPort = {
        async resolveActionAuthorization() {
          return { outcome: "granted", authorizationGrantId: "grant-001" };
        },
        async consumeActionAuthorization(req) {
          return { outcome: "consumed", actionId: req.actionId };
        },
      };
      const forgePort: ForgeActionPort = {
        isConfigured: () => true,
        boundRepository: () => ({ owner: 'org', repo: 'repo' }),
        async performForgeAction(
          request: ForgeActionRequest,
        ): Promise<ForgeActionResult> {
          seen.push({ ...request });
          return {
            outcome: "executed",
            pullRequestNumber: 42,
            headSha: request.expectedHeadSha,
          };
        },
      };
      const useCase = new ExecuteAuthorizedForgeActionUseCase({
        mergeRecordRepo: new FakeMergeRecordRepo([]),
        forgeRead: OPEN_READER,
        attemptRepo,
        attemptOwnerDecisionPort: attemptDoorsFrom(attemptRepo),
        workOrderRepo,
        journal,
        authorizationPort,
        forgePort,
        acceptanceEvidencePort: new InMemoryAcceptanceEvidencePort({
          outcome: "found",
          assessment: {
            candidateHeadSha: HEAD,
            policyRevision: "pol-1",
            state: "accepted",
            acceptanceReceiptId: "receipt-001",
          },
        }),
      });
      return { useCase, seen };
    }

    it("forwards title and body to the forge only for push-and-open-pr", async () => {
      const { useCase, seen } = capturingDeps();

      const result = await useCase.executeAuthorizedForgeAction({
        actionId: "act-open",
        attemptId: "att-001",
        workOrderId: "wo-001",
        kind: "push-and-open-pr",
        expectedHeadSha: HEAD,
        authorizationGrantId: "grant-001",
        title: "My PR title",
        body: "My PR body\nwith a second line",
      });

      expect(result.outcome).toBe("executed");
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({
        kind: "push-and-open-pr",
        title: "My PR title",
        body: "My PR body\nwith a second line",
      });
    });

    it("omits title and body for push-to-pr even when the request carries them", async () => {
      const { useCase, seen } = capturingDeps();

      const result = await useCase.executeAuthorizedForgeAction({
        actionId: "act-push",
        attemptId: "att-001",
        workOrderId: "wo-001",
        kind: "push-to-pr",
        expectedHeadSha: HEAD,
        authorizationGrantId: "grant-001",
        title: "should not forward",
        body: "should not forward",
      });

      expect(result.outcome).toBe("executed");
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({ kind: "push-to-pr" });
      expect(seen[0]).not.toHaveProperty("title");
      expect(seen[0]).not.toHaveProperty("body");
    });

    it("omits title and body for merge-pr", async () => {
      const { useCase, seen } = capturingDeps();

      const result = await useCase.executeAuthorizedForgeAction({
        actionId: "act-merge",
        attemptId: "att-001",
        workOrderId: "wo-001",
        kind: "merge-pr",
        pullRequestNumber: 7,
        expectedHeadSha: HEAD,
        authorizationGrantId: "grant-001",
        title: "should not forward",
        body: "should not forward",
      });

      expect(result.outcome).toBe("executed");
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({ kind: "merge-pr" });
      expect(seen[0]).not.toHaveProperty("title");
      expect(seen[0]).not.toHaveProperty("body");
    });

    it("forwards neither title nor body when the push-and-open-pr request omits them", async () => {
      const { useCase, seen } = capturingDeps();

      const result = await useCase.executeAuthorizedForgeAction({
        actionId: "act-open-2",
        attemptId: "att-001",
        workOrderId: "wo-001",
        kind: "push-and-open-pr",
        expectedHeadSha: HEAD,
        authorizationGrantId: "grant-001",
      });

      expect(result.outcome).toBe("executed");
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({ kind: "push-and-open-pr" });
      expect(seen[0]).not.toHaveProperty("title");
      expect(seen[0]).not.toHaveProperty("body");
    });
  });

  describe("recorded branch name on forge requests (KF-5b)", () => {
    const HEAD = "1111111111111111111111111111111111111111";

    function capturingDeps() {
      const seen: Array<Record<string, unknown>> = [];
      const journal = new InMemoryJournal();
      const attemptRepo = new InMemoryAttemptRepo(makeAttemptRecord());
      const workOrderRepo = new InMemoryWorkOrderRepo(makeWorkOrderRecord());
      const authorizationPort: ActionAuthorizationPort = {
        async resolveActionAuthorization() {
          return { outcome: "granted", authorizationGrantId: "grant-001" };
        },
        async consumeActionAuthorization(req) {
          return { outcome: "consumed", actionId: req.actionId };
        },
      };
      const forgePort: ForgeActionPort = {
        isConfigured: () => true,
        boundRepository: () => ({ owner: 'org', repo: 'repo' }),
        async performForgeAction(
          request: ForgeActionRequest,
        ): Promise<ForgeActionResult> {
          seen.push({ ...request });
          return {
            outcome: "executed",
            pullRequestNumber: 42,
            headSha: request.expectedHeadSha,
          };
        },
      };
      const useCase = new ExecuteAuthorizedForgeActionUseCase({
        mergeRecordRepo: new FakeMergeRecordRepo([]),
        forgeRead: OPEN_READER,
        attemptRepo,
        attemptOwnerDecisionPort: attemptDoorsFrom(attemptRepo),
        workOrderRepo,
        journal,
        authorizationPort,
        forgePort,
        acceptanceEvidencePort: new InMemoryAcceptanceEvidencePort({
          outcome: "found",
          assessment: {
            candidateHeadSha: HEAD,
            policyRevision: "pol-1",
            state: "accepted",
            acceptanceReceiptId: "receipt-001",
          },
        }),
      });
      return { useCase, seen, journal };
    }

    it("defaults to feat/<laneId> when the request carries no branch name", async () => {
      const { useCase, seen } = capturingDeps();

      const result = await useCase.executeAuthorizedForgeAction({
        actionId: "act-open",
        attemptId: "att-001",
        workOrderId: "wo-001",
        kind: "push-and-open-pr",
        expectedHeadSha: HEAD,
        authorizationGrantId: "grant-001",
      });

      expect(result.outcome).toBe("executed");
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({
        kind: "push-and-open-pr",
        branchName: "feat/lane-auth",
      });
    });

    it("forwards the run's recorded branch when the request carries one", async () => {
      const { useCase, seen } = capturingDeps();

      const result = await useCase.executeAuthorizedForgeAction({
        actionId: "act-open",
        attemptId: "att-001",
        workOrderId: "wo-001",
        kind: "push-and-open-pr",
        expectedHeadSha: HEAD,
        authorizationGrantId: "grant-001",
        branchName: "fleet/run-01JB0000000000000000000000",
      });

      expect(result.outcome).toBe("executed");
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({
        branchName: "fleet/run-01JB0000000000000000000000",
      });
    });

    it("forwards the PR base branch for push-and-open-pr (CB-D2)", async () => {
      const { useCase, seen } = capturingDeps();

      const result = await useCase.executeAuthorizedForgeAction({
        actionId: "act-open",
        attemptId: "att-001",
        workOrderId: "wo-001",
        kind: "push-and-open-pr",
        expectedHeadSha: HEAD,
        authorizationGrantId: "grant-001",
        branchName: "fleet/run-01JB0000000000000000000000",
        baseBranch: "chain/example",
      });

      expect(result.outcome).toBe("executed");
      expect(seen).toHaveLength(1);
      expect(seen[0]?.baseBranch).toBe("chain/example");
    });

    it("does not forward baseBranch for merge-pr (CB-D2)", async () => {
      const { useCase, seen } = capturingDeps();

      const result = await useCase.executeAuthorizedForgeAction({
        actionId: "act-merge",
        attemptId: "att-001",
        workOrderId: "wo-001",
        kind: "merge-pr",
        pullRequestNumber: 7,
        expectedHeadSha: HEAD,
        authorizationGrantId: "grant-001",
        baseBranch: "chain/example",
      });

      expect(result.outcome).toBe("executed");
      expect(seen).toHaveLength(1);
      expect(seen[0]).not.toHaveProperty("baseBranch");
    });

    it("refuses an unparsable base branch for push-and-open-pr before any grant is consumed (CB-D2)", async () => {
      for (const baseBranch of [
        "release",
        "main ",
        "chain/example/",
        "chain/a--b",
        42,
      ] as unknown as string[]) {
        const journal = new InMemoryJournal();
        const attemptRepo = new InMemoryAttemptRepo(makeAttemptRecord());
        const workOrderRepo = new InMemoryWorkOrderRepo(makeWorkOrderRecord());
        let consumed = false;
        let forgeCalls = 0;
        const authorizationPort: ActionAuthorizationPort = {
          async resolveActionAuthorization() {
            return { outcome: "granted", authorizationGrantId: "grant-001" };
          },
          async consumeActionAuthorization(req) {
            consumed = true;
            return { outcome: "consumed", actionId: req.actionId };
          },
        };
        const forgePort: ForgeActionPort = {
          isConfigured: () => true,
          boundRepository: () => ({ owner: 'org', repo: 'repo' }),
          async performForgeAction(): Promise<ForgeActionResult> {
            forgeCalls += 1;
            return { outcome: "executed", headSha: HEAD };
          },
        };
        const useCase = new ExecuteAuthorizedForgeActionUseCase({
          mergeRecordRepo: new FakeMergeRecordRepo([]),
          forgeRead: OPEN_READER,
          attemptRepo,
          attemptOwnerDecisionPort: attemptDoorsFrom(attemptRepo),
          workOrderRepo,
          journal,
          authorizationPort,
          forgePort,
          acceptanceEvidencePort: new InMemoryAcceptanceEvidencePort({
            outcome: "found",
            assessment: {
              candidateHeadSha: HEAD,
              policyRevision: "pol-1",
              state: "accepted",
              acceptanceReceiptId: "receipt-001",
            },
          }),
        });

        const result = await useCase.executeAuthorizedForgeAction({
          actionId: "act-1",
          attemptId: "att-001",
          workOrderId: "wo-001",
          kind: "push-and-open-pr",
          expectedHeadSha: HEAD,
          authorizationGrantId: "grant-001",
          baseBranch,
        });

        expect(result).toEqual({
          outcome: "refused",
          reason: "baseBranch must be main or chain/<lowercase-dashes>",
        });
        expect(consumed).toBe(false);
        expect(forgeCalls).toBe(0);
      }
    });

    it("refuses an unsafe branch name before any grant is consumed or forge call runs", async () => {
      for (const branchName of [
        "bad branch",
        "12345",
        "a..b",
        null,
        ["fleet/x"],
        42,
      ] as unknown as string[]) {
        const journal = new InMemoryJournal();
        const attemptRepo = new InMemoryAttemptRepo(makeAttemptRecord());
        const workOrderRepo = new InMemoryWorkOrderRepo(makeWorkOrderRecord());
        let consumed = false;
        let forgeCalls = 0;
        const authorizationPort: ActionAuthorizationPort = {
          async resolveActionAuthorization() {
            return { outcome: "granted", authorizationGrantId: "grant-001" };
          },
          async consumeActionAuthorization(req) {
            consumed = true;
            return { outcome: "consumed", actionId: req.actionId };
          },
        };
        const forgePort: ForgeActionPort = {
          isConfigured: () => true,
          boundRepository: () => ({ owner: 'org', repo: 'repo' }),
          async performForgeAction(): Promise<ForgeActionResult> {
            forgeCalls += 1;
            return { outcome: "executed", headSha: HEAD };
          },
        };
        const useCase = new ExecuteAuthorizedForgeActionUseCase({
          mergeRecordRepo: new FakeMergeRecordRepo([]),
          forgeRead: OPEN_READER,
          attemptRepo,
          attemptOwnerDecisionPort: attemptDoorsFrom(attemptRepo),
          workOrderRepo,
          journal,
          authorizationPort,
          forgePort,
          acceptanceEvidencePort: new InMemoryAcceptanceEvidencePort({
            outcome: "found",
            assessment: {
              candidateHeadSha: HEAD,
              policyRevision: "pol-1",
              state: "accepted",
              acceptanceReceiptId: "receipt-001",
            },
          }),
        });

        const result = await useCase.executeAuthorizedForgeAction({
          actionId: "act-1",
          attemptId: "att-001",
          workOrderId: "wo-001",
          kind: "merge-pr",
          pullRequestNumber: 7,
          expectedHeadSha: HEAD,
          authorizationGrantId: "grant-001",
          branchName,
        });

        expect(result).toEqual({
          outcome: "refused",
          reason: "branchName must be a safe branch name",
        });
        expect(consumed).toBe(false);
        expect(forgeCalls).toBe(0);
        expect(journal.entries).toHaveLength(0);
      }
    });
  });
});

describe("ExecuteAuthorizedForgeActionUseCase WB5b: merge-record and PR-link producers", () => {
  const WB_HEAD = "1111111111111111111111111111111111111111";
  const WB_OTHER_HEAD = "2222222222222222222222222222222222222222";

  const mergeReq = {
    actionId: "act-1",
    attemptId: "att-001",
    workOrderId: "wo-001",
    kind: "merge-pr" as const,
    expectedHeadSha: WB_HEAD,
    authorizationGrantId: "grant-001",
  };

  function acceptedAssessment() {
    return new InMemoryAcceptanceEvidencePort({
      outcome: "found",
      assessment: {
        candidateHeadSha: WB_HEAD,
        policyRevision: "pol-1",
        state: "accepted",
        acceptanceReceiptId: "receipt-001",
      },
    });
  }

  class FakeLanePlanRepo implements LanePlanRepositoryPort {
    readonly calls: string[];
    private readonly plans = new Map<string, LanePlanRecord>();
    private readonly links = new Map<string, PullRequestLinkRecord>();
    private readonly conflicts = new Map<
      string,
      PullRequestLinkConflictRecord
    >();

    constructor(order: string[]) {
      this.calls = order;
    }

    async saveLanePlan(record: LanePlanRecord): Promise<void> {
      this.plans.set(`${record.projectId}:${record.planId}`, record);
    }

    async saveLanePlanIfAcyclic(
      record: LanePlanRecord,
    ): Promise<SaveLanePlanResult> {
      await this.saveLanePlan(record);
      return { outcome: "saved" };
    }

    async findLanePlan(
      projectId: string,
      planId: string,
    ): Promise<LanePlanRecord | null> {
      return this.plans.get(`${projectId}:${planId}`) ?? null;
    }

    async listLanePlans(): Promise<readonly LanePlanRecord[]> {
      return [...this.plans.values()];
    }

    async savePullRequestLink(
      record: PullRequestLinkRecord,
    ): Promise<SavePullRequestLinkResult> {
      this.calls.push(
        `link:${record.repository}#${record.number}:${record.laneId}`,
      );
      const key = pullRequestLinkKey({
        repository: record.repository,
        number: record.number,
      });
      const existing = this.links.get(key) ?? null;
      const decision = decidePullRequestLink(existing, record);
      if (decision === "create") {
        this.links.set(key, record);
        return { outcome: "saved", link: record };
      }
      if (decision === "no-op") {
        return {
          outcome: "unchanged",
          link: existing as PullRequestLinkRecord,
        };
      }
      return {
        outcome: "refused",
        code: "pr-already-linked",
        linkedLaneId: existing!.laneId,
      };
    }

    async findPullRequestLink(
      repository: string,
      number: number,
    ): Promise<PullRequestLinkRecord | null> {
      return this.links.get(pullRequestLinkKey({ repository, number })) ?? null;
    }

    async listPullRequestLinks(): Promise<readonly PullRequestLinkRecord[]> {
      return [...this.links.values()];
    }

    async savePullRequestLinkConflict(
      record: PullRequestLinkConflictRecord,
    ): Promise<SavePullRequestLinkConflictResult> {
      const key = pullRequestLinkConflictKey(record);
      const existing = this.conflicts.get(key);
      if (existing !== undefined) {
        return { outcome: "unchanged", conflict: existing };
      }
      this.conflicts.set(key, record);
      return { outcome: "saved", conflict: record };
    }

    async listPullRequestLinkConflicts(): Promise<
      readonly PullRequestLinkConflictRecord[]
    > {
      return [...this.conflicts.values()];
    }
  }

  function orderedJournal(
    base: InMemoryJournal,
    order: string[],
  ): ExecutionJournalPort {
    return {
      appendJournalEntry: async (entry) => {
        order.push(`journal:${entry.status}:${entry.id}`);
        await base.appendJournalEntry(entry);
      },
      listJournalEntriesForAttempt: (attemptId) =>
        base.listJournalEntriesForAttempt(attemptId),
      saveCapacityReservation: async () => {},
      listActiveReservations: async () => [],
      releaseCapacityReservation: async () => false,
      reserveCapacityAtomically: async (request) => ({
        outcome: "reserved" as const,
        reservation: { ...request.record!, slotIndex: 0 },
      }),
    };
  }

  const WB_BRANCH = "feat/lane-auth";

  function snapshot(
    number: number,
    overrides: Partial<PullRequestSnapshot> = {},
  ): PullRequestSnapshot {
    return {
      number,
      state: "open",
      mergeState: "clean",
      headSha: WB_HEAD,
      headRef: WB_BRANCH,
      isCrossRepository: false,
      headRepositoryOwner: 'org',
      baseRef: "main",
      mergedAtIso: null,
      closedAtIso: null,
      mergeCommitSha: null,
      ...overrides,
    };
  }

  /** Any number the use case asks about is open on the attempt's branch at the expected head. */
  async function openAtExpectedHead(
    request: ReadPullRequestRequest,
  ): Promise<ReadPullRequestResult> {
    return {
      outcome: "found",
      pullRequest: snapshot(request.ref.kind === "number" ? request.ref.number : 0, {
        headRepositoryOwner: request.repository?.owner ?? "org",
      }),
    };
  }

  function typedCompletedEntry(number: number): ActionJournalEntryRecord {
    return {
      id: "forge:act-open:completed:2",
      attemptId: "att-001",
      workOrderId: "wo-001",
      action: "forge",
      status: "completed",
      baseCommit: "b".repeat(40),
      recordedAtIso: "2026-11-01T00:00:00.000Z",
      sessionId: null,
      detail: null,
      pullRequest: { repository: "org/repo", number },
    };
  }

  function storedLink(number: number): PullRequestLinkRecord {
    return {
      version: 1,
      repository: "org/repo",
      number,
      projectId: "proj-001",
      planId: null,
      laneId: "lane-auth",
      source: "fleet-forge-action",
      linkedAtIso: "2026-11-05T10:00:00.000Z",
    };
  }

  function wb5bDeps(
    options: {
      workOrder?: WorkOrderRecord;
      forge?: (request: ForgeActionRequest) => ForgeActionResult;
      now?: () => string;
      lookup?: () => Promise<OpenPullRequestsByHeadResult>;
      /** The pull-request read (WB5b2); `"none"` wires no reader. Default: any number is open at the expected head. */
      read?:
        | ((request: ReadPullRequestRequest) => Promise<ReadPullRequestResult>)
        | "none";
      /** Overrides the merge-record store's answer to `saveMergeRecord` (WB5b2). */
      saveOutcome?: MergeRecordSaveOutcome;
      /** The first N `saveMergeRecord` calls throw (a disk or lock failure). */
      failSaves?: number;
      /** The repository the forge port is bound to (WB5b2); `"unbound"` binds none. Default org/repo. */
      bound?: { owner: string; repo: string } | "unbound";
    } = {},
  ) {
    const order: string[] = [];
    const reads: ReadPullRequestRequest[] = [];
    const consumed: string[] = [];
    const lookups: { repository: string; branchName: string }[] = [];
    const journalBase = new InMemoryJournal();
    const attemptRepo = new InMemoryAttemptRepo(makeAttemptRecord());
    const workOrderRepo = new InMemoryWorkOrderRepo(
      options.workOrder ?? makeWorkOrderRecord(),
    );
    const lanePlanRepo = new FakeLanePlanRepo(order);
    const mergeRecordRepo = new FakeMergeRecordRepo(order);
    let failuresLeft = options.failSaves ?? 0;
    const mergeStore: MergeRecordRepositoryPort =
      options.saveOutcome === undefined && options.failSaves === undefined
        ? mergeRecordRepo
        : {
            saveMergeRecord: async (record) => {
              if (failuresLeft > 0) {
                failuresLeft -= 1;
                throw new Error("disk full");
              }
              return options.saveOutcome === undefined
                ? mergeRecordRepo.saveMergeRecord(record)
                : options.saveOutcome;
            },
            findMergeRecord: (repository, number) =>
              mergeRecordRepo.findMergeRecord(repository, number),
            listMergeRecords: () => mergeRecordRepo.listMergeRecords(),
          };
    const readOverride = options.read === "none" ? undefined : options.read;
    const readPullRequest =
      options.read === "none"
        ? undefined
        : async (request: ReadPullRequestRequest) => {
            reads.push(request);
            return (readOverride ?? openAtExpectedHead)(request);
          };
    const seen: ForgeActionRequest[] = [];
    const forgePort: ForgeActionPort = {
      isConfigured: () => true,
      boundRepository: () =>
        options.bound === "unbound"
          ? undefined
          : (options.bound ?? { owner: "org", repo: "repo" }),
      ...(options.lookup !== undefined
        ? {
            async findOpenPullRequestsByHead(query) {
              lookups.push({ ...query });
              return (
                options.lookup as () => Promise<OpenPullRequestsByHeadResult>
              )();
            },
          }
        : {}),
      async performForgeAction(request) {
        seen.push(request);
        return options.forge
          ? options.forge(request)
          : { outcome: "executed", headSha: request.expectedHeadSha };
      },
    };
    const authorizationPort: ActionAuthorizationPort = {
      async resolveActionAuthorization() {
        return { outcome: "granted", authorizationGrantId: "grant-001" };
      },
      async consumeActionAuthorization(req) {
        consumed.push(req.actionId);
        return { outcome: "consumed", actionId: req.actionId };
      },
    };
    const useCase = new ExecuteAuthorizedForgeActionUseCase({
      attemptRepo,
      attemptOwnerDecisionPort: attemptDoorsFrom(attemptRepo),
      workOrderRepo,
      journal: orderedJournal(journalBase, order),
      authorizationPort,
      forgePort,
      acceptedReceiptByHead: { [WB_HEAD]: "receipt-001" },
      acceptanceEvidencePort: acceptedAssessment(),
      lanePlanRepo,
      mergeRecordRepo: mergeStore,
      ...(readPullRequest !== undefined
        ? { forgeRead: { readPullRequest } }
        : {}),
      ...(options.now ? { now: options.now } : {}),
    });
    return {
      consumed,
      reads,
      lookups,
      useCase,
      journal: journalBase,
      order,
      lanePlanRepo,
      mergeRecordRepo,
      seen,
      workOrderRepo,
    };
  }

  it("appends the completed journal entry first and saves the merge record with its id as actionRef", async () => {
    const now = (): string => "2026-11-05T10:00:00Z";
    const deps = wb5bDeps({ now });
    const result = await deps.useCase.executeAuthorizedForgeAction({
      ...mergeReq,
      pullRequestNumber: 7,
    });
    expect(result.outcome).toBe("executed");

    const completed = deps.journal.entries.find(
      (entry) => entry.status === "completed",
    )!;
    expect(completed.id).toBe("forge:act-1:completed:2");
    expect(completed.detail).toBeNull();
    expect(completed.pullRequest).toEqual({
      repository: "org/repo",
      number: 7,
    });

    // Call order: the completed journal entry lands before the link and the
    // merge record; the merge record carries the completed entry's id.
    expect(deps.order).toEqual([
      "journal:intent-recorded:forge:act-1:intent-recorded:1",
      "journal:completed:forge:act-1:completed:2",
      "link:org/repo#7:lane-auth",
      "merge:org/repo#7:forge:act-1:completed:2:fleet:created",
    ]);

    const stored = await deps.mergeRecordRepo.findMergeRecord("org/repo", 7);
    expect(stored).toEqual({
      schemaVersion: 1,
      repository: "org/repo",
      number: 7,
      headSha: WB_HEAD,
      mergedAtIso: "2026-11-05T10:00:00.000Z",
      firstSeenAtIso: "2026-11-05T10:00:00.000Z",
      source: "fleet-forge-action",
      merger: "fleet",
      actionRef: completed.id,
    });

    const link = await deps.lanePlanRepo.findPullRequestLink("org/repo", 7);
    expect(link).toEqual({
      version: 1,
      repository: "org/repo",
      number: 7,
      projectId: "proj-001",
      planId: null,
      laneId: "lane-auth",
      source: "fleet-forge-action",
      linkedAtIso: "2026-11-05T10:00:00.000Z",
    });

    expect((await deps.workOrderRepo.findWorkOrderById("wo-001"))?.state).toBe(
      "merged",
    );
  });

  it("links the plan lane through an imported alias when the work order has a planRef", async () => {
    const plan: LanePlanRecord = {
      version: 1,
      projectId: "proj-001",
      planId: "plan-1",
      revision: 1,
      digest: "a".repeat(64),
      doc: "docs/plan.md",
      lanes: [
        {
          laneId: "lane-A",
          aliases: ["lane-auth"],
          scope: "auth lane",
          packages: ["work-execution"],
          sharedFiles: [],
          tier: 0,
          after: [],
          decisions: [],
          status: "planned",
          brief: null,
          mergedPr: null,
        },
      ],
      decisions: [],
      exclusiveOrder: [],
      importedAtIso: "2026-11-01T00:00:00.000Z",
    };
    const deps = wb5bDeps({
      workOrder: {
        ...makeWorkOrderRecord(),
        planRef: {
          projectId: "proj-001",
          planId: "plan-1",
          laneId: "lane-auth",
        },
      },
    });
    await deps.lanePlanRepo.saveLanePlan(plan);
    await deps.useCase.executeAuthorizedForgeAction({
      ...mergeReq,
      pullRequestNumber: 7,
    });
    const link = await deps.lanePlanRepo.findPullRequestLink("org/repo", 7);
    expect(link).toMatchObject({
      projectId: "proj-001",
      planId: "plan-1",
      laneId: "lane-A",
    });
  });

  it("writes neither PullRequestLink nor MergeRecord when appending the completed journal entry fails, leaving recoverable intent-recorded state", async () => {
    const deps = wb5bDeps();
    const base = deps.journal;
    const originalAppend = base.appendJournalEntry.bind(base);
    base.appendJournalEntry = async (entry) => {
      if (entry.status === "completed") {
        throw new Error("journal unavailable");
      }
      await originalAppend(entry);
    };

    await expect(
      deps.useCase.executeAuthorizedForgeAction({
        ...mergeReq,
        pullRequestNumber: 7,
      }),
    ).rejects.toThrow("journal unavailable");
    expect(deps.journal.entries.map((entry) => entry.status)).toEqual([
      "intent-recorded",
    ]);
    expect(await deps.lanePlanRepo.listPullRequestLinks()).toEqual([]);
    expect(await deps.mergeRecordRepo.listMergeRecords()).toEqual([]);
    expect((await deps.workOrderRepo.findWorkOrderById("wo-001"))?.state).toBe(
      "approved",
    );
  });

  function twoLanePlan(): LanePlanRecord {
    const lane = (laneId: string, aliases: string[]) => ({
      laneId,
      aliases,
      scope: "a lane",
      packages: ["work-execution"],
      sharedFiles: [],
      tier: 0 as const,
      after: [],
      decisions: [],
      status: "planned" as const,
      brief: null,
      mergedPr: null,
    });
    return {
      version: 1,
      projectId: "proj-001",
      planId: "plan-1",
      revision: 1,
      digest: "a".repeat(64),
      doc: "docs/plan.md",
      lanes: [lane("lane-A", ["lane-auth"]), lane("lane-B", [])],
      decisions: [],
      exclusiveOrder: [],
      importedAtIso: "2026-11-01T00:00:00.000Z",
    } as LanePlanRecord;
  }

  const planWorkOrder = (): WorkOrderRecord => ({
    ...makeWorkOrderRecord(),
    planRef: { projectId: "proj-001", planId: "plan-1", laneId: "lane-auth" },
  });

  const prLink = (number: number, laneId: string) => ({
    version: 1 as const,
    repository: "org/repo",
    number,
    projectId: "proj-001",
    planId: "plan-1",
    laneId,
    source: "cli" as const,
    linkedAtIso: "2026-11-01T00:00:00.000Z",
  });

  it("records a conflict when the PR is linked to a different lane of the same plan, and none for a confirmed alias of the same lane", async () => {
    const different = wb5bDeps({ workOrder: planWorkOrder() });
    await different.lanePlanRepo.saveLanePlan(twoLanePlan());
    await different.lanePlanRepo.savePullRequestLink(prLink(7, "lane-B"));
    await different.useCase.executeAuthorizedForgeAction({
      ...mergeReq,
      pullRequestNumber: 7,
    });
    const conflicts =
      await different.lanePlanRepo.listPullRequestLinkConflicts!();
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({
      linkedLane: { projectId: "proj-001", planId: "plan-1", laneId: "lane-B" },
      refusedLane: {
        projectId: "proj-001",
        planId: "plan-1",
        laneId: "lane-A",
      },
    });
    expect(
      await different.mergeRecordRepo.findMergeRecord("org/repo", 7),
    ).not.toBeNull();

    const alias = wb5bDeps({ workOrder: planWorkOrder() });
    await alias.lanePlanRepo.saveLanePlan(twoLanePlan());
    await alias.lanePlanRepo.savePullRequestLink(prLink(8, "lane-auth"));
    await alias.useCase.executeAuthorizedForgeAction({
      ...mergeReq,
      pullRequestNumber: 8,
    });
    expect(
      await alias.lanePlanRepo.listPullRequestLinkConflicts!(),
    ).toHaveLength(0);
  });

  it("resolves an old lane alias against the stored link on a different attempt with no journal reference, and refuses a merge whose PR number cannot be resolved without calling the forge", async () => {
    const deps = wb5bDeps({ workOrder: planWorkOrder() });
    await deps.lanePlanRepo.saveLanePlan(twoLanePlan());
    // The link was stored under the plan's current lane id by another attempt;
    // this attempt has no typed journal entry and the work order carries the alias.
    await deps.lanePlanRepo.savePullRequestLink(prLink(9, "lane-A"));
    const merged = await deps.useCase.executeAuthorizedForgeAction(mergeReq);
    expect(merged.outcome).toBe("executed");
    expect(deps.seen[0]?.pullRequestNumber).toBe(9);
    expect(
      await deps.mergeRecordRepo.findMergeRecord("org/repo", 9),
    ).toMatchObject({ merger: "fleet" });

    const none = wb5bDeps({ workOrder: planWorkOrder() });
    await none.lanePlanRepo.saveLanePlan(twoLanePlan());
    const refused = await none.useCase.executeAuthorizedForgeAction(mergeReq);
    expect(refused.outcome).toBe("refused");
    expect(none.seen).toHaveLength(0);
    expect(
      none.journal.entries.filter((entry) => entry.status === "completed"),
    ).toHaveLength(0);
  });

  it("resolves the PR number across steps without parsing detail: a second-attempt merge reads the typed journal entry", async () => {
    const deps = wb5bDeps({
      forge: (request) =>
        request.kind === "push-and-open-pr"
          ? {
              outcome: "executed",
              pullRequestNumber: 42,
              headSha: request.expectedHeadSha,
            }
          : { outcome: "executed", headSha: request.expectedHeadSha },
      now: (): string => "2026-11-05T10:00:00Z",
    });

    const opened = await deps.useCase.executeAuthorizedForgeAction({
      actionId: "act-open",
      attemptId: "att-001",
      workOrderId: "wo-001",
      kind: "push-and-open-pr",
      expectedHeadSha: WB_HEAD,
      authorizationGrantId: "grant-001",
    });
    expect(opened.outcome).toBe("executed");

    const openedCompleted = deps.journal.entries.find(
      (entry) =>
        entry.status === "completed" && entry.id.startsWith("forge:act-open"),
    )!;
    expect(openedCompleted.detail).toBe("pull request #42");
    expect(openedCompleted.pullRequest).toEqual({
      repository: "org/repo",
      number: 42,
    });
    expect(
      await deps.lanePlanRepo.findPullRequestLink("org/repo", 42),
    ).not.toBeNull();

    const merged = await deps.useCase.executeAuthorizedForgeAction({
      actionId: "act-merge",
      attemptId: "att-001",
      workOrderId: "wo-001",
      kind: "merge-pr",
      expectedHeadSha: WB_HEAD,
      authorizationGrantId: "grant-002",
    });
    expect(merged).toMatchObject({ outcome: "executed" });

    const mergeCompleted = deps.journal.entries.find(
      (entry) =>
        entry.status === "completed" && entry.id.startsWith("forge:act-merge"),
    )!;
    expect(mergeCompleted.detail).toBeNull();
    expect(mergeCompleted.pullRequest).toEqual({
      repository: "org/repo",
      number: 42,
    });

    const stored = await deps.mergeRecordRepo.findMergeRecord("org/repo", 42);
    expect(stored).toMatchObject({
      repository: "org/repo",
      number: 42,
      headSha: WB_HEAD,
      source: "fleet-forge-action",
      merger: "fleet",
      actionRef: "forge:act-merge:completed:4",
    });
  });

  it("persists a link conflict naming both lanes when the PR is already linked, and still saves the MergeRecord", async () => {
    const deps = wb5bDeps();
    await deps.lanePlanRepo.savePullRequestLink({
      version: 1,
      repository: "org/repo",
      number: 7,
      projectId: "proj-1",
      planId: null,
      laneId: "L1",
      source: "cli",
      linkedAtIso: "2026-11-01T00:00:00.000Z",
    });

    const result = await deps.useCase.executeAuthorizedForgeAction({
      ...mergeReq,
      pullRequestNumber: 7,
    });
    expect(result.outcome).toBe("executed");

    const conflicts = await deps.lanePlanRepo.listPullRequestLinkConflicts!();
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({
      schemaVersion: 1,
      repository: "org/repo",
      number: 7,
      linkedLane: { projectId: "proj-1", planId: null, laneId: "L1" },
      refusedLane: { projectId: "proj-001", planId: null, laneId: "lane-auth" },
    });

    const stored = await deps.mergeRecordRepo.findMergeRecord("org/repo", 7);
    expect(stored).toMatchObject({
      source: "fleet-forge-action",
      merger: "fleet",
    });
    expect(stored?.actionRef).toBe("forge:act-1:completed:2");
  });

  it("both arrival orders against forge-observation converge on one fleet MergeRecord with actionRef and without duplicate writes", async () => {
    // Order 1: the forge observation is stored first, the merge upgrades it.
    const deps = wb5bDeps({ now: (): string => "2026-11-05T10:00:00Z" });
    await deps.mergeRecordRepo.saveMergeRecord({
      schemaVersion: 1,
      repository: "org/repo",
      number: 7,
      headSha: WB_HEAD,
      // The observation's merge instant matches the merge the use case will
      // record, so the later fleet sighting upgrades rather than conflicts.
      mergedAtIso: "2026-11-05T10:00:00.000Z",
      firstSeenAtIso: "2026-11-04T00:00:00.000Z",
      source: "forge-observation",
      merger: "unknown",
    });
    const result = await deps.useCase.executeAuthorizedForgeAction({
      ...mergeReq,
      pullRequestNumber: 7,
    });
    expect(result.outcome).toBe("executed");
    await expect(deps.mergeRecordRepo.listMergeRecords()).resolves.toHaveLength(1);
    const upgraded = await deps.mergeRecordRepo.findMergeRecord("org/repo", 7);
    expect(upgraded).toMatchObject({
      merger: "fleet",
      source: "forge-observation",
      firstSeenAtIso: "2026-11-04T00:00:00.000Z",
      actionRef: "forge:act-1:completed:2",
    });

    // Order 2: the fleet merge is stored first, a later observation is a no-op.
    const deps2 = wb5bDeps({ now: (): string => "2026-11-05T10:00:00Z" });
    await deps2.useCase.executeAuthorizedForgeAction({
      ...mergeReq,
      pullRequestNumber: 7,
    });
    const observation = await deps2.mergeRecordRepo.saveMergeRecord({
      schemaVersion: 1,
      repository: "org/repo",
      number: 7,
      headSha: WB_HEAD,
      mergedAtIso: "2026-11-05T10:00:00.000Z",
      firstSeenAtIso: "2026-11-06T00:00:00.000Z",
      source: "forge-observation",
      merger: "unknown",
    });
    expect(observation.outcome).toBe("unchanged");
    expect(
      await deps2.mergeRecordRepo.findMergeRecord("org/repo", 7),
    ).toMatchObject({
      merger: "fleet",
      source: "fleet-forge-action",
      actionRef: "forge:act-1:completed:2",
    });
    expect(await deps2.mergeRecordRepo.listMergeRecords()).toHaveLength(1);

    // Order 3: a divergent headSha is an integrity finding, never an overwrite.
    const deps3 = wb5bDeps({ now: (): string => "2026-11-05T10:00:00Z" });
    await deps3.mergeRecordRepo.saveMergeRecord({
      schemaVersion: 1,
      repository: "org/repo",
      number: 7,
      headSha: WB_OTHER_HEAD,
      mergedAtIso: "2026-11-04T00:00:00.000Z",
      firstSeenAtIso: "2026-11-04T00:00:00.000Z",
      source: "forge-observation",
      merger: "unknown",
    });
    await deps3.useCase.executeAuthorizedForgeAction({
      ...mergeReq,
      pullRequestNumber: 7,
    });
    // First call: the test's own observation save; second: the use case's
    // fleet sighting, decided as an integrity conflict against the stored one.
    const calls = deps3.mergeRecordRepo.calls.filter((call) =>
      call.includes("merge:org/repo#7"),
    );
    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain("integrity-conflict");
    const stillStored = await deps3.mergeRecordRepo.findMergeRecord(
      "org/repo",
      7,
    );
    expect(stillStored).toMatchObject({
      headSha: WB_OTHER_HEAD,
      merger: "unknown",
      source: "forge-observation",
    });
  });

  it("refuses null, non-object, sparse-array, wrong-typed, unknown-enum, and throwing-getter requests without throwing", async () => {
    const deps = wb5bDeps();
    const sparse = new Array(3) as unknown as Record<string, unknown>;
    sparse.actionId = "act-1";
    const throwingGetter = Object.defineProperty({ ...mergeReq }, "actionId", {
      configurable: true,
      enumerable: true,
      get() {
        throw new Error("boom");
      },
    });
    const cases: unknown[] = [
      null,
      "merge it",
      42,
      sparse,
      { ...mergeReq, kind: "explode" },
      { ...mergeReq, expectedHeadSha: "NOT-A-SHA" },
      { ...mergeReq, authorizationGrantId: "" },
      throwingGetter,
    ];
    for (const input of cases) {
      const result = await deps.useCase.executeAuthorizedForgeAction(
        input as never,
      );
      expect(result.outcome).toBe("refused");
    }
    expect(deps.journal.entries).toHaveLength(0);
    expect(await deps.mergeRecordRepo.listMergeRecords()).toEqual([]);
    expect(await deps.lanePlanRepo.listPullRequestLinks()).toEqual([]);
  });

  it("refuses secret-shaped and path-containing inputs with code/field messages that never echo the offending value or path", async () => {
    const deps = wb5bDeps();
    const secret = ["gh", "p_"].join("") + "x".repeat(36);
    for (const [field, value] of [
      ["actionId", secret],
      ["workOrderId", "sub/dir/id"],
      ["authorizationGrantId", "grant\\id"],
    ] as const) {
      const result = await deps.useCase.executeAuthorizedForgeAction({
        ...mergeReq,
        [field]: value,
      } as never);
      expect(result.outcome).toBe("refused");
      if (result.outcome === "refused") {
        expect(result.reason).toContain(field);
        expect(JSON.stringify(result)).not.toContain(secret);
        expect(JSON.stringify(result)).not.toContain(value);
      }
    }
  });

  it("refuses oversized request identifiers, out-of-range pullRequestNumber, and overlong actionRef/repository inputs", async () => {
    const deps = wb5bDeps();
    for (const field of [
      "actionId",
      "attemptId",
      "workOrderId",
      "authorizationGrantId",
    ] as const) {
      const result = await deps.useCase.executeAuthorizedForgeAction({
        ...mergeReq,
        [field]: "a".repeat(257),
      } as never);
      expect(result.outcome).toBe("refused");
    }
    for (const pullRequestNumber of [0, 1_000_000_000, 1.5]) {
      const result = await deps.useCase.executeAuthorizedForgeAction({
        ...mergeReq,
        pullRequestNumber,
      } as never);
      expect(result).toEqual({
        outcome: "refused",
        reason: "pullRequestNumber must be a positive integer",
      });
    }
    // An unresolvable repository stays unknown: a merge that no record can
    // name is refused before the forge runs.
    const deps2 = wb5bDeps({
      workOrder: { ...makeWorkOrderRecord(), repository: "r".repeat(201) },
    });
    const result = await deps2.useCase.executeAuthorizedForgeAction({
      ...mergeReq,
      pullRequestNumber: 7,
    });
    expect(result.outcome).toBe("refused");
    expect(deps2.seen).toHaveLength(0);
    expect(await deps2.mergeRecordRepo.listMergeRecords()).toEqual([]);
    expect(await deps2.lanePlanRepo.listPullRequestLinks()).toEqual([]);
  });

  it("refuses merge-pr with merge-record-store-unavailable when no merge-record store is wired, and refuses an unresolved PR number, never calling the forge", async () => {
    const seen: ForgeActionRequest[] = [];
    const journal = new InMemoryJournal();
    const attemptRepo = new InMemoryAttemptRepo(makeAttemptRecord());
    const useCase = new ExecuteAuthorizedForgeActionUseCase({
      attemptRepo,
      attemptOwnerDecisionPort: attemptDoorsFrom(attemptRepo),
      workOrderRepo: new InMemoryWorkOrderRepo(makeWorkOrderRecord()),
      journal,
      authorizationPort: {
        async resolveActionAuthorization() {
          return { outcome: "granted", authorizationGrantId: "grant-001" };
        },
        async consumeActionAuthorization(req) {
          return { outcome: "consumed", actionId: req.actionId };
        },
      },
      forgePort: {
        isConfigured: () => true,
        boundRepository: () => ({ owner: 'org', repo: 'repo' }),
        async performForgeAction(request) {
          seen.push(request);
          return { outcome: "executed", headSha: request.expectedHeadSha };
        },
      },
      acceptedReceiptByHead: { [WB_HEAD]: "receipt-001" },
      acceptanceEvidencePort: acceptedAssessment(),
    });
    expect(
      await useCase.executeAuthorizedForgeAction({
        ...mergeReq,
        pullRequestNumber: 7,
      }),
    ).toEqual({ outcome: "refused", reason: "merge-record-store-unavailable" });
    const unresolved = await useCase.executeAuthorizedForgeAction(mergeReq);
    expect(unresolved.outcome).toBe("refused");
    expect(seen).toHaveLength(0);
    expect(journal.entries).toHaveLength(0);
  });

  describe("legacy attempt: the pull request is looked up by its branch head", () => {
    const legacyEntry = {
      id: "forge:act-open:completed:2",
      attemptId: "att-001",
      workOrderId: "wo-001",
      action: "forge" as const,
      status: "completed" as const,
      baseCommit: "b".repeat(40),
      recordedAtIso: "2026-11-01T00:00:00.000Z",
      sessionId: null,
      detail: "pull request #42",
    };

    it("resolves a free-text legacy entry to the single open PR at the expected head and records the source", async () => {
      const deps = wb5bDeps({
        lookup: async () => ({
          outcome: "read",
          pullRequests: [{ number: 42, headSha: WB_HEAD }],
        }),
      });
      await deps.journal.appendJournalEntry(legacyEntry);
      const result = await deps.useCase.executeAuthorizedForgeAction(mergeReq);
      expect(result.outcome).toBe("executed");
      expect(deps.lookups).toEqual([
        { repository: "org/repo", branchName: "feat/lane-auth" },
      ]);
      expect(deps.seen[0]?.pullRequestNumber).toBe(42);
      const merged = deps.journal.entries.find(
        (entry) =>
          entry.status === "completed" && entry.id.startsWith("forge:act-1"),
      )!;
      expect(merged.detail).toBe("prSource=legacy-head-lookup");
      expect(merged.pullRequest).toEqual({
        repository: "org/repo",
        number: 42,
      });
      const stored = await deps.mergeRecordRepo.findMergeRecord("org/repo", 42);
      expect(stored?.actionRef).toBe(merged.id);
    });

    it.each([
      ["no open pull request", [], "legacy-pr-lookup-none-found"],
      [
        "two matching pull requests",
        [
          { number: 42, headSha: WB_HEAD },
          { number: 43, headSha: WB_HEAD },
        ],
        "legacy-pr-lookup-ambiguous",
      ],
      [
        "a head sha mismatch",
        [{ number: 42, headSha: WB_OTHER_HEAD }],
        "legacy-pr-lookup-head-mismatch",
      ],
    ])(
      "refuses %s before the grant and the forge call",
      async (_name, pullRequests, reason) => {
        const deps = wb5bDeps({
          lookup: async () => ({ outcome: "read", pullRequests }),
        });
        const result =
          await deps.useCase.executeAuthorizedForgeAction(mergeReq);
        expect(result).toEqual({ outcome: "refused", reason });
        expect(deps.seen).toHaveLength(0);
        expect(await deps.mergeRecordRepo.listMergeRecords()).toEqual([]);
      },
    );

    it("refuses on an unreadable answer and on a thrown lookup, never guessing", async () => {
      const unreadable = wb5bDeps({
        lookup: async () => ({ outcome: "unreadable", reason: "gh failed" }),
      });
      expect(
        await unreadable.useCase.executeAuthorizedForgeAction(mergeReq),
      ).toEqual({ outcome: "refused", reason: "legacy-pr-lookup-unreadable" });
      const thrown = wb5bDeps({
        lookup: async () => {
          throw new Error("forge exploded");
        },
      });
      expect(
        await thrown.useCase.executeAuthorizedForgeAction(mergeReq),
      ).toEqual({ outcome: "refused", reason: "legacy-pr-lookup-unreadable" });
      expect(unreadable.seen).toHaveLength(0);
      expect(thrown.seen).toHaveLength(0);
    });
  });

  describe("WB5b2: the recorded pull request is the merged pull request", () => {
    it("refuses a request number that disagrees with the typed journal reference: pull-request-sources-disagree, no grant, no forge call, no read", async () => {
      const deps = wb5bDeps();
      await deps.journal.appendJournalEntry(typedCompletedEntry(42));
      const result = await deps.useCase.executeAuthorizedForgeAction({
        ...mergeReq,
        pullRequestNumber: 999,
      });
      expect(result).toEqual({
        outcome: "refused",
        reason: "pull-request-sources-disagree",
      });
      expect(deps.consumed).toEqual([]);
      expect(deps.seen).toHaveLength(0);
      expect(deps.reads).toHaveLength(0);
      expect(await deps.mergeRecordRepo.listMergeRecords()).toEqual([]);
      expect(await deps.lanePlanRepo.listPullRequestLinks()).toEqual([]);
    });

    it("refuses a stored link that disagrees with the journal or the request, before the grant", async () => {
      const journalVsLink = wb5bDeps();
      await journalVsLink.journal.appendJournalEntry(typedCompletedEntry(42));
      await journalVsLink.lanePlanRepo.savePullRequestLink(storedLink(43));
      expect(
        await journalVsLink.useCase.executeAuthorizedForgeAction(mergeReq),
      ).toEqual({ outcome: "refused", reason: "pull-request-sources-disagree" });
      expect(journalVsLink.consumed).toEqual([]);

      const requestVsLink = wb5bDeps();
      await requestVsLink.lanePlanRepo.savePullRequestLink(storedLink(43));
      expect(
        await requestVsLink.useCase.executeAuthorizedForgeAction({
          ...mergeReq,
          pullRequestNumber: 44,
        }),
      ).toEqual({ outcome: "refused", reason: "pull-request-sources-disagree" });
      expect(requestVsLink.consumed).toEqual([]);
      expect(requestVsLink.seen).toHaveLength(0);
    });

    it.each([
      [
        "another branch's pull request",
        async () => ({
          outcome: "found" as const,
          pullRequest: snapshot(7, { headRef: "feat/other-lane" }),
        }),
      ],
      [
        "a head mismatch",
        async () => ({
          outcome: "found" as const,
          pullRequest: snapshot(7, { headSha: WB_OTHER_HEAD }),
        }),
      ],
      [
        "a closed pull request",
        async () => ({
          outcome: "found" as const,
          pullRequest: snapshot(7, {
            state: "closed" as const,
            closedAtIso: "2026-11-05T09:00:00.000Z",
          }),
        }),
      ],
      ["a not-found answer", async () => ({ outcome: "not-found" as const })],
      [
        "an unavailable answer",
        async () => ({ outcome: "unavailable" as const, reason: "boom" }),
      ],
      [
        "a snapshot of another number",
        async () => ({
          outcome: "found" as const,
          pullRequest: snapshot(8),
        }),
      ],
      [
        "a throwing read",
        async (): Promise<ReadPullRequestResult> => {
          throw new Error("forge exploded");
        },
      ],
    ])(
      "refuses a request-only number that is unverified: %s",
      async (_name, read) => {
        const deps = wb5bDeps({ read });
        const result = await deps.useCase.executeAuthorizedForgeAction({
          ...mergeReq,
          pullRequestNumber: 7,
        });
        expect(result).toEqual({
          outcome: "refused",
          reason: "pull-request-unverified",
        });
        expect(deps.consumed).toEqual([]);
        expect(deps.seen).toHaveLength(0);
        expect(await deps.mergeRecordRepo.listMergeRecords()).toEqual([]);
        expect(await deps.lanePlanRepo.listPullRequestLinks()).toEqual([]);
      },
    );

    it("refuses a request-only number when no pull-request reader is wired: unknown stays unknown", async () => {
      const deps = wb5bDeps({ read: "none" });
      const result = await deps.useCase.executeAuthorizedForgeAction({
        ...mergeReq,
        pullRequestNumber: 7,
      });
      expect(result).toEqual({
        outcome: "refused",
        reason: "pull-request-unverified",
      });
      expect(deps.consumed).toEqual([]);
      expect(deps.seen).toHaveLength(0);
    });

    it("verifies a request-only number that is right with one bounded read, and merges by that number", async () => {
      const deps = wb5bDeps();
      const result = await deps.useCase.executeAuthorizedForgeAction({
        ...mergeReq,
        pullRequestNumber: 7,
      });
      expect(result.outcome).toBe("executed");
      expect(deps.reads).toEqual([
        {
          ref: { kind: "number", number: 7 },
          repository: { owner: "org", repo: "repo" },
          timeoutMs: 15_000,
        },
      ]);
      expect(deps.seen[0]?.pullRequestNumber).toBe(7);
      expect(
        await deps.mergeRecordRepo.findMergeRecord("org/repo", 7),
      ).toMatchObject({ number: 7, headSha: WB_HEAD });
    });

    it("verifies a number the typed journal names too: one read, then the merge by that number", async () => {
      const deps = wb5bDeps();
      await deps.journal.appendJournalEntry(typedCompletedEntry(42));
      const result = await deps.useCase.executeAuthorizedForgeAction({
        ...mergeReq,
        pullRequestNumber: 42,
      });
      expect(result.outcome).toBe("executed");
      expect(deps.reads).toHaveLength(1);
      expect(deps.seen[0]?.pullRequestNumber).toBe(42);
    });

    it("refuses when the journal and the stored link agree on a pull request the forge shows closed", async () => {
      const closed = async (request: ReadPullRequestRequest) => ({
        outcome: "found" as const,
        pullRequest: snapshot(
          request.ref.kind === "number" ? request.ref.number : 0,
          { state: "closed", closedAtIso: "2026-11-05T09:00:00.000Z" },
        ),
      });
      const both = wb5bDeps({ read: closed });
      await both.journal.appendJournalEntry(typedCompletedEntry(42));
      await both.lanePlanRepo.savePullRequestLink(storedLink(42));
      expect(await both.useCase.executeAuthorizedForgeAction(mergeReq)).toEqual({
        outcome: "refused",
        reason: "pull-request-link-stale",
      });
      expect(both.consumed).toEqual([]);
      expect(both.seen).toHaveLength(0);

      const journalOnly = wb5bDeps({ read: closed });
      await journalOnly.journal.appendJournalEntry(typedCompletedEntry(42));
      expect(
        await journalOnly.useCase.executeAuthorizedForgeAction(mergeReq),
      ).toEqual({ outcome: "refused", reason: "pull-request-unverified" });
      expect(journalOnly.consumed).toEqual([]);
      expect(journalOnly.seen).toHaveLength(0);

      const unreadable = wb5bDeps({ read: "none" });
      await unreadable.journal.appendJournalEntry(typedCompletedEntry(42));
      expect(
        await unreadable.useCase.executeAuthorizedForgeAction(mergeReq),
      ).toEqual({ outcome: "refused", reason: "pull-request-unverified" });
      expect(unreadable.seen).toHaveLength(0);
    });

    it("refuses a pull request merged at the expected head but on another branch, recording nothing", async () => {
      const deps = wb5bDeps({
        read: async (request) => ({
          outcome: "found",
          pullRequest: snapshot(
            request.ref.kind === "number" ? request.ref.number : 0,
            {
              state: "merged",
              headRef: "feat/other-lane",
              isCrossRepository: false,
              headRepositoryOwner: 'org',
mergedAtIso: "2026-11-05T09:00:00.000Z",
              mergeCommitSha: WB_HEAD,
            },
          ),
        }),
      });
      await deps.journal.appendJournalEntry(typedCompletedEntry(42));
      expect(await deps.useCase.executeAuthorizedForgeAction(mergeReq)).toEqual({
        outcome: "refused",
        reason: "pull-request-unverified",
      });
      expect(deps.consumed).toEqual([]);
      expect(deps.seen).toHaveLength(0);
      expect(await deps.mergeRecordRepo.listMergeRecords()).toEqual([]);
      expect(
        (await deps.workOrderRepo.findWorkOrderById("wo-001"))?.state,
      ).toBe("approved");
    });

    it("treats a typed journal reference for another repository as a disagreement, never merging the request's number", async () => {
      const deps = wb5bDeps();
      await deps.journal.appendJournalEntry({
        ...typedCompletedEntry(42),
        pullRequest: { repository: "other/repo", number: 42 },
      });
      expect(
        await deps.useCase.executeAuthorizedForgeAction({
          ...mergeReq,
          pullRequestNumber: 43,
        }),
      ).toEqual({ outcome: "refused", reason: "pull-request-sources-disagree" });
      expect(deps.consumed).toEqual([]);
      expect(deps.seen).toHaveLength(0);
      expect(deps.reads).toHaveLength(0);
    });

    it("refuses a merge when the work order's repository is not the forge port's bound repository: no read, no grant, no merge", async () => {
      const deps = wb5bDeps({ bound: { owner: "other", repo: "repo" } });
      expect(
        await deps.useCase.executeAuthorizedForgeAction({
          ...mergeReq,
          pullRequestNumber: 7,
        }),
      ).toEqual({ outcome: "refused", reason: "repository-mismatch" });
      expect(deps.reads).toHaveLength(0);
      expect(deps.consumed).toEqual([]);
      expect(deps.seen).toHaveLength(0);
      expect(await deps.mergeRecordRepo.listMergeRecords()).toEqual([]);
    });

    it("refuses a merge through an unbound forge port, and compares the bound repository case-insensitively", async () => {
      const unbound = wb5bDeps({ bound: "unbound" });
      expect(
        await unbound.useCase.executeAuthorizedForgeAction({
          ...mergeReq,
          pullRequestNumber: 7,
        }),
      ).toEqual({ outcome: "refused", reason: "repository-unbound" });
      expect(unbound.reads).toHaveLength(0);
      expect(unbound.consumed).toEqual([]);
      expect(unbound.seen).toHaveLength(0);

      const sameRepo = wb5bDeps({ bound: { owner: "ORG", repo: "Repo" } });
      expect(
        (
          await sameRepo.useCase.executeAuthorizedForgeAction({
            ...mergeReq,
            pullRequestNumber: 7,
          })
        ).outcome,
      ).toBe("executed");
    });

    it("normalises both repositories alike: .git, whitespace and ASCII case match; Unicode look-alikes never do", async () => {
      for (const bound of [
        { owner: "org", repo: "repo.git" },
        { owner: " org", repo: "repo " },
        { owner: "ORG", repo: "rEpO" },
      ]) {
        const deps = wb5bDeps({ bound });
        expect(
          (
            await deps.useCase.executeAuthorizedForgeAction({
              ...mergeReq,
              pullRequestNumber: 7,
            })
          ).outcome,
        ).toBe("executed");
      }
      const korgOrder = { ...makeWorkOrderRecord(), repository: "github.com/korg/repo" };
      for (const bound of [
        // The Kelvin sign lower-cases to k under Unicode folding.
        { owner: "\u212Aorg", repo: "repo" },
        // A Turkish dotless i is not an ASCII letter.
        { owner: "korg", repo: "repo\u0131" },
      ]) {
        const deps = wb5bDeps({ bound, workOrder: korgOrder });
        expect(
          await deps.useCase.executeAuthorizedForgeAction({
            ...mergeReq,
            pullRequestNumber: 7,
          }),
        ).toEqual({ outcome: "refused", reason: "repository-invalid" });
        expect(deps.reads).toHaveLength(0);
        expect(deps.consumed).toEqual([]);
        expect(deps.seen).toHaveLength(0);
      }
    });

    const LIVE_URL = "https://github.com/martinkrakowski/fleet-v2.git";
    const LIVE_BOUND = { owner: "martinkrakowski", repo: "fleet-v2" };

    it("merges a work order that stores the live URL form, and records the canonical owner/repo", async () => {
      const deps = wb5bDeps({
        bound: LIVE_BOUND,
        workOrder: { ...makeWorkOrderRecord(), repository: LIVE_URL },
      });
      const result = await deps.useCase.executeAuthorizedForgeAction({
        ...mergeReq,
        pullRequestNumber: 7,
      });
      expect(result.outcome).toBe("executed");
      expect(deps.reads[0]?.repository).toEqual(LIVE_BOUND);
      expect(
        await deps.mergeRecordRepo.findMergeRecord("martinkrakowski/fleet-v2", 7),
      ).toMatchObject({ number: 7 });
      expect(
        deps.journal.entries.find((entry) => entry.status === "completed")
          ?.pullRequest,
      ).toEqual({ repository: "martinkrakowski/fleet-v2", number: 7 });
    });

    it.each([
      ["the live URL with another owner", LIVE_URL, { owner: "someone", repo: "fleet-v2" }, "repository-mismatch"],
      ["a non-GitHub host", "https://gitlab.com/martinkrakowski/fleet-v2.git", LIVE_BOUND, "repository-invalid"],
      ["a look-alike host", "https://github.com.evil.example/martinkrakowski/fleet-v2", LIVE_BOUND, "repository-invalid"],
      ["http (refused: the forge is https only)", "http://github.com/martinkrakowski/fleet-v2.git", LIVE_BOUND, "repository-invalid"],
      ["credentials in the URL", "https://user:pass@github.com/martinkrakowski/fleet-v2.git", LIVE_BOUND, "repository-invalid"],
      ["a query", "https://github.com/martinkrakowski/fleet-v2.git?x=1", LIVE_BOUND, "repository-invalid"],
      ["a fragment", "https://github.com/martinkrakowski/fleet-v2#readme", LIVE_BOUND, "repository-invalid"],
      ["an extra path segment", "https://github.com/martinkrakowski/fleet-v2/tree/main", LIVE_BOUND, "repository-invalid"],
      ["two trailing slashes", "https://github.com/martinkrakowski/fleet-v2//", LIVE_BOUND, "repository-invalid"],
      ["a non-ASCII owner", "https://github.com/\u212Aartinkrakowski/fleet-v2", LIVE_BOUND, "repository-invalid"],
      ["an ssh user other than git", "ssh://root@github.com/martinkrakowski/fleet-v2.git", LIVE_BOUND, "repository-invalid"],
    ])(
      "refuses a work order repository with %s, before any read, grant or merge",
      async (_name, repository, bound, reason) => {
        const deps = wb5bDeps({
          bound,
          workOrder: { ...makeWorkOrderRecord(), repository },
        });
        expect(
          await deps.useCase.executeAuthorizedForgeAction({
            ...mergeReq,
            pullRequestNumber: 7,
          }),
        ).toEqual({ outcome: "refused", reason });
        expect(deps.reads).toHaveLength(0);
        expect(deps.consumed).toEqual([]);
        expect(deps.seen).toHaveLength(0);
      },
    );

    it.each([
      ["one trailing slash", "https://github.com/martinkrakowski/fleet-v2/"],
      ["no .git", "https://github.com/martinkrakowski/fleet-v2"],
      ["an upper-case host", "https://GitHub.COM/martinkrakowski/fleet-v2.git"],
      ["the scp form", "git@github.com:martinkrakowski/fleet-v2.git"],
      ["the ssh form", "ssh://git@github.com/martinkrakowski/fleet-v2.git"],
      ["the host-prefixed form", "github.com/martinkrakowski/fleet-v2"],
      ["the plain form", "martinkrakowski/fleet-v2"],
    ])("accepts a work order repository in %s form", async (_name, repository) => {
      const deps = wb5bDeps({
        bound: LIVE_BOUND,
        workOrder: { ...makeWorkOrderRecord(), repository },
      });
      expect(
        (
          await deps.useCase.executeAuthorizedForgeAction({
            ...mergeReq,
            pullRequestNumber: 7,
          })
        ).outcome,
      ).toBe("executed");
    });

    it("a throwing merge-record store is merge-record-not-saved, and the next pass completes the record without merging again", async () => {
      let state: "open" | "merged" = "open";
      const deps = wb5bDeps({
        failSaves: 1,
        read: async (request) => ({
          outcome: "found",
          pullRequest: snapshot(
            request.ref.kind === "number" ? request.ref.number : 0,
            state === "merged"
              ? {
                  state: "merged",
                  mergedAtIso: "2026-11-05T09:00:00.000Z",
                  mergeCommitSha: WB_HEAD,
                }
              : {},
          ),
        }),
      });
      const first = await deps.useCase.executeAuthorizedForgeAction({
        ...mergeReq,
        pullRequestNumber: 7,
      });
      expect(first).toEqual({
        outcome: "refused",
        reason: "merge-record-not-saved",
        forgeAmbiguous: true,
      });
      expect(
        (await deps.workOrderRepo.findWorkOrderById("wo-001"))?.state,
      ).toBe("approved");
      expect(
        deps.journal.entries.find((entry) => entry.status === "ambiguous")
          ?.detail,
      ).toBe("merge-record-not-saved:unavailable");
      expect(deps.seen).toHaveLength(1);

      state = "merged";
      const second = await deps.useCase.executeAuthorizedForgeAction({
        ...mergeReq,
        actionId: "act-2",
      });
      expect(second.outcome).toBe("executed");
      expect(deps.seen).toHaveLength(1);
      expect(
        await deps.mergeRecordRepo.findMergeRecord("org/repo", 7),
      ).toMatchObject({ number: 7, headSha: WB_HEAD, merger: "fleet" });
      expect(
        (await deps.workOrderRepo.findWorkOrderById("wo-001"))?.state,
      ).toBe("merged");
    });

    it.each([
      [
        "closed",
        snapshot(9, {
          state: "closed",
          closedAtIso: "2026-11-05T09:00:00.000Z",
        }),
      ],
      [
        "merged at a different head",
        snapshot(9, {
          state: "merged",
          headSha: WB_OTHER_HEAD,
          mergedAtIso: "2026-11-05T09:00:00.000Z",
          mergeCommitSha: WB_OTHER_HEAD,
        }),
      ],
    ])(
      "refuses a stored link whose pull request is %s: pull-request-link-stale",
      async (_name, pullRequest) => {
        const deps = wb5bDeps({
          read: async () => ({ outcome: "found", pullRequest }),
        });
        await deps.lanePlanRepo.savePullRequestLink(storedLink(9));
        const result = await deps.useCase.executeAuthorizedForgeAction(mergeReq);
        expect(result).toEqual({
          outcome: "refused",
          reason: "pull-request-link-stale",
        });
        expect(deps.consumed).toEqual([]);
        expect(deps.seen).toHaveLength(0);
        expect(await deps.mergeRecordRepo.listMergeRecords()).toEqual([]);
      },
    );

    it("refuses a stored link it cannot read, and merges one that is open", async () => {
      const unreadable = wb5bDeps({
        read: async () => ({ outcome: "unavailable", reason: "boom" }),
      });
      await unreadable.lanePlanRepo.savePullRequestLink(storedLink(9));
      expect(
        await unreadable.useCase.executeAuthorizedForgeAction(mergeReq),
      ).toEqual({ outcome: "refused", reason: "pull-request-unverified" });
      expect(unreadable.consumed).toEqual([]);

      const open = wb5bDeps();
      await open.lanePlanRepo.savePullRequestLink(storedLink(9));
      expect(
        (await open.useCase.executeAuthorizedForgeAction(mergeReq)).outcome,
      ).toBe("executed");
      expect(open.seen[0]?.pullRequestNumber).toBe(9);
    });

    it.each([
      [
        "refused",
        { outcome: "refused", code: "invalid" } as MergeRecordSaveOutcome,
      ],
      [
        "integrity-conflict",
        {
          outcome: "integrity-conflict",
          record: {
            schemaVersion: 1,
            repository: "org/repo",
            number: 7,
            headSha: WB_OTHER_HEAD,
            mergedAtIso: "2026-11-05T09:00:00.000Z",
            firstSeenAtIso: "2026-11-05T09:00:00.000Z",
            source: "forge-observation",
            merger: "unknown",
          },
        } as MergeRecordSaveOutcome,
      ],
    ])(
      "does not mark the work order merged when saveMergeRecord answers %s: typed outcome and an ambiguous journal entry",
      async (outcome, saveOutcome) => {
        const deps = wb5bDeps({ saveOutcome });
        const result = await deps.useCase.executeAuthorizedForgeAction({
          ...mergeReq,
          pullRequestNumber: 7,
        });
        expect(result).toEqual({
          outcome: "refused",
          reason: "merge-record-not-saved",
          forgeAmbiguous: true,
        });
        expect(
          (await deps.workOrderRepo.findWorkOrderById("wo-001"))?.state,
        ).toBe("approved");
        const ambiguous = deps.journal.entries.filter(
          (entry) => entry.status === "ambiguous",
        );
        expect(ambiguous).toHaveLength(1);
        expect(ambiguous[0]?.detail).toBe(
          `merge-record-not-saved:${outcome}`,
        );
        // The completed entry still carries the typed reference a later pass reads.
        expect(
          deps.journal.entries.find((entry) => entry.status === "completed")
            ?.pullRequest,
        ).toEqual({ repository: "org/repo", number: 7 });
      },
    );

    it("refuses an operator actionId too long for the merge record's actionRef before the grant, and accepts the longest that fits", async () => {
      const tooLong = wb5bDeps();
      const refused = await tooLong.useCase.executeAuthorizedForgeAction({
        ...mergeReq,
        actionId: "a".repeat(106),
        pullRequestNumber: 7,
      });
      expect(refused).toEqual({
        outcome: "refused",
        reason: "action-id-too-long",
      });
      expect(tooLong.consumed).toEqual([]);
      expect(tooLong.seen).toHaveLength(0);
      expect(tooLong.reads).toHaveLength(0);
      expect(tooLong.journal.entries).toHaveLength(0);

      const fits = wb5bDeps();
      const merged = await fits.useCase.executeAuthorizedForgeAction({
        ...mergeReq,
        actionId: "a".repeat(105),
        pullRequestNumber: 7,
      });
      expect(merged.outcome).toBe("executed");
      const stored = await fits.mergeRecordRepo.findMergeRecord("org/repo", 7);
      expect(stored?.actionRef?.length).toBeLessThanOrEqual(128);
    });

    it("passes through only the two exact legacy-lookup reasons; every other unreadable reason is generic", async () => {
      for (const reason of [
        "legacy-pr-lookup-unbound-repository",
        "legacy-pr-lookup-repository-mismatch",
      ]) {
        const deps = wb5bDeps({
          lookup: async () => ({ outcome: "unreadable", reason }),
        });
        expect(
          await deps.useCase.executeAuthorizedForgeAction(mergeReq),
        ).toEqual({ outcome: "refused", reason });
      }
      for (const reason of [
        "legacy-pr-lookup-token-ghp_exposed",
        "legacy-pr-lookup-",
        "gh failed",
      ]) {
        const deps = wb5bDeps({
          lookup: async () => ({ outcome: "unreadable", reason }),
        });
        expect(
          await deps.useCase.executeAuthorizedForgeAction(mergeReq),
        ).toEqual({ outcome: "refused", reason: "legacy-pr-lookup-unreadable" });
      }
    });
  });

  describe("WB5b3: fork pull requests are refused and repositories are canonical", () => {
    it("refuses a fork PR carrying the attempt's branch name and exact head commit: pull-request-cross-repository, no grant, no merge, no record", async () => {
      const deps = wb5bDeps({
        read: async (request) => ({
          outcome: "found",
          pullRequest: snapshot(request.ref.kind === "number" ? request.ref.number : 0, {
            isCrossRepository: true,
            headRepositoryOwner: "some-fork-owner",
          }),
        }),
      });
      const result = await deps.useCase.executeAuthorizedForgeAction({
        ...mergeReq,
        pullRequestNumber: 7,
      });
      expect(result).toEqual({
        outcome: "refused",
        reason: "pull-request-cross-repository",
      });
      expect(deps.consumed).toEqual([]);
      expect(deps.seen).toHaveLength(0);
      expect(await deps.mergeRecordRepo.listMergeRecords()).toEqual([]);
      expect(await deps.lanePlanRepo.listPullRequestLinks()).toEqual([]);
      expect(
        deps.journal.entries.filter((entry) => entry.status === "completed"),
      ).toHaveLength(0);
    });

    it("refuses when the head repository owner differs from the read repository's owner, even with isCrossRepository false", async () => {
      const deps = wb5bDeps({
        read: async (request) => ({
          outcome: "found",
          pullRequest: snapshot(request.ref.kind === "number" ? request.ref.number : 0, {
            headRepositoryOwner: "Other-Org",
          }),
        }),
      });
      expect(
        await deps.useCase.executeAuthorizedForgeAction({
          ...mergeReq,
          pullRequestNumber: 7,
        }),
      ).toEqual({ outcome: "refused", reason: "pull-request-cross-repository" });
      expect(deps.consumed).toEqual([]);
      expect(deps.seen).toHaveLength(0);
    });

    it("refuses pull-request-unverified when isCrossRepository is missing from the read", async () => {
      const deps = wb5bDeps({
        read: async () => ({
          outcome: "unavailable",
          reason: "gh pr view returned an unreadable pull request",
        }),
      });
      expect(
        await deps.useCase.executeAuthorizedForgeAction({
          ...mergeReq,
          pullRequestNumber: 7,
        }),
      ).toEqual({ outcome: "refused", reason: "pull-request-unverified" });
      expect(deps.consumed).toEqual([]);
      expect(deps.seen).toHaveLength(0);
    });

    it("refuses pull-request-unverified when the found snapshot carries a non-boolean isCrossRepository, before the grant is consumed", async () => {
      const deps = wb5bDeps({
        read: async (request) => ({
          outcome: "found",
          pullRequest: {
            ...snapshot(
              request.ref.kind === "number" ? request.ref.number : 0,
            ),
            // Simulate a snapshot that came back malformed (WB5b3): the
            // flag is not a boolean, so verification must fail closed
            // rather than treating a truthy non-boolean as false.
            isCrossRepository: "no" as unknown as boolean,
          },
        }),
      });
      expect(
        await deps.useCase.executeAuthorizedForgeAction({
          ...mergeReq,
          pullRequestNumber: 7,
        }),
      ).toEqual({ outcome: "refused", reason: "pull-request-unverified" });
      expect(deps.consumed).toEqual([]);
      expect(deps.seen).toHaveLength(0);
      expect(await deps.mergeRecordRepo.listMergeRecords()).toEqual([]);
    });

    it("refuses a fork pull request found through the legacy head lookup, before the grant is consumed", async () => {
      const deps = wb5bDeps({
        lookup: async () => ({
          outcome: "read",
          pullRequests: [{ number: 42, headSha: WB_HEAD }],
        }),
        read: async (request) => ({
          outcome: "found",
          pullRequest: snapshot(
            request.ref.kind === "number" ? request.ref.number : 0,
            {
              isCrossRepository: true,
              headRepositoryOwner: "some-fork-owner",
            },
          ),
        }),
      });
      await deps.journal.appendJournalEntry({
        id: "forge:act-open:completed:2",
        attemptId: "att-001",
        workOrderId: "wo-001",
        action: "forge",
        status: "completed",
        baseCommit: "b".repeat(40),
        recordedAtIso: "2026-11-01T00:00:00.000Z",
        sessionId: null,
        detail: "pull request #42",
      });
      const result = await deps.useCase.executeAuthorizedForgeAction(mergeReq);
      expect(result).toEqual({
        outcome: "refused",
        reason: "pull-request-cross-repository",
      });
      expect(deps.consumed).toEqual([]);
      expect(deps.seen).toHaveLength(0);
      expect(await deps.mergeRecordRepo.listMergeRecords()).toEqual([]);
      expect(await deps.lanePlanRepo.listPullRequestLinks()).toEqual([]);
      expect(
        deps.journal.entries.filter(
          (entry) => entry.status === "completed" && entry.id.startsWith("forge:act-1"),
        ),
      ).toHaveLength(0);
    });

    it("still merges a same-repository PR at the expected head", async () => {
      const deps = wb5bDeps();
      const result = await deps.useCase.executeAuthorizedForgeAction({
        ...mergeReq,
        pullRequestNumber: 7,
      });
      expect(result.outcome).toBe("executed");
      expect(deps.consumed).toEqual(["act-1"]);
    });
  });

  it("refuses cleanly when the composition clock is unreadable, before consuming the grant", async () => {
    let consumed = 0;
    const deps = wb5bDeps();
    // Rebuild with a throwing clock through the same shape the use case reads.
    const throwingNow = (): string => {
      throw new Error("clock broken");
    };
    const useCase = new ExecuteAuthorizedForgeActionUseCase({
      attemptRepo: new InMemoryAttemptRepo(makeAttemptRecord()),
      attemptOwnerDecisionPort: attemptDoorsFrom(
        new InMemoryAttemptRepo(makeAttemptRecord()),
      ),
      workOrderRepo: new InMemoryWorkOrderRepo(makeWorkOrderRecord()),
      journal: deps.journal,
      authorizationPort: {
        async resolveActionAuthorization() {
          return { outcome: "granted", authorizationGrantId: "grant-001" };
        },
        async consumeActionAuthorization() {
          consumed += 1;
          return { outcome: "consumed", actionId: "act-1" };
        },
      },
      forgePort: {
        isConfigured: () => true,
        boundRepository: () => ({ owner: 'org', repo: 'repo' }),
        async performForgeAction() {
          return { outcome: "executed", headSha: WB_HEAD };
        },
      },
      acceptedReceiptByHead: { [WB_HEAD]: "receipt-001" },
      acceptanceEvidencePort: acceptedAssessment(),
      lanePlanRepo: deps.lanePlanRepo,
      mergeRecordRepo: deps.mergeRecordRepo,
      now: throwingNow,
    });
    const result = await useCase.executeAuthorizedForgeAction(mergeReq);
    expect(result.outcome).toBe("refused");
    expect(consumed).toBe(0);
    expect(deps.journal.entries).toHaveLength(0);
  });
});

class FakeMergeRecordRepo implements MergeRecordRepositoryPort {
  readonly calls: string[];
  private readonly records = new Map<string, MergeRecordRecord>();

  constructor(order: string[]) {
    this.calls = order;
  }

  async saveMergeRecord(
    record: MergeRecordRecord,
  ): Promise<MergeRecordSaveOutcome> {
    const key = `${record.repository}#${record.number}`;
    const decision = decideMergeRecord(this.records.get(key) ?? null, record);
    if (!decision.success) {
      return { outcome: "refused", code: "invalid" };
    }
    if (decision.outcome === "create") {
      this.records.set(key, decision.record);
    } else if (decision.outcome === "upgrade-merger") {
      this.records.set(key, decision.record);
    } else if (decision.outcome === "integrity-conflict") {
      // The stored record is kept: the conflict is reported, never overwritten.
      this.records.set(key, decision.record);
    }
    this.calls.push(
      `merge:${record.repository}#${record.number}:${record.actionRef ?? ""}:${record.merger}:${decision.outcome === "create" ? "created" : decision.outcome === "upgrade-merger" ? "merger-upgraded" : decision.outcome}`,
    );
    return {
      outcome:
        decision.outcome === "create"
          ? "created"
          : decision.outcome === "upgrade-merger"
            ? "merger-upgraded"
            : decision.outcome,
      record: decision.record,
    };
  }

  async findMergeRecord(
    repository: string,
    number: number,
  ): Promise<MergeRecordRecord | null> {
    return this.records.get(`${repository}#${number}`) ?? null;
  }

  async listMergeRecords(): Promise<readonly MergeRecordRecord[]> {
    return [...this.records.values()];
  }
}
