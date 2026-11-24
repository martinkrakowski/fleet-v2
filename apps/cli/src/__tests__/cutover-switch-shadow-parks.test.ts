// SW2b3: `cutover switch` shadow parks through the production composition.
// The runtime is the real `createFleetCliRuntime` over a real temporary state
// directory, a local git clone with a real linked worktree, and a v2
// installation whose local host answers the runner state through a Node
// stand-in for the bundled `ocm-run` (`--status` only). The shadow ledger is
// seeded through the real `ShadowEvidenceAdapter` store, the queue through the
// real `mergeQueueRepository`. Nothing is mocked except that stand-in's
// answers.

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
  CutoverJournalAdapter,
  LaneRun,
  sha256HexDigest,
  SHADOW_LEDGER_SCHEMA_VERSION,
  ShadowEvidenceAdapter,
  type ManageCutoverResult,
  type MergeQueueEntryRecord,
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

/** The `ocm-run --status` stand-in: `run-*` directories run their own session. */
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

async function fixture(options: { readonly policy?: unknown } = {}): Promise<Fixture> {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'fleet-v2-cutover-shadow-parks-')));
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
  await git(clonePath, 'worktree', 'add', '--quiet', '-b', `fleet/${RUN_ID}`, path.join(worktreeRoot, RUN_ID));
  const ocmRunBin = path.join(root, 'ocm-run');
  writeFileSync(ocmRunBin, FAKE_OCM_RUN);
  chmodSync(ocmRunBin, 0o755);
  const runtime = createFleetCliRuntime({ stateDir, installation: installation(root, options.policy), ocmRunBin });
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

/** One conducted, proven lane: a run whose branch is checked out, an attempt whose own session runs there. */
async function seedProvenLane(fx: Fixture): Promise<void> {
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
    sessionId: `ses_${RUN_ID.replace(/[^A-Za-z0-9]/g, '_')}`,
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
}

/** The day string `offset` UTC days before the real clock, floored to the day. */
function dayString(offsetDays: number): string {
  return new Date(Date.now() - offsetDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/** Seeds a passing 1-day shadow ledger through the real store. */
async function seedShadowLedger(stateDir: string): Promise<void> {
  const days = [dayString(1)].map((day) => ({
    day,
    releaseSha: RELEASE_SHA,
    mergesCompared: 20,
    verdicts: Object.fromEntries(
      CUTOVER_SHADOW_CRITERIA.map((criterion) => [
        criterion,
        { verdict: 'pass', reason: 'ok', digest: 'f'.repeat(64), recordedAtIso: NOW },
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

/** Enqueues one merge-queue entry and parks it with `reason: 'checks'`. */
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
  overrides: { readonly notBeforeIso?: string | null; readonly attempt?: number } = {},
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
  return parked.record;
}

/** The seeds every switch must pass before its merge-policy and shadow-park phases run. */
async function seedPassingPreflight(fx: Fixture): Promise<void> {
  await registerRealCloneProfile(fx);
  await seedProvenLane(fx);
  await seedShadowLedger(fx.stateDir);
  await fx.runtime.daemon.pause.write(true, NOW);
}

/** One shadow repository under the parse default (`shadow: true`). */
const SHADOW_POLICY = {
  merge: { repos: { 'shadow-owner/shadow-repo': { projectId: 'proj-1' } } },
};

describe('cutover switch shadow parks through the CLI (SW2b3)', () => {
  it('answers unknown merge-queue-unreadable without quarantining or modifying bytes when merge-queue.json is corrupt', async () => {
    const fx = await fixture({});
    await seedPassingPreflight(fx);
    const queuePath = path.join(fx.stateDir, 'merge-queue.json');
    await fs.writeFile(queuePath, CORRUPT, 'utf8');
    const before = await snapshotState(fx.stateDir);
    const { code, result } = await runSwitch(fx.runtime);
    expect(result).toEqual({ outcome: 'unknown', reason: 'merge-queue-unreadable' });
    expect(code).toBe(1);
    // The bytes are untouched and nothing new appeared: no quarantine file or
    // directory, no cutover record, no cutover journal, no shadow-park journal.
    expect(await snapshotState(fx.stateDir)).toEqual(before);
    expect(await fs.readFile(queuePath, 'utf8')).toBe(CORRUPT);
    await expect(fs.stat(path.join(fx.stateDir, 'cutover.json'))).rejects.toThrow();
    await expect(fs.stat(path.join(fx.stateDir, 'cutover-journal.json'))).rejects.toThrow();
    await expect(fs.stat(path.join(fx.stateDir, 'shadow-park-journal.json'))).rejects.toThrow();
  });

  it('releases an ordinary shadow parked entry end to end and journals its intent in the shadow-park store', async () => {
    const fx = await fixture({ policy: SHADOW_POLICY });
    await seedPassingPreflight(fx);
    const parked = await seedParkedEntry(fx, 'shadow-owner', 'shadow-repo', 7, { notBeforeIso: NOW, attempt: 2 });
    const { code, result } = await runSwitch(fx.runtime);
    expect(result).toMatchObject({
      outcome: 'completed',
      move: 'switch',
      state: 'switched',
      releasedParks: 1,
      vetoHoldParks: 0,
    });
    expect(code).toBe(0);

    // The entry is back in the queue: `queued`, its `notBeforeIso` cleared, its
    // attempt history preserved — dropping at maxAttempts is the first live
    // evaluation's decision, not the release's.
    const listed = await fx.runtime.execution.mergeQueueRepository.listMergeEntries({ deadlineIso: QUEUE_DEADLINE });
    const byId = new Map(listed.map((entry) => [entry.entryId, entry]));
    expect(byId.get(parked.entryId)).toMatchObject({
      state: 'queued',
      reason: null,
      notBeforeIso: null,
      attempt: 2,
    });

    // The park intent lives in the separate shadow-park store, keyed by the
    // entry digest; the cutover journal holds only the switch's own entries.
    const parkJournal = new CutoverJournalAdapter({ stateDir: fx.stateDir, shadowPark: true });
    const parks = await parkJournal.listByKeyPrefix('cutover/shadow-park-');
    expect(parks.outcome).toBe('listed');
    if (parks.outcome !== 'listed') throw new Error('shadow-park journal unreadable');
    expect(parks.entries.map((entry) => entry.key)).toEqual([
      `cutover/shadow-park-${sha256HexDigest(parked.entryId).slice(0, 32)}@${parked.revision}`,
    ]);
    expect(parks.entries.every((entry) => entry.kind === 'intent')).toBe(true);

    const cutoverJournal = new CutoverJournalAdapter({ stateDir: fx.stateDir });
    const switchEntries = await cutoverJournal.listByKeyPrefix('cutover/switch@0');
    expect(switchEntries.outcome).toBe('listed');
    if (switchEntries.outcome !== 'listed') throw new Error('cutover journal unreadable');
    expect(switchEntries.entries.map((entry) => entry.kind)).toEqual(['intent', 'result']);
    expect(switchEntries.entries.every((entry) => entry.key === 'cutover/switch@0')).toBe(true);
    expect(await parkJournal.listByKeyPrefix('')).toMatchObject({ outcome: 'listed' });
    const everyCutoverKey = await cutoverJournal.listByKeyPrefix('');
    if (everyCutoverKey.outcome === 'listed') {
      expect(everyCutoverKey.entries.every((entry) => entry.key.startsWith('cutover/switch@'))).toBe(true);
    }
  });
});
