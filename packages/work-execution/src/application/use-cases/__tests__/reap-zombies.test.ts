/**
 * Unit tests for lane K11a2: the reaper pass (`ReapZombiesUseCase`). The fakes
 * cover the keyed record-only repair (intent before the action, result after),
 * the fault injections (a crash between the repair and its result; a young
 * subject never repaired), the store semantics (one finding id reused across
 * passes, an unreadable store never treated as empty), every typed refusal on
 * runtime input, and the ids-and-codes-only output boundary.
 */

import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';

import { containsSecretShape } from '@fleet/shared';

import type { ActionJournalEntryRecord, AttemptRecord, CapacityReservationRecord } from '../../../domain/execution-records.js';
import type { AttemptRepositoryPort } from '../../ports/out/AttemptRepositoryPort.out-port.js';
import type { ExecutionJournalPort, ReserveCapacityAtomicallyRequest } from '../../ports/out/ExecutionJournalPort.out-port.js';
import type { LaneRunJournalEntryRecord } from '../../../domain/lane-run-journal.js';
import type { LaneRunJournalPort, LaneRunJournalAppendResult } from '../../ports/out/LaneRunJournalPort.out-port.js';
import type { LaneRunRepositoryPort } from '../../ports/out/LaneRunRepositoryPort.out-port.js';
import type { ConductorHaltPort } from '../../ports/out/ConductorHaltPort.out-port.js';
import type { ConductorHaltState } from '../../../domain/conductor-halt.js';
import type {
  ExecutionRunnerPort,
  RunnerSessionRef,
  RunnerSessionStatus,
} from '../../ports/out/ExecutionRunnerPort.out-port.js';
import type { RunnerForAttemptPort } from '../../ports/out/RunnerForAttemptPort.out-port.js';
import type { ReconcileAttemptPort, ReconcileAttemptResult } from '../../ports/in/ReconcileAttemptPort.in-port.js';
import type { ReaperFindingRepositoryPort, ReaperFindingStoreRecord } from '../../ports/out/ReaperFindingRepositoryPort.out-port.js';
import type {
  ForgeReadPort,
  ReadPullRequestRequest,
  ReadPullRequestResult,
} from '../../ports/out/ForgeReadPort.out-port.js';
import type {
  InspectWorktreeForRemovalRequest,
  InspectWorktreeForRemovalResult,
  ListWorktreesRequest,
  ListWorktreesResult,
  ListedWorktree,
  ReadFilesystemSpaceRequest,
  ReadFilesystemSpaceResult,
  RemoveWorktreeRequest,
  RemoveWorktreeResult,
  WorktreeRemovalFacts,
  WorkspacePort,
} from '../../ports/out/WorkspacePort.out-port.js';
import type {
  ReapZombiesRequest,
  ReapZombiesResult,
} from '../../ports/in/ReapZombiesPort.in-port.js';
import {
  ReapZombiesUseCase,
  type ReaperAttentionPort,
  type ReaperMergeRecordRead,
  type ReaperProjectProfileView,
  type ReaperProjectProfilesPort,
} from '../ReapZombiesUseCase.use-case.js';
import { ReserveExecutionCapacityUseCase } from '../ReserveExecutionCapacityUseCase.use-case.js';
import { InMemoryReaperFindingRepositoryAdapter } from '../../../infrastructure/adapters/InMemoryReaperFindingRepositoryAdapter.adapter.js';
import { REAPER_FINDING_SCHEMA_VERSION } from '../../../domain/reaper-findings.js';

const NOW = '2026-11-06T12:00:00.000Z';
const BEFORE = '2026-11-06T11:00:00.000Z'; // one hour before NOW: not young
const YOUNG = '2026-11-06T11:59:30.000Z'; // 30 s before NOW: young
const WORKTREE = '/tmp/worktree-example-1';
const COMMIT = 'a'.repeat(40);
const PROJECT = 'proj-1';

// KW4a fixtures: one registered clone, its one linked worktree, its host.
const HOST_NAME = 'host-1';
const CLONE = '/srv/clone';
const ROOT = '/srv/clone/.worktrees';
const WT_PATH = '/srv/clone/.worktrees/wt-a';
const OLD = '2026-11-04T12:00:00.000Z'; // over the 24 h retention before NOW: quiet
const LATER = '2026-11-06T12:10:00.000Z'; // past the grace after NOW
const DISK_POLICY = { graceMinutes: 5, minFreePercent: 15, clearFreePercent: 20 };

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
    inspectWorktreeRun: () => Promise.resolve({ state: 'idle' }),
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

const JOURNAL: Pick<ExecutionJournalPort, 'listActiveReservations' | 'listJournalEntriesForAttempt'> = {
  listActiveReservations: () => Promise.resolve([]),
  listJournalEntriesForAttempt: () => Promise.resolve([]),
};

// ---------------------------------------------------------------------------
// KW4a fakes: the workspace, profile and forge reads of the gathering.
// ---------------------------------------------------------------------------

/** The 12-hex digest the tests use for a subject; matches the D1 shape. */
function testDigest(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 12);
}

/** The subject of the fixture worktree, computable before a pass runs. */
function subjectOfFixtureWorktree(): string {
  return testDigest(`${HOST_NAME}\u0000${PROJECT}\u0000${CLONE}\u0000${WT_PATH}`);
}

/** The host digest of the fixture host (D1). */
function subjectOfFixtureHost(): string {
  return testDigest(`host\u0000${HOST_NAME}`);
}

function removalFacts(overrides: Partial<WorktreeRemovalFacts> = {}): WorktreeRemovalFacts {
  return {
    path: WT_PATH,
    head: COMMIT,
    branch: 'fleet/merged-branch',
    detached: false,
    headOnDefault: true,
    status: { tracked: 0, untracked: 0, unmerged: 0 },
    locked: false,
    inProgressOperations: [],
    lastActivity: { iso: OLD, unknown: false },
    sizeBytes: 4096,
    ...overrides,
  };
}

function listedWorktree(path: string, overrides: Partial<ListedWorktree> = {}): ListedWorktree {
  return { path, head: COMMIT, branch: 'fleet/branch', locked: false, prunable: false, ...overrides };
}

interface WorkspaceFake {
  /** Every method name called, in order, read or write. */
  calls: string[];
  /** Every request of the read methods (and a repair removal), in order. */
  requests: { list?: ListWorktreesRequest; inspect?: InspectWorktreeForRemovalRequest; space?: ReadFilesystemSpaceRequest; remove?: RemoveWorktreeRequest }[];
  /** The forbidden write methods' call names; must stay empty for a report-only pass. */
  forbidden: string[];
  listWorktreesCount: number;
}

interface WorkspaceOptions {
  /** The listed entries; a sparse array or malformed entries exercise the robustness bar. */
  entries?: readonly (ListedWorktree | null | undefined)[];
  /** The inspection answer, resolved fresh on every read. */
  facts?: () => WorktreeRemovalFacts;
  /** Throwing overrides for each read. */
  throwList?: boolean;
  throwInspect?: boolean;
  throwSpace?: boolean;
  /** Answer overrides: an `unknown` inspection or a filesystem answer. */
  inspectAnswer?: () => InspectWorktreeForRemovalResult;
  spaceAnswer?: (request: ReadFilesystemSpaceRequest) => ReadFilesystemSpaceResult;
  /** KW4b': an explicit `removeWorktree` answer; when set the write is allowed. */
  removeAnswer?: () => RemoveWorktreeResult;
}

/**
 * The read-only workspace fake. Only the three read methods are implemented;
 * the forbidden write methods are recorded if ever called and must stay
 * untouched by a report-only pass.
 */
function makeWorkspace(options: WorkspaceOptions = {}): WorkspacePort & WorkspaceFake {
  const entries = options.entries ?? [listedWorktree(WT_PATH)];
  const facts = options.facts ?? removalFacts;
  const fake = {
    calls: [],
    requests: [],
    forbidden: [],
    listWorktreesCount: 0,
    listWorktrees: (request: ListWorktreesRequest) => {
      fake.calls.push('listWorktrees');
      fake.requests.push({ list: request });
      fake.listWorktreesCount += 1;
      if (options.throwList) {
        return Promise.reject(new Error('list failed'));
      }
      // Holes and malformed entries are handed over as-is: the pass must skip
      // them without throwing (the robustness bar).
      return Promise.resolve({ outcome: 'listed', worktrees: entries as unknown as readonly ListedWorktree[] } satisfies ListWorktreesResult);
    },
    inspectWorktreeForRemoval: (request: InspectWorktreeForRemovalRequest) => {
      fake.calls.push('inspectWorktreeForRemoval');
      fake.requests.push({ inspect: request });
      if (options.throwInspect) {
        return Promise.reject(new Error('inspect failed'));
      }
      if (options.inspectAnswer !== undefined) {
        return Promise.resolve(options.inspectAnswer());
      }
      return Promise.resolve({ outcome: 'inspected', facts: facts() } satisfies InspectWorktreeForRemovalResult);
    },
    readFilesystemSpace: (request: ReadFilesystemSpaceRequest) => {
      fake.calls.push('readFilesystemSpace');
      fake.requests.push({ space: request });
      if (options.throwSpace) {
        return Promise.reject(new Error('space failed'));
      }
      if (options.spaceAnswer !== undefined) {
        return Promise.resolve(options.spaceAnswer(request));
      }
      return Promise.resolve({ outcome: 'read', freeBytes: 200, totalBytes: 1000 } satisfies ReadFilesystemSpaceResult);
    },
  } as unknown as WorkspacePort & WorkspaceFake;
  if (options.removeAnswer !== undefined) {
    Object.defineProperty(fake, 'removeWorktree', {
      enumerable: true,
      value: (request: RemoveWorktreeRequest) => {
        fake.calls.push('removeWorktree');
        fake.requests.push({ remove: request });
        return Promise.resolve(options.removeAnswer!());
      },
    });
  } else {
    Object.defineProperty(fake, 'removeWorktree', {
      enumerable: true,
      value: () => {
        fake.forbidden.push('removeWorktree');
        return Promise.reject(new Error('a report-only pass must never call a write method'));
      },
    });
  }
  const writes: [keyof WorkspacePort, string][] = [
    ['removeLaneWorktree', 'removeLaneWorktree'],
    ['commitLaneOutput', 'commitLaneOutput'],
    ['resetWorktreeToHead', 'resetWorktreeToHead'],
    ['prepareLaneWorktree', 'prepareLaneWorktree'],
    ['preserveWorktreeEdits', 'preserveWorktreeEdits'],
  ];
  for (const [key, name] of writes) {
    Object.defineProperty(fake, key, {
      enumerable: true,
      value: () => {
        fake.forbidden.push(name);
        return Promise.reject(new Error('a report-only pass must never call a write method'));
      },
    });
  }
  return fake;
}

function profileView(overrides: Partial<ReaperProjectProfileView> = {}): ReaperProjectProfileView {
  return {
    projectId: PROJECT,
    status: 'active',
    defaultBranch: 'main',
    clones: { [HOST_NAME]: { path: CLONE, worktreeRoot: ROOT } },
    ...overrides,
  };
}

function makeProfiles(profiles: readonly ReaperProjectProfileView[]): ReaperProjectProfilesPort & { calls: number } {
  const fake: ReaperProjectProfilesPort & { calls: number } = {
    calls: 0,
    listProjectProfiles: (request: { readonly status?: 'active' | 'retired' }) => {
      fake.calls += 1;
      if (request.status === undefined) {
        return Promise.reject(new Error('status required'));
      }
      return Promise.resolve({ outcome: 'listed', profiles });
    },
  };
  return fake;
}

function mergedPrSnapshot(): ReadPullRequestResult {
  return {
    outcome: 'found',
    pullRequest: {
      number: 1,
      state: 'merged',
      mergeState: 'clean',
      headSha: COMMIT,
      headRef: 'fleet/merged-branch',
      isCrossRepository: false,
      headRepositoryOwner: 'example-owner',      baseRef: 'main',
      mergedAtIso: OLD,
      closedAtIso: null,
      mergeCommitSha: COMMIT,
    },
  };
}

function makeForgeRead(answer: () => ReadPullRequestResult = mergedPrSnapshot, throwRead = false): ForgeReadPort & { requests: ReadPullRequestRequest[] } {
  const fake: ForgeReadPort & { requests: ReadPullRequestRequest[] } = {
    requests: [],
    readPullRequest: (request: ReadPullRequestRequest) => {
      fake.requests.push(request);
      if (throwRead) {
        return Promise.reject(new Error('forge failed'));
      }
      return Promise.resolve(answer());
    },
    listOpenPullRequestsByBase: () => Promise.resolve({ outcome: 'unavailable', reason: 'not used' }),
    isConfigured: () => true,
  };
  return fake;
}

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
  /** A spy planted on the journal under the release name: the reaper must never call it. */
  releaseSpy?: () => unknown;
  attentionItems?: unknown[];
  newIdOverride?: () => string;
  reaperFindings?: ReaperFindingRepositoryPort;
  attemptRepo?: AttemptRepositoryPort;
  runnerForAttempt?: RunnerForAttemptPort;
  /** KW4a: the optional gathering dependencies; absent means the gathering does not run. */
  workspace?: WorkspacePort;
  profiles?: ReaperProjectProfilesPort;
  forgeRead?: ForgeReadPort & { requests: ReadPullRequestRequest[] };
  computeDigest?: (text: string) => string;
  /** KW4b': the optional merged-worktree repair dependencies. */
  reserveCapacity?: ExecutionJournalPort['reserveCapacityAtomically'];
  releaseCapacity?: ExecutionJournalPort['releaseCapacityReservation'];
  runRepo?: Pick<LaneRunRepositoryPort, 'list'>;
  mergeRecordRepo?: ReaperMergeRecordRead;
  halt?: Pick<ConductorHaltPort, 'read'>;
  clockMs?: () => number;
  storeCallTimeoutMs?: number;
}

function build(harness: Harness): ReapZombiesUseCase {
  const attemptRepo = harness.attemptRepo ?? makeAttemptRepo(harness.attempts);
  const executionJournal: Pick<ExecutionJournalPort, 'listActiveReservations' | 'listJournalEntriesForAttempt'> & {
    reserveCapacityAtomically?: ExecutionJournalPort['reserveCapacityAtomically'];
    releaseCapacityReservation?: ExecutionJournalPort['releaseCapacityReservation'];
  } = {
    listActiveReservations: () => Promise.resolve(harness.reservations),
    listJournalEntriesForAttempt: (attemptId: string) => {
      const entries = harness.actionJournal?.get(attemptId);
      return Promise.resolve(entries ?? []);
    },
    ...(harness.releaseSpy === undefined ? {} : { releaseCapacityReservationIfUnchanged: harness.releaseSpy }),
    ...(harness.reserveCapacity === undefined ? {} : { reserveCapacityAtomically: harness.reserveCapacity }),
    ...(harness.releaseCapacity === undefined ? {} : { releaseCapacityReservation: harness.releaseCapacity }),
  };
  const runnerForAttempt: RunnerForAttemptPort = harness.runnerForAttempt ?? {
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
    ...(harness.workspace === undefined ? {} : { workspace: harness.workspace }),
    ...(harness.profiles === undefined ? {} : { profiles: harness.profiles }),
    ...(harness.forgeRead === undefined ? {} : { forgeRead: harness.forgeRead }),
    ...(harness.computeDigest === undefined ? {} : { computeDigest: harness.computeDigest }),
    ...(harness.runRepo === undefined ? {} : { runRepo: harness.runRepo }),
    ...(harness.mergeRecordRepo === undefined ? {} : { mergeRecordRepo: harness.mergeRecordRepo }),
    ...(harness.halt === undefined ? {} : { halt: harness.halt }),
    ...(harness.clockMs === undefined ? {} : { clockMs: harness.clockMs }),
    ...(harness.storeCallTimeoutMs === undefined ? {} : { storeCallTimeoutMs: harness.storeCallTimeoutMs }),
  });
}

function request(overrides: Partial<ReapZombiesRequest> = {}): ReapZombiesRequest {
  return { projectId: PROJECT, nowIso: NOW, policy: POLICY, ...overrides };
}

/** Seed one open finding so the next pass reaches the two-sightings repair rule. */
async function seedOpenFinding(
  store: ReaperFindingRepositoryPort,
  subject: string,
  kind: 'dead-attempt' | 'leaked-slot' | 'stale-attention' | 'merged-worktree' | 'disk-pressure' = 'dead-attempt',
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
    computeDigest: testDigest,
    ...overrides,
  };
}

/**
 * A base harness with the KW4a gathering wired: one active profile, one clone,
 * one clean merged worktree and a forge that reads a merged PR for its branch.
 */
function gatherHarness(overrides: Partial<Harness> & { workspace?: WorkspacePort } = {}): Harness {
  const base = baseHarness(overrides);
  return {
    ...base,
    workspace: overrides.workspace ?? makeWorkspace(),
    profiles: overrides.profiles ?? makeProfiles([profileView()]),
    forgeRead: overrides.forgeRead ?? makeForgeRead(),
    computeDigest: testDigest,
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
    await seedOpenFinding(store, 'att-1:dead-attempt', 'stale-attention');
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
    expect(finding?.subject).toBe('att-1:dead-attempt');
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

  it('a leaked slot is never released even when the leaked-slot repair is enabled in policy', async () => {
    const store = new InMemoryReaperFindingRepositoryAdapter();
    await seedOpenFinding(store, 'res-1', 'leaked-slot');
    let releaseCalls = 0;
    const harness = baseHarness({
      attempts: [attemptFixture('att-1', { state: 'ended', sessionId: null })],
      reservations: [reservationFixture('res-1', 'att-1')],
      store,
      releaseSpy: () => {
        releaseCalls += 1;
        return Promise.resolve({ outcome: 'released' });
      },
    });
    const policy = { graceMinutes: 5, repairs: { 'dead-attempt': true, 'leaked-slot': true } };
    const result = await runPass(harness, { policy });
    expect(releaseCalls).toBe(0);
    expect(result.findings.find((entry) => entry.kind === 'leaked-slot')?.subject).toBe('res-1');
    // Report-only: the stored finding, the view and the attention summary never say `repair`.
    expect(result.findings.find((entry) => entry.kind === 'leaked-slot')?.action).toBe('report');
    expect((await store.listOpenFindings()).find((record) => record.finding.kind === 'leaked-slot')?.finding.action).toBe('report');
    expect(result.repairs.find((entry) => entry.kind === 'leaked-slot')).toBeUndefined();
    expect(harness.attention.recorded.some((entry) => String(entry.body.summary).includes('action repair'))).toBe(false);
    expect(harness.journal.state.appendCalls).toEqual([]);
  });

  it('two open attention items of different kinds on one terminal attempt are each cleared and journalled', async () => {
    const store = new InMemoryReaperFindingRepositoryAdapter();
    await seedOpenFinding(store, 'att-1:approval', 'stale-attention');
    await seedOpenFinding(store, 'att-1:question', 'stale-attention');
    const item = (kind: string): Record<string, unknown> => ({
      itemId: `attn-${kind}`,
      projectId: PROJECT,
      kind,
      subject: { kind: 'attempt', ref: 'att-1' },
      workOrderId: 'wo-a',
      summary: 's',
      state: 'open',
      raisedBy: 'reaper',
      firstRaisedAtIso: BEFORE,
      lastRaisedAtIso: BEFORE,
      raisedCount: 1,
      clearance: null,
    });
    const attention: AttentionState = { recorded: [], cleared: [] };
    const base = makeAttention(attention, [item('approval'), item('question')]);
    let failApproval = true;
    const attentionPort: ReaperAttentionPort = {
      ...base,
      clearAttentionItem: (request: unknown, via: string, actor: string) => {
        if (failApproval && (request as { kind: string }).kind === 'approval') {
          attention.cleared.push({ request: request as Record<string, unknown>, via, actor });
          return Promise.reject(new Error('clear failed'));
        }
        return base.clearAttentionItem(request, via, actor);
      },
    };
    const harness = baseHarness({
      attempts: [attemptFixture('att-1', { state: 'ended', sessionId: null })],
      store,
      attention,
      attentionPort,
    });
    const first = await runPass(harness, { policy: { graceMinutes: 5, repairs: { 'stale-attention': true } } });
    const repairs = first.repairs.filter((entry) => entry.kind === 'stale-attention');
    expect(repairs.map((entry) => entry.subject).sort()).toEqual(['att-1:approval', 'att-1:question']);
    expect(repairs.find((entry) => entry.subject === 'att-1:question')?.outcome).toBe('completed');
    expect(repairs.find((entry) => entry.subject === 'att-1:approval')).toMatchObject({ outcome: 'skipped', reasonCode: 'attention-unclearable' });
    expect(attention.cleared.map((entry) => (entry.request as { kind: string }).kind).sort()).toEqual(['approval', 'question']);
    const results = harness.journal.state.appendCalls.filter((entry) => entry.kind === 'result');
    expect(results).toHaveLength(1);
    expect(results[0]?.key).toMatch(/^reaper\/att-1:question\/stale-attention@/);
    // A second pass does not clear the finished kind again.
    failApproval = false;
    attention.cleared.length = 0;
    const second = await build(harness).reapZombies(request({ nowIso: '2026-11-06T12:30:00.000Z', policy: { graceMinutes: 5, repairs: { 'stale-attention': true } } }));
    expect(second.repairs.find((entry) => entry.subject === 'att-1:question')).toMatchObject({ outcome: 'skipped', reasonCode: 'already-repaired' });
    expect(attention.cleared.filter((entry) => (entry.request as { kind: string }).kind === 'question')).toHaveLength(0);
  });

  it('a fractional graceMinutes is accepted and used', async () => {
    // The attempt was last active 30 s ago: young under 5 minutes, not young under 0.25 minutes.
    const attempts = [attemptFixture('att-1', { createdAtIso: YOUNG, updatedAtIso: YOUNG })];
    const repairs = { 'dead-attempt': true };
    const actionFor = async (graceMinutes: number): Promise<string | undefined> => {
      const store = new InMemoryReaperFindingRepositoryAdapter();
      await seedOpenFinding(store, 'att-1');
      const result = await runPass(baseHarness({ attempts, store }), { policy: { graceMinutes, repairs } });
      expect(result.outcome).toBe('completed');
      return result.findings.find((entry) => entry.subject === 'att-1')?.action;
    };
    expect(await actionFor(5)).not.toBe('repair');
    expect(await actionFor(0.25)).toBe('repair');
    expect(await actionFor(0)).toBe('repair');
  });

  it('a non-finite, negative or non-number graceMinutes is refused', async () => {
    for (const graceMinutes of [Number.NaN, Number.POSITIVE_INFINITY, -1, '5', null]) {
      const result = await runPass(baseHarness({ attempts: [attemptFixture('att-1')] }), { policy: { graceMinutes } as never });
      expect(result).toMatchObject({ outcome: 'refused', reason: 'request-invalid' });
    }
  });

  it('a close conflict leaves the finding and its attention item untouched and reports it', async () => {
    const store = new InMemoryReaperFindingRepositoryAdapter();
    await seedOpenFinding(store, 'att-1');
    const attention: AttentionState = { recorded: [], cleared: [] };
    const conflicting: ReaperFindingRepositoryPort = {
      upsertFinding: store.upsertFinding.bind(store),
      listOpenFindings: store.listOpenFindings.bind(store),
      closeFinding: () => Promise.resolve({ outcome: 'conflict' as const }),
    } as unknown as ReaperFindingRepositoryPort;
    const harness = baseHarness({
      attempts: [attemptFixture('att-1', { state: 'ended', sessionId: null })],
      store,
      attention,
      attentionPort: makeAttention(attention),
      reaperFindings: conflicting,
    });
    const result = await runPass(harness);
    expect(attention.cleared).toHaveLength(0);
    expect(await store.listOpenFindings()).toHaveLength(1);
    expect(result.unknown).toContainEqual({ subject: 'att-1', kind: 'dead-attempt', reason: 'finding-close-conflict' });
  });

  it('a secret-shaped attempt id is never copied into an unknown subject', async () => {
    const token = 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8';
    expect(containsSecretShape(token)).toBe(true);
    const harness = baseHarness({
      attempts: [attemptFixture(token)],
      runnerForAttempt: { runnerForAttempt: () => ({ ok: false, reason: 'host-unknown' }) },
    });
    const result = await runPass(harness);
    expect(JSON.stringify(result).includes(token)).toBe(false);
    expect(result.unknown).toContainEqual({ subject: '', reason: 'subject-unsafe' });
    expect(harness.runner.inspectCalls).toEqual([]);
  });

  it('a secret-shaped reservation id is never copied into an unknown subject', async () => {
    const token = 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8';
    const harness = baseHarness({ reservations: [reservationFixture(token, 'att-1')] });
    const result = await runPass(harness);
    expect(JSON.stringify(result).includes(token)).toBe(false);
    expect(result.findings).toEqual([]);
  });

  it('pass-cap unknowns are capped at the 64-item output cap', async () => {
    const attempts: AttemptRecord[] = [];
    for (let index = 0; index < 200; index += 1) {
      attempts.push(attemptFixture(`att-${index}`));
    }
    const result = await runPass(baseHarness({ attempts }));
    const capped = result.unknown.filter((entry) => entry.reason === 'pass-cap');
    expect(capped).toHaveLength(64);
    expect(result.findings.length).toBeLessThanOrEqual(64);
  });

  it('a throwing policy getter is refused without throwing', async () => {
    const policy = {};
    Object.defineProperty(policy, 'graceMinutes', {
      enumerable: true,
      get: () => {
        throw new Error('boom');
      },
    });
    const harness = baseHarness({ attempts: [attemptFixture('att-1')] });
    const result = await runPass(harness, { policy });
    expect(result).toMatchObject({ outcome: 'refused', reason: 'request-invalid' });
    expect(harness.journal.state.appendCalls).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // KW4a: the worktree and disk gathering — report only.
  // -------------------------------------------------------------------------

  it('reports a merged worktree with its size and never removes it', async () => {
    const workspace = makeWorkspace();
    const harness = gatherHarness({ workspace });
    const first = await runPass(harness);
    const second = await runPass(harness, { nowIso: LATER });
    expect(second.outcome).toBe('completed');
    const finding = second.findings.find((entry) => entry.kind === 'merged-worktree');
    expect(finding).toBeDefined();
    expect(finding?.action).toBe('report'); // report only, even though the condition holds
    expect(finding?.subject).toMatch(/^[0-9a-f]{12}$/);
    expect(second.worktrees).toEqual([
      { subject: finding?.subject, report: 'merged-worktree', evidence: 'merged-pr', sizeBytes: 4096 },
    ]);
    // The first sighting waits; only the second, past the grace, reports.
    expect(first.findings.find((entry) => entry.kind === 'merged-worktree')?.action).toBe('wait');
    // Never removes: no write method of the workspace port was called and no journal intent was written.
    expect(workspace.forbidden).toEqual([]);
    expect(harness.journal.state.appendCalls).toEqual([]);
  });

  it('reports a busy worktree and suppresses the merged-worktree finding for that subject', async () => {
    const holder = { facts: removalFacts({ inProgressOperations: ['rebase-merge'] }) };
    const workspace = makeWorkspace({ facts: () => holder.facts });
    const harness = gatherHarness({ workspace });
    await runPass(harness);
    const second = await runPass(harness, { nowIso: LATER });
    const subject = subjectOfFixtureWorktree();
    expect(second.findings.find((entry) => entry.subject === subject && entry.kind === 'merged-worktree')).toBeUndefined();
    expect(second.worktrees).toEqual([
      { subject, report: 'worktree-busy', evidence: 'unknown', sizeBytes: 4096 },
    ]);
    // The busy subject never reaches the forge either.
    expect(harness.forgeRead?.requests).toEqual([]);
  });

  it('keeps one finding id for a worktree subject across passes', async () => {
    const harness = gatherHarness();
    const first = await runPass(harness);
    const second = await runPass(harness, { nowIso: LATER });
    const firstId = first.findings.find((entry) => entry.kind === 'merged-worktree')?.findingId;
    const secondId = second.findings.find((entry) => entry.kind === 'merged-worktree')?.findingId;
    expect(firstId).toBeDefined();
    expect(secondId).toBe(firstId);
  });

  it('raises one worktree-busy attention item and refreshes it on the next pass', async () => {
    const workspace = makeWorkspace({ facts: () => removalFacts({ inProgressOperations: ['MERGE_HEAD'] }) });
    const harness = gatherHarness({ workspace });
    const first = await runPass(harness);
    const second = await runPass(harness, { nowIso: LATER });
    const subject = subjectOfFixtureWorktree();
    expect(first.attention).toEqual([{ kind: 'worktree-busy', subject, outcome: 'raised' }]);
    expect(second.attention).toEqual([{ kind: 'worktree-busy', subject, outcome: 'refreshed' }]);
    expect(harness.attention.recorded).toHaveLength(2);
    for (const { body } of harness.attention.recorded) {
      expect(body.kind).toBe('worktree-busy');
      expect(body.subject).toEqual({ kind: 'worktree', ref: subject });
    }
  });

  it('clears the worktree-busy attention item when the worktree is no longer busy', async () => {
    const holder = { facts: removalFacts({ inProgressOperations: ['MERGE_HEAD'] }) };
    const workspace = makeWorkspace({ facts: () => holder.facts });
    const subject = subjectOfFixtureWorktree();
    // The open item the first pass raised is what the second pass sees.
    const attentionItems = [
      {
        kind: 'worktree-busy',
        subject: { kind: 'worktree', ref: subject },
        state: 'open',
        summary: 'Reaper report worktree-busy for worktree ' + subject,
      },
    ];
    const harness = gatherHarness({ workspace, attentionItems });
    await runPass(harness);
    holder.facts = removalFacts();
    await runPass(harness, { nowIso: LATER });
    expect(harness.attention.cleared).toHaveLength(1);
    expect(harness.attention.cleared[0]?.request).toMatchObject({
      action: 'resolve',
      projectId: PROJECT,
      kind: 'worktree-busy',
      subject: { kind: 'worktree', ref: subject },
      reason: 'stale',
    });
  });

  it('reports disk pressure on the second sighting and keeps the item open between the thresholds', async () => {
    const holder = { freeBytes: 100, totalBytes: 1000 }; // 10 %: below the 15 % minimum
    const workspace = makeWorkspace({ spaceAnswer: () => ({ outcome: 'read', freeBytes: holder.freeBytes, totalBytes: holder.totalBytes }) });
    const harness = gatherHarness({ workspace });
    const subject = subjectOfFixtureHost();
    const first = await runPass(harness, { policy: DISK_POLICY });
    expect(first.findings.find((entry) => entry.kind === 'disk-pressure')?.action).toBe('wait');
    const second = await runPass(harness, { nowIso: LATER, policy: DISK_POLICY });
    const finding = second.findings.find((entry) => entry.kind === 'disk-pressure');
    expect(finding).toMatchObject({ subject, action: 'report' });
    expect(second.attention.filter((entry) => entry.kind === 'disk-pressure')).toEqual([
      { kind: 'disk-pressure', subject, outcome: 'raised' },
    ]);
    expect(harness.attention.recorded.find((entry) => entry.body.kind === 'disk-pressure')?.body.subject).toEqual({ kind: 'host', ref: subject });
    // Between the thresholds: 17 % is above the 15 % min but below the 20 % clear.
    holder.freeBytes = 170;
    await runPass(harness, { nowIso: '2026-11-06T12:20:00.000Z', policy: DISK_POLICY });
    // The finding stays open and its item stays open: no close, no clear.
    expect((await harness.store.listOpenFindings()).some((record) => record.finding.kind === 'disk-pressure')).toBe(true);
    expect(harness.attention.cleared).toEqual([]);
  });

  it('closes the disk-pressure finding only above the clear threshold', async () => {
    const holder = { freeBytes: 100, totalBytes: 1000 };
    const workspace = makeWorkspace({ spaceAnswer: () => ({ outcome: 'read', freeBytes: holder.freeBytes, totalBytes: holder.totalBytes }) });
    const harness = gatherHarness({ workspace });
    const subject = subjectOfFixtureHost();
    await runPass(harness, { policy: DISK_POLICY });
    await runPass(harness, { nowIso: LATER, policy: DISK_POLICY });
    // At the clear threshold exactly (20 %): not strictly above, so it stays open.
    holder.freeBytes = 200;
    await runPass(harness, { nowIso: '2026-11-06T12:20:00.000Z', policy: DISK_POLICY });
    expect((await harness.store.listOpenFindings()).some((record) => record.finding.kind === 'disk-pressure')).toBe(true);
    expect(harness.attention.cleared).toEqual([]);
    // Above it (25 %): the finding closes and its attention item is cleared.
    holder.freeBytes = 250;
    await runPass(harness, { nowIso: '2026-11-06T12:30:00.000Z', policy: DISK_POLICY });
    expect((await harness.store.listOpenFindings()).some((record) => record.finding.kind === 'disk-pressure')).toBe(false);
    expect(harness.attention.cleared).toHaveLength(1);
    expect(harness.attention.cleared[0]?.request).toMatchObject({
      action: 'resolve',
      projectId: PROJECT,
      kind: 'disk-pressure',
      subject: { kind: 'host', ref: subject },
      reason: 'stale',
    });
  });

  it('keeps merged-worktree report-only unless the repair is explicitly opted in (D-R6)', async () => {
    const workspace = makeWorkspace();
    const harness = gatherHarness({ workspace });
    const policy = { graceMinutes: 5, repairs: { 'dead-attempt': true } as const };
    await runPass(harness, { policy });
    const second = await runPass(harness, { nowIso: LATER, policy });
    const finding = second.findings.find((entry) => entry.kind === 'merged-worktree');
    expect(finding?.action).toBe('report'); // D-R6: the absent flag stays report-only
    expect(second.repairs.filter((entry) => entry.kind === 'merged-worktree')).toEqual([]);
    expect(workspace.forbidden).toEqual([]);
    expect(harness.journal.state.appendCalls).toEqual([]);
  });

  it('leaves an open merged-worktree finding open when the worktree read failed', async () => {
    const subject = subjectOfFixtureWorktree();
    const store = new InMemoryReaperFindingRepositoryAdapter();
    await seedOpenFinding(store, subject, 'merged-worktree');
    const workspace = makeWorkspace({ throwInspect: true });
    const harness = gatherHarness({ workspace, store });
    const result = await runPass(harness, { policy: DISK_POLICY });
    expect(result.unknown).toContainEqual({ subject, kind: 'merged-worktree', reason: 'worktree-unreadable' });
    expect(result.findings.find((entry) => entry.kind === 'merged-worktree')).toBeUndefined();
    // A failed read never closes anything: the finding stays open.
    expect((await store.listOpenFindings())).toHaveLength(1);
  });

  it('refuses a null request, a missing field, a wrong-typed field, a sparse array, an unknown enum value and a throwing getter without throwing', async () => {
    // Request-level cases.
    const useCase = build(baseHarness());
    await expect(useCase.reapZombies(null as unknown as ReapZombiesRequest)).resolves.toMatchObject({ outcome: 'refused', reason: 'request-invalid' });
    await expect(useCase.reapZombies({ nowIso: NOW } as unknown as ReapZombiesRequest)).resolves.toMatchObject({ outcome: 'refused', reason: 'request-invalid' });
    await expect(useCase.reapZombies({ projectId: 42, nowIso: NOW } as unknown as ReapZombiesRequest)).resolves.toMatchObject({ outcome: 'refused', reason: 'request-invalid' });
    await expect(useCase.reapZombies({ projectId: PROJECT, nowIso: NOW, policy: { graceMinutes: 'x' } } as unknown as ReapZombiesRequest)).resolves.toMatchObject({ outcome: 'refused', reason: 'request-invalid' });
    // Worktree-level cases: the gathering skips malformed reads, never throws.
    const sparse: ListedWorktree[] = new Array(4);
    sparse[1] = listedWorktree(WT_PATH);
    sparse[2] = { ...listedWorktree(ROOT + '/wt-b'), branch: 42 as unknown as string }; // a branch that is a number
    sparse[3] = { ...listedWorktree(ROOT + '/wt-c'), path: 7 as unknown as string }; // a non-string path
    const workspace = makeWorkspace({ entries: sparse });
    const cloneWithThrowingGetter: Record<string, { readonly path: string; readonly worktreeRoot: string }> = {
      [HOST_NAME]: { path: CLONE, worktreeRoot: ROOT },
    };
    Object.defineProperty(cloneWithThrowingGetter, 'host-2', {
      enumerable: true,
      get() {
        throw new Error('clone getter exploded');
      },
    });
    const profiles = makeProfiles([profileView({ clones: cloneWithThrowingGetter })]);
    const harness = gatherHarness({ workspace, profiles });
    const result = await runPass(harness, { policy: DISK_POLICY });
    expect(result.outcome).toBe('completed');
    // The hole and the non-string path were skipped without throwing; the two
    // string paths (including the one whose listed branch is a number) were inspected.
    expect(workspace.requests.filter((entry) => entry.inspect !== undefined)).toHaveLength(2);
    // Both are first sightings: they wait, none reports or repairs.
    for (const finding of result.findings.filter((entry) => entry.kind === 'merged-worktree')) {
      expect(finding.action).toBe('wait');
    }
  });

  it('bounds every outbound read and leaves the rest of the pass to the next pass', async () => {
    // More than 64 subjects: the subjects past the cap are pass-cap unknowns and are not inspected.
    const many = Array.from({ length: 70 }, (_, index) => listedWorktree(`${ROOT}/wt-${index}`));
    const cappedWorkspace = makeWorkspace({ entries: many });
    const cappedHarness = gatherHarness({ workspace: cappedWorkspace });
    const cappedResult = await runPass(cappedHarness, { policy: DISK_POLICY });
    const capUnknowns = cappedResult.unknown.filter((entry) => entry.reason === 'pass-cap' && entry.kind === 'merged-worktree');
    expect(capUnknowns.length).toBe(70 - 64);
    expect(cappedResult.findings.length).toBeLessThanOrEqual(64);
    expect(cappedWorkspace.requests.filter((entry) => entry.inspect !== undefined)).toHaveLength(64);

    // More than 16 clones: only the first 16 are read.
    const cloneProfiles = [
      profileView({
        clones: Object.fromEntries(
          Array.from({ length: 20 }, (_, index) => [`host-${index}`, { path: `/srv/clone-${index}`, worktreeRoot: `/srv/clone-${index}/.worktrees` }]),
        ),
      }),
    ];
    const cloneWorkspace = makeWorkspace({ entries: [] });
    const cloneHarness = gatherHarness({ workspace: cloneWorkspace, profiles: makeProfiles(cloneProfiles) });
    await runPass(cloneHarness, { policy: DISK_POLICY });
    expect(cloneWorkspace.listWorktreesCount).toBe(16);

    // The forge read is bounded.
    const forgeHarness = gatherHarness();
    await runPass(forgeHarness, { policy: DISK_POLICY });
    for (const read of forgeHarness.forgeRead?.requests ?? []) {
      expect(read.timeoutMs).toBe(5000);
      expect(read.ref).toEqual({ kind: 'branch', branchName: 'fleet/merged-branch' });
    }
  });

  it('records a worktree finding once and reuses its id and its attention item across passes', async () => {
    const store = new InMemoryReaperFindingRepositoryAdapter();
    // Aged sighting: the pass sees the second sighting, so the finding reports
    // and its attention item is raised in the first pass, refreshed in the second.
    await seedOpenFinding(store, subjectOfFixtureWorktree(), 'merged-worktree');
    const harness = gatherHarness({ store });
    const first = await runPass(harness);
    const second = await runPass(harness, { nowIso: LATER });
    const firstId = first.findings.find((entry) => entry.kind === 'merged-worktree')?.findingId;
    const secondId = second.findings.find((entry) => entry.kind === 'merged-worktree')?.findingId;
    expect(firstId).toBeDefined();
    expect(secondId).toBe(firstId);
    expect(first.attention[0]?.outcome).toBe('raised');
    expect(second.attention[0]?.outcome).toBe('refreshed');
    // No second action: this lane performs no one-way intent, so nothing was journalled.
    expect(harness.journal.state.appendCalls).toEqual([]);
    expect(harness.journal.state.entries.size).toBe(0);
  });

  it('reports an unreadable read as unknown and never as empty, zero or a pass', async () => {
    const subject = subjectOfFixtureWorktree();
    const hostSubject = subjectOfFixtureHost();
    // A throwing list: the clone contributes nothing and no finding is built.
    const listHarness = gatherHarness({ workspace: makeWorkspace({ throwList: true }) });
    const listResult = await runPass(listHarness, { policy: DISK_POLICY });
    expect(listResult.unknown).toContainEqual({ subject: '', reason: 'worktree-list-unreadable' });
    expect(listResult.findings.find((entry) => entry.kind === 'merged-worktree')).toBeUndefined();
    expect(listResult.worktrees).toEqual([]);
    // A throwing inspection: the subject is an unknown, never a half-read finding.
    const inspectHarness = gatherHarness({ workspace: makeWorkspace({ throwInspect: true }) });
    const inspectResult = await runPass(inspectHarness, { policy: DISK_POLICY });
    expect(inspectResult.unknown).toContainEqual({ subject, kind: 'merged-worktree', reason: 'worktree-unreadable' });
    expect(inspectResult.findings.find((entry) => entry.kind === 'merged-worktree')).toBeUndefined();
    // A throwing disk read: the host is an unknown, never a zero reading.
    const diskHarness = gatherHarness({ workspace: makeWorkspace({ throwSpace: true }) });
    const diskResult = await runPass(diskHarness, { policy: DISK_POLICY });
    expect(diskResult.unknown).toContainEqual({ subject: hostSubject, kind: 'disk-pressure', reason: 'disk-unreadable' });
    expect(diskResult.findings.find((entry) => entry.kind === 'disk-pressure')).toBeUndefined();
    // A throwing forge read: the evidence stays unknown, never a finding.
    const forgeHarness = gatherHarness({ forgeRead: makeForgeRead(mergedPrSnapshot, true) });
    const forgeResult = await runPass(forgeHarness, { policy: DISK_POLICY });
    expect(forgeResult.unknown.some((entry) => entry.reason === 'forge-unreadable')).toBe(true);
    expect(forgeResult.findings.find((entry) => entry.kind === 'merged-worktree')).toBeUndefined();
  });

  it('echoes no path and no secret-shaped text in the result, the attention summary or the finding subject', async () => {
    const workspace = makeWorkspace({ facts: () => removalFacts({ inProgressOperations: ['MERGE_HEAD'] }) });
    const harness = gatherHarness({ workspace });
    const result = await runPass(harness, { policy: DISK_POLICY });
    const serialized = JSON.stringify(result);
    for (const forbidden of [WT_PATH, ROOT, CLONE]) {
      expect(serialized.includes(forbidden)).toBe(false);
    }
    for (const { body } of harness.attention.recorded) {
      const summary = String(body.summary);
      expect(summary.length).toBeLessThanOrEqual(1024);
      expect(summary.includes(WT_PATH)).toBe(false);
      expect(summary.includes('/')).toBe(false);
      expect(containsSecretShape(summary)).toBe(false);
    }
    for (const finding of result.findings) {
      expect(finding.subject).toMatch(/^[0-9a-f]{12}$/);
    }
  });

  it('calls only the read methods of the workspace port and never a removal, a hook or a fetch', async () => {
    const workspace = makeWorkspace();
    const harness = gatherHarness({ workspace });
    await runPass(harness, { policy: DISK_POLICY });
    for (const call of workspace.calls) {
      expect(['listWorktrees', 'inspectWorktreeForRemoval', 'readFilesystemSpace']).toContain(call);
    }
    expect(workspace.forbidden).toEqual([]);
    // The git reads never write, run hooks or reach the network: the fake only
    // ever answered the three read methods, in that fixed set.
    expect(new Set(workspace.calls)).toEqual(new Set(['listWorktrees', 'inspectWorktreeForRemoval', 'readFilesystemSpace']));
  });

  it('bounds the subjects, the unknowns and the summary length of one pass', async () => {
    const many = Array.from({ length: 70 }, (_, index) => listedWorktree(`${ROOT}/wt-${index}`));
    const workspace = makeWorkspace({ entries: many });
    const harness = gatherHarness({ workspace });
    const result = await runPass(harness, { policy: DISK_POLICY });
    // At most 64 subjects were inspected and classified.
    expect(result.findings.length).toBeLessThanOrEqual(64);
    // The bounded unknown reasons stay under the 64-item cap.
    for (const reason of new Set(result.unknown.map((entry) => entry.reason))) {
      expect(result.unknown.filter((entry) => entry.reason === reason).length).toBeLessThanOrEqual(64);
    }
    // At most 16 clones are read and every summary stays within the cap.
    expect(workspace.listWorktreesCount).toBe(1);
    for (const { body } of harness.attention.recorded) {
      expect(String(body.summary).length).toBeLessThanOrEqual(1024);
    }
  });

  it('writes no journal intent for a worktree subject, so there is no one-way action to replay', async () => {
    const harness = gatherHarness();
    await runPass(harness);
    await runPass(harness, { nowIso: LATER });
    expect(harness.journal.state.appendCalls).toEqual([]);
    expect(harness.journal.state.entries.size).toBe(0);
  });
  it('skips a retired profile even when the port returns it despite the active filter', async () => {
    const retiredClone = { path: '/srv/retired', worktreeRoot: '/srv/retired/.worktrees' };
    const workspace = makeWorkspace();
    const profiles = makeProfiles([
      profileView({ status: 'retired', clones: { 'host-retired': retiredClone } }),
    ]);
    const harness = gatherHarness({ workspace, profiles });
    await runPass(harness);
    expect(workspace.calls).toEqual([]);
  });

  it('records findings and attention under the request project and never scans another project clone', async () => {
    const workspace = makeWorkspace();
    const profiles = makeProfiles([
      profileView(),
      profileView({ projectId: 'proj-2', clones: { 'host-2': { path: '/srv/other', worktreeRoot: '/srv/other/.worktrees' } } }),
    ]);
    const harness = gatherHarness({ workspace, profiles });
    await runPass(harness);
    const roots = workspace.requests.flatMap((entry) => (entry.list === undefined ? [] : [entry.list.repositoryRoot]));
    expect(roots).toEqual([CLONE]);
    const spaces = workspace.requests.flatMap((entry) => (entry.space === undefined ? [] : [entry.space.path]));
    expect(spaces).toEqual([ROOT]);
  });

  it('measures every clone on a host and reports the worst filesystem', async () => {
    const second = { path: '/srv/clone2', worktreeRoot: '/srv/clone2/.worktrees' };
    const workspace = makeWorkspace({
      spaceAnswer: (req) => ({ outcome: 'read', freeBytes: req.path === second.worktreeRoot ? 100 : 200, totalBytes: 1000 }),
    });
    const profiles = makeProfiles([
      profileView({ clones: { [HOST_NAME]: { path: CLONE, worktreeRoot: ROOT } } }),
      profileView({ clones: { [HOST_NAME]: second } }),
    ]);
    const harness = gatherHarness({ workspace, profiles });
    await runPass(harness, { policy: DISK_POLICY });
    const result = await runPass(harness, { nowIso: LATER, policy: DISK_POLICY });
    const spaces = workspace.requests.flatMap((entry) => (entry.space === undefined ? [] : [entry.space.path]));
    expect(spaces).toContain(second.worktreeRoot);
    expect(result.findings.find((entry) => entry.kind === 'disk-pressure')).toMatchObject({ subject: subjectOfFixtureHost(), action: 'report' });
  });

  it('uses the default clear threshold of 20 without reporting it as unordered', async () => {
    const subject = subjectOfFixtureHost();
    const store = new InMemoryReaperFindingRepositoryAdapter();
    await seedOpenFinding(store, subject, 'disk-pressure');
    const workspace = makeWorkspace({ spaceAnswer: () => ({ outcome: 'read', freeBytes: 250, totalBytes: 1000 }) });
    const harness = gatherHarness({ workspace, store });
    const result = await runPass(harness, { policy: { graceMinutes: 5, minFreePercent: 15 } });
    expect(result.unknown.some((entry) => entry.reason === 'disk-thresholds-unordered')).toBe(false);
    expect((await store.listOpenFindings()).some((record) => record.finding.kind === 'disk-pressure')).toBe(false);
  });
  it('leaves a host disk status unknown when one of its clones cannot be read', async () => {
    const subject = subjectOfFixtureHost();
    const second = { path: '/srv/clone2', worktreeRoot: '/srv/clone2/.worktrees' };
    const store = new InMemoryReaperFindingRepositoryAdapter();
    await seedOpenFinding(store, subject, 'disk-pressure');
    const workspace = makeWorkspace({
      spaceAnswer: (req) => (req.path === second.worktreeRoot
        ? ({ outcome: 'unknown', reason: 'read-failed' } as unknown as ReadFilesystemSpaceResult)
        : { outcome: 'read', freeBytes: 100, totalBytes: 1000 }),
    });
    const profiles = makeProfiles([
      profileView({ clones: { [HOST_NAME]: { path: CLONE, worktreeRoot: ROOT } } }),
      profileView({ clones: { [HOST_NAME]: second } }),
    ]);
    const harness = gatherHarness({ workspace, profiles, store });
    const result = await runPass(harness, { policy: DISK_POLICY });
    expect(result.unknown).toContainEqual({ subject, kind: 'disk-pressure', reason: 'disk-unreadable' });
    expect(result.findings.some((entry) => entry.kind === 'disk-pressure')).toBe(false);
    expect((await store.listOpenFindings()).some((record) => record.finding.kind === 'disk-pressure')).toBe(true);
    expect(harness.attention.cleared).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// KW4b': the merged-worktree repair — hold, re-read, caps, pass budget, F129.
// ---------------------------------------------------------------------------

describe('reap zombies KW4b merged-worktree repair', () => {
  const MERGED_POLICY = { graceMinutes: 5, repairs: { 'merged-worktree': true } as const };
  const MANIFEST_SHA = 'a'.repeat(64);

  function sealedCollectedAttempt(id: string): AttemptRecord {
    return attemptFixture(id, {
      worktreePath: WT_PATH,
      state: 'collected',
      sessionId: null,
      artifacts: {
        headCommit: COMMIT,
        commitsSinceBase: [],
        collectedArtifactPaths: [],
        notes: 'present',
        manifestPath: `.lane/artifacts-manifest-${MANIFEST_SHA.slice(0, 16)}.json`,
        manifestSha256: MANIFEST_SHA,
      },
    });
  }

  function mergedIntentMintedId(findingId: string, subject: string, targetPath = WT_PATH): string {
    return `${findingId}:${testDigest(
      ['merged-worktree-v1', PROJECT, findingId, subject, HOST_NAME, CLONE, ROOT, targetPath].join('\u0000'),
    )}`;
  }

  function makeReserve(events: string[]): ExecutionJournalPort['reserveCapacityAtomically'] {
    return async (request) => {
      events.push('hold');
      return { outcome: 'reserved', reservation: request.record as CapacityReservationRecord };
    };
  }

  function makeRelease(events: string[], holdAttemptIds: string[] = []): ExecutionJournalPort['releaseCapacityReservation'] {
    return async (attemptId) => {
      events.push('release:' + attemptId);
      holdAttemptIds.push(attemptId);
      return true;
    };
  }

  it('repairs an opted-in merged-worktree under a hold with an F129 intent and the sealed manifest', async () => {
    const store = new InMemoryReaperFindingRepositoryAdapter();
    const subject = subjectOfFixtureWorktree();
    const seeded = await seedOpenFinding(store, subject, 'merged-worktree');

    const events: string[] = [];
    const releasedHolds: string[] = [];
    const workspace = makeWorkspace({
      removeAnswer: () => {
        events.push('remove');
        return { outcome: 'removed', branchTip: COMMIT };
      },
    });
    const originalInspect = workspace.inspectWorktreeForRemoval!.bind(workspace);
    workspace.inspectWorktreeForRemoval = async (request: InspectWorktreeForRemovalRequest) => {
      events.push('inspect');
      return originalInspect(request);
    };

    const shared = {
      store,
      journal: makeJournal(),
      reconcile: makeReconcile(),
      runner: makeRunner(),
      attention: { recorded: [], cleared: [] } as AttentionState,
      attempts: [sealedCollectedAttempt('att-1')],
      reserveCapacity: makeReserve(events),
      releaseCapacity: makeRelease(events, releasedHolds),
      computeDigest: testDigest,
    };
    const first = await runPass(
      gatherHarness({ ...shared, workspace, attentionPort: makeAttention(shared.attention) }),
      { policy: MERGED_POLICY },
    );

    const repair = first.repairs.find((entry) => entry.kind === 'merged-worktree');
    expect(repair).toMatchObject({
      key: `reaper/${subject}/merged-worktree@${seeded.findingId}`,
      outcome: 'completed',
    });
    expect(first.findings.find((entry) => entry.kind === 'merged-worktree')?.action).toBe('repair');

    const appends = shared.journal.state.appendCalls;
    expect(appends.map((entry) => entry.kind)).toEqual(['intent', 'result']);
    expect(appends[0]?.key).toBe(`reaper/${subject}/merged-worktree@${seeded.findingId}`);
    expect(appends[0]?.mintedId).toBe(mergedIntentMintedId(seeded.findingId, subject));
    expect(appends[1]?.outcome).toBe('completed');

    // The hold is acquired before the re-read; the removal runs under the hold
    // and the hold is released after it.
    expect(events.indexOf('hold')).toBeGreaterThan(-1);
    expect(events.indexOf('hold')).toBeLessThan(events.lastIndexOf('inspect'));
    expect(events.indexOf('remove')).toBeGreaterThan(events.indexOf('hold'));
    expect(events.some((entry) => entry === 'release:reaper-' + seeded.findingId)).toBe(true);
    expect(releasedHolds).toContain('reaper-' + seeded.findingId);

    const removeCalls = workspace.requests.flatMap((entry) => (entry.remove === undefined ? [] : [entry.remove]));
    expect(removeCalls).toHaveLength(1);
    expect(removeCalls[0]).toMatchObject({
      repositoryRoot: CLONE,
      worktreeRoot: ROOT,
      worktreePath: WT_PATH,
      expectedHead: COMMIT,
      expectedBranch: 'fleet/merged-branch',
      expectedLastActivityIso: OLD,
      manifest: {
        kind: 'sealed',
        attemptId: 'att-1',
        manifestPath: `.lane/artifacts-manifest-${MANIFEST_SHA.slice(0, 16)}.json`,
        expectedManifestSha256: MANIFEST_SHA,
      },
    });
  });

  it('closes the repaired merged-worktree finding and clears its attention once the worktree is gone', async () => {
    const store = new InMemoryReaperFindingRepositoryAdapter();
    const subject = subjectOfFixtureWorktree();
    await seedOpenFinding(store, subject, 'merged-worktree');

    const events: string[] = [];
    const attention: AttentionState = { recorded: [], cleared: [] };
    const journal = makeJournal();
    const workspace = makeWorkspace({
      removeAnswer: () => {
        events.push('remove');
        return { outcome: 'removed', branchTip: COMMIT };
      },
    });
    const shared = {
      store,
      journal,
      reconcile: makeReconcile(),
      runner: makeRunner(),
      attention,
      attempts: [sealedCollectedAttempt('att-1')],
      reserveCapacity: makeReserve(events),
      releaseCapacity: makeRelease(events),
      computeDigest: testDigest,
    };

    const pass1 = await runPass(
      gatherHarness({ ...shared, workspace, attentionPort: makeAttention(attention) }),
      { policy: MERGED_POLICY },
    );
    expect(pass1.repairs.find((entry) => entry.kind === 'merged-worktree')?.outcome).toBe('completed');

    const pass2 = await runPass(
      gatherHarness({ ...shared, workspace, attentionPort: makeAttention(attention) }),
      { nowIso: LATER, policy: MERGED_POLICY },
    );
    expect(pass2.repairs.find((entry) => entry.kind === 'merged-worktree')).toMatchObject({
      outcome: 'skipped',
      reasonCode: 'already-repaired',
    });

    // Third pass: the worktree is gone from the list, so the unseen finding
    // closes and its attention item clears.
    const attentionItems = [{ kind: 'merged-worktree', subject: { kind: 'worktree', ref: subject }, state: 'open' }];
    const pass3 = await runPass(
      gatherHarness({
        ...shared,
        workspace: makeWorkspace({ entries: [] }),
        attentionPort: makeAttention(attention, attentionItems),
      }),
      { nowIso: '2026-11-06T12:30:00.000Z', policy: MERGED_POLICY },
    );
    expect(pass3.outcome).toBe('completed');
    expect(await store.listOpenFindings()).toHaveLength(0);
    expect(attention.cleared.some((entry) => entry.request.kind === 'merged-worktree')).toBe(true);
  });

  it('re-reads under the hold and skips when a fact turned false (recheck-ineligible)', async () => {
    const store = new InMemoryReaperFindingRepositoryAdapter();
    const subject = subjectOfFixtureWorktree();
    await seedOpenFinding(store, subject, 'merged-worktree');

    const events: string[] = [];
    let inspectCount = 0;
    const workspace = makeWorkspace({
      facts: () => {
        inspectCount += 1;
        return inspectCount <= 1
          ? removalFacts()
          : removalFacts({ status: { tracked: 1, untracked: 0, unmerged: 0 } });
      },
    });
    const shared = {
      store,
      journal: makeJournal(),
      reconcile: makeReconcile(),
      runner: makeRunner(),
      attention: { recorded: [], cleared: [] } as AttentionState,
      attempts: [sealedCollectedAttempt('att-1')],
      reserveCapacity: makeReserve(events),
      releaseCapacity: makeRelease(events),
      computeDigest: testDigest,
    };
    const result = await runPass(
      gatherHarness({ ...shared, workspace, attentionPort: makeAttention(shared.attention) }),
      { policy: MERGED_POLICY },
    );
    const repair = result.repairs.find((entry) => entry.kind === 'merged-worktree');
    expect(repair).toMatchObject({ outcome: 'skipped', reasonCode: 'recheck-ineligible' });
    expect(shared.journal.state.appendCalls).toEqual([]);
    expect(events.filter((entry) => entry === 'hold')).toHaveLength(1);
    expect(events.some((entry) => entry.startsWith('release:'))).toBe(true);
    expect(events.includes('remove')).toBe(false);
    expect((await store.listOpenFindings()).some((record) => record.finding.kind === 'merged-worktree')).toBe(true);
  });

  it('skips the merged-worktree repair when the conductor is halted or the marker is unreadable', async () => {
    for (const [state, reason] of [
      ['halted', 'conductor-halted'],
      ['unreadable', 'halt-unreadable'],
    ] as const) {
      const store = new InMemoryReaperFindingRepositoryAdapter();
      const subject = subjectOfFixtureWorktree();
      await seedOpenFinding(store, subject, 'merged-worktree');
      const events: string[] = [];
      const workspace = makeWorkspace({ removeAnswer: () => ({ outcome: 'removed', branchTip: COMMIT }) });
      const harness = gatherHarness({
        store,
        attempts: [sealedCollectedAttempt('att-1')],
        workspace,
        halt: {
          read: async (): Promise<ConductorHaltState> =>
            state === 'halted'
              ? { state: 'halted', record: { version: 1, halted: true, changedAtIso: BEFORE } }
              : { state: 'unreadable' },
        },
        reserveCapacity: makeReserve(events),
        releaseCapacity: makeRelease(events),
      });
      const result = await runPass(harness, { policy: MERGED_POLICY });
      const repair = result.repairs.find((entry) => entry.kind === 'merged-worktree');
      expect(repair).toMatchObject({ outcome: 'skipped', reasonCode: reason });
      expect(events).toEqual([]);
      expect(harness.journal.state.appendCalls).toEqual([]);
      expect(result.unknown.some((entry) => entry.reason === 'halt-unreadable')).toBe(state === 'unreadable');
    }
  });

  it('a reaper hold with no attempt record blocks concurrent ReserveExecutionCapacity on both request paths, and the reaper skips a busy worktree', async () => {
    const holdReservation = (attemptId: string, worktreePath = WT_PATH): CapacityReservationRecord => ({
      id: 'res-hold',
      attemptId,
      hostId: 'host-1',
      slotIndex: 0,
      held: true,
      seatTool: null,
      hostName: HOST_NAME,
      worktreePath,
      reservedAtIso: BEFORE,
      releasedAtIso: null,
    });
    const makeReserveJournal = (held: readonly CapacityReservationRecord[]): ExecutionJournalPort => ({
      reserveCapacityAtomically: async (request: ReserveCapacityAtomicallyRequest) => {
        if (request.selectRecord !== undefined) {
          const selected = await request.selectRecord(held);
          if (selected.outcome !== 'selected') {
            return { outcome: 'no-capacity' };
          }
        }
        const verdict = await request.checkBusyWorktree?.(held);
        if (verdict !== undefined && verdict.outcome === 'busy-worktree') {
          return { outcome: 'busy-worktree', blockingAttemptId: verdict.blockingAttemptId };
        }
        return { outcome: 'refused', reason: 'unexpected' };
      },
    } as unknown as ExecutionJournalPort);
    const attemptRepo = makeAttemptRepo([]); // the hold has no attempt record

    // Non-candidates path: the hold's own worktree path blocks.
    const nonCandidates = await new ReserveExecutionCapacityUseCase({
      journal: makeReserveJournal([holdReservation('reaper-f1')]),
      attemptRepo,
    }).reserveExecutionCapacity({
      reservationId: 'res-x',
      attemptId: 'attempt-x',
      workOrderId: 'wo-a',
      seatTool: 'opencode',
      hostId: 'host-1',
      worktreePath: WT_PATH,
      maxSlots: 64,
    });
    expect(nonCandidates).toEqual({ outcome: 'busy-worktree', blockingAttemptId: 'reaper-f1' });

    // Candidates path: the selected host's derived path matches the hold's path.
    const derivedPathFor = (attemptId: string): string => `${ROOT}/${testDigest(attemptId).slice(0, 32)}`;
    const candidates = await new ReserveExecutionCapacityUseCase({
      journal: makeReserveJournal([holdReservation('reaper-f2', derivedPathFor('attempt-y'))]),
      attemptRepo,
      computeDigest: testDigest,
    }).reserveExecutionCapacity({
      reservationId: 'res-y',
      attemptId: 'attempt-y',
      workOrderId: 'wo-a',
      seatTool: 'opencode',
      candidateHosts: [
        {
          name: HOST_NAME,
          kind: 'opencode',
          transport: 'local',
          sshAlias: null,
          port: null,
          maxLanes: 2,
          worktreeRoot: ROOT,
        },
      ],
    });
    expect(candidates).toEqual({ outcome: 'busy-worktree', blockingAttemptId: 'reaper-f2' });

    // The reaper itself skips when an attempt reservation already holds the path.
    const store = new InMemoryReaperFindingRepositoryAdapter();
    const subject = subjectOfFixtureWorktree();
    await seedOpenFinding(store, subject, 'merged-worktree');
    const events: string[] = [];
    const busyReserve: ExecutionJournalPort['reserveCapacityAtomically'] = async () => {
      events.push('hold');
      return { outcome: 'busy-worktree', blockingAttemptId: 'attempt-other' };
    };
    const harness = gatherHarness({
      store,
      attempts: [sealedCollectedAttempt('att-1')],
      reserveCapacity: busyReserve,
      releaseCapacity: makeRelease([]),
    });
    const result = await runPass(harness, { policy: MERGED_POLICY });
    const repair = result.repairs.find((entry) => entry.kind === 'merged-worktree');
    expect(repair).toMatchObject({ outcome: 'skipped', reasonCode: 'worktree-busy' });
    expect(events).toEqual(['hold']);
    expect(harness.journal.state.appendCalls).toEqual([]);
  });

  it('refuses malformed runtime inputs, policy caps/budgets, unknown repair flags, sparse arrays and throwing getters without throwing', async () => {
    const harness = baseHarness();
    for (const policy of [
      { maxRemovalsPerPass: -1 },
      { maxRemovalsPerPass: 65 },
      { passBudgetSeconds: 0 },
      { passBudgetSeconds: -5 },
      { passBudgetSeconds: 3601 },
      { maxRemovalsPerPass: 'x' },
      { repairs: { 'not-a-kind': true } },
      { unknownKey: 1 },
    ]) {
      const result = await runPass(harness, { policy: policy as never });
      expect(result).toMatchObject({ outcome: 'refused', reason: 'request-invalid' });
    }
    const ok = await runPass(harness, { policy: { maxRemovalsPerPass: 10, passBudgetSeconds: 120 } });
    expect(ok.outcome).toBe('completed');

    const sparse: ListedWorktree[] = new Array(3);
    sparse[1] = listedWorktree(WT_PATH);
    const sparseResult = await runPass(gatherHarness({ workspace: makeWorkspace({ entries: sparse }) }), {
      policy: DISK_POLICY,
    });
    expect(sparseResult.outcome).toBe('completed');

    const hostilePolicy: Record<string, unknown> = {};
    Object.defineProperty(hostilePolicy, 'passBudgetSeconds', {
      enumerable: true,
      get() {
        throw new Error('boom');
      },
    });
    const hostile = await runPass(harness, { policy: hostilePolicy as never });
    expect(hostile).toMatchObject({ outcome: 'refused', reason: 'request-invalid' });
  });

  it('guards every outbound call with the pass budget and leaves unvisited or timed-out worktrees for the next pass', async () => {
    let wallTime = 0;
    const profiles: ReaperProjectProfilesPort = {
      listProjectProfiles: async (): Promise<{ readonly outcome: 'listed'; readonly profiles: readonly ReaperProjectProfileView[] }> => {
        wallTime = 10 ** 9;
        return { outcome: 'listed', profiles: [profileView()] };
      },
    };
    const harness = gatherHarness({
      profiles,
      clockMs: () => wallTime,
      storeCallTimeoutMs: 15_000,
    });
    const result = await runPass(harness, { policy: MERGED_POLICY });
    expect(result.outcome).toBe('completed');
    expect(result.unknown.some((entry) => entry.reason === 'pass-budget')).toBe(true);
    expect(result.findings.filter((entry) => entry.kind === 'merged-worktree')).toEqual([]);
    expect(result.worktrees).toEqual([]);
  });

  it('recovers a crashed merged-worktree intent by releasing the reaper hold and reconciling read-only without removing twice', async () => {
    const store = new InMemoryReaperFindingRepositoryAdapter();
    const subject = subjectOfFixtureWorktree();
    const seeded = await seedOpenFinding(store, subject, 'merged-worktree');
    const key = `reaper/${subject}/merged-worktree@${seeded.findingId}`;
    const intent: LaneRunJournalEntryRecord = {
      version: 1,
      entryId: newId(),
      kind: 'intent',
      key,
      runId: null,
      recordedAtIso: BEFORE,
      mode: null,
      expectedRevision: null,
      mintedId: mergedIntentMintedId(seeded.findingId, subject),
      outcome: null,
      reasonCode: null,
      detail: null,
      grantId: null,
      state: null,
    };
    const events: string[] = [];
    const releasedHolds: string[] = [];
    const workspace = makeWorkspace({ removeAnswer: () => ({ outcome: 'removed', branchTip: COMMIT }) });
    const harness = gatherHarness({
      store,
      journal: makeJournal([intent]),
      attempts: [sealedCollectedAttempt('att-1')],
      workspace,
      reserveCapacity: makeReserve(events),
      releaseCapacity: makeRelease(events, releasedHolds),
    });
    const result = await runPass(harness, { policy: MERGED_POLICY });
    const repair = result.repairs.find((entry) => entry.kind === 'merged-worktree');
    expect(repair).toMatchObject({ outcome: 'reconciled', reasonCode: 'not-removed' });
    expect(workspace.requests.some((entry) => entry.remove !== undefined)).toBe(false);
    expect(releasedHolds).toEqual(['reaper-' + seeded.findingId]);
    const appends = harness.journal.state.appendCalls;
    expect(appends.map((entry) => entry.kind)).toEqual(['result']);
    expect(appends[0]).toMatchObject({ key, outcome: 'reconciled', reasonCode: 'not-removed' });
  });

  it('reconciles a crashed merged-worktree intent read-only when the worktree is no longer linked', async () => {
    const store = new InMemoryReaperFindingRepositoryAdapter();
    const subject = subjectOfFixtureWorktree();
    const seeded = await seedOpenFinding(store, subject, 'merged-worktree');
    const key = `reaper/${subject}/merged-worktree@${seeded.findingId}`;
    const intent: LaneRunJournalEntryRecord = {
      version: 1,
      entryId: newId(),
      kind: 'intent',
      key,
      runId: null,
      recordedAtIso: BEFORE,
      mode: null,
      expectedRevision: null,
      mintedId: mergedIntentMintedId(seeded.findingId, subject),
      outcome: null,
      reasonCode: null,
      detail: null,
      grantId: null,
      state: null,
    };
    const events: string[] = [];
    let inspectCount = 0;
    const workspace = makeWorkspace({
      inspectAnswer: () => {
        inspectCount += 1;
        return inspectCount <= 1
          ? { outcome: 'inspected', facts: removalFacts() }
          : { outcome: 'refused', reason: 'not-a-linked-worktree' };
      },
    });
    const harness = gatherHarness({
      store,
      journal: makeJournal([intent]),
      attempts: [sealedCollectedAttempt('att-1')],
      workspace,
      reserveCapacity: makeReserve(events),
      releaseCapacity: makeRelease(events),
    });
    const result = await runPass(harness, { policy: MERGED_POLICY });
    const repair = result.repairs.find((entry) => entry.kind === 'merged-worktree');
    expect(repair).toMatchObject({ outcome: 'reconciled' });
    expect(repair?.reasonCode).toBeUndefined();
    expect(harness.journal.state.appendCalls.map((entry) => entry.kind)).toEqual(['result']);
  });

  it('treats thrown or unreadable re-reads under the hold as unknown, skips removal and keeps open findings', async () => {
    const store = new InMemoryReaperFindingRepositoryAdapter();
    const subject = subjectOfFixtureWorktree();
    await seedOpenFinding(store, subject, 'merged-worktree');
    const attempts = [sealedCollectedAttempt('att-1')];
    let listCalls = 0;
    const attemptRepo: AttemptRepositoryPort = {
      saveAttempt: () => Promise.resolve(),
      findAttemptById: () => Promise.resolve(null),
      listAttemptsByWorkOrder: () => Promise.resolve([]),
      listAllAttempts: () => {
        listCalls += 1;
        return listCalls === 1 ? Promise.resolve(attempts) : Promise.reject(new Error('boom'));
      },
    };
    const events: string[] = [];
    const workspace = makeWorkspace({ removeAnswer: () => ({ outcome: 'removed', branchTip: COMMIT }) });
    const harness = gatherHarness({
      store,
      attemptRepo,
      workspace,
      reserveCapacity: makeReserve(events),
      releaseCapacity: makeRelease(events),
    });
    const result = await runPass(harness, { policy: MERGED_POLICY });
    const repair = result.repairs.find((entry) => entry.kind === 'merged-worktree');
    expect(repair).toMatchObject({ outcome: 'skipped', reasonCode: 'recheck-unknown' });
    expect(events.includes('remove')).toBe(false);
    expect(events.some((entry) => entry.startsWith('release:'))).toBe(true);
    expect(harness.journal.state.appendCalls).toEqual([]);
    expect((await store.listOpenFindings()).some((record) => record.finding.kind === 'merged-worktree')).toBe(true);
  });

  it('refuses replay of a pending merged-worktree intent when the request digest mismatches before writing anything (F129)', async () => {
    const store = new InMemoryReaperFindingRepositoryAdapter();
    const subject = subjectOfFixtureWorktree();
    const seeded = await seedOpenFinding(store, subject, 'merged-worktree');
    const key = `reaper/${subject}/merged-worktree@${seeded.findingId}`;
    const intent: LaneRunJournalEntryRecord = {
      version: 1,
      entryId: newId(),
      kind: 'intent',
      key,
      runId: null,
      recordedAtIso: BEFORE,
      mode: null,
      expectedRevision: null,
      mintedId: `${seeded.findingId}:${'b'.repeat(64)}`, // a different digest
      outcome: null,
      reasonCode: null,
      detail: null,
      grantId: null,
      state: null,
    };
    const events: string[] = [];
    const workspace = makeWorkspace({ removeAnswer: () => ({ outcome: 'removed', branchTip: COMMIT }) });
    const harness = gatherHarness({
      store,
      journal: makeJournal([intent]),
      attempts: [sealedCollectedAttempt('att-1')],
      workspace,
      reserveCapacity: makeReserve(events),
      releaseCapacity: makeRelease(events),
    });
    const result = await runPass(harness, { policy: MERGED_POLICY });
    const repair = result.repairs.find((entry) => entry.kind === 'merged-worktree');
    expect(repair).toMatchObject({ outcome: 'refused', reasonCode: 'intent-digest-mismatch' });
    expect(events).toEqual([]); // no hold, no release, no removal
    expect(harness.journal.state.appendCalls).toEqual([]);
    expect(result.unknown.some((entry) => entry.reason === 'intent-digest-mismatch')).toBe(true);
    expect((await store.listOpenFindings()).some((record) => record.finding.kind === 'merged-worktree')).toBe(true);
  });

  it('caps merged-worktree removals at maxRemovalsPerPass oldest-first and bounds unknown and summary sizes', async () => {
    const store = new InMemoryReaperFindingRepositoryAdapter();
    const wtOld = `${ROOT}/wt-old`;
    const wtMid = `${ROOT}/wt-mid`;
    const wtNew = `${ROOT}/wt-new`;
    const subjectOld = testDigest(`${HOST_NAME}\u0000${PROJECT}\u0000${CLONE}\u0000${wtOld}`);
    const subjectMid = testDigest(`${HOST_NAME}\u0000${PROJECT}\u0000${CLONE}\u0000${wtMid}`);
    const subjectNew = testDigest(`${HOST_NAME}\u0000${PROJECT}\u0000${CLONE}\u0000${wtNew}`);
    for (const subject of [subjectOld, subjectMid, subjectNew]) {
      await seedOpenFinding(store, subject, 'merged-worktree');
    }
    const workspace = makeWorkspace({
      entries: [listedWorktree(wtOld), listedWorktree(wtMid), listedWorktree(wtNew)],
      removeAnswer: () => ({ outcome: 'removed', branchTip: COMMIT }),
    });
    workspace.inspectWorktreeForRemoval = async (request) => {
      const last =
        request.worktreePath === wtOld
          ? '2026-11-03T12:00:00.000Z'
          : request.worktreePath === wtMid
            ? '2026-11-04T12:00:00.000Z'
            : '2026-11-05T12:00:00.000Z';
      return {
        outcome: 'inspected',
        facts: removalFacts({
          path: request.worktreePath,
          branch: 'fleet/' + request.worktreePath.split('/').pop(),
          lastActivity: { iso: last, unknown: false },
        }),
      };
    };
    const events: string[] = [];
    const harness = gatherHarness({
      store,
      attempts: [sealedCollectedAttempt('att-1')],
      workspace,
      reserveCapacity: makeReserve(events),
      releaseCapacity: makeRelease(events),
    });
    const result = await runPass(harness, { policy: { graceMinutes: 5, repairs: { 'merged-worktree': true }, maxRemovalsPerPass: 2 } });
    const repairs = result.repairs.filter((entry) => entry.kind === 'merged-worktree');
    // Oldest two enter the repair (they are not removal-cap-skipped); the
    // newest is skipped by the per-pass cap.
    expect(repairs).toHaveLength(3);
    expect(repairs[0]?.subject).toBe(subjectOld);
    expect(repairs[1]?.subject).toBe(subjectMid);
    expect(repairs[0]?.reasonCode).not.toBe('removal-cap');
    expect(repairs[1]?.reasonCode).not.toBe('removal-cap');
    expect(repairs[2]).toMatchObject({ subject: subjectNew, outcome: 'skipped', reasonCode: 'removal-cap' });
    for (const unknown of result.unknown) {
      expect(unknown.reason.length).toBeLessThanOrEqual(64);
    }
  });

  it('echoes no filesystem path, branch name or secret-shaped text in results, journal entries or attention items', async () => {
    const store = new InMemoryReaperFindingRepositoryAdapter();
    const subject = subjectOfFixtureWorktree();
    await seedOpenFinding(store, subject, 'merged-worktree');
    const events: string[] = [];
    const attention: AttentionState = { recorded: [], cleared: [] };
    const workspace = makeWorkspace({ removeAnswer: () => ({ outcome: 'removed', branchTip: COMMIT }) });
    const harness = gatherHarness({
      store,
      attempts: [sealedCollectedAttempt('att-1')],
      workspace,
      reserveCapacity: makeReserve(events),
      releaseCapacity: makeRelease(events),
      attentionPort: makeAttention(attention),
    });
    const result = await runPass(harness, { policy: MERGED_POLICY });
    for (const forbidden of [WT_PATH, ROOT, CLONE, 'fleet/merged-branch']) {
      expect(JSON.stringify(result).includes(forbidden)).toBe(false);
    }
    for (const entry of harness.journal.state.appendCalls) {
      const text = JSON.stringify(entry);
      for (const forbidden of [WT_PATH, ROOT, CLONE, 'fleet/merged-branch']) {
        expect(text.includes(forbidden)).toBe(false);
      }
    }
    for (const { body } of attention.recorded) {
      const summary = String(body.summary);
      expect(summary.includes('/')).toBe(false);
      expect(containsSecretShape(summary)).toBe(false);
      expect(summary.length).toBeLessThanOrEqual(1024);
    }
  });
});
