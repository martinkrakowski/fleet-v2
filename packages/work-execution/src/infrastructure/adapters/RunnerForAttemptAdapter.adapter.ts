// Adapter for lane H9b1: one runner adapter per recorded host.
/**
 * RunnerForAttemptAdapter implements RunnerForAttemptPort: it resolves the
 * runner that addresses the host an attempt actually ran on.
 *
 * - **Legacy** (no recorded `hostName`; v1, absent or pre-H9a records): the
 *   single legacy runner the composition root built, exactly as today. That
 *   adapter keeps enforcing the legacy confirm rule itself (the recorded
 *   alias and port must equal the single lane-runner's).
 * - **Recorded `hostName`:** the host is looked up in the CURRENT
 *   installation by its name. If it is missing, renamed, or now has a
 *   different kind, transport, alias or port than recorded, the answer is
 *   `ok: false` naming the recorded host; never a fallback to another host.
 *   Otherwise one `ExecutionRunnerAdapter` is built and cached per host name
 *   from the installation's hosts, with the same environment and options as
 *   today's single adapter, per host.
 * - **Recorded agy host:** a confirmed agy host gets an `AgyRunnerAdapter`
 *   when the root supplies an agy executor for it, and is refused otherwise
 *   (exactly as before when no executor is given).
 */

import type {
  ExecutionRunnerPort,
  RunnerIsolationCapabilities,
} from "../../application/ports/out/ExecutionRunnerPort.out-port.js";
import type {
  RunnerForAttemptPort,
  RunnerForAttemptRequest,
  RunnerForAttemptResult,
} from "../../application/ports/out/RunnerForAttemptPort.out-port.js";
import type { CommandExecutorPort } from "../../application/ports/out/CommandExecutorPort.out-port.js";
import type {
  AttemptRecord,
  AttemptRunnerRecord,
} from "../../domain/execution-records.js";
import {
  confirmRecordedHost,
  hasRecordedHostName,
  type RunnerForAttemptHostSpec,
} from "./ConfirmRecordedHost.js";
import {
  ExecutionRunnerAdapter,
  type ExecutionRunnerHost,
  type SubprocessRunner,
} from "./ExecutionRunnerAdapter.adapter.js";
import { AgyRunnerAdapter } from "./AgyRunnerAdapter.adapter.js";

export type { RunnerForAttemptHostSpec } from "./ConfirmRecordedHost.js";

// The host spec shape lives in `ConfirmRecordedHost` and is re-exported
// above, so existing imports of `RunnerForAttemptHostSpec` keep resolving.

export interface RunnerForAttemptAdapterOptions {
  /**
   * The current installation's hosts by name (the loader-validated host-map
   * keys). An omitted or empty record means every recorded host is gone.
   */
  readonly hosts?: Readonly<Record<string, RunnerForAttemptHostSpec>>;
  /**
   * The single legacy runner the composition root built (today's
   * environment-based or selected-lane-runner adapter); used for attempts
   * recorded without a `hostName`.
   */
  readonly legacyRunner: ExecutionRunnerPort;
  // --- options forwarded to each per-host ExecutionRunnerAdapter, identical
  // --- to today's single adapter's construction:
  readonly ocmRunBin?: string;
  readonly executor?: CommandExecutorPort;
  readonly runSubprocess?: SubprocessRunner;
  readonly capabilities?: Partial<RunnerIsolationCapabilities>;
  readonly runnerTransport?: "local" | "ssh";
  readonly resolveWorktreePath?: (
    attemptId: string,
  ) => Promise<string | null> | string | null;
  readonly resolveAttempt?: (
    attemptId: string,
  ) => Promise<AttemptRecord | null> | AttemptRecord | null;
  /** AG-2: the executor that runs `bin/agy-run` on a named agy lane-runner host; absent keeps agy refused. */
  readonly agyExecutorForHost?: (hostName: string) => CommandExecutorPort | null;
  /** AG-2: the agy-run script path for every agy host (the adapter's default when absent). */
  readonly agyRunBin?: string;
}

/** The confirm-or-unknown refusal, naming the recorded host. */
export class RunnerForAttemptAdapter implements RunnerForAttemptPort {
  /** One adapter per host name, built once and cached. */
  private readonly adapters = new Map<string, ExecutionRunnerPort>();

  constructor(private readonly options: RunnerForAttemptAdapterOptions) {}

  runnerForAttempt(request: RunnerForAttemptRequest): RunnerForAttemptResult {
    const recorded = request.runner;
    if (!hasRecordedHostName(recorded)) {
      // Legacy attempt: the single legacy runner, exactly as today.
      return { ok: true, runner: this.options.legacyRunner };
    }

    // H9b2: the confirm-or-unknown comparison is the shared one in
    // `ConfirmRecordedHost`, so the executor helper enforces the same rule.
    const confirmed = confirmRecordedHost(
      recorded as AttemptRunnerRecord,
      this.options?.hosts,
    );
    if (!confirmed.ok) {
      return { ok: false, reason: confirmed.reason };
    }

    const name = confirmed.name;
    const spec = confirmed.spec;
    const currentKind = spec.runner?.kind ?? "opencode";
    const currentTransport = confirmed.transport;

    // AG-2: a confirmed agy host gets an AgyRunnerAdapter when the root gives
    // an executor for that host; without one the old refusal stands unchanged.
    if (currentKind === "agy") {
      if (this.options.agyExecutorForHost === undefined) {
        return {
          ok: false,
          reason: `recorded host ${name} runner kind ${currentKind} has no adapter`,
        };
      }
      const cachedAgy = this.adapters.get(name);
      if (cachedAgy !== undefined) return { ok: true, runner: cachedAgy };
      const builtAgy = this.buildAgyRunner(name, spec, currentTransport);
      if (builtAgy === null) {
        return {
          ok: false,
          reason: `recorded host ${name} has no agy executor`,
        };
      }
      this.adapters.set(name, builtAgy);
      return { ok: true, runner: builtAgy };
    }

    // H9b1 follow-up (Fable review): only the `opencode` runner kind has an
    // ocm-run adapter. Any other confirmed kind is refused instead of
    // building an ocm-run adapter for it.
    if (currentKind !== "opencode") {
      return {
        ok: false,
        reason: `recorded host ${name} runner kind ${currentKind} has no adapter`,
      };
    }

    const cached = this.adapters.get(name);
    if (cached !== undefined) return { ok: true, runner: cached };

    const built = this.buildRunner(name, spec, currentTransport);
    this.adapters.set(name, built);
    return { ok: true, runner: built };
  }

  /** Build the runner adapter for one confirmed host (v2 mode). */
  private buildRunner(
    name: string,
    spec: RunnerForAttemptHostSpec,
    transport: "local" | "ssh",
  ): ExecutionRunnerPort {
    const host: ExecutionRunnerHost = {
      hostName: name,
      transport,
      ...(transport === "ssh" && spec.sshAlias !== undefined
        ? { sshAlias: spec.sshAlias }
        : {}),
      remotePort:
        typeof spec.runner?.port === "number" ? spec.runner.port : null,
      ...(spec.runner?.authFile !== undefined &&
      spec.runner.authFile.trim() !== ""
        ? { authFile: spec.runner.authFile }
        : {}),
    };
    return new ExecutionRunnerAdapter({
      host,
      ocmRunBin: this.options?.ocmRunBin,
      executor: this.options?.executor,
      ...(this.options?.runSubprocess !== undefined
        ? { runSubprocess: this.options.runSubprocess }
        : {}),
      ...(this.options?.capabilities !== undefined
        ? { capabilities: this.options.capabilities }
        : {}),
      ...(this.options?.runnerTransport !== undefined
        ? { runnerTransport: this.options.runnerTransport }
        : {}),
      ...this.sharedResolvers(),
    });
  }

  /** Resolvers forwarded to every per-host runner adapter (opencode and agy). */
  private sharedResolvers(): Pick<
    RunnerForAttemptAdapterOptions,
    'resolveWorktreePath' | 'resolveAttempt'
  > {
    return {
      ...(this.options?.resolveWorktreePath !== undefined
        ? { resolveWorktreePath: this.options.resolveWorktreePath }
        : {}),
      ...(this.options?.resolveAttempt !== undefined
        ? { resolveAttempt: this.options.resolveAttempt }
        : {}),
    };
  }

  /** Build the agy runner adapter for one confirmed agy host (AG-2). */
  private buildAgyRunner(
    name: string,
    spec: RunnerForAttemptHostSpec,
    transport: "local" | "ssh",
  ): ExecutionRunnerPort | null {
    const executor = this.options.agyExecutorForHost!(name);
    if (executor === null) return null;
    return new AgyRunnerAdapter({
      executor,
      hostName: name,
      ...(transport === "ssh" && spec.sshAlias !== undefined
        ? { sshAlias: spec.sshAlias }
        : {}),
      mode: spec.runner?.agyMode ?? "edit-only",
      transport,
      ...(this.options.agyRunBin !== undefined
        ? { agyRunBin: this.options.agyRunBin }
        : {}),
      ...this.sharedResolvers(),
      ...(this.options.capabilities !== undefined
        ? { capabilities: this.options.capabilities }
        : {}),
    });
  }
}
