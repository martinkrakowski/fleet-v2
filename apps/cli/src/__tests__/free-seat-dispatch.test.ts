// Free-seat wiring at the CLI composition boundary for dispatch (free-seat
// plan FS3a review): a v2 installation with `policy.useFreeSeats` false
// reaches DispatchAttemptUseCase through AllowedSeatAdapter, so a dispatch
// whose effective model is a free seat's model is refused before any runner
// starts while a paid seat's model proceeds past the seat check. This proves
// the seat port is wired in the CLI composition.
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createFleetCliRuntime } from '../composition.js';
import type { FleetInstallation } from '@fleet/installation';
import { sha256HexDigest, simpleDeterministicHexDigest } from '@fleet/work-execution';
import type { WorkOrderRecord } from '@fleet/work-execution';

const ATTEMPT_ID = 'att-free-seat-dispatch';
const WORK_ORDER_ID = 'wo-free-seat-dispatch';
const SESSION_ID = 'ses_free_seat_dispatch_1';

const FREE_MODEL = 'provider-free/glm-5.3-flash';
const PAID_MODEL = 'provider-a/glm-5.3';

const installation: FleetInstallation = {
  schemaVersion: 2,
  forge: { mode: 'none' },
  hosts: {
    here: {
      transport: 'local',
      worktreeRoot: '/tmp/wt',
      roles: ['orchestrator', 'lane-runner', 'verifier'],
      runner: {
        kind: 'opencode',
        port: 46000,
        capabilities: {
          networkEgressRestricted: true,
          cpuAndMemoryLimited: true,
          processTreeTermination: true,
          filesystemScope: 'scoped-worktree',
        },
      },
    },
  },
  seats: [
    {
      id: 'impl-paid',
      tool: 'opencode',
      model: PAID_MODEL,
      roles: ['implementer'],
      costClass: 'paid',
    },
    {
      id: 'impl-free',
      tool: 'opencode',
      model: FREE_MODEL,
      roles: ['implementer'],
      costClass: 'free',
    },
  ],
  chains: {
    implementer: [{ seatId: 'impl-paid' }, { seatId: 'impl-free' }],
  },
  policy: { useFreeSeats: false },
};

let suiteDir: string;
let laneRepoDir: string;
let briefDir: string;
let baseCommit: string;
let freeManifest: { path: string; digest: string; fnvDigest: string };
let paidManifest: { path: string; digest: string; fnvDigest: string };

function initGitRepo(dir: string): string {
  mkdirSync(dir, { recursive: true });
  execFileSync('git', ['-C', dir, 'init', '-q']);
  execFileSync('git', ['-C', dir, 'config', 'user.email', 'fleet@example.invalid']);
  execFileSync('git', ['-C', dir, 'config', 'user.name', 'Fleet CLI Test']);
  execFileSync('git', ['-C', dir, 'config', 'commit.gpgsign', 'false']);
  // The frozen brief package lives in the worktree's gitignored `.lane/`
  // directory, where the containment rules allow it.
  writeFileSync(path.join(dir, '.gitignore'), '.lane/\n');
  writeFileSync(path.join(dir, 'README.md'), '# lane worktree\n');
  execFileSync('git', ['-C', dir, 'add', '.']);
  execFileSync('git', ['-C', dir, 'commit', '-q', '-m', 'init']);
  return execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
}

function writeBriefPackage(
  proseFileName: string,
  model: string,
): { path: string; digest: string; fnvDigest: string } {
  const prosePath = path.join(briefDir, proseFileName);
  const manifestPath = path.join(briefDir, proseFileName.replace(/\.md$/, '-manifest.json'));
  const prose = `# Frozen brief for ${model}\n`;
  const manifest = JSON.stringify({ modelAssignment: { model } }, null, 2);
  writeFileSync(prosePath, prose);
  writeFileSync(manifestPath, manifest);
  const combined = `${prose}\n${manifest}`;
  return {
    path: prosePath,
    digest: sha256HexDigest(combined),
    fnvDigest: simpleDeterministicHexDigest(combined),
  };
}

function makeWorkOrder(): WorkOrderRecord {
  return {
    id: WORK_ORDER_ID,
    projectId: 'proj-cli-test',
    taskId: 'task-cli-test',
    laneId: 'lane-cli-test',
    repository: 'github.com/org/repo',
    state: 'implementing',
    revision: 1,
    baseCommit,
    ownedPaths: ['src/'],
    policyRevision: 'pol-1',
    prerequisiteWorkOrderIds: [],
    createdAtIso: '2026-10-15T10:00:00Z',
    updatedAtIso: '2026-10-15T10:00:00Z',
  };
}

beforeAll(() => {
  suiteDir = mkdtempSync(path.join(tmpdir(), 'fleet-cli-free-seat-dispatch-'));
  laneRepoDir = path.join(suiteDir, 'lane-repo');
  // Brief files are staged inside the worktree's gitignored `.lane/` folder:
  // dispatch reads the frozen brief only from contained worktree paths.
  briefDir = path.join(laneRepoDir, '.lane');
  mkdirSync(briefDir, { recursive: true });
  baseCommit = initGitRepo(laneRepoDir);
  freeManifest = writeBriefPackage('free-brief.md', FREE_MODEL);
  paidManifest = writeBriefPackage('paid-brief.md', PAID_MODEL);
});

afterAll(() => {
  rmSync(suiteDir, { recursive: true, force: true });
});

describe('free-seat dispatch wiring at the CLI composition boundary', () => {
  function makeRuntime() {
    let runnerStarts = 0;
    const runSubprocess = async () => {
      runnerStarts += 1;
      return { exitCode: 0, stdout: JSON.stringify({ sessionID: SESSION_ID }), stderr: '' };
    };
    const rt = createFleetCliRuntime({ installation, runSubprocess });
    return { rt, runnerStarts: () => runnerStarts };
  }

  async function reserveAttempt(rt: ReturnType<typeof createFleetCliRuntime>) {
    const reserve = await rt.execution.reserveExecutionCapacity.reserveExecutionCapacity({
      reservationId: 'res-free-seat-dispatch',
      attemptId: ATTEMPT_ID,
      workOrderId: WORK_ORDER_ID,
      hostId: 'here',
      worktreePath: laneRepoDir,
      maxSlots: 1,
      seatTool: 'opencode',
      nowIso: '2026-10-15T10:00:00.000Z',
    });
    expect(reserve.outcome).toBe('reserved');
  }

  it('refuses a dispatch whose effective model is a free seat before any runner starts', async () => {
    const { rt, runnerStarts } = makeRuntime();
    await rt.execution.workOrderRepository.saveWorkOrder(makeWorkOrder());
    await reserveAttempt(rt);

    const result = await rt.execution.dispatchAttempt.dispatchAttempt({
      attemptId: ATTEMPT_ID,
      workOrderId: WORK_ORDER_ID,
      worktreePath: laneRepoDir,
      briefPackagePath: freeManifest.path,
      briefDigest: freeManifest.digest,
      baseCommit,
      stepLimit: 40,
      timeLimitSeconds: 3600,
      nowIso: '2026-10-15T10:00:00.000Z',
    });

    expect(result.outcome).toBe('refused');
    expect(result.outcome === 'refused' && result.reason).toContain('is a free seat');
    expect(result.outcome === 'refused' && result.reason).toContain('impl-free');
    // Refused before any runner subprocess was started.
    expect(runnerStarts()).toBe(0);

    // The refusal is durable: exactly one journal `refused` entry.
    const entries = await rt.execution.executionJournal.listJournalEntriesForAttempt(ATTEMPT_ID);
    expect(entries).toHaveLength(1);
    expect(entries[0].action).toBe('dispatch');
    expect(entries[0].status).toBe('refused');
    expect(entries[0].detail).toContain(FREE_MODEL);
    expect(entries[0].detail).toContain('useFreeSeats false');
  });

  it('proceeds past the seat check when the effective model is a paid seat', async () => {
    const { rt, runnerStarts } = makeRuntime();
    await rt.execution.workOrderRepository.saveWorkOrder(makeWorkOrder());
    await reserveAttempt(rt);

    const result = await rt.execution.dispatchAttempt.dispatchAttempt({
      attemptId: ATTEMPT_ID,
      workOrderId: WORK_ORDER_ID,
      worktreePath: laneRepoDir,
      briefPackagePath: paidManifest.path,
      briefDigest: paidManifest.digest,
      baseCommit,
      stepLimit: 40,
      timeLimitSeconds: 3600,
      nowIso: '2026-10-15T10:00:00.000Z',
    });

    // The refusal is not the seat check: the dispatch started a runner.
    expect(result.outcome).toBe('started');
    expect(result.outcome === 'started' && result.sessionId).toBe(SESSION_ID);
    expect(runnerStarts()).toBe(1);
    const saved = await rt.execution.attemptRepository.findAttemptById(ATTEMPT_ID);
    expect(saved?.runner?.model).toBe(PAID_MODEL);
    expect(saved?.runner?.useFreeSeats).toBe(false);
  });

  it('refuses a dispatch whose digest is the FNV fallback instead of SHA-256', async () => {
    const { rt, runnerStarts } = makeRuntime();
    await rt.execution.workOrderRepository.saveWorkOrder(makeWorkOrder());
    await reserveAttempt(rt);

    const result = await rt.execution.dispatchAttempt.dispatchAttempt({
      attemptId: ATTEMPT_ID,
      workOrderId: WORK_ORDER_ID,
      worktreePath: laneRepoDir,
      briefPackagePath: paidManifest.path,
      briefDigest: paidManifest.fnvDigest,
      baseCommit,
      stepLimit: 40,
      timeLimitSeconds: 3600,
      nowIso: '2026-10-15T10:00:00.000Z',
    });

    expect(result).toEqual({
      outcome: 'refused',
      reason: `Frozen brief digest mismatch for attempt ${ATTEMPT_ID}: the brief or its manifest changed after it was prepared; run 'brief prepare' again`,
    });
    expect(runnerStarts()).toBe(0);
  });
});
