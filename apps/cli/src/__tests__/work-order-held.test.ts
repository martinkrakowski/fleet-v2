// PT1ca: `work-order register` refuses an overlap with an active work order or an
// open pull request and keeps the registration as held; `work-order held` lists
// it by ids and codes only. Driven through the real runCli, a state directory
// and a fake gh runner behind the GitHub forge mode.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import type { FleetInstallation } from '@fleet/installation';
import { LaneRun } from '@fleet/work-execution';

import { createFleetCliRuntime, type FleetCliRuntime } from '../composition.js';
import { runCli, type CliIo } from '../index.js';

const tempStateDirs: string[] = [];

afterAll(() => {
  for (const dir of tempStateDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const HEAD = '3dd5d90509461e3d2154b52da28671aeffa84130';
const T0 = '2026-11-07T10:00:00.000Z';
const T1 = '2026-11-07T10:30:00.000Z';
const T2 = '2026-11-07T11:00:00.000Z';

function installation(): FleetInstallation {
  return {
    schemaVersion: 2,
    hosts: {
      local: {
        transport: 'local',
        worktreeRoot: '/tmp/fleet-pt1ca-worktrees',
        roles: ['orchestrator', 'lane-runner'],
        runner: {
          kind: 'opencode',
          port: 46000,
          capabilities: {
            networkEgressRestricted: true,
            cpuAndMemoryLimited: true,
            processTreeTermination: true,
            filesystemScope: 'scoped-worktree',
          },
          maxLanes: 2,
        },
      },
    },
    forge: { mode: 'github', owner: 'acme', repo: 'fleet' },
  };
}

interface FakeForge {
  openPullRequests: readonly number[];
  files: Readonly<Record<number, readonly string[]>>;
  failFiles: boolean;
  calls: string[][];
}

function makeRuntime(forge: FakeForge): { runtime: FleetCliRuntime; stateDir: string } {
  const stateDir = mkdtempSync(path.join(tmpdir(), 'fleet-cli-held-'));
  tempStateDirs.push(stateDir);
  const runtime = createFleetCliRuntime({
    stateDir,
    installation: installation(),
    forgeGhRunner: async (args: readonly string[]) => {
      forge.calls.push([...args]);
      if (args[0] === 'api') {
        const stdout = forge.openPullRequests
          .map((number) => JSON.stringify({ number, head: { sha: HEAD }, base: { ref: 'main' } }))
          .join('\n');
        return { exitCode: 0, stdout, stderr: '' };
      }
      if (args[0] === 'pr' && args[1] === 'view' && args.includes('files')) {
        if (forge.failFiles) {
          return { exitCode: 1, stdout: '', stderr: 'boom' };
        }
        const number = Number(args[2]);
        return {
          exitCode: 0,
          stdout: JSON.stringify({ files: (forge.files[number] ?? []).map((file) => ({ path: file })) }),
          stderr: '',
        };
      }
      return { exitCode: 1, stdout: '', stderr: 'unexpected' };
    },
  });
  return { runtime, stateDir };
}

function newForge(overrides: Partial<FakeForge> = {}): FakeForge {
  return { openPullRequests: [], files: {}, failFiles: false, calls: [], ...overrides };
}

async function cli(
  runtime: FleetCliRuntime,
  argv: string[],
): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = { stdout: (text) => out.push(text), stderr: (text) => err.push(text) };
  const code = await runCli(argv, io, runtime);
  return { code, out: out.join(''), err: err.join('') };
}

async function registerProfile(runtime: FleetCliRuntime): Promise<void> {
  const result = await cli(runtime, [
    'coordination',
    'register-profile',
    '--json',
    JSON.stringify({
      projectId: 'example-project',
      displayName: 'Example Project',
      repository: 'https://example.com/example.git',
      designatedDispatcherHost: 'local',
      policyRevision: 'pol-1',
      maxConcurrentLanes: 2,
      runnerCapabilities: { 'scoped-worktree': true, networkEgressRestricted: true },
    }),
  ]);
  expect(result.code).toBe(0);
}

function register(
  runtime: FleetCliRuntime,
  workOrderId: string,
  ownedPaths: string,
  extra: string[] = [],
): Promise<{ code: number; out: string; err: string }> {
  return cli(runtime, [
    'work-order',
    'register',
    '--work-order-id',
    workOrderId,
    '--project-id',
    'example-project',
    '--task-id',
    'task-1',
    '--lane-id',
    'lane-1',
    '--repository',
    'acme/fleet',
    '--base-commit',
    'abc123',
    '--owned-paths',
    ownedPaths,
    '--policy-revision',
    'pol-1',
    ...extra,
  ]);
}

describe('work-order held (PT1ca)', () => {
  it('refuses on an open PR overlap, holds it, and lists it idempotently by ids and codes only', async () => {
    const forge = newForge({
      openPullRequests: [42],
      files: { 42: ['packages/example-held/src/x.ts', 'docs/other.md'] },
    });
    const { runtime } = makeRuntime(forge);
    await registerProfile(runtime);

    const refused = await register(runtime, 'wo-held-1', 'packages/example-held', [
      '--brief-request-ref',
      'brief-req-01',
      '--now-iso',
      T0,
    ]);
    expect(refused.code).toBe(1);
    const payload = JSON.parse(refused.out) as Record<string, unknown>;
    expect(payload).toMatchObject({
      outcome: 'refused',
      reason: 'open-pr-overlap',
      pullRequestNumber: 42,
      blockerKind: 'open-pr',
      blockerId: '42',
      held: true,
    });
    expect(payload.pathCode).toMatch(/^path-[0-9a-f]{12}$/);
    for (const text of [refused.out, refused.err]) {
      expect(text).not.toContain('packages/');
      expect(text).not.toContain('x.ts');
    }
    expect(forge.calls.some((args) => args.join(' ') === 'pr view 42 -R acme/fleet --json files')).toBe(true);
    expect((await cli(runtime, ['work-order', 'inspect', '--work-order-id', 'wo-held-1'])).out).toContain('not-found');
  });

  it('re-registers an overlap-refused request idempotently without duplicating held state', async () => {
    const forge = newForge({ openPullRequests: [42], files: { 42: ['packages/example-held/src/x.ts'] } });
    const { runtime } = makeRuntime(forge);
    await registerProfile(runtime);
    const first = await register(runtime, 'wo-held-1', 'packages/example-held', ['--brief-request-ref', 'brief-req-01', '--now-iso', T0]);
    const again = await register(runtime, 'wo-held-1', 'packages/example-held', ['--brief-request-ref', 'brief-req-01', '--now-iso', T1]);
    expect(again.code).toBe(1);
    expect(again.out).toBe(first.out);

    const listed = await cli(runtime, ['work-order', 'held', '--now-iso', T2]);
    expect(listed.code).toBe(0);
    expect(JSON.parse(listed.out)).toEqual({
      outcome: 'listed',
      held: [{ workOrderId: 'wo-held-1', blockerKind: 'open-pr', blockerId: '42', ageMinutes: 60 }],
    });
    expect(listed.out).not.toContain('packages/');

    const byProject = await cli(runtime, ['work-order', 'held', '--project-id', 'example-project', '--now-iso', T2]);
    expect(JSON.parse(byProject.out)).toMatchObject({ held: [{ workOrderId: 'wo-held-1' }] });
    const otherProject = await cli(runtime, ['work-order', 'held', '--project-id', 'nobody', '--now-iso', T2]);
    expect(JSON.parse(otherProject.out)).toEqual({ outcome: 'listed', held: [] });

    const mutated = await register(runtime, 'wo-held-1', 'packages/example-held', ['--brief-request-ref', 'brief-req-02', '--now-iso', T1]);
    expect(mutated.code).toBe(1);
    expect(JSON.parse(mutated.out)).toEqual({ outcome: 'refused', reason: 'held-request-mismatch' });
  });

  it('holds an active-work-order overlap and lists it with its blocker', async () => {
    const forge = newForge();
    const { runtime } = makeRuntime(forge);
    await registerProfile(runtime);
    expect((await register(runtime, 'wo-active-1', 'packages/example-active', ['--now-iso', T0])).code).toBe(0);
    const refused = await register(runtime, 'wo-active-2', 'packages/example-active/src', ['--now-iso', T0]);
    expect(refused.code).toBe(1);
    expect(JSON.parse(refused.out)).toMatchObject({
      reason: 'active-work-order-overlap',
      blockerKind: 'active-work-order',
      blockerId: 'wo-active-1',
      held: true,
    });
    expect(refused.out).not.toContain('packages/');
    const listed = await cli(runtime, ['work-order', 'held', '--now-iso', T1]);
    expect(JSON.parse(listed.out)).toEqual({
      outcome: 'listed',
      held: [{ workOrderId: 'wo-active-2', blockerKind: 'active-work-order', blockerId: 'wo-active-1', ageMinutes: 30 }],
    });
  });

  it('does not let an open PR bound to the same work order in lane-runs.json block registration', async () => {
    const forge = newForge({ openPullRequests: [42], files: { 42: ['packages/example-bound/src/x.ts'] } });
    const { runtime } = makeRuntime(forge);
    await registerProfile(runtime);
    const created = LaneRun.create({
      version: 1,
      runId: 'run-01JB0000000000000000000000',
      workOrderId: 'wo-bound-1',
      tier: 2,
      seatPlanRef: 'a'.repeat(64),
      cursors: { 'first-pass': 0, fix: null, review: null },
      round: 0,
      attemptIds: ['attempt-example-1'],
      prNumber: 42,
      parked: null,
      parkCount: 0,
      lease: null,
      revision: 1,
      runPolicyRevision: 'policy-example-1',
    });
    expect(created.success).toBe(true);
    if (!created.success) {
      throw new Error('fixture must be a valid LaneRun record');
    }
    expect(await runtime.conductor.laneRunRepository.create(created.value.toRecord())).toMatchObject({
      outcome: 'saved',
    });
    const bound = await register(runtime, 'wo-bound-1', 'packages/example-bound', ['--now-iso', T0]);
    expect(bound.code).toBe(0);
    expect(JSON.parse(bound.out)).toMatchObject({ outcome: 'registered' });
    expect(forge.calls.some((args) => args[0] === 'pr')).toBe(false);
    const other = await register(runtime, 'wo-bound-2', 'packages/example-bound/src', ['--now-iso', T0]);
    expect(other.code).toBe(1);
    expect(JSON.parse(other.out)).toMatchObject({ reason: 'active-work-order-overlap', blockerId: 'wo-bound-1' });
  });

  it('refuses overlap-unknown and neither admits nor holds when forge file read is unknown', async () => {
    const forge = newForge({ openPullRequests: [42], failFiles: true });
    const { runtime } = makeRuntime(forge);
    await registerProfile(runtime);
    const refused = await register(runtime, 'wo-unknown-1', 'packages/example-unknown', ['--now-iso', T0]);
    expect(refused.code).toBe(1);
    expect(JSON.parse(refused.out)).toEqual({ outcome: 'refused', reason: 'overlap-unknown' });
    expect(refused.out + refused.err).not.toContain('boom');
    expect((await cli(runtime, ['work-order', 'inspect', '--work-order-id', 'wo-unknown-1'])).out).toContain('not-found');
    const listed = await cli(runtime, ['work-order', 'held', '--now-iso', T1]);
    expect(JSON.parse(listed.out)).toEqual({ outcome: 'listed', held: [] });
  });

  it('screens secret-shaped inputs and never echoes them in the output', async () => {
    const secret = ['ghp', '_', 'x'.repeat(36)].join('');
    const { runtime } = makeRuntime(newForge());
    await registerProfile(runtime);
    const refused = await register(runtime, 'wo-secret-1', `packages/${secret}`, ['--now-iso', T0]);
    expect(refused.code).toBe(1);
    expect(JSON.parse(refused.out)).toEqual({ outcome: 'refused', reason: 'invalid-request' });
    expect(refused.out + refused.err).not.toContain(secret);
  });

  it('exits 2 on a bare --brief-request-ref, --intent-id, --project-id or --now-iso', async () => {
    const { runtime } = makeRuntime(newForge());
    await registerProfile(runtime);
    expect((await register(runtime, 'wo-usage-1', 'packages/example-usage', ['--brief-request-ref'])).code).toBe(2);
    expect((await register(runtime, 'wo-usage-1', 'packages/example-usage', ['--intent-id', '  '])).code).toBe(2);
    const bareProject = await cli(runtime, ['work-order', 'held', '--project-id']);
    expect(bareProject.code).toBe(2);
    expect(bareProject.err).toContain('work-order held --project-id needs a project id');
    const bareNow = await cli(runtime, ['work-order', 'held', '--now-iso']);
    expect(bareNow.code).toBe(2);
    expect(bareNow.err).toContain('work-order held --now-iso needs an ISO timestamp');
  });
});
