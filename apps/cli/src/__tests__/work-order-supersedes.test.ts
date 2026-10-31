// WO-1: `work-order register --supersedes-work-order-id` — lineage flag, usage errors, inspect.
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
    'https://example.com/example.git',
    '--base-commit',
    'abc123',
    '--owned-paths',
    'packages/example',
    '--policy-revision',
    'pol-1',
    ...extra,
  ]);
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
}

describe('work-order register --supersedes-work-order-id (WO-1)', () => {
  it('registers a successor and shows supersedesWorkOrderId through inspect', async () => {
    const stateDir = mkdtempSync(path.join(tmpdir(), 'fleet-cli-supersedes-'));
    tempStateDirs.push(stateDir);
    const runtime = createFleetCliRuntime({ stateDir });
    await registerProfile(runtime);
    await registerWorkOrder(runtime, 'wo-sup-cli-a');
    await closeWorkOrder(runtime, 'wo-sup-cli-a');

    const registered = await registerWorkOrder(runtime, 'wo-sup-cli-b', [
      '--supersedes-work-order-id',
      'wo-sup-cli-a',
    ]);
    expect(registered.code).toBe(0);
    expect(JSON.parse(registered.out).workOrder.supersedesWorkOrderId).toBe('wo-sup-cli-a');

    const inspected = await cli(runtime, [
      'work-order',
      'inspect',
      '--work-order-id',
      'wo-sup-cli-b',
    ]);
    expect(inspected.code).toBe(0);
    const inspection = JSON.parse(inspected.out);
    expect(inspection.outcome).toBe('found');
    expect(inspection.workOrder.supersedesWorkOrderId).toBe('wo-sup-cli-a');
  });

  it('treats a bare flag and an empty value as usage errors', async () => {
    const stateDir = mkdtempSync(path.join(tmpdir(), 'fleet-cli-supersedes-'));
    tempStateDirs.push(stateDir);
    const runtime = createFleetCliRuntime({ stateDir });
    await registerProfile(runtime);

    const bare = await registerWorkOrder(runtime, 'wo-sup-cli-bare', [
      '--supersedes-work-order-id',
      '--policy-revision',
      'pol-1',
    ]);
    expect(bare.code).toBe(2);
    expect(bare.err).toContain('--supersedes-work-order-id needs a work order id');

    const empty = await registerWorkOrder(runtime, 'wo-sup-cli-empty', [
      '--supersedes-work-order-id',
      '',
    ]);
    expect(empty.code).toBe(2);
    expect(empty.err).toContain('--supersedes-work-order-id needs a work order id');

    const inspected = await cli(runtime, [
      'work-order',
      'inspect',
      '--work-order-id',
      'wo-sup-cli-bare',
    ]);
    expect(JSON.parse(inspected.out).outcome).toBe('not-found');
  });

  it('exits 1 when the superseded work order is not terminal', async () => {
    const stateDir = mkdtempSync(path.join(tmpdir(), 'fleet-cli-supersedes-'));
    tempStateDirs.push(stateDir);
    const runtime = createFleetCliRuntime({ stateDir });
    await registerProfile(runtime);
    await registerWorkOrder(runtime, 'wo-sup-cli-active');

    const registered = await registerWorkOrder(runtime, 'wo-sup-cli-child', [
      '--owned-paths',
      'packages/example-child',
      '--supersedes-work-order-id',
      'wo-sup-cli-active',
    ]);
    expect(registered.code).toBe(1);
    expect(registered.out).toContain(
      'Superseded work order is not terminal: wo-sup-cli-active (approved)',
    );

    const inspected = await cli(runtime, [
      'work-order',
      'inspect',
      '--work-order-id',
      'wo-sup-cli-child',
    ]);
    expect(JSON.parse(inspected.out).outcome).toBe('not-found');
  });
});
