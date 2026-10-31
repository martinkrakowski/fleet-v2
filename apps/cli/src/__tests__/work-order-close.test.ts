// KF-36b-1b: `work-order close` — the --yes confirmation gate and the close itself.
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
    'packages/example',
    '--policy-revision',
    'pol-1',
  ]);
  expect(result.code).toBe(0);
}

describe('work-order close (KF-36b-1b)', () => {
  it('refuses without --yes and leaves the work order approved', async () => {
    const stateDir = mkdtempSync(path.join(tmpdir(), 'fleet-cli-close-'));
    tempStateDirs.push(stateDir);
    const runtime = createFleetCliRuntime({ stateDir });
    await registerProfile(runtime);
    await registerWorkOrder(runtime, 'wo-close-1');

    const closed = await cli(runtime, [
      'work-order',
      'close',
      '--work-order-id',
      'wo-close-1',
      '--state',
      'stopped',
    ]);
    expect(closed.code).toBe(2);
    expect(closed.err).toContain('work-order close needs --yes');

    const inspected = await cli(runtime, [
      'work-order',
      'inspect',
      '--work-order-id',
      'wo-close-1',
    ]);
    expect(inspected.code).toBe(0);
    expect(JSON.parse(inspected.out).workOrder.state).toBe('approved');
  });

  it('closes with --yes and reports the stopped state', async () => {
    const stateDir = mkdtempSync(path.join(tmpdir(), 'fleet-cli-close-'));
    tempStateDirs.push(stateDir);
    const runtime = createFleetCliRuntime({ stateDir });
    await registerProfile(runtime);
    await registerWorkOrder(runtime, 'wo-close-2');

    const closed = await cli(runtime, [
      'work-order',
      'close',
      '--work-order-id',
      'wo-close-2',
      '--state',
      'stopped',
      '--yes',
    ]);
    expect(closed.code).toBe(0);
    expect(JSON.parse(closed.out).outcome).toBe('closed');
    expect(JSON.parse(closed.out).state).toBe('stopped');

    const inspected = await cli(runtime, [
      'work-order',
      'inspect',
      '--work-order-id',
      'wo-close-2',
    ]);
    expect(inspected.code).toBe(0);
    expect(JSON.parse(inspected.out).workOrder.state).toBe('stopped');
  });
});
