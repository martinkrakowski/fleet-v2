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
 *
 * With an idempotency key the ask is find-or-create: before anything else a
 * stored question holding the key is mapped to `exists` (same ask, whatever
 * its state) or a fixed refusal (different ask); a retried ask is answered
 * from the store alone. Races on the key are resolved the same way after a
 * refused save.
 */

import { OwnerQuestion, sameOwnerQuestionAsk } from '../../domain/entities/OwnerQuestion.js';
import type { OwnerQuestionRecord } from '../../domain/owner-question-records.js';
import type {
  AskOwnerQuestionPort,
  AskOwnerQuestionRequest,
  AskOwnerQuestionResult,
  OwnerQuestionClock,
} from '../ports/in/AskOwnerQuestionPort.in-port.js';
import type { CoordinationRequestRepositoryPort } from '../ports/out/CoordinationRequestRepositoryPort.out-port.js';
import {
  OwnerQuestionIdempotencyKeyConflictError,
  OwnerQuestionRevisionConflictError,
} from '../ports/out/OwnerQuestionRepositoryPort.out-port.js';
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
        idempotencyKey: request.idempotencyKey,
      });
    } catch (error) {
      return {
        outcome: 'refused',
        reason: error instanceof Error ? error.message : String(error),
      };
    }

    // A keyed ask is find-or-create: a stored holder of the key answers the
    // retry from the store alone, before any other check.
    if (question.toRecord().idempotencyKey !== undefined) {
      const keyed = await this.keyedOutcome(question.toRecord());
      if (keyed !== null) {
        return keyed;
      }
    }

    if (question.getDoorKind() === 'one-way') {
      const linkedRequestId = question.getLinkedRequestId();
      if (linkedRequestId === null) {
        return { outcome: 'refused', reason: 'a one-way question requires a linkedRequestId' };
      }
      const linked = await this.deps.requestRepo.findRequestById(linkedRequestId);
      if (linked === null || !LINKABLE_KINDS.includes(linked.kind)) {
        // Never echo the caller-supplied id or kind in the reason.
        return {
          outcome: 'refused',
          reason: 'the linked request was not found or is not an action-decision or policy-proposal',
        };
      }
    }

    try {
      await this.deps.ownerQuestionRepo.save(question.toRecord(), 0);
    } catch (error) {
      if (error instanceof OwnerQuestionIdempotencyKeyConflictError) {
        const keyed = await this.keyedOutcome(question.toRecord());
        if (keyed !== null) {
          return keyed;
        }
        return {
          outcome: 'refused',
          reason: 'another question holds this idempotency key',
        };
      }
      if (error instanceof OwnerQuestionRevisionConflictError) {
        if (question.toRecord().idempotencyKey !== undefined) {
          const stored = await this.deps.ownerQuestionRepo.get(request.questionId);
          if (stored !== null && sameOwnerQuestionAsk(stored, question.toRecord())) {
            return { outcome: 'exists', question: stored };
          }
        }
        return {
          outcome: 'refused',
          reason: 'another writer moved this question first; ask again',
        };
      }
      throw error;
    }
    return { outcome: 'asked', question: question.toRecord() };
  }

  /**
   * For a keyed candidate: the stored holder of its key mapped to `exists`
   * (same ask) or a fixed refusal (different ask); null when no question
   * holds the key. Never compares by questionId: the key decides.
   */
  private async keyedOutcome(candidate: OwnerQuestionRecord): Promise<AskOwnerQuestionResult | null> {
    const holder = candidate.idempotencyKey === undefined
      ? null
      : await this.deps!.ownerQuestionRepo.findByIdempotencyKey(candidate.idempotencyKey);
    if (holder === null) {
      return null;
    }
    if (sameOwnerQuestionAsk(holder, candidate)) {
      return { outcome: 'exists', question: holder };
    }
    return {
      outcome: 'refused',
      reason: 'another question holds this idempotency key with a different ask',
    };
  }
}
