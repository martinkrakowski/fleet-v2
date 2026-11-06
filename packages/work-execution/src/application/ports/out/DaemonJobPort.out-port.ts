// @generated outbound contract scaffold — refined for lane DT10a.
/**
 * DaemonJobPort: one registered daemon job (daemon-tick plan §3.2). The tick
 * takes the job's lease by `leaseScope` before it calls `pass`, releases it
 * after, and records the outcome. The job takes no lease itself and writes no
 * status. `jobId` is `merge-pass:<repoDigest>`, `notifier` or
 * `replan-digest`; `leaseScope` is `merge/<repoDigest>` or the job id.
 */
import type { DaemonJobOutcome } from '../../../domain/daemon-tick.js';

export interface DaemonJobPassRequest {
  /** The tick's now, read once before the job starts. */
  readonly nowIso: string;
  /** The tick's deadline: every call inside the job takes min(timeout, deadline − now). */
  readonly deadlineIso: string;
}

export interface DaemonJobPort {
  readonly jobId: string;
  readonly leaseScope: string;
  pass(request: DaemonJobPassRequest): Promise<DaemonJobOutcome>;
}
