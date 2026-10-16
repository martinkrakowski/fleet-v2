/**
 * ExpireOwnerQuestionsUseCase implements ExpireOwnerQuestionsPort. It moves
 * every open owner question whose expiry has passed to the expired state,
 * judged by the injected clock, never by a request body.
 *
 * Expired questions stay blocking: their work remains held until the question
 * is re-asked. A question whose save loses a revision race is left for the
 * next run rather than forced.
 */

import type { OwnerQuestionRecord } from '../../domain/owner-question-records.js';
import { OwnerQuestion } from '../../domain/entities/OwnerQuestion.js';
import type {
  ExpireOwnerQuestionsPort,
  ExpireOwnerQuestionsResult,
} from '../ports/in/ExpireOwnerQuestionsPort.in-port.js';
import type { OwnerQuestionClock } from '../ports/in/AskOwnerQuestionPort.in-port.js';
import { OwnerQuestionRevisionConflictError } from '../ports/out/OwnerQuestionRepositoryPort.out-port.js';
import type { OwnerQuestionRepositoryPort } from '../ports/out/OwnerQuestionRepositoryPort.out-port.js';

export interface ExpireOwnerQuestionsUseCaseDependencies {
  readonly ownerQuestionRepo: OwnerQuestionRepositoryPort;
  readonly clock: OwnerQuestionClock;
}

export class ExpireOwnerQuestionsUseCase implements ExpireOwnerQuestionsPort {
  constructor(private readonly deps?: ExpireOwnerQuestionsUseCaseDependencies) {}

  async expireOwnerQuestions(): Promise<ExpireOwnerQuestionsResult> {
    return this.execute();
  }

  async execute(): Promise<ExpireOwnerQuestionsResult> {
    // Unconfigured is 501 and is checked before any work is done.
    if (!this.deps) {
      throw new Error('Not implemented: ExpireOwnerQuestionsUseCase');
    }
    const nowMs = new Date(this.deps.clock.nowIso()).getTime();
    const open = await this.deps.ownerQuestionRepo.list({ state: 'open' });
    const expired: OwnerQuestionRecord[] = [];
    const unchanged: OwnerQuestionRecord[] = [];
    for (const record of open) {
      if (record.expiresAt === null) {
        unchanged.push(record);
        continue;
      }
      const expiresAtMs = new Date(record.expiresAt).getTime();
      if (Number.isNaN(expiresAtMs) || expiresAtMs > nowMs) {
        unchanged.push(record);
        continue;
      }
      try {
        const entity = OwnerQuestion.fromRecord(record).transitionTo('expired');
        await this.deps.ownerQuestionRepo.save(entity.toRecord(), record.revision);
        expired.push(entity.toRecord());
      } catch (error) {
        // A lost revision race is another writer moving first; the question
        // stays open for the next run instead of being forced.
        if (!(error instanceof OwnerQuestionRevisionConflictError)) {
          throw error;
        }
        unchanged.push(record);
      }
    }
    return { outcome: 'expired', expired, unchanged };
  }
}
