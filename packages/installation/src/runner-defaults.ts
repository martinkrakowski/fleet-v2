/**
 * The runner defaults an installation file declares for one host (plan P2).
 * Pure: no clock, no filesystem, no environment, no subprocess. It answers
 * "what does a runner invocation on this host need?" from the derived model,
 * so the platform has one typed way to read the contract instead of each
 * consumer re-deriving it. A refusal is a named reason, never a default
 * value, and a refusal message never carries a value.
 */

import type { FleetInstallationModel, HostModel, HostRole } from './types.js';

export type RunnerDefaultsRefusal =
  | 'host-not-found'
  | 'no-runner'
  | 'no-port'
  | 'dial-port-out-of-range';

/** The runner defaults one host's file declares for one runner invocation. */
export interface RunnerDefaults {
  readonly hostName: string;
  readonly transport: 'local' | 'ssh';
  /** The server port on that host. */
  readonly port: number;
  /** 1 unless the file says otherwise (the offset the bundled program implements). */
  readonly tunnelOffset: number;
  /** local: port; ssh: port + tunnelOffset. */
  readonly dialPort: number;
  /** The role alias when a role is given, else the host alias. */
  readonly sshAlias?: string;
  /** The orchestrator-side auth file. */
  readonly authFile?: string;
  readonly container?: string;
}

export type RunnerDefaultsResult =
  | { readonly ok: true; readonly defaults: RunnerDefaults }
  | { readonly ok: false; readonly reason: RunnerDefaultsRefusal };

/** The effective alias for a role: `roleAliases[role]` when present, otherwise the host's own alias. */
export function resolveRoleAlias(
  model: FleetInstallationModel,
  hostName: string,
  role: HostRole,
): string | undefined {
  const host = model.hosts[hostName];
  if (host === undefined || host.transport === 'local') {
    // A local host has no alias to resolve.
    return undefined;
  }
  return host.roleAliases?.[role] ?? host.sshAlias;
}

function buildDefaults(
  hostName: string,
  host: HostModel,
  alias: string | undefined,
): RunnerDefaultsResult {
  const runner = host.runner;
  if (runner === undefined) {
    return { ok: false, reason: 'no-runner' };
  }
  if (runner.port === undefined) {
    return { ok: false, reason: 'no-port' };
  }
  const tunnelOffset = runner.tunnelOffset ?? 1;
  const dialPort = host.transport === 'local' ? runner.port : runner.port + tunnelOffset;
  if (dialPort > 65535) {
    return { ok: false, reason: 'dial-port-out-of-range' };
  }
  return {
    ok: true,
    defaults: {
      hostName,
      transport: host.transport,
      port: runner.port,
      tunnelOffset,
      dialPort,
      ...(alias !== undefined ? { sshAlias: alias } : {}),
      ...(runner.authFile !== undefined ? { authFile: runner.authFile } : {}),
      ...(host.container !== undefined ? { container: host.container } : {}),
    },
  };
}

/** The runner defaults for one named host, using the host's own alias. */
export function resolveRunnerDefaults(
  model: FleetInstallationModel,
  hostName: string,
): RunnerDefaultsResult {
  const host = model.hosts[hostName];
  if (host === undefined) {
    return { ok: false, reason: 'host-not-found' };
  }
  return buildDefaults(hostName, host, host.transport === 'local' ? undefined : host.sshAlias);
}

/** The runner defaults for the host that holds `role`, using that role's alias. */
export function resolveRoleRunnerDefaults(
  model: FleetInstallationModel,
  role: HostRole,
): RunnerDefaultsResult {
  for (const hostName of Object.keys(model.hosts)) {
    const host = model.hosts[hostName];
    if (host.roles.includes(role)) {
      return buildDefaults(hostName, host, resolveRoleAlias(model, hostName, role));
    }
  }
  return { ok: false, reason: 'host-not-found' };
}
