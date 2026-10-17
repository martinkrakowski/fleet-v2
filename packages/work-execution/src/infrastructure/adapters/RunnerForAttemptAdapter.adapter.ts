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
 */

import type {
  ExecutionRunnerPort,
  RunnerIsolationCapabilities,
} from '../../application/ports/out/ExecutionRunnerPort.out-port.js';
import type {
  RunnerForAttemptPort,
  RunnerForAttemptRequest,
  RunnerForAttemptResult,
} from '../../application/ports/out/RunnerForAttemptPort.out-port.js';
import type { CommandExecutorPort } from '../../application/ports/out/CommandExecutorPort.out-port.js';
import type { AttemptRecord, RunnerKind } from '../../domain/execution-records.js';
import {
  ExecutionRunnerAdapter,
  type ExecutionRunnerHost,
  type SubprocessRunner,
} from './ExecutionRunnerAdapter.adapter.js';

/**
 * One host as this adapter reads it — a structural subset of
 * `@fleet/installation`'s host section and derived model, so work-execution
 * stays free of a dependency on that package.
 */
export interface RunnerForAttemptHostSpec {
  readonly transport?: 'local' | 'ssh';
  readonly sshAlias?: string;
  readonly roles?: readonly string[];
  readonly runner?: {
    readonly kind?: RunnerKind;
    readonly port?: number;
    readonly authFile?: string;
  };
}

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
  readonly runnerTransport?: 'local' | 'ssh';
  readonly resolveWorktreePath?: (attemptId: string) => Promise<string | null> | string | null;
  readonly resolveAttempt?: (
    attemptId: string,
  ) => Promise<AttemptRecord | null> | AttemptRecord | null;
}

/** The confirm-or-unknown refusal, naming the recorded host. */
function changedReason(hostName: string): RunnerForAttemptResult {
  return { ok: false, reason: `recorded host ${hostName} changed or was removed` };
}

export class RunnerForAttemptAdapter implements RunnerForAttemptPort {
  /** One adapter per host name, built once and cached. */
  private readonly adapters = new Map<string, ExecutionRunnerPort>();

  constructor(private readonly options: RunnerForAttemptAdapterOptions) {}

  runnerForAttempt(request: RunnerForAttemptRequest): RunnerForAttemptResult {
    const recorded = request.runner;
    const recordedHostName = recorded?.hostName;
    if (
      recorded === null ||
      recorded === undefined ||
      recordedHostName === null ||
      recordedHostName === undefined ||
      recordedHostName.trim() === ''
    ) {
      // Legacy attempt: the single legacy runner, exactly as today.
      return { ok: true, runner: this.options.legacyRunner };
    }

    const name = recordedHostName.trim();
    const hosts = this.options?.hosts;
    const spec = hosts?.[name];
    if (spec === undefined) {
      return changedReason(name);
    }
    if (spec.roles !== undefined && !spec.roles.includes('lane-runner')) {
      // The host exists but no longer serves the lane-runner role: it has
      // changed; never fall back to whichever host does.
      return changedReason(name);
    }

    const currentKind = spec.runner?.kind ?? 'opencode';
    if (recorded.kind !== currentKind) {
      return changedReason(name);
    }

    const currentTransport = spec.transport === 'ssh' ? 'ssh' : 'local';
    // A v2 dispatch records the ssh alias on `host` for an ssh host and
    // `null` for a local host, so the recorded alias decides the transport.
    const recordedAlias = recorded.host?.trim() ?? '';
    const recordedTransport = recordedAlias !== '' ? 'ssh' : 'local';
    if (currentTransport !== recordedTransport) {
      return changedReason(name);
    }
    if (currentTransport === 'ssh') {
      const currentAlias = spec.sshAlias?.trim() ?? '';
      if (currentAlias === '' || currentAlias !== recordedAlias) {
        return changedReason(name);
      }
    }

    const currentPort = typeof spec.runner?.port === 'number' ? spec.runner.port : null;
    if ((recorded.remotePort ?? null) !== currentPort) {
      return changedReason(name);
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
    transport: 'local' | 'ssh',
  ): ExecutionRunnerPort {
    const host: ExecutionRunnerHost = {
      hostName: name,
      transport,
      ...(transport === 'ssh' && spec.sshAlias !== undefined ? { sshAlias: spec.sshAlias } : {}),
      remotePort: typeof spec.runner?.port === 'number' ? spec.runner.port : null,
      ...(spec.runner?.authFile !== undefined && spec.runner.authFile.trim() !== ''
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
      ...(this.options?.resolveWorktreePath !== undefined
        ? { resolveWorktreePath: this.options.resolveWorktreePath }
        : {}),
      ...(this.options?.resolveAttempt !== undefined
        ? { resolveAttempt: this.options.resolveAttempt }
        : {}),
    });
  }
}
