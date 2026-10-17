// Implemented for migration step 2 — shared-host slot arbitration.
/**
 * ReserveExecutionCapacityUseCase: reserve one slot for one attempt under the
 * host's shared budget. The busy-worktree check runs inside the journal's
 * locked read-modify-write (Opus note on #58), so a conflicting reservation
 * that lands while the claim is in flight is still refused; a refusal is
 * distinguished from "no free slot". The duplicate-attempt, busy-worktree and
 * slot-budget checks all run under the lock, so a racing claim never
 * supersedes another reservation and never exceeds the budget. Only a durable
 * reservation in the journal authorizes later dispatch.
 */

import type { AttemptStateValue } from '../../domain/value-objects/AttemptState.vo.js';
import { parseSeatTool } from '../../domain/execution-records.js';
import type { RunnerKind } from '../../domain/execution-records.js';
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
    const deps = this.deps;
    if (!deps) {
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

    // The seat tool is required and never defaulted (H8): a blank, unknown or
    // wrong-case tool is a refusal, not an opencode seat.
    const seatTool = parseSeatTool(request.seatTool);
    if (seatTool === undefined) {
      return {
        outcome: 'refused',
        reason: 'seatTool must be a declared runner kind (opencode or agy)',
      };
    }

    // The host fields (H9a1): validated when given, all null when absent.
    let host: {
      hostName: string | null;
      hostKind: RunnerKind | null;
      transport: 'local' | 'ssh' | null;
      sshAlias: string | null;
      port: number | null;
    } = { hostName: null, hostKind: null, transport: null, sshAlias: null, port: null };
    if (request.host !== undefined && request.host !== null) {
      const given = request.host;
      if (typeof given !== 'object' || Array.isArray(given)) {
        return { outcome: 'refused', reason: 'host must be an object' };
      }
      const hostName = typeof given.hostName === 'string' ? given.hostName.trim() : '';
      if (hostName === '') {
        return { outcome: 'refused', reason: 'host.hostName must be a non-empty string' };
      }
      const hostKind = parseSeatTool(given.hostKind);
      if (hostKind === undefined) {
        return {
          outcome: 'refused',
          reason: 'host.hostKind must be a declared runner kind (opencode or agy)',
        };
      }
      const transport = given.transport;
      if (transport !== 'local' && transport !== 'ssh') {
        return { outcome: 'refused', reason: 'host.transport must be "local" or "ssh"' };
      }
      const sshAlias =
        typeof given.sshAlias === 'string' && given.sshAlias.trim() !== ''
          ? given.sshAlias.trim()
          : null;
      if (transport === 'ssh' && sshAlias === null) {
        return {
          outcome: 'refused',
          reason: 'host.sshAlias is required when host.transport is "ssh"',
        };
      }
      const port = typeof given.port === 'number' ? given.port : null;
      if (port !== null && (!Number.isInteger(port) || port < 1)) {
        return {
          outcome: 'refused',
          reason: 'host.port must be a positive integer or null',
        };
      }
      host = { hostName, hostKind, transport, sshAlias, port };
    }

    // The busy-worktree, duplicate-attempt and slot-budget checks all run
    // inside the journal's locked read-modify-write (Opus note on #58): a
    // conflicting reservation that lands between the request and the append
    // is still refused by the re-read under the lock.
    const nowIso = request.nowIso ?? new Date().toISOString();
    const claim: CapacityReservationClaim = {
      id: request.reservationId,
      attemptId: request.attemptId,
      hostId: request.hostId,
      seatTool,
      ...host,
      held: true,
      reservedAtIso: nowIso,
      releasedAtIso: null,
    };
    const arbitration = await deps.journal.reserveCapacityAtomically({
      attemptId: request.attemptId,
      maxSlots: request.maxSlots,
      record: claim,
      checkBusyWorktree: async (held) => {
        for (const reservation of held) {
          const holder = await deps.attemptRepo.findAttemptById(reservation.attemptId);
          if (holder && holder.worktreePath === request.worktreePath) {
            return { outcome: 'busy-worktree', blockingAttemptId: reservation.attemptId };
          }
        }
        const allAttempts = await deps.attemptRepo.listAllAttempts();
        const conflictingAttempt = allAttempts.find(
          (attempt) =>
            attempt.id !== request.attemptId &&
            attempt.worktreePath === request.worktreePath &&
            WORKTREE_CLAIMING_STATES.includes(attempt.state),
        );
        return conflictingAttempt
          ? { outcome: 'busy-worktree', blockingAttemptId: conflictingAttempt.id }
          : { outcome: 'ok' };
      },
    });
    if (arbitration.outcome === 'busy-worktree') {
      return { outcome: 'busy-worktree', blockingAttemptId: arbitration.blockingAttemptId };
    }
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
