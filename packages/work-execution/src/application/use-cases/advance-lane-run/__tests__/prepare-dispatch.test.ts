import { describe, expect, it, vi } from 'vitest';
import {
  performPrepare,
  worktreeRecoveryPatchInputsValid,
} from '../prepare-dispatch.js';
import type { AdvanceStepContext, GatheredLaneRunFacts } from '../step-context.js';
import type { LaneRunRecord } from '../../../../domain/lane-run-records.js';
import type { LaneRunDecision } from '../../../../domain/lane-run-decider.js';
import type { AttemptRecord } from '../../../../domain/execution-records.js';
import type { AdvanceLaneRunRequest } from '../../../ports/in/AdvanceLaneRunPort.in-port.js';

describe('worktreeRecoveryPatchInputsValid', () => {
  it('accepts valid absolute normalised worktree path and safe attempt id', () => {
    expect(worktreeRecoveryPatchInputsValid('/home/user/worktree', 'attempt-01JB000')).toBe(true);
    expect(worktreeRecoveryPatchInputsValid('/var/lane/run_1', 'attempt.test_1-2')).toBe(true);
  });

  it('refuses non-string worktree paths', () => {
    expect(worktreeRecoveryPatchInputsValid(null, 'attempt-1')).toBe(false);
    expect(worktreeRecoveryPatchInputsValid(undefined, 'attempt-1')).toBe(false);
    expect(worktreeRecoveryPatchInputsValid(42, 'attempt-1')).toBe(false);
    expect(worktreeRecoveryPatchInputsValid({}, 'attempt-1')).toBe(false);
    expect(worktreeRecoveryPatchInputsValid(['/worktree'], 'attempt-1')).toBe(false);
  });

  it('refuses non-string attempt ids', () => {
    expect(worktreeRecoveryPatchInputsValid('/worktree', null)).toBe(false);
    expect(worktreeRecoveryPatchInputsValid('/worktree', undefined)).toBe(false);
    expect(worktreeRecoveryPatchInputsValid('/worktree', 42)).toBe(false);
    expect(worktreeRecoveryPatchInputsValid('/worktree', {})).toBe(false);
    expect(worktreeRecoveryPatchInputsValid('/worktree', ['attempt-1'])).toBe(false);
  });

  it('refuses invalid worktree paths (relative, root, NUL, double slash, trailing slash, traversal)', () => {
    expect(worktreeRecoveryPatchInputsValid('relative/path', 'attempt-1')).toBe(false);
    expect(worktreeRecoveryPatchInputsValid('/', 'attempt-1')).toBe(false);
    expect(worktreeRecoveryPatchInputsValid('/path/with\0nul', 'attempt-1')).toBe(false);
    expect(worktreeRecoveryPatchInputsValid('/path//double', 'attempt-1')).toBe(false);
    expect(worktreeRecoveryPatchInputsValid('/trailing/slash/', 'attempt-1')).toBe(false);
    expect(worktreeRecoveryPatchInputsValid('/path/./current', 'attempt-1')).toBe(false);
    expect(worktreeRecoveryPatchInputsValid('/path/../escape', 'attempt-1')).toBe(false);
  });

  it('refuses attempt ids with traversal, slashes, NUL, empty or invalid characters', () => {
    expect(worktreeRecoveryPatchInputsValid('/worktree', '')).toBe(false);
    expect(worktreeRecoveryPatchInputsValid('/worktree', '..')).toBe(false);
    expect(worktreeRecoveryPatchInputsValid('/worktree', 'attempt..escape')).toBe(false);
    expect(worktreeRecoveryPatchInputsValid('/worktree', 'attempt/slash')).toBe(false);
    expect(worktreeRecoveryPatchInputsValid('/worktree', 'attempt\\backslash')).toBe(false);
    expect(worktreeRecoveryPatchInputsValid('/worktree', 'attempt\0nul')).toBe(false);
    expect(worktreeRecoveryPatchInputsValid('/worktree', '.hidden')).toBe(false);
    expect(worktreeRecoveryPatchInputsValid('/worktree', 'attempt space')).toBe(false);
  });
});

describe('performPrepare fix-round recovery boundary (Finding 1)', () => {
  const RUN_ID = 'run-01JB0000000000000000000000';
  const ATTEMPT_ID = 'attempt-01JB0000000000000000000001';
  const WORKTREE = '/var/lane/run-01JB0000000000000000000000';

  const mockRecord: LaneRunRecord = {
    version: 1,
    runId: RUN_ID,
    workOrderId: 'wo-1',
    tier: 2,
    seatPlanRef: 'a'.repeat(64),
    cursors: { 'first-pass': 0, fix: 0, review: null },
    round: 1,
    attemptIds: [ATTEMPT_ID],
    prNumber: null,
    parked: null,
    parkCount: 0,
    lease: null,
    revision: 1,
    runPolicyRevision: 'policy-1',
    branchName: 'feat/test',
  };

  const mockCancelledAttempt: AttemptRecord = {
    schemaVersion: 1,
    id: ATTEMPT_ID,
    workOrderId: 'wo-1',
    kind: 'fix',
    fixNumber: 1,
    priorAttemptId: 'attempt-01JB0000000000000000000000',
    state: 'cancelled',
    worktreePath: WORKTREE,
    baseCommit: '0'.repeat(40),
    outcome: null,
    briefPackagePath: '.lane/brief.md',
    briefDigest: 'b'.repeat(64),
    seatPlan: {
      version: 1,
      'first-pass': [{ id: 'fp1', model: 'alpha-1', tool: 'opencode' }],
      fix: [{ id: 'fx1', model: 'beta-1', tool: 'opencode' }],
      review: [],
    },
    seatSelection: { seatId: 'fx1', role: 'fix', model: 'beta-1', tool: 'opencode', agent: null, variant: null, seatIndex: 0 },
    runner: { kind: 'opencode', hostName: 'lane-host', host: null, remotePort: 1234, agent: null, model: null, variant: null },
    completionReceipt: null,
    artifacts: null,
    sessionId: null,
    stopReason: 'runner-refused',
    createdAtIso: '2026-11-01T00:00:00.000Z',
    updatedAtIso: '2026-11-01T00:01:00.000Z',
  };

  const mockRequest: AdvanceLaneRunRequest = {
    runId: RUN_ID,
    lease: { holderId: 'test-holder', fence: 1 },
    halted: false,
    nowIso: '2026-11-01T00:02:00.000Z',
  };

  const fixDecision: Extract<LaneRunDecision, { kind: 'act' }> = {
    kind: 'act',
    step: 'prepare',
    key: `${RUN_ID}/r1/prepare/0/a2`,
    round: 1,
    seatIndex: 0,
    head12: null,
    retry: null,
  };

  it('reconciles incomplete recovery in a fix round before preparing next attempt', async () => {
    const journalEntries: Array<{ action: string; status: string; detail: string | null }> = [
      {
        action: 'dispatch',
        status: 'intent-recorded',
        detail: `preserved uncommitted edits: ${WORKTREE}.${ATTEMPT_ID}.patch`,
      },
    ];

    const appendJournalEntry = vi.fn().mockImplementation(async (entry) => {
      journalEntries.push(entry);
    });

    const preserveWorktreeEdits = vi.fn().mockResolvedValue({
      outcome: 'refused',
      reason: 'destination-exists',
    });

    const resetWorktreeToHead = vi.fn().mockResolvedValue({
      outcome: 'reset',
      headCommit: '0'.repeat(40),
    });

    const cancelPreparedAttempt = vi.fn();

    const ctx: AdvanceStepContext = {
      deps: {
        runRepo: {
          save: vi.fn().mockImplementation(async (r: LaneRunRecord) => ({ outcome: 'saved', record: r })),
          get: vi.fn().mockResolvedValue(null),
        } as never,
        runJournal: {
          append: vi.fn().mockImplementation(async (e: unknown) => ({ outcome: 'appended', entry: e })),
          listForKey: vi.fn().mockResolvedValue([]),
          listForRun: vi.fn().mockResolvedValue([]),
        } as never,
        attemptRepo: { findAttemptById: vi.fn(), saveAttempt: vi.fn() } as never,
        executionJournal: {
          listActiveReservations: vi.fn().mockResolvedValue([]),
          listJournalEntriesForAttempt: vi.fn().mockImplementation(async () => journalEntries),
          appendJournalEntry,
        },
        worktreeRecovery: {
          preserveWorktreeEdits,
          resetWorktreeToHead,
        },
        cancelPreparedAttempt: {
          cancelPreparedAttempt,
        } as never,
        reconcileAttempt: {} as never,
        admission: {} as never,
        newUlid: () => '01JBNEWULID00000000000000',
        artifactPort: {} as never,
      },
    };

    const gathered: GatheredLaneRunFacts = {
      facts: {
        state: 'ready',
        halted: false,
        stopMode: null,
        stopRequestedAtIso: null,
        stopGraceMinutes: 45,
        pendingIntent: null,
        admission: 'admitted',
        costCeilingReached: false,
        implementerSeat: { ok: true, seatIndex: 0 },
        reviewSeat: { ok: true, seatIndex: 0 },
        roundSeatIndexes: [],
        attempt: null,
        head12: null,
        acceptedHead12: null,
        gate: 'none',
        gateCongestion: null,
        briefCheck: { verdict: 'none', seatIndex: null, retries: 0 },
        codeReview: { verdict: 'none', seatIndex: null, retries: 0 },
        preMerge: 'none',
        premergePost: 'none',
        acceptance: 'none',
        acceptanceRetry: null,
        ci: 'pending',
        pr: null,
        refusedStep: null,
        merge: { oneWayDoor: false, branchBehind: false, trainFree: true, policyGrant: true },
      },
      deadlineUnknown: false,
      latestAttempt: mockCancelledAttempt,
      attemptRecords: [mockCancelledAttempt],
    };

    // When recovery preservation fails, it parks step-refused prepare rather than preparing next seat
    preserveWorktreeEdits.mockResolvedValueOnce({
      outcome: 'refused',
      reason: 'git-refused',
    });

    const result = await performPrepare(ctx, mockRecord, gathered, fixDecision, mockRequest);
    expect(result.outcome).toBe('parked');
    if (result.outcome === 'parked') {
      expect(result.reason).toBe('step-refused');
      expect(result.qualifier).toBe('prepare');
    }
    expect(resetWorktreeToHead).not.toHaveBeenCalled();
    expect(cancelPreparedAttempt).not.toHaveBeenCalled();
  });

  it('appends completed journal entry and prepares attempt when reconciliation succeeds', async () => {
    const journalEntries: Array<{ action: string; status: string; detail: string | null }> = [
      {
        action: 'dispatch',
        status: 'intent-recorded',
        detail: `preserved uncommitted edits: ${WORKTREE}.${ATTEMPT_ID}.patch`,
      },
    ];

    const appendJournalEntry = vi.fn().mockImplementation(async (entry) => {
      journalEntries.push(entry);
    });

    const preserveWorktreeEdits = vi.fn().mockResolvedValue({
      outcome: 'refused',
      reason: 'destination-exists',
    });

    const verifySavedPatch = vi.fn().mockResolvedValue(true);

    const resetWorktreeToHead = vi.fn().mockResolvedValue({
      outcome: 'reset',
      headCommit: '0'.repeat(40),
    });

    const savedAttempts: AttemptRecord[] = [];
    const saveAttempt = vi.fn().mockImplementation(async (attempt) => {
      savedAttempts.push(attempt);
    });

    const worktreeRecovery = {
      preserveWorktreeEdits,
      verifySavedPatch,
      resetWorktreeToHead,
    };

    const ctx: AdvanceStepContext = {
      deps: {
        runRepo: {
          save: vi.fn().mockImplementation(async (r: LaneRunRecord) => ({ outcome: 'saved', record: r })),
          get: vi.fn().mockResolvedValue(null),
        } as never,
        runJournal: {
          append: vi.fn().mockImplementation(async (e: unknown) => ({ outcome: 'appended', entry: e })),
          listForKey: vi.fn().mockResolvedValue([]),
          listForRun: vi.fn().mockResolvedValue([]),
        } as never,
        attemptRepo: { findAttemptById: vi.fn(), saveAttempt } as never,
        executionJournal: {
          listActiveReservations: vi.fn().mockResolvedValue([]),
          listJournalEntriesForAttempt: vi.fn().mockImplementation(async () => journalEntries),
          appendJournalEntry,
        },
        worktreeRecovery,
        reconcileAttempt: {} as never,
        admission: {} as never,
        newUlid: () => '01JBNEWULID00000000000000',
        artifactPort: {} as never,
      },
    };

    const round0Record: LaneRunRecord = { ...mockRecord, round: 0 };
    const round0Attempt: AttemptRecord = {
      ...mockCancelledAttempt,
      kind: 'initial',
      fixNumber: 0,
      priorAttemptId: null,
    };
    const round0Decision: Extract<LaneRunDecision, { kind: 'act' }> = {
      ...fixDecision,
      round: 0,
      key: `${RUN_ID}/r0/prepare/0/a2`,
    };

    const gathered: GatheredLaneRunFacts = {
      facts: {
        state: 'ready',
        halted: false,
        stopMode: null,
        stopRequestedAtIso: null,
        stopGraceMinutes: 45,
        pendingIntent: null,
        admission: 'admitted',
        costCeilingReached: false,
        implementerSeat: { ok: true, seatIndex: 0 },
        reviewSeat: { ok: true, seatIndex: 0 },
        roundSeatIndexes: [],
        attempt: null,
        head12: null,
        acceptedHead12: null,
        gate: 'none',
        gateCongestion: null,
        briefCheck: { verdict: 'none', seatIndex: null, retries: 0 },
        codeReview: { verdict: 'none', seatIndex: null, retries: 0 },
        preMerge: 'none',
        premergePost: 'none',
        acceptance: 'none',
        acceptanceRetry: null,
        ci: 'pending',
        pr: null,
        refusedStep: null,
        merge: { oneWayDoor: false, branchBehind: false, trainFree: true, policyGrant: true },
      },
      deadlineUnknown: false,
      latestAttempt: round0Attempt,
      attemptRecords: [round0Attempt],
    };

    const result = await performPrepare(ctx, round0Record, gathered, round0Decision, mockRequest);
    expect(result.outcome).toBe('acted');
    if (result.outcome === 'acted') {
      expect(result.result).toBe('completed');
      expect(result.reasonCode).toBe('prepared');
    }
    expect(verifySavedPatch).toHaveBeenCalled();
    expect(resetWorktreeToHead).toHaveBeenCalled();
    expect(journalEntries.some((e) => e.status === 'completed' && e.action === 'dispatch')).toBe(true);
    expect(savedAttempts.length).toBe(1);
  });

  it('parks and does not repeat reset when destination-exists patch fails verification against current worktree', async () => {
    const journalEntries: Array<{ action: string; status: string; detail: string | null }> = [
      {
        action: 'dispatch',
        status: 'intent-recorded',
        detail: `preserved uncommitted edits: ${WORKTREE}.${ATTEMPT_ID}.patch`,
      },
    ];

    const appendJournalEntry = vi.fn().mockImplementation(async (entry) => {
      journalEntries.push(entry);
    });

    const preserveWorktreeEdits = vi.fn().mockResolvedValue({
      outcome: 'refused',
      reason: 'destination-exists',
    });

    const verifySavedPatch = vi.fn().mockResolvedValue(false);

    const resetWorktreeToHead = vi.fn().mockResolvedValue({
      outcome: 'reset',
      headCommit: '0'.repeat(40),
    });

    const worktreeRecovery = {
      preserveWorktreeEdits,
      verifySavedPatch,
      resetWorktreeToHead,
    };

    const ctx: AdvanceStepContext = {
      deps: {
        runRepo: {
          save: vi.fn().mockImplementation(async (r: LaneRunRecord) => ({ outcome: 'saved', record: r })),
          get: vi.fn().mockResolvedValue(null),
        } as never,
        runJournal: {
          append: vi.fn().mockImplementation(async (e: unknown) => ({ outcome: 'appended', entry: e })),
          listForKey: vi.fn().mockResolvedValue([]),
          listForRun: vi.fn().mockResolvedValue([]),
        } as never,
        attemptRepo: { findAttemptById: vi.fn(), saveAttempt: vi.fn() } as never,
        executionJournal: {
          listActiveReservations: vi.fn().mockResolvedValue([]),
          listJournalEntriesForAttempt: vi.fn().mockImplementation(async () => journalEntries),
          appendJournalEntry,
        },
        worktreeRecovery,
        reconcileAttempt: {} as never,
        admission: {} as never,
        newUlid: () => '01JBNEWULID00000000000000',
        artifactPort: {} as never,
      },
    };

    const gathered: GatheredLaneRunFacts = {
      facts: {
        state: 'ready',
        halted: false,
        stopMode: null,
        stopRequestedAtIso: null,
        stopGraceMinutes: 45,
        pendingIntent: null,
        admission: 'admitted',
        costCeilingReached: false,
        implementerSeat: { ok: true, seatIndex: 0 },
        reviewSeat: { ok: true, seatIndex: 0 },
        roundSeatIndexes: [],
        attempt: null,
        head12: null,
        acceptedHead12: null,
        gate: 'none',
        gateCongestion: null,
        briefCheck: { verdict: 'none', seatIndex: null, retries: 0 },
        codeReview: { verdict: 'none', seatIndex: null, retries: 0 },
        preMerge: 'none',
        premergePost: 'none',
        acceptance: 'none',
        acceptanceRetry: null,
        ci: 'pending',
        pr: null,
        refusedStep: null,
        merge: { oneWayDoor: false, branchBehind: false, trainFree: true, policyGrant: true },
      },
      deadlineUnknown: false,
      latestAttempt: mockCancelledAttempt,
      attemptRecords: [mockCancelledAttempt],
    };

    const result = await performPrepare(ctx, mockRecord, gathered, fixDecision, mockRequest);
    expect(result.outcome).toBe('parked');
    if (result.outcome === 'parked') {
      expect(result.reason).toBe('step-refused');
      expect(result.qualifier).toBe('prepare');
    }
    expect(verifySavedPatch).toHaveBeenCalled();
    expect(resetWorktreeToHead).not.toHaveBeenCalled();
    expect(journalEntries.some((e) => e.status === 'completed')).toBe(false);
  });
});
