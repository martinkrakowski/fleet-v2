/**
 * ReadOwnerQuestionUseCase implements ReadOwnerQuestionPort. It is a thin read
 * of one owner question by id. Known absence is null, never an invented
 * question, and reading writes nothing.
 */

import type {
  ReadOwnerQuestionPort,
  ReadOwnerQuestionRequest,
  ReadOwnerQuestionResult,
} from '../ports/in/ReadOwnerQuestionPort.in-port.js';
import type { OwnerQuestionRepositoryPort } from '../ports/out/OwnerQuestionRepositoryPort.out-port.js';

export interface ReadOwnerQuestionDependencies {
  readonly ownerQuestionRepo: OwnerQuestionRepositoryPort;
}

export class ReadOwnerQuestionUseCase implements ReadOwnerQuestionPort {
  constructor(private readonly deps?: ReadOwnerQuestionDependencies) {}

  async readOwnerQuestion(request: ReadOwnerQuestionRequest): Promise<ReadOwnerQuestionResult> {
    return this.execute(request);
  }

  async execute(input: unknown): Promise<ReadOwnerQuestionResult> {
    // Unconfigured is 501 and is checked before any request validation.
    if (!this.deps) {
      throw new Error('Not implemented: ReadOwnerQuestionUseCase');
    }
    // A configured runtime still refuses a missing request object instead of
    // inventing one; the HTTP boundary always supplies an object body.
    if (typeof input !== 'object' || input === null) {
      throw new Error('Not implemented: ReadOwnerQuestionUseCase');
    }
    const request = input as ReadOwnerQuestionRequest;
    const questionId = typeof request.questionId === 'string' ? request.questionId.trim() : '';
    if (questionId === '') {
      return { outcome: 'not-found', questionId: '' };
    }
    const question = await this.deps.ownerQuestionRepo.get(questionId);
    if (question === null) {
      return { outcome: 'not-found', questionId };
    }
    return { outcome: 'found', question };
  }
}
