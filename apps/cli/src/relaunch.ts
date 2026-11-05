/**
 * The `relaunch` command group (cutover plan CO26): the read-only
 * `relaunch inventory`. It reports, per lane host, the registered clones'
 * worktree listing, the runner's state per worktree directory, the
 * conductor's status and each lane's population (conducted, attempt-recorded,
 * unrecorded). Risk flags are counts only; the worktree paths are printed
 * here, in the local CLI output. It writes nothing and mutates no worktree.
 */

import { optStr, type CommandHandler } from './commands/payload.js';
import type { FleetCliRuntime } from './composition.js';
import type { AttemptRunnerRecord, RelaunchCloneRef } from '@fleet/work-execution';
import type { HostSection } from '@fleet/installation';

/** The host's recorded runner block; null when the host is not in the installation. */
function recordedHostOf(hostName: string, rt: FleetCliRuntime): AttemptRunnerRecord | null {
  const host: HostSection | undefined = rt.installation?.hosts?.[hostName];
  if (host === undefined) return null;
  const kind = host.runner?.kind ?? 'opencode';
  return {
    kind,
    remotePort: kind === 'agy' ? null : host.runner?.port ?? null,
    host: host.transport === 'ssh' ? host.sshAlias ?? null : null,
    hostName,
    agent: null,
    model: null,
    variant: null,
  };
}

export const relaunchCommands: Readonly<Record<string, CommandHandler>> = {
  inventory: async (p, rt) => {
    const hostName = optStr(p, 'host') ?? null;
    // D18: only the clones of active project profiles are read; never a
    // host-wide scan. An unreadable profile listing reports zero hosts.
    const profiles = await rt.coordination.listProjectProfiles.listProjectProfiles({ status: 'active' });
    const clones: RelaunchCloneRef[] = [];
    if (profiles.outcome === 'listed') {
      for (const profile of profiles.profiles) {
        if (profile.status !== 'active') continue;
        for (const [cloneHost, clone] of Object.entries(profile.clones)) {
          if (hostName !== null && cloneHost !== hostName) continue;
          clones.push({
            projectId: profile.projectId,
            hostName: cloneHost,
            clonePath: clone.path,
            worktreeRoot: clone.worktreeRoot,
            recordedHost: recordedHostOf(cloneHost, rt),
          });
        }
      }
    }
    return rt.execution.inventoryRelaunch.inventoryRelaunch({
      nowIso: new Date().toISOString(),
      hostName,
      clones,
    });
  },
};
