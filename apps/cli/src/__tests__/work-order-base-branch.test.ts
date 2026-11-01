// CB1: `work-order register --base-branch` — flag, default, bare-flag usage
// error, use-case refusal, JSON payload, rerun copying.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { createFleetCliRuntime } from '../composition.js';
import { runCli, type CliIo } from '../index.js';

const tempStateDirs: string[] = [];

afterAll(() => {
  for (const dir of tempStateDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

async function cli(
  runtime: ReturnType<typeof createFleetCliRuntime>,
  argv: string[],
): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = {
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
  };
  const code = await runCli(argv, io, runtime);
  return { code, out: out.join(''), err: err.join('') };
}

async function registerProfile(
  runtime: ReturnType<typeof createFleetCliRuntime>,
): Promise<void> {
  const result = await cli(runtime, [
    'coordination',
    'register-profile',
    '--json',
    JSON.stringify({
      projectId: 'example-project',
      displayName: 'Example Project',
      repository: 'https://example.com/example.git',
      designatedDispatcherHost: 'host-example',
      policyRevision: 'pol-1',
      maxConcurrentLanes: 2,
      runnerCapabilities: { 'scoped-worktree': true, networkEgressRestricted: true },
    }),
  ]);
  expect(result.code).toBe(0);
}

function registerJsonArg(overrides: Record<string, unknown> = {}): string[] {
  return [
    'work-order',
    'register',
    '--json',
    JSON.stringify({
      workOrderId: 'wo-base-branch-1',
      projectId: 'example-project',
      taskId: 'task-1',
      laneId: 'lane-1',
      repository: 'https://example.com/example.git',
      baseCommit: 'abc123',
      ownedPaths: ['packages/example/**'],
      policyRevision: 'pol-1',
      ...overrides,
    }),
  ];
}

async function inspectOrder(
  runtime: ReturnType<typeof createFleetCliRuntime>,
  workOrderId: string,
): Promise<Record<string, unknown>> {
  const inspected = await cli(runtime, ['work-order', 'inspect', '--work-order-id', workOrderId]);
  return JSON.parse(inspected.out) as Record<string, unknown>;
}

describe('work-order register --base-branch (CB1)', () => {
  it('registers --base-branch chain/example and reports it through inspect', async () => {
    const stateDir = mkdtempSync(path.join(tmpdir(), 'fleet-cli-base-branch-'));
    tempStateDirs.push(stateDir);
    const runtime = createFleetCliRuntime({ stateDir });
    await registerProfile(runtime);

    const registered = await cli(runtime, [
      'work-order',
      'register',
      '--work-order-id',
      'wo-base-branch-1',
      '--project-id',
      'example-project',
      '--task-id',
      'task-1',
      '--lane-id',
      'lane-1',
      '--repository',
      'https://example.com/example.git',
      '--base-commit',
      'abc123',
      '--owned-paths',
      'packages/example',
      '--policy-revision',
      'pol-1',
      '--base-branch',
      'chain/example',
    ]);
    expect(registered.code).toBe(0);
    expect(JSON.parse(registered.out).workOrder.baseBranch).toBe('chain/example');

    const inspection = await inspectOrder(runtime, 'wo-base-branch-1');
    expect(inspection.outcome).toBe('found');
    expect((inspection.workOrder as Record<string, unknown>).baseBranch).toBe('chain/example');
  });

  it('registers main when --base-branch is absent', async () => {
    const stateDir = mkdtempSync(path.join(tmpdir(), 'fleet-cli-base-branch-'));
    tempStateDirs.push(stateDir);
    const runtime = createFleetCliRuntime({ stateDir });
    await registerProfile(runtime);

    const registered = await cli(runtime, [
      'work-order',
      'register',
      '--work-order-id',
      'wo-base-branch-2',
      '--project-id',
      'example-project',
      '--task-id',
      'task-1',
      '--lane-id',
      'lane-2',
      '--repository',
      'https://example.com/example.git',
      '--base-commit',
      'abc123',
      '--owned-paths',
      'packages/example-two',
      '--policy-revision',
      'pol-1',
    ]);
    expect(registered.code).toBe(0);
    expect(JSON.parse(registered.out).workOrder.baseBranch).toBe('main');

    const inspection = await inspectOrder(runtime, 'wo-base-branch-2');
    expect(inspection.outcome).toBe('found');
    expect((inspection.workOrder as Record<string, unknown>).baseBranch).toBe('main');
  });

  it('refuses a bare --base-branch as a usage error without registering', async () => {
    const stateDir = mkdtempSync(path.join(tmpdir(), 'fleet-cli-base-branch-'));
    tempStateDirs.push(stateDir);
    const runtime = createFleetCliRuntime({ stateDir });
    await registerProfile(runtime);

    const registered = await cli(runtime, [
      'work-order',
      'register',
      '--work-order-id',
      'wo-base-branch-3',
      '--project-id',
      'example-project',
      '--task-id',
      'task-1',
      '--lane-id',
      'lane-3',
      '--repository',
      'https://example.com/example.git',
      '--base-commit',
      'abc123',
      '--owned-paths',
      'packages/example-three',
      '--policy-revision',
      'pol-1',
      '--base-branch',
    ]);
    expect(registered.code).toBe(2);
    expect(registered.err).toContain('work-order register --base-branch needs a branch');

    const inspection = await inspectOrder(runtime, 'wo-base-branch-3');
    expect(inspection.outcome).toBe('not-found');
  });

  it('refuses --base-branch release with the reason code and never echoes the value', async () => {
    const stateDir = mkdtempSync(path.join(tmpdir(), 'fleet-cli-base-branch-'));
    tempStateDirs.push(stateDir);
    const runtime = createFleetCliRuntime({ stateDir });
    await registerProfile(runtime);

    const registered = await cli(runtime, [
      'work-order',
      'register',
      '--work-order-id',
      'wo-base-branch-4',
      '--project-id',
      'example-project',
      '--task-id',
      'task-1',
      '--lane-id',
      'lane-4',
      '--repository',
      'https://example.com/example.git',
      '--base-commit',
      'abc123',
      '--owned-paths',
      'packages/example-four',
      '--policy-revision',
      'pol-1',
      '--base-branch',
      'release',
    ]);
    expect(registered.code).toBe(1);
    const payload = JSON.parse(registered.out) as { reason?: string };
    expect(payload.reason).toBe('invalid-base-branch');
    expect(registered.err).not.toContain('release');

    const inspection = await inspectOrder(runtime, 'wo-base-branch-4');
    expect(inspection.outcome).toBe('not-found');
  });

  it('accepts a JSON baseBranch payload', async () => {
    const stateDir = mkdtempSync(path.join(tmpdir(), 'fleet-cli-base-branch-'));
    tempStateDirs.push(stateDir);
    const runtime = createFleetCliRuntime({ stateDir });
    await registerProfile(runtime);

    const registered = await cli(runtime, [
      ...registerJsonArg({
        workOrderId: 'wo-base-branch-5',
        laneId: 'lane-5',
        ownedPaths: 'packages/example-five/**',
        baseBranch: 'chain/other',
      }),
    ]);
    expect(registered.code).toBe(0);
    expect(JSON.parse(registered.out).workOrder.baseBranch).toBe('chain/other');
  });

  it('rerun copies the source base branch onto the successor', async () => {
    const stateDir = mkdtempSync(path.join(tmpdir(), 'fleet-cli-base-branch-'));
    tempStateDirs.push(stateDir);
    const runtime = createFleetCliRuntime({ stateDir });
    await registerProfile(runtime);

    const registered = await cli(runtime, [
      ...registerJsonArg({
        workOrderId: 'wo-base-branch-6',
        laneId: 'lane-6',
        ownedPaths: 'packages/example-six/**',
        baseBranch: 'chain/example',
      }),
    ]);
    expect(registered.code).toBe(0);

    const stopped = await cli(runtime, [
      'work-order',
      'close',
      '--work-order-id',
      'wo-base-branch-6',
      '--state',
      'stopped',
      '--yes',
    ]);
    expect(stopped.code).toBe(0);

    const rerun = await cli(runtime, [
      'work-order',
      'rerun',
      '--from',
      'wo-base-branch-6',
      '--work-order-id',
      'wo-base-branch-7',
      '--yes',
    ]);
    expect(rerun.code).toBe(0);

    const inspection = await inspectOrder(runtime, 'wo-base-branch-7');
    expect(inspection.outcome).toBe('found');
    expect((inspection.workOrder as Record<string, unknown>).baseBranch).toBe('chain/example');
  });
});
