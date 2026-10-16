/**
 * InspectAttemptUseCase: fetch an attempt record safely without invoking the
 * runner subprocess or mutating server state. Safe and idempotent for GET routes.
 */

import type {
  InspectAttemptPort,
  InspectAttemptRequest,
  InspectAttemptResult,
} from '../ports/in/InspectAttemptPort.in-port.js';
import type { AttemptRepositoryPort } from '../ports/out/AttemptRepositoryPort.out-port.js';

export interface InspectAttemptDependencies {
  readonly attemptRepo: AttemptRepositoryPort;
}

export class InspectAttemptUseCase implements InspectAttemptPort {
  constructor(private readonly deps?: InspectAttemptDependencies) {}

  async inspectAttempt(request: InspectAttemptRequest): Promise<InspectAttemptResult> {
    if (!this.deps) {
      throw new Error('Not implemented: InspectAttemptUseCase');
    }

    if (!request.attemptId) {
      return { outcome: 'not-found', attemptId: request.attemptId ?? '' };
    }

    const attempt = await this.deps.attemptRepo.findAttemptById(request.attemptId);
    if (!attempt) {
      return { outcome: 'not-found', attemptId: request.attemptId };
    }

    return { outcome: 'found', attempt };
  }

  async execute(input?: unknown): Promise<InspectAttemptResult> {
    if (!this.deps) {
      throw new Error('Not implemented: InspectAttemptUseCase');
    }
    if (!input || typeof input !== 'object') {
      throw new Error('Not implemented: InspectAttemptUseCase');
    }
    return this.inspectAttempt(input as InspectAttemptRequest);
  }
}
