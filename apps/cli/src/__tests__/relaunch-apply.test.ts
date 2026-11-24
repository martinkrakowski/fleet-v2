/**
 * AR3c2 — `relaunch request-grant` and `relaunch apply` through the production
 * composition. `request-grant` derives the digest-bound `relaunch:apply` grant
 * coordinates from a plan digest and refuses hostile flags with exit 2. The
 * live-apply e2e runs the real owner sequence — `relaunch plan`,
 * `relaunch request-grant`, `coordination request-decision`, a pre-signature
 * `grant-missing` refusal, `coordination sign-decision` with an ephemeral
 * Ed25519 owner key, `coordination resolve-auth` authorizing, then a live
 * `relaunch apply` wave that saves and adopts one real lane worktree — over a
 * real git clone with linked worktrees and a fake `ocm-run` stand-in. Nothing
 * is mocked except the stand-in's answers and the owner key is ephemeral,
 * written outside the state directory and any worktree.
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';

import { afterAll, describe, expect, it } from 'vitest';

import { parseInstallation, type FleetInstallation } from '@fleet/installation';
import type { PlanRelaunchResult } from '@fleet/work-execution';
import {
  isStrictIsoInstant,
  relaunchApplyDigestPayload,
  RELAUNCH_APPLY_DIGEST_PREFIX,
  RELAUNCH_APPLY_PROJECT_ID,
} from '@fleet/operator-coordination';

import { createFleetCliRuntime, type FleetCliRuntime } from '../composition.js';
import { relaunchCommands } from '../relaunch.js';
import { runCli, type CliIo } from '../index.js';
import { CliUsageError } from '../commands/payload.js';
import { ephemeralOwnerKey, type EphemeralOwnerKey } from './signed-decision-fixture.js';

const execFileAsync = promisify(execFile);

/** The fixture clone's real HEAD: the save's diff check resolves the base commit in git, so a made-up sha cannot stand in. */
let COMMIT = 'a'.repeat(40);
const HOST = 'lane-host';
const RUNNER_PORT = 46_000;
const RUN_ID = 'run-01JC000000000000000000000B';
const BRIEF_TEXT = 'do the thing';
const BRIEF_DIGEST = createHash('sha256').update(BRIEF_TEXT).digest('hex');
const PLAN_DIGEST = 'b'.repeat(64);

const roots: string[] = [];

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/**
 * The `ocm-run` stand-in: `--status` reports exactly the session the seeded
 * attempt records (`ses_<directory name>`), so the inventory proves the
 * lane's claim; `--abort` stops it by writing a marker beside the worktree
 * (never inside it), after which `--status` answers idle.
 */
const FAKE_OCM_RUN = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const dir = args[args.indexOf('--dir') + 1] ?? '';
const name = path.basename(dir);
const marker = path.join(path.dirname(dir), '.ocm-' + name + '.stopped');
if (args.includes('--abort')) {
  fs.writeFileSync(marker, 'stopped');
  process.exit(0);
}
if (!args.includes('--status')) process.exit(64);
if (fs.existsSync(marker)) process.exit(0);
process.stdout.write('ocm-run: running in ' + dir + ':\\nses_' + name.replace(/[^A-Za-z0-9]/g, '_') + '\\n');
process.exit(3);
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
  readonly worktreePath: string;
  readonly runtime: FleetCliRuntime;
  readonly ownerKey: EphemeralOwnerKey;
}

/** One clone, one linked worktree with an uncommitted edit, one owner key, one registered profile. */
async function fixture(): Promise<Fixture> {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'fleet-v2-relaunch-apply-')));
  roots.push(root);
  const stateDir = path.join(root, 'state');
  const clonePath = path.join(root, 'clone');
  const worktreeRoot = path.join(root, 'worktrees');
  const worktreePath = path.join(worktreeRoot, 'lane-one');
  await fs.mkdir(stateDir, { recursive: true });
  await fs.mkdir(clonePath, { recursive: true });
  await fs.mkdir(worktreeRoot, { recursive: true });
  await git(clonePath, 'init', '--quiet', '-b', 'main');
  await fs.writeFile(path.join(clonePath, 'README.md'), 'fixture\n');
  await git(clonePath, 'add', 'README.md');
  await git(clonePath, 'commit', '--quiet', '-m', 'fixture');
  COMMIT = (await git(clonePath, 'rev-parse', 'HEAD')).trim();
  await git(clonePath, 'worktree', 'add', '--quiet', '-b', 'fleet/lane-one', worktreePath);
  // The lane's uncommitted edit, inside the save input's allowed prefixes and
  // free of every secret shape: the save's diff check must stay clean.
  await fs.mkdir(path.join(worktreePath, 'packages', 'pkg-one', 'src'), { recursive: true });
  await fs.writeFile(path.join(worktreePath, 'packages', 'pkg-one', 'src', 'feature.ts'), 'export const one = 1;\n');
  const ocmRunBin = path.join(root, 'ocm-run');
  writeFileSync(ocmRunBin, FAKE_OCM_RUN);
  chmodSync(ocmRunBin, 0o755);
  const ownerKey = ephemeralOwnerKey();
  const runtime = createFleetCliRuntime({
    stateDir,
    installation: installation(root),
    ocmRunBin,
    ownerPublicKey: ownerKey.ownerPublicKey,
  });
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
  await runtime.execution.workOrderRepository.saveWorkOrder({
    id: 'wo-1',
    projectId: 'proj-1',
    taskId: 'task-1',
    laneId: 'attempt-l1',
    repository: 'https://example.com/example.git',
    baseCommit: COMMIT,
    ownedPaths: ['packages/pkg-one/src/feature.ts'],
    policyRevision: 'pol-1',
    prerequisiteWorkOrderIds: [],
    state: 'implementing',
    revision: 1,
    createdAtIso: new Date().toISOString(),
    updatedAtIso: new Date().toISOString(),
    risk: 'standard',
    baseBranch: 'main',
    planRef: { projectId: 'proj-1', planId: 'plan-1', laneId: 'attempt-l1' },
  });
  const now = new Date().toISOString();
  await runtime.execution.attemptRepository.saveAttempt({
    id: 'attempt-l1',
    workOrderId: 'wo-1',
    kind: 'initial',
    fixNumber: 0,
    priorAttemptId: null,
    worktreePath,
    baseCommit: COMMIT,
    state: 'running',
    outcome: null,
    briefDigest: 'b'.repeat(64),
    briefPackagePath: 'brief/manifest.json',
    sessionId: 'ses_lane_one',
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
    createdAtIso: now,
    updatedAtIso: now,
  });
  return { root, stateDir, clonePath, worktreeRoot, worktreePath, runtime, ownerKey };
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

async function cli(
  runtime: FleetCliRuntime,
  argv: readonly string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const io = capture();
  const code = await runCli(argv, io, runtime);
  return { code, stdout: io.out.join(''), stderr: io.err.join('') };
}

/** The per-lane facts one live apply wave needs, as JSON flag values. */
function saveInputsJson(fx: Fixture): string {
  return JSON.stringify([
    {
      laneId: 'attempt-l1',
      attemptId: 'attempt-l1',
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
      baseCommit: COMMIT,
      allowedPathPrefixes: ['packages/pkg-one/'],
    },
  ]);
}

function adoptInputsJson(): string {
  return JSON.stringify([
    {
      laneId: 'attempt-l1',
      projectId: 'proj-1',
      planRef: { projectId: 'proj-1', planId: 'plan-1', laneId: 'attempt-l1' },
      baseBranch: 'main',
      workOrder: {
        workOrderId: 'wo-1',
        taskId: 'task-1',
        repository: 'https://example.com/example.git',
        baseCommit: COMMIT,
        ownedPaths: ['packages/pkg-one/src/feature.ts'],
        policyRevision: 'pol-1',
        risk: 'standard',
        prerequisiteWorkOrderIds: [],
      },
      brief: {
        briefId: 'brief-l1',
        briefText: BRIEF_TEXT,
        expectedBriefDigest: BRIEF_DIGEST,
        prosePath: 'brief/prose.md',
        manifestPath: 'brief/manifest.json',
        reviewerModel: 'reviewer-1',
        acceptanceSpec: { commitRequired: true, diffCheck: true, commands: [{ argv: ['yarn', 'test'] }] },
      },
      attempt: { attemptId: 'attempt-l1', endedAtIso: '2026-11-23T10:05:00Z', sessionId: null },
      run: {
        runId: RUN_ID,
        tier: 2,
        seatPlanRef: 'e'.repeat(64),
        runPolicyRevision: 'pol-1',
      },
    },
  ]);
}

interface RequestGrantResult {
  readonly outcome: 'ready';
  readonly requestId: string;
  readonly grantId: string;
  readonly planDigest: string;
  readonly createdAtIso: string;
  readonly requestCommand: string;
  readonly signCommand: string;
  readonly resolveCommand: string;
}

describe('relaunch request-grant (AR3c2)', () => {
  /** A disposable runtime whose state directory is cleaned up with the roots. */
  function tempRuntime(): FleetCliRuntime {
    const stateDir = mkdtempSync(path.join(tmpdir(), 'fleet-v2-req-grant-'));
    roots.push(stateDir);
    return createFleetCliRuntime({ stateDir });
  }

  it('derives the grant coordinates and prints the exact golden commands for a fixed --now', async () => {
    const nowIso = '2026-11-23T10:00:00.000Z';
    const { code, stdout } = await cli(
      tempRuntime(),
      ['relaunch', 'request-grant', '--plan-digest', PLAN_DIGEST, '--policy-revision', 'pol-1', '--now', nowIso],
    );
    expect(code).toBe(0);
    const result = JSON.parse(stdout) as RequestGrantResult;
    const expectedRequestId =
      RELAUNCH_APPLY_DIGEST_PREFIX +
      createHash('sha256')
        .update(
          relaunchApplyDigestPayload({
            projectId: RELAUNCH_APPLY_PROJECT_ID,
            proposalDigest: PLAN_DIGEST,
            createdAtIso: nowIso,
          }),
        )
        .digest('hex');
    expect(result).toEqual({
      outcome: 'ready',
      requestId: expectedRequestId,
      grantId: `grant-${expectedRequestId}`,
      planDigest: PLAN_DIGEST,
      createdAtIso: nowIso,
      requestCommand: `fleet-v2 coordination request-decision --request-id ${expectedRequestId} --project-id relaunch --kind action-decision --action-scope relaunch:apply --proposal-digest ${PLAN_DIGEST} --policy-revision pol-1 --now-iso ${nowIso}`,
      signCommand: `fleet-v2 coordination sign-decision --request ${expectedRequestId} --answer approve --key <path> --yes`,
      resolveCommand: `fleet-v2 coordination resolve-auth --project-id relaunch --action-scope relaunch:apply --proposal-digest ${PLAN_DIGEST} --authorization-grant-id grant-${expectedRequestId}`,
    });
  });

  it('rejects invalid plan-digest with exit 2', async () => {
    const runtime = tempRuntime();
    for (const [flags, viaJson] of [
      [['--policy-revision', 'pol-1'], undefined],
      [['--plan-digest', 'A'.repeat(64), '--policy-revision', 'pol-1'], undefined],
      [['--plan-digest', 'a'.repeat(63), '--policy-revision', 'pol-1'], undefined],
      [['--plan-digest', 'a'.repeat(65), '--policy-revision', 'pol-1'], undefined],
      [['--policy-revision', 'pol-1'], { planDigest: 7 }],
    ] as const) {
      const argv = ['relaunch', 'request-grant', ...flags];
      const { code, stderr } = await cli(runtime, viaJson === undefined ? argv : ['relaunch', 'request-grant', '--json', JSON.stringify(viaJson)]);
      expect(code, JSON.stringify(viaJson ?? flags)).toBe(2);
      expect(stderr).not.toContain('a'.repeat(64));
    }
  });

  it('rejects non-string and shell-metacharacter policy-revision with exit 2', async () => {
    const runtime = tempRuntime();
    for (const viaJson of [
      { planDigest: PLAN_DIGEST },
      { planDigest: PLAN_DIGEST, policyRevision: 7 },
      { planDigest: PLAN_DIGEST, policyRevision: 'p'.repeat(129) },
      { planDigest: PLAN_DIGEST, policyRevision: 'pol;rm -rf /' },
      { planDigest: PLAN_DIGEST, policyRevision: 'pol|cat' },
      { planDigest: PLAN_DIGEST, policyRevision: 'pol&whoami' },
      { planDigest: PLAN_DIGEST, policyRevision: 'pol$x' },
      { planDigest: PLAN_DIGEST, policyRevision: 'pol`id`' },
      { planDigest: PLAN_DIGEST, policyRevision: 'pol<in' },
      { planDigest: PLAN_DIGEST, policyRevision: "pol'quote" },
      { planDigest: PLAN_DIGEST, policyRevision: 'pol(sub)' },
      { planDigest: PLAN_DIGEST, policyRevision: 'pol\nline' },
      { planDigest: PLAN_DIGEST, policyRevision: 'pol\u0000nul' },
      { planDigest: PLAN_DIGEST, policyRevision: 'pol spaced' },
    ]) {
      const { code, stderr } = await cli(runtime, [
        'relaunch',
        'request-grant',
        '--json',
        JSON.stringify(viaJson),
      ]);
      expect(code, JSON.stringify(viaJson.policyRevision ?? '(missing)')).toBe(2);
      expect(stderr).not.toContain('rm -rf');
      expect(stderr).not.toContain('whoami');
    }
  });

  it('rejects invalid --now with exit 2', async () => {
    const runtime = tempRuntime();
    for (const now of ['not-a-timestamp', '2026-02-30T00:00:00.000Z', '2026-11-23T10:00:00', '7']) {
      const { code } = await cli(runtime, [
        'relaunch',
        'request-grant',
        '--plan-digest',
        PLAN_DIGEST,
        '--policy-revision',
        'pol-1',
        '--now',
        now,
      ]);
      expect(code, now).toBe(2);
    }
  });
});

describe('relaunch apply live e2e (AR3c2)', () => {
  it('runs the real owner sequence and applies one wave through the production composition', async () => {
    const fx = await fixture();

    // 1. `relaunch plan`: one attempt-recorded, runner-idle lane with the
    // save/adopt/redispatch steps, stored by digest.
    const planned = await cli(fx.runtime, ['relaunch', 'plan']);
    expect(planned.code, `${planned.stdout}\n${planned.stderr}`).toBe(0);
    const planResult = JSON.parse(planned.stdout) as PlanRelaunchResult;
    expect(planResult.outcome, `${planned.stdout}\n${planned.stderr}`).toBe('planned');
    if (planResult.outcome !== 'planned') throw new Error('unreachable');
    const planDigest = planResult.plan.planDigest;
    const lane = planResult.plan.lanes.find((entry) => entry.laneId === 'attempt-l1');
    expect(lane).toBeDefined();
    expect(lane?.population).toBe('attempt-recorded');
    expect(lane?.steps.map((step) => step.step)).toEqual(['save', 'abort', 'adopt', 'redispatch']);

    // 2. `relaunch request-grant` derives the owner grant coordinates.
    const granted = await cli(fx.runtime, [
      'relaunch',
      'request-grant',
      '--plan-digest',
      planDigest,
      '--policy-revision',
      'pol-1',
    ]);
    expect(granted.code).toBe(0);
    const grant = JSON.parse(granted.stdout) as RequestGrantResult;
    expect(grant.outcome).toBe('ready');
    expect(grant.requestId.startsWith(RELAUNCH_APPLY_DIGEST_PREFIX)).toBe(true);
    expect(isStrictIsoInstant(grant.createdAtIso)).toBe(true);
    // The printed request command, replayed verbatim (modulo the executable
    // prefix), records the matching coordination request.
    const recorded = await cli(fx.runtime, [
      'coordination',
      'request-decision',
      '--request-id',
      grant.requestId,
      '--project-id',
      'relaunch',
      '--kind',
      'action-decision',
      '--action-scope',
      'relaunch:apply',
      '--proposal-digest',
      planDigest,
      '--policy-revision',
      'pol-1',
      '--now-iso',
      grant.createdAtIso,
    ]);
    expect(recorded.code).toBe(0);
    expect(JSON.parse(recorded.stdout)).toMatchObject({ outcome: 'requested' });

    // 3. BEFORE the owner signs, the live apply refuses `grant-missing` (exit 1).
    const beforeSign = await cli(fx.runtime, [
      'relaunch',
      'apply',
      '--plan-digest',
      planDigest,
      '--apply',
      '--grant',
      grant.grantId,
      '--save-inputs',
      saveInputsJson(fx),
      '--adopt-inputs',
      adoptInputsJson(),
    ]);
    expect(beforeSign.code).toBe(1);
    expect(JSON.parse(beforeSign.stdout)).toEqual({ outcome: 'refused', reason: 'grant-missing' });
    // The refusal spent nothing: the lane's worktree still holds its edit and
    // the cutover journal is empty.
    expect(await fs.readFile(path.join(fx.worktreePath, 'packages', 'pkg-one', 'src', 'feature.ts'), 'utf8')).toContain(
      'export const one = 1;',
    );
    const journalBefore = await fx.runtime.execution.cutoverJournal.listByKeyPrefix(`relaunch/${planDigest}/`);
    if (journalBefore.outcome !== 'listed') throw new Error('journal unreadable');
    expect(journalBefore.entries).toEqual([]);

    // 4. The owner signs the decision with the ephemeral key. The PKCS8 PEM is
    // written mode 0600 outside the state directory and every worktree.
    const keyPath = path.join(fx.root, 'owner-key.pem');
    writeFileSync(keyPath, fx.ownerKey.privateKey.export({ type: 'pkcs8', format: 'pem' }));
    chmodSync(keyPath, 0o600);
    const signed = await cli(fx.runtime, [
      'coordination',
      'sign-decision',
      '--request',
      grant.requestId,
      '--answer',
      'approve',
      '--key',
      keyPath,
      '--yes',
    ]);
    expect(signed.code).toBe(0);
    expect(JSON.parse(signed.stdout)).toMatchObject({ outcome: 'signed', grantId: grant.grantId });

    // 5. The owner resolve authorizes the grant — head-free, through the
    // recorded-answer refresh.
    const resolved = await cli(fx.runtime, [
      'coordination',
      'resolve-auth',
      '--project-id',
      'relaunch',
      '--action-scope',
      'relaunch:apply',
      '--proposal-digest',
      planDigest,
      '--authorization-grant-id',
      grant.grantId,
    ]);
    expect(resolved.code).toBe(0);
    expect(JSON.parse(resolved.stdout)).toMatchObject({
      outcome: 'authorized',
      grantId: grant.grantId,
      requestId: grant.requestId,
      expectedHeadSha: '',
    });

    // 6. First live apply: the save and adopt run; the seeded attempt record
    // does not yet match what the adopt requires (it is still `running` with
    // no collected artifact), so the lane stops with `adopt-failed` AFTER the
    // save completed and journaled.
    const firstApply = await cli(fx.runtime, [
      'relaunch',
      'apply',
      '--plan-digest',
      planDigest,
      '--apply',
      '--grant',
      grant.grantId,
      '--save-inputs',
      saveInputsJson(fx),
      '--adopt-inputs',
      adoptInputsJson(),
    ]);
    expect(firstApply.code).toBe(1);
    expect(JSON.parse(firstApply.stdout)).toEqual({ outcome: 'refused', reason: 'adopt-failed', laneId: 'attempt-l1' });
    const firstJournal = await fx.runtime.execution.cutoverJournal.listByKeyPrefix(`relaunch/${planDigest}/attempt-l1/`);
    if (firstJournal.outcome !== 'listed') throw new Error('journal unreadable');
    const saveResult = firstJournal.entries.find(
      (entry) => entry.key === `relaunch/${planDigest}/attempt-l1/save` && entry.kind === 'result',
    );
    expect(saveResult).toMatchObject({ outcome: 'completed' });
    const saveCommit = (saveResult as { commitId?: string }).commitId;
    expect(typeof saveCommit).toBe('string');

    // 7. The attempt's collected facts are updated to what the adopt expects
    // (a fixture step: the lane's real driver records them, the apply never
    // writes attempt records itself).
    const attempt = await fx.runtime.execution.attemptRepository.findAttemptById('attempt-l1');
    expect(attempt).not.toBeNull();
    if (attempt === null) throw new Error('unreachable');
    const storedRevision = attempt.revision ?? 0;
    await fx.runtime.execution.attemptRepository.saveAttempt({
      ...attempt,
      state: 'ended',
      outcome: 'partial',
      briefDigest: BRIEF_DIGEST,
      artifacts: {
        headCommit: saveCommit as string,
        commitsSinceBase: [saveCommit as string],
        collectedArtifactPaths: [],
        notes: 'missing',
      },
      revision: storedRevision + 1,
      updatedAtIso: new Date().toISOString(),
    });

    // 8. The replayed apply re-derives everything from the journal (the save
    // and its intent are never repeated), adopts the lane into a conducted
    // run and journals the redispatch hand-off: applied, wave 1.
    const secondApply = await cli(fx.runtime, [
      'relaunch',
      'apply',
      '--plan-digest',
      planDigest,
      '--apply',
      '--grant',
      grant.grantId,
      '--save-inputs',
      saveInputsJson(fx),
      '--adopt-inputs',
      adoptInputsJson(),
    ]);
    expect(secondApply.code).toBe(0);
    const applied = JSON.parse(secondApply.stdout) as { outcome: string; wave: number | null };
    expect(applied).toMatchObject({ outcome: 'applied', wave: 1 });

    // 9. The cutover journal carries the completed save and the completed
    // adopt/work-order results.
    const finalJournal = await fx.runtime.execution.cutoverJournal.listByKeyPrefix(`relaunch/${planDigest}/attempt-l1/`);
    if (finalJournal.outcome !== 'listed') throw new Error('journal unreadable');
    const completed = (key: string): unknown =>
      finalJournal.entries.find((entry) => entry.key === key && entry.kind === 'result' && entry.outcome === 'completed');
    expect(completed(`relaunch/${planDigest}/attempt-l1/save`)).toBeDefined();
    expect(completed(`relaunch/${planDigest}/attempt-l1/adopt/work-order`)).toBeDefined();
    expect(completed(`relaunch/${planDigest}/attempt-l1/adopt/run`)).toBeDefined();
  });

  it('dry-runs by default with exit 0 and journals nothing', async () => {
    const fx = await fixture();
    const planned = await cli(fx.runtime, ['relaunch', 'plan']);
    const planResult = JSON.parse(planned.stdout) as PlanRelaunchResult;
    if (planResult.outcome !== 'planned') throw new Error('unreachable');
    const planDigest = planResult.plan.planDigest;

    const dry = await cli(fx.runtime, ['relaunch', 'apply', '--plan-digest', planDigest]);
    expect(dry.code).toBe(0);
    const result = JSON.parse(dry.stdout) as { outcome: string; planDigest: string };
    expect(result.outcome).toBe('dry-run');
    expect(result.planDigest).toBe(planDigest);
    const journal = await fx.runtime.execution.cutoverJournal.listByKeyPrefix(`relaunch/${planDigest}/`);
    if (journal.outcome !== 'listed') throw new Error('journal unreadable');
    expect(journal.entries).toEqual([]);
  });
});

describe('relaunch apply hostile payload gates (AR3c2)', () => {
  it('rejects invalid JSON, non-array, oversized, and escaped __proto__ via runCli with exit 2', async () => {
    const fx = await fixture();
    const base = ['relaunch', 'apply', '--plan-digest', PLAN_DIGEST];
    for (const [label, saveInputs] of [
      ['invalid JSON', '[{"laneId":'],
      ['non-array JSON', '{"laneId":"attempt-l1"}'],
      ['oversized JSON', `"${'x'.repeat(2_097_153)}"`],
      ['oversized array', JSON.stringify(Array.from({ length: 65 }, (_, i) => ({ laneId: `l${i}` })))],
      ['escaped __proto__', '[{"\\u005f\\u005fproto\\u005f\\u005f":{"polluted":true}}]'],
    ] as const) {
      const { code, stderr } = await cli(fx.runtime, [...base, '--save-inputs', saveInputs]);
      expect(code, label).toBe(2);
      expect(stderr, label).not.toContain('polluted');
      expect(stderr, label).not.toContain('x'.repeat(1000));
    }
    for (const adoptInputs of ['[{"laneId":', '{"laneId":"attempt-l1"}', '[{"constructor":{"x":1}}]']) {
      const { code } = await cli(fx.runtime, [...base, '--adopt-inputs', adoptInputs]);
      expect(code, adoptInputs).toBe(2);
    }
  });

  it('rejects getter, revoked Proxy, array-like, and sparse array with CliUsageError and zero getter calls', async () => {
    let getterCalls = 0;
    const getterArray: unknown[] = [];
    Object.defineProperty(getterArray, 0, {
      get() {
        getterCalls += 1;
        return { laneId: 'attempt-l1' };
      },
      enumerable: true,
    });
    getterArray.length = 1;
    const throwingProxy = new Proxy([{}], {
      get() {
        throw new Error('hostile get');
      },
      getOwnPropertyDescriptor() {
        throw new Error('hostile descriptor');
      },
      ownKeys() {
        throw new Error('hostile keys');
      },
      getPrototypeOf() {
        throw new Error('hostile prototype');
      },
    });
    const { proxy, revoke } = Proxy.revocable([{}], {});
    revoke();
    const arrayLike = { length: 1, 0: { laneId: 'attempt-l1' } };
    const sparse = new Array(1);
    sparse.length = 1;
    const rtStub = {} as FleetCliRuntime;
    for (const [label, hostile] of [
      ['getter on element', getterArray],
      ['throwing Proxy', throwingProxy],
      ['revoked Proxy', proxy],
      ['array-like', arrayLike],
      ['sparse array', sparse],
    ] as const) {
      await expect(
        relaunchCommands.apply({ planDigest: PLAN_DIGEST, saveInputs: hostile }, rtStub),
        label,
      ).rejects.toBeInstanceOf(CliUsageError);
    }
    expect(getterCalls).toBe(0);
  });

  it('refuses each inputs-clone hardening case (nested getter, symbol key, depth, node budget, array extras, foreign prototype, function and undefined values, polluting keys) in both flags with zero getter calls', async () => {
    let getterCalls = 0;
    const nestedGetter: Record<string, unknown> = { laneId: 'attempt-l1' };
    Object.defineProperty(nestedGetter, 'inner', {
      enumerable: true,
      get() {
        getterCalls += 1;
        return 1;
      },
    });
    const symbolKeyed: Record<PropertyKey, unknown> = { laneId: 'attempt-l1' };
    symbolKeyed[Symbol('hostile')] = 1;
    // Depth 11 of nested single-key objects exceeds MAX_INPUT_DEPTH (10).
    let deep: unknown = { leaf: 1 };
    for (let level = 0; level < 11; level += 1) deep = { next: deep };
    // 4,100 primitives in one element exceeds the 4,096-node budget while each
    // single array and object stays within its own bounds.
    const wide = Array.from({ length: 4100 }, (_, index) => index);
    const arrayWithExtra: unknown[] = [{}];
    (arrayWithExtra as unknown as Record<string, unknown>).extra = 1;
    const foreignPrototype = Object.setPrototypeOf([{}], null) as unknown[];
    const nestedHole: unknown[] = [];
    nestedHole.length = 1;
    const nestedProtoKey = JSON.parse('{"laneId":"attempt-l1","prototype":{"x":1}}') as unknown;
    const nestedConstructorKey = JSON.parse('{"a":{"constructor":{"x":1}}}') as unknown;
    const cases: ReadonlyArray<readonly [string, unknown]> = [
      ['nested object getter', [nestedGetter]],
      ['symbol key on an element', [symbolKeyed]],
      ['depth past the cap', [deep]],
      ['node budget past the cap', [{ wide }]],
      ['non-index own key on the array', arrayWithExtra],
      ['array with a foreign prototype', foreignPrototype],
      ['hole in a nested array', [{ nestedHole }]],
      ['nested prototype key', [nestedProtoKey]],
      ['nested constructor key', [nestedConstructorKey]],
      ['function value', [{ run: () => 1 }]],
      ['undefined value', [{ laneId: undefined }]],
      ['bigint value', [{ laneId: 1n }]],
    ];
    const rtStub = {} as FleetCliRuntime;
    for (const flag of ['saveInputs', 'adoptInputs'] as const) {
      for (const [label, hostile] of cases) {
        await expect(
          relaunchCommands.apply({ planDigest: PLAN_DIGEST, [flag]: hostile }, rtStub),
          `${flag}: ${label}`,
        ).rejects.toBeInstanceOf(CliUsageError);
      }
    }
    expect(getterCalls).toBe(0);
  });

  it('passes a dense array supplied through generic --json to the bounded reader, never a usage error', async () => {
    const fx = await fixture();
    const { code, stdout, stderr } = await cli(fx.runtime, [
      'relaunch',
      'apply',
      '--plan-digest',
      PLAN_DIGEST,
      '--json',
      JSON.stringify({ saveInputs: [{}] }),
    ]);
    // The dense array reached the use case (its own typed refusal), not the
    // CLI's array-document usage error.
    expect(stderr).not.toContain('JSON array');
    expect(code).toBe(1);
    expect(JSON.parse(stdout)).toEqual({ outcome: 'refused', reason: 'invalid-request' });
  });

  it('never echoes a secret sent through --grant, --save-inputs, or --adopt-inputs (usage and refusal paths)', async () => {
    const fx = await fixture();
    const grantSecret = 'sk-ant-api03-SECRETSENTINEL_12345';
    const tokenSecret = 'ghp_SECRETSENTINEL9999999999999999999999';

    // Usage path: a non-string --grant carrying secret-shaped keys.
    const nonStringGrant = await cli(fx.runtime, [
      'relaunch',
      'apply',
      '--plan-digest',
      PLAN_DIGEST,
      '--apply',
      '--json',
      JSON.stringify({ planDigest: PLAN_DIGEST, apply: true, grant: { [grantSecret]: 1 } }),
    ]);
    expect(nonStringGrant.code).toBe(2);
    expect(nonStringGrant.stdout + nonStringGrant.stderr).not.toContain('SECRETSENTINEL');

    // Refusal path: a secret-shaped --grant reaches the use case, which
    // refuses `secret-detected` without echoing it.
    const secretGrant = await cli(fx.runtime, [
      'relaunch',
      'apply',
      '--plan-digest',
      PLAN_DIGEST,
      '--apply',
      '--grant',
      grantSecret,
    ]);
    expect(secretGrant.code).toBe(1);
    expect(JSON.parse(secretGrant.stdout)).toEqual({ outcome: 'refused', reason: 'secret-detected' });
    expect(secretGrant.stdout + secretGrant.stderr).not.toContain('SECRETSENTINEL');

    // The input scan runs against a stored plan, so the refusal paths below
    // use a real plan digest.
    const plannedForScan = JSON.parse((await cli(fx.runtime, ['relaunch', 'plan'])).stdout) as PlanRelaunchResult;
    if (plannedForScan.outcome !== 'planned') throw new Error('plan fixture failed');
    const scanDigest = plannedForScan.plan.planDigest;

    // Refusal path for the inputs flags: a secret inside a well-formed array
    // (the secret rides in a validated field, so the parse's secret scan —
    // not a shape refusal — names it).
    for (const [flag, payload] of [
      [
        '--save-inputs',
        JSON.stringify([
          {
            laneId: 'attempt-l1',
            attemptId: 'attempt-l1',
            worktreePath: `/tmp/lanes/${tokenSecret}/wt`,
            clonePath: '/tmp/lanes/clone',
            recordedHost: null,
            baseCommit: COMMIT,
            allowedPathPrefixes: ['packages/pkg-one/'],
          },
        ]),
      ],
      [
        '--adopt-inputs',
        JSON.stringify([
          {
            ...JSON.parse(adoptInputsJson())[0],
            brief: { ...JSON.parse(adoptInputsJson())[0].brief, briefText: tokenSecret },
          },
        ]),
      ],
    ] as const) {
      const { code, stdout, stderr } = await cli(fx.runtime, [
        'relaunch',
        'apply',
        '--plan-digest',
        scanDigest,
        flag,
        payload,
      ]);
      expect(code, flag).toBe(1);
      expect(JSON.parse(stdout), flag).toEqual({ outcome: 'refused', reason: 'secret-detected' });
      expect(stdout + stderr, flag).not.toContain('SECRETSENTINEL');
    }

    // Usage path for the inputs flags: JSON that cannot parse still never
    // echoes the secret inside it.
    const badJson = await cli(fx.runtime, [
      'relaunch',
      'apply',
      '--plan-digest',
      PLAN_DIGEST,
      '--save-inputs',
      `[{"note":"${tokenSecret}"`,
    ]);
    expect(badJson.code).toBe(2);
    expect(badJson.stdout + badJson.stderr).not.toContain('SECRETSENTINEL');
  });

  it('rejects non-string --grant, --now, and --deadline, and non-boolean --apply with exit 2', async () => {
    const fx = await fixture();
    for (const json of [
      { planDigest: PLAN_DIGEST, apply: true, grant: 7 },
      { planDigest: PLAN_DIGEST, apply: true, grant: null },
      { planDigest: PLAN_DIGEST, now: 7 },
      { planDigest: PLAN_DIGEST, deadline: 7 },
      { planDigest: PLAN_DIGEST, apply: 'yes' },
      { planDigest: PLAN_DIGEST, apply: 1 },
    ]) {
      const { code } = await cli(fx.runtime, ['relaunch', 'apply', '--json', JSON.stringify(json)]);
      expect(code, JSON.stringify(json)).toBe(2);
    }
  });
});
