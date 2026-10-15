// Implemented for migration step 2 — fresh fix rounds, never resumed sessions.
/**
 * PrepareFixAttemptUseCase: create a fresh attempt with numbered fixes after
 * the prior attempt has ended. A fix round never resumes the prior session;
 * its conversation is not the new attempt's. The new identity is created only
 * when the prior attempt is terminal for work and the fix identity is unused.
 */

import type { AttemptRecord } from '../../domain/execution-records.js';
import type {
  PrepareFixAttemptPort,
  PrepareFixAttemptRequest,
  PrepareFixAttemptResult,
} from '../ports/in/PrepareFixAttemptPort.in-port.js';
import type { AttemptRepositoryPort } from '../ports/out/AttemptRepositoryPort.out-port.js';

export interface PrepareFixAttemptDependencies {
  readonly attemptRepo: AttemptRepositoryPort;
}

/** Prior-attempt states after which a fresh fix round may be prepared. */
const FIXABLE_PRIOR_STATES: readonly AttemptRecord['state'][] = ['ended', 'collected', 'cancelled'];

function isNonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export class PrepareFixAttemptUseCase implements PrepareFixAttemptPort {
  constructor(private readonly deps?: PrepareFixAttemptDependencies) {}

  async prepareFixAttempt(request: PrepareFixAttemptRequest): Promise<PrepareFixAttemptResult> {
    if (!this.deps) {
      throw new Error('Not implemented: PrepareFixAttemptUseCase');
    }

    const requiredFields: readonly (keyof PrepareFixAttemptRequest)[] = [
      'fixAttemptId',
      'workOrderId',
      'priorAttemptId',
      'worktreePath',
      'baseCommit',
    ];
    const missingFields = requiredFields.filter((field) => !isNonEmpty(request[field]));
    if (missingFields.length > 0) {
      return { outcome: 'refused', reason: `Missing required fix attempt fields: ${missingFields.join(', ')}` };
    }
    if (request.fixAttemptId === request.priorAttemptId) {
      return { outcome: 'refused', reason: 'fixAttemptId must differ from priorAttemptId' };
    }
    if (!Array.isArray(request.numberedFixes) || request.numberedFixes.length === 0) {
      return { outcome: 'refused', reason: 'numberedFixes must record at least one fix' };
    }

    const prior = await this.deps.attemptRepo.findAttemptById(request.priorAttemptId);
    if (!prior || prior.workOrderId !== request.workOrderId) {
      return { outcome: 'refused', reason: 'Prior attempt not found for work order' };
    }
    if (!FIXABLE_PRIOR_STATES.includes(prior.state)) {
      return { outcome: 'refused', reason: 'Cannot prepare fix attempt before prior attempt has ended' };
    }

    const existingFix = await this.deps.attemptRepo.findAttemptById(request.fixAttemptId);
    if (existingFix) {
      return { outcome: 'refused', reason: `Fix attempt id already exists: ${request.fixAttemptId}` };
    }

    const nowIso = request.nowIso ?? new Date().toISOString();
    // A fix attempt is a fresh identity: it never inherits or resumes the
    // prior session's sessionId or conversation.
    const record: AttemptRecord = {
      id: request.fixAttemptId,
      workOrderId: request.workOrderId,
      kind: 'fix',
      fixNumber: prior.fixNumber + 1,
      priorAttemptId: prior.id,
      worktreePath: request.worktreePath,
      baseCommit: request.baseCommit,
      state: 'intent-recorded',
      outcome: null,
      briefDigest: null,
      briefPackagePath: null,
      sessionId: null,
      completionReceipt: null,
      artifacts: null,
      createdAtIso: nowIso,
      updatedAtIso: nowIso,
    };
    await this.deps.attemptRepo.saveAttempt(record);
    return { outcome: 'prepared', attempt: record };
  }

  async execute(input?: unknown): Promise<PrepareFixAttemptResult> {
    if (!this.deps || !input || typeof input !== 'object') {
      throw new Error('Not implemented: PrepareFixAttemptUseCase');
    }
    return this.prepareFixAttempt(input as PrepareFixAttemptRequest);
  }
}
