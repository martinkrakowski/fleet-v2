import type { AttemptRepositoryPort } from "@fleet/work-execution";
import type { PrepareFixAttemptResult } from "@fleet/work-execution";
import { PrepareFixAttemptUseCase } from "@fleet/work-execution/use-cases";

/**
 * Wraps only the API's own `PrepareFixAttemptUseCase` instance with a
 * pending-fix limit: at most one `intent-recorded` fix attempt per work order
 * over the API. The limit sits here, not inside the use case, because a
 * refused fix prepare is terminal for a conductor run's fix round — the
 * conductor's instance lives in the CLI process, so wrapping the use case
 * itself would park conductor runs `step-refused` instead of only throttling
 * the API.
 *
 * The check is read-then-act; two fixes for different priors on one work
 * order can still race, and the limiter key is the prior id, not the work
 * order.
 */
export function withPendingFixLimit(
  useCase: Pick<PrepareFixAttemptUseCase, "execute">,
  attemptRepo: Pick<
    AttemptRepositoryPort,
    "findAttemptById" | "listAttemptsByWorkOrder"
  >,
): { execute(input?: unknown): Promise<PrepareFixAttemptResult> } {
  return {
    async execute(input?: unknown): Promise<PrepareFixAttemptResult> {
      if (input !== null && typeof input === "object") {
        const request = input as Record<string, unknown>;
        const priorAttemptId = request.priorAttemptId;
        const fixAttemptId =
          typeof request.fixAttemptId === "string"
            ? request.fixAttemptId
            : undefined;
        if (typeof priorAttemptId === "string") {
          const prior = await attemptRepo.findAttemptById(priorAttemptId);
          if (prior) {
            const siblings = await attemptRepo.listAttemptsByWorkOrder(
              prior.workOrderId,
            );
            const pending = siblings.find(
              (attempt) =>
                attempt.kind === "fix" &&
                attempt.state === "intent-recorded" &&
                attempt.id !== fixAttemptId,
            );
            if (pending) {
              return {
                outcome: "refused",
                reason: `pending-fix-exists: ${pending.id}`,
              };
            }
          }
        }
      }
      return useCase.execute(input);
    },
  };
}
