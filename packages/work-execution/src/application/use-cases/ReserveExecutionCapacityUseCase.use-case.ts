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

    if (typeof request.maxSlots !== 'number' || !Number.isFinite(request.maxSlots) || request.maxSlots <= 0) {
      return { outcome: 'refused', reason: 'maxSlots must be a positive number' };
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
      if (reservation.attemptId === request.attemptId) {
        continue;
      }
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
    if (!this.deps || !input || typeof input !== 'object') {
      throw new Error('Not implemented: ReserveExecutionCapacityUseCase');
    }
    return this.reserveExecutionCapacity(input as ReserveExecutionCapacityRequest);
  }
}
