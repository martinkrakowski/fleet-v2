import { describe, expect, it } from 'vitest';
import type {
  ActionJournalEntryRecord,
  AttemptRecord,
  CapacityReservationRecord,
} from '../../domain/execution-records.js';
import type { AttemptRepositoryPort } from '../ports/out/AttemptRepositoryPort.out-port.js';
import type { ExecutionJournalPort } from '../ports/out/ExecutionJournalPort.out-port.js';
import type {
  AcceptanceEvidencePort,
  ReadAcceptanceRequest,
  ReadAcceptanceResult,
} from '../ports/out/AcceptanceEvidencePort.out-port.js';
import { ExplainAttemptUseCase } from './InspectAttemptUseCase.use-case.js';

class InMemoryAttemptRepo implements AttemptRepositoryPort {
  private reads = 0;

  constructor(private readonly sequence: readonly (AttemptRecord | null)[]) {}

  async findAttemptById(_id: string): Promise<AttemptRecord | null> {
    const index = Math.min(this.reads, this.sequence.length - 1);
    this.reads += 1;
    return this.sequence[index];
  }
  async saveAttempt(_record: AttemptRecord): Promise<void> {}
  async listAttemptsByWorkOrder(_workOrderId: string): Promise<readonly AttemptRecord[]> {
    return [];
  }
  async listAllAttempts(): Promise<readonly AttemptRecord[]> {
    return [];
  }
}

class InMemoryJournal implements ExecutionJournalPort {
  constructor(
    private readonly entries: readonly ActionJournalEntryRecord[] = [],
    private readonly reservations: readonly CapacityReservationRecord[] = [],
  ) {}

  async appendJournalEntry(_entry: ActionJournalEntryRecord): Promise<void> {}
  async listJournalEntriesForAttempt(
    _attemptId: string,
  ): Promise<readonly ActionJournalEntryRecord[]> {
    return this.entries;
  }
  async saveCapacityReservation(_reservation: CapacityReservationRecord): Promise<void> {}
  async listActiveReservations(
    _hostId?: string,
  ): Promise<readonly CapacityReservationRecord[]> {
    return this.reservations;
  }
  async releaseCapacityReservation(
    _attemptId: string,
    _releasedAtIso: string,
  ): Promise<boolean> {
    return false;
  }
  async reserveCapacityAtomically() {
    return { outcome: 'no-free-slot' as const, heldCount: 0, maxSlots: 0 };
  }
}

class InMemoryAcceptanceEvidence implements AcceptanceEvidencePort {
  constructor(private readonly result: ReadAcceptanceResult) {}

  async readAcceptance(_request: ReadAcceptanceRequest): Promise<ReadAcceptanceResult> {
    return this.result;
  }
}

const HEAD = 'b'.repeat(40);
const RECONCILE_AT = '2026-10-15T11:00:00Z';

function makeAttemptRecord(overrides: Partial<AttemptRecord> = {}): AttemptRecord {
  return {
    id: 'att-001',
    workOrderId: 'wo-001',
    kind: 'initial',
    fixNumber: 0,
    priorAttemptId: null,
    state: 'running',
    outcome: null,
    baseCommit: 'a'.repeat(40),
    worktreePath: '/tmp/worktree',
    briefDigest: 'sha256-brief',
    briefPackagePath: null,
    sessionId: 'ses_1',
    completionReceipt: null,
    artifacts: null,
    revision: 3,
    createdAtIso: '2026-10-15T10:00:00Z',
    updatedAtIso: '2026-10-15T10:30:00Z',
    ...overrides,
  } as AttemptRecord;
}

const reconcileEntry: ActionJournalEntryRecord = {
  id: 'j-1',
  attemptId: 'att-001',
  workOrderId: 'wo-001',
  action: 'reconcile',
  baseCommit: 'a'.repeat(40),
  recordedAtIso: RECONCILE_AT,
  status: 'completed',
  sessionId: 'ses_1',
  detail: null,
};

const reservation: CapacityReservationRecord = {
  id: 'res-1',
  attemptId: 'att-001',
  hostId: 'host-1',
  slotIndex: 0,
  held: true,
  seatTool: 'opencode',
  reservedAtIso: '2026-10-15T10:05:00Z',
  releasedAtIso: null,
};

const acceptanceFound: ReadAcceptanceResult = {
  outcome: 'found',
  assessment: {
    state: 'accepted',
    candidateHeadSha: HEAD,
    policyRevision: 'policy-1',
    acceptanceReceiptId: 'receipt-1',
  },
};

describe('ExplainAttemptUseCase', () => {
  it('explains a running attempt', async () => {
    const attempt = makeAttemptRecord({
      artifacts: {
        headCommit: HEAD,
        commitsSinceBase: [HEAD],
        collectedArtifactPaths: ['/tmp/patch.diff'],
        notes: 'present',
      },
    });
    const useCase = new ExplainAttemptUseCase({
      attemptRepo: new InMemoryAttemptRepo([attempt]),
      journal: new InMemoryJournal([reconcileEntry], [reservation]),
      acceptanceEvidence: new InMemoryAcceptanceEvidence(acceptanceFound),
    });

    const result = await useCase.explainAttempt({ attemptId: attempt.id });
    expect(result.outcome).toBe('explained');
    if (result.outcome !== 'explained') return;

    expect(result.lines.map((line) => line.source)).toEqual([
      'record',
      'runner',
      'capacity',
      'gate',
      'next',
    ]);
    expect(result.lines[0].readAt).toBe('3');
    expect(result.lines[1].readAt).toBe(RECONCILE_AT);
    expect(result.lines[2].detail).toContain('host-1');
    expect(result.lines[2].detail).toContain('0');
    expect(result.lines[3].status).toBe('known');
    expect(result.lines[3].detail).toContain('receipt-1');
    expect(result.next.map((command) => command.command)).toEqual([
      'dispatch',
      'reconcile',
      'stop',
      'collect',
      'accept',
      'fix',
    ]);
    expect(result.next.find((command) => command.command === 'stop')?.legal).toBe(true);
  });

  it('reports unknown when the attempt changed while it was being explained', async () => {
    const first = makeAttemptRecord({ revision: 1 });
    const last = makeAttemptRecord({ revision: 2 });
    const useCase = new ExplainAttemptUseCase({
      attemptRepo: new InMemoryAttemptRepo([first, last]),
      journal: new InMemoryJournal(),
    });

    const result = await useCase.explainAttempt({ attemptId: first.id });
    expect(result).toEqual({
      outcome: 'unknown',
      attemptId: first.id,
      reason: 'the attempt changed while it was being explained; run it again',
    });
  });

  it('reports not-found for an unknown attempt', async () => {
    const useCase = new ExplainAttemptUseCase({
      attemptRepo: new InMemoryAttemptRepo([null]),
      journal: new InMemoryJournal(),
    });

    const result = await useCase.explainAttempt({ attemptId: 'att-missing' });
    expect(result).toEqual({ outcome: 'not-found', attemptId: 'att-missing' });
  });

  it('never echoes a journal detail', async () => {
    const secret = 'sk-abcdefghijklmnopqrstuvwxyz012345';
    const entryWithSecret: ActionJournalEntryRecord = { ...reconcileEntry, detail: secret };
    const attempt = makeAttemptRecord({
      artifacts: {
        headCommit: HEAD,
        commitsSinceBase: [HEAD],
        collectedArtifactPaths: ['/tmp/patch.diff'],
        notes: 'present',
      },
    });
    const useCase = new ExplainAttemptUseCase({
      attemptRepo: new InMemoryAttemptRepo([attempt]),
      journal: new InMemoryJournal([entryWithSecret], [reservation]),
      acceptanceEvidence: new InMemoryAcceptanceEvidence(acceptanceFound),
    });

    const result = await useCase.explainAttempt({ attemptId: attempt.id });
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it('says unknown for a gate line with no collected head', async () => {
    const attempt = makeAttemptRecord({ artifacts: null });
    const useCase = new ExplainAttemptUseCase({
      attemptRepo: new InMemoryAttemptRepo([attempt]),
      journal: new InMemoryJournal(),
      acceptanceEvidence: new InMemoryAcceptanceEvidence(acceptanceFound),
    });

    const result = await useCase.explainAttempt({ attemptId: attempt.id });
    expect(result.outcome).toBe('explained');
    if (result.outcome !== 'explained') return;

    const gateLine = result.lines.find((line) => line.source === 'gate')!;
    expect(gateLine.status).toBe('unknown');
    expect(gateLine.detail).toBe('no collected head to judge');
  });

  it('derives the next commands from the attempt record alone', async () => {
    const attempt = makeAttemptRecord({
      state: 'collected',
      artifacts: {
        headCommit: HEAD,
        commitsSinceBase: [HEAD],
        collectedArtifactPaths: ['/tmp/patch.diff'],
        notes: 'present',
      },
    });
    const useCase = new ExplainAttemptUseCase({
      attemptRepo: new InMemoryAttemptRepo([attempt]),
      journal: new InMemoryJournal(),
    });

    const result = await useCase.explainAttempt({ attemptId: attempt.id });
    expect(result.outcome).toBe('explained');
    if (result.outcome !== 'explained') return;

    const byCommand = Object.fromEntries(
      result.next.map((command) => [command.command, command]),
    );
    expect(byCommand.dispatch).toEqual({
      command: 'dispatch',
      legal: false,
      reason: 'already-dispatched',
    });
    expect(byCommand.collect).toEqual({
      command: 'collect',
      legal: false,
      reason: 'no-completion-receipt',
    });
    expect(byCommand.accept.legal).toBe(true);
    expect(byCommand.fix.legal).toBe(true);
    expect(byCommand.reconcile).toEqual({
      command: 'reconcile',
      legal: false,
      reason: 'terminal-state',
    });
  });

  it('refuses collect with no-completion-receipt for a collected attempt without a receipt', async () => {
    const attempt = makeAttemptRecord({ state: 'collected', completionReceipt: null });
    const useCase = new ExplainAttemptUseCase({
      attemptRepo: new InMemoryAttemptRepo([attempt]),
      journal: new InMemoryJournal(),
    });

    const result = await useCase.explainAttempt({ attemptId: attempt.id });
    expect(result.outcome).toBe('explained');
    if (result.outcome !== 'explained') return;

    const collect = result.next.find((command) => command.command === 'collect')!;
    expect(collect.legal).toBe(false);
    expect(collect.reason).toBe('no-completion-receipt');
  });

  it('refuses collect with not-ended for a collected attempt with a receipt', async () => {
    const attempt = makeAttemptRecord({
      state: 'collected',
      completionReceipt: {
        attemptId: 'att-001',
        sessionId: 'ses_1',
        endedAtIso: '2026-10-15T10:20:00Z',
        authoritative: true,
        exitStatus: 0,
        stoppedByRequest: false,
      },
    });
    const useCase = new ExplainAttemptUseCase({
      attemptRepo: new InMemoryAttemptRepo([attempt]),
      journal: new InMemoryJournal(),
    });

    const result = await useCase.explainAttempt({ attemptId: attempt.id });
    expect(result.outcome).toBe('explained');
    if (result.outcome !== 'explained') return;

    const collect = result.next.find((command) => command.command === 'collect')!;
    expect(collect.legal).toBe(false);
    expect(collect.reason).toBe('not-ended');
  });

  it('refuses with unknown when the attempt revision changes during readAcceptance', async () => {
    const attempt = makeAttemptRecord({
      state: 'collected',
      artifacts: {
        headCommit: HEAD,
        commitsSinceBase: [HEAD],
        collectedArtifactPaths: ['/tmp/patch.diff'],
        notes: 'present',
      },
    });
    class MutatingAcceptanceEvidence implements AcceptanceEvidencePort {
      async readAcceptance(_request: ReadAcceptanceRequest): Promise<ReadAcceptanceResult> {
        attemptAtRead.revision = (attemptAtRead.revision ?? 0) + 1;
        return acceptanceFound;
      }
    }
    const attemptAtRead = attempt as { revision?: number | null };
    class SnapshotAttemptRepo implements AttemptRepositoryPort {
      async findAttemptById(): Promise<AttemptRecord | null> {
        return { ...attempt };
      }
      async saveAttempt(_record: AttemptRecord): Promise<void> {}
      async listAttemptsByWorkOrder(_workOrderId: string): Promise<readonly AttemptRecord[]> {
        return [];
      }
      async listAllAttempts(): Promise<readonly AttemptRecord[]> {
        return [];
      }
    }
    const useCase = new ExplainAttemptUseCase({
      attemptRepo: new SnapshotAttemptRepo(),
      journal: new InMemoryJournal(),
      acceptanceEvidence: new MutatingAcceptanceEvidence(),
    });

    const result = await useCase.explainAttempt({ attemptId: attempt.id });
    expect(result).toEqual({
      outcome: 'unknown',
      attemptId: attempt.id,
      reason: 'the attempt changed while it was being explained; run it again',
    });
  });
});
