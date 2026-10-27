// AM2: `work-order register --risk` — flag, default, usage error, JSON payload.
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

function registerJsonArg(overrides: Record<string, string> = {}): string[] {
  return [
    'work-order',
    'register',
    '--json',
    JSON.stringify({
      workOrderId: 'wo-risk-example-1',
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

describe('work-order register --risk (AM2)', () => {
  it('registers --risk standard and reports it through inspect', async () => {
    const stateDir = mkdtempSync(path.join(tmpdir(), 'fleet-cli-risk-'));
    tempStateDirs.push(stateDir);
    const runtime = createFleetCliRuntime({ stateDir });
    await registerProfile(runtime);

    const registered = await cli(runtime, [
      'work-order',
      'register',
      '--work-order-id',
      'wo-risk-example-1',
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
      '--risk',
      'standard',
    ]);
    expect(registered.code).toBe(0);
    expect(JSON.parse(registered.out).workOrder.risk).toBe('standard');

    const inspected = await cli(runtime, [
      'work-order',
      'inspect',
      '--work-order-id',
      'wo-risk-example-1',
    ]);
    expect(inspected.code).toBe(0);
    const inspection = JSON.parse(inspected.out);
    expect(inspection.outcome).toBe('found');
    expect(inspection.workOrder.risk).toBe('standard');
  });

  it('registers high when --risk is absent', async () => {
    const stateDir = mkdtempSync(path.join(tmpdir(), 'fleet-cli-risk-'));
    tempStateDirs.push(stateDir);
    const runtime = createFleetCliRuntime({ stateDir });
    await registerProfile(runtime);

    const registered = await cli(runtime, [
      'work-order',
      'register',
      '--work-order-id',
      'wo-risk-example-2',
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
    expect(JSON.parse(registered.out).workOrder.risk).toBe('high');
  });

  it('refuses --risk low as a usage error without registering', async () => {
    const stateDir = mkdtempSync(path.join(tmpdir(), 'fleet-cli-risk-'));
    tempStateDirs.push(stateDir);
    const runtime = createFleetCliRuntime({ stateDir });
    await registerProfile(runtime);

    const registered = await cli(runtime, [
      'work-order',
      'register',
      '--work-order-id',
      'wo-risk-example-3',
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
      '--risk',
      'low',
    ]);
    expect(registered.code).toBe(2);
    expect(registered.err).toContain(
      'work-order register --risk must be one of: standard, high',
    );

    const inspected = await cli(runtime, [
      'work-order',
      'inspect',
      '--work-order-id',
      'wo-risk-example-3',
    ]);
    expect(JSON.parse(inspected.out).outcome).toBe('not-found');
  });

  it('accepts a JSON risk payload and refuses an unknown one', async () => {
    const stateDir = mkdtempSync(path.join(tmpdir(), 'fleet-cli-risk-'));
    tempStateDirs.push(stateDir);
    const runtime = createFleetCliRuntime({ stateDir });
    await registerProfile(runtime);

    const standard = await cli(runtime, [
      ...registerJsonArg({
        workOrderId: 'wo-risk-example-4',
        laneId: 'lane-4',
        ownedPaths: 'packages/example-four/**',
        risk: 'standard',
      }),
    ]);
    expect(standard.code).toBe(0);
    expect(JSON.parse(standard.out).workOrder.risk).toBe('standard');

    const medium = await cli(runtime, [
      ...registerJsonArg({
        workOrderId: 'wo-risk-example-5',
        laneId: 'lane-5',
        ownedPaths: 'packages/example-five/**',
        risk: 'medium',
      }),
    ]);
    expect(medium.code).toBe(2);
  });
});