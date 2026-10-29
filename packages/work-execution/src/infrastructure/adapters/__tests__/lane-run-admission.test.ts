/**
 * Unit tests for K7-5b: `LaneRunAdmissionAdapter` — `reserveFirst` (the
 * global cap and package-busy checks first, then the reserve chooses host
 * and worktree path) and `admit` (a later attempt of a run, pinned to the
 * run's own host and worktree, with the fail-closed `worktree-mismatch`
 * guard), plus the pure `laneRunPackageKeys`. Every store is in-memory; a
 * recording `ReserveExecutionCapacityPort` fake; no runner, no subprocess,
 * no network.
 */

import { describe, expect, it, vi } from 'vitest';

import type { AttemptRecord, CapacityReservationRecord, WorkOrderRecord } from '../../../domain/execution-records.js';
import type { LaneRunRecord } from '../../../domain/lane-run-records.js';
import { laneRunConductEntry } from '../../../domain/lane-run-step-facts.js';
import { laneRunPackageKeys, laneRunPackagesOverlap } from '../../../domain/lane-run-packages.js';
import type { ReserveExecutionCapacityCandidateHost, ReserveExecutionCapacityPort, ReserveExecutionCapacityRequest, ReserveExecutionCapacityResult } from '../../../application/ports/in/ReserveExecutionCapacityPort.in-port.js';
import type { LaneRunAdmissionRequest } from '../../../application/ports/out/LaneRunAdmissionPort.out-port.js';
import { LaneRunAdmissionAdapter } from '../LaneRunAdmissionAdapter.adapter.js';
import { ExecutionJournalAdapter } from '../ExecutionJournalAdapter.adapter.js';
import { LaneRunJournalAdapter } from '../LaneRunJournalAdapter.adapter.js';
import { LaneRunRepositoryAdapter } from '../LaneRunRepositoryAdapter.adapter.js';

const NOW = '2026-10-27T10:00:00.000Z';
const COMMIT = 'a'.repeat(40);
const WORKTREE_ROOT = '/tmp/fleet-example/wt';
const WORKTREE_PATH = WORKTREE_ROOT + '/example0000000000000000000000000001';
const HOST_NAME = 'lane-example';
const RUN_A_ID = 'run-01JB0000000000000000000000';
const RUN_B_ID = 'run-01JB0000000000000000000001';

const CANDIDATE_HOSTS = [
  {
    name: HOST_NAME,
    kind: 'opencode' as const,
    transport: 'local' as const,
    sshAlias: null,
    port: null,
    maxLanes: 1,
    worktreeRoot: WORKTREE_ROOT,
  },
];

/** An ssh lane-runner host that declares no `runner.authFile` (KF-14b). */
const SSH_NO_AUTH_HOST = {
  name: 'lane-ssh-no-auth',
  kind: 'opencode' as const,
  transport: 'ssh' as const,
  sshAlias: 'lane-ssh',
  port: 46000,
  maxLanes: 1,
  worktreeRoot: WORKTREE_ROOT,
  reviewRoute: 'no-auth-file' as const,
};

function workOrderFixture(overrides: Partial<WorkOrderRecord> = {}): WorkOrderRecord {
  return {
    id: 'wo-example-1',
    projectId: 'project-example-1',
    taskId: 'task-example-1',
    laneId: 'lane-example-1',
    repository: 'repo-example-1',
    baseCommit: COMMIT,
    ownedPaths: ['packages/example/src'],
    policyRevision: 'policy-example-1',
    prerequisiteWorkOrderIds: [],
    state: 'approved',
    revision: 1,
    createdAtIso: NOW,
    updatedAtIso: NOW,
    ...overrides,
  };
}

function runRecord(runId: string, attemptIds: readonly string[], workOrderId = 'wo-example-1'): LaneRunRecord {
  return {
    version: 1,
    runId,
    workOrderId,
    tier: 2,
    seatPlanRef: 'c'.repeat(64),
    cursors: { 'first-pass': null, fix: null, review: null },
    round: 0,
    attemptIds: [...attemptIds],
    prNumber: null,
    parked: null,
    parkCount: 0,
    lease: null,
    revision: 1,
    runPolicyRevision: 'policy-example-1',
  };
}

function attemptFixture(attemptId: string, overrides: Partial<AttemptRecord> = {}): AttemptRecord {
  return {
    id: attemptId,
    workOrderId: 'wo-example-1',
    kind: 'initial',
    fixNumber: 0,
    priorAttemptId: null,
    worktreePath: WORKTREE_PATH,
    baseCommit: COMMIT,
    state: 'intent-recorded',
    outcome: null,
    briefDigest: 'b'.repeat(64),
    briefPackagePath: WORKTREE_PATH + '/.lane/brief.md',
    sessionId: null,
    completionReceipt: null,
    artifacts: null,
    runner: {
      kind: 'opencode',
      remotePort: null,
      host: null,
      hostName: HOST_NAME,
      agent: null,
      model: null,
      variant: null,
    },
    createdAtIso: NOW,
    updatedAtIso: NOW,
    ...overrides,
  };
}

function reservationFixture(attemptId: string, overrides: Partial<CapacityReservationRecord> = {}): CapacityReservationRecord {
  return {
    id: 'res-example-' + attemptId,
    attemptId,
    hostId: HOST_NAME,
    slotIndex: 0,
    held: true,
    seatTool: 'opencode',
    hostName: HOST_NAME,
    hostKind: 'opencode',
    transport: 'local',
    sshAlias: null,
    port: null,
    worktreePath: WORKTREE_PATH,
    reservedAtIso: NOW,
    releasedAtIso: null,
    ...overrides,
  };
}

interface AdmissionHarnessOptions {
  readonly maxActiveRuns?: number;
  readonly candidateHosts?: readonly ReserveExecutionCapacityCandidateHost[] | undefined;
}

function makeHarness(options: AdmissionHarnessOptions = {}) {
  const runRepo = new LaneRunRepositoryAdapter();
  const runJournal = new LaneRunJournalAdapter();
  const executionJournal = new ExecutionJournalAdapter();
  const workOrders = new Map<string, WorkOrderRecord>([
    ['wo-example-1', workOrderFixture()],
  ]);
  const workOrderRepo = {
    findWorkOrderById: async (workOrderId: string) => workOrders.get(workOrderId) ?? null,
  };
  const attempts = new Map<string, AttemptRecord>();
  const attemptRepo = {
    findAttemptById: async (attemptId: string) => attempts.get(attemptId) ?? null,
  };

  const reserveCalls: ReserveExecutionCapacityRequest[] = [];
  let reserveAnswer: (request: ReserveExecutionCapacityRequest) => Promise<ReserveExecutionCapacityResult> = async (request) => {
    const reservation = reservationFixture(request.attemptId, {
      hostName: request.candidateHosts?.[0]?.name ?? request.hostId ?? HOST_NAME,
      hostKind: request.candidateHosts?.[0]?.kind ?? 'opencode',
      worktreePath: request.worktreePath ?? WORKTREE_PATH,
    });
    await executionJournal.saveCapacityReservation(reservation);
    return { outcome: 'reserved', reservation };
  };
  const reserve: ReserveExecutionCapacityPort = {
    async reserveExecutionCapacity(request) {
      reserveCalls.push(request);
      return reserveAnswer(request);
    },
  };

  let reservationCounter = 0;
  const adapter = new LaneRunAdmissionAdapter({
    reserve,
    runRepo,
    runJournal,
    workOrderRepo,
    attemptRepo,
    executionJournal,
    maxActiveRuns: options.maxActiveRuns ?? 1,
    ...(options.candidateHosts === undefined ? { candidateHosts: CANDIDATE_HOSTS } : { candidateHosts: options.candidateHosts }),
    newReservationId: () => {
      reservationCounter += 1;
      return 'res-adm-' + String(reservationCounter);
    },
  });

  const createRun = async (record: LaneRunRecord) => {
    const created = await runRepo.create(record);
    expect(created.outcome).toBe('saved');
  };
  const holdReservation = async (attemptId: string, overrides: Partial<CapacityReservationRecord> = {}) => {
    await executionJournal.saveCapacityReservation(reservationFixture(attemptId, overrides));
  };
  const stopRun = async (runId: string) => {
    const appended = await runJournal.append(
      laneRunConductEntry('01JB0000000000000000000002', runId, 'stopped', NOW),
    );
    expect(appended.outcome).toBe('appended');
  };

  return {
    adapter,
    runRepo,
    runJournal,
    executionJournal,
    workOrders,
    attempts,
    reserveCalls,
    setReserveAnswer: (answer: typeof reserveAnswer) => {
      reserveAnswer = answer;
    },
    createRun,
    holdReservation,
    stopRun,
  };
}

function firstReservationRequest(overrides: Record<string, unknown> = {}) {
  return {
    attemptId: 'attempt-example-1',
    workOrderId: 'wo-example-1',
    seatTool: 'opencode' as const,
    nowIso: NOW,
    ...overrides,
  };
}

function admitRequest(overrides: Partial<LaneRunAdmissionRequest> = {}): LaneRunAdmissionRequest {
  return {
    attemptId: 'attempt-example-2',
    workOrderId: 'wo-example-1',
    seatTool: 'opencode',
    worktreePath: WORKTREE_PATH,
    nowIso: NOW,
    ...overrides,
  };
}

async function heldFor(journal: ExecutionJournalAdapter, attemptId: string): Promise<boolean> {
  return (await journal.listActiveReservations()).some(
    (reservation) => reservation.attemptId === attemptId && reservation.held,
  );
}

describe('LaneRunAdmissionAdapter reserveFirst (K7-D7)', () => {
  it('test 8: with no active run the reserve gets the candidates and no worktree path, and answers reserved', async () => {
    const harness = makeHarness();
    const result = await harness.adapter.reserveFirst(firstReservationRequest());

    expect(result).toEqual({
      outcome: 'reserved',
      hostName: HOST_NAME,
      hostKind: 'opencode',
      worktreePath: WORKTREE_PATH,
      transport: 'local',
      sshAlias: null,
      port: null,
    });
    expect(harness.reserveCalls).toHaveLength(1);
    const request = harness.reserveCalls[0];
    expect(request.attemptId).toBe('attempt-example-1');
    expect(request.candidateHosts).toEqual(CANDIDATE_HOSTS);
    expect(request.worktreePath).toBeUndefined();
    expect(request.hostId).toBeUndefined();
  });

  it('test 8c (KF-8): the reserved result carries the record\'s transport, sshAlias and port', async () => {
    const harness = makeHarness();
    harness.setReserveAnswer(async (request) => {
      const reservation = reservationFixture(request.attemptId, {
        transport: 'ssh',
        sshAlias: 'lane-ssh-example',
        port: 41002,
      });
      await harness.executionJournal.saveCapacityReservation(reservation);
      return { outcome: 'reserved', reservation };
    });
    expect(await harness.adapter.reserveFirst(firstReservationRequest())).toEqual({
      outcome: 'reserved',
      hostName: HOST_NAME,
      hostKind: 'opencode',
      worktreePath: WORKTREE_PATH,
      transport: 'ssh',
      sshAlias: 'lane-ssh-example',
      port: 41002,
    });

    // A legacy record persisted before `transport` existed derives its
    // transport from the alias it carries.
    const legacy = makeHarness();
    legacy.setReserveAnswer(async (request) => {
      const reservation = reservationFixture(request.attemptId, {
        transport: undefined,
        sshAlias: 'legacy-alias',
        port: null,
      });
      await legacy.executionJournal.saveCapacityReservation(reservation);
      return { outcome: 'reserved', reservation };
    });
    expect(await legacy.adapter.reserveFirst(firstReservationRequest())).toMatchObject({
      transport: 'ssh',
      sshAlias: 'legacy-alias',
      port: null,
    });
  });

  it('test 9: the cap blocks while another active run holds a reservation, and clears once it is stopped', async () => {
    const harness = makeHarness({ maxActiveRuns: 1 });
    await harness.createRun(runRecord('run-01JB0000000000000000000001', ['attempt-example-2'], 'wo-example-2'));
    harness.workOrders.set('wo-example-2', workOrderFixture({ id: 'wo-example-2', ownedPaths: ['packages/other/src'] }));
    await harness.holdReservation('attempt-example-2');

    const blocked = await harness.adapter.reserveFirst(firstReservationRequest());
    expect(blocked).toEqual({ outcome: 'no-capacity' });
    expect(harness.reserveCalls).toHaveLength(0);

    await harness.stopRun('run-01JB0000000000000000000001');
    const cleared = await harness.adapter.reserveFirst(firstReservationRequest());
    expect(cleared).toEqual({
      outcome: 'reserved',
      hostName: HOST_NAME,
      hostKind: 'opencode',
      worktreePath: WORKTREE_PATH,
      transport: 'local',
      sshAlias: null,
      port: null,
    });
    expect(harness.reserveCalls).toHaveLength(1);
  });

  it('test 9b: an in-flight held reservation without a run counts against the cap', async () => {
    const harness = makeHarness({ maxActiveRuns: 1 });
    await harness.holdReservation('attempt-example-9');

    const blocked = await harness.adapter.reserveFirst(firstReservationRequest());
    expect(blocked).toEqual({ outcome: 'no-capacity' });
    expect(harness.reserveCalls).toHaveLength(0);
  });

  it('test 10: package-busy blocks a shared package of the same repository, not a different one', async () => {
    const harness = makeHarness({ maxActiveRuns: 2 });
    await harness.createRun(runRecord('run-01JB0000000000000000000001', ['attempt-example-2'], 'wo-example-2'));
    harness.workOrders.set(
      'wo-example-2',
      workOrderFixture({ id: 'wo-example-2', ownedPaths: ['packages/work-execution/src'] }),
    );
    await harness.holdReservation('attempt-example-2');

    harness.workOrders.set(
      'wo-example-1',
      workOrderFixture({ id: 'wo-example-1', ownedPaths: ['packages/work-execution/test'] }),
    );
    const shared = await harness.adapter.reserveFirst(
      firstReservationRequest({ workOrderId: 'wo-example-1' }),
    );
    expect(shared).toEqual({ outcome: 'no-capacity' });
    expect(harness.reserveCalls).toHaveLength(0);

    harness.workOrders.set(
      'wo-example-1',
      workOrderFixture({ id: 'wo-example-1', ownedPaths: ['apps/cli/src'] }),
    );
    const distinct = await harness.adapter.reserveFirst(firstReservationRequest());
    expect(distinct).toEqual({
      outcome: 'reserved',
      hostName: HOST_NAME,
      hostKind: 'opencode',
      worktreePath: WORKTREE_PATH,
      transport: 'local',
      sshAlias: null,
      port: null,
    });
    expect(harness.reserveCalls).toHaveLength(1);
  });

  it('test 10b: an in-flight held reservation without a run blocks a shared package, not a distinct one', async () => {
    const harness = makeHarness({ maxActiveRuns: 2 });
    harness.attempts.set(
      'attempt-example-9',
      attemptFixture('attempt-example-9', { workOrderId: 'wo-example-2' }),
    );
    await harness.holdReservation('attempt-example-9');
    harness.workOrders.set(
      'wo-example-2',
      workOrderFixture({ id: 'wo-example-2', ownedPaths: ['packages/work-execution/src'] }),
    );

    harness.workOrders.set(
      'wo-example-1',
      workOrderFixture({ id: 'wo-example-1', ownedPaths: ['packages/work-execution/test'] }),
    );
    const shared = await harness.adapter.reserveFirst(
      firstReservationRequest({ workOrderId: 'wo-example-1' }),
    );
    expect(shared).toEqual({ outcome: 'no-capacity' });
    expect(harness.reserveCalls).toHaveLength(0);

    harness.workOrders.set(
      'wo-example-1',
      workOrderFixture({ id: 'wo-example-1', ownedPaths: ['apps/cli/src'] }),
    );
    const distinct = await harness.adapter.reserveFirst(firstReservationRequest());
    expect(distinct).toEqual({
      outcome: 'reserved',
      hostName: HOST_NAME,
      hostKind: 'opencode',
      worktreePath: WORKTREE_PATH,
      transport: 'local',
      sshAlias: null,
      port: null,
    });
    expect(harness.reserveCalls).toHaveLength(1);
  });

  it('test 9c: the checks are re-run after the reservation is written; a concurrent start makes this attempt release and refuse no-capacity', async () => {
    const harness = makeHarness({ maxActiveRuns: 1 });
    // While this start is reserving, another start reserves concurrently for
    // another attempt (an in-flight held reservation with no run).
    harness.setReserveAnswer(async (request) => {
      await harness.executionJournal.saveCapacityReservation(
        reservationFixture('attempt-example-9'),
      );
      const reservation = reservationFixture(request.attemptId);
      await harness.executionJournal.saveCapacityReservation(reservation);
      return { outcome: 'reserved', reservation };
    });
    const releaseSpy = vi.spyOn(harness.executionJournal, 'releaseCapacityReservation');

    const result = await harness.adapter.reserveFirst(firstReservationRequest());

    expect(result).toEqual({ outcome: 'no-capacity' });
    expect(harness.reserveCalls).toHaveLength(1);
    expect(releaseSpy).toHaveBeenCalledWith('attempt-example-1', NOW);
    expect(await heldFor(harness.executionJournal, 'attempt-example-1')).toBe(false);
    // The concurrent racer keeps its reservation; the caller retries.
    expect(await heldFor(harness.executionJournal, 'attempt-example-9')).toBe(true);
  });

  it('test 8b: no candidate hosts refuses no-host; an incomplete reservation is released and refused', async () => {
    const noHost = makeHarness({ candidateHosts: [] });
    expect(await noHost.adapter.reserveFirst(firstReservationRequest())).toEqual({
      outcome: 'refused',
      reason: 'no-host',
    });
    expect(noHost.reserveCalls).toHaveLength(0);

    const incomplete = makeHarness();
    // Actually save the bad reservation first: `held === false` must not pass
    // without the release.
    await incomplete.holdReservation('attempt-example-1', {
      hostName: null,
      hostKind: null,
      worktreePath: null,
    });
    const releaseSpy = vi.spyOn(incomplete.executionJournal, 'releaseCapacityReservation');
    incomplete.setReserveAnswer(async (request) => ({
      outcome: 'reserved',
      reservation: reservationFixture(request.attemptId, { hostName: null, hostKind: null, worktreePath: null }),
    }));
    const refused = await incomplete.adapter.reserveFirst(firstReservationRequest());
    expect(refused).toEqual({ outcome: 'refused', reason: 'reservation-incomplete' });
    expect(releaseSpy).toHaveBeenCalledWith('attempt-example-1', NOW);
    expect(await heldFor(incomplete.executionJournal, 'attempt-example-1')).toBe(false);
  });

  it('test 8c: an ssh host without a review route is never offered to the reserve; alone it refuses no-review-route (KF-14b)', async () => {
    const harness = makeHarness({ candidateHosts: [SSH_NO_AUTH_HOST] });
    const result = await harness.adapter.reserveFirst(firstReservationRequest());
    expect(result).toEqual({ outcome: 'refused', reason: 'no-review-route' });
    expect(harness.reserveCalls).toHaveLength(0);
  });

  it('test 8d: mixed candidates — the reserve sees only the available host (KF-14b)', async () => {
    const harness = makeHarness({ candidateHosts: [SSH_NO_AUTH_HOST, ...CANDIDATE_HOSTS] });
    const result = await harness.adapter.reserveFirst(firstReservationRequest());
    expect(result).toEqual({
      outcome: 'reserved',
      hostName: HOST_NAME,
      hostKind: 'opencode',
      worktreePath: WORKTREE_PATH,
      transport: 'local',
      sshAlias: null,
      port: null,
    });
    expect(harness.reserveCalls).toHaveLength(1);
    expect(harness.reserveCalls[0]?.candidateHosts).toEqual(CANDIDATE_HOSTS);
  });
});

describe('LaneRunAdmissionAdapter admit (a later attempt of a run)', () => {
  it('test 11: a pivot attempt of a start-created run is admitted on the run\'s own host and worktree', async () => {
    const harness = makeHarness();
    await harness.createRun(
      runRecord(RUN_A_ID, ['attempt-example-1', 'attempt-example-2']),
    );
    harness.attempts.set('attempt-example-1', attemptFixture('attempt-example-1'));
    await harness.holdReservation('attempt-example-1');

    const result = await harness.adapter.admit(admitRequest());

    expect(result).toEqual({ outcome: 'admitted' });
    expect(harness.reserveCalls).toHaveLength(1);
    const request = harness.reserveCalls[0];
    expect(request.hostId).toBe(HOST_NAME);
    expect(request.worktreePath).toBe(WORKTREE_PATH);
    expect(request.maxSlots).toBe(1);
    expect(request.candidateHosts).toBeUndefined();
    expect(request.host).toMatchObject({ hostName: HOST_NAME, hostKind: 'opencode', transport: 'local' });
  });

  it('test 11c: a later attempt whose request path differs from the first attempt\'s is refused before the reserve', async () => {
    const harness = makeHarness();
    await harness.createRun(runRecord(RUN_A_ID, ['attempt-example-1', 'attempt-example-2']));
    harness.attempts.set('attempt-example-1', attemptFixture('attempt-example-1'));
    await harness.holdReservation('attempt-example-1');

    const wrongPath = await harness.adapter.admit(
      admitRequest({ worktreePath: WORKTREE_ROOT + '/other00000000000000000000000002' }),
    );
    expect(wrongPath).toEqual({ outcome: 'refused', reason: 'worktree-mismatch' });
    expect(harness.reserveCalls).toHaveLength(0);

    const fresh = makeHarness();
    await fresh.createRun(runRecord(RUN_A_ID, ['attempt-example-1', 'attempt-example-2']));
    await fresh.holdReservation('attempt-example-1');
    const unreadable = await fresh.adapter.admit(admitRequest());
    expect(unreadable).toEqual({ outcome: 'refused', reason: 'worktree-mismatch' });
    expect(fresh.reserveCalls).toHaveLength(0);
  });

  it('test 12: a reservation at another path is released and refused worktree-mismatch', async () => {
    const harness = makeHarness();
    await harness.createRun(runRecord(RUN_A_ID, ['attempt-example-1', 'attempt-example-2']));
    harness.attempts.set('attempt-example-1', attemptFixture('attempt-example-1'));
    await harness.holdReservation('attempt-example-1');
    // Actually save the bad reservation first: `held === false` must not pass
    // without the release.
    const badPath = WORKTREE_ROOT + '/other00000000000000000000000000002';
    await harness.holdReservation('attempt-example-2', { worktreePath: badPath });
    const releaseSpy = vi.spyOn(harness.executionJournal, 'releaseCapacityReservation');
    harness.setReserveAnswer(async (request) => ({
      outcome: 'reserved',
      reservation: reservationFixture(request.attemptId, {
        worktreePath: badPath,
      }),
    }));

    const result = await harness.adapter.admit(admitRequest());
    expect(result).toEqual({ outcome: 'refused', reason: 'worktree-mismatch' });
    expect(releaseSpy).toHaveBeenCalledWith('attempt-example-2', NOW);
    expect(await heldFor(harness.executionJournal, 'attempt-example-2')).toBe(false);
  });

  it('test 13: a seat tool other than the pinned host\'s kind is refused before the reserve', async () => {
    const harness = makeHarness();
    await harness.createRun(runRecord(RUN_A_ID, ['attempt-example-1', 'attempt-example-2']));
    harness.attempts.set('attempt-example-1', attemptFixture('attempt-example-1'));
    await harness.holdReservation('attempt-example-1');

    const result = await harness.adapter.admit(admitRequest({ seatTool: 'agy' }));
    expect(result).toEqual({ outcome: 'refused', reason: 'host-kind-differs' });
    expect(harness.reserveCalls).toHaveLength(0);
  });

  it('test 14: busy-worktree reads no-capacity and a reserve refusal reads reserve-refused', async () => {
    const busy = makeHarness();
    await busy.createRun(runRecord(RUN_A_ID, ['attempt-example-1', 'attempt-example-2']));
    busy.attempts.set('attempt-example-1', attemptFixture('attempt-example-1'));
    await busy.holdReservation('attempt-example-1');
    busy.setReserveAnswer(async () => ({ outcome: 'busy-worktree', blockingAttemptId: 'attempt-example-1' }));
    expect(await busy.adapter.admit(admitRequest())).toEqual({ outcome: 'no-capacity' });

    const refused = makeHarness();
    await refused.createRun(runRecord(RUN_A_ID, ['attempt-example-1', 'attempt-example-2']));
    refused.attempts.set('attempt-example-1', attemptFixture('attempt-example-1'));
    await refused.holdReservation('attempt-example-1');
    refused.setReserveAnswer(async () => ({ outcome: 'refused', reason: 'example reserve refusal' }));
    expect(await refused.adapter.admit(admitRequest())).toEqual({ outcome: 'refused', reason: 'reserve-refused' });
  });

  it('test 11b: an attempt no run lists is refused run-missing; a run without a known host is refused run-host-unknown', async () => {
    const harness = makeHarness();
    expect(await harness.adapter.admit(admitRequest())).toEqual({ outcome: 'refused', reason: 'run-missing' });

    await harness.createRun(runRecord(RUN_B_ID, ['attempt-example-2']));
    expect(await harness.adapter.admit(admitRequest())).toEqual({
      outcome: 'refused',
      reason: 'run-host-unknown',
    });
    expect(harness.reserveCalls).toHaveLength(0);
  });
});

describe('laneRunPackageKeys (K7-D5)', () => {
  it('test 15: packages/<x> and apps/<x prefixes name their package, others their first segment', () => {
    expect(
      laneRunPackageKeys(['packages/a/src/x.ts', 'packages/a/test', 'apps/cli', 'docs/x.md']),
    ).toEqual(['apps/cli', 'docs', 'packages/a']);
  });

  it('test 15b: blank and .. segments are skipped, duplicates collapse, and never throws', () => {
    expect(laneRunPackageKeys(['packages/a/src', 'packages/a/test', 'apps/cli/src', 'apps/cli/test', '', '..'])).toEqual([
      'apps/cli',
      'packages/a',
    ]);
    expect(laneRunPackageKeys([])).toEqual([]);
    expect(laneRunPackageKeys([undefined as unknown as string])).toEqual([]);
  });

  it('test 15c: bare packages and apps own their whole tree; other paths keep their behaviour', () => {
    expect(laneRunPackageKeys(['packages'])).toEqual(['packages']);
    expect(laneRunPackageKeys(['apps'])).toEqual(['apps']);
    expect(laneRunPackageKeys(['apps/'])).toEqual(['apps']);

    const sameRepo = { repository: 'repo-example-1' };
    // A bare tree overlaps every key under that tree.
    expect(laneRunPackagesOverlap({ ...sameRepo, ownedPaths: ['packages'] }, { ...sameRepo, ownedPaths: ['packages/a/src'] })).toBe(true);
    expect(laneRunPackagesOverlap({ ...sameRepo, ownedPaths: ['packages/a/src'] }, { ...sameRepo, ownedPaths: ['packages'] })).toBe(true);
    // A bare tree of one kind does not overlap the other tree.
    expect(laneRunPackagesOverlap({ ...sameRepo, ownedPaths: ['apps'] }, { ...sameRepo, ownedPaths: ['packages/a'] })).toBe(false);
    // Unchanged behaviour: equal keys overlap, sibling keys do not, other
    // repositories never overlap, and non-tree paths keep first-segment keys.
    expect(laneRunPackagesOverlap({ ...sameRepo, ownedPaths: ['packages/a'] }, { ...sameRepo, ownedPaths: ['packages/a/test'] })).toBe(true);
    expect(laneRunPackagesOverlap({ ...sameRepo, ownedPaths: ['packages/a'] }, { ...sameRepo, ownedPaths: ['packages/b'] })).toBe(false);
    expect(laneRunPackagesOverlap({ ...sameRepo, ownedPaths: ['packages'] }, { repository: 'repo-other-1', ownedPaths: ['packages/a'] })).toBe(false);
    expect(laneRunPackagesOverlap({ ...sameRepo, ownedPaths: ['docs'] }, { ...sameRepo, ownedPaths: ['docs/x.md'] })).toBe(true);
  });

  it('only exactly packages or apps (a trailing slash allowed) is a whole-tree key; packages/.. and packages//x stay skipped', () => {
    expect(laneRunPackageKeys(['packages', 'apps/'])).toEqual(['apps', 'packages']);
    expect(laneRunPackageKeys(['packages/..', 'packages//nested', 'apps/..'])).toEqual([]);
  });
});
