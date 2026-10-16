/**
 * ListOwnerQuestionsUseCase implements ListOwnerQuestionsPort. It is a thin
 * read over the owner question repository, optionally narrowed by lifecycle
 * state and asked-at lower bound. Reading writes nothing and invents nothing.
 */

import type { ListOwnerQuestionsPort, ListOwnerQuestionsRequest, ListOwnerQuestionsResult } from '../ports/in/ListOwnerQuestionsPort.in-port.js';
import type { OwnerQuestionRepositoryPort } from '../ports/out/OwnerQuestionRepositoryPort.out-port.js';

export interface ListOwnerQuestionsDependencies {
  readonly ownerQuestionRepo: OwnerQuestionRepositoryPort;
}

const STATES: readonly string[] = ['open', 'answered', 'rejected', 'expired', 'acknowledged'];

export class ListOwnerQuestionsUseCase implements ListOwnerQuestionsPort {
  constructor(private readonly deps?: ListOwnerQuestionsDependencies) {}

  async listOwnerQuestions(request?: ListOwnerQuestionsRequest): Promise<ListOwnerQuestionsResult> {
    return this.execute(request);
  }

  async execute(input?: unknown): Promise<ListOwnerQuestionsResult> {
    // Unconfigured is 501 and is checked before any request validation.
    if (!this.deps) {
      throw new Error('Not implemented: ListOwnerQuestionsUseCase');
    }
    const request =
      typeof input === 'object' && input !== null ? (input as ListOwnerQuestionsRequest) : {};
    const state = request.state;
    if (state !== undefined && !STATES.includes(state)) {
      return { questions: [] };
    }
    const since = request.since;
    if (since !== undefined && (typeof since !== 'string' || Number.isNaN(Date.parse(since)))) {
      return { questions: [] };
    }
    const questions = await this.deps.ownerQuestionRepo.list({
      state,
      since: since === undefined ? undefined : new Date(since).toISOString(),
    });
    return { questions };
  }
}
