// Attention-items CLI tests — AM3b-4.
/**
 * `coordination attention-items` lists stored machine notices with optional
 * filters; `coordination attention-dismiss` clears one at the revision read.
 * Items are seeded through the runtime's record use case: the CLI has no
 * raise command. Nothing here dispatches or touches the network.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createFleetCliRuntime, type FleetCliRuntime } from '../composition.js';
import { runCli } from '../index.js';
import type { CliIo } from '../index.js';

interface CapturedIo extends CliIo {
  readonly outLines: string[];
  readonly errLines: string[];
}

function captureIo(): CapturedIo {
  const outLines: string[] = [];
  const errLines: string[] = [];
  return {
    outLines,
    errLines,
    stdout: (text: string) => {
      outLines.push(text);
    },
    stderr: (text: string) => {
      errLines.push(text);
    },
  };
}

function tempStateDir(): string {
  return mkdtempSync(join(tmpdir(), 'fleet-v2-attention-test-'));
}

/** Run one CLI invocation and return its exit code and parsed stdout JSON. */
async function runCoordination(
  runtime: FleetCliRuntime,
  args: readonly string[],
  stateDir: string,
): Promise<{ code: number; stdout: string[]; stderr: string[] }> {
  const io = captureIo();
  const code = await runCli(
    ['coordination', ...args],
    io,
    runtime,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    { now: () => '2026-10-27T10:00:00.000Z', stateDir },
  );
  return { code, stdout: io.outLines, stderr: io.errLines };
}

function parseDocument(lines: readonly string[]): Record<string, unknown> {
  expect(lines).toHaveLength(1);
  return JSON.parse(lines[0]!) as Record<string, unknown>;
}

async function seedItem(
  runtime: FleetCliRuntime,
  workOrderId: string,
  ref: string,
): Promise<string> {
  const result = await runtime.coordination.recordAttentionItem.recordAttentionItem(
    {
      projectId: 'example-project',
      kind: 'needs-owner',
      subject: { kind: 'work-order', ref },
      workOrderId,
      summary: 'example notice',
    },
    'example-orchestrator',
  );
  if (result.outcome === 'refused') {
    throw new Error(result.reason);
  }
  return result.item.itemId;
}

describe('coordination attention-items and attention-dismiss', () => {
  it('lists seeded items, filters by work order, and returns an empty list for a bad state filter', async () => {
    const stateDir = tempStateDir();
    const runtime = createFleetCliRuntime({ stateDir });
    await seedItem(runtime, 'wo-example-1', 'wo-example-1');
    await seedItem(runtime, 'wo-example-2', 'wo-example-2');

    const all = await runCoordination(runtime, ['attention-items'], stateDir);
    expect(all.code).toBe(0);
    const allDoc = parseDocument(all.stdout);
    const allItems = allDoc.items as Array<Record<string, unknown>>;
    expect(allItems).toHaveLength(2);
    expect(
      allItems.map((entry) => (entry.item as Record<string, unknown>).workOrderId).sort((a, b) =>
        String(a).localeCompare(String(b)),
      ),
    ).toEqual(['wo-example-1', 'wo-example-2']);

    const filtered = await runCoordination(
      runtime,
      ['attention-items', '--workOrderId', 'wo-example-1'],
      stateDir,
    );
    expect(filtered.code).toBe(0);
    const filteredItems = (parseDocument(filtered.stdout).items as Array<Record<string, unknown>>);
    expect(filteredItems).toHaveLength(1);
    expect((filteredItems[0]!.item as Record<string, unknown>).workOrderId).toBe('wo-example-1');

    const badState = await runCoordination(runtime, ['attention-items', '--state', 'XYZZY'], stateDir);
    expect(badState.code).toBe(0);
    expect(parseDocument(badState.stdout).items).toEqual([]);
  });

  it('dismisses one item at the revision read, refuses stale revisions, and reports absence', async () => {
    const stateDir = tempStateDir();
    const runtime = createFleetCliRuntime({ stateDir });
    const itemId = await seedItem(runtime, 'wo-example-1', 'wo-example-1');

    const dismissed = await runCoordination(
      runtime,
      ['attention-dismiss', '--itemId', itemId, '--expectedRevision', '1'],
      stateDir,
    );
    expect(dismissed.code).toBe(0);
    expect(parseDocument(dismissed.stdout).outcome).toBe('cleared');

    const stale = await runCoordination(
      runtime,
      ['attention-dismiss', '--itemId', itemId, '--expectedRevision', '1'],
      stateDir,
    );
    expect(stale.code).toBe(1);
    const staleDoc = parseDocument(stale.stdout);
    expect(staleDoc.outcome).toBe('refused');
    expect(staleDoc.code).toBe('stale-revision');

    const missing = await runCoordination(
      runtime,
      ['attention-dismiss', '--itemId', 'att-missing', '--expectedRevision', '1'],
      stateDir,
    );
    expect(missing.code).toBe(1);
    expect(parseDocument(missing.stdout).outcome).toBe('not-found');

    const noRevision = await runCoordination(
      runtime,
      ['attention-dismiss', '--itemId', 'att-example-1'],
      stateDir,
    );
    expect(noRevision.code).toBe(2);
  });

  it('persists the clearance for a fresh runtime with via cli', async () => {
    const stateDir = tempStateDir();
    const runtime = createFleetCliRuntime({ stateDir });
    const itemId = await seedItem(runtime, 'wo-example-1', 'wo-example-1');

    const dismissed = await runCoordination(
      runtime,
      ['attention-dismiss', '--itemId', itemId, '--expectedRevision', '1'],
      stateDir,
    );
    expect(dismissed.code).toBe(0);

    const fresh = createFleetCliRuntime({ stateDir });
    const listed = await runCoordination(fresh, ['attention-items'], stateDir);
    expect(listed.code).toBe(0);
    const items = parseDocument(listed.stdout).items as Array<Record<string, unknown>>;
    expect(items).toHaveLength(1);
    const item = (items[0]!.item as Record<string, unknown>);
    expect(item.state).toBe('cleared');
    expect((item.clearance as Record<string, unknown>).via).toBe('cli');
  });

  it('state check reports attention-items.json readable on the seeded directory', async () => {
    const stateDir = tempStateDir();
    const runtime = createFleetCliRuntime({ stateDir });
    await seedItem(runtime, 'wo-example-1', 'wo-example-1');

    const io = captureIo();
    const code = await runCli(['--state-dir', stateDir, 'state', 'check'], io, runtime);
    expect(code).toBe(0);
    expect(io.outLines.join('')).toContain('attention-items.json: ok (1 record)\n');
  });

  it('help output contains the attention-items and attention-dismiss commands', async () => {
    const io = captureIo();
    const code = await runCli(['--help'], io);
    expect(code).toBe(0);
    expect(io.outLines.join('')).toContain('attention-items|attention-dismiss');
  });
});
