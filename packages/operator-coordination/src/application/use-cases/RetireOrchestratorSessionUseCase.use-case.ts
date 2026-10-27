/**
 * RetireOrchestratorSessionUseCase implements RetireOrchestratorSessionPort.
 * It marks a session retired, idempotently; retirement ends its lease. A
 * retired session stays retired and its id is never reused for a new session.
 */

import { OrchestratorSession } from '../../domain/entities/OrchestratorSession.js';
import type { OrchestratorSessionRecord } from '../../domain/orchestrator-session-records.js';
import {
  OrchestratorSessionRevisionConflictError,
  type OrchestratorSessionRepositoryPort,
} from '../ports/out/OrchestratorSessionRepositoryPort.out-port.js';
import type {
  RetireOrchestratorSessionPort,
  RetireOrchestratorSessionResult,
} from '../ports/in/RetireOrchestratorSessionPort.in-port.js';
import type { OrchestratorSessionClock } from '../ports/in/RegisterOrchestratorSessionPort.in-port.js';

export interface RetireOrchestratorSessionDependencies {
  readonly sessionRepo: OrchestratorSessionRepositoryPort;
  readonly clock: OrchestratorSessionClock;
}

type RetireResult =
  | { readonly ok: true; readonly session: OrchestratorSessionRecord }
  | { readonly ok: false; readonly reason: string };

export class RetireOrchestratorSessionUseCase implements RetireOrchestratorSessionPort {
  constructor(private readonly deps?: RetireOrchestratorSessionDependencies) {}

  async retireOrchestratorSession(
    request: { orchestratorId: string },
  ): Promise<RetireOrchestratorSessionResult> {
    return this.execute(request);
  }

  async execute(input: unknown): Promise<RetireOrchestratorSessionResult> {
    // Unconfigured is 501 and is checked before any request validation.
    if (!this.deps) {
      throw new Error('Not implemented: RetireOrchestratorSessionUseCase');
    }
    const orchestratorId = orchestratorIdFrom(input);
    if (orchestratorId === null) {
      return { outcome: 'refused', reason: 'an orchestratorId is required' };
    }
    let stored = await this.deps.sessionRepo.get(orchestratorId);
    if (stored === null) {
      return { outcome: 'not-found' };
    }
    if (stored.session.status === 'retired') {
      return { outcome: 'retired', session: stored.session, revision: stored.revision };
    }
    const retired = retireSession(stored.session, this.deps.clock.nowIso());
    if (!retired.ok) {
      return { outcome: 'refused', reason: retired.reason };
    }
    try {
      const saved = await this.deps.sessionRepo.save(retired.session, stored.revision);
      return { outcome: 'retired', session: saved.session, revision: saved.revision };
    } catch (error) {
      if (!(error instanceof OrchestratorSessionRevisionConflictError)) {
        throw error;
      }
    }

    // One conflict: re-read once and retry the retire-and-save once.
    stored = await this.deps.sessionRepo.get(orchestratorId);
    if (stored === null) {
      return { outcome: 'not-found' };
    }
    if (stored.session.status === 'retired') {
      return { outcome: 'retired', session: stored.session, revision: stored.revision };
    }
    const retiredAgain = retireSession(stored.session, this.deps.clock.nowIso());
    if (!retiredAgain.ok) {
      return { outcome: 'refused', reason: retiredAgain.reason };
    }
    try {
      const saved = await this.deps.sessionRepo.save(retiredAgain.session, stored.revision);
      return { outcome: 'retired', session: saved.session, revision: saved.revision };
    } catch (secondError) {
      if (secondError instanceof OrchestratorSessionRevisionConflictError) {
        return {
          outcome: 'refused',
          reason: 'another writer moved this session first; retire again',
        };
      }
      throw secondError;
    }
  }
}

function retireSession(session: OrchestratorSessionRecord, nowIso: string): RetireResult {
  const loaded = OrchestratorSession.create(session);
  if (!loaded.success) {
    return { ok: false, reason: loaded.error.message };
  }
  const result = loaded.value.retire(nowIso);
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
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}
