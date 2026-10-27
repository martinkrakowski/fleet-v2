/**
 * RegisterOrchestratorSessionUseCase implements RegisterOrchestratorSessionPort.
 * It records a new active orchestrator session from a closed registration body,
 * using the injected clock for every time. A session's scopes come only from
 * the presenting token's own scopes, passed separately by the composition
 * root; a body that carries scopes, status or times is refused before anything
 * is stored, and a token holding a scope a session may not hold can never
 * register. A registered session grants nothing.
 */

import {
  OrchestratorSession,
  ORCHESTRATOR_SESSION_LEASE_SECONDS,
} from '../../domain/entities/OrchestratorSession.js';
import { ORCHESTRATOR_SESSION_SCOPES } from '../../domain/orchestrator-session-records.js';
import {
  OrchestratorSessionRevisionConflictError,
  type OrchestratorSessionRepositoryPort,
} from '../ports/out/OrchestratorSessionRepositoryPort.out-port.js';
import type {
  OrchestratorSessionClock,
  RegisterOrchestratorSessionPort,
  RegisterOrchestratorSessionResult,
} from '../ports/in/RegisterOrchestratorSessionPort.in-port.js';

export interface RegisterOrchestratorSessionDependencies {
  readonly sessionRepo: OrchestratorSessionRepositoryPort;
  readonly clock: OrchestratorSessionClock;
}

/** The registration body is closed: exactly these keys, never scopes, status or times. */
const REGISTRATION_BODY_KEYS: readonly string[] = [
  'orchestratorId',
  'cliKind',
  'model',
  'host',
  'projects',
  'claims',
];

type RegistrationBodyRead =
  | { readonly ok: true; readonly value: Record<string, unknown> }
  | { readonly ok: false; readonly reason: 'record' | 'unknown-key' }
  | { readonly ok: false; readonly reason: 'missing-key'; readonly key: string };

/** Read the closed registration body by descriptor, like the domain reads its records. */
function readClosedRegistrationBody(body: unknown): RegistrationBodyRead {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, reason: 'record' };
  }
  const prototype = Object.getPrototypeOf(body);
  if (prototype !== Object.prototype && prototype !== null) {
    return { ok: false, reason: 'record' };
  }
  const ownKeys = Reflect.ownKeys(body);
  // Own keys are distinct, so more keys than the closed set means an unknown one.
  if (ownKeys.length > REGISTRATION_BODY_KEYS.length) {
    return { ok: false, reason: 'unknown-key' };
  }
  const value: Record<string, unknown> = {};
  for (const key of ownKeys) {
    if (typeof key !== 'string' || !REGISTRATION_BODY_KEYS.includes(key)) {
      return { ok: false, reason: 'unknown-key' };
    }
    const descriptor = Object.getOwnPropertyDescriptor(body, key);
    if (descriptor === undefined || !descriptor.enumerable) {
      return { ok: false, reason: 'unknown-key' };
    }
    value[key] = descriptor.value;
  }
  // Named from the closed list, never from the input.
  const missing = REGISTRATION_BODY_KEYS.find((key) => !Object.hasOwn(value, key));
  if (missing !== undefined) {
    return { ok: false, reason: 'missing-key', key: missing };
  }
  return { ok: true, value };
}

function registrationBodyRefusal(read: Exclude<RegistrationBodyRead, { ok: true }>): string {
  switch (read.reason) {
    case 'record':
      return 'OrchestratorSession registration requires a record';
    case 'unknown-key':
      return 'OrchestratorSession registration has an unknown key';
    case 'missing-key':
      return `OrchestratorSession registration is missing the key ${read.key}`;
  }
}

export class RegisterOrchestratorSessionUseCase implements RegisterOrchestratorSessionPort {
  constructor(private readonly deps?: RegisterOrchestratorSessionDependencies) {}

  async registerOrchestratorSession(
    body: unknown,
    presentedScopes: readonly string[],
  ): Promise<RegisterOrchestratorSessionResult> {
    return this.execute(body, presentedScopes);
  }

  async execute(body: unknown, presentedScopes: unknown): Promise<RegisterOrchestratorSessionResult> {
    // Unconfigured is 501 and is checked before any request validation.
    if (!this.deps) {
      throw new Error('Not implemented: RegisterOrchestratorSessionUseCase');
    }

    // 1. The body is a closed plain object with exactly the six registration keys.
    const read = readClosedRegistrationBody(body);
    if (!read.ok) {
      return {
        outcome: 'refused',
        reason: registrationBodyRefusal(read),
      };
    }
    const bodyRecord = read.value;

    // Every array input is copied by index before any check, and that copy is what is stored.
    const projects = plainArrayCopy(bodyRecord.projects);
    const claims = plainArrayCopy(bodyRecord.claims);

    // 2. The presented scopes are the token's own scopes; they come only from here.
    const presentedCopy = plainArrayCopy(presentedScopes);
    if (!Array.isArray(presentedCopy)) {
      return {
        outcome: 'refused',
        reason: 'the presenting token\'s scopes could not be read',
      };
    }
    for (const scope of presentedCopy) {
      if (!ORCHESTRATOR_SESSION_SCOPES.includes(scope as never)) {
        return {
          outcome: 'refused',
          reason: 'the presenting token holds a scope an orchestrator session may not hold',
        };
      }
    }

    // 3. The clock alone supplies the times; the aggregate validates the full record.
    const nowIso = this.deps.clock.nowIso();
    if (!Number.isFinite(Date.parse(nowIso))) {
      return { outcome: 'refused', reason: 'the clock could not be read' };
    }
    const leaseUntilMs = Date.parse(nowIso) + ORCHESTRATOR_SESSION_LEASE_SECONDS * 1000;
    const createdResult = OrchestratorSession.create({
      orchestratorId: bodyRecord.orchestratorId,
      cliKind: bodyRecord.cliKind,
      model: bodyRecord.model,
      host: bodyRecord.host,
      projects,
      claims,
      scopes: presentedCopy,
      startedAtIso: nowIso,
      lastHeartbeatIso: nowIso,
      leaseUntilIso: new Date(leaseUntilMs).toISOString(),
      lastPolledRequestsAtIso: null,
      status: 'active',
    });
    if (!createdResult.success) {
      return { outcome: 'refused', reason: createdResult.error.message };
    }
    const sessionRecord = createdResult.value.toRecord();

    // 4. Retired ids are never reused; any existing id refuses.
    const existing = await this.deps.sessionRepo.get(sessionRecord.orchestratorId);
    if (existing !== null) {
      return {
        outcome: 'refused',
        reason: 'an orchestrator session with this id already exists',
      };
    }

    // 5. Save at revision 0; a moved revision means another writer claimed the id.
    try {
      const stored = await this.deps.sessionRepo.save(sessionRecord, 0);
      return { outcome: 'registered', session: stored.session, revision: stored.revision };
    } catch (error) {
      if (error instanceof OrchestratorSessionRevisionConflictError) {
        return {
          outcome: 'refused',
          reason: 'an orchestrator session with this id already exists',
        };
      }
      throw error;
    }
  }
}

/** A fresh plain array copied by index (no iterator, no species); a non-array is returned unchanged. */
function plainArrayCopy(value: unknown): unknown {
  if (!Array.isArray(value)) {
    return value;
  }
  const copy: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, index);
    copy.push(descriptor === undefined ? undefined : descriptor.value);
  }
  return copy;
}
