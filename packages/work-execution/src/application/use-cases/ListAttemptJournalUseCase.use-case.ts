/**
 * ListAttemptJournalUseCase: the API's plain journal read (P1-J). Returns one
 * attempt's action journal entries in recorded order without modifying state,
 * never contacts the runner, never saves and never appends. Legality and the
 * "what may happen next" block are left to the conductor's decider; this read
 * carries none.
 */

import type {
  ListAttemptJournalPort,
  ListAttemptJournalRequest,
  ListAttemptJournalResult,
} from '../ports/in/ListAttemptJournalPort.in-port.js';
import type { AttemptRepositoryPort } from '../ports/out/AttemptRepositoryPort.out-port.js';
import type { ExecutionJournalPort } from '../ports/out/ExecutionJournalPort.out-port.js';

export interface ListAttemptJournalDependencies {
  readonly attemptRepo: AttemptRepositoryPort;
  readonly journal: ExecutionJournalPort;
}

export class ListAttemptJournalUseCase implements ListAttemptJournalPort {
  constructor(private readonly deps?: ListAttemptJournalDependencies) {}

  async listAttemptJournal(request: ListAttemptJournalRequest): Promise<ListAttemptJournalResult> {
    if (!this.deps) {
      throw new Error('Not implemented: ListAttemptJournalUseCase');
    }

    if (typeof request.attemptId !== 'string' || request.attemptId.trim() === '') {
      return { outcome: 'not-found', attemptId: '' };
    }

    const attempt = await this.deps.attemptRepo.findAttemptById(request.attemptId);
    if (!attempt) {
      return { outcome: 'not-found', attemptId: request.attemptId };
    }

    const entries = await this.deps.journal.listJournalEntriesForAttempt(request.attemptId);
    return { outcome: 'listed', attemptId: request.attemptId, entries: [...entries] };
  }

  async execute(input?: unknown): Promise<ListAttemptJournalResult> {
    if (!this.deps) {
      throw new Error('Not implemented: ListAttemptJournalUseCase');
    }
    if (!input || typeof input !== 'object') {
      throw new Error('Not implemented: ListAttemptJournalUseCase');
    }
    return this.listAttemptJournal(input as ListAttemptJournalRequest);
  }
}
