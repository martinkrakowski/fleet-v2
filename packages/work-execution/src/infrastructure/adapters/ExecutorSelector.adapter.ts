// @generated adapter scaffold — implemented for migration station O3 (role executor selection).
/**
 * Executor selection for composition roots: pick the CommandExecutorPort for
 * each role from an installation's v2 `hosts` section, or from the v1
 * mapping. An `ssh` transport yields an `SshExecutor` with the host's alias;
 * a `local` transport (and the v1 mapping's orchestrator role) yields a
 * `LocalExecutor`. A single-machine installation therefore never constructs
 * an `SshExecutor`.
 *
 * The input is a structural subset of `@fleet/installation`'s parsed file, so
 * this module keeps work-execution free of a dependency on that package while
 * both roots (CLI and API) resolve roles identically.
 */

import { LocalExecutor } from './LocalExecutor.adapter.js';
import { SshExecutor } from './SshExecutor.adapter.js';
import type { CommandExecutorPort } from '../../application/ports/out/CommandExecutorPort.out-port.js';

/** One host as the selector needs it. */
export interface ExecutorHostSpec {
  readonly transport?: 'local' | 'ssh';
  readonly sshAlias?: string;
  readonly worktreeRoot?: string;
  readonly roles?: readonly string[];
}

/** The installation shape the selector reads (v1 sections or v2 hosts). */
export interface InstallationExecutorInputs {
  readonly worktree?: { readonly sshHost?: string };
  readonly runner?: { readonly host?: string; readonly ocmRunBin?: string };
  /** v1 carries an optional sshHost; v2 carries procedures only. */
  readonly verification?:
    | { readonly sshHost?: string }
    | { readonly procedures?: Readonly<Record<string, unknown>> };
  readonly hosts?: Readonly<Record<string, ExecutorHostSpec>>;
}

/** The executor per role. The orchestrator always runs where the root runs. */
export interface RoleExecutors {
  readonly orchestrator: CommandExecutorPort;
  readonly worktree: CommandExecutorPort;
  readonly verifier: CommandExecutorPort;
}

/** Build the executor one host spec selects: ssh alias → SshExecutor, else local. */
export function executorForHost(spec?: ExecutorHostSpec): CommandExecutorPort {
  if (spec !== undefined && spec.transport === 'ssh' && spec.sshAlias !== undefined) {
    return new SshExecutor({ host: spec.sshAlias });
  }
  return new LocalExecutor();
}

/** First host whose roles include `role`, or undefined. */
function hostWithRole(
  hosts: Readonly<Record<string, ExecutorHostSpec>> | undefined,
  role: string,
): ExecutorHostSpec | undefined {
  if (hosts === undefined) return undefined;
  for (const name of Object.keys(hosts)) {
    const host = hosts[name];
    if (host.roles?.includes(role)) return host;
  }
  return undefined;
}

/**
 * Resolve the executor per role. Explicit root overrides win over the
 * installation (matching the roots' `options ?? installation ?? env`
 * precedence). The v2 `hosts` section decides when present; the v1 mapping
 * otherwise keeps `worktree.sshHost` (worktree) and `verification.sshHost`
 * (verifier) separate from `runner.host`/`runner.ocmRunBin` (runner settings
 * the roots consume separately), and gives the v1 model a local orchestrator
 * host so every role resolves.
 */
export interface RoleExecutorOverrides {
  /** Explicit worktree ssh alias (options or environment) before the installation. */
  readonly worktreeSshHost?: string;
  /** Explicit verifier ssh alias before the installation. */
  readonly verifierSshHost?: string;
}

export function resolveRoleExecutors(
  installation?: InstallationExecutorInputs,
  overrides?: RoleExecutorOverrides,
): RoleExecutors {
  const orchestrator: CommandExecutorPort = new LocalExecutor();
  const worktreeOverride = overrides?.worktreeSshHost;
  const verifierOverride = overrides?.verifierSshHost;
  const hosts = installation?.hosts;
  if (hosts !== undefined && Object.keys(hosts).length > 0) {
    return {
      orchestrator,
      worktree:
        worktreeOverride !== undefined
          ? new SshExecutor({ host: worktreeOverride })
          : executorForHost(hostWithRole(hosts, 'lane-runner')),
      verifier:
        verifierOverride !== undefined
          ? new SshExecutor({ host: verifierOverride })
          : executorForHost(hostWithRole(hosts, 'verifier')),
    };
  }
  return {
    orchestrator,
    worktree:
      worktreeOverride !== undefined
        ? new SshExecutor({ host: worktreeOverride })
        : executorForHost(
            installation?.worktree?.sshHost !== undefined
              ? { transport: 'ssh', sshAlias: installation.worktree.sshHost }
              : undefined,
          ),
    verifier: executorForHost(verifierSpecOf(installation, verifierOverride)),
  };
}

/** The verifier host spec: explicit override, then the installation's mapping. */
function verifierSpecOf(
  installation: InstallationExecutorInputs | undefined,
  override: string | undefined,
): ExecutorHostSpec | undefined {
  if (override !== undefined) return { transport: 'ssh', sshAlias: override };
  const verification = installation?.verification;
  if (verification === undefined) return undefined;
  if ('sshHost' in verification && verification.sshHost !== undefined) {
    return { transport: 'ssh', sshAlias: verification.sshHost };
  }
  return undefined;
}
