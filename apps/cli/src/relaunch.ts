/**
 * The `relaunch` command group (cutover plan CO26, CO29a): the read-only
 * `relaunch inventory` and `relaunch plan`. The inventory reports, per lane
 * host, the registered clones' worktree listing, the runner's state per
 * worktree directory, the conductor's status and each lane's population
 * (conducted, attempt-recorded, unrecorded); its risk flags are counts only
 * and the worktree paths are printed here, in the local CLI output. The plan
 * orders the relaunch of those lanes and stores one immutable plan by digest;
 * its output carries ids, counts, digests and fixed codes, never a path. Both
 * stop, abort, adopt and dispatch nothing and mutate no worktree.
 */

import { optStr, type CommandHandler, type Payload } from './commands/payload.js';
import type { FleetCliRuntime } from './composition.js';
import type {
  AttemptRunnerRecord,
  InventoryRelaunchResult,
  PlanRelaunchResult,
  RelaunchCloneRef,
} from '@fleet/work-execution';
import type { HostSection } from '@fleet/installation';

/**
 * The host's recorded runner block, or null when the host is not in the
 * installation. A null block routes no read: the inventory reports that
 * host as unknown instead of inspecting the path on the local executor.
 */
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

/** The refusal for unreadable profile records (exit 1). */
const UNREADABLE: InventoryRelaunchResult = { outcome: 'refused', reason: 'records-unreadable' };

/** The unknown for unreadable profile records: no clone list, so no plan (exit 1). */
const PROFILES_UNREADABLE: PlanRelaunchResult = { outcome: 'unknown', reasons: ['profile-records-unreadable'] };

/**
 * D18: only the clones of active project profiles are read; never a host-wide
 * scan. An unreadable profile listing is not "no clones": it is null, and the
 * caller refuses rather than reporting zero hosts.
 */
async function activeClones(hostName: string | null, rt: FleetCliRuntime): Promise<RelaunchCloneRef[] | null> {
  let profiles: Awaited<ReturnType<FleetCliRuntime['coordination']['listProjectProfiles']['listProjectProfiles']>>;
  try {
    profiles = await rt.coordination.listProjectProfiles.listProjectProfiles({ status: 'active' });
  } catch {
    return null;
  }
  if (profiles.outcome !== 'listed') return null;
  const clones: RelaunchCloneRef[] = [];
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
  return clones;
}

/** An integer string becomes a number; anything else reaches the use case as given and is refused there. */
function coerceInteger(value: unknown): unknown {
  return typeof value === 'string' && /^-?\d+$/.test(value) ? Number(value) : value;
}

/** Whether the operator supplied `key`; an omitted flag keeps the use case's default. */
function supplied(p: Payload, key: string): boolean {
  return Object.hasOwn(p, key) && p[key] !== undefined;
}

export const relaunchCommands: Readonly<Record<string, CommandHandler>> = {
  inventory: async (p, rt) => {
    const hostName = optStr(p, 'host') ?? null;
    const clones = await activeClones(hostName, rt);
    if (clones === null) return UNREADABLE;
    return rt.execution.inventoryRelaunch.inventoryRelaunch({
      nowIso: new Date().toISOString(),
      hostName,
      clones,
    });
  },
  plan: async (p, rt) => {
    const hostName = optStr(p, 'host') ?? null;
    const clones = await activeClones(hostName, rt);
    if (clones === null) return PROFILES_UNREADABLE;
    return rt.execution.planRelaunch.planRelaunch({
      nowIso: optStr(p, 'now') ?? new Date().toISOString(),
      hostName,
      clones,
      ...(supplied(p, 'maxActiveRuns') ? { maxActiveRuns: coerceInteger(p.maxActiveRuns) as number } : {}),
      ...(supplied(p, 'dispatchStaggerMs') ? { dispatchStaggerMs: coerceInteger(p.dispatchStaggerMs) as number } : {}),
      ...(supplied(p, 'deadline') ? { deadlineIso: p.deadline as string } : {}),
    });
  },
};
