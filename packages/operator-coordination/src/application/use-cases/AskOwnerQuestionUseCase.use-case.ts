/**
 * AskOwnerQuestionUseCase implements AskOwnerQuestionPort. It records one new
 * open owner question at revision 1, validated by the OwnerQuestion aggregate
 * itself; the asked-at moment comes from the injected clock, never from the
 * request.
 *
 * A one-way question must reference an existing coordination request of kind
 * action-decision or policy-proposal, read through the coordination request
 * repository. Anything else is refused. Asking a question grants nothing and
 * writes nothing on the referenced request.
 */

import { OwnerQuestion } from '../../domain/entities/OwnerQuestion.js';
import type {
  AskOwnerQuestionPort,
  AskOwnerQuestionRequest,
  AskOwnerQuestionResult,
  OwnerQuestionClock,
} from '../ports/in/AskOwnerQuestionPort.in-port.js';
import type { CoordinationRequestRepositoryPort } from '../ports/out/CoordinationRequestRepositoryPort.out-port.js';
import { OwnerQuestionRevisionConflictError } from '../ports/out/OwnerQuestionRepositoryPort.out-port.js';
import type { OwnerQuestionRepositoryPort } from '../ports/out/OwnerQuestionRepositoryPort.out-port.js';

export interface AskOwnerQuestionDependencies {
  readonly ownerQuestionRepo: OwnerQuestionRepositoryPort;
  readonly requestRepo: CoordinationRequestRepositoryPort;
  readonly clock: OwnerQuestionClock;
}

/** The only coordination request kinds a one-way question may reference. */
const LINKABLE_KINDS: readonly string[] = ['action-decision', 'policy-proposal'];

export class AskOwnerQuestionUseCase implements AskOwnerQuestionPort {
  constructor(private readonly deps?: AskOwnerQuestionDependencies) {}

  async askOwnerQuestion(request: AskOwnerQuestionRequest): Promise<AskOwnerQuestionResult> {
    return this.execute(request);
  }

  async execute(input: unknown): Promise<AskOwnerQuestionResult> {
    // Unconfigured is 501 and is checked before any request validation.
    if (!this.deps) {
      throw new Error('Not implemented: AskOwnerQuestionUseCase');
    }
    // A configured runtime still refuses a missing request object instead of
    // inventing one; the HTTP boundary always supplies an object body.
    if (typeof input !== 'object' || input === null) {
      throw new Error('Not implemented: AskOwnerQuestionUseCase');
    }
    const request = input as AskOwnerQuestionRequest;
    const doorKind = request.doorKind ?? 'one-way';

    // The domain validates the shape; the clock alone supplies askedAt.
    let question: OwnerQuestion;
    try {
      question = OwnerQuestion.fromRecord({
        questionId: request.questionId,
        revision: 1,
        askedBy: request.askedBy,
        title: request.title,
        body: request.body,
        options: request.options,
        recommendation: request.recommendation,
        doorKind,
        linkedRequestId: request.linkedRequestId ?? null,
        blocks: request.blocks,
        state: 'open',
        askedAt: this.deps.clock.nowIso(),
        expiresAt: request.expiresAt ?? null,
        answer: null,
        acknowledgement: null,
      });
    } catch (error) {
      return {
        outcome: 'refused',
        reason: error instanceof Error ? error.message : String(error),
      };
    }

    if (question.getDoorKind() === 'one-way') {
      const linkedRequestId = question.getLinkedRequestId();
      if (linkedRequestId === null) {
        return { outcome: 'refused', reason: 'a one-way question requires a linkedRequestId' };
      }
      const linked = await this.deps.requestRepo.findRequestById(linkedRequestId);
      if (linked === null) {
        return {
          outcome: 'refused',
          reason: `a one-way question must reference an existing coordination request, and none is recorded for ${linkedRequestId}`,
        };
      }
      if (!LINKABLE_KINDS.includes(linked.kind)) {
        return {
          outcome: 'refused',
          reason: 'a one-way question must reference an action-decision or policy-proposal request',
        };
      }
    }

    try {
      await this.deps.ownerQuestionRepo.save(question.toRecord(), 0);
    } catch (error) {
      if (error instanceof OwnerQuestionRevisionConflictError) {
        return {
          outcome: 'refused',
          reason: 'another writer moved this question first; ask again',
        };
      }
      throw error;
    }
    return { outcome: 'asked', question: question.toRecord() };
  }
}
