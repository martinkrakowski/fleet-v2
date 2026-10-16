// Implemented for migration step 2 — shared-host slot arbitration.
/**
 * ReserveExecutionCapacityUseCase: reserve one slot for one attempt under the
 * host's shared budget. A busy worktree blocks the reservation before the
 * slot budget is consulted; a refusal is distinguished from "no free slot".
 * The duplicate-attempt and slot-budget checks run inside the journal's
 * locked read-modify-write, so a racing claim never superseds another
 * reservation and never exceeds the budget. Only a durable reservation in
 * the journal authorizes later dispatch.
 */

import type { AttemptStateValue } from '../../domain/value-objects/AttemptState.vo.js';
import type {
  ReserveExecutionCapacityPort,
  ReserveExecutionCapacityRequest,
  ReserveExecutionCapacityResult,
} from '../ports/in/ReserveExecutionCapacityPort.in-port.js';
import type { CapacityReservationClaim } from '../ports/out/ExecutionJournalPort.out-port.js';
import type { AttemptRepositoryPort } from '../ports/out/AttemptRepositoryPort.out-port.js';
import type { ExecutionJournalPort } from '../ports/out/ExecutionJournalPort.out-port.js';

export interface ReserveExecutionCapacityDependencies {
  readonly journal: ExecutionJournalPort;
  readonly attemptRepo: AttemptRepositoryPort;
}

/**
 * Attempts in these states still claim their worktree. Ended, collected and
 * cancelled attempts do not; blocked attempts still hold their lane directory.
 */
const WORKTREE_CLAIMING_STATES: readonly AttemptStateValue[] = [
  'intent-recorded',
  'dispatching',
  'running',
  'reconciling',
  'blocked',
];

function isNonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export class ReserveExecutionCapacityUseCase implements ReserveExecutionCapacityPort {
  constructor(private readonly deps?: ReserveExecutionCapacityDependencies) {}

  async reserveExecutionCapacity(
    request: ReserveExecutionCapacityRequest,
  ): Promise<ReserveExecutionCapacityResult> {
    if (!this.deps) {
      throw new Error('Not implemented: ReserveExecutionCapacityUseCase');
    }

    // A non-positive (or non-finite) budget is refused with the original
    // reason; a positive but fractional budget is refused as non-integer so
    // both callers and journals see an exact, stable refusal message.
    if (
      typeof request.maxSlots !== 'number' ||
      !Number.isFinite(request.maxSlots) ||
      request.maxSlots <= 0
    ) {
      return { outcome: 'refused', reason: 'maxSlots must be a positive number' };
    }
    if (!Number.isInteger(request.maxSlots)) {
      return { outcome: 'refused', reason: 'maxSlots must be a positive integer' };
    }
    const requiredFields: readonly (keyof ReserveExecutionCapacityRequest)[] = [
      'reservationId',
      'attemptId',
      'hostId',
      'worktreePath',
    ];
    const missingFields = requiredFields.filter((field) => !isNonEmpty(request[field]));
    if (missingFields.length > 0) {
      return { outcome: 'refused', reason: `Missing required reservation fields: ${missingFields.join(', ')}` };
    }

    const heldReservations = await this.deps.journal.listActiveReservations(request.hostId);
    for (const reservation of heldReservations) {
      const holder = await this.deps.attemptRepo.findAttemptById(reservation.attemptId);
      if (holder && holder.worktreePath === request.worktreePath) {
        return { outcome: 'busy-worktree', blockingAttemptId: reservation.attemptId };
      }
    }

    const allAttempts = await this.deps.attemptRepo.listAllAttempts();
    const conflictingAttempt = allAttempts.find(
      (attempt) =>
        attempt.id !== request.attemptId &&
        attempt.worktreePath === request.worktreePath &&
        WORKTREE_CLAIMING_STATES.includes(attempt.state),
    );
    if (conflictingAttempt) {
      return { outcome: 'busy-worktree', blockingAttemptId: conflictingAttempt.id };
    }

    // The duplicate-attempt and slot-budget checks run inside the journal's
    // locked read-modify-write: a racing claim that slips between this
    // read and the append is still refused by the re-read under the lock.
    const nowIso = request.nowIso ?? new Date().toISOString();
    const claim: CapacityReservationClaim = {
      id: request.reservationId,
      attemptId: request.attemptId,
      hostId: request.hostId,
      held: true,
      reservedAtIso: nowIso,
      releasedAtIso: null,
    };
    const arbitration = await this.deps.journal.reserveCapacityAtomically({
      attemptId: request.attemptId,
      maxSlots: request.maxSlots,
      record: claim,
    });
    if (arbitration.outcome === 'duplicate-attempt') {
      return {
        outcome: 'refused',
        reason: `Attempt ${request.attemptId} already holds an active capacity reservation`,
      };
    }
    if (arbitration.outcome === 'no-free-slot') {
      return {
        outcome: 'no-free-slot',
        heldCount: arbitration.heldCount,
        maxSlots: arbitration.maxSlots,
      };
    }
    return { outcome: 'reserved', reservation: arbitration.reservation };
  }

  async execute(input?: unknown): Promise<ReserveExecutionCapacityResult> {
    // Unconfigured is 501 and is checked before any request validation.
    if (!this.deps) {
      throw new Error('Not implemented: ReserveExecutionCapacityUseCase');
    }
    // A configured runtime still refuses a missing request object instead of
    // inventing one; the HTTP boundary always supplies an object body, and an
    // empty object body flows into the validation below as a refusal.
    if (!input || typeof input !== 'object') {
      throw new Error('Not implemented: ReserveExecutionCapacityUseCase');
    }
    return this.reserveExecutionCapacity(input as ReserveExecutionCapacityRequest);
  }
}
