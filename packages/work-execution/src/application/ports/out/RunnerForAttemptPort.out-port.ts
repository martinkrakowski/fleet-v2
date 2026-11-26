// Outbound contract: resolve the runner that addresses the host an attempt
// actually ran on (H9b1). Refined from the generated scaffold for lane H9b1.
/**
 * RunnerForAttemptPort: given the attempt's recorded runner block, return the
 * `ExecutionRunnerPort` that addresses the host the attempt ran on. The
 * recorded host is the truth after dispatch; the current installation is
 * consulted only to confirm it — a host that is missing, renamed, or now has
 * a different kind, transport, alias or port than recorded is refused and the
 * action names the recorded host. Never falls back to another host.
 *
 * A legacy attempt (no recorded `hostName`: v1, absent, or pre-H9a records)
 * uses the single legacy runner exactly as today.
 */

import type { AttemptRunnerRecord } from "../../../domain/execution-records.js";
import type { ExecutionRunnerPort } from "./ExecutionRunnerPort.out-port.js";

export interface RunnerForAttemptRequest {
  /** The attempt's recorded runner block; `null` for a legacy attempt. */
  readonly runner?: AttemptRunnerRecord | null;
}

/**
 * `ok: true` carries the runner for the recorded host. `ok: false` refuses
 * with the reason; the reason names the recorded host so the operator can
 * reconcile the installation instead of the action guessing a route.
 */
export type RunnerForAttemptResult =
  | { readonly ok: true; readonly runner: ExecutionRunnerPort }
  | { readonly ok: false; readonly reason: string };

export interface RunnerForAttemptPort {
  /** Return the runner that addresses the attempt's recorded host. */
  runnerForAttempt(request: RunnerForAttemptRequest): RunnerForAttemptResult;
}
