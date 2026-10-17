// Lane H9b2: one CommandExecutorPort per recorded host.
/**
 * ExecutorForHost is the infrastructure helper the composition roots wire
 * into the workspace and artifact reads (and the CLI's `readGitHead` and
 * forge push): given the attempt's recorded runner block, it returns the
 * `CommandExecutorPort` for the host the attempt actually ran on.
 *
 * - **Legacy** (no recorded `hostName`; v1, absent or pre-H9a records): the
 *   single legacy executor the composition root built — today's
 *   `roleExecutors.worktree` — exactly as before.
 * - **Recorded `hostName`:** the host is confirmed against the current
 *   installation with the shared confirm-or-unknown comparison
 *   (`ConfirmRecordedHost`, the same rule H9b1's RunnerForAttemptAdapter
 *   enforces; a missing, renamed or changed host refuses naming the recorded
 *   host). A confirmed local host gets a `LocalExecutor`; a confirmed ssh
 *   host gets an `SshExecutor` with the host's alias. One executor is built
 *   and cached per host name.
 */

import type { AttemptRunnerRecord } from "../../domain/execution-records.js";
import type { CommandExecutorPort } from "../../application/ports/out/CommandExecutorPort.out-port.js";
import { LocalExecutor } from "./LocalExecutor.adapter.js";
import { SshExecutor } from "./SshExecutor.adapter.js";
import {
  confirmRecordedHost,
  hasRecordedHostName,
  type RunnerForAttemptHostSpec,
} from "./ConfirmRecordedHost.js";

export interface ExecutorForHostOptions {
  /**
   * The current installation's hosts by name (the loader-validated host-map
   * keys). An omitted or empty record means every recorded host is gone.
   */
  readonly hosts?: Readonly<Record<string, RunnerForAttemptHostSpec>>;
  /**
   * The single legacy executor the composition root built (today's
   * worktree-role executor); used for attempts recorded without a
   * `hostName`.
   */
  readonly legacyExecutor: CommandExecutorPort;
}

/** `ok: true` carries the executor for the recorded host; `ok: false` refuses. */
export type ExecutorForRecordedHostResult =
  | { readonly ok: true; readonly executor: CommandExecutorPort }
  | { readonly ok: false; readonly reason: string };

export class ExecutorForHost {
  /** One executor per host name, built once and cached. */
  private readonly executors = new Map<string, CommandExecutorPort>();

  constructor(private readonly options: ExecutorForHostOptions) {}

  /**
   * The executor for the attempt's recorded host. A legacy record returns
   * the legacy executor; a recorded host is confirmed first and never falls
   * back to another host.
   */
  executorForRecordedHost(
    recorded: AttemptRunnerRecord | null | undefined,
  ): ExecutorForRecordedHostResult {
    if (recorded === null || recorded === undefined || !hasRecordedHostName(recorded)) {
      return { ok: true, executor: this.options.legacyExecutor };
    }
    const confirmed = confirmRecordedHost(recorded, this.options?.hosts);
    if (!confirmed.ok) {
      return { ok: false, reason: confirmed.reason };
    }
    const cached = this.executors.get(confirmed.name);
    if (cached !== undefined) return { ok: true, executor: cached };
    const built =
      confirmed.transport === "ssh"
        ? new SshExecutor({ host: confirmed.spec.sshAlias?.trim() ?? "" })
        : new LocalExecutor();
    this.executors.set(confirmed.name, built);
    return { ok: true, executor: built };
  }
}
