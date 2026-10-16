/**
 * AnswerOwnerQuestionUseCase implements AnswerOwnerQuestionPort. It records the
 * owner's answer on a two-way question at its current revision and saves with
 * the expected revision the use case last read, bumping the stored record to
 * that revision + 1.
 *
 * A one-way question is refused: it is answered only by a signed owner
 * decision, never through this port. An answer whose revision is not the
 * current one is refused. The port is idempotent: replaying the same answer
 * for the same (questionId, questionRevision) returns the stored result
 * without a second write. An answer grants nothing: it touches no coordination
 * request, and the answered-at moment comes from the injected clock.
 */

import type { OwnerQuestionAnswerRecord, OwnerQuestionRecord } from '../../domain/owner-question-records.js';
import { OwnerQuestion } from '../../domain/entities/OwnerQuestion.js';
import type { OwnerQuestionClock } from '../ports/in/AskOwnerQuestionPort.in-port.js';
import type {
  AnswerOwnerQuestionPort,
  AnswerOwnerQuestionRequest,
  AnswerOwnerQuestionResult,
} from '../ports/in/AnswerOwnerQuestionPort.in-port.js';
import { OwnerQuestionRevisionConflictError } from '../ports/out/OwnerQuestionRepositoryPort.out-port.js';
import type { OwnerQuestionRepositoryPort } from '../ports/out/OwnerQuestionRepositoryPort.out-port.js';

export interface AnswerOwnerQuestionDependencies {
  readonly ownerQuestionRepo: OwnerQuestionRepositoryPort;
  readonly clock: OwnerQuestionClock;
}

const ANSWER_SHAPES: readonly string[] = ['accept', 'reject', 'answer'];
const ANSWER_VIAS: readonly string[] = ['web', 'cli'];

function sameAnswer(
  recorded: OwnerQuestionAnswerRecord,
  request: AnswerOwnerQuestionRequest,
): boolean {
  // The domain forces an accept onto the recommended option, so the replayed
  // request is compared the same way, whatever optionId it named.
  const requestedOptionId =
    request.shape === 'accept' ? recorded.optionId : (request.optionId ?? null);
  return (
    recorded.shape === request.shape &&
    (recorded.optionId ?? null) === requestedOptionId &&
    (recorded.text ?? null) === (request.text ?? null) &&
    (recorded.reason ?? null) === (request.reason ?? null) &&
    recorded.answeredVia === request.answeredVia &&
    (recorded.sessionId ?? null) === (request.sessionId ?? null)
  );
}

export class AnswerOwnerQuestionUseCase implements AnswerOwnerQuestionPort {
  constructor(private readonly deps?: AnswerOwnerQuestionDependencies) {}

  async answerOwnerQuestion(
    request: AnswerOwnerQuestionRequest,
  ): Promise<AnswerOwnerQuestionResult> {
    return this.execute(request);
  }

  async execute(input: unknown): Promise<AnswerOwnerQuestionResult> {
    // Unconfigured is 501 and is checked before any request validation.
    if (!this.deps) {
      throw new Error('Not implemented: AnswerOwnerQuestionUseCase');
    }
    // A configured runtime still refuses a missing request object instead of
    // inventing one; the HTTP boundary always supplies an object body.
    if (typeof input !== 'object' || input === null) {
      throw new Error('Not implemented: AnswerOwnerQuestionUseCase');
    }
    const request = input as AnswerOwnerQuestionRequest;
    const questionId = typeof request.questionId === 'string' ? request.questionId.trim() : '';
    if (questionId === '') {
      return { outcome: 'refused', reason: 'an answer requires a non-empty questionId' };
    }
    if (!Number.isInteger(request.questionRevision) || request.questionRevision < 1) {
      return {
        outcome: 'refused',
        reason: 'an answer requires a positive integer questionRevision',
      };
    }
    if (!ANSWER_SHAPES.includes(request.shape)) {
      return { outcome: 'refused', reason: 'an answer requires a shape of accept, reject or answer' };
    }
    if (!ANSWER_VIAS.includes(request.answeredVia)) {
      return {
        outcome: 'refused',
        reason: 'a two-way answer is answered via web or cli; only a signed owner decision answers a one-way question',
      };
    }

    const stored = await this.deps.ownerQuestionRepo.get(questionId);
    if (stored === null) {
      return { outcome: 'refused', reason: 'no owner question is recorded for that id' };
    }

    if (stored.doorKind === 'one-way') {
      return {
        outcome: 'refused',
        reason: 'one-way questions are answered only by a signed owner decision',
      };
    }

    if (stored.state !== 'open') {
      const already = stored.answer;
      if (
        already !== null &&
        already.questionRevision === request.questionRevision &&
        sameAnswer(already, request)
      ) {
        // Idempotent replay: the stored result, without a second write.
        return { outcome: 'answered', question: stored, replayed: true };
      }
      return {
        outcome: 'refused',
        reason:
          already !== null && already.questionRevision === request.questionRevision
            ? 'this question revision already carries a different answer'
            : `the question is no longer open; its current revision is ${stored.revision}`,
      };
    }

    if (request.questionRevision !== stored.revision) {
      return {
        outcome: 'refused',
        reason: `the answer names a stale revision; current revision is ${stored.revision}`,
      };
    }

    let answered: OwnerQuestionRecord;
    try {
      const current = OwnerQuestion.fromRecord(stored);
      const answer: OwnerQuestionAnswerRecord = {
        shape: request.shape,
        optionId: request.optionId ?? null,
        text: request.text ?? null,
        reason: request.reason ?? null,
        // The answer carries the revision the caller answered, never the
        // bumped revision the save produces.
        questionRevision: request.questionRevision,
        answeredVia: request.answeredVia,
        answeredAt: this.deps.clock.nowIso(),
        sessionId: request.sessionId ?? null,
      };
      const transitioned = current.transitionTo(
        request.shape === 'reject' ? 'rejected' : 'answered',
        { answer },
      );
      // The repository requires record.revision === expectedRevision + 1.
      answered = { ...transitioned.toRecord(), revision: stored.revision + 1 };
    } catch {
      // A fixed reason: internal validation text is never passed to the caller.
      return { outcome: 'refused', reason: 'the answer does not fit this question' };
    }

    try {
      await this.deps.ownerQuestionRepo.save(answered, stored.revision);
    } catch (error) {
      if (error instanceof OwnerQuestionRevisionConflictError) {
        return {
          outcome: 'refused',
          reason: 'another writer moved this question first; read it and answer again',
        };
      }
      throw error;
    }
    return { outcome: 'answered', question: answered, replayed: false };
  }
}
