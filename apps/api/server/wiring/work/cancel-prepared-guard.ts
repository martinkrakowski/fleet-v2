import {
  laneRunJournalState,
  LANE_RUN_TERMINAL_STATES,
  type CancelPreparedAttemptPort,
  type CancelPreparedAttemptRequest,
  type CancelPreparedAttemptResult,
  type LaneRunJournalPort,
  type LaneRunRepositoryPort,
  type LaneRunStateValue,
} from "@fleet/work-execution";

export type GuardedCancelPreparedResult =
  | CancelPreparedAttemptResult
  | { readonly outcome: "refused"; readonly reason: "run-active"; readonly runId: string };

/**
 * Wraps the API's own `CancelPreparedAttemptUseCase` instance with EX-1a's
 * run-active refusal. The loop copies the CLI's `attempt cancel-prepared`
 * check; it should later move into the use case so the CLI and the API share
 * one rule. Reads are not wrapped: a read failure propagates (fail-closed).
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
      for (const run of await runRepo.list()) {
        if (run.attemptIds.includes(request.attemptId)) {
          const state = laneRunJournalState(
            await runJournal.listForRun(run.runId),
            run.runId,
          );
          if (
            !(LANE_RUN_TERMINAL_STATES as readonly LaneRunStateValue[]).includes(
              state,
            )
          ) {
            return {
              outcome: "refused",
              reason: "run-active",
              runId: run.runId,
            };
          }
        }
      }
      return useCase.cancelPreparedAttempt(request);
    },
  };
}
