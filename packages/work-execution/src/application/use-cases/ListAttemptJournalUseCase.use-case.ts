/**
 * ListAttemptJournalUseCase: the API's plain journal read (P1-J). Returns one
 * attempt's action journal entries in recorded order without modifying state,
 * never contacts the runner, never saves and never appends. Legality and the
 * "what may happen next" block are left to the conductor's decider; this read
 * carries none.
 */

import { LANE_DIFF_SECRET_PATTERNS } from '@fleet/shared';

import type {
  ListAttemptJournalPort,
  ListAttemptJournalRequest,
  ListAttemptJournalResult,
} from '../ports/in/ListAttemptJournalPort.in-port.js';
import type { AttemptRepositoryPort } from '../ports/out/AttemptRepositoryPort.out-port.js';
import type { ExecutionJournalPort } from '../ports/out/ExecutionJournalPort.out-port.js';
import type { ActionJournalEntryRecord } from '../../domain/execution-records.js';

// Raw runner, stop and forge reasons may carry secrets or client text.
export const JOURNAL_DETAIL_MAX_CHARS = 2000;

type JournalDetail = ActionJournalEntryRecord['detail'];

function sanitizeJournalDetail(detail: JournalDetail): JournalDetail {
  if (typeof detail !== 'string') {
    return detail;
  }
  for (const pattern of LANE_DIFF_SECRET_PATTERNS) {
    if (detail.match(pattern.regex) !== null) {
      return '[detail withheld: secret-shaped (' + pattern.name + ')]';
    }
  }
  if (detail.length > JOURNAL_DETAIL_MAX_CHARS) {
    return detail.slice(0, JOURNAL_DETAIL_MAX_CHARS) + ' [truncated]';
  }
  return detail;
}

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
    const safeEntries = entries.map((entry) => ({
      ...entry,
      detail: sanitizeJournalDetail(entry.detail),
    }));
    return { outcome: 'listed', attemptId: request.attemptId, entries: safeEntries };
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
