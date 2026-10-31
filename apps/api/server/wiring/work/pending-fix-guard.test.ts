// EX-1b: the pending-fix guard refuses a fix when another fix attempt on the
// prior's work order is still `intent-recorded`, without calling the wrapped
// use case, and delegates otherwise.
import { describe, expect, it, vi } from "vitest";

import { AttemptRepositoryAdapter } from "@fleet/work-execution";
import type { AttemptRecord, PrepareFixAttemptResult } from "@fleet/work-execution";

import { withPendingFixLimit } from "./pending-fix-guard";

function attemptRecord(
  id: string,
  overrides: Partial<AttemptRecord> = {},
): AttemptRecord {
  return {
    id,
    workOrderId: "wo-1",
    kind: "initial",
    fixNumber: 0,
    priorAttemptId: null,
    worktreePath: `/tmp/opencode/lanes/${id}`,
    baseCommit: "0".repeat(40),
    state: "running",
    outcome: null,
    briefDigest: null,
    briefPackagePath: null,
    sessionId: null,
    completionReceipt: null,
    artifacts: null,
    createdAtIso: "2026-10-31T09:00:00.000Z",
    updatedAtIso: "2026-10-31T09:00:00.000Z",
    ...overrides,
  };
}

function fixAttempt(id: string, state: AttemptRecord["state"]): AttemptRecord {
  return attemptRecord(id, {
    kind: "fix",
    fixNumber: 1,
    priorAttemptId: "prior-1",
    state,
  });
}

describe("withPendingFixLimit", () => {
  it("refuses when a pending fix sibling exists and never calls the use case", async () => {
    const attemptRepo = new AttemptRepositoryAdapter();
    await attemptRepo.saveAttempt(attemptRecord("prior-1"));
    await attemptRepo.saveAttempt(fixAttempt("fix-held", "intent-recorded"));

    const execute = vi.fn(
      async (): Promise<PrepareFixAttemptResult> => ({
        outcome: "prepared",
        attempt: fixAttempt("fix-new", "intent-recorded"),
      }),
    );
    const guarded = withPendingFixLimit(
      { execute },
      attemptRepo,
    );

    const result = await guarded.execute({
      fixAttemptId: "fix-new",
      workOrderId: "wo-1",
      priorAttemptId: "prior-1",
      numberedFixes: ["fix the thing"],
    });
    expect(result).toEqual({
      outcome: "refused",
      reason: "pending-fix-exists: fix-held",
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("delegates once when no pending fix sibling exists", async () => {
    const attemptRepo = new AttemptRepositoryAdapter();
    await attemptRepo.saveAttempt(attemptRecord("prior-1"));
    // A fix sibling that already moved past `intent-recorded` does not block.
    await attemptRepo.saveAttempt(fixAttempt("fix-done", "collected"));

    const prepared = fixAttempt("fix-new", "intent-recorded");
    const execute = vi.fn(
      async (): Promise<PrepareFixAttemptResult> => ({
        outcome: "prepared",
        attempt: prepared,
      }),
    );
    const guarded = withPendingFixLimit({ execute }, attemptRepo);

    const result = await guarded.execute({
      fixAttemptId: "fix-new",
      workOrderId: "wo-1",
      priorAttemptId: "prior-1",
      numberedFixes: ["fix the thing"],
    });
    expect(result).toEqual({ outcome: "prepared", attempt: prepared });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith({
      fixAttemptId: "fix-new",
      workOrderId: "wo-1",
      priorAttemptId: "prior-1",
      numberedFixes: ["fix the thing"],
    });
  });

  it("falls through when the input is not an object or the prior id is not a string", async () => {
    const attemptRepo = new AttemptRepositoryAdapter();
    await attemptRepo.saveAttempt(attemptRecord("prior-1"));
    await attemptRepo.saveAttempt(fixAttempt("fix-held", "intent-recorded"));

    const execute = vi.fn(
      async (): Promise<PrepareFixAttemptResult> => ({
        outcome: "refused",
        reason: "missing fields",
      }),
    );
    const guarded = withPendingFixLimit({ execute }, attemptRepo);

    await guarded.execute(undefined);
    await guarded.execute({ fixAttemptId: "fix-new", priorAttemptId: 7 });
    expect(execute).toHaveBeenCalledTimes(2);
  });
});
