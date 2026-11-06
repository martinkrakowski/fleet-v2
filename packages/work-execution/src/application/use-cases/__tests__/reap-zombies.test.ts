/**
 * Unit tests for lane K11a2: the reaper pass (`ReapZombiesUseCase`). The fakes
 * cover the keyed record-only repair (intent before the action, result after),
 * the fault injections (a crash between the repair and its result; a young
 * subject never repaired), the store semantics (one finding id reused across
 * passes, an unreadable store never treated as empty), every typed refusal on
 * runtime input, and the ids-and-codes-only output boundary.
 */

import { describe, expect, it } from 'vitest';

import { containsSecretShape } from '@fleet/shared';

import type { ActionJournalEntryRecord, AttemptRecord, CapacityReservationRecord } from '../../../domain/execution-records.js';
import type { AttemptRepositoryPort } from '../../ports/out/AttemptRepositoryPort.out-port.js';
import type {
  ExecutionJournalPort,
  ReleaseCapacityReservationIfUnchangedRequest,
} from '../../ports/out/ExecutionJournalPort.out-port.js';
import type { LaneRunJournalEntryRecord } from '../../../domain/lane-run-journal.js';
import type { LaneRunJournalPort, LaneRunJournalAppendResult } from '../../ports/out/LaneRunJournalPort.out-port.js';
import type {
  ExecutionRunnerPort,
  RunnerSessionRef,
  RunnerSessionStatus,
} from '../../ports/out/ExecutionRunnerPort.out-port.js';
import type { RunnerForAttemptPort } from '../../ports/out/RunnerForAttemptPort.out-port.js';
import type { ReconcileAttemptPort, ReconcileAttemptResult } from '../../ports/in/ReconcileAttemptPort.in-port.js';
import type { ReaperFindingRepositoryPort, ReaperFindingStoreRecord } from '../../ports/out/ReaperFindingRepositoryPort.out-port.js';
import type {
  ReapZombiesRequest,
  ReapZombiesResult,
} from '../../ports/in/ReapZombiesPort.in-port.js';
import { ReapZombiesUseCase, type ReaperAttentionPort } from '../ReapZombiesUseCase.use-case.js';
import { InMemoryReaperFindingRepositoryAdapter } from '../../../infrastructure/adapters/InMemoryReaperFindingRepositoryAdapter.adapter.js';
import { REAPER_FINDING_SCHEMA_VERSION } from '../../../domain/reaper-findings.js';

const NOW = '2026-11-06T12:00:00.000Z';
const BEFORE = '2026-11-06T11:00:00.000Z'; // one hour before NOW: not young
const YOUNG = '2026-11-06T11:59:30.000Z'; // 30 s before NOW: young
const WORKTREE = '/tmp/worktree-example-1';
const COMMIT = 'a'.repeat(40);
const PROJECT = 'proj-1';

const POLICY = { graceMinutes: 5, repairs: { 'dead-attempt': true } };

/** A ULID-shaped id (the O1b-1 pattern): first character 0-7, 26 Crockford characters. */
function ulid(n: number): string {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  let id = '0';
  let value = 1_000_000 + n;
  for (let i = 0; i < 25; i += 1) {
    id += alphabet[value % 32];
    value = Math.floor(value / 32) + i * 7 + n;
  }
  return id;
}

let idCounter = 0;
function newId(): string {
  idCounter += 1;
  return ulid(idCounter);
}

function attemptFixture(id: string, overrides: Partial<AttemptRecord> = {}): AttemptRecord {
  return {
    id,
    workOrderId: 'wo-a',
    kind: 'initial',
    fixNumber: 0,
    priorAttemptId: null,
    worktreePath: WORKTREE,
    baseCommit: COMMIT,
    state: 'running',
    outcome: null,
    briefDigest: 'b'.repeat(64),
    briefPackagePath: '.lane/brief-package',
    sessionId: `ses-${id}`,
    completionReceipt: null,
    artifacts: null,
    runner: null,
    createdAtIso: BEFORE,
    updatedAtIso: BEFORE,
    ...overrides,
  };
}

function reservationFixture(id: string, attemptId: string, overrides: Partial<CapacityReservationRecord> = {}): CapacityReservationRecord {
  return {
    id,
    attemptId,
    hostId: 'h',
    slotIndex: 0,
    held: true,
    seatTool: 'opencode',
    reservedAtIso: BEFORE,
    releasedAtIso: null,
    ...overrides,
  };
}

function receiptFor(attemptId: string): { attemptId: string; sessionId: string; endedAtIso: string; authoritative: boolean; exitStatus: number | null; stoppedByRequest: boolean } {
  return {
    attemptId,
    sessionId: `ses-${attemptId}`,
    endedAtIso: NOW,
    authoritative: true,
    exitStatus: 0,
    stoppedByRequest: false,
  };
}

/** The runner status that says the session is gone: reachable, worker not running. */
const SESSION_GONE: RunnerSessionStatus = {
  runnerReachable: 'reachable',
  workspacePreparation: 'prepared',
  workerCommand: 'ended',
  completionReceipt: null,
  artifactsCollected: false,
};

function makeRunner(): ExecutionRunnerPort & { inspectCalls: RunnerSessionRef[] } {
  const inspectCalls: RunnerSessionRef[] = [];
  return {
    inspectCalls,
    describeCapabilities: () => ({
      filesystemScope: 'scoped-worktree',
      networkEgressRestricted: true,
      cpuAndMemoryLimited: true,
      processTreeTermination: true,
      authoritativeCompletion: true,
      artifactPersistence: true,
    }),
    startSession: () => Promise.reject(new Error('not used')),
    inspectSession: (session: RunnerSessionRef) => {
      inspectCalls.push(session);
      return Promise.resolve(SESSION_GONE);
    },
    stopSession: () => Promise.reject(new Error('not used')),
  };
}

const RUNNER_FOR_ATTEMPT: RunnerForAttemptPort = {
  runnerForAttempt: () => ({ ok: true, runner: makeRunnerPlaceholder() }),
};

function makeRunnerPlaceholder(): ExecutionRunnerPort {
  return makeRunner();
}

interface JournalState {
  readonly entries: Map<string, LaneRunJournalEntryRecord[]>;
  appendCalls: LaneRunJournalEntryRecord[];
}

function makeJournal(seed: LaneRunJournalEntryRecord[] = []): LaneRunJournalPort & { state: JournalState } {
  const state: JournalState = {
    entries: new Map<string, LaneRunJournalEntryRecord[]>(),
    appendCalls: [],
  };
  for (const entry of seed) {
    const list = state.entries.get(entry.key ?? '') ?? [];
    list.push(entry);
    state.entries.set(entry.key ?? '', list);
  }
  return {
    state,
    append: (entry: LaneRunJournalEntryRecord): Promise<LaneRunJournalAppendResult> => {
      state.appendCalls.push(entry);
      const list = state.entries.get(entry.key ?? '') ?? [];
      if (entry.kind === 'intent' && list.some((existing) => existing.kind === 'intent')) {
        return Promise.resolve({ outcome: 'refused', reason: 'duplicate-key', detail: null });
      }
      const appended = { ...entry };
      list.push(appended);
      state.entries.set(entry.key ?? '', list);
      return Promise.resolve({ outcome: 'appended', entry: appended });
    },
    listForRun: () => Promise.resolve([]),
    listForKey: (key: string) => Promise.resolve(state.entries.get(key) ?? []),
  };
}

function makeReconcile(script: ReconcileAttemptResult[] = []): ReconcileAttemptPort & { calls: string[] } {
  const calls: string[] = [];
  let index = 0;
  return {
    calls,
    reconcileAttempt: (request: { attemptId: string }) => {
      calls.push(request.attemptId);
      const next = script[index] ?? { outcome: 'ended', attempt: attemptFixture(request.attemptId), receipt: { attemptId: 'att-1', sessionId: 'ses-att-1', endedAtIso: NOW, authoritative: true, exitStatus: 0, stoppedByRequest: false } };
      index += 1;
      return Promise.resolve(next);
    },
  };
}

interface AttentionState {
  recorded: { body: Record<string, unknown>; actor: string }[];
  cleared: { request: Record<string, unknown>; via: string; actor: string }[];
}

function makeAttention(state: AttentionState = { recorded: [], cleared: [] }, items: unknown[] = []): ReaperAttentionPort {
  const seen = new Map<string, number>();
  return {
    listAttentionItems: () => Promise.resolve({ items }),
    recordAttentionItem: (body: unknown, actor: string) => {
      const candidate = body as Record<string, unknown>;
      state.recorded.push({ body: candidate, actor });
      const mapKey = `${String(candidate.projectId)}\u0000${String(candidate.kind)}\u0000${JSON.stringify(candidate.subject)}`;
      const previous = seen.get(mapKey) ?? 0;
      seen.set(mapKey, previous + 1);
      return Promise.resolve({ outcome: previous === 0 ? 'raised' : 'refreshed' });
    },
    clearAttentionItem: (request: unknown, via: string, actor: string) => {
      state.cleared.push({ request: request as Record<string, unknown>, via, actor });
      return Promise.resolve({ outcome: 'cleared' });
    },
  };
}

function makeAttemptRepo(attempts: readonly AttemptRecord[] = []): AttemptRepositoryPort & { findCalls: string[] } {
  const findCalls: string[] = [];
  const byId = new Map(attempts.map((attempt) => [attempt.id, attempt]));
  return {
    findCalls,
    saveAttempt: () => Promise.resolve(),
    findAttemptById: (attemptId: string) => {
      findCalls.push(attemptId);
      return Promise.resolve(byId.get(attemptId) ?? null);
    },
    listAttemptsByWorkOrder: () => Promise.resolve([]),
    listAllAttempts: () => Promise.resolve(attempts),
  };
}

const JOURNAL: Pick<ExecutionJournalPort, 'listActiveReservations' | 'listJournalEntriesForAttempt' | 'releaseCapacityReservationIfUnchanged'> = {
  listActiveReservations: () => Promise.resolve([]),
  listJournalEntriesForAttempt: () => Promise.resolve([]),
  releaseCapacityReservationIfUnchanged: undefined,
};

interface Harness {
  attempts: AttemptRecord[];
  reservations: CapacityReservationRecord[];
  store: InMemoryReaperFindingRepositoryAdapter;
  journal: ReturnType<typeof makeJournal>;
  reconcile: ReturnType<typeof makeReconcile>;
  runner: ReturnType<typeof makeRunner>;
  attention: AttentionState;
  attentionPort: ReaperAttentionPort;
  /** Action-journal entries per attempt, keyed by attempt id. */
  actionJournal?: Map<string, ActionJournalEntryRecord[]>;
  /** The fenced capacity release; absent means the operation is unavailable. */
  release?: ExecutionJournalPort['releaseCapacityReservationIfUnchanged'];
  attentionItems?: unknown[];
  newIdOverride?: () => string;
  reaperFindings?: ReaperFindingRepositoryPort;
  attemptRepo?: AttemptRepositoryPort;
}

function build(harness: Harness): ReapZombiesUseCase {
  const attemptRepo = harness.attemptRepo ?? makeAttemptRepo(harness.attempts);
  const executionJournal: Pick<ExecutionJournalPort, 'listActiveReservations' | 'listJournalEntriesForAttempt' | 'releaseCapacityReservationIfUnchanged'> = {
    listActiveReservations: () => Promise.resolve(harness.reservations),
    listJournalEntriesForAttempt: (attemptId: string) => {
      const entries = harness.actionJournal?.get(attemptId);
      return Promise.resolve(entries ?? []);
    },
    releaseCapacityReservationIfUnchanged: harness.release,
  };
  const runnerForAttempt: RunnerForAttemptPort = {
    runnerForAttempt: () => {
      const runner = harness.runner;
      return { ok: true, runner };
    },
  };
  return new ReapZombiesUseCase({
    attemptRepo,
    executionJournal,
    runJournal: harness.journal,
    reconcile: harness.reconcile,
    runner: harness.runner,
    runnerForAttempt,
    attention: harness.attentionPort,
    reaperFindings: harness.reaperFindings ?? harness.store,
    newId: harness.newIdOverride ?? newId,
  });
}

function request(overrides: Partial<ReapZombiesRequest> = {}): ReapZombiesRequest {
  return { projectId: PROJECT, nowIso: NOW, policy: POLICY, ...overrides };
}

/** Seed one open finding so the next pass reaches the two-sightings repair rule. */
async function seedOpenFinding(
  store: ReaperFindingRepositoryPort,
  subject: string,
  kind: 'dead-attempt' | 'leaked-slot' | 'stale-attention' = 'dead-attempt',
): Promise<ReaperFindingStoreRecord> {
  const upsert = await store.upsertFinding(
    {
      schemaVersion: REAPER_FINDING_SCHEMA_VERSION,
      kind,
      subject,
      action: 'wait',
      firstSightingIso: BEFORE,
      lastSightingIso: BEFORE,
      sightings: 1,
    },
    newId(),
  );
  if (upsert.outcome !== 'stored') {
    throw new Error('seed failed');
  }
  return upsert.record;
}

async function runPass(harness: Harness, overrides: Partial<ReapZombiesRequest> = {}): Promise<ReapZombiesResult> {
  return await build(harness).reapZombies(request(overrides));
}

function baseHarness(overrides: Partial<Harness> = {}): Harness {
  const attention: AttentionState = { recorded: [], cleared: [] };
  return {
    attempts: [],
    reservations: [],
    store: new InMemoryReaperFindingRepositoryAdapter(),
    journal: makeJournal(),
    reconcile: makeReconcile(),
    runner: makeRunner(),
    attention,
    attentionPort: makeAttention(attention, overrides.attentionItems ?? []),
    ...overrides,
  };
}

describe('reap zombies', () => {
  it('a dead attempt is reconciled under its reaper key and the finding is stored', async () => {
    const store = new InMemoryReaperFindingRepositoryAdapter();
    const seeded = await seedOpenFinding(store, 'att-1');
    const harness = baseHarness({
      attempts: [attemptFixture('att-1')],
      store,
      reconcile: makeReconcile([{ outcome: 'ended', attempt: attemptFixture('att-1'), receipt: { attemptId: 'att-1', sessionId: 'ses-att-1', endedAtIso: NOW, authoritative: true, exitStatus: 0, stoppedByRequest: false } }]),
    });
    const result = await runPass(harness);
    expect(result.outcome).toBe('completed');
    const finding = result.findings.find((entry) => entry.subject === 'att-1');
    expect(finding).toBeDefined();
    expect(finding?.findingId).toBe(seeded.findingId);
    expect(finding?.action).toBe('repair');
    // The intent was journaled before the action, the result after.
    expect(harness.journal.state.appendCalls.map((entry) => entry.kind)).toEqual(['intent', 'result']);
    const key = `reaper/att-1/dead-attempt@${seeded.findingId}`;
    expect(harness.journal.state.appendCalls[0]?.key).toBe(key);
    expect(harness.journal.state.appendCalls[0]?.mintedId).toBe(seeded.findingId);
    expect(harness.journal.state.appendCalls[1]?.outcome).toBe('completed');
    expect(harness.reconcile.calls).toEqual(['att-1']);
    const repair = result.repairs[0];
    expect(repair).toMatchObject({ key, kind: 'dead-attempt', subject: 'att-1', outcome: 'completed' });
  });

  it('one finding id is reused across passes so the repair key is stable', async () => {
    const store = new InMemoryReaperFindingRepositoryAdapter();
    const seeded = await seedOpenFinding(store, 'att-1');
    const harness = baseHarness({
      attempts: [attemptFixture('att-1')],
      store,
      reconcile: makeReconcile([{ outcome: 'ended', attempt: attemptFixture('att-1'), receipt: receiptFor('att-1') }]),
    });
    const first = await runPass(harness);
    // A later pass: the gap since the first pass's sighting has elapsed.
    const second = await runPass(harness, { nowIso: '2026-11-06T12:10:00.000Z' });
    const firstId = first.findings[0]?.findingId;
    const secondId = second.findings[0]?.findingId;
    expect(firstId).toBe(seeded.findingId);
    expect(secondId).toBe(firstId);
    // The second pass sees the final result of the first and does not act again.
    expect(harness.reconcile.calls).toEqual(['att-1']);
    expect(second.repairs[0]).toMatchObject({ outcome: 'skipped', reasonCode: 'already-repaired' });
  });

  it('a crash after the repair before its result leaves the next pass to record reconciled and to perform no second action', async () => {
    const store = new InMemoryReaperFindingRepositoryAdapter();
    const seeded = await seedOpenFinding(store, 'att-1');
    const key = `reaper/att-1/dead-attempt@${seeded.findingId}`;
    const intent: LaneRunJournalEntryRecord = {
      version: 1,
      entryId: newId(),
      kind: 'intent',
      key,
      runId: null,
      recordedAtIso: BEFORE,
      mode: null,
      expectedRevision: null,
      mintedId: seeded.findingId,
      outcome: null,
      reasonCode: null,
      detail: null,
      grantId: null,
      state: null,
    };
    // The classification snapshot still names the attempt running, but the
    // re-read the recovery performs finds it terminal: the previous pass
    // reconciled it and crashed before its result.
    const attemptRepo = makeAttemptRepo([attemptFixture('att-1')]);
    const byId = new Map([['att-1', attemptFixture('att-1', { state: 'ended', sessionId: null })]]);
    const reReadingRepo: AttemptRepositoryPort = {
      ...attemptRepo,
      findAttemptById: (attemptId: string) => {
        attemptRepo.findCalls.push(attemptId);
        return Promise.resolve(byId.get(attemptId) ?? null);
      },
    };
    const harness = baseHarness({
      attempts: [attemptFixture('att-1')],
      store,
      journal: makeJournal([intent]),
      attemptRepo: reReadingRepo,
    });
    const result = await runPass(harness);
    expect(harness.reconcile.calls).toEqual([]);
    expect(harness.journal.state.appendCalls).toHaveLength(1);
    expect(harness.journal.state.appendCalls[0]).toMatchObject({ kind: 'result', key, outcome: 'reconciled' });
    expect(result.repairs[0]).toMatchObject({ outcome: 'reconciled', key });
  });

  it('a subject with a young intent is never repaired', async () => {
    const harness = baseHarness({
      attempts: [attemptFixture('att-1', { updatedAtIso: YOUNG })],
    });
    const result = await runPass(harness);
    // The subject is seen but young: it waits, and nothing is repaired.
    expect(result.findings[0]).toMatchObject({ subject: 'att-1', kind: 'dead-attempt', action: 'wait' });
    expect(result.repairs).toEqual([]);
    expect(harness.reconcile.calls).toEqual([]);
    expect(harness.journal.state.appendCalls).toEqual([]);
  });

  it('an unreachable runner is an unknown and never proof the session ended', async () => {
    const unreachableRunner: ReturnType<typeof makeRunner> & { inspectCalls: RunnerSessionRef[] } = {
      ...makeRunner(),
      inspectSession: () => {
        return Promise.resolve({
          runnerReachable: 'unreachable',
          workspacePreparation: 'prepared',
          workerCommand: 'not-started',
          completionReceipt: null,
          artifactsCollected: false,
        } satisfies RunnerSessionStatus);
      },
    } as ReturnType<typeof makeRunner>;
    const harness = baseHarness({
      attempts: [attemptFixture('att-1', { updatedAtIso: BEFORE })],
      runner: unreachableRunner,
    });
    const result = await runPass(harness);
    expect(result.outcome).toBe('completed');
    // Unreachability does not establish the session ended: no dead-attempt
    // observation, no finding, no repair, only the unknown.
    expect(result.findings).toEqual([]);
    expect(result.repairs).toEqual([]);
    expect(result.unknown).toEqual([{ subject: 'att-1', kind: 'dead-attempt', reason: 'runner-unreachable' }]);
    expect(harness.journal.state.appendCalls).toEqual([]);
    expect(harness.reconcile.calls).toEqual([]);
  });

  it('a leaked slot is reported and never released', async () => {
    const store = new InMemoryReaperFindingRepositoryAdapter();
    await seedOpenFinding(store, 'res-1', 'leaked-slot');
    const harness = baseHarness({
      attempts: [attemptFixture('att-1', { state: 'ended', sessionId: null })],
      reservations: [reservationFixture('res-1', 'att-1')],
      store,
    });
    const result = await runPass(harness);
    const finding = result.findings.find((entry) => entry.subject === 'res-1');
    expect(finding).toBeDefined();
    expect(finding?.kind).toBe('leaked-slot');
    // Report-only: no repair was attempted, nothing was released.
    expect(result.repairs).toEqual([]);
    expect(harness.reconcile.calls).toEqual([]);
    expect(harness.journal.state.appendCalls).toEqual([]);
    const attention = result.attention.find((entry) => entry.subject === 'res-1');
    expect(attention?.outcome).toBe('raised');
  });

  it('a null request is refused without throwing', async () => {
    const harness = baseHarness();
    const useCase = build(harness);
    const result = await useCase.reapZombies(null as unknown as ReapZombiesRequest);
    expect(result).toMatchObject({ outcome: 'refused', reason: 'request-invalid' });
  });

  it('a missing project id is refused without throwing', async () => {
    const harness = baseHarness();
    const useCase = build(harness);
    const result = await useCase.reapZombies({ nowIso: NOW } as unknown as ReapZombiesRequest);
    expect(result).toMatchObject({ outcome: 'refused', reason: 'request-invalid' });
  });

  it('a wrong-typed project id is refused without throwing', async () => {
    const harness = baseHarness();
    const useCase = build(harness);
    const result = await useCase.reapZombies({ projectId: 42, nowIso: NOW } as unknown as ReapZombiesRequest);
    expect(result).toMatchObject({ outcome: 'refused', reason: 'request-invalid' });
  });

  it('a sparse observations array is refused without throwing', async () => {
    const sparse = new Array(3);
    sparse[1] = attemptFixture('att-1', { state: 'ended', sessionId: null });
    const harness = baseHarness();
    const attemptRepo: AttemptRepositoryPort = {
      saveAttempt: () => Promise.resolve(),
      findAttemptById: () => Promise.resolve(null),
      listAttemptsByWorkOrder: () => Promise.resolve([]),
      listAllAttempts: () => Promise.resolve(sparse as unknown as AttemptRecord[]),
    };
    const useCase = new ReapZombiesUseCase({
      attemptRepo,
      executionJournal: JOURNAL,
      runJournal: harness.journal,
      reconcile: harness.reconcile,
      runner: harness.runner,
      runnerForAttempt: RUNNER_FOR_ATTEMPT,
      attention: harness.attentionPort,
      reaperFindings: harness.store,
      newId,
    });
    const result = await useCase.reapZombies(request());
    expect(result.outcome).toBe('completed');
    expect(result.findings).toEqual([]);
  });

  it('an unknown finding kind is refused without throwing', async () => {
    const badStore: ReaperFindingRepositoryPort = {
      async upsertFinding() {
        return { outcome: 'refused', reason: 'unknown-kind' };
      },
      async listOpenFindings() {
        return [
          {
            findingId: newId(),
            revision: 1,
            state: 'open',
            finding: {
              schemaVersion: REAPER_FINDING_SCHEMA_VERSION,
              kind: 'not-a-kind' as ReaperFindingStoreRecord['finding']['kind'],
              subject: 'att-1',
              action: 'report',
              sightings: 1,
            },
          },
        ];
      },
      async closeFinding() {
        return { outcome: 'not-found' };
      },
    };
    const harness = baseHarness({ attempts: [attemptFixture('att-1')], reaperFindings: badStore });
    const result = await runPass(harness);
    expect(result.outcome).toBe('completed');
    expect(harness.reconcile.calls).toEqual([]);
  });

  it('a throwing getter on the request is refused without throwing', async () => {
    const harness = baseHarness();
    const useCase = build(harness);
    const malicious: Record<string, unknown> = {};
    Object.defineProperty(malicious, 'projectId', {
      enumerable: true,
      get() {
        throw new Error('getter exploded');
      },
    });
    const result = await useCase.reapZombies(malicious as unknown as ReapZombiesRequest);
    expect(result).toMatchObject({ outcome: 'refused', reason: 'request-invalid' });
  });

  it('an unreadable findings store is reported as unknown and never as empty', async () => {
    const throwingStore: ReaperFindingRepositoryPort = {
      upsertFinding: () => Promise.reject(new Error('unreadable')),
      listOpenFindings: () => Promise.reject(new Error('unreadable')),
      closeFinding: () => Promise.resolve({ outcome: 'not-found' }),
    };
    const harness = baseHarness({
      attempts: [attemptFixture('att-1')],
      reaperFindings: throwingStore,
    });
    const result = await runPass(harness);
    expect(result.findings).toEqual([]);
    expect(result.unknown).toContainEqual({ subject: '', reason: 'findings-unreadable' });
    // Nothing was written at all: no attention, no journal entry, no action.
    expect(harness.attention.recorded).toEqual([]);
    expect(harness.journal.state.appendCalls).toEqual([]);
    expect(harness.reconcile.calls).toEqual([]);
  });

  it('an unreadable attempts read is reported as unknown and nothing is written', async () => {
    const harness = baseHarness();
    const throwingRepo: AttemptRepositoryPort = {
      saveAttempt: () => Promise.resolve(),
      findAttemptById: () => Promise.resolve(null),
      listAttemptsByWorkOrder: () => Promise.resolve([]),
      listAllAttempts: () => Promise.reject(new Error('unreadable')),
    };
    const useCase = new ReapZombiesUseCase({
      attemptRepo: throwingRepo,
      executionJournal: JOURNAL,
      runJournal: harness.journal,
      reconcile: harness.reconcile,
      runner: harness.runner,
      runnerForAttempt: RUNNER_FOR_ATTEMPT,
      attention: harness.attentionPort,
      reaperFindings: harness.store,
      newId,
    });
    const result = await useCase.reapZombies(request());
    expect(result.unknown).toContainEqual({ subject: '', reason: 'attempts-unreadable' });
    expect(result.findings).toEqual([]);
    expect(harness.attention.recorded).toEqual([]);
    expect(harness.journal.state.appendCalls).toEqual([]);
  });

  it('no path and no secret-shaped text appears in the attention summary', async () => {
    const store = new InMemoryReaperFindingRepositoryAdapter();
    await seedOpenFinding(store, 'att-1');
    const harness = baseHarness({
      attempts: [attemptFixture('att-1')],
      store,
      reconcile: makeReconcile([{ outcome: 'ended', attempt: attemptFixture('att-1'), receipt: receiptFor('att-1') }]),
    });
    await runPass(harness);
    expect(harness.attention.recorded).toHaveLength(1);
    for (const { body } of harness.attention.recorded) {
      const summary = String(body.summary);
      expect(summary.includes(WORKTREE)).toBe(false);
      expect(summary.includes('/')).toBe(false);
      expect(containsSecretShape(summary)).toBe(false);
      expect(summary.length).toBeLessThanOrEqual(1024);
    }
  });

  it('the attention item is raised once per finding and refreshed on the next pass', async () => {
    const store = new InMemoryReaperFindingRepositoryAdapter();
    await seedOpenFinding(store, 'att-1');
    const harness = baseHarness({
      attempts: [attemptFixture('att-1')],
      store,
      reconcile: makeReconcile([{ outcome: 'ended', attempt: attemptFixture('att-1'), receipt: receiptFor('att-1') }]),
    });
    const first = await runPass(harness);
    const second = await runPass(harness, { nowIso: '2026-11-06T12:10:00.000Z' });
    expect(first.attention).toHaveLength(1);
    expect(first.attention[0]?.outcome).toBe('raised');
    expect(second.attention).toHaveLength(1);
    expect(second.attention[0]?.outcome).toBe('refreshed');
    expect(harness.attention.recorded).toHaveLength(2);
  });

  it('a subject with a recent stop intent in its action journal is never repaired', async () => {
    const store = new InMemoryReaperFindingRepositoryAdapter();
    await seedOpenFinding(store, 'att-1');
    const actionJournal = new Map<string, ActionJournalEntryRecord[]>();
    actionJournal.set('att-1', [
      {
        id: 'aj-1',
        attemptId: 'att-1',
        workOrderId: 'wo-a',
        action: 'stop',
        baseCommit: COMMIT,
        recordedAtIso: YOUNG,
        status: 'intent-recorded',
        sessionId: 'ses-att-1',
        detail: null,
      },
    ]);
    // The attempt record itself is old; only the journal intent is young, so
    // the no-young-intent rule must wait.
    const harness = baseHarness({
      attempts: [attemptFixture('att-1')],
      store,
      actionJournal,
      reconcile: makeReconcile([{ outcome: 'ended', attempt: attemptFixture('att-1'), receipt: receiptFor('att-1') }]),
    });
    const result = await runPass(harness);
    const finding = result.findings.find((entry) => entry.subject === 'att-1');
    expect(finding?.action).toBe('wait');
    expect(result.repairs).toEqual([]);
    expect(harness.reconcile.calls).toEqual([]);
    expect(harness.journal.state.appendCalls).toEqual([]);
  });

  it('an open attention item for a terminal attempt is reported as stale-attention', async () => {
    const store = new InMemoryReaperFindingRepositoryAdapter();
    // A prior sighting, so the second sighting past the grace period reports.
    await seedOpenFinding(store, 'att-1', 'stale-attention');
    const attentionItems = [
      {
        itemId: 'attn-1',
        projectId: PROJECT,
        kind: 'dead-attempt',
        subject: { kind: 'attempt', ref: 'att-1' },
        workOrderId: 'wo-a',
        summary: 'Reaper finding dead-attempt for attempt att-1; action report; sightings 2',
        state: 'open',
        raisedBy: 'reaper',
        firstRaisedAtIso: BEFORE,
        lastRaisedAtIso: BEFORE,
        raisedCount: 1,
        clearance: null,
      },
    ];
    const harness = baseHarness({
      attempts: [attemptFixture('att-1', { state: 'ended', sessionId: null })],
      store,
      attentionItems,
    });
    const result = await runPass(harness);
    const finding = result.findings.find((entry) => entry.kind === 'stale-attention');
    expect(finding).toBeDefined();
    expect(finding?.subject).toBe('att-1');
    expect(finding?.action).toBe('report');
    // A stale-attention finding raises nothing new: the item is already open.
    expect(result.attention).toEqual([]);
  });

  it('a resolved finding is closed and its attention item cleared on the next pass', async () => {
    const store = new InMemoryReaperFindingRepositoryAdapter();
    await seedOpenFinding(store, 'att-1');
    const attention: AttentionState = { recorded: [], cleared: [] };
    const harness = baseHarness({
      // The attempt is no longer running: the zombie resolved.
      attempts: [attemptFixture('att-1', { state: 'ended', sessionId: null })],
      store,
      attention,
      attentionPort: makeAttention(attention),
    });
    const result = await runPass(harness);
    expect(result.findings).toEqual([]);
    expect(await store.listOpenFindings()).toHaveLength(0);
    expect(attention.cleared).toHaveLength(1);
    expect(attention.cleared[0]?.request).toMatchObject({
      action: 'resolve',
      projectId: PROJECT,
      kind: 'dead-attempt',
      subject: { kind: 'attempt', ref: 'att-1' },
      reason: 'stale',
    });
  });

  it('a crash after reconcile leaves the next pass to recover via the settle sweep even when the attempt is terminal', async () => {
    const store = new InMemoryReaperFindingRepositoryAdapter();
    const seeded = await seedOpenFinding(store, 'att-1');
    const key = `reaper/att-1/dead-attempt@${seeded.findingId}`;
    const intent: LaneRunJournalEntryRecord = {
      version: 1,
      entryId: newId(),
      kind: 'intent',
      key,
      runId: null,
      recordedAtIso: BEFORE,
      mode: null,
      expectedRevision: null,
      mintedId: seeded.findingId,
      outcome: null,
      reasonCode: null,
      detail: null,
      grantId: null,
      state: null,
    };
    // The attempt is terminal in the list read: it is omitted from observations,
    // so the recovery must come from the settle sweep, not the repair loop.
    const harness = baseHarness({
      attempts: [attemptFixture('att-1', { state: 'ended', sessionId: null })],
      store,
      journal: makeJournal([intent]),
      attemptRepo: makeAttemptRepo([attemptFixture('att-1', { state: 'ended', sessionId: null })]),
      reconcile: makeReconcile([{ outcome: 'ended', attempt: attemptFixture('att-1'), receipt: receiptFor('att-1') }]),
    });
    await runPass(harness);
    expect(harness.reconcile.calls).toEqual([]);
    expect(harness.journal.state.appendCalls).toHaveLength(1);
    expect(harness.journal.state.appendCalls[0]).toMatchObject({ kind: 'result', key, outcome: 'reconciled' });
    expect(await store.listOpenFindings()).toHaveLength(0);
  });

  it('a leaked slot is released through the fenced capacity release when policy enables it', async () => {
    const store = new InMemoryReaperFindingRepositoryAdapter();
    const seeded = await seedOpenFinding(store, 'res-1', 'leaked-slot');
    const releaseCalls: ReleaseCapacityReservationIfUnchangedRequest[] = [];
    const release: ExecutionJournalPort['releaseCapacityReservationIfUnchanged'] = (request) => {
      releaseCalls.push(request);
      return Promise.resolve({ outcome: 'released', reservationId: request.reservationId });
    };
    const harness = baseHarness({
      attempts: [attemptFixture('att-1', { state: 'ended', sessionId: null })],
      reservations: [reservationFixture('res-1', 'att-1')],
      store,
      release,
    });
    const policy = { graceMinutes: 5, repairs: { 'dead-attempt': true, 'leaked-slot': true } };
    const result = await runPass(harness, { policy });
    const repair = result.repairs.find((entry) => entry.kind === 'leaked-slot');
    expect(repair).toBeDefined();
    expect(repair?.outcome).toBe('completed');
    expect(repair?.key).toBe(`reaper/res-1/leaked-slot@${seeded.findingId}`);
    expect(releaseCalls).toHaveLength(1);
    expect(releaseCalls[0]?.attemptId).toBe('att-1');
    expect(releaseCalls[0]?.reservationId).toBe('res-1');
    expect(releaseCalls[0]?.attemptRevision).toBe(0);
    expect(typeof releaseCalls[0]?.readAttemptRevision).toBe('function');
    expect(harness.journal.state.appendCalls.map((entry) => entry.kind)).toEqual(['intent', 'result']);
    expect(harness.journal.state.appendCalls[1]?.outcome).toBe('completed');
  });

  it('a changed fenced release ends the repair ambiguous and keeps the finding reported', async () => {
    const store = new InMemoryReaperFindingRepositoryAdapter();
    await seedOpenFinding(store, 'res-1', 'leaked-slot');
    const release: ExecutionJournalPort['releaseCapacityReservationIfUnchanged'] = () => Promise.resolve({ outcome: 'changed' });
    const harness = baseHarness({
      attempts: [attemptFixture('att-1', { state: 'ended', sessionId: null })],
      reservations: [reservationFixture('res-1', 'att-1')],
      store,
      release,
    });
    const policy = { graceMinutes: 5, repairs: { 'leaked-slot': true } };
    const result = await runPass(harness, { policy });
    const repair = result.repairs.find((entry) => entry.kind === 'leaked-slot');
    expect(repair?.outcome).toBe('ambiguous');
    expect(await store.listOpenFindings()).not.toHaveLength(0);
  });

  it('a leaked-slot repair is skipped when the fenced release is unavailable', async () => {
    const store = new InMemoryReaperFindingRepositoryAdapter();
    await seedOpenFinding(store, 'res-1', 'leaked-slot');
    const harness = baseHarness({
      attempts: [attemptFixture('att-1', { state: 'ended', sessionId: null })],
      reservations: [reservationFixture('res-1', 'att-1')],
      store,
      release: undefined,
    });
    const policy = { graceMinutes: 5, repairs: { 'leaked-slot': true } };
    const result = await runPass(harness, { policy });
    const repair = result.repairs.find((entry) => entry.kind === 'leaked-slot');
    expect(repair).toMatchObject({ outcome: 'skipped', reasonCode: 'repair-not-available' });
  });
});
