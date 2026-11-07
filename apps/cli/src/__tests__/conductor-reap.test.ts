// EX-2b: `conductor reap --worktrees` — operator-opt-in removal of finished
// lanes' clean worktrees (branches kept). The flags are strict: --worktrees
// is required, --yes is required unless --dry-run is given, and a durable
// state directory is required like the other record-only commands.
// C2' adds --force-unsealed and the real-git end-to-end removal tests.
import { execFile } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { promisify } from 'node:util';

import { afterAll, describe, expect, it, vi } from 'vitest';

import {
  ActionAuthorizationAdapter,
  AttemptArtifactAdapter,
  LaneRun,
  laneRunConductEntry,
  LocalExecutor,
  ReapLaneWorktreesUseCase,
  consumptionId,
  unsealedWorktreeRemovalActionId,
  unsealedWorktreeRemovalScope,
  sha256HexDigest,
  unsealedRemovalRequestDigest,
  WorkspaceAdapter,
  type LaneRunRecord,
  type SubprocessRunner,
} from '@fleet/work-execution';
import type { FleetInstallation } from '@fleet/installation';
import { canonicalDecisionBytes } from '@fleet/operator-coordination';

import { createFleetCliRuntime, type FleetCliRuntime } from '../composition.js';
import { unsealedWorktreeRemovalAuthorizer } from '../composition/conductor.js';
import { runCli } from '../index.js';
import type { CliIo } from '../index.js';

const RUN_ID = 'run-01JB000000000000000000000A';
const NOW = '2026-10-31T00:00:00.000Z';
const COMMIT = 'a'.repeat(40);
const RECORDED_HOST = {
  kind: 'opencode' as const,
  remotePort: 4166,
  host: 'lane-host',
  hostName: 'lane-host',
  agent: null,
  model: null,
  variant: null,
};

const tempStateDirs: string[] = [];

afterAll(() => {
  for (const dir of tempStateDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempStateDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'fleet-v2-conductor-reap-'));
  tempStateDirs.push(dir);
  return dir;
}

interface CapturedIo extends CliIo {
  readonly outLines: string[];
  readonly errLines: string[];
}

function captureIo(): CapturedIo {
  const outLines: string[] = [];
  const errLines: string[] = [];
  return {
    outLines,
    errLines,
    stdout: (text: string) => {
      outLines.push(text);
    },
    stderr: (text: string) => {
      errLines.push(text);
    },
  };
}

/** Run one conductor invocation; `stateDir` null runs with no durable state directory. */
async function runConductor(
  runtime: FleetCliRuntime,
  args: readonly string[],
  stateDir: string | null = '/state-dir-example',
): Promise<{ code: number; stdout: string[]; stderr: string[] }> {
  const io = captureIo();
  const code = await runCli(
    ['conductor', ...args],
    io,
    runtime,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    stateDir === null ? { now: () => NOW } : { now: () => NOW, stateDir },
  );
  return { code, stdout: io.outLines, stderr: io.errLines };
}

async function registerProfile(runtime: FleetCliRuntime): Promise<void> {
  const result = await runtime.coordination.registerProjectProfile.execute({
    projectId: 'example-project',
    displayName: 'Example Project',
    repository: 'https://example.com/example.git',
    designatedDispatcherHost: 'orchestrator-host',
    policyRevision: 'pol-1',
    maxConcurrentLanes: 2,
    runnerCapabilities: { networkEgressRestricted: true },
    clones: { 'lane-host': { path: '/srv/fleet/clone', worktreeRoot: '/srv/fleet/worktrees' } },
  });
  expect(result.outcome).toBe('registered');
}

/** One merged run: merged journal, merged work order, one collected attempt on a recorded host. */
async function seedMergedRun(runtime: FleetCliRuntime): Promise<void> {
  await registerProfile(runtime);
  await runtime.execution.workOrderRepository.saveWorkOrder({
    id: 'wo-example-1',
    projectId: 'example-project',
    taskId: 'task-1',
    laneId: 'lane-1',
    repository: 'https://example.com/example.git',
    baseCommit: COMMIT,
    ownedPaths: ['packages/example'],
    policyRevision: 'pol-1',
    prerequisiteWorkOrderIds: [],
    state: 'merged',
    revision: 1,
    createdAtIso: NOW,
    updatedAtIso: NOW,
    risk: 'standard',
  });
  await runtime.execution.attemptRepository.saveAttempt({
    id: 'attempt-example-1',
    workOrderId: 'wo-example-1',
    kind: 'initial',
    fixNumber: 0,
    priorAttemptId: null,
    worktreePath: '/srv/fleet/worktrees/wt1',
    baseCommit: COMMIT,
    state: 'collected',
    outcome: null,
    briefDigest: 'b'.repeat(64),
    briefPackagePath: '.lane/brief-package',
    sessionId: null,
    completionReceipt: null,
    artifacts: null,
    runner: RECORDED_HOST,
    createdAtIso: NOW,
    updatedAtIso: NOW,
  });
  const created = LaneRun.create({
    version: 1,
    runId: RUN_ID,
    workOrderId: 'wo-example-1',
    tier: 2,
    seatPlanRef: 'c'.repeat(64),
    cursors: { 'first-pass': 0, fix: null, review: null },
    round: 0,
    attemptIds: ['attempt-example-1'],
    prNumber: null,
    parked: null,
    parkCount: 0,
    lease: null,
    revision: 1,
    runPolicyRevision: 'pol-1',
    branchName: `fleet/${RUN_ID}`,
  });
  expect(created.success).toBe(true);
  if (!created.success) {
    throw new Error('fixture must be a valid LaneRun record');
  }
  const record: LaneRunRecord = created.value.toRecord();
  expect(await runtime.conductor.laneRunRepository.create(record)).toMatchObject({ outcome: 'saved' });
  expect(
    await runtime.conductor.laneRunJournal.append(
      laneRunConductEntry('01JB0000000000000000000001', RUN_ID, 'merged', NOW),
    ),
  ).toMatchObject({ outcome: 'appended' });
}

const execGit = (args: readonly string[], cwd: string) =>
  promisify(execFile)('git', ['-c', 'user.name=Fleet Test', '-c', 'user.email=fleet-test@example.invalid', ...args], { cwd });

function createOwnerKeyPair(): { publicKeyBase64: string; privateKey: KeyObject } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const raw32 = publicKey.export({ format: 'der', type: 'spki' }).subarray(12);
  return { publicKeyBase64: raw32.toString('base64'), privateKey };
}

function signDecision(
  fields: {
    requestId: string;
    projectId: string;
    actionScope: string;
    expectedHeadSha: string | null;
    decisionRevision: string | null;
    grantId: string | null;
    state: string;
  },
  privateKey: KeyObject,
): string {
  return sign(null, canonicalDecisionBytes(fields), privateKey).toString('base64');
}

/** A valid Ed25519-signed one-way owner decision scoped to attempt-example-1's worktree and head. */
async function seedSignedOwnerApproval(s: {
  runtime: FleetCliRuntime;
  worktreePath: string;
  head: string;
  privateKey: KeyObject;
  stateDir: string;
}): Promise<void> {
  const actionScope = unsealedWorktreeRemovalScope('attempt-example-1', sha256HexDigest(s.worktreePath));
  const requested = await s.runtime.coordination.requestScopedDecision.requestScopedDecision({
    requestId: 'req-unsealed-1',
    projectId: 'example-project',
    kind: 'action-decision',
    actionScope,
    expectedHeadSha: s.head,
    proposalDigest: 'd'.repeat(64),
    policyRevision: 'pol-1',
    attemptId: 'attempt-example-1',
  });
  expect(requested.outcome).toBe('requested');
  const asked = await s.runtime.coordination.askOwnerQuestion.askOwnerQuestion({
    questionId: 'oq-unsealed-1',
    askedBy: 'conductor',
    title: 'Remove the unsealed worktree?',
    body: 'The artifacts were never sealed.',
    options: [
      { id: 'accept', label: 'Remove', consequence: 'The worktree directory is removed; the branch is kept.' },
      { id: 'reject', label: 'Keep', consequence: 'Nothing is removed.' },
    ],
    recommendation: { optionId: 'reject', because: 'Destructive without a sealed manifest.' },
    doorKind: 'one-way',
    linkedRequestId: 'req-unsealed-1',
  });
  expect(asked.outcome).toBe('asked');
  const signature = signDecision(
    {
      requestId: 'req-unsealed-1',
      projectId: 'example-project',
      actionScope,
      expectedHeadSha: s.head,
      decisionRevision: 'rev-1',
      grantId: 'grant-1',
      state: 'approved',
    },
    s.privateKey,
  );
  const decisionsDir = path.join(s.stateDir, 'decisions');
  await fs.mkdir(decisionsDir, { recursive: true });
  await fs.writeFile(
    path.join(decisionsDir, 'req-unsealed-1.json'),
    JSON.stringify({ state: 'approved', decisionRevision: 'rev-1', grantId: 'grant-1', signature }),
    'utf8',
  );
}

describe('conductor reap --worktrees (EX-2b)', () => {
  it('requires --worktrees', async () => {
    const runtime = createFleetCliRuntime({ stateDir: tempStateDir() });
    const result = await runConductor(runtime, ['reap']);
    expect(result.code).toBe(2);
    expect(result.stdout).toEqual([]);
    expect(result.stderr.join('')).toContain('requires --worktrees');
  });

  it('requires --yes without --dry-run, and calls nothing', async () => {
    const runtime = createFleetCliRuntime({ stateDir: tempStateDir() });
    // A real candidate exists, so a removal attempted before the refusal would be observable.
    await seedMergedRun(runtime);
    const reap = vi.spyOn(runtime.conductor.reapLaneWorktrees, 'reapLaneWorktrees');
    const result = await runConductor(runtime, ['reap', '--worktrees']);
    expect(result.code).toBe(2);
    expect(result.stdout).toEqual([]);
    expect(result.stderr.join('')).toContain('--yes');
    expect(reap).not.toHaveBeenCalled();
  });

  it('rejects an unknown flag and a positional', async () => {
    const runtime = createFleetCliRuntime({ stateDir: tempStateDir() });
    for (const args of [
      ['reap', '--worktrees', '--force'],
      ['reap', '--worktrees', '--yes', 'run-01JB000000000000000000000A'],
    ]) {
      const result = await runConductor(runtime, args);
      expect(result.code).toBe(2);
      expect(result.stdout).toEqual([]);
    }
  });

  it('needs a durable state directory like the other record-only commands', async () => {
    const runtime = createFleetCliRuntime();
    const result = await runConductor(runtime, ['reap', '--worktrees', '--yes'], null);
    expect(result.code).toBe(2);
    expect(result.stdout).toEqual([]);
    expect(result.stderr.join('')).toContain('needs a durable state directory');
  });

  it('--dry-run lists the candidate, removes nothing and exits 0', async () => {
    const runtime = createFleetCliRuntime({ stateDir: tempStateDir() });
    await seedMergedRun(runtime);
    const result = await runConductor(runtime, ['reap', '--worktrees', '--dry-run']);
    expect(result.code).toBe(0);
    expect(result.stdout).toHaveLength(1);
    const doc = JSON.parse(result.stdout[0]!) as {
      outcome: string;
      dryRun: boolean;
      removed: { runId: string; branchTip: string | null }[];
      alreadyRemoved: unknown[];
      refused: unknown[];
      skipped: unknown[];
    };
    expect(doc.outcome).toBe('reaped');
    expect(doc.dryRun).toBe(true);
    expect(doc.removed).toEqual([{ runId: RUN_ID, branchTip: null }]);
    expect(doc.alreadyRemoved).toEqual([]);
    expect(doc.refused).toEqual([]);
    expect(doc.skipped).toEqual([]);
  });

  it('--dry-run lists a non-terminal run as skipped', async () => {
    const runtime = createFleetCliRuntime({ stateDir: tempStateDir() });
    await seedMergedRun(runtime);
    // Move the run's conduct to a non-terminal state so it is not a candidate.
    expect(
      await runtime.conductor.laneRunJournal.append(
        laneRunConductEntry('01JB0000000000000000000002', RUN_ID, 'running', NOW),
      ),
    ).toMatchObject({ outcome: 'appended' });
    const result = await runConductor(runtime, ['reap', '--worktrees', '--dry-run']);
    expect(result.code).toBe(0);
    const doc = JSON.parse(result.stdout[0]!) as { removed: unknown[]; skipped: { runId: string; reason: string }[] };
    expect(doc.removed).toEqual([]);
    expect(doc.skipped).toEqual([{ runId: RUN_ID, reason: 'run-not-terminal' }]);
  });

  it('--yes attempts the removal and exits 1 when it is refused or unknown', async () => {
    const runtime = createFleetCliRuntime({ stateDir: tempStateDir() });
    await seedMergedRun(runtime);
    // The clone path does not exist and host 'lane-host' resolves to no
    // executor, so the removal is refused/unknown — never a silent pass.
    const result = await runConductor(runtime, ['reap', '--worktrees', '--yes']);
    expect(result.code).toBe(1);
    expect(result.stdout).toHaveLength(1);
    const doc = JSON.parse(result.stdout[0]!) as {
      outcome: string;
      removed: unknown[];
      refused: { runId: string; reason: string }[];
    };
    expect(doc.outcome).toBe('reaped');
    expect(doc.removed).toEqual([]);
    expect(doc.refused.length).toBeGreaterThan(0);
    expect(doc.refused[0]!.runId).toBe(RUN_ID);
  });

  it('prints journalFailed and exits 1 when any journal append failed', async () => {
    const runtime = createFleetCliRuntime({ stateDir: tempStateDir() });
    await seedMergedRun(runtime);
    const reap = vi
      .spyOn(runtime.conductor.reapLaneWorktrees, 'reapLaneWorktrees')
      .mockResolvedValue({
        outcome: 'reaped',
        dryRun: false,
        removed: [{ runId: RUN_ID, branchTip: COMMIT }],
        alreadyRemoved: [],
        refused: [],
        skipped: [],
        journalFailed: [
          { runId: RUN_ID, attemptId: 'attempt-example-1', branchTip: COMMIT, reason: 'journal write failed' },
        ],
      });
    const result = await runConductor(runtime, ['reap', '--worktrees', '--yes']);
    expect(result.code).toBe(1);
    expect(result.stdout).toHaveLength(1);
    const doc = JSON.parse(result.stdout[0]!) as {
      journalFailed: { runId: string; attemptId: string; branchTip: string; reason: string }[];
    };
    expect(doc.journalFailed).toEqual([
      { runId: RUN_ID, attemptId: 'attempt-example-1', branchTip: COMMIT, reason: 'journal write failed' },
    ]);
    expect(reap).toHaveBeenCalledTimes(1);
  });

  it('help names reap', async () => {
    const runtime = createFleetCliRuntime({ stateDir: tempStateDir() });
    const result = await runConductor(runtime, ['--help']);
    expect(result.code).toBe(0);
    expect(result.stdout.join('')).toContain('reap');
  });
});

// --- C2': --force-unsealed --------------------------------------------------

describe('conductor reap --force-unsealed (C2\')', () => {
  it('rejects --force-unsealed with --sessions and a duplicate --force-unsealed', async () => {
    const runtime = createFleetCliRuntime({ stateDir: tempStateDir() });
    const withSessions = await runConductor(runtime, ['reap', '--worktrees', '--sessions', '--force-unsealed']);
    expect(withSessions.code).toBe(2);
    expect(withSessions.stderr.join('')).toContain('applies only to --worktrees');
    // A secret-shaped or path-shaped unknown token is never echoed.
    const secretToken = `--gh${'p_'}${'x'.repeat(30)}`;
    const unknown = await runConductor(runtime, ['reap', '--worktrees', '--yes', secretToken]);
    expect(unknown.code).toBe(2);
    expect(unknown.stderr.join('')).not.toContain('ghp_');
    expect(unknown.stderr.join('')).not.toContain(secretToken);
    const duplicate = await runConductor(runtime, ['reap', '--worktrees', '--yes', '--force-unsealed', '--force-unsealed']);
    expect(duplicate.code).toBe(2);
    expect(duplicate.stderr.join('')).toContain('given more than once');
  });
});

describe('conductor reap --worktrees against real git (C2\')', () => {
  const tempRoots: string[] = [];
  const tempStateDirs2: string[] = [];

  afterAll(async () => {
    for (const dir of tempRoots) {
      await fs.rm(dir, { recursive: true, force: true });
    }
    for (const dir of tempStateDirs2) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /** A real clone, a real linked worktree, and the reap rewired to real adapters. */
  async function setupReal(): Promise<{
    runtime: FleetCliRuntime;
    root: string;
    clonePath: string;
    worktreeRoot: string;
    worktreePath: string;
    head: string;
    privateKey: KeyObject;
  }> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-reap-e2e-'));
    tempRoots.push(root);
    const clonePath = path.join(root, 'clone');
    const worktreeRoot = path.join(root, 'worktrees');
    const worktreePath = path.join(worktreeRoot, 'wt1');
    await fs.mkdir(clonePath);
    await execGit(['init'], clonePath);
    await execGit(['config', 'user.name', 'Fleet Test'], clonePath);
    await execGit(['config', 'user.email', 'fleet-test@example.invalid'], clonePath);
    await fs.writeFile(path.join(clonePath, 'README.md'), '# fleet test\n', 'utf8');
    await execGit(['add', '.'], clonePath);
    await execGit(['commit', '-m', 'initial commit'], clonePath);
    const { stdout: headOut } = await execGit(['rev-parse', 'HEAD'], clonePath);
    const head = headOut.trim();
    await fs.mkdir(worktreeRoot);
    await execGit(['worktree', 'add', '-b', `fleet/${RUN_ID}`, worktreePath, head], clonePath);
    await fs.appendFile(path.join(clonePath, '.git', 'info', 'exclude'), '\n.lane/\n', 'utf8');

    const stateDir = mkdtempSync(path.join(tmpdir(), 'fleet-v2-conductor-reap-e2e-'));
    tempStateDirs2.push(stateDir);
    const { publicKeyBase64, privateKey } = createOwnerKeyPair();
    const runtime = createFleetCliRuntime({ stateDir, ownerPublicKey: publicKeyBase64 });
    // The project profile points at the real clone and worktree root.
    const profile = await runtime.coordination.registerProjectProfile.execute({
      projectId: 'example-project',
      displayName: 'Example Project',
      repository: 'https://example.com/example.git',
      designatedDispatcherHost: 'orchestrator-host',
      policyRevision: 'pol-1',
      maxConcurrentLanes: 2,
      runnerCapabilities: { networkEgressRestricted: true },
      clones: { 'lane-host': { path: clonePath, worktreeRoot } },
    });
    expect(profile.outcome).toBe('registered');
    // The merged run whose latest attempt recorded the real worktree path.
    await runtime.execution.workOrderRepository.saveWorkOrder({
      id: 'wo-example-1',
      projectId: 'example-project',
      taskId: 'task-1',
      laneId: 'lane-1',
      repository: 'https://example.com/example.git',
      baseCommit: COMMIT,
      ownedPaths: ['packages/example'],
      policyRevision: 'pol-1',
      prerequisiteWorkOrderIds: [],
      state: 'merged',
      revision: 1,
      createdAtIso: NOW,
      updatedAtIso: NOW,
      risk: 'standard',
    });
    await runtime.execution.attemptRepository.saveAttempt({
      id: 'attempt-example-1',
      workOrderId: 'wo-example-1',
      kind: 'initial',
      fixNumber: 0,
      priorAttemptId: null,
      worktreePath,
      baseCommit: COMMIT,
      state: 'collected',
      outcome: null,
      briefDigest: 'b'.repeat(64),
      briefPackagePath: '.lane/brief-package',
      sessionId: null,
      completionReceipt: null,
      artifacts: null,
      runner: RECORDED_HOST,
      createdAtIso: NOW,
      updatedAtIso: NOW,
    });
    const created = LaneRun.create({
      version: 1,
      runId: RUN_ID,
      workOrderId: 'wo-example-1',
      tier: 2,
      seatPlanRef: 'c'.repeat(64),
      cursors: { 'first-pass': 0, fix: null, review: null },
      round: 0,
      attemptIds: ['attempt-example-1'],
      prNumber: null,
      parked: null,
      parkCount: 0,
      lease: null,
      revision: 1,
      runPolicyRevision: 'pol-1',
      branchName: `fleet/${RUN_ID}`,
    });
    expect(created.success).toBe(true);
    if (!created.success) {
      throw new Error('fixture must be a valid LaneRun record');
    }
    expect(
      await runtime.conductor.laneRunRepository.create(created.value.toRecord()),
    ).toMatchObject({ outcome: 'saved' });
    expect(
      await runtime.conductor.laneRunJournal.append(
        laneRunConductEntry('01JB0000000000000000000001', RUN_ID, 'merged', NOW),
      ),
    ).toMatchObject({ outcome: 'appended' });

    // Rewire the reap onto real adapters with a local executor: the recorded
    // host resolves to this machine's LocalExecutor, so the whole removal —
    // git list, status, manifest gate, `git worktree remove` — is real.
    const workspace = new WorkspaceAdapter({
      executorForRecordedHost: () => ({ ok: true, executor: new LocalExecutor() }),
    });
    const attemptArtifact = new AttemptArtifactAdapter({
      executorForRecordedHost: () => ({ ok: true, executor: new LocalExecutor() }),
    });
    const actionAuthorization = new ActionAuthorizationAdapter({
      authorizeUnsealedWorktreeRemoval: unsealedWorktreeRemovalAuthorizer({
        coordination: runtime.coordination,
        coordinationRequestRepository: runtime.coordination.coordinationRequestRepository,
      }),
    });
    (runtime.conductor as { reapLaneWorktrees: ReapLaneWorktreesUseCase }).reapLaneWorktrees =
      new ReapLaneWorktreesUseCase({
      workOrderRepo: runtime.execution.workOrderRepository,
      attemptRepo: runtime.execution.attemptRepository,
      runRepo: runtime.conductor.laneRunRepository,
      runJournal: runtime.conductor.laneRunJournal,
      executionJournal: runtime.execution.executionJournal,
      profileRead: runtime.conductor.profileRead,
      workspace,
      attemptArtifact,
      actionAuthorization,
      // The reap gate requires a runner resolver; this fixture's recorded host
      // has no real runner seat, so the resolver answers idle for any host.
      runnerForAttempt: {
        runnerForAttempt: () => ({
          ok: true,
          runner: {
            async inspectWorktreeRun() {
              return { state: 'idle' };
            },
          } as never,
        }),
      },
    });
    return { runtime, root, clonePath, worktreeRoot, worktreePath, head, privateKey };  }

  async function seedScopedApproval(
    s: Awaited<ReturnType<typeof setupReal>>,
  ): Promise<void> {
    await seedSignedOwnerApproval({
      runtime: s.runtime,
      worktreePath: s.worktreePath,
      head: s.head,
      privateKey: s.privateKey,
      stateDir: tempStateDirs2[tempStateDirs2.length - 1]!,
    });
  }

  it('refuses an uncollected attempt with artifacts not collected and keeps the worktree', async () => {
    const s = await setupReal();
    const result = await runConductor(s.runtime, ['reap', '--worktrees', '--yes']);
    expect(result.code).toBe(1);
    const doc = JSON.parse(result.stdout[0]!) as {
      refused: { runId: string; reason: string }[];
    };
    expect(doc.refused).toEqual([{ runId: RUN_ID, reason: 'artifacts not collected' }]);
    await expect(fs.stat(s.worktreePath)).resolves.toBeTruthy();
  });

  it('refuses --force-unsealed without a signed owner decision and keeps the worktree', async () => {
    const s = await setupReal();
    const result = await runConductor(s.runtime, ['reap', '--worktrees', '--yes', '--force-unsealed']);
    expect(result.code).toBe(1);
    const doc = JSON.parse(result.stdout[0]!) as {
      refused: { runId: string; reason: string }[];
    };
    expect(doc.refused).toEqual([{ runId: RUN_ID, reason: 'unapproved-force-unsealed' }]);
    await expect(fs.stat(s.worktreePath)).resolves.toBeTruthy();
  });

  it('removes a clean unsealed worktree with a signed owner decision, consumes the grant once, and journals approvalRef', async () => {
    const s = await setupReal();
    await seedScopedApproval(s);
    const result = await runConductor(s.runtime, ['reap', '--worktrees', '--yes', '--force-unsealed']);
    expect(result.code).toBe(0);
    const doc = JSON.parse(result.stdout[0]!) as {
      removed: { runId: string }[];
      refused: unknown[];
    };
    expect(doc.removed).toEqual([{ runId: RUN_ID, branchTip: expect.any(String) }]);
    expect(doc.refused).toEqual([]);
    await expect(fs.stat(s.worktreePath)).rejects.toBeTruthy();
    const request = await s.runtime.coordination.coordinationRequestRepository.findRequestById('req-unsealed-1');
    expect(request!.consumptions).toHaveLength(1);
    expect(request!.consumptions[0]!.attemptId).toBe('attempt-example-1');
    const entries = await s.runtime.execution.executionJournal.listJournalEntriesForAttempt('attempt-example-1');
    const completed = entries.find((entry) => entry.status === 'completed');
    expect(completed!.detail).toContain('approvalRef=');
    expect(completed!.detail).not.toContain(s.worktreePath);
    // A second force-unsealed pass is idempotent and consumes nothing more.
    const again = await runConductor(s.runtime, ['reap', '--worktrees', '--yes', '--force-unsealed']);
    expect(again.code).toBe(0);
    const againDoc = JSON.parse(again.stdout[0]!) as { alreadyRemoved: { runId: string }[] };
    expect(againDoc.alreadyRemoved).toEqual([{ runId: RUN_ID }]);
    const requestAfter = await s.runtime.coordination.coordinationRequestRepository.findRequestById('req-unsealed-1');
    expect(requestAfter!.consumptions).toHaveLength(1);
  });

  it('recovers a crash after grant consumption: removes without a second signature or consumption', async () => {
    const s = await setupReal();
    await seedScopedApproval(s);
    // Simulate the crash: the grant was consumed for exactly this action id and
    // attempt, then the process died before the removal and its journal entry.
    const actionScope = unsealedWorktreeRemovalScope('attempt-example-1', sha256HexDigest(s.worktreePath));
    const actionId = unsealedWorktreeRemovalActionId(RUN_ID, 'attempt-example-1');
    await s.runtime.coordination.syncOneWayOwnerQuestions.syncOneWayOwnerQuestions();
    const resolved = await s.runtime.coordination.resolveActionAuthorization.resolveActionAuthorization({
      projectId: 'example-project',
      actionScope,
      expectedHeadSha: s.head,
      attemptId: 'attempt-example-1',
    });
    expect(resolved.outcome).toBe('authorized');
    const consumed = await s.runtime.coordination.recordAuthorizationConsumption.recordAuthorizationConsumption({
      consumptionId: consumptionId(actionId),
      grantId: (resolved as { grantId: string }).grantId,
      actionId,
      actionScope,
      attemptId: 'attempt-example-1',
      expectedHeadSha: s.head,
      nowIso: NOW,
    });
    expect(consumed.outcome).toBe('consumed');
    // Remove the signed decision file: a second consumption would need a new signature.
    const decisionsDir = path.join(tempStateDirs2[tempStateDirs2.length - 1]!, 'decisions');
    await fs.rm(path.join(decisionsDir, 'req-unsealed-1.json'));
    const result = await runConductor(s.runtime, ['reap', '--worktrees', '--yes', '--force-unsealed']);
    expect(result.code).toBe(0);
    const doc = JSON.parse(result.stdout[0]!) as { removed: { runId: string }[] };
    expect(doc.removed).toEqual([{ runId: RUN_ID, branchTip: expect.any(String) }]);
    await expect(fs.stat(s.worktreePath)).rejects.toBeTruthy();
    const request = await s.runtime.coordination.coordinationRequestRepository.findRequestById('req-unsealed-1');
    expect(request!.consumptions).toHaveLength(1);
  });

  it('refuses a dirty worktree under --force-unsealed without consuming the signed grant', async () => {
    const s = await setupReal();
    await seedScopedApproval(s);
    await fs.writeFile(path.join(s.worktreePath, 'untracked.txt'), 'x\n', 'utf8');
    const result = await runConductor(s.runtime, ['reap', '--worktrees', '--yes', '--force-unsealed']);
    expect(result.code).toBe(1);
    const doc = JSON.parse(result.stdout[0]!) as {
      refused: { runId: string; reason: string }[];
    };
    expect(doc.refused).toEqual([{ runId: RUN_ID, reason: 'dirty' }]);
    await expect(fs.stat(s.worktreePath)).resolves.toBeTruthy();
    const request = await s.runtime.coordination.coordinationRequestRepository.findRequestById('req-unsealed-1');
    expect(request!.consumptions).toHaveLength(0);
  });
});

// --- C2: production composition ---------------------------------------------

const RUN_B = 'run-01JB000000000000000000000B';
/** A local v2 host: the recorded runner names the host and carries no ssh alias. */
const PROD_RECORDED_HOST = {
  kind: 'opencode' as const,
  remotePort: 4166,
  host: null,
  hostName: 'lane-host',
  agent: null,
  model: null,
  variant: null,
};

function productionInstallation(worktreeRoot: string): FleetInstallation {
  return {
    schemaVersion: 2,
    hosts: {
      'lane-host': {
        transport: 'local',
        worktreeRoot,
        roles: ['orchestrator', 'lane-runner'],
        runner: { kind: 'opencode', port: 4166 },
      },
    },
    forge: { mode: 'none' },
  };
}

function laneRunRecordFor(runId: string): LaneRunRecord {
  const created = LaneRun.create({
    version: 1,
    runId,
    workOrderId: 'wo-example-1',
    tier: 2,
    seatPlanRef: 'c'.repeat(64),
    cursors: { 'first-pass': 0, fix: null, review: null },
    round: 0,
    attemptIds: ['attempt-example-1'],
    prNumber: null,
    parked: null,
    parkCount: 0,
    lease: null,
    revision: 1,
    runPolicyRevision: 'pol-1',
    branchName: `fleet/${runId}`,
  });
  if (!created.success) {
    throw new Error('fixture must be a valid LaneRun record');
  }
  return created.value.toRecord();
}

describe('conductor reap --worktrees through production composition (C2)', () => {
  const roots: string[] = [];

  afterAll(async () => {
    for (const dir of roots) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  type RunnerCall = { command: string; args: readonly string[] };
  const idleRunner = (calls: RunnerCall[] = []): SubprocessRunner => async (command, args) => {
    calls.push({ command, args });
    return { exitCode: 0, stdout: '', stderr: '' };
  };
  // `ocm-run --status` exits 3 and lists the active session under its header line.
  const activeRunner = (calls: RunnerCall[] = []): SubprocessRunner => async (command, args) => {
    calls.push({ command, args });
    return {
      exitCode: 3,
      stdout: `ocm-run: running in ${args[args.indexOf('--dir') + 1]}:\nses_active1\n`,
      stderr: '',
    };
  };

  /**
   * A real clone and linked worktree, a v2 local installation, and the
   * unmodified production `createFleetCliRuntime` composition: nothing is
   * rewired, so the reap runs the composed use case, workspace, artifact
   * adapter, runner resolver and authorizer.
   */
  async function setupProduction(options: { runSubprocess: SubprocessRunner; sealed: boolean }) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-reap-c2-'));
    roots.push(root);
    const clonePath = path.join(root, 'clone');
    const worktreeRoot = path.join(root, 'worktrees');
    const worktreePath = path.join(worktreeRoot, 'wt1');
    const stateDir = path.join(root, 'state');
    await fs.mkdir(clonePath);
    await fs.mkdir(stateDir);
    await execGit(['init'], clonePath);
    await fs.writeFile(path.join(clonePath, 'README.md'), '# fleet test\n', 'utf8');
    await execGit(['add', '.'], clonePath);
    await execGit(['commit', '-m', 'initial commit'], clonePath);
    const head = (await execGit(['rev-parse', 'HEAD'], clonePath)).stdout.trim();
    await fs.mkdir(worktreeRoot);
    await execGit(['worktree', 'add', '-b', `fleet/${RUN_ID}`, worktreePath, head], clonePath);
    await fs.appendFile(path.join(clonePath, '.git', 'info', 'exclude'), '\n.lane/\n', 'utf8');
    await fs.mkdir(path.join(worktreePath, '.lane'));
    await fs.writeFile(path.join(worktreePath, '.lane', 'notes.md'), 'notes\n', 'utf8');

    const { publicKeyBase64, privateKey } = createOwnerKeyPair();
    const runtime = createFleetCliRuntime({
      stateDir,
      ownerPublicKey: publicKeyBase64,
      installation: productionInstallation(worktreeRoot),
      runSubprocess: options.runSubprocess,
      env: {},
    });
    const profile = await runtime.coordination.registerProjectProfile.execute({
      projectId: 'example-project',
      displayName: 'Example Project',
      repository: 'https://example.com/example.git',
      designatedDispatcherHost: 'lane-host',
      policyRevision: 'pol-1',
      maxConcurrentLanes: 2,
      runnerCapabilities: { networkEgressRestricted: true },
      clones: { 'lane-host': { path: clonePath, worktreeRoot } },
    });
    expect(profile).toMatchObject({ outcome: 'registered' });
    await runtime.execution.workOrderRepository.saveWorkOrder({
      id: 'wo-example-1',
      projectId: 'example-project',
      taskId: 'task-1',
      laneId: 'lane-1',
      repository: 'https://example.com/example.git',
      baseCommit: COMMIT,
      ownedPaths: ['packages/example'],
      policyRevision: 'pol-1',
      prerequisiteWorkOrderIds: [],
      state: 'merged',
      revision: 1,
      createdAtIso: NOW,
      updatedAtIso: NOW,
      risk: 'standard',
    });
    let artifacts = null;
    if (options.sealed) {
      const sealed = await runtime.execution.attemptArtifact.sealArtifactManifest({
        attemptId: 'attempt-example-1',
        worktreePath,
        artifactPaths: ['.lane/notes.md'],
        recordedHost: PROD_RECORDED_HOST,
      });
      if (sealed.outcome !== 'sealed') {
        throw new Error(`fixture must seal a manifest: ${sealed.reason}`);
      }
      artifacts = {
        headCommit: head,
        commitsSinceBase: [],
        collectedArtifactPaths: ['.lane/notes.md'],
        notes: 'present' as const,
        manifestPath: sealed.manifestPath,
        manifestSha256: sealed.manifestSha256,
      };
    }
    await runtime.execution.attemptRepository.saveAttempt({
      id: 'attempt-example-1',
      workOrderId: 'wo-example-1',
      kind: 'initial',
      fixNumber: 0,
      priorAttemptId: null,
      worktreePath,
      baseCommit: COMMIT,
      state: 'collected',
      outcome: null,
      briefDigest: 'b'.repeat(64),
      briefPackagePath: '.lane/brief-package',
      sessionId: null,
      completionReceipt: null,
      artifacts,
      runner: PROD_RECORDED_HOST,
      createdAtIso: NOW,
      updatedAtIso: NOW,
    });
    expect(await runtime.conductor.laneRunRepository.create(laneRunRecordFor(RUN_ID))).toMatchObject({
      outcome: 'saved',
    });
    expect(
      await runtime.conductor.laneRunJournal.append(
        laneRunConductEntry('01JB0000000000000000000001', RUN_ID, 'merged', NOW),
      ),
    ).toMatchObject({ outcome: 'appended' });
    return { runtime, stateDir, root, clonePath, worktreeRoot, worktreePath, head, privateKey };
  }

  type Production = Awaited<ReturnType<typeof setupProduction>>;

  interface ReapDoc {
    outcome: string;
    removed: { runId: string; branchTip: string | null }[];
    alreadyRemoved: { runId: string }[];
    refused: { runId: string; reason: string }[];
  }

  async function reapDoc(s: Production, extraFlags: readonly string[] = []) {
    const result = await runConductor(s.runtime, ['reap', '--worktrees', '--yes', ...extraFlags], s.stateDir);
    return { code: result.code, doc: JSON.parse(result.stdout[0]!) as ReapDoc };
  }

  async function consumptionsOf(s: Production): Promise<number> {
    const request = await s.runtime.coordination.coordinationRequestRepository.findRequestById('req-unsealed-1');
    return request === null ? 0 : request.consumptions.length;
  }

  const exists = (target: string) =>
    fs.stat(target).then(
      () => true,
      () => false,
    );

  it('removes a real git worktree through production composition when its sealed artifact manifest verifies, and refuses when tampered', async () => {
    const runnerCalls: RunnerCall[] = [];
    const s = await setupProduction({ runSubprocess: idleRunner(runnerCalls), sealed: true });
    const notes = path.join(s.worktreePath, '.lane', 'notes.md');

    await fs.writeFile(notes, 'tampered\n', 'utf8');
    const tampered = await reapDoc(s);
    expect(tampered.code).toBe(1);
    expect(tampered.doc.removed).toEqual([]);
    expect(tampered.doc.refused).toEqual([{ runId: RUN_ID, reason: 'artifacts changed since collection' }]);
    expect(await exists(s.worktreePath)).toBe(true);

    await fs.writeFile(notes, 'notes\n', 'utf8');
    const removed = await reapDoc(s);
    expect(removed.code).toBe(0);
    expect(removed.doc.removed).toEqual([{ runId: RUN_ID, branchTip: s.head }]);
    expect(removed.doc.refused).toEqual([]);
    expect(await exists(s.worktreePath)).toBe(false);
    // The runner was asked about this worktree before every removal attempt.
    expect(runnerCalls.length).toBeGreaterThanOrEqual(2);
    expect(runnerCalls[0]!.args).toEqual(['--status', '--dir', s.worktreePath]);

    // The branch is the record of the run and is kept at its tip.
    const branchTip = (await execGit(['rev-parse', `refs/heads/fleet/${RUN_ID}`], s.clonePath)).stdout.trim();
    expect(branchTip).toBe(s.head);

    const entries = await s.runtime.execution.executionJournal.listJournalEntriesForAttempt('attempt-example-1');
    const completed = entries.filter((entry) => entry.status === 'completed');
    expect(completed).toHaveLength(1);
    expect(completed[0]!.detail).toContain(`fleet/${RUN_ID} kept at ${s.head}`);
    for (const entry of entries) {
      for (const hostPath of [s.worktreePath, s.clonePath, s.worktreeRoot, s.root]) {
        expect(entry.detail).not.toContain(hostPath);
      }
    }
  });

  it('refuses --force-unsealed with busy through production composition when the runner reports an active session, without consuming the owner grant', async () => {
    const s = await setupProduction({ runSubprocess: activeRunner(), sealed: false });
    await seedSignedOwnerApproval(s);
    const { code, doc } = await reapDoc(s, ['--force-unsealed']);
    expect(code).toBe(1);
    expect(doc.removed).toEqual([]);
    expect(doc.refused).toEqual([{ runId: RUN_ID, reason: 'busy' }]);
    expect(await exists(s.worktreePath)).toBe(true);
    expect(await consumptionsOf(s)).toBe(0);
    const entries = await s.runtime.execution.executionJournal.listJournalEntriesForAttempt('attempt-example-1');
    expect(entries).toEqual([]);
  });

  it('refuses unknown through production composition when the runner cannot prove the worktree idle', async () => {
    const s = await setupProduction({
      runSubprocess: async () => ({ exitCode: 2, stdout: '', stderr: 'runner unreachable' }),
      sealed: true,
    });
    const { code, doc } = await reapDoc(s);
    expect(code).toBe(1);
    expect(doc.refused).toEqual([{ runId: RUN_ID, reason: 'unknown' }]);
    expect(await exists(s.worktreePath)).toBe(true);
  });

  it('refuses intent-digest-mismatch through production composition when a crashed force-unsealed intent is retried under a changed runId', async () => {
    const s = await setupProduction({ runSubprocess: idleRunner(), sealed: false });
    // First pass: no owner decision exists yet, so the pass stops after the
    // intent entry is recorded.
    const first = await reapDoc(s, ['--force-unsealed']);
    expect(first.code).toBe(1);
    expect(first.doc.refused).toEqual([{ runId: RUN_ID, reason: 'unapproved-force-unsealed' }]);
    const afterFirst = await s.runtime.execution.executionJournal.listJournalEntriesForAttempt('attempt-example-1');
    expect(afterFirst).toHaveLength(1);
    expect(afterFirst[0]).toMatchObject({ status: 'intent-recorded', id: `attempt-example-1:collect:reap-unsealed-intent:${RUN_ID}` });
    const recordedDigest = /requestDigest=([0-9a-f]{64})$/.exec(afterFirst[0]!.detail ?? '')?.[1];
    expect(recordedDigest).toBe(
      unsealedRemovalRequestDigest(
        {
          attemptId: 'attempt-example-1',
          expectedHeadSha: s.head,
          projectId: 'example-project',
          repositoryRoot: s.clonePath,
          runId: RUN_ID,
          worktreePath: s.worktreePath,
          worktreeRoot: s.worktreeRoot,
        },
        sha256HexDigest,
      ),
    );
    expect(afterFirst[0]!.detail).not.toContain(s.worktreePath);
    expect(afterFirst[0]!.detail).not.toContain(s.root);

    // The attempt moves onto a second merged run: the worktree's branch now
    // belongs to RUN_B, and a signed approval exists for it.
    await execGit(['branch', '-m', `fleet/${RUN_ID}`, `fleet/${RUN_B}`], s.worktreePath);
    expect(await s.runtime.conductor.laneRunRepository.create(laneRunRecordFor(RUN_B))).toMatchObject({
      outcome: 'saved',
    });
    expect(
      await s.runtime.conductor.laneRunJournal.append(
        laneRunConductEntry('01JB0000000000000000000003', RUN_B, 'merged', NOW),
      ),
    ).toMatchObject({ outcome: 'appended' });
    await seedSignedOwnerApproval(s);

    const second = await reapDoc(s, ['--force-unsealed']);
    expect(second.code).toBe(1);
    expect(second.doc.removed).toEqual([]);
    expect(second.doc.refused).toEqual([
      { runId: RUN_ID, reason: 'branch-mismatch' },
      { runId: RUN_B, reason: 'intent-digest-mismatch' },
    ]);
    expect(await consumptionsOf(s)).toBe(0);
    const afterSecond = await s.runtime.execution.executionJournal.listJournalEntriesForAttempt('attempt-example-1');
    expect(afterSecond).toEqual(afterFirst);
    expect(await exists(s.worktreePath)).toBe(true);
  });

  describe('unsealedWorktreeRemovalAuthorizer', () => {
    const VALID_REQUEST = {
      projectId: 'example-project',
      runId: RUN_ID,
      attemptId: 'attempt-example-1',
      worktreePath: '/srv/fleet/worktrees/wt1',
      expectedHeadSha: COMMIT,
      nowIso: NOW,
    };

    function authorizerWith(listed: () => unknown) {
      const calls = { sync: 0, list: 0, find: 0, resolve: 0, consume: 0 };
      const deps = {
        coordination: {
          syncOneWayOwnerQuestions: {
            syncOneWayOwnerQuestions: async () => {
              calls.sync += 1;
            },
          },
          listOwnerQuestions: {
            listOwnerQuestions: async () => {
              calls.list += 1;
              return listed();
            },
          },
          resolveActionAuthorization: {
            resolveActionAuthorization: async () => {
              calls.resolve += 1;
              return { outcome: 'refused' };
            },
          },
          recordAuthorizationConsumption: {
            recordAuthorizationConsumption: async () => {
              calls.consume += 1;
              return { outcome: 'refused' };
            },
          },
        },
        coordinationRequestRepository: {
          findRequestById: async () => {
            calls.find += 1;
            return null;
          },
        },
      };
      return { authorize: unsealedWorktreeRemovalAuthorizer(deps as never), calls };
    }

    const throwingField = (field: string): unknown =>
      Object.defineProperty({}, field, {
        enumerable: true,
        get() {
          throw new Error('getter exploded');
        },
      });

    it('handles null, throwing getters, sparse arrays, and oversized question lists without throwing', async () => {
      // Hostile requests are blocked before any store is touched.
      const hostileRequests: unknown[] = [
        null,
        undefined,
        42,
        'request',
        [],
        throwingField('projectId'),
        new Proxy({}, { getPrototypeOf: () => { throw new Error('proxy exploded'); } }),
        { ...VALID_REQUEST, projectId: undefined },
        { ...VALID_REQUEST, runId: 7 },
        { ...VALID_REQUEST, attemptId: null },
        { ...VALID_REQUEST, worktreePath: `/${'w'.repeat(4096)}` },
        { ...VALID_REQUEST, expectedHeadSha: 'not-a-sha' },
        { ...VALID_REQUEST, expectedHeadSha: 'A'.repeat(40) },
        { ...VALID_REQUEST, nowIso: 'not-a-date' },
        { ...VALID_REQUEST, nowIso: '2026-02-30T00:00:00.000Z' },
        { ...VALID_REQUEST, nowIso: undefined },
      ];
      const untouched = authorizerWith(() => ({ questions: [] }));
      for (const request of hostileRequests) {
        await expect(untouched.authorize(request as never)).resolves.toEqual({
          outcome: 'blocked',
          reason: 'invalid-request',
        });
      }
      expect(untouched.calls).toEqual({ sync: 0, list: 0, find: 0, resolve: 0, consume: 0 });

      // An unreadable list is unknown, never an empty scan.
      for (const listed of [null, undefined, 'questions', {}, { questions: 'nope' }, { questions: { length: 1 } }]) {
        const { authorize, calls } = authorizerWith(() => listed);
        await expect(authorize(VALID_REQUEST)).resolves.toEqual({
          outcome: 'unknown',
          reason: 'owner-question-sync-failed',
        });
        expect(calls.find).toBe(0);
      }
      const syncThrows = authorizerWith(() => ({ questions: [] }));
      const throwingDeps = {
        coordination: {
          syncOneWayOwnerQuestions: {
            syncOneWayOwnerQuestions: async () => {
              throw new Error('sync failed');
            },
          },
        },
        coordinationRequestRepository: {},
      };
      await expect(
        unsealedWorktreeRemovalAuthorizer(throwingDeps as never)(VALID_REQUEST),
      ).resolves.toEqual({ outcome: 'unknown', reason: 'owner-question-sync-failed' });
      expect(syncThrows.calls.sync).toBe(0);

      // An oversized list is refused unscanned.
      const oversized = authorizerWith(() => ({ questions: new Array(4097).fill(null) }));
      await expect(oversized.authorize(VALID_REQUEST)).resolves.toEqual({
        outcome: 'unknown',
        reason: 'owner-question-list-too-large',
      });
      expect(oversized.calls.find).toBe(0);

      // The largest allowed list of junk is scanned and finds no approval.
      const atLimit = authorizerWith(() => ({ questions: new Array(4096).fill(null) }));
      await expect(atLimit.authorize(VALID_REQUEST)).resolves.toEqual({
        outcome: 'blocked',
        reason: 'no-scoped-owner-approval',
      });
      expect(atLimit.calls.find).toBe(0);

      // Sparse holes, primitives, throwing records and malformed answers are skipped, never read.
      const sparse: unknown[] = new Array(8);
      sparse[1] = 'junk';
      sparse[3] = throwingField('doorKind');
      sparse[4] = new Proxy({}, { getPrototypeOf: () => { throw new Error('proxy exploded'); } });
      sparse[5] = { doorKind: 'one-way', state: 'answered', questionId: 'oq-1', linkedRequestId: 7, answer: null };
      sparse[6] = {
        doorKind: 'one-way',
        state: 'answered',
        questionId: 'oq-2',
        linkedRequestId: 'req-2',
        answer: throwingField('shape'),
      };
      sparse[7] = {
        doorKind: 'one-way',
        state: 'answered',
        questionId: 'oq-3',
        linkedRequestId: 'req-3',
        answer: { shape: 'reject', answeredVia: 'signed-decision' },
      };
      const sparseCase = authorizerWith(() => ({ questions: sparse }));
      await expect(sparseCase.authorize(VALID_REQUEST)).resolves.toEqual({
        outcome: 'blocked',
        reason: 'no-scoped-owner-approval',
      });
      expect(sparseCase.calls.find).toBe(0);
      expect(sparseCase.calls.consume).toBe(0);

      // A well-formed accepted question reaches the request lookup, which here finds nothing.
      const accepted = authorizerWith(() => ({
        questions: [
          {
            doorKind: 'one-way',
            state: 'answered',
            questionId: 'oq-4',
            linkedRequestId: 'req-4',
            answer: { shape: 'accept', answeredVia: 'signed-decision' },
          },
        ],
      }));
      await expect(accepted.authorize(VALID_REQUEST)).resolves.toEqual({
        outcome: 'blocked',
        reason: 'no-scoped-owner-approval',
      });
      expect(accepted.calls.find).toBe(1);
      expect(accepted.calls.consume).toBe(0);
    });
  });

  it('composition guard: no CLI composition module or use case other than ReapLaneWorktreesUseCase invokes removeWorktree or removeLaneWorktree', () => {
    const srcDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const sources: string[] = [path.join(srcDir, 'composition.ts')];
    const visit = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const full = path.join(dir, name);
        if (statSync(full).isDirectory()) {
          if (name !== '__tests__') {
            visit(full);
          }
        } else if (name.endsWith('.ts') && !name.endsWith('.test.ts')) {
          sources.push(full);
        }
      }
    };
    visit(path.join(srcDir, 'composition'));
    expect(sources.length).toBeGreaterThan(5);
    const offenders = sources.filter((file) => /removeWorktree|removeLaneWorktree/.test(readFileSync(file, 'utf8')));
    expect(offenders).toEqual([]);
    // The one composition that builds a reap hands it to the one use case.
    const builders = sources.filter((file) => readFileSync(file, 'utf8').includes('new ReapLaneWorktreesUseCase('));
    expect(builders.map((file) => path.basename(file))).toEqual(['conductor.ts']);
    // K11b' stays cut: the zombie reaper is not composed into the conductor yet.
    const conductorSource = readFileSync(path.join(srcDir, 'composition', 'conductor.ts'), 'utf8');
    expect(conductorSource).not.toContain('ReapZombiesUseCase');
  });
});
