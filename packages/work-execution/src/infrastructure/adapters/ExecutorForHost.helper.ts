// Lane H9b2: one CommandExecutorPort per recorded host.
/**
 * ExecutorForHost is the infrastructure helper the composition roots wire
 * into the workspace and artifact reads (and the CLI's `readGitHead` and
 * forge push): given the attempt's recorded runner block, it returns the
 * `CommandExecutorPort` for the host the attempt actually ran on.
 *
 * - **Legacy** (no recorded host block at all, or no alias on a v1 or absent
 *   installation): the single legacy executor the composition root built —
 *   today's `roleExecutors.worktree` — exactly as before.
 * - **Recorded `hostName`:** the host is confirmed against the current
 *   installation with the shared confirm-or-unknown comparison
 *   (`ConfirmRecordedHost`, the same rule H9b1's RunnerForAttemptAdapter
 *   enforces; a missing, renamed or changed host refuses naming the recorded
 *   host). A confirmed local host gets a `LocalExecutor`; a confirmed ssh
 *   host gets an `SshExecutor` with the host's alias. One executor is built
 *   and cached per host name.
 *
 * A record that names a host alias while carrying no `hostName` (an older
 * hand-run ssh record on a v2 installation) resolves through the one
 * installation ssh host with that alias, or is refused; it never falls back
 * to the local executor (owner decision D2).
 */

import type { AttemptRunnerRecord } from "../../domain/execution-records.js";
import { runnerHasHostName } from "../../domain/execution-records.js";
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
   * back to another host. A record that names a host alias without a host
   * name resolves through that alias on a v2 installation, or is refused —
   * never the local executor.
   */
  executorForRecordedHost(
    recorded: AttemptRunnerRecord | null | undefined,
  ): ExecutorForRecordedHostResult {
    if (
      recorded === null ||
      recorded === undefined ||
      !hasRecordedHostName(recorded)
    ) {
      // An older hand-run ssh record names only an alias; on a v2
      // installation it resolves through that alias or is refused, never
      // local (D2). No record, an empty alias or a v1/absent installation
      // keeps the legacy executor.
      const alias = recorded?.host?.trim() ?? "";
      if (
        this.options?.hosts !== undefined &&
        recorded !== null &&
        recorded !== undefined &&
        alias !== "" &&
        !runnerHasHostName(recorded)
      ) {
        const matches = Object.entries(this.options.hosts).filter(
          ([, spec]) =>
            spec.transport === "ssh" && (spec.sshAlias?.trim() ?? "") === alias,
        );
        if (matches.length !== 1) {
          return {
            ok: false,
            reason:
              "the attempt names a host alias that matches no single installation host",
          };
        }
        const [name, spec] = matches[0]!;
        return this.executorForConfirmedHost(name, spec, "ssh");
      }
      return { ok: true, executor: this.options.legacyExecutor };
    }
    const confirmed = confirmRecordedHost(recorded, this.options?.hosts);
    if (!confirmed.ok) {
      return { ok: false, reason: confirmed.reason };
    }
    return this.executorForConfirmedHost(
      confirmed.name,
      confirmed.spec,
      confirmed.transport,
    );
  }

  /** Build (or reuse the cached) executor for a resolved installation host. */
  private executorForConfirmedHost(
    name: string,
    spec: RunnerForAttemptHostSpec,
    transport: "local" | "ssh",
  ): ExecutorForRecordedHostResult {
    const cached = this.executors.get(name);
    if (cached !== undefined) return { ok: true, executor: cached };
    const built =
      transport === "ssh"
        ? new SshExecutor({ host: spec.sshAlias?.trim() ?? "" })
        : new LocalExecutor();
    this.executors.set(name, built);
    return { ok: true, executor: built };
  }
}
