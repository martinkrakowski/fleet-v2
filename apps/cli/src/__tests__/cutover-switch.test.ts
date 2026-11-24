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

import { parseInstallation, type FleetInstallation, type LoadResult } from '@fleet/installation';
import {
  CUTOVER_SHADOW_CRITERIA,
  LaneRun,
  SHADOW_LEDGER_SCHEMA_VERSION,
  ShadowEvidenceAdapter,
  type InventoryRelaunchResult,
  type ManageCutoverResult,
  type MergeQueueEntryRecord,
} from '@fleet/work-execution';

import { createFleetCliRuntime, summarizeInventoryForCutover, type FleetCliRuntime } from '../composition.js';
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

function installation(root: string, policy?: unknown): FleetInstallation {
  const parsed = parseInstallation({
    schemaVersion: 2,
    forge: { mode: 'none' },
    ...(policy === undefined ? {} : { policy }),
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
  /** A `policy` block parsed into the installation, so `daemon.mergePolicy` is configured. */
  readonly policy?: unknown;
  /** Overrides the installation load the merge-policy seam reads (SW2b3 unreadable-policy test). */
  readonly mergePolicyLoad?: () => LoadResult;
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
  const runtime = createFleetCliRuntime({
    stateDir,
    installation: installation(root, options.policy),
    ocmRunBin,
    ...(options.mergePolicyLoad === undefined ? {} : { loadInstallationForMergePolicy: options.mergePolicyLoad }),
  });
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
 * Seeds a passing 1-day shadow ledger (every criterion `pass`, 20 merges, one
 * pinned non-null release sha, the day yesterday) through the real store,
 * or a ledger with one criterion failed when `failCriterion` is given.
 */
async function seedShadowLedger(
  stateDir: string,
  failCriterion?: string,
): Promise<void> {
  const days = [dayString(1)].map((day) => ({
    day,
    releaseSha: RELEASE_SHA,
    mergesCompared: 20,
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

/** Enqueues one merge-queue entry and parks it (SW2b3 shadow-park CLI tests). */
let entrySequence = 700;
const HEAD_OID = 'a'.repeat(40);
/** The queue adapter validates deadlines against the real clock, so the test deadline lies ahead of it. */
const QUEUE_DEADLINE = new Date(Date.now() + 600_000).toISOString();

function ulid(n: number): string {
  return '01JB' + String(n).padStart(22, '0');
}

async function seedParkedEntry(
  fx: Fixture,
  owner: string,
  repo: string,
  pr: number,
  overrides: { readonly reason?: 'checks' | 'veto-hold'; readonly notBeforeIso?: string | null; readonly attempt?: number } = {},
): Promise<MergeQueueEntryRecord> {
  entrySequence += 1;
  const queue = fx.runtime.execution.mergeQueueRepository;
  const created = await queue.enqueueMergeEntry({
    repository: { owner, repo },
    pullRequest: pr,
    headOid: HEAD_OID,
    tier: 1,
    enqueuedBy: 'cli',
    runId: null,
    entryId: ulid(entrySequence),
    successorEntryId: ulid(entrySequence),
    enqueuedAtIso: NOW,
    deadlineIso: QUEUE_DEADLINE,
  });
  if (created.outcome !== 'created') throw new Error(`enqueue refused: ${created.outcome}`);
  const parked = await queue.applyMergeTransition({
    entryId: created.record.entryId,
    expectedRevision: created.record.revision,
    next: {
      ...created.record,
      revision: created.record.revision + 1,
      state: 'parked',
      reason: 'checks',
      ...(overrides.notBeforeIso === undefined ? {} : { notBeforeIso: overrides.notBeforeIso }),
      ...(overrides.attempt === undefined ? {} : { attempt: overrides.attempt }),
    },
    successor: null,
    deadlineIso: QUEUE_DEADLINE,
  });
  if (parked.outcome !== 'applied') throw new Error(`park refused: ${parked.outcome}`);
  if (overrides.reason === 'veto-hold') {
    const vetoed = await queue.applyMergeTransition({
      entryId: created.record.entryId,
      expectedRevision: parked.record.revision,
      next: { ...parked.record, revision: parked.record.revision + 1, state: 'parked', reason: 'veto-hold' },
      successor: null,
      deadlineIso: QUEUE_DEADLINE,
    });
    if (vetoed.outcome !== 'applied') throw new Error(`veto park refused: ${vetoed.outcome}`);
    return vetoed.record;
  }
  return parked.record;
}

/** The seeds every switch must pass before its merge-policy and shadow-park phases run. */
async function seedPassingPreflight(fx: Fixture): Promise<void> {
  await registerRealCloneProfile(fx);
  await seedProvenLane(fx, RUN_ID);
  await seedShadowLedger(fx.stateDir);
  await fx.runtime.daemon.pause.write(true, NOW);
}

/** One raw profile record shaped like the ghost profile below (registration refuses these shapes). */
function rawProfile(projectId: string, clones: Record<string, unknown>): unknown {
  return {
    projectId,
    displayName: `Project ${projectId}`,
    repository: 'https://example.com/example.git',
    designatedDispatcherHost: HOST,
    policyRevision: 'pol-1',
    maxConcurrentLanes: 4,
    runnerCapabilities: { networkEgressRestricted: true },
    revision: 0,
    updatedAtIso: NOW,
    status: 'active',
    defaultBranch: null,
    clones,
    gateProcedures: [],
    defaultAllowedPathPrefixes: [],
    lastProbe: null,
  };
}

describe('cutover switch with countUnrecordedLanes wired (CO30c)', () => {
  it('completes the switch when the passing window holds and every listed worktree is a proven recorded lane', async () => {
    const fx = await fixture({ worktrees: [RUN_ID] });
    await registerRealCloneProfile(fx);
    await seedProvenLane(fx, RUN_ID);
    await seedShadowLedger(fx.stateDir);
    await fx.runtime.daemon.pause.write(true, NOW);
    const { code, result } = await runSwitch(fx.runtime);
    expect(result).toMatchObject({ outcome: 'completed', move: 'switch', state: 'switched', revision: 1 });
    expect(result).toMatchObject({ releasedParks: 0, vetoHoldParks: 0 });
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

  it('refuses when an active profile declares no clones: no clone coverage is never a pass', async () => {
    const fx = await fixture({ worktrees: [RUN_ID] });
    await fs.writeFile(
      path.join(fx.stateDir, 'project-profiles.json'),
      JSON.stringify([rawProfile('proj-empty', {})]),
      'utf8',
    );
    await seedShadowLedger(fx.stateDir);
    const before = await snapshotState(fx.stateDir);
    const { code, result } = await runSwitch(fx.runtime);
    expect(result).toMatchObject({ outcome: 'unknown', reason: 'unrecorded-lanes-unknown' });
    expect(code).toBe(1);
    expect(await snapshotState(fx.stateDir)).toEqual(before);
    await expect(fs.stat(path.join(fx.stateDir, 'cutover.json'))).rejects.toThrow();
    await expect(fs.stat(path.join(fx.stateDir, 'cutover-journal.json'))).rejects.toThrow();
  });

  it('refuses when one active profile among covered ones declares no clones', async () => {
    const fx = await fixture({ worktrees: [RUN_ID] });
    await registerRealCloneProfile(fx);
    const profiles = JSON.parse(await fs.readFile(path.join(fx.stateDir, 'project-profiles.json'), 'utf8')) as unknown[];
    profiles.push(rawProfile('proj-empty', {}));
    await fs.writeFile(path.join(fx.stateDir, 'project-profiles.json'), JSON.stringify(profiles), 'utf8');
    await seedShadowLedger(fx.stateDir);
    const before = await snapshotState(fx.stateDir);
    const { code, result } = await runSwitch(fx.runtime);
    expect(result).toMatchObject({ outcome: 'unknown', reason: 'unrecorded-lanes-unknown' });
    expect(code).toBe(1);
    expect(await snapshotState(fx.stateDir)).toEqual(before);
    await expect(fs.stat(path.join(fx.stateDir, 'cutover.json'))).rejects.toThrow();
    await expect(fs.stat(path.join(fx.stateDir, 'cutover-journal.json'))).rejects.toThrow();
  });

  it('refuses when the inventory inspects fewer clones than the profiles declare', async () => {
    // The real inventory counts every requested clone per host, so partial
    // coverage cannot be produced through the composition without changing
    // the use case (forbidden). This pins the helper's contract directly:
    // an inventoried result that inspected 1 of 2 declared clones is
    // unreadable, and the gate answers `unrecorded-lanes-unknown` for it,
    // so the switch is never performed on partial coverage.
    const inventoried: InventoryRelaunchResult = {
      outcome: 'inventoried',
      nowIso: NOW,
      conductor: { halted: false, driverLease: 'absent', runCount: 0 },
      riskFlags: [],
      hosts: [
        {
          hostName: HOST,
          cloneCount: 1,
          worktreeCount: 0,
          counts: { conducted: 0, attemptRecorded: 0, unrecorded: 0 },
          riskFlags: [],
          lanes: [],
        },
      ],
    };
    expect(summarizeInventoryForCutover(inventoried, 2)).toEqual({ status: 'unreadable' });
    expect(summarizeInventoryForCutover(inventoried, 1)).toEqual({
      status: 'ok',
      unrecorded: 0,
      unknownListings: 0,
    });
    expect(summarizeInventoryForCutover(inventoried)).toEqual({
      status: 'ok',
      unrecorded: 0,
      unknownListings: 0,
    });
    // The real switch itself: through the production composition the declared
    // clones are always all inspected (the inventory counts every requested
    // clone per host), so the real-switch refusal for a declared-clone-less
    // profile is exercised by the two tests above. This run pins that full
    // clone coverage through the real composition passes the lanes gate and
    // performs the switch.
    const fx = await fixture({ worktrees: [RUN_ID] });
    await registerRealCloneProfile(fx);
    await seedProvenLane(fx, RUN_ID);
    await seedShadowLedger(fx.stateDir);
    await fx.runtime.daemon.pause.write(true, NOW);
    const { code, result } = await runSwitch(fx.runtime);
    expect(result).toMatchObject({ outcome: 'completed', move: 'switch', state: 'switched' });
    expect(result).toMatchObject({ releasedParks: 0, vetoHoldParks: 0 });
    expect(code).toBe(0);
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
    await fx.runtime.daemon.pause.write(true, NOW);
    const { code, result } = await runSwitch(fx.runtime);
    expect(result).toMatchObject({ outcome: 'completed', move: 'switch', state: 'switched' });
    expect(result).toMatchObject({ releasedParks: 0, vetoHoldParks: 0 });
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
    const before = await snapshotState(fx.stateDir);
    const { code, result } = await runSwitch(fx.runtime);
    expect(result).toMatchObject({ outcome: 'unknown', reason: 'unrecorded-lanes-unknown' });
    expect(code).toBe(1);
    expect(await snapshotState(fx.stateDir)).toEqual(before);
    await expect(fs.stat(path.join(fx.stateDir, 'cutover.json'))).rejects.toThrow();
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
    const before = await snapshotState(fx.stateDir);
    const { code, result } = await runSwitch(fx.runtime);
    expect(result).toMatchObject({ outcome: 'unknown', reason: 'unrecorded-lanes-unknown' });
    expect(code).toBe(1);
    expect(await snapshotState(fx.stateDir)).toEqual(before);
    await expect(fs.stat(path.join(fx.stateDir, 'cutover.json'))).rejects.toThrow();
  });

  it('answers unknown when the runner read fails for a worktree', async () => {
    const fx = await fixture({ worktrees: ['broken-lane'] });
    await registerRealCloneProfile(fx);
    await seedShadowLedger(fx.stateDir);
    const before = await snapshotState(fx.stateDir);
    const { code, result } = await runSwitch(fx.runtime);
    expect(result).toMatchObject({ outcome: 'unknown', reason: 'unrecorded-lanes-unknown' });
    expect(code).toBe(1);
    expect(await snapshotState(fx.stateDir)).toEqual(before);
    await expect(fs.stat(path.join(fx.stateDir, 'cutover.json'))).rejects.toThrow();
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
    await fx.runtime.daemon.pause.write(true, NOW);
    const { code, result } = await runSwitch(fx.runtime);
    expect(result).toMatchObject({ outcome: 'unknown', reason: 'train-pause-unreadable' });
    expect(code).toBe(1);
  });

  it('refuses daemon-not-paused when daemon pause is clear, with zero writes', async () => {
    // The daemon pause stays `clear`: the switch gate must refuse before the
    // train-pause gate and write no record and no journal entry.
    const fx = await fixture({ worktrees: [RUN_ID] });
    await registerRealCloneProfile(fx);
    await seedProvenLane(fx, RUN_ID);
    await seedShadowLedger(fx.stateDir);
    const before = await snapshotState(fx.stateDir);
    const { code, result } = await runSwitch(fx.runtime);
    expect(result).toMatchObject({ outcome: 'refused', reason: 'daemon-not-paused' });
    expect(code).toBe(1);
    expect(await snapshotState(fx.stateDir)).toEqual(before);
    await expect(fs.stat(path.join(fx.stateDir, 'cutover.json'))).rejects.toThrow();
    await expect(fs.stat(path.join(fx.stateDir, 'cutover-journal.json'))).rejects.toThrow();
  });

  it('refuses as unknown when a listed worktree sits outside the clone worktree root', async () => {
    const fx = await fixture({});
    await registerRealCloneProfile(fx);
    await seedShadowLedger(fx.stateDir);
    // A worktree linked outside the clone's declared worktree root: the clone
    // lists it, the inventory accounts no lane for it, and the difference is
    // more than each clone's own main worktree — the silent drop the gate
    // must never read as `unrecorded 0`.
    await git(
      fx.clonePath,
      'worktree',
      'add',
      '--quiet',
      '-b',
      'fleet/outside',
      path.join(fx.root, 'outside-root-wt'),
    );
    const before = await snapshotState(fx.stateDir);
    const { code, result } = await runSwitch(fx.runtime);
    expect(result).toMatchObject({ outcome: 'unknown', reason: 'unrecorded-lanes-unknown' });
    expect(code).toBe(1);
    expect(await snapshotState(fx.stateDir)).toEqual(before);
    await expect(fs.stat(path.join(fx.stateDir, 'cutover.json'))).rejects.toThrow();
  });

  it('refuses conductor-driver-live while a driver lease is live', async () => {
    const fx = await fixture({ worktrees: [RUN_ID] });
    await registerRealCloneProfile(fx);
    await seedProvenLane(fx, RUN_ID);
    await seedShadowLedger(fx.stateDir);
    await fs.writeFile(
      path.join(fx.stateDir, 'conductor-driver-lease.json'),
      JSON.stringify([{ version: 1, holderId: 'driver-1', fence: 1, leaseUntilIso: '2030-01-01T00:00:00.000Z' }]),
      'utf8',
    );
    const before = await snapshotState(fx.stateDir);
    const { code, result } = await runSwitch(fx.runtime);
    expect(result).toMatchObject({ outcome: 'refused', reason: 'conductor-driver-live' });
    expect(code).toBe(1);
    expect(await snapshotState(fx.stateDir)).toEqual(before);
    await expect(fs.stat(path.join(fx.stateDir, 'cutover.json'))).rejects.toThrow();
  });

  it('answers unreadable when a top-level driver-lease-unknown flag is present', () => {
    // CO30c follow-up: an inventoried result can still carry a
    // `driver-lease-unknown` flag when the lease record itself read but its
    // state could not be determined. That is not evidence of an idle driver,
    // so the summary answers `unreadable` — between the live-lease refusal
    // (which stays `refused`) and the non-`inventoried` outcome path.
    const inventoried: InventoryRelaunchResult = {
      outcome: 'inventoried',
      nowIso: NOW,
      conductor: { halted: false, driverLease: 'absent', runCount: 0 },
      riskFlags: [{ code: 'driver-lease-unknown', count: 1 }],
      hosts: [
        {
          hostName: HOST,
          cloneCount: 1,
          worktreeCount: 0,
          counts: { conducted: 0, attemptRecorded: 0, unrecorded: 0 },
          riskFlags: [],
          lanes: [],
        },
      ],
    };
    expect(summarizeInventoryForCutover(inventoried, 1)).toEqual({ status: 'unreadable' });
    expect(summarizeInventoryForCutover(inventoried)).toEqual({ status: 'unreadable' });
  });

  it('completes the switch when two active profiles share one clone', async () => {
    // CO30c follow-up: two active profiles declaring the same clone (same
    // host, path and worktree root) name one clone, not two. Before the
    // deduplication the declared count doubled and the inventory's inspected
    // count could never reach it, so every shared-clone installation failed
    // the gate as unknown. The registration use case refuses a second
    // project over the same clone, so the fixture seeds the second record
    // directly.
    const fx = await fixture({ worktrees: [RUN_ID] });
    await registerRealCloneProfile(fx);
    const profiles = JSON.parse(await fs.readFile(path.join(fx.stateDir, 'project-profiles.json'), 'utf8')) as unknown[];
    profiles.push(rawProfile('proj-2', { [HOST]: { path: fx.clonePath, worktreeRoot: fx.worktreeRoot } }));
    await fs.writeFile(path.join(fx.stateDir, 'project-profiles.json'), JSON.stringify(profiles), 'utf8');
    await seedProvenLane(fx, RUN_ID);
    await seedShadowLedger(fx.stateDir);
    await fx.runtime.daemon.pause.write(true, NOW);
    const { code, result } = await runSwitch(fx.runtime);
    expect(result).toMatchObject({ outcome: 'completed', move: 'switch', state: 'switched' });
    expect(result).toMatchObject({ releasedParks: 0, vetoHoldParks: 0 });
    expect(code).toBe(0);
  });

  it('answers unknown when the driver lease file is unreadable', async () => {
    const fx = await fixture({ worktrees: [RUN_ID] });
    await registerRealCloneProfile(fx);
    await seedShadowLedger(fx.stateDir);
    await fs.writeFile(path.join(fx.stateDir, 'conductor-driver-lease.json'), CORRUPT, 'utf8');
    const before = await snapshotState(fx.stateDir);
    const { code, result } = await runSwitch(fx.runtime);
    expect(result).toMatchObject({ outcome: 'unknown', reason: 'unrecorded-lanes-unknown' });
    expect(code).toBe(1);
    expect(await snapshotState(fx.stateDir)).toEqual(before);
  });

  it('passes the lanes gate when no driver lease exists', async () => {
    const fx = await fixture({ worktrees: [RUN_ID] });
    await registerRealCloneProfile(fx);
    await seedProvenLane(fx, RUN_ID);
    await seedShadowLedger(fx.stateDir);
    await expect(fs.stat(path.join(fx.stateDir, 'conductor-driver-lease.json'))).rejects.toThrow();
    await fx.runtime.daemon.pause.write(true, NOW);
    const { code, result } = await runSwitch(fx.runtime);
    expect(result).toMatchObject({ outcome: 'completed', move: 'switch', state: 'switched' });
    expect(result).toMatchObject({ releasedParks: 0, vetoHoldParks: 0 });
    expect(code).toBe(0);
  });

  it('answers unknown when the daemon status is unreadable', async () => {
    const fx = await fixture({ worktrees: [RUN_ID] });
    await registerRealCloneProfile(fx);
    await seedProvenLane(fx, RUN_ID);
    await seedShadowLedger(fx.stateDir);
    await fs.mkdir(path.join(fx.stateDir, 'daemon'), { recursive: true });
    await fs.writeFile(path.join(fx.stateDir, 'daemon', 'status.json'), CORRUPT, 'utf8');
    const before = await snapshotState(fx.stateDir);
    const { code, result } = await runSwitch(fx.runtime);
    expect(result).toMatchObject({ outcome: 'unknown', reason: 'daemon-status-unreadable' });
    expect(code).toBe(1);
    expect(await snapshotState(fx.stateDir)).toEqual(before);
  });

  it('answers unknown when the runner cannot be resolved for a worktree attempt', async () => {
    const fx = await fixture({ worktrees: [RUN_ID] });
    await registerRealCloneProfile(fx);
    // The attempt is recorded against the same host at a different port: the
    // confirm-or-unknown rule refuses the runner instead of falling back, so
    // the inventory cannot tell the worktree's state and reports
    // `unknown-runner-state`.
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
      sessionId: fakeSessionOf(RUN_ID),
      completionReceipt: null,
      artifacts: null,
      runner: {
        kind: 'opencode',
        remotePort: RUNNER_PORT + 1,
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
    await seedShadowLedger(fx.stateDir);
    const before = await snapshotState(fx.stateDir);
    const { code, result } = await runSwitch(fx.runtime);
    expect(result).toMatchObject({ outcome: 'unknown', reason: 'unrecorded-lanes-unknown' });
    expect(code).toBe(1);
    expect(await snapshotState(fx.stateDir)).toEqual(before);
  });
});

describe('cutover switch merge-policy wiring (SW2b3)', () => {
  /** A configured policy with no shadow repository: every listed repo is live. */
  const LIVE_ONLY_POLICY = {
    merge: { repos: { 'live-owner/live-repo': { projectId: 'proj-1', shadow: false } } },
  };
  /** One shadow repository (the parse default) and one live repository. */
  const MIXED_POLICY = {
    merge: {
      repos: {
        'shadow-owner/shadow-repo': { projectId: 'proj-1' },
        'live-owner/live-repo': { projectId: 'proj-1', shadow: false },
      },
    },
  };

  it('completes with a configured merge policy that names no shadow repository', async () => {
    const fx = await fixture({ worktrees: [RUN_ID], policy: LIVE_ONLY_POLICY });
    await seedPassingPreflight(fx);
    const { code, result } = await runSwitch(fx.runtime);
    expect(result).toMatchObject({
      outcome: 'completed',
      move: 'switch',
      state: 'switched',
      releasedParks: 0,
      vetoHoldParks: 0,
    });
    expect(code).toBe(0);
  });

  it('counts a shadow veto-hold, releases nothing, and leaves a live-repo parked entry untouched', async () => {
    const fx = await fixture({ worktrees: [RUN_ID], policy: MIXED_POLICY });
    await seedPassingPreflight(fx);
    const vetoed = await seedParkedEntry(fx, 'shadow-owner', 'shadow-repo', 1, { reason: 'veto-hold' });
    const live = await seedParkedEntry(fx, 'live-owner', 'live-repo', 2, { notBeforeIso: NOW, attempt: 2 });
    const { code, result } = await runSwitch(fx.runtime);
    expect(result).toMatchObject({
      outcome: 'completed',
      move: 'switch',
      state: 'switched',
      releasedParks: 0,
      vetoHoldParks: 1,
    });
    expect(code).toBe(0);
    const listed = await fx.runtime.execution.mergeQueueRepository.listMergeEntries({ deadlineIso: QUEUE_DEADLINE });
    const byId = new Map(listed.map((entry) => [entry.entryId, entry]));
    expect(byId.get(vetoed.entryId)).toMatchObject({ state: 'parked', reason: 'veto-hold' });
    // The live repository's parked entry is not the switch's to release: the
    // first live daemon pass owns it, notBeforeIso and attempt history intact.
    expect(byId.get(live.entryId)).toMatchObject({
      state: 'parked',
      reason: 'checks',
      notBeforeIso: NOW,
      attempt: 2,
    });
  });

  it('answers unknown with merge-policy-unreadable when the installation merge policy is invalid', async () => {
    const fx = await fixture({
      worktrees: [RUN_ID],
      mergePolicyLoad: () => ({ status: 'invalid', file: '/private/install.json', errors: ['invalid'] }),
    });
    await seedPassingPreflight(fx);
    const before = await snapshotState(fx.stateDir);
    const { code, result } = await runSwitch(fx.runtime);
    expect(result).toEqual({ outcome: 'unknown', reason: 'merge-policy-unreadable' });
    expect(code).toBe(1);
    expect(await snapshotState(fx.stateDir)).toEqual(before);
    await expect(fs.stat(path.join(fx.stateDir, 'cutover.json'))).rejects.toThrow();
    await expect(fs.stat(path.join(fx.stateDir, 'cutover-journal.json'))).rejects.toThrow();
    await expect(fs.stat(path.join(fx.stateDir, 'shadow-park-journal.json'))).rejects.toThrow();
  });

  for (const [label, argv] of [
    ['missing --expected-revision', ['cutover', 'switch', '--operation-id', 'op-1', '--relaunch-plan-digest', DIGEST]],
    [
      'malformed --expected-revision',
      ['cutover', 'switch', '--expected-revision', 'abc', '--operation-id', 'op-1', '--relaunch-plan-digest', DIGEST],
    ],
    ['missing --operation-id', ['cutover', 'switch', '--expected-revision', '0', '--relaunch-plan-digest', DIGEST]],
    [
      'blank --operation-id',
      ['cutover', 'switch', '--expected-revision', '0', '--operation-id', '', '--relaunch-plan-digest', DIGEST],
    ],
    [
      'missing --relaunch-plan-digest',
      ['cutover', 'switch', '--expected-revision', '0', '--operation-id', 'op-1'],
    ],
    [
      'malformed --relaunch-plan-digest',
      ['cutover', 'switch', '--expected-revision', '0', '--operation-id', 'op-1', '--relaunch-plan-digest', 'zz'],
    ],
    [
      'an unknown flag',
      [
        'cutover', 'switch', '--expected-revision', '0', '--operation-id', 'op-1',
        '--relaunch-plan-digest', DIGEST, '--nonsense',
      ],
    ],
    [
      'an extra positional',
      ['cutover', 'switch', '--expected-revision', '0', '--operation-id', 'op-1', '--relaunch-plan-digest', DIGEST, 'extra'],
    ],
  ] as const) {
    it(`refuses ${label} with exit 2 without touching state`, async () => {
      const fx = await fixture({});
      const before = await snapshotState(fx.stateDir);
      const io = capture();
      const code = await runCli(argv, io, fx.runtime);
      expect(code).toBe(2);
      expect(io.err.join('')).not.toBe('');
      expect(await snapshotState(fx.stateDir)).toEqual(before);
      await expect(fs.stat(path.join(fx.stateDir, 'cutover.json'))).rejects.toThrow();
      await expect(fs.stat(path.join(fx.stateDir, 'shadow-park-journal.json'))).rejects.toThrow();
    });
  }
});
