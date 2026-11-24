import {
  findLiveRunForAttempt,
  type CancelPreparedAttemptPort,
  type CancelPreparedAttemptRequest,
  type CancelPreparedAttemptResult,
  type LaneRunJournalPort,
  type LaneRunRepositoryPort,
} from "@fleet/work-execution";

export type GuardedCancelPreparedResult =
  | CancelPreparedAttemptResult
  | { readonly outcome: "refused"; readonly reason: "run-active"; readonly runId: string };

/**
 * Wraps the API's own `CancelPreparedAttemptUseCase` instance with EX-1a's
 * run-active refusal. It delegates the run scan to the shared
 * `findLiveRunForAttempt` helper in `@fleet/work-execution`, so the CLI's
 * `attempt cancel-prepared` and this guard enforce one rule. Reads are not
 * wrapped: a read failure propagates (fail-closed).
 */
export function withRunActiveRefusal(
  useCase: Pick<CancelPreparedAttemptPort, "cancelPreparedAttempt">,
  runRepo: Pick<LaneRunRepositoryPort, "list">,
  runJournal: Pick<LaneRunJournalPort, "listForRun">,
): {
  cancelPreparedAttempt(
    request: CancelPreparedAttemptRequest,
  ): Promise<GuardedCancelPreparedResult>;
} {
  return {
    async cancelPreparedAttempt(
      request: CancelPreparedAttemptRequest,
    ): Promise<GuardedCancelPreparedResult> {
      const liveRun = await findLiveRunForAttempt(
        runRepo,
        runJournal,
        request.attemptId,
      );
      if (liveRun !== null) {
        return {
          outcome: "refused",
          reason: "run-active",
          runId: liveRun.runId,
        };
      }
      return useCase.cancelPreparedAttempt(request);
    },
  };
}
