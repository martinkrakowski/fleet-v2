/**
 * AcknowledgeOwnerAnswerUseCase implements AcknowledgeOwnerAnswerPort. It
 * records that the asker saw the answer on an answered or rejected owner
 * question: the acknowledger comes from the request, the moment from the
 * injected clock.
 *
 * Nothing else may be acknowledged: an open, expired or already acknowledged
 * question is refused, and an acknowledgement grants nothing.
 */

import { OwnerQuestion } from '../../domain/entities/OwnerQuestion.js';
import type { OwnerQuestionRecord } from '../../domain/owner-question-records.js';
import type { OwnerQuestionClock } from '../ports/in/AskOwnerQuestionPort.in-port.js';
import type {
  AcknowledgeOwnerAnswerPort,
  AcknowledgeOwnerAnswerRequest,
  AcknowledgeOwnerAnswerResult,
} from '../ports/in/AcknowledgeOwnerAnswerPort.in-port.js';
import { OwnerQuestionRevisionConflictError } from '../ports/out/OwnerQuestionRepositoryPort.out-port.js';
import type { OwnerQuestionRepositoryPort } from '../ports/out/OwnerQuestionRepositoryPort.out-port.js';

export interface AcknowledgeOwnerAnswerDependencies {
  readonly ownerQuestionRepo: OwnerQuestionRepositoryPort;
  readonly clock: OwnerQuestionClock;
}

export class AcknowledgeOwnerAnswerUseCase implements AcknowledgeOwnerAnswerPort {
  constructor(private readonly deps?: AcknowledgeOwnerAnswerDependencies) {}

  async acknowledgeOwnerAnswer(
    request: AcknowledgeOwnerAnswerRequest,
  ): Promise<AcknowledgeOwnerAnswerResult> {
    return this.execute(request);
  }

  async execute(input: unknown): Promise<AcknowledgeOwnerAnswerResult> {
    // Unconfigured is 501 and is checked before any request validation.
    if (!this.deps) {
      throw new Error('Not implemented: AcknowledgeOwnerAnswerUseCase');
    }
    // A configured runtime still refuses a missing request object instead of
    // inventing one; the HTTP boundary always supplies an object body.
    if (typeof input !== 'object' || input === null) {
      throw new Error('Not implemented: AcknowledgeOwnerAnswerUseCase');
    }
    const request = input as AcknowledgeOwnerAnswerRequest;
    const questionId = typeof request.questionId === 'string' ? request.questionId.trim() : '';
    const by = typeof request.by === 'string' ? request.by.trim() : '';
    if (questionId === '') {
      return { outcome: 'refused', reason: 'an acknowledgement requires a non-empty questionId' };
    }
    if (by === '') {
      return { outcome: 'refused', reason: 'an acknowledgement requires a non-empty by' };
    }

    const stored = await this.deps.ownerQuestionRepo.get(questionId);
    if (stored === null) {
      return { outcome: 'refused', reason: 'no owner question is recorded for that id' };
    }
    if (stored.state !== 'answered' && stored.state !== 'rejected') {
      return {
        outcome: 'refused',
        reason: `only an answered or rejected question can be acknowledged, and this one is ${stored.state}`,
      };
    }

    let acknowledged: OwnerQuestionRecord;
    try {
      const transitioned = OwnerQuestion.fromRecord(stored).transitionTo('acknowledged', {
        acknowledgement: { by, at: this.deps.clock.nowIso() },
      });
      // The repository requires record.revision === expectedRevision + 1.
      acknowledged = { ...transitioned.toRecord(), revision: stored.revision + 1 };
    } catch (error) {
      return { outcome: 'refused', reason: error instanceof Error ? error.message : String(error) };
    }

    try {
      await this.deps.ownerQuestionRepo.save(acknowledged, stored.revision);
    } catch (error) {
      if (error instanceof OwnerQuestionRevisionConflictError) {
        return {
          outcome: 'refused',
          reason: 'another writer moved this question first; read it and acknowledge again',
        };
      }
      throw error;
    }
    const question = acknowledged;
    const acknowledgement = question.acknowledgement;
    if (acknowledgement === null) {
      return { outcome: 'refused', reason: 'the acknowledgement could not be recorded' };
    }
    return { outcome: 'acknowledged', question, acknowledgement };
  }
}
