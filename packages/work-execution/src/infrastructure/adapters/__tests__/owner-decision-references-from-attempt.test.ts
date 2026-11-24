// Unit tests for readOwnerDecisionReferencesFromAttempt — VB28.
import { describe, expect, it, vi } from "vitest";

import { readOwnerDecisionReferencesFromAttempt } from "../AttemptOwnerDecisionAdapter.adapter.js";
import type { AttemptRecord } from "../../../domain/execution-records.js";
import type { InspectAttemptResult } from "../../../application/ports/in/InspectAttemptPort.in-port.js";

function makeAttempt(overrides?: Partial<AttemptRecord>): AttemptRecord {
  return {
    id: "attempt-1",
    workOrderId: "work-order-1",
    kind: "initial",
    fixNumber: 0,
    priorAttemptId: null,
    worktreePath: "/srv/state/worktrees/lane-1",
    baseCommit: "0000000000000000000000000000000000000000",
    state: "running",
    outcome: null,
    briefDigest: null,
    briefPackagePath: null,
    sessionId: null,
    completionReceipt: null,
    artifacts: null,
    ownerDecisionReferences: ["dec-0"],
    createdAtIso: "2026-01-01T00:00:00.000Z",
    updatedAtIso: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

const attemptId = "attempt-1";

function lookupWith(
  outcome: InspectAttemptResult,
): { inspectAttempt: { inspectAttempt: () => Promise<InspectAttemptResult> } } {
  return {
    inspectAttempt: {
      inspectAttempt: vi.fn(() => Promise.resolve(outcome)),
    },
  };
}

describe("readOwnerDecisionReferencesFromAttempt", () => {
  it("returns unknown without throwing when inspectAttempt is not wired", async () => {
    const lookup: { inspectAttempt?: unknown } = {};
    const result = await readOwnerDecisionReferencesFromAttempt(
      lookup as Parameters<typeof readOwnerDecisionReferencesFromAttempt>[0],
      { attemptId },
    );
    expect(result).toEqual({
      outcome: "unknown",
      reason: "The work context is not wired for attempt inspection",
    });
  });

  it("returns unknown naming the attempt id when inspectAttempt reports not-found", async () => {
    const lookup = lookupWith({ outcome: "not-found", attemptId });
    const result = await readOwnerDecisionReferencesFromAttempt(lookup, {
      attemptId,
    });
    expect(result).toEqual({
      outcome: "unknown",
      reason: `No attempt is recorded for ${attemptId}`,
    });
    expect(lookup.inspectAttempt.inspectAttempt).toHaveBeenCalledTimes(1);
    expect(lookup.inspectAttempt.inspectAttempt).toHaveBeenCalledWith({
      attemptId,
    });
  });

  it("returns unknown naming the attempt id when inspectAttempt reports unknown", async () => {
    const lookup = lookupWith({
      outcome: "unknown",
      attemptId,
      reason: "the inspection store was unavailable",
    });
    const result = await readOwnerDecisionReferencesFromAttempt(lookup, {
      attemptId,
    });
    expect(result).toEqual({
      outcome: "unknown",
      reason: `No attempt is recorded for ${attemptId}`,
    });
    expect(lookup.inspectAttempt.inspectAttempt).toHaveBeenCalledTimes(1);
    expect(lookup.inspectAttempt.inspectAttempt).toHaveBeenCalledWith({
      attemptId,
    });
  });

  it("returns unknown instead of recorded empty list when ownerDecisionReferences is undefined", async () => {
    const attempt = makeAttempt({ ownerDecisionReferences: undefined });
    const lookup = lookupWith({ outcome: "found", attempt });
    const result = await readOwnerDecisionReferencesFromAttempt(lookup, {
      attemptId,
    });
    expect(result).toEqual({
      outcome: "unknown",
      reason: `attempt ${attemptId} was recorded before owner decision references were frozen`,
    });
  });

  it("returns a recorded empty list when the attempt recorded no references", async () => {
    const attempt = makeAttempt({ ownerDecisionReferences: [] });
    const lookup = lookupWith({ outcome: "found", attempt });
    const result = await readOwnerDecisionReferencesFromAttempt(lookup, {
      attemptId,
    });
    expect(result).toEqual({ outcome: "recorded", ownerDecisionReferences: [] });
  });

  it("returns the recorded references in their exact order", async () => {
    const attempt = makeAttempt({
      ownerDecisionReferences: ["dec-1", "dec-2"],
    });
    const lookup = lookupWith({ outcome: "found", attempt });
    const result = await readOwnerDecisionReferencesFromAttempt(lookup, {
      attemptId,
    });
    expect(result).toEqual({
      outcome: "recorded",
      ownerDecisionReferences: ["dec-1", "dec-2"],
    });
  });

  it("propagates the exact rejection error when inspectAttempt rejects", async () => {
    const err = new Error("inspection failed");
    const lookup: {
      inspectAttempt: {
        inspectAttempt: () => Promise<InspectAttemptResult>;
      };
    } = {
      inspectAttempt: {
        inspectAttempt: vi.fn(() => Promise.reject(err)),
      },
    };
    await expect(
      readOwnerDecisionReferencesFromAttempt(lookup, { attemptId }),
    ).rejects.toBe(err);
  });
});
