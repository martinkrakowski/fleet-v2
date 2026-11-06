/**
 * O9 first slice: the live conductor registers one orchestrator session with
 * `cliKind` conductor and the `start-lane-run` claim after a pass holds the
 * driver lease, heartbeats so the 90 s lease does not lapse across the poll
 * sleep, and retires that session on exit. This module holds the decisions;
 * the CLI's `conductor.ts` does all stderr I/O. Every public function never
 * throws and maps a thrown use case or input to the `-unknown` codes.
 */

import {
  HeartbeatOrchestratorSessionUseCase,
  ListOrchestratorSessionsUseCase,
  ORCHESTRATOR_SESSION_MAX_PROJECTS,
  RegisterOrchestratorSessionUseCase,
  RetireOrchestratorSessionUseCase,
  isOrchestratorAttached,
  type ListOrchestratorSessionsResult,
  type OrchestratorSessionClock,
  type OrchestratorSessionRepositoryPort,
  type ProjectProfileRecord,
} from '@fleet/operator-coordination';

/** The presenting token id: matches the session token-id pattern; never a secret. */
const CONDUCTOR_TOKEN_ID = 'conductor-driver';
/** Presented scopes exactly; never placed on the registration body. */
const CONDUCTOR_REGISTERED_SCOPES = ['orchestrate'] as const;
/** Claims exactly; never `dispatch-attempt`. */
const CONDUCTOR_CLAIMS = ['start-lane-run'] as const;
const CONDUCTOR_CLI_KIND = 'conductor';
const CONDUCTOR_MODEL: string | null = null;
/** Heartbeat gap cap, under the 90 s lease. */
const CONDUCTOR_HEARTBEAT_GAP_CAP_MS = 60_000;
/** At most this many lapsed conductor-driver sessions are retired before registering. */
const CONDUCTOR_LAPSED_SCAN_CAP = 64;
/** A longer stored-session list is unknown and writes nothing. */
const CONDUCTOR_LIST_CAP = 1000;

export type RegisterConductorOrchestratorCode =
  | 'registered'
  | 'host-unknown'
  | 'projects-over-cap'
  | 'register-refused'
  | 'register-unknown';

export interface RegisterConductorOrchestratorResult {
  readonly code: RegisterConductorOrchestratorCode;
  /** The session id; non-null only when `code` is `registered`. */
  readonly orchestratorId: string | null;
}

export interface RegisterConductorOrchestratorInput {
  readonly sessionRepo: OrchestratorSessionRepositoryPort;
  readonly listProfiles: () => Promise<readonly ProjectProfileRecord[]>;
  readonly installation: unknown;
  readonly clock: OrchestratorSessionClock;
  readonly newOrchestratorId: () => string;
}

type LocalHostRead =
  | { readonly ok: true; readonly host: string }
  | { readonly ok: false; readonly reason: 'unreadable' | 'not-local' };

/**
 * The single local host key of a readable v2 installation. `null` and
 * non-object installations are unreadable (register-unknown); a readable
 * installation that is not v2, or whose `hosts` is not a plain object with
 * exactly one `local` entry, is not local (host-unknown). A sparse array is
 * not that object; an unknown transport is not local.
 */
function localHostOf(installation: unknown): LocalHostRead {
  if (typeof installation !== 'object' || installation === null) {
    return { ok: false, reason: 'unreadable' };
  }
  let schemaVersion: unknown;
  let hosts: unknown;
  try {
    schemaVersion = (installation as { schemaVersion?: unknown }).schemaVersion;
    hosts = (installation as { hosts?: unknown }).hosts;
  } catch {
    return { ok: false, reason: 'unreadable' };
  }
  if (schemaVersion !== 2) {
    return { ok: false, reason: 'not-local' };
  }
  if (typeof hosts !== 'object' || hosts === null || Array.isArray(hosts)) {
    return { ok: false, reason: 'not-local' };
  }
  const prototype = Object.getPrototypeOf(hosts);
  if (prototype !== Object.prototype && prototype !== null) {
    return { ok: false, reason: 'not-local' };
  }
  try {
    const entries = Object.entries(hosts as Record<string, unknown>);
    if (entries.length !== 1) {
      return { ok: false, reason: 'not-local' };
    }
    const [hostName, hostValue] = entries[0]!;
    if (typeof hostValue !== 'object' || hostValue === null) {
      return { ok: false, reason: 'not-local' };
    }
    if ((hostValue as { transport?: unknown }).transport !== 'local') {
      return { ok: false, reason: 'not-local' };
    }
    return { ok: true, host: hostName };
  } catch {
    return { ok: false, reason: 'unreadable' };
  }
}

/**
 * Register one conductor orchestrator session. Never throws; every code maps
 * a throw or an unreadable input to `register-unknown`, and `register-unknown`
 * writes nothing.
 */
export async function registerConductorOrchestrator(
  input: RegisterConductorOrchestratorInput,
): Promise<RegisterConductorOrchestratorResult> {
  try {
    return await registerConductorOrchestratorUnchecked(input);
  } catch {
    return { code: 'register-unknown', orchestratorId: null };
  }
}

async function registerConductorOrchestratorUnchecked(
  input: RegisterConductorOrchestratorInput,
): Promise<RegisterConductorOrchestratorResult> {
  const hostRead = localHostOf(input.installation);
  if (!hostRead.ok) {
    return {
      code: hostRead.reason === 'unreadable' ? 'register-unknown' : 'host-unknown',
      orchestratorId: null,
    };
  }
  let nowIso: string;
  try {
    nowIso = input.clock.nowIso();
  } catch {
    return { code: 'register-unknown', orchestratorId: null };
  }
  const clock: OrchestratorSessionClock = { nowIso: () => nowIso };

  let profiles: readonly ProjectProfileRecord[];
  try {
    profiles = await input.listProfiles();
  } catch {
    return { code: 'register-unknown', orchestratorId: null };
  }
  if (!Array.isArray(profiles)) {
    return { code: 'register-unknown', orchestratorId: null };
  }
  // Active project ids only, copied by index, sorted, deduped; other statuses are left out.
  const projects = profiles
    .filter((profile) => profile.status === 'active')
    .map((profile) => profile.projectId)
    .sort()
    .filter((projectId, index, all) => index === 0 || projectId !== all[index - 1]);
  if (projects.length > ORCHESTRATOR_SESSION_MAX_PROJECTS) {
    return { code: 'projects-over-cap', orchestratorId: null };
  }

  // Before creating a session list the stored sessions; a throw or a list
  // longer than the cap writes nothing.
  const listUseCase = new ListOrchestratorSessionsUseCase({ sessionRepo: input.sessionRepo, clock });
  let listed: ListOrchestratorSessionsResult;
  try {
    listed = await listUseCase.listOrchestratorSessions();
  } catch {
    return { code: 'register-unknown', orchestratorId: null };
  }
  if (listed.sessions.length > CONDUCTOR_LIST_CAP) {
    return { code: 'register-unknown', orchestratorId: null };
  }

  // Retire up to the scan cap of lapsed conductor-driver active sessions; a
  // throw or refusal writes no new session. Attached sessions are never retired.
  const retireUseCase = new RetireOrchestratorSessionUseCase({ sessionRepo: input.sessionRepo, clock });
  let retired = 0;
  for (const entry of listed.sessions) {
    if (retired >= CONDUCTOR_LAPSED_SCAN_CAP) {
      break;
    }
    if (entry.session.cliKind !== CONDUCTOR_CLI_KIND) {
      continue;
    }
    if (entry.session.registeredByTokenId !== CONDUCTOR_TOKEN_ID) {
      continue;
    }
    if (entry.session.status !== 'active') {
      continue;
    }
    if (isOrchestratorAttached(entry.session, nowIso)) {
      continue;
    }
    try {
      const result = await retireUseCase.retireOrchestratorSession(
        { orchestratorId: entry.session.orchestratorId },
        CONDUCTOR_TOKEN_ID,
      );
      if (result.outcome !== 'retired') {
        return { code: 'register-unknown', orchestratorId: null };
      }
      retired += 1;
    } catch {
      return { code: 'register-unknown', orchestratorId: null };
    }
  }

  let orchestratorId: string;
  try {
    orchestratorId = 'orch-' + input.newOrchestratorId();
  } catch {
    return { code: 'register-unknown', orchestratorId: null };
  }
  const body = {
    orchestratorId,
    cliKind: CONDUCTOR_CLI_KIND,
    model: CONDUCTOR_MODEL,
    host: hostRead.host,
    projects,
    claims: [...CONDUCTOR_CLAIMS],
  };
  const registerUseCase = new RegisterOrchestratorSessionUseCase({ sessionRepo: input.sessionRepo, clock });
  try {
    const result = await registerUseCase.registerOrchestratorSession(
      body,
      [...CONDUCTOR_REGISTERED_SCOPES],
      CONDUCTOR_TOKEN_ID,
    );
    if (result.outcome === 'registered') {
      return { code: 'registered', orchestratorId: result.session.orchestratorId };
    }
    return { code: 'register-refused', orchestratorId: null };
  } catch {
    return { code: 'register-unknown', orchestratorId: null };
  }
}

export type ConductorHeartbeatCode = 'renewed' | 'heartbeat-refused' | 'heartbeat-unknown';

/** Heartbeat the registered session with the same token. Never throws. */
export async function heartbeatConductorOrchestrator(
  repo: OrchestratorSessionRepositoryPort,
  clock: OrchestratorSessionClock,
  orchestratorId: string,
): Promise<{ readonly code: ConductorHeartbeatCode }> {
  try {
    const useCase = new HeartbeatOrchestratorSessionUseCase({ sessionRepo: repo, clock });
    const result = await useCase.heartbeatOrchestratorSession({ orchestratorId }, CONDUCTOR_TOKEN_ID);
    return { code: result.outcome === 'renewed' ? 'renewed' : 'heartbeat-refused' };
  } catch {
    return { code: 'heartbeat-unknown' };
  }
}

export type ConductorRetireCode = 'retired' | 'retire-refused' | 'retire-unknown';

/** Retire the registered session with the same token. Never throws. */
export async function retireConductorOrchestrator(
  repo: OrchestratorSessionRepositoryPort,
  clock: OrchestratorSessionClock,
  orchestratorId: string,
): Promise<{ readonly code: ConductorRetireCode }> {
  try {
    const useCase = new RetireOrchestratorSessionUseCase({ sessionRepo: repo, clock });
    const result = await useCase.retireOrchestratorSession({ orchestratorId }, CONDUCTOR_TOKEN_ID);
    return { code: result.outcome === 'retired' ? 'retired' : 'retire-refused' };
  } catch {
    return { code: 'retire-unknown' };
  }
}

/** Cap a poll sleep to the heartbeat gap when a session is registered. */
export function pollDelayWhileRegistered(delayMs: number): number {
  if (Number.isFinite(delayMs) && delayMs >= 0) {
    return Math.min(delayMs, CONDUCTOR_HEARTBEAT_GAP_CAP_MS);
  }
  return CONDUCTOR_HEARTBEAT_GAP_CAP_MS;
}
