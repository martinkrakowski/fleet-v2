// @generated adapter scaffold — implemented for migration station O3 (role executor selection).
/**
 * Executor and installation-profile selection for composition roots: pick the
 * CommandExecutorPort for each role from an installation's v2 `hosts`
 * section, or from the v1 mapping, and derive the runner capability profile
 * (D4) and the forge mode (D6) the roots wire into their adapters. An `ssh`
 * transport yields an `SshExecutor` with the host's alias; a `local`
 * transport (and the v1 mapping's orchestrator role) yields a
 * `LocalExecutor`. A single-machine installation therefore never constructs
 * an `SshExecutor`.
 *
 * The input is a structural subset of `@fleet/installation`'s derived model,
 * so this module keeps work-execution free of a dependency on that package
 * while both roots (CLI and API) resolve roles identically.
 */

import { LocalExecutor } from './LocalExecutor.adapter.js';
import { SshExecutor } from './SshExecutor.adapter.js';
import type { CommandExecutorPort } from '../../application/ports/out/CommandExecutorPort.out-port.js';
import type { RunnerIsolationCapabilities } from '../../application/ports/out/ExecutionRunnerPort.out-port.js';

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
  if (spec !== undefined && spec.transport === 'ssh') {
    if (spec.sshAlias === undefined || spec.sshAlias.trim() === '') {
      // Refuse loudly: a host that declares an ssh transport without an
      // alias must never silently degrade to a local executor.
      throw new Error(
        `Host${spec.roles?.length ? ` (roles: ${spec.roles.join(', ')})` : ''} declares transport 'ssh' without an sshAlias; refusing to fall back to a local executor`,
      );
    }
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

/** Like `hostWithRole`, but over the structural host shape the profile resolver reads. */
function runnerProfileHostWithRole(
  hosts: Readonly<Record<string, RunnerProfileHostSpec>> | undefined,
  role: string,
): RunnerProfileHostSpec | undefined {
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

// ---------------------------------------------------------------------------
// Runner capability profile (D4) and forge mode (D6), for the composition roots
// ---------------------------------------------------------------------------

/** A derived runner capability declaration, as the loader reports it. */
export interface DerivedRunnerCapabilityDeclaration {
  readonly source: 'declared' | 'undeclared' | 'legacy-asserted';
  readonly filesystemScope: 'scoped-worktree' | 'inherited-directory' | 'unknown';
  readonly networkEgressRestricted: boolean | null;
  readonly cpuAndMemoryLimited: boolean | null;
  readonly processTreeTermination: boolean | null;
}

/** Structural shape of a derived model host the profile resolver reads. */
export interface RunnerProfileHostSpec {
  readonly transport?: 'local' | 'ssh';
  readonly roles?: readonly string[];
  readonly runner?: {
    readonly capabilities?: DerivedRunnerCapabilityDeclaration;
    readonly maxLanes?: number;
  };
}

/** Structural shape of an installation's forge section the mode resolver reads. */
export interface ForgeModeInputs {
  readonly forge?: { readonly mode?: unknown; readonly owner?: string; readonly repo?: string };
}

/** The runner capability profile and capacity budget a root wires for dispatch. */
export interface RunnerCapabilityProfile {
  /** The capability report the runner adapter publishes, source included. */
  readonly capabilities: RunnerIsolationCapabilities;
  /** The lane-runner host's transport; a local host drops SSH_AUTH_SOCK (D5). */
  readonly transport: 'local' | 'ssh';
  /** The runner's declared lane budget; feeds capacity maxSlots. */
  readonly maxLanes?: number;
}

/** Today's enforced booleans for capabilities a v2 declaration does not name. */
function enforcementDefaults(): Pick<
  RunnerIsolationCapabilities,
  'authoritativeCompletion' | 'artifactPersistence'
> {
  return { authoritativeCompletion: true, artifactPersistence: true };
}

/**
 * Resolve the lane-runner host's capability profile from the derived model's
 * hosts (D4). `declared` reports the declaration verbatim with the enforced
 * defaults for the capabilities a declaration does not name; `undeclared`
 * reports `filesystemScope: "unknown"` and refuses dispatch; only the v1 and
 * env-only mapping can produce `legacy-asserted`, which keeps today's
 * behaviour. No lane-runner host (no installation, env-only) keeps the
 * adapter's own defaults.
 */
export function resolveRunnerCapabilityProfile(
  hosts: Readonly<Record<string, RunnerProfileHostSpec>> | undefined,
): RunnerCapabilityProfile | undefined {
  const host = runnerProfileHostWithRole(hosts, 'lane-runner');
  const runner = host?.runner;
  if (host === undefined || runner === undefined) {
    return undefined;
  }
  const transport = host.transport === 'ssh' ? 'ssh' : 'local';
  const maxLanes = runner.maxLanes;
  const declaration = runner.capabilities;
  if (declaration === undefined || declaration.source === 'undeclared') {
    return {
      transport,
      ...(maxLanes !== undefined ? { maxLanes } : {}),
      capabilities: {
        source: 'undeclared',
        filesystemScope: 'unknown',
        networkEgressRestricted: false,
        cpuAndMemoryLimited: false,
        processTreeTermination: false,
        ...enforcementDefaults(),
      },
    };
  }
  if (declaration.source === 'legacy-asserted') {
    return {
      transport,
      ...(maxLanes !== undefined ? { maxLanes } : {}),
      capabilities: {
        source: 'legacy-asserted',
        filesystemScope: 'scoped-worktree',
        networkEgressRestricted: true,
        cpuAndMemoryLimited: true,
        processTreeTermination: true,
        ...enforcementDefaults(),
      },
    };
  }
  return {
    transport,
    ...(maxLanes !== undefined ? { maxLanes } : {}),
    capabilities: {
      source: 'declared',
      filesystemScope: declaration.filesystemScope,
      networkEgressRestricted: declaration.networkEgressRestricted === true,
      cpuAndMemoryLimited: declaration.cpuAndMemoryLimited === true,
      processTreeTermination: declaration.processTreeTermination === true,
      ...enforcementDefaults(),
    },
  };
}

/**
 * The installation's forge mode (D6). A v2 `mode` is taken as written; a v1
 * `owner`/`repo` forge is mode `github`. No forge section is no mode: the
 * roots keep today's behaviour (fail-closed forge reads where a port is
 * bound), and `none` is never a fallback for it.
 */
export function resolveInstallationForgeMode(
  installation: ForgeModeInputs | undefined,
): 'github' | 'none' | undefined {
  const forge = installation?.forge;
  if (forge === undefined) {
    return undefined;
  }
  if (forge.mode === 'none') {
    return 'none';
  }
  if (forge.mode === 'github') {
    return 'github';
  }
  if (forge.mode === undefined && forge.owner !== undefined && forge.repo !== undefined) {
    return 'github';
  }
  return undefined;
}
