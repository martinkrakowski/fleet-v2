/**
 * CO29a: `relaunch plan` through the production composition. The runtime is the
 * real `createFleetCliRuntime` over a real temporary state directory, a local
 * git clone with real linked worktrees, and a v2 installation whose local host
 * answers the runner state through a Node stand-in for the bundled `ocm-run`
 * (`--status` only). Nothing is mocked except that stand-in's answers.
 */

import { execFile } from 'node:child_process';
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';

import { afterAll, describe, expect, it } from 'vitest';

import { parseInstallation, type FleetInstallation } from '@fleet/installation';
import { LaneRun, type PlanRelaunchResult, type RelaunchPlanRecord } from '@fleet/work-execution';

import { createFleetCliRuntime, type FleetCliRuntime } from '../composition.js';
import { runCli, type CliIo } from '../index.js';

const execFileAsync = promisify(execFile);

const NOW = '2026-11-07T00:00:00.000Z';
const RUN_ID = 'run-01JC000000000000000000000A';
const COMMIT = 'a'.repeat(40);
const HOST = 'lane-host';
const RUNNER_PORT = 46_000;

const roots: string[] = [];

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** The `ocm-run --status` stand-in: `run-*` directories run their own session, `broken-*` ones cannot be told. */
const FAKE_OCM_RUN = `#!/usr/bin/env node
const args = process.argv.slice(2);
const dir = args[args.indexOf('--dir') + 1] ?? '';
const name = dir.split('/').pop() ?? '';
if (!args.includes('--status')) process.exit(64);
if (name.startsWith('broken-')) process.exit(1);
if (name.startsWith('run-')) {
  process.stdout.write('ocm-run: running in ' + dir + ':\\nses_' + name.replace(/[^A-Za-z0-9]/g, '_') + '\\n');
  process.exit(3);
}
process.exit(0);
`;

function installation(root: string): FleetInstallation {
  const parsed = parseInstallation({
    schemaVersion: 2,
    forge: { mode: 'none' },
    hosts: {
      [HOST]: {
        transport: 'local',
        worktreeRoot: path.join(root, 'worktrees'),
        roles: ['orchestrator', 'lane-runner', 'verifier'],
        runner: { kind: 'opencode', port: RUNNER_PORT },
      },
    },
  });
  if (!parsed.ok || parsed.installation === undefined) throw new Error('installation fixture failed to parse');
  return parsed.installation;
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(
    'git',
    ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', ...args],
    { cwd, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } },
  );
  return stdout;
}

interface Fixture {
  readonly root: string;
  readonly stateDir: string;
  readonly clonePath: string;
  readonly worktreeRoot: string;
  readonly runtime: FleetCliRuntime;
}

async function fixture(worktrees: readonly string[]): Promise<Fixture> {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'fleet-v2-relaunch-plan-')));
  roots.push(root);
  const stateDir = path.join(root, 'state');
  const clonePath = path.join(root, 'clone');
  const worktreeRoot = path.join(root, 'worktrees');
  await fs.mkdir(stateDir, { recursive: true });
  await fs.mkdir(clonePath, { recursive: true });
  await fs.mkdir(worktreeRoot, { recursive: true });
  await git(clonePath, 'init', '--quiet', '-b', 'main');
  await fs.writeFile(path.join(clonePath, 'README.md'), 'fixture\n');
  await git(clonePath, 'add', 'README.md');
  await git(clonePath, 'commit', '--quiet', '-m', 'fixture');
  for (const name of worktrees) {
    await git(clonePath, 'worktree', 'add', '--quiet', '-b', `fleet/${name}`, path.join(worktreeRoot, name));
  }
  const ocmRunBin = path.join(root, 'ocm-run');
  writeFileSync(ocmRunBin, FAKE_OCM_RUN);
  chmodSync(ocmRunBin, 0o755);
  const runtime = createFleetCliRuntime({ stateDir, installation: installation(root), ocmRunBin });
  const registered = await runtime.coordination.registerProjectProfile.execute({
    projectId: 'proj-1',
    displayName: 'Project One',
    repository: 'https://example.com/example.git',
    designatedDispatcherHost: HOST,
    policyRevision: 'pol-1',
    maxConcurrentLanes: 4,
    runnerCapabilities: { networkEgressRestricted: true },
    clones: { [HOST]: { path: clonePath, worktreeRoot } },
  });
  expect(registered.outcome).toBe('registered');
  return { root, stateDir, clonePath, worktreeRoot, runtime };
}

async function seedWorkOrder(
  runtime: FleetCliRuntime,
  id: string,
  extra: { readonly ownedPaths: string[]; readonly baseBranch?: 'main' | `chain/${string}`; readonly prerequisiteWorkOrderIds?: string[] },
): Promise<void> {
  await runtime.execution.workOrderRepository.saveWorkOrder({
    id,
    projectId: 'proj-1',
    taskId: `task-${id}`,
    laneId: `lane-${id}`,
    repository: 'https://example.com/example.git',
    baseCommit: COMMIT,
    ownedPaths: extra.ownedPaths,
    policyRevision: 'pol-1',
    prerequisiteWorkOrderIds: extra.prerequisiteWorkOrderIds ?? [],
    state: 'implementing',
    revision: 1,
    createdAtIso: NOW,
    updatedAtIso: NOW,
    risk: 'standard',
    ...(extra.baseBranch !== undefined ? { baseBranch: extra.baseBranch } : {}),
  });
}

async function seedAttempt(
  runtime: FleetCliRuntime,
  fx: Pick<Fixture, 'worktreeRoot'>,
  id: string,
  workOrderId: string,
  worktreeName: string,
): Promise<void> {
  await runtime.execution.attemptRepository.saveAttempt({
    id,
    workOrderId,
    kind: 'initial',
    fixNumber: 0,
    priorAttemptId: null,
    worktreePath: path.join(fx.worktreeRoot, worktreeName),
    baseCommit: COMMIT,
    state: 'running',
    outcome: null,
    briefDigest: 'b'.repeat(64),
    briefPackagePath: '.lane/brief-package',
    sessionId: `ses_${worktreeName.replace(/[^A-Za-z0-9]/g, '_')}`,
    completionReceipt: null,
    artifacts: null,
    runner: {
      kind: 'opencode',
      remotePort: RUNNER_PORT,
      host: null,
      hostName: HOST,
      agent: null,
      model: null,
      variant: null,
    },
    createdAtIso: NOW,
    updatedAtIso: NOW,
  });
}

async function seedRun(runtime: FleetCliRuntime, workOrderId: string, attemptId: string): Promise<void> {
  const created = LaneRun.create({
    version: 1,
    runId: RUN_ID,
    workOrderId,
    tier: 2,
    seatPlanRef: 'c'.repeat(64),
    cursors: { 'first-pass': 0, fix: null, review: null },
    round: 0,
    attemptIds: [attemptId],
    prNumber: null,
    parked: null,
    parkCount: 0,
    lease: null,
    revision: 1,
    runPolicyRevision: 'pol-1',
    branchName: `fleet/${RUN_ID}`,
  });
  if (!created.success) throw new Error('fixture must be a valid LaneRun record');
  expect(await runtime.conductor.laneRunRepository.create(created.value.toRecord())).toMatchObject({ outcome: 'saved' });
}

interface Captured extends CliIo {
  readonly out: string[];
  readonly err: string[];
}

function capture(): Captured {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, stdout: (text) => out.push(text), stderr: (text) => err.push(text) };
}

/** Every file and directory name under the state dir (recursive), sorted: the plan's on-disk footprint. */
async function snapshotState(dir: string): Promise<string[]> {
  const names = await fs.readdir(dir, { recursive: true });
  return names.sort((a, b) => a.localeCompare(b));
}

/** Every file under the state dir (recursive) with its size in bytes, sorted: names and bytes must not change. */
async function snapshotStateWithSizes(dir: string): Promise<string[]> {
  const names = await fs.readdir(dir, { recursive: true });
  const rows: string[] = [];
  for (const name of names) {
    const stat = await fs.lstat(path.join(dir, name));
    rows.push(`${name}\t${stat.isDirectory() ? 'dir' : String(stat.size)}`);
  }
  return rows.sort((a, b) => a.localeCompare(b));
}

async function plan(
  runtime: FleetCliRuntime,
  ...flags: string[]
): Promise<{ code: number; result: PlanRelaunchResult; stdout: string; stderr: string }> {
  const io = capture();
  const code = await runCli(['relaunch', 'plan', '--now', NOW, ...flags], io, runtime);
  const stdout = io.out.join('');
  return { code, result: JSON.parse(stdout) as PlanRelaunchResult, stdout, stderr: io.err.join('') };
}

/** Everything the plan seeds: a conducted run, a chain of two attempts, a clashing attempt and a free worktree. */
async function seededFixture(): Promise<Fixture> {
  const fx = await fixture([RUN_ID, 'run-head', 'run-tail', 'run-clash', 'free-one']);
  const { runtime } = fx;
  await seedWorkOrder(runtime, 'wo-cond', { ownedPaths: ['packages/conducted-pkg'] });
  await seedWorkOrder(runtime, 'wo-head', { ownedPaths: ['packages/pkg-head'], baseBranch: 'chain/feat' });
  await seedWorkOrder(runtime, 'wo-tail', {
    ownedPaths: ['packages/pkg-tail'],
    baseBranch: 'chain/feat',
    prerequisiteWorkOrderIds: ['wo-head'],
  });
  await seedWorkOrder(runtime, 'wo-clash', { ownedPaths: ['packages/pkg-head/src'] });
  // The conducted run's worktree carries the run's own branch, which proves its claim; the runner is
  // not asked about its session, so its attempt records the stand-in's session for the directory.
  await seedAttempt(runtime, fx, 'attempt-cond', 'wo-cond', RUN_ID);
  await seedAttempt(runtime, fx, 'attempt-head', 'wo-head', 'run-head');
  await seedAttempt(runtime, fx, 'attempt-tail', 'wo-tail', 'run-tail');
  await seedAttempt(runtime, fx, 'attempt-clash', 'wo-clash', 'run-clash');
  await seedRun(runtime, 'wo-cond', 'attempt-cond');
  return fx;
}

describe('relaunch plan (production composition)', () => {
  it('plans and persists an ordered idempotent relaunch plan end-to-end through createFleetCliRuntime and runCli', async () => {
    const fx = await seededFixture();
    const first = await plan(fx.runtime, '--dispatch-stagger-ms', '1000');

    expect(first.code).toBe(0);
    expect(first.result.outcome).toBe('planned');
    if (first.result.outcome !== 'planned') throw new Error('unreachable');
    expect(first.result.reused).toBe(false);
    const record: RelaunchPlanRecord = first.result.plan;

    // Conducted first (wave 0, no step: D-CO10), then the chain head, then the lanes by id, the free worktree last.
    const unrecordedId = record.lanes[record.lanes.length - 1].laneId;
    expect(unrecordedId).toMatch(/^worktree-[0-9a-f]{12}$/);
    expect(record.lanes.map((lane) => lane.laneId)).toEqual([
      RUN_ID,
      'attempt-head',
      'attempt-clash',
      'attempt-tail',
      unrecordedId,
    ]);
    expect(record.lanes.map((lane) => lane.population)).toEqual([
      'conducted',
      'attempt-recorded',
      'attempt-recorded',
      'attempt-recorded',
      'unrecorded',
    ]);
    expect(record.lanes.map((lane) => lane.steps.map((step) => step.step))).toEqual([
      [],
      ['save', 'abort', 'adopt', 'redispatch'],
      ['save', 'abort', 'adopt', 'redispatch'],
      ['save', 'abort', 'adopt', 'redispatch'],
      ['save', 'adopt', 'redispatch'],
    ]);
    expect(record.lanes.map((lane) => lane.chainHead)).toEqual([false, true, false, false, false]);
    expect(record.lanes.map((lane) => lane.dependsOnLaneIds)).toEqual([[], [], [], ['attempt-head'], []]);
    // Waves: head with the conducted run; the clash over pkg-head waits; the tail follows its head; the free
    // worktree has no work order, so it shares a wave with no lane of its project.
    expect(record.lanes.map((lane) => lane.admissionWave)).toEqual([0, 1, 2, 2, 3]);
    expect(record.lanes.map((lane) => lane.staggerOffsetMs)).toEqual([null, 0, 1000, 2000, 3000]);
    expect(record.lanes.map((lane) => lane.dispatchEndpointKey)).toEqual([
      null,
      `opencode:${HOST}:${RUNNER_PORT}`,
      `opencode:${HOST}:${RUNNER_PORT}`,
      `opencode:${HOST}:${RUNNER_PORT}`,
      `opencode:${HOST}:${RUNNER_PORT}`,
    ]);
    expect(record.lanes.map((lane) => lane.runnerState)).toEqual(['running', 'running', 'running', 'running', 'idle']);
    expect(record.lanes.map((lane) => lane.baseBranch)).toEqual(['main', 'chain/feat', 'main', 'chain/feat', 'main']);
    expect(record.lanes[4]).toMatchObject({ projectId: 'proj-1', workOrderId: null, runId: null, attemptId: null });
    for (const lane of record.lanes) {
      for (const step of lane.steps) {
        expect(step.idempotencyKey).toBe(`relaunch/${record.planDigest}/${lane.laneId}/${step.step}`);
      }
    }

    // Persisted: one record in relaunch-plans.json, found by digest through a fresh runtime over the same state.
    const stored = JSON.parse(await fs.readFile(path.join(fx.stateDir, 'relaunch-plans.json'), 'utf8')) as unknown[];
    expect(stored).toHaveLength(1);
    const reopened = createFleetCliRuntime({ stateDir: fx.stateDir });
    expect(await reopened.execution.relaunchPlanRepository.findByDigest(record.planDigest)).toEqual({ outcome: 'found', plan: record });

    // No path, state directory or secret in stdout, stderr or the stored file.
    const storedText = await fs.readFile(path.join(fx.stateDir, 'relaunch-plans.json'), 'utf8');
    for (const text of [first.stdout, first.stderr, storedText]) {
      expect(text).not.toContain(fx.root);
      expect(text).not.toMatch(/worktreePath|clonePath|worktreeRoot|stateDir/);
    }

    // The same state planned later is the same plan: reused, nothing written.
    const before = await fs.readFile(path.join(fx.stateDir, 'relaunch-plans.json'));
    const io = capture();
    const code = await runCli(['relaunch', 'plan', '--now', '2026-11-08T10:00:00.000Z', '--dispatch-stagger-ms', '1000'], io, fx.runtime);
    const second = JSON.parse(io.out.join('')) as PlanRelaunchResult;
    expect(code).toBe(0);
    expect(second).toMatchObject({ outcome: 'planned', reused: true, planDigest: record.planDigest });
    expect((await fs.readFile(path.join(fx.stateDir, 'relaunch-plans.json'))).equals(before)).toBe(true);

    // Another request over the same lanes (a lower cap) is another plan.
    const capped = await plan(fx.runtime, '--dispatch-stagger-ms', '1000', '--max-active-runs', '2');
    expect(capped.code).toBe(0);
    expect(capped.result).toMatchObject({ outcome: 'planned', reused: false });
    if (capped.result.outcome === 'planned') {
      expect(capped.result.planDigest).not.toBe(record.planDigest);
      expect(capped.result.plan.lanes.map((lane) => lane.admissionWave)).toEqual([0, 1, 2, 2, 3]);
    }
  });

  it('relaunch plan through production composition leaves git refs, status, and hooks untouched', async () => {
    const fx = await seededFixture();
    const hookMarker = path.join(fx.root, 'hook-ran');
    const hooksDir = path.join(fx.clonePath, '.git', 'hooks');
    for (const hook of ['reference-transaction', 'post-checkout', 'pre-commit', 'post-merge']) {
      const file = path.join(hooksDir, hook);
      writeFileSync(file, `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(hookMarker)}, 'ran');\n`);
      chmodSync(file, 0o755);
    }

    const snapshot = async (): Promise<Record<string, string>> => {
      const out: Record<string, string> = {
        refs: await git(fx.clonePath, 'for-each-ref', '--format=%(refname) %(objectname)'),
        worktrees: await git(fx.clonePath, 'worktree', 'list', '--porcelain'),
        status: await git(fx.clonePath, 'status', '--porcelain=v1', '--ignored'),
        config: await fs.readFile(path.join(fx.clonePath, '.git', 'config'), 'utf8'),
        hooks: (await fs.readdir(hooksDir)).sort().join(','),
        linked: (await fs.readdir(path.join(fx.clonePath, '.git', 'worktrees'))).sort().join(','),
      };
      for (const name of ['run-head', 'free-one']) {
        out[`status:${name}`] = await git(path.join(fx.worktreeRoot, name), 'status', '--porcelain=v1', '--ignored');
        out[`head:${name}`] = await git(path.join(fx.worktreeRoot, name), 'rev-parse', 'HEAD');
      }
      return out;
    };

    const before = await snapshot();
    const planned = await plan(fx.runtime);
    expect(planned.code).toBe(0);
    expect(planned.result.outcome).toBe('planned');
    expect(await snapshot()).toEqual(before);
    await expect(fs.stat(hookMarker)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('exits 1 with unknown and writes no plan when a runner state cannot be told', async () => {
    const fx = await fixture(['broken-one']);
    const result = await plan(fx.runtime);
    expect(result.code).toBe(1);
    expect(result.result).toEqual({ outcome: 'unknown', reasons: ['unknown-runner-state'] });
    await expect(fs.stat(path.join(fx.stateDir, 'relaunch-plans.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(result.stdout).not.toContain(fx.root);
  });

  it('exits 1 with unknown when a host cannot be routed, never planning the clone as empty', async () => {
    const fx = await fixture(['free-one']);
    // The same clones without the installation: no host block routes the listing read.
    const bare = createFleetCliRuntime({ stateDir: fx.stateDir });
    const result = await plan(bare);
    expect(result.code).toBe(1);
    expect(result.result).toEqual({ outcome: 'unknown', reasons: ['unknown-worktree-read'] });
    await expect(fs.stat(path.join(fx.stateDir, 'relaunch-plans.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('exits 1 with unknown on an unreadable record store and quarantines nothing (CO29a fix round 2)', async () => {
    const fx = await seededFixture();
    // The corrupt work-order store: bytes no reader accepts. work-orders.json is
    // read only by the plan (the CO26 inventory reads the lane-run stores), so
    // this reaches the plan's own reads: they are read-only, so answering
    // unknown must quarantine nothing and touch no file (no quarantine
    // directory, no rewritten store file, no plan).
    await fs.writeFile(path.join(fx.stateDir, 'work-orders.json'), '{broken CANARY-bytes', 'utf8');
    const before = await snapshotState(fx.stateDir);

    const result = await plan(fx.runtime);

    expect(result.code).toBe(1);
    expect(result.result).toEqual({ outcome: 'unknown', reasons: ['store-read-failed'] });
    await expect(fs.stat(path.join(fx.stateDir, 'relaunch-plans.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    const after = await snapshotState(fx.stateDir);
    expect(after).toEqual(before);
  });

  it('relaunch inventory and relaunch plan write nothing on an unreadable lane-runs.json (both compose read-only stores)', async () => {
    const fx = await seededFixture();
    await fs.writeFile(path.join(fx.stateDir, 'lane-runs.json'), '{broken CANARY-bytes', 'utf8');
    const before = await snapshotStateWithSizes(fx.stateDir);

    const io = capture();
    const inventoryCode = await runCli(['relaunch', 'inventory'], io, fx.runtime);
    expect(inventoryCode).not.toBe(0);
    expect(await snapshotStateWithSizes(fx.stateDir)).toEqual(before);

    const result = await plan(fx.runtime);
    expect(result.code).toBe(1);
    expect(result.result).toEqual({ outcome: 'unknown', reasons: ['inventory-records-unreadable'] });
    await expect(fs.stat(path.join(fx.stateDir, 'relaunch-plans.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await snapshotStateWithSizes(fx.stateDir)).toEqual(before);
  });

  it('exits 1 with unknown when the profile records cannot be read', async () => {
    const fx = await fixture([]);
    const unreadable = {
      ...fx.runtime,
      coordination: {
        ...fx.runtime.coordination,
        listProjectProfiles: {
          listProjectProfiles: async () => {
            throw new Error(`cannot read ${fx.stateDir}`);
          },
        },
      },
    } as unknown as FleetCliRuntime;
    const result = await plan(unreadable);
    expect(result.code).toBe(1);
    expect(result.result).toEqual({ outcome: 'unknown', reasons: ['profile-records-unreadable'] });
    expect(result.stdout).not.toContain(fx.stateDir);

    const rejected = {
      ...fx.runtime,
      coordination: {
        ...fx.runtime.coordination,
        listProjectProfiles: { listProjectProfiles: async () => ({ outcome: 'rejected', reason: 'store unreadable' }) },
      },
    } as unknown as FleetCliRuntime;
    expect((await plan(rejected)).result).toEqual({ outcome: 'unknown', reasons: ['profile-records-unreadable'] });
  });

  it('refuses invalid flags and an exhausted deadline with exit 1 and writes nothing', async () => {
    const fx = await fixture(['free-one']);
    const invalid = { outcome: 'refused', reason: 'invalid-request' };
    for (const flags of [
      ['--max-active-runs', '0'],
      ['--max-active-runs', '65'],
      ['--max-active-runs', 'many'],
      ['--max-active-runs'],
      ['--dispatch-stagger-ms', '-5'],
      ['--dispatch-stagger-ms', '600001'],
      ['--dispatch-stagger-ms', '1.5'],
      ['--deadline', 'tomorrow'],
      ['--host', '../escape'],
    ]) {
      const result = await plan(fx.runtime, ...flags);
      expect({ flags, code: result.code, result: result.result }).toEqual({ flags, code: 1, result: invalid });
    }
    const exhausted = await plan(fx.runtime, '--deadline', '2000-01-01T00:00:00.000Z');
    expect(exhausted.code).toBe(1);
    expect(exhausted.result).toEqual({ outcome: 'refused', reason: 'budget-exhausted' });
    await expect(fs.stat(path.join(fx.stateDir, 'relaunch-plans.json'))).rejects.toMatchObject({ code: 'ENOENT' });

    // A deadline in the future leaves the plan to complete.
    const roomy = await plan(fx.runtime, '--deadline', '2999-01-01T00:00:00.000Z');
    expect(roomy.code).toBe(0);
    expect(roomy.result.outcome).toBe('planned');
  });

  it('plans zero lanes for a host the profiles do not name', async () => {
    const fx = await fixture(['free-one']);
    const result = await plan(fx.runtime, '--host', 'other-host');
    expect(result.code).toBe(0);
    expect(result.result).toMatchObject({ outcome: 'planned' });
    if (result.result.outcome === 'planned') {
      expect(result.result.plan.lanes).toEqual([]);
      expect(result.result.plan.hostFilter).toBe('other-host');
    }
  });
});
