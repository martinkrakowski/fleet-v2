import {
  snapshotPlainDataRecord,
  type LaneRunRepositoryPort,
  type StopAttemptRequest,
  type StopAttemptResult,
} from "@fleet/work-execution";
import type { StopAttemptUseCase } from "@fleet/work-execution/use-cases";

export type GuardedStopAttemptResult =
  | StopAttemptResult
  | { readonly outcome: "refused"; readonly reason: "run-owned"; readonly runId: string }
  | { readonly outcome: "unknown"; readonly reason: "run-ownership-unknown" };

/** The guarded stop boundary both the route's calls go through. */
export interface GuardedStopAttemptUseCase {
  execute(input?: unknown): Promise<GuardedStopAttemptResult>;
  stopAttempt(request: StopAttemptRequest): Promise<GuardedStopAttemptResult>;
}

/**
 * Wraps the API's own `StopAttemptUseCase` instance with the run-owned refusal
 * (web-UI plan §3.4, conductor plan §3.8): an attempt any lane run lists —
 * active or terminal — is stopped only through the conductor driver, so a
 * standalone stop of it is refused with a `runId` pointer. Reads of the run
 * store fail closed: when `lane-runs.json` is unreadable the ownership is
 * unknown, the use case is never invoked, and the caller reports unknown.
 *
 * The input is inspected through its own property descriptors (never a
 * getter), so a throwing Proxy or accessor cannot escape. A non-plain input
 * is refused without touching the run store; a missing `attemptId` is left to
 * the use case's own validation.
 */
export function withRunOwnedStopRefusal(
  useCase: Pick<StopAttemptUseCase, "execute" | "stopAttempt">,
  runRepo: Pick<LaneRunRepositoryPort, "list">,
): GuardedStopAttemptUseCase {
  async function guard(input: unknown): Promise<GuardedStopAttemptResult> {
    let snapshot: Record<string, unknown> | null;
    try {
      snapshot = snapshotPlainDataRecord(input);
    } catch {
      snapshot = null;
    }
    if (snapshot === null) {
      return { outcome: "refused", reason: "invalid-request" };
    }
    const rawAttemptId = snapshot.attemptId;
    if (typeof rawAttemptId !== "string" || rawAttemptId.trim().length === 0) {
      return useCase.execute(snapshot);
    }
    const attemptId = rawAttemptId.trim();

    let runs: readonly { readonly runId: string; readonly attemptIds: readonly string[] }[];
    try {
      runs = await runRepo.list();
    } catch {
      return { outcome: "unknown", reason: "run-ownership-unknown" };
    }
    // Deterministic ownership: the first run, by run id ascending, that lists
    // the attempt owns it, terminal or not.
    const owned = runs
      .slice()
      .sort((a, b) => a.runId.localeCompare(b.runId))
      .find((run) => run.attemptIds.includes(attemptId));
    if (owned !== undefined) {
      return { outcome: "refused", reason: "run-owned", runId: owned.runId };
    }
    return useCase.execute(snapshot);
  }

  return {
    async execute(input?: unknown): Promise<GuardedStopAttemptResult> {
      return guard(input);
    },
    async stopAttempt(request: StopAttemptRequest): Promise<GuardedStopAttemptResult> {
      return guard(request);
    },
  };
}
