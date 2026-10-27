// ListAttemptJournalUseCase tests — A-J (GET /v1/attempts/:id/journal).
/**
 * Covers the plain read of one attempt's action journal: listed entries in
 * recorded order, known attempt with no entries, unknown attempt, blank id,
 * the unconfigured "Not implemented" throw, the no-mutation guarantee, and
 * the detail withhold/truncate rules applied before entries leave.
 */

import { describe, expect, it } from 'vitest';

import {
  JOURNAL_DETAIL_MAX_CHARS,
  ListAttemptJournalUseCase,
} from '../ListAttemptJournalUseCase.use-case.js';
import type { AttemptRepositoryPort } from '../../ports/out/AttemptRepositoryPort.out-port.js';
import type {
  ExecutionJournalPort,
  ReserveCapacityAtomicallyRequest,
  ReserveCapacityAtomicallyResult,
} from '../../ports/out/ExecutionJournalPort.out-port.js';
import type {
  ActionJournalEntryRecord,
  AttemptRecord,
  CapacityReservationRecord,
} from '../../../domain/execution-records.js';

const BASE_COMMIT = '0'.repeat(40);

const att1: AttemptRecord = {
  id: 'att-1',
  workOrderId: 'wo-1',
  kind: 'initial',
  fixNumber: 0,
  priorAttemptId: null,
  worktreePath: '/tmp/opencode/lanes/att-1',
  baseCommit: BASE_COMMIT,
  state: 'running',
  revision: 1,
  outcome: null,
  briefDigest: null,
  briefPackagePath: null,
  sessionId: null,
  completionReceipt: null,
  artifacts: null,
  runner: {
    kind: 'opencode',
    remotePort: 4166,
    host: null,
    agent: null,
    model: null,
    variant: null,
  },
  createdAtIso: '2026-10-20T09:00:00.000Z',
  updatedAtIso: '2026-10-20T09:30:00.000Z',
};

const att3: AttemptRecord = {
  ...att1,
  id: 'att-3',
  worktreePath: '/tmp/opencode/lanes/att-3',
};

const entryJ1: ActionJournalEntryRecord = {
  id: 'j-1',
  attemptId: 'att-1',
  workOrderId: 'wo-1',
  action: 'dispatch',
  baseCommit: BASE_COMMIT,
  recordedAtIso: '2026-10-20T09:00:00.000Z',
  status: 'intent-recorded',
  sessionId: null,
  detail: null,
};

const entryJ2: ActionJournalEntryRecord = {
  id: 'j-2',
  attemptId: 'att-1',
  workOrderId: 'wo-1',
  action: 'dispatch',
  baseCommit: BASE_COMMIT,
  recordedAtIso: '2026-10-20T09:01:00.000Z',
  status: 'completed',
  sessionId: null,
  detail: null,
};

const entryOther: ActionJournalEntryRecord = {
  id: 'j-3',
  attemptId: 'att-2',
  workOrderId: 'wo-1',
  action: 'dispatch',
  baseCommit: BASE_COMMIT,
  recordedAtIso: '2026-10-20T10:00:00.000Z',
  status: 'intent-recorded',
  sessionId: null,
  detail: null,
};

function makeAttemptRepo(attempts: readonly AttemptRecord[] = [att1]): AttemptRepositoryPort {
  return {
    findAttemptById: async (attemptId: string) =>
      attempts.find((attempt) => attempt.id === attemptId) ?? null,
  } as unknown as AttemptRepositoryPort;
}

class FakeExecutionJournal implements ExecutionJournalPort {
  listCalls = 0;

  private readonly storedByAttempt: ReadonlyMap<string, readonly ActionJournalEntryRecord[]>;

  constructor(entries: readonly ActionJournalEntryRecord[]) {
    const grouped = new Map<string, ActionJournalEntryRecord[]>();
    for (const entry of entries) {
      const group = grouped.get(entry.attemptId);
      if (group === undefined) {
        grouped.set(entry.attemptId, [entry]);
      } else {
        group.push(entry);
      }
    }
    this.storedByAttempt = grouped;
  }

  // Same stored array reference on every call; the copy test fails if the use
  // case returns it without copying.
  async listJournalEntriesForAttempt(attemptId: string): Promise<readonly ActionJournalEntryRecord[]> {
    this.listCalls += 1;
    return this.storedByAttempt.get(attemptId) ?? [];
  }

  async listActiveReservations(): Promise<readonly CapacityReservationRecord[]> {
    return [];
  }

  async appendJournalEntry(): Promise<void> {
    throw new Error('journal must not be written');
  }

  async saveCapacityReservation(): Promise<void> {
    throw new Error('journal must not be written');
  }

  async releaseCapacityReservation(): Promise<boolean> {
    throw new Error('journal must not be written');
  }

  async reserveCapacityAtomically(
    _request: ReserveCapacityAtomicallyRequest,
  ): Promise<ReserveCapacityAtomicallyResult> {
    throw new Error('journal must not be written');
  }
}

function makeUseCase(options: {
  attempts?: readonly AttemptRecord[];
  entries?: readonly ActionJournalEntryRecord[];
} = {}) {
  const attemptRepo = makeAttemptRepo(options.attempts);
  const journal = new FakeExecutionJournal(options.entries ?? [entryJ1, entryJ2, entryOther]);
  const useCase = new ListAttemptJournalUseCase({ attemptRepo, journal });
  return { useCase, attemptRepo, journal };
}

describe('ListAttemptJournalUseCase', () => {
  it('lists one attempt\'s journal entries in recorded order', async () => {
    const { useCase } = makeUseCase();
    const result = await useCase.listAttemptJournal({ attemptId: 'att-1' });
    expect(result).toEqual({
      outcome: 'listed',
      attemptId: 'att-1',
      entries: [entryJ1, entryJ2],
    });
  });

  it('lists an empty array for a known attempt with no entries', async () => {
    const { useCase } = makeUseCase({ attempts: [att1, att3] });
    const result = await useCase.listAttemptJournal({ attemptId: 'att-3' });
    expect(result).toEqual({ outcome: 'listed', attemptId: 'att-3', entries: [] });
  });

  it('returns not-found for an unknown attempt without reading the journal', async () => {
    const { useCase, journal } = makeUseCase();
    const result = await useCase.listAttemptJournal({ attemptId: 'att-9' });
    expect(result).toEqual({ outcome: 'not-found', attemptId: 'att-9' });
    expect(journal.listCalls).toBe(0);
  });

  it('returns not-found with a blank attempt id for whitespace-only ids', async () => {
    const { useCase } = makeUseCase();
    const result = await useCase.listAttemptJournal({ attemptId: '   ' });
    expect(result).toEqual({ outcome: 'not-found', attemptId: '' });
  });

  it('throws Not implemented without dependencies and for a non-object execute input', async () => {
    const bare = new ListAttemptJournalUseCase();
    await expect(bare.listAttemptJournal({ attemptId: 'att-1' })).rejects.toThrow(
      'Not implemented: ListAttemptJournalUseCase',
    );
    await expect(bare.execute({ attemptId: 'att-1' })).rejects.toThrow(
      'Not implemented: ListAttemptJournalUseCase',
    );
    const { useCase } = makeUseCase();
    await expect(useCase.execute(null)).rejects.toThrow('Not implemented: ListAttemptJournalUseCase');
  });

  it('returns a fresh entries array per call', async () => {
    const { useCase } = makeUseCase();
    const first = await useCase.listAttemptJournal({ attemptId: 'att-1' });
    if (first.outcome !== 'listed') {
      throw new Error(`expected listed, got ${first.outcome}`);
    }
    (first.entries as ActionJournalEntryRecord[]).push(entryOther);
    const second = await useCase.listAttemptJournal({ attemptId: 'att-1' });
    expect(second).toEqual({
      outcome: 'listed',
      attemptId: 'att-1',
      entries: [entryJ1, entryJ2],
    });
  });

  it('withholds a secret-shaped detail and never returns the matched text', async () => {
    const secret = 'ghp_' + 'x'.repeat(30);
    const entry: ActionJournalEntryRecord = {
      ...entryJ1,
      id: 'j-secret',
      detail: 'runner error: ' + secret,
    };
    const { useCase } = makeUseCase({ entries: [entry] });
    const result = await useCase.listAttemptJournal({ attemptId: 'att-1' });
    if (result.outcome !== 'listed') {
      throw new Error(`expected listed, got ${result.outcome}`);
    }
    const [first] = result.entries;
    expect(first?.detail).toBe('[detail withheld: secret-shaped (github-token)]');
    expect(JSON.stringify(result)).not.toContain('ghp_');
  });

  it('truncates a detail longer than 2000 characters', async () => {
    const longDetail = 'lorem ipsum dolor sit amet '.repeat(100).slice(0, 2500);
    const entry: ActionJournalEntryRecord = {
      ...entryJ1,
      id: 'j-long',
      detail: longDetail,
    };
    const { useCase } = makeUseCase({ entries: [entry] });
    const result = await useCase.listAttemptJournal({ attemptId: 'att-1' });
    if (result.outcome !== 'listed') {
      throw new Error(`expected listed, got ${result.outcome}`);
    }
    const [first] = result.entries;
    expect(first?.detail).toBe(longDetail.slice(0, JOURNAL_DETAIL_MAX_CHARS) + ' [truncated]');
  });

  it('keeps a normal detail unchanged', async () => {
    const entry: ActionJournalEntryRecord = {
      ...entryJ1,
      id: 'j-normal',
      detail: 'dispatch recorded for wo-1',
    };
    const { useCase } = makeUseCase({ entries: [entry] });
    const result = await useCase.listAttemptJournal({ attemptId: 'att-1' });
    if (result.outcome !== 'listed') {
      throw new Error(`expected listed, got ${result.outcome}`);
    }
    const [first] = result.entries;
    expect(first?.detail).toBe('dispatch recorded for wo-1');
  });
});
