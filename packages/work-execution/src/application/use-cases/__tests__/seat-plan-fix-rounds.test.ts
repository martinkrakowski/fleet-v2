/**
 * S1c tests: fix rounds rotate through the seat plan; collection records the
 * stop reason; acceptance refuses a reviewer in the family of any implementer
 * that ran in the lane. Every dependency is an in-memory fake; no filesystem,
 * subprocess, network or clock-dependent behaviour is exercised.
 */

import { describe, expect, it } from 'vitest';

import type {
  ActionJournalEntryRecord,
  AttemptRecord,
  AttemptRunnerRecord,
  AttemptSeatSelectionRecord,
  CapacityReservationRecord,
  CommandCompletionReceipt,
} from '../../../domain/execution-records.js';
import type { CollectCompletedAttemptArtifactsResult } from '../../ports/out/AttemptArtifactPort.out-port.js';
import type { AttemptArtifactPort } from '../../ports/out/AttemptArtifactPort.out-port.js';
import type { AttemptRepositoryPort } from '../../ports/out/AttemptRepositoryPort.out-port.js';
import type {
  ExecutionJournalPort,
  ReserveCapacityAtomicallyRequest,
  ReserveCapacityAtomicallyResult,
} from '../../ports/out/ExecutionJournalPort.out-port.js';
import type {
  AcceptanceAssessmentPort,
  AcceptanceAssessmentRequest,
  AcceptanceAssessmentResult,
} from '../../ports/out/AcceptanceAssessmentPort.out-port.js';
import type { RequestAttemptAcceptanceRequest } from '../../ports/in/RequestAttemptAcceptancePort.in-port.js';
import { CollectAttemptArtifactsUseCase } from '../CollectAttemptArtifactsUseCase.use-case.js';
import { PrepareFixAttemptUseCase } from '../PrepareFixAttemptUseCase.use-case.js';
import { RequestAttemptAcceptanceUseCase } from '../RequestAttemptAcceptanceUseCase.use-case.js';
import { SeatPlan } from '../../../domain/value-objects/SeatPlan.vo.js';

/** The seat plan used across these tests (S1c brief). */
const PLAN_RAW = {
  version: 1,
  'first-pass': [{ id: 'fp-1', model: 'acme/mercury-3', tool: 'opencode' }],
  fix: [
    { id: 'fx-1', model: 'acme/argon-4', tool: 'opencode' },
    { id: 'fx-2', model: 'acme/glm-5.3', tool: 'opencode', variant: 'low' },
    { id: 'fx-3', model: 'acme/laguna-2', tool: 'opencode', on: ['payment', 'rate-limited'] },
  ],
  review: [{ id: 'rv-1', model: 'acme/grok-4.7' }],
};
const planJson = SeatPlan.create(PLAN_RAW).value!.toJSON();

const fpSelection = {
  role: 'first-pass',
  seatIndex: 0,
  seatId: 'fp-1',
  model: 'acme/mercury-3',
  tool: 'opencode',
  variant: null,
  agent: null,
} as const;

function fixSelection(
  seatIndex: number,
  seatId: string,
  model: string,
  variant: string | null,
): AttemptSeatSelectionRecord {
  return { role: 'fix', seatIndex, seatId, model, tool: 'opencode', variant, agent: null };
}

function runnerModel(model: string, variant: string | null = null): AttemptRunnerRecord {
  return { kind: 'opencode', remotePort: 4166, host: null, agent: null, model, variant };
}

const RUNNER_MERCURY = runnerModel('acme/mercury-3');

function makeAttemptRepo(): AttemptRepositoryPort & { attempts: Map<string, AttemptRecord> } {
  const attempts = new Map<string, AttemptRecord>();
  return {
    attempts,
    async saveAttempt(record) {
      attempts.set(record.id, record);
    },
    async findAttemptById(attemptId) {
      return attempts.get(attemptId) ?? null;
    },
    async listAttemptsByWorkOrder(workOrderId) {
      return [...attempts.values()].filter((attempt) => attempt.workOrderId === workOrderId);
    },
    async listAllAttempts() {
      return [...attempts.values()];
    },
  };
}

function makeJournal(): ExecutionJournalPort & {
  entries: ActionJournalEntryRecord[];
  reservations: Map<string, CapacityReservationRecord>;
  releaseCount: number;
  heldFor(attemptId: string): boolean;
} {
  const entries: ActionJournalEntryRecord[] = [];
  const reservations = new Map<string, CapacityReservationRecord>();
  const journalState: ExecutionJournalPort & {
    entries: ActionJournalEntryRecord[];
    reservations: Map<string, CapacityReservationRecord>;
    releaseCount: number;
    heldFor(attemptId: string): boolean;
  } = {
    entries,
    reservations,
    releaseCount: 0,
    heldFor(attemptId) {
      return [...reservations.values()].some((r) => r.attemptId === attemptId && r.held);
    },
    async appendJournalEntry(entry) {
      entries.push(entry);
    },
    async listJournalEntriesForAttempt(attemptId) {
      return entries.filter((entry) => entry.attemptId === attemptId);
    },
    async saveCapacityReservation(reservation) {
      reservations.set(reservation.id, reservation);
    },
    async listActiveReservations(hostId) {
      return [...reservations.values()].filter(
        (reservation) => reservation.held && (hostId === undefined || reservation.hostId === hostId),
      );
    },
    async releaseCapacityReservation(attemptId, releasedAtIso) {
      journalState.releaseCount += 1;
      for (const [id, reservation] of reservations) {
        if (reservation.attemptId === attemptId && reservation.held) {
          reservations.set(id, { ...reservation, held: false, releasedAtIso });
          return true;
        }
      }
      return false;
    },
    async reserveCapacityAtomically(
      request: ReserveCapacityAtomicallyRequest,
    ): Promise<ReserveCapacityAtomicallyResult> {
      const held = [...reservations.values()].filter((reservation) => reservation.held);
      if (request.checkBusyWorktree !== undefined) {
        const verdict = await request.checkBusyWorktree(held);
        if (verdict.outcome === 'busy-worktree') {
          return { outcome: 'busy-worktree', blockingAttemptId: verdict.blockingAttemptId };
        }
      }
      const duplicate = held.find((reservation) => reservation.attemptId === request.attemptId);
      if (duplicate !== undefined) {
        return {
          outcome: 'duplicate-attempt',
          attemptId: request.attemptId,
          existingReservationId: duplicate.id,
        };
      }
      const heldOnHost = held.filter((reservation) => reservation.hostId === request.record?.hostId);
      const maxSlots = request.maxSlots ?? 0;
      if (heldOnHost.length >= maxSlots) {
        return { outcome: 'no-free-slot', heldCount: heldOnHost.length, maxSlots };
      }
      const usedSlots = new Set(heldOnHost.map((reservation) => reservation.slotIndex));
      let slotIndex = 0;
      while (usedSlots.has(slotIndex)) {
        slotIndex += 1;
      }
      const reservation: CapacityReservationRecord = { ...request.record!, slotIndex };
      reservations.set(reservation.id, reservation);
      return { outcome: 'reserved', reservation };
    },
  };
  return journalState;
}

function storedAttempt(overrides: Partial<AttemptRecord> = {}): AttemptRecord {
  return {
    id: 'attempt-1',
    workOrderId: 'wo-1',
    kind: 'initial',
    fixNumber: 0,
    priorAttemptId: null,
    worktreePath: '/lanes/attempt-1',
    baseCommit: 'abc123',
    state: 'running',
    outcome: null,
    briefDigest: 'digest-1',
    briefPackagePath: '.lane/brief.md',
    sessionId: 'session-1',
    completionReceipt: null,
    artifacts: null,
    createdAtIso: '2026-10-15T08:00:00.000Z',
    updatedAtIso: '2026-10-15T08:00:00.000Z',
    ...overrides,
  };
}

function storedReservation(overrides: Partial<CapacityReservationRecord> = {}): CapacityReservationRecord {
  return {
    id: 'res-1',
    attemptId: 'attempt-1',
    hostId: 'host-1',
    slotIndex: 0,
    held: true,
    seatTool: 'opencode',
    reservedAtIso: '2026-10-15T08:00:00.000Z',
    releasedAtIso: null,
    ...overrides,
  };
}

function completionReceipt(overrides: Partial<CommandCompletionReceipt> = {}): CommandCompletionReceipt {
  return {
    attemptId: 'attempt-1',
    sessionId: 'session-1',
    endedAtIso: '2026-10-15T09:00:00.000Z',
    authoritative: true,
    exitStatus: 0,
    stoppedByRequest: false,
    ...overrides,
  };
}

function validCollectRequest(overrides: Record<string, unknown> = {}) {
  return {
    attemptId: 'attempt-1',
    workOrderId: 'wo-1',
    worktreePath: '/lanes/attempt-1',
    baseCommit: 'abc123',
    expectedArtifacts: ['dist/report.json'],
    completionReceipt: completionReceipt(),
    ...overrides,
  };
}

function makeArtifactPort(
  options: {
    offendingPaths?: readonly string[];
    placeRefusedReason?: string;
    prosePath?: string;
    manifestPath?: string;
    collectResult?: CollectCompletedAttemptArtifactsResult;
  } = {},
) {
  const verifiedCalls: Parameters<AttemptArtifactPort['verifyIgnoredPaths']>[0][] = [];
  const placedCalls: Parameters<AttemptArtifactPort['placeFrozenBrief']>[0][] = [];
  const collectCalls: Parameters<AttemptArtifactPort['collectCompletedAttemptArtifacts']>[0][] = [];
  const port: AttemptArtifactPort = {
    async verifyIgnoredPaths(request) {
      verifiedCalls.push(request);
      const offendingPaths = request.candidatePaths.filter((path) => options.offendingPaths?.includes(path));
      if (offendingPaths.length > 0) {
        return { outcome: 'not-ignored', offendingPaths };
      }
      return { outcome: 'ignored', checkedPaths: request.candidatePaths };
    },
    async placeFrozenBrief(request) {
      placedCalls.push(request);
      if (options.placeRefusedReason) {
        return { outcome: 'refused', reason: options.placeRefusedReason };
      }
      return {
        outcome: 'placed',
        prosePath: options.prosePath ?? '.lane/brief.md',
        manifestPath: options.manifestPath ?? '.lane/brief-manifest.json',
      };
    },
    async collectCompletedAttemptArtifacts(request) {
      collectCalls.push(request);
      if (options.collectResult) {
        return options.collectResult;
      }
      return {
        outcome: 'collected',
        artifacts: {
          headCommit: 'head456',
          commitsSinceBase: ['commit-1'],
          collectedArtifactPaths: ['dist/report.json'],
          notes: 'present',
        },
      };
    },
  };
  return { port, verifiedCalls, placedCalls, collectCalls };
}

function makeCollectSetup(
  options: {
    attempt?: Partial<AttemptRecord>;
    collectResult?: CollectCompletedAttemptArtifactsResult;
    withReservation?: boolean;
  } = {},
) {
  const attemptRepo = makeAttemptRepo();
  attemptRepo.attempts.set(
    'attempt-1',
    storedAttempt({
      state: 'ended',
      sessionId: 'session-1',
      completionReceipt: completionReceipt(),
      ...options.attempt,
    }),
  );
  const journal = makeJournal();
  if (options.withReservation ?? true) {
    journal.reservations.set('res-1', storedReservation({ id: 'res-1', attemptId: 'attempt-1' }));
  }
  const artifacts = makeArtifactPort({ collectResult: options.collectResult });
  const useCase = new CollectAttemptArtifactsUseCase({
    attemptRepo,
    journal,
    artifactPort: artifacts.port,
  });
  return { attemptRepo, journal, artifacts, useCase };
}

function validFixRequest(overrides: Record<string, unknown> = {}) {
  return {
    fixAttemptId: 'attempt-fix-1',
    workOrderId: 'wo-1',
    priorAttemptId: 'attempt-1',
    worktreePath: '/lanes/attempt-1',
    baseCommit: 'abc123',
    numberedFixes: ['1. Address the review finding about error mapping'],
    nowIso: '2026-10-15T10:00:00.000Z',
    ...overrides,
  };
}

function makeFixSetup(options: { prior?: Partial<AttemptRecord>; existingFix?: AttemptRecord } = {}) {
  const attemptRepo = makeAttemptRepo();
  attemptRepo.attempts.set(
    'attempt-1',
    storedAttempt({ state: 'collected', fixNumber: 0, kind: 'initial', ...options.prior }),
  );
  if (options.existingFix) {
    attemptRepo.attempts.set(options.existingFix.id, options.existingFix);
  }
  const useCase = new PrepareFixAttemptUseCase({ attemptRepo });
  return { attemptRepo, useCase };
}

describe('PrepareFixAttemptUseCase seat plan', () => {
  it('selects fx-1 for a collected gate-failed prior that carries a seat plan and saves it', async () => {
    const setup = makeFixSetup({
      prior: {
        state: 'collected',
        outcome: 'done',
        stopReason: 'gate-failed',
        seatPlan: planJson,
        seatSelection: fpSelection,
        runner: RUNNER_MERCURY,
      },
    });

    const result = await setup.useCase.prepareFixAttempt(validFixRequest());

    expect(result.outcome).toBe('prepared');
    if (result.outcome !== 'prepared') {
      throw new Error('unreachable');
    }
    expect(result.attempt.seatPlan).toEqual(planJson);
    expect(result.attempt.seatSelection).toEqual(fixSelection(0, 'fx-1', 'acme/argon-4', null));
    const saved = setup.attemptRepo.attempts.get('attempt-fix-1');
    expect(saved?.seatPlan).toEqual(planJson);
    expect(saved?.seatSelection?.role).toBe('fix');
    expect(saved?.seatSelection?.seatIndex).toBe(0);
    expect(saved?.seatSelection?.seatId).toBe('fx-1');
  });

  it('rotates fix seats round-robin, wraps, and leaves a trigger-gated fallback waiting', async () => {
    const setup = makeFixSetup({
      prior: {
        state: 'collected',
        outcome: 'done',
        stopReason: 'gate-failed',
        seatPlan: planJson,
        seatSelection: fpSelection,
        runner: RUNNER_MERCURY,
        createdAtIso: '2026-10-15T08:00:00.000Z',
      },
    });

    const first = await setup.useCase.prepareFixAttempt(
      validFixRequest({ nowIso: '2026-10-15T09:00:00.000Z' }),
    );
    expect(first.outcome).toBe('prepared');
    expect(first.outcome === 'prepared' && first.attempt.seatSelection?.seatId).toBe('fx-1');
    setup.attemptRepo.attempts.set(
      'attempt-fix-1',
      storedAttempt({
        id: 'attempt-fix-1',
        kind: 'fix',
        fixNumber: 1,
        priorAttemptId: 'attempt-1',
        state: 'collected',
        outcome: 'done',
        stopReason: 'none',
        seatPlan: planJson,
        seatSelection: fixSelection(0, 'fx-1', 'acme/argon-4', null),
        runner: runnerModel('acme/argon-4'),
        createdAtIso: '2026-10-15T09:00:00.000Z',
        updatedAtIso: '2026-10-15T09:00:00.000Z',
      }),
    );

    const second = await setup.useCase.prepareFixAttempt(
      validFixRequest({ fixAttemptId: 'attempt-fix-2', priorAttemptId: 'attempt-fix-1', nowIso: '2026-10-15T10:00:00.000Z' }),
    );
    expect(second.outcome).toBe('prepared');
    expect(second.outcome === 'prepared' && second.attempt.seatSelection?.seatId).toBe('fx-2');
    setup.attemptRepo.attempts.set(
      'attempt-fix-2',
      storedAttempt({
        id: 'attempt-fix-2',
        kind: 'fix',
        fixNumber: 2,
        priorAttemptId: 'attempt-fix-1',
        state: 'collected',
        outcome: 'done',
        stopReason: 'none',
        seatPlan: planJson,
        seatSelection: fixSelection(1, 'fx-2', 'acme/glm-5.3', 'low'),
        runner: runnerModel('acme/glm-5.3', 'low'),
        createdAtIso: '2026-10-15T10:00:00.000Z',
        updatedAtIso: '2026-10-15T10:00:00.000Z',
      }),
    );

    const third = await setup.useCase.prepareFixAttempt(
      validFixRequest({ fixAttemptId: 'attempt-fix-3', priorAttemptId: 'attempt-fix-2', nowIso: '2026-10-15T11:00:00.000Z' }),
    );
    expect(third.outcome).toBe('prepared');
    if (third.outcome !== 'prepared') {
      throw new Error('unreachable');
    }
    // Wraps past fx-3 (still waiting for its trigger) back to fx-1.
    expect(third.attempt.seatSelection?.seatId).toBe('fx-1');
  });

  it('does not re-run a model refused for payment, and lets a triggered fallback join', async () => {
    const setup = makeFixSetup({
      prior: {
        state: 'cancelled',
        outcome: 'stopped',
        stopReason: 'rate-limited',
        seatPlan: planJson,
        seatSelection: fpSelection,
        runner: RUNNER_MERCURY,
        createdAtIso: '2026-10-15T08:00:00.000Z',
      },
    });

    const first = await setup.useCase.prepareFixAttempt(
      validFixRequest({ nowIso: '2026-10-15T09:00:00.000Z' }),
    );
    expect(first.outcome).toBe('prepared');
    expect(first.outcome === 'prepared' && first.attempt.seatSelection?.seatId).toBe('fx-1');
    setup.attemptRepo.attempts.set(
      'attempt-fix-1',
      storedAttempt({
        id: 'attempt-fix-1',
        kind: 'fix',
        fixNumber: 1,
        priorAttemptId: 'attempt-1',
        state: 'cancelled',
        outcome: 'stopped',
        stopReason: 'payment',
        seatPlan: planJson,
        seatSelection: fixSelection(0, 'fx-1', 'acme/argon-4', null),
        runner: runnerModel('acme/argon-4'),
        createdAtIso: '2026-10-15T09:00:00.000Z',
        updatedAtIso: '2026-10-15T09:00:00.000Z',
      }),
    );

    const second = await setup.useCase.prepareFixAttempt(
      validFixRequest({ fixAttemptId: 'attempt-fix-2', priorAttemptId: 'attempt-fix-1', nowIso: '2026-10-15T10:00:00.000Z' }),
    );
    expect(second.outcome).toBe('prepared');
    expect(second.outcome === 'prepared' && second.attempt.seatSelection?.seatId).toBe('fx-2');
    setup.attemptRepo.attempts.set(
      'attempt-fix-2',
      storedAttempt({
        id: 'attempt-fix-2',
        kind: 'fix',
        fixNumber: 2,
        priorAttemptId: 'attempt-fix-1',
        state: 'collected',
        outcome: 'done',
        stopReason: 'none',
        seatPlan: planJson,
        seatSelection: fixSelection(1, 'fx-2', 'acme/glm-5.3', 'low'),
        runner: runnerModel('acme/glm-5.3', 'low'),
        createdAtIso: '2026-10-15T10:00:00.000Z',
        updatedAtIso: '2026-10-15T10:00:00.000Z',
      }),
    );

    const third = await setup.useCase.prepareFixAttempt(
      validFixRequest({ fixAttemptId: 'attempt-fix-3', priorAttemptId: 'attempt-fix-2', nowIso: '2026-10-15T11:00:00.000Z' }),
    );
    expect(third.outcome).toBe('prepared');
    expect(third.outcome === 'prepared' && third.attempt.seatSelection?.seatId).toBe('fx-3');
    setup.attemptRepo.attempts.set(
      'attempt-fix-3',
      storedAttempt({
        id: 'attempt-fix-3',
        kind: 'fix',
        fixNumber: 3,
        priorAttemptId: 'attempt-fix-2',
        state: 'collected',
        outcome: 'done',
        stopReason: 'none',
        seatPlan: planJson,
        seatSelection: fixSelection(2, 'fx-3', 'acme/laguna-2', null),
        runner: runnerModel('acme/laguna-2'),
        createdAtIso: '2026-10-15T11:00:00.000Z',
        updatedAtIso: '2026-10-15T11:00:00.000Z',
      }),
    );

    const fourth = await setup.useCase.prepareFixAttempt(
      validFixRequest({ fixAttemptId: 'attempt-fix-4', priorAttemptId: 'attempt-fix-3', nowIso: '2026-10-15T12:00:00.000Z' }),
    );
    expect(fourth.outcome).toBe('prepared');
    if (fourth.outcome !== 'prepared') {
      throw new Error('unreachable');
    }
    // fx-1's model sits out (payment); fx-2 is next.
    expect(fourth.attempt.seatSelection?.seatId).toBe('fx-2');
  });

  it('skips an unhealthy fix seat', async () => {
    const setup = makeFixSetup({
      prior: {
        state: 'collected',
        outcome: 'done',
        stopReason: 'none',
        seatPlan: planJson,
        seatSelection: fpSelection,
        runner: RUNNER_MERCURY,
      },
    });

    const result = await setup.useCase.prepareFixAttempt(validFixRequest({ unhealthySeatIds: ['fx-1'] }));

    expect(result.outcome).toBe('prepared');
    if (result.outcome !== 'prepared') {
      throw new Error('unreachable');
    }
    expect(result.attempt.seatSelection?.seatId).toBe('fx-2');
  });

  it('refuses when every fix seat is unavailable', async () => {
    const setup = makeFixSetup({
      prior: {
        state: 'collected',
        outcome: 'done',
        stopReason: 'gate-failed',
        seatPlan: planJson,
        seatSelection: fpSelection,
        runner: RUNNER_MERCURY,
      },
    });

    const result = await setup.useCase.prepareFixAttempt(
      validFixRequest({ unhealthySeatIds: ['fx-1', 'fx-2'] }),
    );

    expect(result.outcome).toBe('refused');
    if (result.outcome === 'refused') {
      expect(result.reason).toMatch(/^No fix seat available: Seat plan exhausted for role fix: /);
      expect(result.reason).toContain('fx-3: waits for payment|rate-limited');
    }
  });

  it('refuses a non-array unhealthySeatIds', async () => {
    const setup = makeFixSetup({
      prior: {
        state: 'collected',
        outcome: 'done',
        stopReason: 'none',
        seatPlan: planJson,
        seatSelection: fpSelection,
        runner: RUNNER_MERCURY,
      },
    });

    const result = await setup.useCase.prepareFixAttempt(
      validFixRequest({ unhealthySeatIds: 'fx-1' as unknown as readonly string[] }),
    );

    expect(result).toEqual({ outcome: 'refused', reason: 'unhealthySeatIds must be an array of strings' });
  });

  it('keeps today’s behaviour for a prior without a seat plan (D1)', async () => {
    const setup = makeFixSetup({ prior: { state: 'collected' } });

    const result = await setup.useCase.prepareFixAttempt(validFixRequest({ unhealthySeatIds: ['fx-1'] }));

    expect(result.outcome).toBe('prepared');
    if (result.outcome !== 'prepared') {
      throw new Error('unreachable');
    }
    expect('seatPlan' in result.attempt).toBe(false);
    expect('seatSelection' in result.attempt).toBe(false);
    const saved = setup.attemptRepo.attempts.get('attempt-fix-1');
    expect(saved && 'seatPlan' in saved).toBe(false);
    expect(saved && 'seatSelection' in saved).toBe(false);
  });

  it('refuses a prior that carries an invalid seat plan', async () => {
    const setup = makeFixSetup({
      prior: {
        state: 'collected',
        seatPlan: { version: 9 } as unknown as AttemptRecord['seatPlan'],
        seatSelection: fpSelection,
      },
    });

    const result = await setup.useCase.prepareFixAttempt(validFixRequest());

    expect(result.outcome).toBe('refused');
    if (result.outcome === 'refused') {
      expect(result.reason).toMatch(/^Prior attempt carries an invalid seat plan: /);
    }
  });

  it('orders lane history by createdAtIso, not repository insertion order', async () => {
    const attemptRepo = makeAttemptRepo();
    const later = storedAttempt({
      id: 'attempt-fix-2',
      kind: 'fix',
      fixNumber: 2,
      priorAttemptId: 'attempt-fix-1',
      state: 'collected',
      outcome: 'done',
      stopReason: 'none',
      seatPlan: planJson,
      seatSelection: fixSelection(1, 'fx-2', 'acme/glm-5.3', 'low'),
      runner: { kind: 'opencode', remotePort: 4166, host: null, agent: null, model: 'acme/glm-5.3', variant: 'low' },
      createdAtIso: '2026-10-15T11:00:00.000Z',
      updatedAtIso: '2026-10-15T11:00:00.000Z',
    });
    const earlier = storedAttempt({
      id: 'attempt-fix-1',
      kind: 'fix',
      fixNumber: 1,
      priorAttemptId: 'attempt-1',
      state: 'collected',
      outcome: 'done',
      stopReason: 'none',
      seatPlan: planJson,
      seatSelection: fixSelection(0, 'fx-1', 'acme/argon-4', null),
      runner: { kind: 'opencode', remotePort: 4166, host: null, agent: null, model: 'acme/argon-4', variant: null },
      createdAtIso: '2026-10-15T10:00:00.000Z',
      updatedAtIso: '2026-10-15T10:00:00.000Z',
    });
    const firstPass = storedAttempt({
      state: 'collected',
      outcome: 'done',
      stopReason: 'none',
      seatPlan: planJson,
      seatSelection: fpSelection,
      runner: RUNNER_MERCURY,
      createdAtIso: '2026-10-15T08:00:00.000Z',
      updatedAtIso: '2026-10-15T08:00:00.000Z',
    });
    // Insert later attempts before earlier ones; selection must follow createdAtIso.
    attemptRepo.attempts.set(later.id, later);
    attemptRepo.attempts.set(earlier.id, earlier);
    attemptRepo.attempts.set(firstPass.id, firstPass);

    const useCase = new PrepareFixAttemptUseCase({ attemptRepo });
    const result = await useCase.prepareFixAttempt(
      validFixRequest({ fixAttemptId: 'attempt-fix-3', priorAttemptId: later.id, nowIso: '2026-10-15T12:00:00.000Z' }),
    );

    expect(result.outcome).toBe('prepared');
    if (result.outcome !== 'prepared') {
      throw new Error('unreachable');
    }
    // Chronological order puts fx-2 last, so the next fix seat is fx-1.
    expect(result.attempt.seatSelection?.seatId).toBe('fx-1');
  });
});

describe('CollectAttemptArtifactsUseCase stopReason', () => {
  it('records stopReason none on a collected attempt with commits', async () => {
    const setup = makeCollectSetup();

    const result = await setup.useCase.collectAttemptArtifacts(validCollectRequest());

    expect(result.outcome).toBe('collected');
    const saved = setup.attemptRepo.attempts.get('attempt-1');
    expect(saved?.outcome).toBe('done');
    expect(saved?.stopReason).toBe('none');
  });

  it('keeps a specific stop reason already recorded instead of replacing it', async () => {
    for (const recorded of ['length', 'rate-limited'] as const) {
      const setup = makeCollectSetup({ attempt: { stopReason: recorded } });

      const result = await setup.useCase.collectAttemptArtifacts(validCollectRequest());

      expect(result.outcome).toBe('collected');
      expect(setup.attemptRepo.attempts.get('attempt-1')?.stopReason).toBe(recorded);
    }
  });

  it('records stopReason no-commit on a collected attempt with no commits', async () => {
    const setup = makeCollectSetup({
      collectResult: {
        outcome: 'collected',
        artifacts: {
          headCommit: 'abc123',
          commitsSinceBase: [],
          collectedArtifactPaths: [],
          notes: 'missing',
        },
      },
    });

    const result = await setup.useCase.collectAttemptArtifacts(validCollectRequest());

    expect(result.outcome).toBe('collected');
    const saved = setup.attemptRepo.attempts.get('attempt-1');
    expect(saved?.outcome).toBe('no-commit');
    expect(saved?.stopReason).toBe('no-commit');
  });
});

const HEAD_SHA = '0123456789abcdef0123456789abcdef01234567';

class FakeAcceptanceAssessment implements AcceptanceAssessmentPort {
  readonly requests: AcceptanceAssessmentRequest[] = [];
  result: AcceptanceAssessmentResult = {
    outcome: 'accepted',
    receiptId: 'receipt-1',
    assessedHeadSha: HEAD_SHA,
  };

  async assessHeadAcceptance(request: AcceptanceAssessmentRequest): Promise<AcceptanceAssessmentResult> {
    this.requests.push(request);
    return this.result;
  }

  async assessHeadReceipts(): Promise<never> {
    throw new Error('assessHeadReceipts is not used by this test');
  }
}

function acceptanceRequest(overrides: Partial<RequestAttemptAcceptanceRequest> = {}): RequestAttemptAcceptanceRequest {
  return {
    attemptId: 'attempt-1',
    candidateHeadSha: HEAD_SHA,
    reviewerModel: 'acme/grok-4.7',
    ...overrides,
  };
}

function collectedWithArtifacts(): Partial<AttemptRecord> {
  return {
    state: 'collected',
    outcome: 'done',
    artifacts: {
      headCommit: HEAD_SHA,
      commitsSinceBase: [HEAD_SHA],
      collectedArtifactPaths: [],
      notes: 'present',
    },
  };
}

describe('RequestAttemptAcceptanceUseCase lane-wide family check', () => {
  it('rejects a reviewer sharing a family with any implementer that ran in the lane', async () => {
    const attemptRepo = makeAttemptRepo();
    attemptRepo.attempts.set(
      'attempt-1',
      storedAttempt({
        ...collectedWithArtifacts(),
        seatPlan: planJson,
        seatSelection: fixSelection(0, 'fx-1', 'acme/argon-4', null),
        runner: runnerModel('acme/argon-4'),
      }),
    );
    attemptRepo.attempts.set(
      'attempt-earlier',
      storedAttempt({
        id: 'attempt-earlier',
        ...collectedWithArtifacts(),
        seatPlan: planJson,
        seatSelection: fpSelection,
        runner: runnerModel('acme/grok-4.6'),
      }),
    );
    const acceptancePort = new FakeAcceptanceAssessment();
    const useCase = new RequestAttemptAcceptanceUseCase({ attemptRepo, acceptancePort });

    const result = await useCase.requestAttemptAcceptance(acceptanceRequest());

    expect(result.outcome).toBe('rejected');
    if (result.outcome === 'rejected') {
      expect(result.reason).toContain('acme/grok-4.6');
      expect(result.reason).toContain('earlier in this lane');
    }
    expect(acceptancePort.requests).toHaveLength(0);
  });

  it('does not run the lane-wide check when the attempt has no seat plan', async () => {
    const attemptRepo = makeAttemptRepo();
    attemptRepo.attempts.set(
      'attempt-1',
      storedAttempt({
        ...collectedWithArtifacts(),
        runner: runnerModel('acme/argon-4'),
      }),
    );
    attemptRepo.attempts.set(
      'attempt-earlier',
      storedAttempt({
        id: 'attempt-earlier',
        ...collectedWithArtifacts(),
        runner: runnerModel('acme/grok-4.6'),
      }),
    );
    const acceptancePort = new FakeAcceptanceAssessment();
    const useCase = new RequestAttemptAcceptanceUseCase({ attemptRepo, acceptancePort });

    const result = await useCase.requestAttemptAcceptance(acceptanceRequest());

    expect(result.outcome).toBe('rejected');
    if (result.outcome === 'rejected') {
      expect(result.reason).not.toContain('earlier in this lane');
    }
    expect(acceptancePort.requests).toHaveLength(0);
  });
});
