/**
 * O9b: the live conductor's thin caller over the store's one locked
 * register-or-adopt operation. This module holds the conductor's own facts
 * (its host, projects, claims, scopes and token id) and maps outcomes to
 * codes; every invariant — one active session per conductor identity, lapsed
 * retire-and-replace, adopting a retired id — lives in the store. The CLI's
 * `conductor.ts` does all stderr I/O. Every public function never throws and
 * maps a thrown use case or input to the `-unknown` codes.
 */

import {
  HeartbeatOrchestratorSessionUseCase,
  ORCHESTRATOR_SESSION_MAX_PROJECTS,
  RetireOrchestratorSessionUseCase,
  type OrchestratorSessionClock,
  type OrchestratorSessionRepositoryPort,
  type ProjectProfileRecord,
} from '@fleet/operator-coordination';

/** The presenting token id: matches the session token-id pattern; never a secret. */
const CONDUCTOR_TOKEN_ID = 'conductor-driver';
/** Presented scopes exactly; never placed on a registration body. */
const CONDUCTOR_REGISTERED_SCOPES = ['orchestrate'] as const;
/** Claims exactly; never `dispatch-attempt`. */
const CONDUCTOR_CLAIMS = ['start-lane-run'] as const;
const CONDUCTOR_MODEL: string | null = null;
/** Heartbeat gap cap, under the 90 s lease; also the during-pass beat interval. */
export const CONDUCTOR_HEARTBEAT_GAP_CAP_MS = 60_000;

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
  /**
   * The state directory of this conductor's own store, when it is known;
   * null (the default) lets the store key the identity on its own directory.
   */
  readonly stateDir?: string | null;
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
 * Register one conductor orchestrator session through the store's one locked
 * register-or-adopt operation. Never throws; every code maps a throw or an
 * unreadable input to `register-unknown`, and `register-unknown` writes
 * nothing.
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

  let orchestratorId: string;
  try {
    orchestratorId = 'orch-' + input.newOrchestratorId();
  } catch {
    return { code: 'register-unknown', orchestratorId: null };
  }

  // One locked store operation decides: adopt the identity's live session,
  // replace a lapsed one, or register. The caller makes no list-then-retire
  // decision of its own.
  const result = await input.sessionRepo.registerOrAdoptSession(
    {
      host: hostRead.host,
      stateDir: input.stateDir ?? null,
      registration: {
        orchestratorId,
        model: CONDUCTOR_MODEL,
        projects,
        claims: [...CONDUCTOR_CLAIMS],
        scopes: [...CONDUCTOR_REGISTERED_SCOPES],
        registeredByTokenId: CONDUCTOR_TOKEN_ID,
      },
    },
    nowIso,
  );
  if (result.outcome === 'refused') {
    return { code: 'register-refused', orchestratorId: null };
  }
  return { code: 'registered', orchestratorId: result.session.orchestratorId };
}

export type ConductorHeartbeatCode = 'renewed' | 'heartbeat-refused' | 'heartbeat-unknown';

/** Why a heartbeat was not renewed, when it was not. Null on `renewed` and `heartbeat-unknown`. */
export type ConductorHeartbeatRefusalKind = 'retired' | 'not-found' | 'other' | null;

const RETIRED_HEARTBEAT_REASON = 'OrchestratorSession is retired and cannot renew its lease';

/**
 * Heartbeat the registered session with the same token, and report why a
 * refused heartbeat was refused. Never throws.
 */
export async function heartbeatConductorOrchestrator(
  repo: OrchestratorSessionRepositoryPort,
  clock: OrchestratorSessionClock,
  orchestratorId: string,
): Promise<{ readonly code: ConductorHeartbeatCode; readonly refusalKind: ConductorHeartbeatRefusalKind }> {
  try {
    const useCase = new HeartbeatOrchestratorSessionUseCase({ sessionRepo: repo, clock });
    const result = await useCase.heartbeatOrchestratorSession({ orchestratorId }, CONDUCTOR_TOKEN_ID);
    if (result.outcome === 'renewed') {
      return { code: 'renewed', refusalKind: null };
    }
    if (result.outcome === 'not-found') {
      return { code: 'heartbeat-refused', refusalKind: 'not-found' };
    }
    if (
      result.outcome === 'refused' &&
      result.reason === RETIRED_HEARTBEAT_REASON
    ) {
      return { code: 'heartbeat-refused', refusalKind: 'retired' };
    }
    return { code: 'heartbeat-refused', refusalKind: 'other' };
  } catch {
    return { code: 'heartbeat-unknown', refusalKind: null };
  }
}

export interface HeartbeatOrReRegisterResult {
  readonly code: ConductorHeartbeatCode;
  /** The session id to keep beating: the new one after a successful re-registration. */
  readonly orchestratorId: string;
  /** Null unless a re-registration was attempted; then its register code. */
  readonly reRegistration: RegisterConductorOrchestratorResult['code'] | null;
}

/**
 * Heartbeat; when the store refused it because the session is retired or
 * gone, call the store's register-or-adopt operation once: it adopts the
 * live replacement or registers the single new session, never a duplicate.
 * Any other refusal (a retry that ran out, a store hiccup) stays an error.
 * Never throws.
 */
export async function heartbeatOrReRegisterConductorOrchestrator(
  input: RegisterConductorOrchestratorInput,
  orchestratorId: string,
  canReRegister: boolean,
): Promise<HeartbeatOrReRegisterResult> {
  const beat = await heartbeatConductorOrchestrator(input.sessionRepo, input.clock, orchestratorId);
  if (beat.code !== 'heartbeat-refused' || !canReRegister) {
    return { code: beat.code, orchestratorId, reRegistration: null };
  }
  // Re-register only when the store refused the session as retired or
  // missing; the one locked operation then ends with exactly one active
  // session for the identity.
  if (beat.refusalKind !== 'retired' && beat.refusalKind !== 'not-found') {
    return { code: beat.code, orchestratorId, reRegistration: null };
  }
  const registration = await registerConductorOrchestrator(input);
  return {
    code: beat.code,
    orchestratorId:
      registration.code === 'registered' && registration.orchestratorId !== null
        ? registration.orchestratorId
        : orchestratorId,
    reRegistration: registration.code,
  };
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
