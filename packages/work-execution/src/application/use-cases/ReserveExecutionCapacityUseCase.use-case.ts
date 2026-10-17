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

import { simpleDeterministicHexDigest } from './PrepareBriefPackageUseCase.use-case.js';

import type { AttemptStateValue } from '../../domain/value-objects/AttemptState.vo.js';
import { parseSeatTool } from '../../domain/execution-records.js';
import type { CapacityReservationRecord, RunnerKind } from '../../domain/execution-records.js';
import type {
  ReserveExecutionCapacityPort,
  ReserveExecutionCapacityRequest,
  ReserveExecutionCapacityResult,
} from '../ports/in/ReserveExecutionCapacityPort.in-port.js';
import type { CapacityReservationClaim, SelectRecordUnderLockVerdict } from '../ports/out/ExecutionJournalPort.out-port.js';
import type { AttemptRepositoryPort } from '../ports/out/AttemptRepositoryPort.out-port.js';
import type { ExecutionJournalPort } from '../ports/out/ExecutionJournalPort.out-port.js';

export interface ReserveExecutionCapacityDependencies {
  readonly journal: ExecutionJournalPort;
  readonly attemptRepo: AttemptRepositoryPort;
  /**
   * Infrastructure digest for the worktree directory name; when absent the
   * pure helper is used, so the application layer stays free of Node
   * built-ins. Only determinism matters here: the path carries no caller text.
   */
  readonly computeDigest?: (content: string) => string;
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
    // both callers and journals see an exact, stable refusal message. The
    // legacy budget check applies only when no candidates are given (H9a2):
    // with candidates the budget is each chosen host's `maxLanes`.
    const candidatesGiven = request.candidateHosts !== undefined && request.candidateHosts !== null;
    // The id fields are required on BOTH paths (H9a fix, review): a request
    // without a reservation id or attempt id must refuse, not skip into the
    // candidates path where those ids are still written into the record.
    // `hostId`/`worktreePath` stay legacy-path-only: with candidates the host
    // and path are chosen in-lock instead.
    const requiredFields: readonly (keyof ReserveExecutionCapacityRequest)[] = candidatesGiven
      ? ['reservationId', 'attemptId']
      : ['reservationId', 'attemptId', 'hostId', 'worktreePath'];
    const missingFields = requiredFields.filter((field) => !isNonEmpty(request[field]));
    if (missingFields.length > 0) {
      return { outcome: 'refused', reason: `Missing required reservation fields: ${missingFields.join(', ')}` };
    }
    if (!candidatesGiven) {
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
    // With `candidateHosts` (H9a2) the host comes from the in-lock selection
    // instead, so this request-level host applies only to the legacy path.
    let host: {
      hostName: string | null;
      hostKind: RunnerKind | null;
      transport: 'local' | 'ssh' | null;
      sshAlias: string | null;
      port: number | null;
    } = { hostName: null, hostKind: null, transport: null, sshAlias: null, port: null };
    if (!candidatesGiven && request.host !== undefined && request.host !== null) {
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

    // The candidate hosts (H9a2): validated up front; the choice itself runs
    // inside the journal's locked read-modify-write so held reservations are
    // counted under the same lock that grants the slot.
    const candidates: {
      name: string;
      kind: RunnerKind;
      transport: 'local' | 'ssh';
      sshAlias: string | null;
      port: number | null;
      maxLanes: number;
      worktreeRoot: string;
    }[] = [];
    if (candidatesGiven) {
      const given = request.candidateHosts as unknown;
      if (!Array.isArray(given) || given.length === 0) {
        return {
          outcome: 'refused',
          reason: 'candidateHosts must be a non-empty array of host objects when given',
        };
      }
      for (const [index, entry] of given.entries()) {
        const label = `candidateHosts[${index}]`;
        if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
          return { outcome: 'refused', reason: `${label} must be an object` };
        }
        const candidate = entry as Record<string, unknown>;
        const name = typeof candidate.name === 'string' ? candidate.name.trim() : '';
        if (name === '') {
          return { outcome: 'refused', reason: `${label}.name must be a non-empty string` };
        }
        const kind = parseSeatTool(candidate.kind);
        if (kind === undefined) {
          return {
            outcome: 'refused',
            reason: `${label}.kind must be a declared runner kind (opencode or agy)`,
          };
        }
        const transport = candidate.transport;
        if (transport !== 'local' && transport !== 'ssh') {
          return { outcome: 'refused', reason: `${label}.transport must be "local" or "ssh"` };
        }
        const sshAlias =
          typeof candidate.sshAlias === 'string' && candidate.sshAlias.trim() !== ''
            ? candidate.sshAlias.trim()
            : null;
        if (transport === 'ssh' && sshAlias === null) {
          return {
            outcome: 'refused',
            reason: `${label}.sshAlias is required when transport is "ssh"`,
          };
        }
        const port = typeof candidate.port === 'number' ? candidate.port : null;
        if (port !== null && (!Number.isInteger(port) || port < 1)) {
          return {
            outcome: 'refused',
            reason: `${label}.port must be a positive integer or null`,
          };
        }
        const worktreeRoot = typeof candidate.worktreeRoot === 'string' ? candidate.worktreeRoot.trim() : '';
        if (worktreeRoot === '') {
          return { outcome: 'refused', reason: `${label}.worktreeRoot must be a non-empty string` };
        }
        const maxLanes = typeof candidate.maxLanes === 'number' ? candidate.maxLanes : 1;
        if (!Number.isInteger(maxLanes) || maxLanes < 1) {
          return { outcome: 'refused', reason: `${label}.maxLanes must be a positive integer` };
        }
        candidates.push({ name, kind, transport, sshAlias, port, maxLanes, worktreeRoot });
      }
    }

    // Only hosts whose runner kind equals the seat's tool are eligible; the
    // selector never falls back to another kind (H9a2).
    const eligible = candidates.filter((candidate) => candidate.kind === seatTool);
    if (candidatesGiven && eligible.length === 0) {
      return {
        outcome: 'refused',
        reason: `no candidate host declares runner kind '${seatTool}'; refusing rather than falling back to another kind`,
      };
    }

    // The busy-worktree, duplicate-attempt and slot-budget checks all run
    // inside the journal's locked read-modify-write (Opus note on #58): a
    // conflicting reservation that lands between the request and the append
    // is still refused by the re-read under the lock.
    const nowIso = request.nowIso ?? new Date().toISOString();
    const claim: CapacityReservationClaim | null = candidatesGiven
      ? null
      : {
          id: request.reservationId,
          attemptId: request.attemptId,
          hostId: request.hostId as string,
          worktreePath: request.worktreePath as string,
          seatTool,
          ...host,
          held: true,
          reservedAtIso: nowIso,
          releasedAtIso: null,
        };

    // H9a2: the worktree path is allocated from the attempt id's digest, so
    // no caller text ever reaches a path. The chosen host's root is prepended
    // inside the lock, after the host is selected.
    const worktreeDigest = (deps.computeDigest ?? simpleDeterministicHexDigest)(request.attemptId).slice(0, 32);

    type ChosenHost = {
      hostName: string;
      hostKind: RunnerKind;
      transport: 'local' | 'ssh';
      sshAlias: string | null;
      port: number | null;
    };
    let chosen: { host: ChosenHost; worktreePath: string; maxSlots: number } | null = null;

    /**
     * The in-lock selection (H9a2): count held reservations per host name,
     * keep the candidates with a free slot, and pick the one with the most
     * free slots (ties by name). No candidate with a free slot is
     * `no-capacity`. The busy-worktree check below reads `chosen` for the
     * (host name, path) pair, so it always arbitrates the host this claim
     * would actually land on.
     */
    const selectRecord =
      candidatesGiven && claim === null
        ? async (
            held: readonly CapacityReservationRecord[],
          ): Promise<SelectRecordUnderLockVerdict> => {
            const heldPerHostName = new Map<string, number>();
            for (const reservation of held) {
              if (reservation.held !== true) continue;
              const key = reservation.hostName ?? reservation.hostId;
              heldPerHostName.set(key, (heldPerHostName.get(key) ?? 0) + 1);
            }
            let best: (typeof eligible)[number] | null = null;
            let bestFreeSlots = 0;
            for (const candidate of eligible) {
              const freeSlots = candidate.maxLanes - (heldPerHostName.get(candidate.name) ?? 0);
              if (freeSlots <= 0) continue;
              if (
                best === null ||
                freeSlots > bestFreeSlots ||
                (freeSlots === bestFreeSlots && candidate.name < best.name)
              ) {
                best = candidate;
                bestFreeSlots = freeSlots;
              }
            }
            if (best === null) {
              return { outcome: 'no-capacity' };
            }
            const worktreePath = `${best.worktreeRoot.replace(/\/+$/, '')}/${worktreeDigest}`;
            const hostFields: ChosenHost = {
              hostName: best.name,
              hostKind: best.kind,
              transport: best.transport,
              sshAlias: best.sshAlias,
              port: best.port,
            };
            chosen = { host: hostFields, worktreePath, maxSlots: best.maxLanes };
            return {
              outcome: 'selected',
              maxSlots: best.maxLanes,
              record: {
                id: request.reservationId,
                attemptId: request.attemptId,
                hostId: best.name,
                worktreePath,
                seatTool,
                ...hostFields,
                held: true,
                reservedAtIso: nowIso,
                releasedAtIso: null,
              },
            };
          }
        : undefined;

    const arbitration = await deps.journal.reserveCapacityAtomically({
      attemptId: request.attemptId,
      ...(claim !== null ? { record: claim, maxSlots: request.maxSlots as number } : {}),
      ...(selectRecord !== undefined ? { selectRecord } : {}),
      checkBusyWorktree: async (held) => {
        // With candidates the path exists only after the in-lock selection
        // has run (the adapter always selects before arbitrating); the check
        // is a (host name, path) pair on the chosen host. Without candidates
        // the legacy caller-supplied path blocks across every host.
        const busyPath = chosen !== null ? chosen.worktreePath : request.worktreePath;
        if (busyPath === undefined) {
          return { outcome: 'ok' };
        }
        if (candidatesGiven) {
          const chosenHostName = chosen?.host.hostName ?? null;
          for (const reservation of held) {
            if (reservation.hostName !== chosenHostName) continue;
            if (reservation.worktreePath === busyPath) {
              return { outcome: 'busy-worktree', blockingAttemptId: reservation.attemptId };
            }
            const holder = await deps.attemptRepo.findAttemptById(reservation.attemptId);
            if (holder && holder.worktreePath === busyPath) {
              return { outcome: 'busy-worktree', blockingAttemptId: reservation.attemptId };
            }
          }
          return { outcome: 'ok' };
        }
        for (const reservation of held) {
          const holder = await deps.attemptRepo.findAttemptById(reservation.attemptId);
          if (holder && holder.worktreePath === busyPath) {
            return { outcome: 'busy-worktree', blockingAttemptId: reservation.attemptId };
          }
        }
        const allAttempts = await deps.attemptRepo.listAllAttempts();
        const conflictingAttempt = allAttempts.find(
          (attempt) =>
            attempt.id !== request.attemptId &&
            attempt.worktreePath === busyPath &&
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
    if (arbitration.outcome === 'no-capacity') {
      return { outcome: 'no-capacity' };
    }
    if (arbitration.outcome === 'refused') {
      return { outcome: 'refused', reason: arbitration.reason };
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
