// KF-36b-2: `work-order stale` — a read-only listing of stale work orders,
// exit 0, never writes.
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
  ownedPath = 'packages/example',
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
    ownedPath,
    '--policy-revision',
    'pol-1',
  ]);
  expect(result.code).toBe(0);
}

interface StaleEntry {
  readonly workOrderId: string;
  readonly kind: string;
  readonly runs: unknown[];
  readonly suggestedClose: unknown;
}

describe('work-order stale (KF-36b-2)', () => {
  it('lists two registered work orders as no-run, exit 0', async () => {
    const stateDir = mkdtempSync(path.join(tmpdir(), 'fleet-cli-stale-'));
    tempStateDirs.push(stateDir);
    const runtime = createFleetCliRuntime({ stateDir });
    await registerProfile(runtime);
    await registerWorkOrder(runtime, 'wo-stale-a', 'packages/example-a');
    await registerWorkOrder(runtime, 'wo-stale-b', 'packages/example-b');

    const listed = await cli(runtime, ['work-order', 'stale']);
    expect(listed.code).toBe(0);
    const doc = JSON.parse(listed.out) as { outcome: string; entries: StaleEntry[] };
    expect(doc.outcome).toBe('listed');
    expect(doc.entries.map((entry) => entry.workOrderId)).toEqual(['wo-stale-a', 'wo-stale-b']);
    for (const entry of doc.entries) {
      expect(entry.kind).toBe('no-run');
      expect(entry.runs).toEqual([]);
      expect(entry.suggestedClose).toBeNull();
    }
  });

  it('after closing one work order, only the other is listed', async () => {
    const stateDir = mkdtempSync(path.join(tmpdir(), 'fleet-cli-stale-'));
    tempStateDirs.push(stateDir);
    const runtime = createFleetCliRuntime({ stateDir });
    await registerProfile(runtime);
    await registerWorkOrder(runtime, 'wo-stale-a', 'packages/example-a');
    await registerWorkOrder(runtime, 'wo-stale-b', 'packages/example-b');

    const closed = await cli(runtime, [
      'work-order',
      'close',
      '--work-order-id',
      'wo-stale-a',
      '--state',
      'stopped',
      '--yes',
    ]);
    expect(closed.code).toBe(0);
    expect(JSON.parse(closed.out).outcome).toBe('closed');

    const listed = await cli(runtime, ['work-order', 'stale']);
    expect(listed.code).toBe(0);
    const doc = JSON.parse(listed.out) as { entries: { workOrderId: string; kind: string }[] };
    expect(doc.entries.map((entry) => entry.workOrderId)).toEqual(['wo-stale-b']);
    expect(doc.entries[0].kind).toBe('no-run');
  });

  it('--project-id narrows the listing to that project', async () => {
    const stateDir = mkdtempSync(path.join(tmpdir(), 'fleet-cli-stale-'));
    tempStateDirs.push(stateDir);
    const runtime = createFleetCliRuntime({ stateDir });
    await registerProfile(runtime);
    await registerWorkOrder(runtime, 'wo-stale-a', 'packages/example-a');

    const mine = await cli(runtime, ['work-order', 'stale', '--project-id', 'example-project']);
    expect(mine.code).toBe(0);
    expect((JSON.parse(mine.out) as { entries: StaleEntry[] }).entries.map((e) => e.workOrderId)).toEqual(['wo-stale-a']);

    const other = await cli(runtime, ['work-order', 'stale', '--project-id', 'another-project']);
    expect(other.code).toBe(0);
    expect((JSON.parse(other.out) as { entries: StaleEntry[] }).entries).toEqual([]);
  });

  it.each([
    ['a bare --project-id', ['work-order', 'stale', '--project-id']],
    ['an empty --project-id', ['work-order', 'stale', '--project-id', '']],
  ])('treats %s as a usage error, never a fleet-wide listing', async (_label, args) => {
    const stateDir = mkdtempSync(path.join(tmpdir(), 'fleet-cli-stale-'));
    tempStateDirs.push(stateDir);
    const runtime = createFleetCliRuntime({ stateDir });
    const listed = await cli(runtime, args);
    expect(listed.code).toBe(2);
    expect(listed.err).toContain('work-order stale --project-id needs a project id');
  });
});
