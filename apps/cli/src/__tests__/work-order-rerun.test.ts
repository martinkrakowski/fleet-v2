// WO-2: `work-order rerun` — registering a successor for a stopped work order.
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

async function registerWorkOrder(
  runtime: ReturnType<typeof createFleetCliRuntime>,
  workOrderId: string,
  ownedPaths: string,
  options: { risk?: string; prerequisiteWorkOrderIds?: string } = {},
): Promise<void> {
  const result = await cli(runtime, [
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
    'https://example.com/example.git',
    '--base-commit',
    'abc123',
    '--owned-paths',
    ownedPaths,
    '--policy-revision',
    'pol-1',
    ...(options.risk === undefined ? [] : ['--risk', options.risk]),
    ...(options.prerequisiteWorkOrderIds === undefined
      ? []
      : ['--prerequisite-work-order-ids', options.prerequisiteWorkOrderIds]),
  ]);
  expect(result.code).toBe(0);
}

async function closeWorkOrder(
  runtime: ReturnType<typeof createFleetCliRuntime>,
  workOrderId: string,
): Promise<void> {
  const result = await cli(runtime, [
    'work-order',
    'close',
    '--work-order-id',
    workOrderId,
    '--state',
    'stopped',
    '--yes',
  ]);
  expect(result.code).toBe(0);
  expect(JSON.parse(result.out).state).toBe('stopped');
}

async function inspectWorkOrder(
  runtime: ReturnType<typeof createFleetCliRuntime>,
  workOrderId: string,
): Promise<{ code: number; body: Record<string, unknown> }> {
  const result = await cli(runtime, ['work-order', 'inspect', '--work-order-id', workOrderId]);
  return { code: result.code, body: result.code === 0 ? JSON.parse(result.out) : {} };
}

describe('work-order rerun (WO-2)', () => {
  it('exits 2 without --yes and registers nothing', async () => {
    const stateDir = mkdtempSync(path.join(tmpdir(), 'fleet-cli-rerun-'));
    tempStateDirs.push(stateDir);
    const runtime = createFleetCliRuntime({ stateDir });
    await registerProfile(runtime);
    await registerWorkOrder(runtime, 'wo-rerun-src', 'packages/example');
    await closeWorkOrder(runtime, 'wo-rerun-src');

    const rerun = await cli(runtime, [
      'work-order',
      'rerun',
      '--from',
      'wo-rerun-src',
      '--work-order-id',
      'wo-rerun-new',
    ]);
    expect(rerun.code).toBe(2);
    expect(rerun.err).toContain(
      "work-order rerun needs --yes: it registers wo-rerun-new as a new work order copying wo-rerun-src's project, task, lane, repository, owned paths, policy revision, risk and base branch, superseding wo-rerun-src; it starts no run, changes nothing on wo-rerun-src, and the brief is frozen again by conductor start.",
    );

    const inspected = await inspectWorkOrder(runtime, 'wo-rerun-new');
    expect(inspected.code).toBe(1);
  });

  it('refuses a source that is not stopped (approved) and registers nothing', async () => {
    const stateDir = mkdtempSync(path.join(tmpdir(), 'fleet-cli-rerun-'));
    tempStateDirs.push(stateDir);
    const runtime = createFleetCliRuntime({ stateDir });
    await registerProfile(runtime);
    await registerWorkOrder(runtime, 'wo-rerun-approved', 'packages/example');

    const rerun = await cli(runtime, [
      'work-order',
      'rerun',
      '--from',
      'wo-rerun-approved',
      '--work-order-id',
      'wo-rerun-new',
      '--yes',
    ]);
    expect(rerun.code).toBe(1);
    const body = JSON.parse(rerun.out);
    expect(body.outcome).toBe('refused');
    expect(body.reason).toBe('source-not-stopped');
    expect(body.state).toBe('approved');

    const inspected = await inspectWorkOrder(runtime, 'wo-rerun-new');
    expect(inspected.code).toBe(1);
  });

  it('copies the source fields onto the successor and marks it as superseding', async () => {
    const stateDir = mkdtempSync(path.join(tmpdir(), 'fleet-cli-rerun-'));
    tempStateDirs.push(stateDir);
    const runtime = createFleetCliRuntime({ stateDir });
    await registerProfile(runtime);
    await registerWorkOrder(runtime, 'wo-rerun-prereq', 'packages/other');
    // The default risk is `high`, so only a non-default value on the source can catch a dropped
    // risk on the re-run. A source stored without a risk cannot be built through the CLI, which
    // is why the stored record here carries `--risk standard` explicitly.
    await registerWorkOrder(runtime, 'wo-rerun-a', 'packages/example', {
      risk: 'standard',
      prerequisiteWorkOrderIds: 'wo-rerun-prereq',
    });
    await closeWorkOrder(runtime, 'wo-rerun-a');

    const rerun = await cli(runtime, [
      'work-order',
      'rerun',
      '--from',
      'wo-rerun-a',
      '--work-order-id',
      'wo-rerun-b',
      '--yes',
    ]);
    expect(rerun.code).toBe(0);
    expect(JSON.parse(rerun.out).outcome).toBe('registered');

    const inspected = await inspectWorkOrder(runtime, 'wo-rerun-b');
    expect(inspected.code).toBe(0);
    const successor = inspected.body.workOrder as Record<string, unknown>;
    expect(successor.projectId).toBe('example-project');
    expect(successor.taskId).toBe('task-1');
    expect(successor.laneId).toBe('lane-1');
    expect(successor.repository).toBe('https://example.com/example.git');
    expect(successor.ownedPaths).toEqual(['packages/example']);
    expect(successor.policyRevision).toBe('pol-1');
    expect(successor.risk).toBe('standard');
    expect(successor.prerequisiteWorkOrderIds).toEqual([]);
    expect(successor.supersedesWorkOrderId).toBe('wo-rerun-a');
    expect(successor.state).toBe('approved');
    expect(successor.baseCommit).toBe('abc123');

    // A second re-run of the same source is refused by WO-1's one-successor rule.
    const second = await cli(runtime, [
      'work-order',
      'rerun',
      '--from',
      'wo-rerun-a',
      '--work-order-id',
      'wo-rerun-c',
      '--yes',
    ]);
    expect(second.code).toBe(1);
    expect(JSON.parse(second.out).reason).toContain('already superseded by wo-rerun-b');
  });

  it('uses an explicit --base-commit only when it is a full 40-hex sha', async () => {
    const stateDir = mkdtempSync(path.join(tmpdir(), 'fleet-cli-rerun-'));
    tempStateDirs.push(stateDir);
    const runtime = createFleetCliRuntime({ stateDir });
    await registerProfile(runtime);
    await registerWorkOrder(runtime, 'wo-rerun-src2', 'packages/example');
    await closeWorkOrder(runtime, 'wo-rerun-src2');

    const short = await cli(runtime, [
      'work-order',
      'rerun',
      '--from',
      'wo-rerun-src2',
      '--work-order-id',
      'wo-rerun-b2',
      '--base-commit',
      'abc1234',
      '--yes',
    ]);
    expect(short.code).toBe(2);
    expect(short.err).toContain('--base-commit needs a full commit sha');

    const refName = await cli(runtime, [
      'work-order',
      'rerun',
      '--from',
      'wo-rerun-src2',
      '--work-order-id',
      'wo-rerun-b2',
      '--base-commit',
      'main',
      '--yes',
    ]);
    expect(refName.code).toBe(2);
    expect(refName.err).toContain('--base-commit needs a full commit sha');

    const full = await cli(runtime, [
      'work-order',
      'rerun',
      '--from',
      'wo-rerun-src2',
      '--work-order-id',
      'wo-rerun-b2',
      '--base-commit',
      'a'.repeat(40),
      '--yes',
    ]);
    expect(full.code).toBe(0);
    const inspected = await inspectWorkOrder(runtime, 'wo-rerun-b2');
    expect(inspected.code).toBe(0);
    expect((inspected.body.workOrder as Record<string, unknown>).baseCommit).toBe('a'.repeat(40));
  });

  it('treats a bare --from as a usage error, not the id "true"', async () => {
    const stateDir = mkdtempSync(path.join(tmpdir(), 'fleet-cli-rerun-'));
    tempStateDirs.push(stateDir);
    const runtime = createFleetCliRuntime({ stateDir });
    const rerun = await cli(runtime, [
      'work-order',
      'rerun',
      '--from',
      '--work-order-id',
      'wo-rerun-b3',
      '--yes',
    ]);
    expect(rerun.code).toBe(2);
    expect(rerun.err).toContain('--from needs the stopped work order id');
  });

  it('treats a bare --work-order-id as a usage error, not the id "true"', async () => {
    const stateDir = mkdtempSync(path.join(tmpdir(), 'fleet-cli-rerun-'));
    tempStateDirs.push(stateDir);
    const runtime = createFleetCliRuntime({ stateDir });
    const rerun = await cli(runtime, ['work-order', 'rerun', '--from', 'wo-rerun-x', '--work-order-id', '--yes']);
    expect(rerun.code).toBe(2);
    expect(rerun.err).toContain('--work-order-id needs the new work order id');
  });

  it('answers not-found for an unknown source and registers nothing', async () => {
    const stateDir = mkdtempSync(path.join(tmpdir(), 'fleet-cli-rerun-'));
    tempStateDirs.push(stateDir);
    const runtime = createFleetCliRuntime({ stateDir });
    const rerun = await cli(runtime, [
      'work-order',
      'rerun',
      '--from',
      'no-such',
      '--work-order-id',
      'wo-rerun-b4',
      '--yes',
    ]);
    expect(rerun.code).toBe(1);
    expect(JSON.parse(rerun.out).outcome).toBe('not-found');

    const inspected = await inspectWorkOrder(runtime, 'wo-rerun-b4');
    expect(inspected.code).toBe(1);
  });
});
