// Direct unit tests for the run-owned stop guard: request-shape refusal,
// fail-closed run-store reads, deterministic run-owned ordering, and
// delegation to the wrapped StopAttemptUseCase for both entrypoints.
import { describe, expect, it, vi } from "vitest";

import type {
  LaneRunRecord,
  LaneRunRepositoryPort,
  StopAttemptRequest,
  StopAttemptResult,
} from "@fleet/work-execution";
import type { StopAttemptUseCase } from "@fleet/work-execution/use-cases";

import { withRunOwnedStopRefusal } from "./stop-attempt-guard";

const DELEGATED: StopAttemptResult = {
  outcome: "refused",
  reason: "delegated-to-use-case",
};

function makeUseCase() {
  const execute = vi.fn(
    async (_input?: unknown): Promise<StopAttemptResult> => DELEGATED,
  );
  const stopAttempt = vi.fn(async (): Promise<StopAttemptResult> => DELEGATED);
  const useCase: Pick<StopAttemptUseCase, "execute" | "stopAttempt"> = {
    execute,
    stopAttempt,
  };
  return { useCase, execute, stopAttempt };
}

function runRecord(
  runId: string,
  attemptIds: string[],
): LaneRunRecord {
  // The guard only reads `runId` and `attemptIds`; the rest of the record is
  // irrelevant to this boundary, so a minimal shape is asserted through.
  return { runId, attemptIds } as unknown as LaneRunRecord;
}

function makeRunRepo(
  runs: readonly LaneRunRecord[] = [],
): { repo: Pick<LaneRunRepositoryPort, "list">; list: ReturnType<typeof vi.fn> } {
  const list = vi.fn(async (): Promise<readonly LaneRunRecord[]> => runs);
  const repo: Pick<LaneRunRepositoryPort, "list"> = { list };
  return { repo, list };
}

describe("withRunOwnedStopRefusal", () => {
  describe("invalid-request refusals", () => {
    it("refuses null, undefined, primitives, non-plain prototypes, and arrays without touching runRepo or useCase", async () => {
      const { useCase, execute } = makeUseCase();
      const { repo, list } = makeRunRepo();
      const guarded = withRunOwnedStopRefusal(useCase, repo);

      const hostile: unknown[] = [
        null,
        undefined,
        42,
        "att-1",
        true,
        new Date(),
        Object.create({ attemptId: "att-1" }),
        [],
        Object.assign(new Array(2), { 0: "att-1" }),
      ];
      for (const input of hostile) {
        await expect(guarded.execute(input)).resolves.toEqual({
          outcome: "refused",
          reason: "invalid-request",
        });
      }
      expect(list).not.toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
    });

    it("refuses sparse holey arrays and enormous-length arrays in O(1) without touching runRepo or useCase", async () => {
      const { useCase, execute } = makeUseCase();
      const { repo, list } = makeRunRepo();
      const guarded = withRunOwnedStopRefusal(useCase, repo);

      // Sparse holey array: index 1 is a hole, never materialized.
      const holey = new Array(2);
      holey[0] = "att-1";
      // Enormous-length array: rejected by the O(1) Array check before any
      // key enumeration of ten million slots.
      const enormous = new Array(1e7);
      enormous[0] = "att-1";

      for (const input of [holey, enormous]) {
        await expect(guarded.execute(input)).resolves.toEqual({
          outcome: "refused",
          reason: "invalid-request",
        });
      }
      expect(list).not.toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
    });

    it("never invokes a getter on input and refuses accessor properties as invalid-request", async () => {
      const { useCase, execute } = makeUseCase();
      const { repo } = makeRunRepo();
      const guarded = withRunOwnedStopRefusal(useCase, repo);

      let invoked = false;
      const withGetter: Record<string, unknown> = {};
      Object.defineProperty(withGetter, "attemptId", {
        enumerable: true,
        get() {
          invoked = true;
          return "att-1";
        },
      });

      await expect(guarded.execute(withGetter)).resolves.toEqual({
        outcome: "refused",
        reason: "invalid-request",
      });
      expect(invoked).toBe(false);
      expect(execute).not.toHaveBeenCalled();
    });

    it("refuses own symbol keys, non-enumerable properties, and own __proto__ keys as invalid-request", async () => {
      const { useCase, execute } = makeUseCase();
      const { repo } = makeRunRepo();
      const guarded = withRunOwnedStopRefusal(useCase, repo);

      const symbolKey = Symbol("attemptId");
      const withSymbol: Record<string | symbol, unknown> = {
        attemptId: "att-1",
      };
      withSymbol[symbolKey] = "att-symbol";

      const nonEnumerable: Record<string, unknown> = { attemptId: "att-1" };
      Object.defineProperty(nonEnumerable, "extra", {
        value: "hidden",
        enumerable: false,
        writable: true,
        configurable: true,
      });

      const protoKey: Record<string, unknown> = { attemptId: "att-1" };
      Object.defineProperty(protoKey, "__proto__", {
        value: { polluted: true },
        enumerable: true,
        writable: true,
        configurable: true,
      });

      for (const input of [withSymbol, nonEnumerable, protoKey]) {
        await expect(guarded.execute(input)).resolves.toEqual({
          outcome: "refused",
          reason: "invalid-request",
        });
      }
      expect(execute).not.toHaveBeenCalled();
    });

    it("refuses a throwing or revoked Proxy as invalid-request without throwing", async () => {
      const { useCase, execute } = makeUseCase();
      const { repo } = makeRunRepo();
      const guarded = withRunOwnedStopRefusal(useCase, repo);

      const throwingTarget = { attemptId: "att-1" };
      const throwing = new Proxy(throwingTarget, {
        ownKeys() {
          throw new Error("ownKeys refused");
        },
      });

      const { revoke, proxy: revoked } = Proxy.revocable({
        attemptId: "att-1",
      }, {});
      revoke();

      for (const input of [throwing, revoked]) {
        await expect(guarded.execute(input)).resolves.toEqual({
          outcome: "refused",
          reason: "invalid-request",
        });
      }
      expect(execute).not.toHaveBeenCalled();
    });
  });

  describe("delegation on unusable attemptId", () => {
    it("delegates to useCase.execute with a fresh snapshot without calling runRepo when attemptId is missing, non-string, or blank", async () => {
      const { useCase, execute } = makeUseCase();
      const { repo, list } = makeRunRepo();
      const guarded = withRunOwnedStopRefusal(useCase, repo);

      const inputs: unknown[] = [
        {},
        { attemptId: undefined },
        { attemptId: null },
        { attemptId: 7 },
        { attemptId: "" },
        { attemptId: "   " },
        // A plain array-like without attemptId is still a plain record.
        Object.assign(Object.create(null), { 0: "att-1", length: 1 }),
      ];
      for (const input of inputs) {
        await expect(guarded.execute(input)).resolves.toEqual(DELEGATED);
      }
      expect(list).not.toHaveBeenCalled();
      expect(execute).toHaveBeenCalledTimes(inputs.length);
      expect(execute).toHaveBeenLastCalledWith(
        expect.objectContaining({ length: 1 }),
      );
    });
  });

  describe("fail-closed run store", () => {
    it("returns unknown run-ownership-unknown and never calls useCase when runRepo.list rejects or throws", async () => {
      const { useCase, execute } = makeUseCase();
      const guarded = withRunOwnedStopRefusal(useCase, {
        list: vi.fn(async () => {
          throw new Error("lane-runs.json unreadable");
        }),
      });
      await expect(guarded.execute({ attemptId: "att-1" })).resolves.toEqual({
        outcome: "unknown",
        reason: "run-ownership-unknown",
      });

      const syncThrowing = withRunOwnedStopRefusal(useCase, {
        list: vi.fn(() => {
          throw new Error("store exploded synchronously");
        }),
      });
      await expect(
        syncThrowing.execute({ attemptId: "att-1" }),
      ).resolves.toEqual({
        outcome: "unknown",
        reason: "run-ownership-unknown",
      });

      expect(execute).not.toHaveBeenCalled();
    });
  });

  describe("run-owned refusal", () => {
    it("refuses with run-owned and the owning runId without calling useCase when a run lists the trimmed attemptId", async () => {
      const { useCase, execute } = makeUseCase();
      const { repo } = makeRunRepo([
        runRecord("run-b", ["other-attempt"]),
        runRecord("run-a", ["att-1"]),
      ]);
      const guarded = withRunOwnedStopRefusal(useCase, repo);

      // The input attemptId is matched after `.trim()`.
      await expect(guarded.execute({ attemptId: "  att-1 " })).resolves.toEqual(
        {
          outcome: "refused",
          reason: "run-owned",
          runId: "run-a",
        },
      );
      expect(execute).not.toHaveBeenCalled();
    });

    it("picks the lexicographically smallest runId when multiple runs list the attemptId without mutating the repo list", async () => {
      const { useCase, execute } = makeUseCase();
      const runs = [
        runRecord("run-c", ["att-1"]),
        runRecord("run-a", ["att-1"]),
        runRecord("run-b", ["att-1"]),
      ];
      const frozen = Object.freeze([...runs]);
      const list = vi.fn(async () => frozen);
      const guarded = withRunOwnedStopRefusal(useCase, { list });

      await expect(guarded.execute({ attemptId: "att-1" })).resolves.toEqual({
        outcome: "refused",
        reason: "run-owned",
        runId: "run-a",
      });
      // The repo's own list order is untouched by the guard's sort.
      expect(frozen.map((run) => run.runId)).toEqual([
        "run-c",
        "run-a",
        "run-b",
      ]);
      expect(execute).not.toHaveBeenCalled();
    });

    it("refuses run-owned for a terminal run too, and ignores unsorted lists ordering", async () => {
      const { useCase, execute } = makeUseCase();
      // Deliberately unsorted, with the owner last: the guard must sort before
      // selecting, so the smallest runId wins regardless of list order.
      const { repo } = makeRunRepo([
        runRecord("run-z", ["att-1"]),
        runRecord("run-m", ["unrelated"]),
        runRecord("run-b", ["att-1"]),
      ]);
      const guarded = withRunOwnedStopRefusal(useCase, repo);

      await expect(guarded.execute({ attemptId: "att-1" })).resolves.toEqual({
        outcome: "refused",
        reason: "run-owned",
        runId: "run-b",
      });
      expect(execute).not.toHaveBeenCalled();
    });
  });

  describe("delegation when unowned", () => {
    it("delegates to useCase.execute with the cloned snapshot when no run owns the attemptId", async () => {
      const { useCase, execute } = makeUseCase();
      const { repo, list } = makeRunRepo([
        runRecord("run-a", ["other-attempt"]),
      ]);
      const guarded = withRunOwnedStopRefusal(useCase, repo);

      const input = { attemptId: "att-1", gracePeriodSeconds: 5 };
      await expect(guarded.execute(input)).resolves.toEqual(DELEGATED);
      expect(list).toHaveBeenCalledTimes(1);
      expect(execute).toHaveBeenCalledTimes(1);
      const snapshot = execute.mock.calls[0]?.[0] as unknown as Record<
        string,
        unknown
      >;
      // The use case receives a fresh null-prototype clone, not the input.
      expect(snapshot).not.toBe(input);
      expect(Object.getPrototypeOf(snapshot)).toBeNull();
      expect(snapshot.attemptId).toBe("att-1");
      expect(snapshot.gracePeriodSeconds).toBe(5);
      // `stopAttempt` is never part of the delegation path.
      expect(useCase.stopAttempt).not.toHaveBeenCalled();
    });

    it("routes both execute and stopAttempt through the same refusal order", async () => {
      const { useCase, execute } = makeUseCase();
      const { repo } = makeRunRepo([runRecord("run-a", ["att-1"])]);
      const guarded = withRunOwnedStopRefusal(useCase, repo);

      // run-owned, for both entrypoints.
      const ownedRequest: StopAttemptRequest = { attemptId: "att-1" };
      await expect(guarded.execute(ownedRequest)).resolves.toEqual({
        outcome: "refused",
        reason: "run-owned",
        runId: "run-a",
      });
      await expect(guarded.stopAttempt(ownedRequest)).resolves.toEqual({
        outcome: "refused",
        reason: "run-owned",
        runId: "run-a",
      });

      // invalid-request, for both entrypoints.
      const hostile = null as unknown as StopAttemptRequest;
      await expect(guarded.execute(hostile)).resolves.toEqual({
        outcome: "refused",
        reason: "invalid-request",
      });
      await expect(guarded.stopAttempt(hostile)).resolves.toEqual({
        outcome: "refused",
        reason: "invalid-request",
      });

      expect(execute).not.toHaveBeenCalled();
      expect(useCase.stopAttempt).not.toHaveBeenCalled();
    });
  });
});
