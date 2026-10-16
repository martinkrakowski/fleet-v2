// Implemented for migration step 2 — shared-host slot arbitration.
/**
 * ReserveExecutionCapacityUseCase: reserve one slot for one attempt under the
 * host's shared budget. A busy worktree blocks the reservation before the
 * slot budget is consulted; a refusal is distinguished from "no free slot".
 * Only a durable reservation in the journal authorizes later dispatch.
 */

import type { CapacityReservationRecord } from '../../domain/execution-records.js';
import type { AttemptStateValue } from '../../domain/value-objects/AttemptState.vo.js';
import type {
  ReserveExecutionCapacityPort,
  ReserveExecutionCapacityRequest,
  ReserveExecutionCapacityResult,
} from '../ports/in/ReserveExecutionCapacityPort.in-port.js';
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
    const allActive = await this.deps.journal.listActiveReservations();
    if (
      allActive.some((reservation) => reservation.attemptId === request.attemptId) ||
      heldReservations.some((reservation) => reservation.attemptId === request.attemptId)
    ) {
      return {
        outcome: 'refused',
        reason: `Attempt ${request.attemptId} already holds an active capacity reservation`,
      };
    }
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

    if (heldReservations.length >= request.maxSlots) {
      return { outcome: 'no-free-slot', heldCount: heldReservations.length, maxSlots: request.maxSlots };
    }

    const usedSlots = new Set(heldReservations.map((reservation) => reservation.slotIndex));
    let slotIndex = 0;
    while (usedSlots.has(slotIndex)) {
      slotIndex += 1;
    }

    const nowIso = request.nowIso ?? new Date().toISOString();
    const reservation: CapacityReservationRecord = {
      id: request.reservationId,
      attemptId: request.attemptId,
      hostId: request.hostId,
      slotIndex,
      held: true,
      reservedAtIso: nowIso,
      releasedAtIso: null,
    };
    await this.deps.journal.saveCapacityReservation(reservation);
    return { outcome: 'reserved', reservation };
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
