// CO30c: `cutover switch` through the production composition with
// `countUnrecordedLanes` wired. The runtime is the real `createFleetCliRuntime`
// over a real temporary state directory, a local git clone with real linked
// worktrees, and a v2 installation whose local host answers the runner state
// through a Node stand-in for the bundled `ocm-run` (`--status` only). The
// shadow ledger is seeded through the real `ShadowEvidenceAdapter` store.
// Nothing is mocked except that stand-in's answers.

import { execFile } from 'node:child_process';
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';

import { afterAll, describe, expect, it } from 'vitest';

import { parseInstallation, type FleetInstallation } from '@fleet/installation';
import {
  CUTOVER_SHADOW_CRITERIA,
  LaneRun,
  SHADOW_LEDGER_SCHEMA_VERSION,
  ShadowEvidenceAdapter,
  type ManageCutoverResult,
} from '@fleet/work-execution';

import { createFleetCliRuntime, type FleetCliRuntime } from '../composition.js';
import { runCli, type CliIo } from '../index.js';

const execFileAsync = promisify(execFile);

const NOW = '2026-11-07T00:00:00.000Z';
const RUN_ID = 'run-01JC000000000000000000000A';
const COMMIT = 'a'.repeat(40);
const HOST = 'lane-host';
const RUNNER_PORT = 46_000;
const DIGEST = 'c'.repeat(64);
const RELEASE_SHA = 'd'.repeat(40);
const CORRUPT = '{"schemaVersion"';

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

interface FixtureOptions {
  /** Real linked worktrees to create under the clone's worktree root. */
  readonly worktrees?: readonly string[];
}

async function fixture(options: FixtureOptions = {}): Promise<Fixture> {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'fleet-v2-cutover-switch-')));
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
  for (const name of options.worktrees ?? []) {
    await git(clonePath, 'worktree', 'add', '--quiet', '-b', `fleet/${name}`, path.join(worktreeRoot, name));
  }
  const ocmRunBin = path.join(root, 'ocm-run');
  writeFileSync(ocmRunBin, FAKE_OCM_RUN);
  chmodSync(ocmRunBin, 0o755);
  const runtime = createFleetCliRuntime({ stateDir, installation: installation(root), ocmRunBin });
  return { root, stateDir, clonePath, worktreeRoot, runtime };
}

/** One profile on the real host over the real clone (D18: registered clones only). */
async function registerRealCloneProfile(fx: Fixture): Promise<void> {
  const registered = await fx.runtime.coordination.registerProjectProfile.execute({
    projectId: 'proj-1',
    displayName: 'Project One',
    repository: 'https://example.com/example.git',
    designatedDispatcherHost: HOST,
    policyRevision: 'pol-1',
    maxConcurrentLanes: 4,
    runnerCapabilities: { networkEgressRestricted: true },
    clones: { [HOST]: { path: fx.clonePath, worktreeRoot: fx.worktreeRoot } },
  });
  expect(registered.outcome).toBe('registered');
}

/** The session the fake `ocm-run` reports for a worktree named `name`. */
function fakeSessionOf(name: string): string {
  return `ses_${name.replace(/[^A-Za-z0-9]/g, '_')}`;
}

/** One conducted, proven lane: a run whose branch is checked out, an attempt whose own session runs there. */
async function seedProvenLane(fx: Fixture, worktreeName: string): Promise<void> {
  await fx.runtime.execution.attemptRepository.saveAttempt({
    id: 'attempt-1',
    workOrderId: 'wo-1',
    kind: 'initial',
    fixNumber: 0,
    priorAttemptId: null,
    worktreePath: path.join(fx.worktreeRoot, worktreeName),
    baseCommit: COMMIT,
    state: 'running',
    outcome: null,
    briefDigest: 'b'.repeat(64),
    briefPackagePath: '.lane/brief-package',
    sessionId: fakeSessionOf(worktreeName),
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
  const created = LaneRun.create({
    version: 1,
    runId: RUN_ID,
    workOrderId: 'wo-1',
    tier: 2,
    seatPlanRef: 'e'.repeat(64),
    cursors: { 'first-pass': 0, fix: null, review: null },
    round: 0,
    attemptIds: ['attempt-1'],
    prNumber: null,
    parked: null,
    parkCount: 0,
    lease: null,
    revision: 1,
    runPolicyRevision: 'pol-1',
    branchName: `fleet/${worktreeName}`,
  });
  if (!created.success) throw new Error('fixture must be a valid LaneRun record');
  expect(await fx.runtime.conductor.laneRunRepository.create(created.value.toRecord())).toMatchObject({
    outcome: 'saved',
  });
}

/** The day string `offset` UTC days before the real clock, floored to the day. */
function dayString(offsetDays: number): string {
  return new Date(Date.now() - offsetDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/**
 * Seeds a passing 3-day shadow ledger (every criterion `pass`, 20+ merges, one
 * shared non-null release sha, the newest day today) through the real store,
 * or a ledger with one criterion failed when `failCriterion` is given.
 */
async function seedShadowLedger(
  stateDir: string,
  failCriterion?: string,
): Promise<void> {
  const days = [dayString(2), dayString(1), dayString(0)].map((day) => ({
    day,
    releaseSha: RELEASE_SHA,
    mergesCompared: 10,
    verdicts: Object.fromEntries(
      CUTOVER_SHADOW_CRITERIA.map((criterion) => [
        criterion,
        {
          verdict: criterion === failCriterion ? 'fail' : 'pass',
          reason: 'ok',
          digest: 'f'.repeat(64),
          recordedAtIso: NOW,
        },
      ]),
    ),
  }));
  const store = new ShadowEvidenceAdapter({ stateDir });
  const saved = await store.compareAndSet({
    expectedRevision: 0,
    next: { schemaVersion: SHADOW_LEDGER_SCHEMA_VERSION, revision: 1, days },
  });
  expect(saved.outcome).toBe('saved');
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

async function runSwitch(
  runtime: FleetCliRuntime,
  ...extra: readonly string[]
): Promise<{ code: number; result: ManageCutoverResult; stdout: string; stderr: string }> {
  const io = capture();
  const code = await runCli(
    ['cutover', 'switch', '--expected-revision', '0', '--operation-id', 'op-1', '--relaunch-plan-digest', DIGEST, ...extra],
    io,
    runtime,
  );
  const stdout = io.out.join('');
  return { code, result: JSON.parse(stdout) as ManageCutoverResult, stdout, stderr: io.err.join('') };
}

/**
 * Every entry under `dir` (recursive, directories included) mapped to a text
 * snapshot: the no-write invariant notices a created or rewritten file, a
 * created directory, or a changed symlink target, not only regular writes.
 */
async function listFileBytes(root: string): Promise<Map<string, string>> {
  const entries = new Map<string, string>();
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        entries.set(full, `link -> ${await fs.readlink(full)}`);
      } else if (entry.isDirectory()) {
        entries.set(full, '<dir>');
        await walk(full);
      } else if (entry.isFile()) {
        entries.set(full, await fs.readFile(full, 'utf8'));
      } else {
        entries.set(full, '<other>');
      }
    }
  };
  await walk(root);
  return entries;
}

async function snapshotState(dir: string): Promise<Map<string, string>> {
  return listFileBytes(dir);
}

describe('cutover switch with countUnrecordedLanes wired (CO30c)', () => {
  it('completes the switch when the passing window holds and every listed worktree is a proven recorded lane', async () => {
    const fx = await fixture({ worktrees: [RUN_ID] });
    await registerRealCloneProfile(fx);
    await seedProvenLane(fx, RUN_ID);
    await seedShadowLedger(fx.stateDir);
    const { code, result } = await runSwitch(fx.runtime);
    expect(result).toMatchObject({ outcome: 'completed', move: 'switch', state: 'switched', revision: 1 });
    expect(code).toBe(0);
    const record = await fs.readFile(path.join(fx.stateDir, 'cutover.json'), 'utf8');
    expect(JSON.parse(record)).toMatchObject({ state: 'switched', revision: 1 });
    expect(await fs.stat(path.join(fx.stateDir, 'cutover-journal.json'))).toBeTruthy();
  });

  it('refuses as unknown when zero active project profiles exist: it never passes 0/0', async () => {
    const fx = await fixture({});
    await seedShadowLedger(fx.stateDir);
    const before = await snapshotState(fx.stateDir);
    const { code, result } = await runSwitch(fx.runtime);
    expect(result).toMatchObject({ outcome: 'unknown', reason: 'unrecorded-lanes-unknown' });
    expect(code).toBe(1);
    expect(await snapshotState(fx.stateDir)).toEqual(before);
    await expect(fs.stat(path.join(fx.stateDir, 'cutover.json'))).rejects.toThrow();
    await expect(fs.stat(path.join(fx.stateDir, 'cutover-journal.json'))).rejects.toThrow();
  });

  it('refuses unrecorded-lanes on an unrecorded idle leftover worktree and writes nothing', async () => {
    const fx = await fixture({ worktrees: ['wt-idle'] });
    await registerRealCloneProfile(fx);
    await seedShadowLedger(fx.stateDir);
    const before = await snapshotState(fx.stateDir);
    const { code, result } = await runSwitch(fx.runtime);
    expect(result).toMatchObject({ outcome: 'refused', reason: 'unrecorded-lanes' });
    expect(code).toBe(1);
    expect(await snapshotState(fx.stateDir)).toEqual(before);
    await expect(fs.stat(path.join(fx.stateDir, 'cutover.json'))).rejects.toThrow();
    await expect(fs.stat(path.join(fx.stateDir, 'cutover-journal.json'))).rejects.toThrow();
  });

  it('lists an unproven lane record and does not refuse the switch on it', async () => {
    const fx = await fixture({ worktrees: [RUN_ID] });
    await registerRealCloneProfile(fx);
    // The run's branch is checked out, but the session running there is not the
    // record's own: the claim is contradicted and reported `unknown` — listed,
    // counted as unproven, and never a refusal.
    await fx.runtime.execution.attemptRepository.saveAttempt({
      id: 'attempt-1',
      workOrderId: 'wo-1',
      kind: 'initial',
      fixNumber: 0,
      priorAttemptId: null,
      worktreePath: path.join(fx.worktreeRoot, RUN_ID),
      baseCommit: COMMIT,
      state: 'running',
      outcome: null,
      briefDigest: 'b'.repeat(64),
      briefPackagePath: '.lane/brief-package',
      sessionId: 'ses_other_session',
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
    const created = LaneRun.create({
      version: 1,
      runId: RUN_ID,
      workOrderId: 'wo-1',
      tier: 2,
      seatPlanRef: 'e'.repeat(64),
      cursors: { 'first-pass': 0, fix: null, review: null },
      round: 0,
      attemptIds: ['attempt-1'],
      prNumber: null,
      parked: null,
      parkCount: 0,
      lease: null,
      revision: 1,
      runPolicyRevision: 'pol-1',
      branchName: `fleet/${RUN_ID}`,
    });
    if (!created.success) throw new Error('fixture must be a valid LaneRun record');
    expect(await fx.runtime.conductor.laneRunRepository.create(created.value.toRecord())).toMatchObject({
      outcome: 'saved',
    });
    const inventory = capture();
    await runCli(['relaunch', 'inventory'], inventory, fx.runtime);
    const listed = JSON.parse(inventory.out.join('')) as {
      outcome: string;
      hosts: readonly { riskFlags: readonly { code: string; count: number }[] }[];
    };
    expect(listed.outcome).toBe('inventoried');
    expect(listed.hosts[0].riskFlags).toContainEqual({ code: 'unproven-lane-records', count: 1 });
    expect(listed.hosts[0].riskFlags).not.toContainEqual({ code: 'unknown-worktree-read', count: expect.anything() });
    expect(listed.hosts[0].riskFlags).not.toContainEqual({ code: 'unknown-runner-state', count: expect.anything() });
    await seedShadowLedger(fx.stateDir);
    const { code, result } = await runSwitch(fx.runtime);
    expect(result).toMatchObject({ outcome: 'completed', move: 'switch', state: 'switched' });
    expect(code).toBe(0);
  });

  for (const [label, fileName] of [
    ['project profiles', 'project-profiles.json'],
    ['lane runs', 'lane-runs.json'],
    ['attempts', 'attempts.json'],
    ['conductor halt', 'conductor-halt.json'],
  ] as const) {
    it(`answers unknown, never quarantining or writing, when ${label} are unreadable`, async () => {
      const fx = await fixture({});
      await registerRealCloneProfile(fx);
      await seedShadowLedger(fx.stateDir);
      await fs.writeFile(path.join(fx.stateDir, fileName), CORRUPT, 'utf8');
      const before = await snapshotState(fx.stateDir);
      const { code, result } = await runSwitch(fx.runtime);
      expect(result).toMatchObject({ outcome: 'unknown', reason: 'unrecorded-lanes-unknown' });
      expect(code).toBe(1);
      expect(await snapshotState(fx.stateDir)).toEqual(before);
    });
  }

  it('answers unknown when a registered clone sits on a host absent from the installation', async () => {
    const fx = await fixture({ worktrees: [RUN_ID] });
    await registerRealCloneProfile(fx);
    // The registration and update use cases refuse a clone host absent from
    // the installation, so the fixture seeds the record directly: the stored
    // profile names a host the installation cannot route, which is exactly
    // the stale-installation condition the gate must refuse as unknown.
    const profiles = JSON.parse(await fs.readFile(path.join(fx.stateDir, 'project-profiles.json'), 'utf8')) as unknown[];
    profiles.push({
      projectId: 'proj-ghost',
      displayName: 'Project Ghost',
      repository: 'https://example.com/example.git',
      designatedDispatcherHost: HOST,
      policyRevision: 'pol-1',
      maxConcurrentLanes: 4,
      runnerCapabilities: { networkEgressRestricted: true },
      revision: 0,
      updatedAtIso: NOW,
      status: 'active',
      defaultBranch: null,
      clones: { 'ghost-host': { path: fx.clonePath, worktreeRoot: fx.worktreeRoot } },
      gateProcedures: [],
      defaultAllowedPathPrefixes: [],
      lastProbe: null,
    });
    await fs.writeFile(path.join(fx.stateDir, 'project-profiles.json'), JSON.stringify(profiles), 'utf8');
    await seedShadowLedger(fx.stateDir);
    const { code, result } = await runSwitch(fx.runtime);
    expect(result).toMatchObject({ outcome: 'unknown', reason: 'unrecorded-lanes-unknown' });
    expect(code).toBe(1);
  });

  it('answers unknown when the clone listing cannot be read', async () => {
    const fx = await fixture({});
    const registered = await fx.runtime.coordination.registerProjectProfile.execute({
      projectId: 'proj-1',
      displayName: 'Project One',
      repository: 'https://example.com/example.git',
      designatedDispatcherHost: HOST,
      policyRevision: 'pol-1',
      maxConcurrentLanes: 4,
      runnerCapabilities: { networkEgressRestricted: true },
      clones: { [HOST]: { path: path.join(fx.root, 'no-such-clone'), worktreeRoot: fx.worktreeRoot } },
    });
    expect(registered.outcome).toBe('registered');
    await seedShadowLedger(fx.stateDir);
    const { code, result } = await runSwitch(fx.runtime);
    expect(result).toMatchObject({ outcome: 'unknown', reason: 'unrecorded-lanes-unknown' });
    expect(code).toBe(1);
  });

  it('answers unknown when the runner read fails for a worktree', async () => {
    const fx = await fixture({ worktrees: ['broken-lane'] });
    await registerRealCloneProfile(fx);
    await seedShadowLedger(fx.stateDir);
    const { code, result } = await runSwitch(fx.runtime);
    expect(result).toMatchObject({ outcome: 'unknown', reason: 'unrecorded-lanes-unknown' });
    expect(code).toBe(1);
  });

  it('refuses shadow-evidence-absent when no shadow ledger exists, before the lanes gate', async () => {
    const fx = await fixture({ worktrees: ['wt-idle'] });
    await registerRealCloneProfile(fx);
    const { code, result } = await runSwitch(fx.runtime);
    expect(result).toMatchObject({
      outcome: 'refused',
      reason: 'shadow-evidence-absent',
      failed: [...CUTOVER_SHADOW_CRITERIA],
    });
    expect(code).toBe(1);
  });

  it('refuses shadow-criteria-failed when a recorded criterion failed', async () => {
    const fx = await fixture({});
    await registerRealCloneProfile(fx);
    await seedShadowLedger(fx.stateDir, 'S6');
    const { code, result } = await runSwitch(fx.runtime);
    expect(result).toMatchObject({ outcome: 'refused', reason: 'shadow-criteria-failed', failed: ['S6'] });
    expect(code).toBe(1);
  });

  it('answers unknown when the train-pause store is unreadable, after the lanes gate passes', async () => {
    const fx = await fixture({ worktrees: [RUN_ID] });
    await registerRealCloneProfile(fx);
    await seedProvenLane(fx, RUN_ID);
    await seedShadowLedger(fx.stateDir);
    await fs.writeFile(path.join(fx.stateDir, 'killall-train-pause.json'), CORRUPT, 'utf8');
    const { code, result } = await runSwitch(fx.runtime);
    expect(result).toMatchObject({ outcome: 'unknown', reason: 'train-pause-unreadable' });
    expect(code).toBe(1);
  });
});
