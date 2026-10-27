/**
 * ListOrchestratorSessionsUseCase implements ListOrchestratorSessionsPort. It
 * is a thin read over the orchestrator session repository, optionally narrowed
 * by status; `attached` and `attentive` are derived from the injected clock,
 * never stored. An invalid filter returns an empty list. Reading writes
 * nothing.
 */

import {
  isOrchestratorAttached,
  isOrchestratorAttentive,
} from '../../domain/entities/OrchestratorSession.js';
import { ORCHESTRATOR_SESSION_STATUSES } from '../../domain/orchestrator-session-records.js';
import type { OrchestratorSessionRepositoryPort } from '../ports/out/OrchestratorSessionRepositoryPort.out-port.js';
import type {
  ListOrchestratorSessionsPort,
  ListOrchestratorSessionsRequest,
  ListOrchestratorSessionsResult,
} from '../ports/in/ListOrchestratorSessionsPort.in-port.js';
import type { OrchestratorSessionClock } from '../ports/in/RegisterOrchestratorSessionPort.in-port.js';

export interface ListOrchestratorSessionsDependencies {
  readonly sessionRepo: OrchestratorSessionRepositoryPort;
  readonly clock: OrchestratorSessionClock;
}

export class ListOrchestratorSessionsUseCase implements ListOrchestratorSessionsPort {
  constructor(private readonly deps?: ListOrchestratorSessionsDependencies) {}

  async listOrchestratorSessions(
    request?: ListOrchestratorSessionsRequest,
  ): Promise<ListOrchestratorSessionsResult> {
    return this.execute(request);
  }

  async execute(input?: unknown): Promise<ListOrchestratorSessionsResult> {
    // Unconfigured is 501 and is checked before any request validation.
    if (!this.deps) {
      throw new Error('Not implemented: ListOrchestratorSessionsUseCase');
    }
    const request =
      typeof input === 'object' && input !== null ? (input as ListOrchestratorSessionsRequest) : {};
    const status = request.status;
    if (status !== undefined && !ORCHESTRATOR_SESSION_STATUSES.includes(status)) {
      return { sessions: [] };
    }
    // One clock read for the whole list, so attached and attentive share a moment.
    const nowIso = this.deps.clock.nowIso();
    const stored = await this.deps.sessionRepo.list({ status });
    const sessions = stored.map(({ session, revision }) => ({
      session,
      revision,
      attached: isOrchestratorAttached(session, nowIso),
      attentive: isOrchestratorAttentive(session, nowIso),
    }));
    return { sessions };
  }
}
