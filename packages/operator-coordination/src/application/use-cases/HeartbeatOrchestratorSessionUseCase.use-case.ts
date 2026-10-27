/**
 * HeartbeatOrchestratorSessionUseCase implements HeartbeatOrchestratorSessionPort.
 * It renews an active session's lease from the injected clock, writing only the
 * lease, so the store announces a heartbeat rather than a data change.
 */

import { OrchestratorSession } from '../../domain/entities/OrchestratorSession.js';
import type { OrchestratorSessionRecord } from '../../domain/orchestrator-session-records.js';
import {
  OrchestratorSessionRevisionConflictError,
  type OrchestratorSessionRepositoryPort,
} from '../ports/out/OrchestratorSessionRepositoryPort.out-port.js';
import type {
  HeartbeatOrchestratorSessionPort,
  HeartbeatOrchestratorSessionResult,
} from '../ports/in/HeartbeatOrchestratorSessionPort.in-port.js';
import type { OrchestratorSessionClock } from '../ports/in/RegisterOrchestratorSessionPort.in-port.js';

export interface HeartbeatOrchestratorSessionDependencies {
  readonly sessionRepo: OrchestratorSessionRepositoryPort;
  readonly clock: OrchestratorSessionClock;
}

type RenewResult =
  | { readonly ok: true; readonly session: OrchestratorSessionRecord }
  | { readonly ok: false; readonly reason: string };

export class HeartbeatOrchestratorSessionUseCase implements HeartbeatOrchestratorSessionPort {
  constructor(private readonly deps?: HeartbeatOrchestratorSessionDependencies) {}

  async heartbeatOrchestratorSession(
    request: { orchestratorId: string },
  ): Promise<HeartbeatOrchestratorSessionResult> {
    return this.execute(request);
  }

  async execute(input: unknown): Promise<HeartbeatOrchestratorSessionResult> {
    // Unconfigured is 501 and is checked before any request validation.
    if (!this.deps) {
      throw new Error('Not implemented: HeartbeatOrchestratorSessionUseCase');
    }
    const orchestratorId = orchestratorIdFrom(input);
    if (orchestratorId === null) {
      return { outcome: 'refused', reason: 'an orchestratorId is required' };
    }
    let stored = await this.deps.sessionRepo.get(orchestratorId);
    if (stored === null) {
      return { outcome: 'not-found' };
    }
    let renewed = renewSession(stored.session, this.deps.clock.nowIso());
    if (!renewed.ok) {
      return { outcome: 'refused', reason: renewed.reason };
    }
    try {
      const saved = await this.deps.sessionRepo.save(renewed.session, stored.revision);
      return { outcome: 'renewed', session: saved.session, revision: saved.revision };
    } catch (error) {
      if (!(error instanceof OrchestratorSessionRevisionConflictError)) {
        throw error;
      }
    }

    // One conflict: re-read once and retry the renew-and-save once.
    stored = await this.deps.sessionRepo.get(orchestratorId);
    if (stored === null) {
      return { outcome: 'not-found' };
    }
    renewed = renewSession(stored.session, this.deps.clock.nowIso());
    if (!renewed.ok) {
      return { outcome: 'refused', reason: renewed.reason };
    }
    try {
      const saved = await this.deps.sessionRepo.save(renewed.session, stored.revision);
      return { outcome: 'renewed', session: saved.session, revision: saved.revision };
    } catch (secondError) {
      if (secondError instanceof OrchestratorSessionRevisionConflictError) {
        return {
          outcome: 'refused',
          reason: 'another writer moved this session first; heartbeat again',
        };
      }
      throw secondError;
    }
  }
}

function renewSession(session: OrchestratorSessionRecord, nowIso: string): RenewResult {
  const loaded = OrchestratorSession.create(session);
  if (!loaded.success) {
    return { ok: false, reason: loaded.error.message };
  }
  const result = loaded.value.renewLease(nowIso);
  if (!result.success) {
    return { ok: false, reason: result.error.message };
  }
  return { ok: true, session: result.value.toRecord() };
}

function orchestratorIdFrom(input: unknown): string | null {
  if (typeof input !== 'object' || input === null) {
    return null;
  }
  const value = (input as { orchestratorId?: unknown }).orchestratorId;
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}
