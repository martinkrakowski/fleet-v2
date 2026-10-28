/**
 * FindOwnerQuestionByKeyUseCase implements FindOwnerQuestionByKeyPort. It is
 * a thin read of one owner question by its idempotency key, for the §3.5
 * reconcile of an owner-question intent without a result. Known absence is
 * `not-found`, never an invented question, and reading writes nothing.
 */

import type {
  FindOwnerQuestionByKeyPort,
  FindOwnerQuestionByKeyRequest,
  FindOwnerQuestionByKeyResult,
} from '../ports/in/FindOwnerQuestionByKeyPort.in-port.js';
import type { OwnerQuestionRepositoryPort } from '../ports/out/OwnerQuestionRepositoryPort.out-port.js';

export interface FindOwnerQuestionByKeyDependencies {
  readonly ownerQuestionRepo: OwnerQuestionRepositoryPort;
}

export class FindOwnerQuestionByKeyUseCase implements FindOwnerQuestionByKeyPort {
  constructor(private readonly deps?: FindOwnerQuestionByKeyDependencies) {}

  async findOwnerQuestionByKey(
    request: FindOwnerQuestionByKeyRequest,
  ): Promise<FindOwnerQuestionByKeyResult> {
    return this.execute(request);
  }

  async execute(input: unknown): Promise<FindOwnerQuestionByKeyResult> {
    // Unconfigured is 501 and is checked before any request validation.
    if (!this.deps) {
      throw new Error('Not implemented: FindOwnerQuestionByKeyUseCase');
    }
    // A configured runtime still refuses a missing request object instead of
    // inventing one; the HTTP boundary always supplies an object body.
    if (typeof input !== 'object' || input === null) {
      throw new Error('Not implemented: FindOwnerQuestionByKeyUseCase');
    }
    const request = input as FindOwnerQuestionByKeyRequest;
    // A key that is not a non-empty string is known absence: no store read.
    const idempotencyKey = typeof request.idempotencyKey === 'string' ? request.idempotencyKey.trim() : '';
    if (idempotencyKey === '') {
      return { outcome: 'not-found' };
    }
    const question = await this.deps.ownerQuestionRepo.findByIdempotencyKey(idempotencyKey);
    if (question === null) {
      return { outcome: 'not-found' };
    }
    return { outcome: 'found', question };
  }
}
