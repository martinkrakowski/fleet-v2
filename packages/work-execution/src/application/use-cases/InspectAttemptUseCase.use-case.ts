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
import type { RunnerForAttemptPort } from '../ports/out/RunnerForAttemptPort.out-port.js';

export interface InspectAttemptDependencies {
  readonly attemptRepo: AttemptRepositoryPort;
  /**
   * Optional (H9b1). When given, an attempt whose recorded host no longer
   * matches the current installation inspects as `unknown` with the reason,
   * never a guess from another host. Without it the behaviour is unchanged.
   */
  readonly runnerForAttempt?: RunnerForAttemptPort;
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

    if (this.deps.runnerForAttempt) {
      // The recorded host is the truth: a recorded host that changed or was
      // removed inspects as unknown with the reason, never a guess.
      const selection = this.deps.runnerForAttempt.runnerForAttempt({
        runner: attempt.runner ?? null,
      });
      if (!selection.ok) {
        return { outcome: 'unknown', attemptId: request.attemptId, reason: selection.reason };
      }
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
