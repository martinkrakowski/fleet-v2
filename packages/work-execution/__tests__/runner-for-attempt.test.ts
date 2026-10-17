// Lane H9b1: inspect, reconcile, stop and collect act through the attempt's
// recorded host, with the confirm-or-unknown rule against the current
// installation and the legacy single-adapter path for v1 and pre-H9a records.
import { describe, expect, it } from 'vitest';

import type {
  AttemptRecord,
  AttemptRunnerRecord,
} from '../src/domain/execution-records.js';
import type {
  ExecutionRunnerPort,
  RunnerIsolationCapabilities,
  RunnerSessionRef,
  RunnerSessionStatus,
  StartRunnerSessionRequest,
  StartRunnerSessionResult,
  StopRunnerSessionRequest,
  StopRunnerSessionResult,
} from '../src/application/ports/out/ExecutionRunnerPort.out-port.js';
import { RunnerForAttemptAdapter } from '../src/infrastructure/adapters/RunnerForAttemptAdapter.adapter.js';
import { InspectAttemptUseCase } from '../src/application/use-cases/InspectAttemptUseCase.use-case.js';
import { StopAttemptUseCase } from '../src/application/use-cases/StopAttemptUseCase.use-case.js';

/** A runner stub whose identity is observable. */
function runnerStub(name: string): ExecutionRunnerPort {
  return {
    describeCapabilities(): RunnerIsolationCapabilities {
      return {
        filesystemScope: 'scoped-worktree',
        networkEgressRestricted: true,
        cpuAndMemoryLimited: true,
        processTreeTermination: true,
        authoritativeCompletion: true,
        artifactPersistence: true,
      };
    },
    describeRunner() {
      return {
        kind: 'opencode',
        remotePort: 4000,
        host: null,
        hostName: name,
        agent: null,
        model: null,
        variant: null,
      };
    },
    async startSession(_request: StartRunnerSessionRequest): Promise<StartRunnerSessionResult> {
      return { outcome: 'refused', reason: `stub ${name}` };
    },
    async inspectSession(_session: RunnerSessionRef): Promise<RunnerSessionStatus> {
      return {
        runnerReachable: 'unknown',
        workspacePreparation: 'unprepared',
        workerCommand: 'not-started',
        completionReceipt: null,
        artifactsCollected: false,
      };
    },
    async stopSession(_request: StopRunnerSessionRequest): Promise<StopRunnerSessionResult> {
      return { outcome: 'refused', reason: `stub ${name}` };
    },
  };
}

function attemptRunner(hostName: string | null, host: string | null, remotePort: number | null): AttemptRunnerRecord {
  return {
    kind: 'opencode',
    remotePort,
    host,
    ...(hostName !== null ? { hostName } : {}),
    agent: null,
    model: 'm',
    variant: null,
  };
}

function attempt(overrides?: Partial<AttemptRecord>): AttemptRecord {
  return {
    id: 'a1',
    workOrderId: 'w1',
    kind: 'initial',
    fixNumber: 0,
    priorAttemptId: null,
    worktreePath: '/tmp/wt-a1',
    baseCommit: 'b'.repeat(40),
    state: 'running',
    outcome: null,
    briefDigest: null,
    briefPackagePath: null,
    sessionId: 'ses_x',
    completionReceipt: null,
    artifacts: null,
    runner: attemptRunner('host-a', null, 4001),
    createdAtIso: '2026-10-16T00:00:00Z',
    updatedAtIso: '2026-10-16T00:00:00Z',
    ...overrides,
  };
}

describe('RunnerForAttemptAdapter', () => {
  const legacy = runnerStub('legacy');
  const hosts = {
    'host-a': { transport: 'ssh' as const, sshAlias: 'a.example', roles: ['lane-runner'], runner: { kind: 'opencode' as const, port: 4001 } },
    'host-b': { transport: 'local' as const, roles: ['lane-runner'], runner: { kind: 'opencode' as const, port: 4002 } },
    'changed-host': { transport: 'ssh' as const, sshAlias: 'a.example', roles: ['lane-runner'], runner: { kind: 'opencode' as const, port: 9999 } },
    're-kinded': { transport: 'ssh' as const, sshAlias: 'a.example', roles: ['lane-runner'], runner: { kind: 'agy' as const, port: 4001 } },
  };

  it('uses the legacy runner for an attempt recorded without a hostName', () => {
    const adapter = new RunnerForAttemptAdapter({ hosts, legacyRunner: legacy });
    for (const recorded of [null, attemptRunner(null, 'a.example', 4001)]) {
      const result = adapter.runnerForAttempt({ runner: recorded });
      expect(result).toEqual({ ok: true, runner: legacy });
    }
  });

  it('uses the recorded host A runner and caches it; a second host gets a distinct adapter', () => {
    const adapter = new RunnerForAttemptAdapter({ hosts, legacyRunner: legacy });
    const a = adapter.runnerForAttempt({
      runner: attemptRunner('host-a', 'a.example', 4001),
    });
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    expect(a.runner).not.toBe(legacy);
    expect(a.runner.describeRunner?.()?.hostName).toBe('host-a');
    expect(a.runner.describeRunner?.()?.remotePort).toBe(4001);
    // Same host resolves to the same cached adapter.
    expect(
      adapter.runnerForAttempt({ runner: attemptRunner('host-a', 'a.example', 4001) }),
    ).toEqual(a);

    const b = adapter.runnerForAttempt({ runner: attemptRunner('host-b', null, 4002) });
    expect(b.ok).toBe(true);
    if (!b.ok) return;
    expect(b.runner).not.toBe(a.runner);
    expect(b.runner.describeRunner?.()?.hostName).toBe('host-b');
  });

  it('refuses a host whose port changed, naming the recorded host', () => {
    const adapter = new RunnerForAttemptAdapter({ hosts, legacyRunner: legacy });
    const result = adapter.runnerForAttempt({
      runner: attemptRunner('changed-host', null, 4001),
    });
    expect(result).toEqual({ ok: false, reason: 'recorded host changed-host changed or was removed' });
  });

  it('refuses a removed host', () => {
    const adapter = new RunnerForAttemptAdapter({ hosts, legacyRunner: legacy });
    const result = adapter.runnerForAttempt({ runner: attemptRunner('gone', null, 4001) });
    expect(result).toEqual({ ok: false, reason: 'recorded host gone changed or was removed' });
  });

  it('refuses a host whose kind changed', () => {
    const adapter = new RunnerForAttemptAdapter({ hosts, legacyRunner: legacy });
    const result = adapter.runnerForAttempt({ runner: attemptRunner('re-kinded', null, 4001) });
    expect(result).toEqual({ ok: false, reason: 'recorded host re-kinded changed or was removed' });
  });
});

describe('H9b1 gating in the use cases', () => {
  const legacy = runnerStub('legacy');
  const hosts = {
    'host-a': { transport: 'local' as const, roles: ['lane-runner'], runner: { kind: 'opencode' as const, port: 4001 } },
    'changed-host': { transport: 'local' as const, roles: ['lane-runner'], runner: { kind: 'opencode' as const, port: 9999 } },
  };
  const selection = new RunnerForAttemptAdapter({ hosts, legacyRunner: legacy });

  const attemptRepo = (record: AttemptRecord | null) => ({
    async findAttemptById(id: string) {
      return record !== null && record.id === id ? record : null;
    },
    async saveAttempt(_record: AttemptRecord) {},
  });

  const journal = {
    entries: [] as unknown[],
    async listJournalEntriesForAttempt() {
      return [];
    },
    async appendJournalEntry(entry: unknown) {
      journal.entries.push(entry);
      return entry;
    },
    async releaseCapacityReservation() {
      return false;
    },
  };

  it('inspect answers unknown with the reason for a changed host', async () => {
    const useCase = new InspectAttemptUseCase({
      attemptRepo: attemptRepo(
        attempt({ runner: attemptRunner('changed-host', null, 4001) }),
      ) as never,
      runnerForAttempt: selection,
    });
    const result = await useCase.inspectAttempt({ attemptId: 'a1' });
    expect(result).toEqual({
      outcome: 'unknown',
      attemptId: 'a1',
      reason: 'recorded host changed-host changed or was removed',
    });
  });

  it('inspect keeps the legacy path for an attempt recorded without a hostName', async () => {
    const useCase = new InspectAttemptUseCase({
      attemptRepo: attemptRepo(
        attempt({ runner: attemptRunner(null, 'old-alias', 4001) }),
      ) as never,
      runnerForAttempt: selection,
    });
    const result = await useCase.inspectAttempt({ attemptId: 'a1' });
    expect(result.outcome).toBe('found');
  });

  it('stop refuses for a changed host before recording any intent', async () => {
    const journalStub = { ...journal, entries: [] as unknown[] };
    const useCase = new StopAttemptUseCase({
      attemptRepo: attemptRepo(attempt({ runner: attemptRunner('changed-host', null, 4001) })) as never,
      journal: journalStub as never,
      runner: legacy,
      runnerForAttempt: selection,
    });
    const result = await useCase.stopAttempt({ attemptId: 'a1' });
    expect(result).toEqual({
      outcome: 'refused',
      reason: 'recorded host changed-host changed or was removed',
    });
    expect(journalStub.entries).toHaveLength(0);
  });

  it('stop refuses for a removed host', async () => {
    const useCase = new StopAttemptUseCase({
      attemptRepo: attemptRepo(attempt({ runner: attemptRunner('gone', null, 4001) })) as never,
      journal: journal as never,
      runner: legacy,
      runnerForAttempt: selection,
    });
    const result = await useCase.stopAttempt({ attemptId: 'a1' });
    expect(result).toEqual({ outcome: 'refused', reason: 'recorded host gone changed or was removed' });
  });

  it('stop still works through the resolved recorded-host runner when the host matches', async () => {
    let stoppedBy: string | null = null;
    const hostRunner: ExecutionRunnerPort = {
      ...runnerStub('host-a'),
      async stopSession(request: StopRunnerSessionRequest): Promise<StopRunnerSessionResult> {
        stoppedBy = request.attemptId;
        return {
          outcome: 'terminated',
          receipt: {
            attemptId: request.attemptId,
            sessionId: request.sessionId,
            endedAtIso: '2026-10-16T01:00:00Z',
            authoritative: true,
            exitStatus: null,
            stoppedByRequest: true,
          },
        };
      },
    };
    const useCase = new StopAttemptUseCase({
      attemptRepo: attemptRepo(attempt()) as never,
      journal: journal as never,
      runner: legacy,
      runnerForAttempt: {
        runnerForAttempt: (request) =>
          request.runner?.hostName === 'host-a'
            ? { ok: true, runner: hostRunner }
            : { ok: false, reason: 'recorded host gone changed or was removed' },
      },
    });
    const result = await useCase.stopAttempt({ attemptId: 'a1' });
    expect(result.outcome).toBe('terminated');
    expect(stoppedBy).toBe('a1');
  });
});
