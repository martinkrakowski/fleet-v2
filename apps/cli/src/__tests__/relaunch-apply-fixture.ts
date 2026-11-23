/**
 * AR3c2 — the shared live-apply fixture for `relaunch apply`'s e2e tests: a
 * real temporary state directory, a real local git clone with one linked
 * worktree, a Node stand-in for the bundled `ocm-run` (`--status` and
 * `--abort` only), a v2 installation whose local host routes the runner, and
 * a runtime whose owner key is an ephemeral in-process Ed25519 keypair.
 * Nothing is mocked except the stand-in's answers; every store, use case and
 * adapter is the production composition's own.
 */

import { execFile } from 'node:child_process';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';

import { parseInstallation, type FleetInstallation } from '@fleet/installation';
import {
  canonicalRelaunchPlanBodyJson,
  sha256HexDigest,
  type RelaunchPlanRecord,
} from '@fleet/work-execution';

import { createFleetCliRuntime, type FleetCliRuntime } from '../composition.js';
import { runCli, type CliIo } from '../index.js';

const execFileAsync = promisify(execFile);

export const HOST = 'lane-host';
export const RUNNER_PORT = 46_112;
export const LANE_ID = 'lane-adopt';
export const HELD_LANE_ID = 'lane-held';
export const WORK_ORDER_ID = 'wo-adopt';
export const ATTEMPT_ID = 'attempt-adopt';
/** `run-` + 26 Crockford characters, per LANE_RUN_ID_PATTERN. */
export const RUN_ID = `run-01JC${'0'.repeat(21)}A`;
export const HELD_RUN_ID = `run-01JC${'0'.repeat(21)}B`;
export const WORKTREE_BRANCH = 'fleet/wt-adopt';
export const BRIEF_TEXT = 'adopt the lane worktree into a conducted run';
export const BRIEF_DIGEST = createHash('sha256').update(BRIEF_TEXT, 'utf8').digest('hex');

/**
 * The `ocm-run` stand-in: `--status` answers idle (exit 0) for any directory
 * that does not begin with `broken-`, `--abort` confirms when the directory
 * exists, and any other invocation exits 64 like the real script does for an
 * unknown mode.
 */
export const FAKE_OCM_RUN = `#!/usr/bin/env node
const args = process.argv.slice(2);
const dir = args[args.indexOf('--dir') + 1] ?? '';
const name = dir.split('/').pop() ?? '';
if (args.includes('--status')) {
  if (name.startsWith('broken-')) process.exit(1);
  process.exit(0);
}
if (args.includes('--abort')) {
  process.exit(require('node:fs').existsSync(dir) ? 0 : 1);
}
process.exit(64);
`;

export async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(
    'git',
    [
      '-c', 'user.name=Fixture',
      '-c', 'user.email=fixture@example.invalid',
      '-c', 'commit.gpgsign=false',
      ...args,
    ],
    { cwd, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } },
  );
  return stdout;
}

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

export interface RelaunchApplyFixture {
  readonly root: string;
  readonly stateDir: string;
  readonly clonePath: string;
  readonly worktreePath: string;
  /** The clone's (and the work order's) base commit. */
  readonly baseCommit: string;
  /** The worktree's own lane commit, one strict descendant of the base. */
  readonly laneCommit: string;
  readonly runtime: FleetCliRuntime;
  /** The fixture's frozen instant: the trusted clock and every `--now` flag. */
  readonly nowIso: string;
  /** The ephemeral owner key file `sign-decision --key` reads. */
  readonly keyPath: string;
}

const roots: string[] = [];

/** Removes every fixture root the process created; tests call it in `afterAll`. */
export function cleanupRelaunchApplyFixtures(): void {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
}

/**
 * Builds the fixture: the clone holds one commit; the lane's worktree is a
 * real linked worktree of that clone; the runtime pins the ephemeral owner
 * key and freezes its clock at the fixture's instant.
 */
export async function makeRelaunchApplyFixture(prefix = 'fleet-v2-relaunch-apply-'): Promise<RelaunchApplyFixture> {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
  roots.push(root);
  const stateDir = path.join(root, 'state');
  const clonePath = path.join(root, 'clone');
  const worktreeRoot = path.join(root, 'worktrees');
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(clonePath, { recursive: true });
  mkdirSync(worktreeRoot, { recursive: true });
  await git(clonePath, 'init', '--quiet', '-b', 'main');
  writeFileSync(path.join(clonePath, 'README.md'), 'fixture\n');
  await git(clonePath, 'add', 'README.md');
  await git(clonePath, 'commit', '--quiet', '-m', 'fixture');
  const worktreePath = path.join(worktreeRoot, 'wt-adopt');
  await git(clonePath, 'worktree', 'add', '--quiet', '-b', WORKTREE_BRANCH, worktreePath);
  // The lane's own committed output: one file under the owned path prefix,
  // committed in the worktree, so the worktree is clean one commit ahead of
  // the base.
  mkdirSync(path.join(worktreePath, 'packages/adopted/src'), { recursive: true });
  writeFileSync(path.join(worktreePath, 'packages/adopted/src/a.ts'), 'lane output\n');
  await git(worktreePath, 'add', 'packages/adopted/src/a.ts');
  await git(worktreePath, 'commit', '--quiet', '-m', 'lane output');
  const ocmRunBin = path.join(root, 'ocm-run');
  writeFileSync(ocmRunBin, FAKE_OCM_RUN);
  chmodSync(ocmRunBin, 0o755);
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const ownerPublicKey = publicKey.export({ format: 'der', type: 'spki' }).subarray(12).toString('base64');
  const keyPath = path.join(root, 'owner-key.pem');
  await writeFile(keyPath, privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(), { mode: 0o600 });
  const nowIso = new Date().toISOString();
  const runtime = createFleetCliRuntime({
    stateDir,
    installation: installation(root),
    ocmRunBin,
    daemonNow: () => nowIso,
    ownerPublicKey,
  });
  const baseCommit = (await git(clonePath, 'rev-parse', 'HEAD')).trim();
  const laneCommit = (await git(worktreePath, 'rev-parse', 'HEAD')).trim();
  return { root, stateDir, clonePath, worktreePath, baseCommit, laneCommit, runtime, nowIso, keyPath };
}

/**
 * The stored plan the live apply runs: one conducted lane in wave 0 (its run
 * is not in the repository, so it counts no live run) and the worktree lane
 * in wave 1 with the full save/abort/adopt/redispatch step set. The step keys
 * are re-keyed to the final digest, exactly as `planRelaunch` stores them.
 */
export function buildRelaunchApplyPlan(): RelaunchPlanRecord {
  const placeholder = '0'.repeat(64);
  const heldLane = {
    laneId: HELD_LANE_ID,
    hostName: HOST,
    projectId: null,
    population: 'conducted' as const,
    runnerState: 'running' as const,
    runId: HELD_RUN_ID,
    attemptId: null,
    workOrderId: null,
    baseBranch: 'main',
    chainHead: true,
    dependsOnLaneIds: [],
    admissionWave: 0,
    dispatchEndpointKey: null,
    staggerOffsetMs: null,
    steps: [],
  };
  const adoptLane = {
    laneId: LANE_ID,
    hostName: HOST,
    projectId: 'proj-adopt',
    population: 'attempt-recorded' as const,
    runnerState: 'running' as const,
    runId: null,
    attemptId: ATTEMPT_ID,
    workOrderId: WORK_ORDER_ID,
    baseBranch: 'main',
    chainHead: false,
    dependsOnLaneIds: [],
    admissionWave: 1,
    dispatchEndpointKey: `opencode:${HOST}:${RUNNER_PORT}`,
    staggerOffsetMs: 0,
    steps: (['save', 'abort', 'adopt', 'redispatch'] as const).map((code) => ({
      step: code,
      idempotencyKey: `relaunch/${placeholder}/${LANE_ID}/${code}`,
    })),
  };
  const body = {
    schemaVersion: 1 as const,
    hostFilter: null,
    maxActiveRuns: 3,
    dispatchStaggerMs: 250,
    conductor: { halted: true, driverLease: 'lapsed' as const, runCount: 2 },
    lanes: [heldLane, { ...adoptLane }],
  };
  const planDigest = sha256HexDigest(
    canonicalRelaunchPlanBodyJson(body as unknown as Parameters<typeof canonicalRelaunchPlanBodyJson>[0]),
  );
  return {
    ...body,
    planDigest,
    requestDigest: 'a'.repeat(64),
    createdAtIso: '2026-11-23T09:00:00Z',
    lanes: [
      heldLane,
      {
        ...adoptLane,
        steps: (['save', 'abort', 'adopt', 'redispatch'] as const).map((code) => ({
          step: code,
          idempotencyKey: `relaunch/${planDigest}/${LANE_ID}/${code}`,
        })),
      },
    ],
  } as unknown as RelaunchPlanRecord;
}

/** The save input for the worktree lane: the real paths, the real base commit, the recorded local runner. */
export function saveInputFor(fx: RelaunchApplyFixture): Record<string, unknown> {
  return {
    laneId: LANE_ID,
    attemptId: ATTEMPT_ID,
    worktreePath: fx.worktreePath,
    clonePath: fx.clonePath,
    recordedHost: {
      kind: 'opencode',
      remotePort: RUNNER_PORT,
      host: null,
      hostName: HOST,
      agent: null,
      model: null,
      variant: null,
    },
    baseCommit: fx.baseCommit,
    allowedPathPrefixes: ['packages/adopted/'],
  };
}

/** The adopt input for the worktree lane; every cross-checked id matches the plan lane and the save input. */
export function adoptInputFor(fx: RelaunchApplyFixture, planDigest: string): Record<string, unknown> {
  return {
    laneId: LANE_ID,
    projectId: 'proj-adopt',
    baseBranch: 'main',
    planRef: { projectId: 'proj-adopt', planId: planDigest, laneId: LANE_ID },
    workOrder: {
      workOrderId: WORK_ORDER_ID,
      taskId: 'task-adopt',
      repository: 'https://example.com/example.git',
      baseCommit: fx.baseCommit,
      ownedPaths: ['packages/adopted/src/a.ts'],
      policyRevision: 'pol-1',
    },
    brief: {
      briefId: 'brief-adopt',
      briefText: BRIEF_TEXT,
      expectedBriefDigest: BRIEF_DIGEST,
      prosePath: 'brief/prose.md',
      manifestPath: 'brief/manifest.json',
      reviewerModel: 'reviewer-1',
      acceptanceSpec: { commitRequired: true, diffCheck: true, commands: [{ argv: ['yarn', 'test'] }] },
    },
    attempt: { attemptId: ATTEMPT_ID, endedAtIso: fx.nowIso, sessionId: null },
    run: {
      runId: RUN_ID,
      tier: 2,
      seatPlanRef: 'e'.repeat(64),
      runPolicyRevision: 'pol-1',
      branchName: WORKTREE_BRANCH,
    },
    // The worktree's own clean-head facts: the lane's worktree is clean at
    // the base commit on its run branch, so the adopt takes the clean-commit
    // source (the caller's declaration) instead of deriving the save-ref
    // source from the journal.
    source: {
      kind: 'clean-commit',
      branchName: WORKTREE_BRANCH,
      commitOid: fx.laneCommit,
      commitOnBranch: true,
      dirtyCount: 0,
      commitsSinceBase: [fx.laneCommit],
    },
  };
}

/**
 * The recorded attempt of the held lane, as the conductor would have left it
 * when the run was interrupted: ended, partial, with its artifacts sealed at
 * the worktree's clean head. `relaunch apply`'s save resolves the worktree's
 * runner through this record, and `adoptLane`'s attempt step requires the
 * same record to match the adopt input.
 */
export async function seedAttemptRecord(fx: RelaunchApplyFixture): Promise<void> {
  await fx.runtime.execution.attemptRepository.saveAttempt({
    id: ATTEMPT_ID,
    workOrderId: WORK_ORDER_ID,
    kind: 'initial',
    fixNumber: 0,
    priorAttemptId: null,
    worktreePath: fx.worktreePath,
    baseCommit: fx.baseCommit,
    state: 'ended',
    outcome: 'partial',
    briefDigest: BRIEF_DIGEST,
    briefPackagePath: 'brief/manifest.json',
    sessionId: null,
    completionReceipt: null,
    artifacts: {
      headCommit: fx.laneCommit,
      commitsSinceBase: [fx.laneCommit],
      collectedArtifactPaths: [],
      notes: 'missing',
    },
    runner: {
      kind: 'opencode',
      remotePort: RUNNER_PORT,
      host: null,
      hostName: HOST,
      agent: null,
      model: null,
      variant: null,
    },
    reviewerSeat: null,
    createdAtIso: fx.nowIso,
    updatedAtIso: fx.nowIso,
  });
}

interface Captured extends CliIo {
  readonly out: string[];
  readonly err: string[];
}

/** A capturing io for `runCli`. */
export function captureIo(): Captured {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, stdout: (text) => out.push(text), stderr: (text) => err.push(text) };
}

export interface RunOutcome {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** One `runCli` invocation over the fixture's runtime; the JSON document is parsed by the caller. */
export async function runFleetCli(
  fx: RelaunchApplyFixture,
  args: readonly string[],
): Promise<RunOutcome> {
  const io = captureIo();
  const code = await runCli([...args], io, fx.runtime);
  return { code, stdout: io.out.join(''), stderr: io.err.join('') };
}

/**
 * Mints the relaunch-apply owner grant through the three documented commands
 * (`relaunch request-grant`, `coordination request-decision`,
 * `coordination sign-decision --answer approve --yes`) over the fixture's
 * ephemeral key file, and binds the signed approval onto the recorded
 * request — the same refresh `ResolveActionAuthorizationUseCase` performs
 * from a verified answer — because the CLI has no standalone record-refresh
 * command. The signature itself is verified at resolve time against the
 * pinned key, so the bind step carries no authority of its own.
 */
export async function mintRelaunchGrant(fx: RelaunchApplyFixture, planDigest: string): Promise<string> {
  const prepared = await runFleetCli(fx, [
    'relaunch', 'request-grant', '--plan-digest', planDigest, '--now', fx.nowIso,
  ]);
  if (prepared.code !== 0) throw new Error(`request-grant failed: ${prepared.stderr}`);
  const preparedDoc = JSON.parse(prepared.stdout) as {
    requestId: string;
    signCommand: string;
    requestCommand: string;
  };
  const recorded = await runFleetCli(fx, [
    'coordination', 'request-decision',
    '--request-id', preparedDoc.requestId,
    '--project-id', 'relaunch',
    '--kind', 'action-decision',
    '--action-scope', 'relaunch:apply',
    '--proposal-digest', planDigest,
    '--policy-revision', 'pol-1',
    '--now-iso', fx.nowIso,
  ]);
  if (recorded.code !== 0) throw new Error(`request-decision failed: ${recorded.stderr}`);
  const signed = await runFleetCli(fx, [
    'coordination', 'sign-decision',
    '--request', preparedDoc.requestId,
    '--answer', 'approve',
    '--decision-revision', 'dec-1',
    '--key', fx.keyPath,
    '--yes',
  ]);
  if (signed.code !== 0) throw new Error(`sign-decision failed: ${signed.stderr}`);
  const grantId = `grant-${preparedDoc.requestId}`;
  const repository = fx.runtime.coordination.coordinationRequestRepository;
  const record = await repository.findRequestById(preparedDoc.requestId);
  if (record === null) throw new Error('the recorded decision request vanished');
  await repository.saveRequest({
    ...record,
    state: 'approved',
    decisionRevision: 'dec-1',
    grantId,
    revision: record.revision + 1,
    updatedAtIso: fx.nowIso,
  });
  return grantId;
}
