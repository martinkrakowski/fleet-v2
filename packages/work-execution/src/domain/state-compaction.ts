// EX-3b: the pure compaction policy. Decides which stored records may be
// removed from the attempt-scoped stores (`attempts.json`, `journal.json`,
// `reservations.json`) without breaking the invariant that no live run, held
// reservation or uncollected attempt references a removed record. Pure domain
// code: no clock, no filesystem, no I/O.
import type {
  ActionJournalEntryRecord,
  AttemptRecord,
  CapacityReservationRecord,
} from './execution-records.js';
import type { AttemptStateValue } from './value-objects/AttemptState.vo.js';

/** Attempt states that are terminal and collected: only these may be compacted. */
export const COMPACTABLE_ATTEMPT_STATES: readonly AttemptStateValue[] = ['collected', 'cancelled'];

/** Journal statuses that prove the entry's action is finished; an attempt named only by these may go. */
export const COMPACTABLE_JOURNAL_STATUSES: readonly ActionJournalEntryRecord['status'][] = ['completed', 'refused'];

export interface AttemptScopedCompactionInput {
  readonly attempts: readonly AttemptRecord[];
  readonly reservations: readonly CapacityReservationRecord[];
  readonly journalEntries: readonly ActionJournalEntryRecord[];
  /** The attempt ids a live (non-terminal) lane run still lists. */
  readonly liveRunAttemptIds: readonly string[];
}

export interface AttemptScopedCompactionPlan {
  readonly removableAttemptIds: readonly string[];
  readonly removableReservationIds: readonly string[];
  readonly removableJournalEntryIds: readonly string[];
}

export function planAttemptScopedCompaction(
  input: AttemptScopedCompactionInput,
): AttemptScopedCompactionPlan {
  // 1. Protected attempt ids: a live run still lists the attempt, a held
  //    reservation still holds it, or an uncollected/live attempt still names
  //    it (as itself or as the attempt it came from).
  const protectedAttemptIds = new Set<string>();
  for (const id of input.liveRunAttemptIds) {
    protectedAttemptIds.add(id);
  }
  for (const reservation of input.reservations) {
    if (reservation.held) {
      protectedAttemptIds.add(reservation.attemptId);
    }
  }
  for (const attempt of input.attempts) {
    if (!COMPACTABLE_ATTEMPT_STATES.includes(attempt.state)) {
      protectedAttemptIds.add(attempt.id);
      if (attempt.priorAttemptId !== null) {
        protectedAttemptIds.add(attempt.priorAttemptId);
      }
    }
  }

  // 2. Removable attempts: terminal, not protected, and every journal entry
  //    naming them is itself terminal. An attempt named by an
  //    'intent-recorded' or 'ambiguous' entry stays.
  const removableAttemptIds: string[] = [];
  for (const attempt of input.attempts) {
    if (!COMPACTABLE_ATTEMPT_STATES.includes(attempt.state)) {
      continue;
    }
    if (protectedAttemptIds.has(attempt.id)) {
      continue;
    }
    const everyJournalEntryTerminal = input.journalEntries
      .filter((entry) => entry.attemptId === attempt.id)
      .every((entry) => COMPACTABLE_JOURNAL_STATUSES.includes(entry.status));
    if (!everyJournalEntryTerminal) {
      continue;
    }
    removableAttemptIds.push(attempt.id);
  }
  const removableAttemptIdSet = new Set(removableAttemptIds);

  // 3. Removable journal entries: terminal entries of removable attempts. An
  //    entry of a kept attempt stays, so no kept entry ever names a removed
  //    attempt.
  const removableJournalEntryIds: string[] = [];
  for (const entry of input.journalEntries) {
    if (COMPACTABLE_JOURNAL_STATUSES.includes(entry.status) && removableAttemptIdSet.has(entry.attemptId)) {
      removableJournalEntryIds.push(entry.id);
    }
  }

  // 4. Removable reservations: released reservations of removable attempts. A
  //    held reservation is never removable; a released reservation of a kept
  //    attempt stays.
  const removableReservationIds: string[] = [];
  for (const reservation of input.reservations) {
    if (!reservation.held && removableAttemptIdSet.has(reservation.attemptId)) {
      removableReservationIds.push(reservation.id);
    }
  }

  return { removableAttemptIds, removableReservationIds, removableJournalEntryIds };
}
