/**
 * CO29a-ro: the architecture guard behind `relaunch inventory` and
 * `relaunch plan`. Every state adapter `composeReadOnlyRelaunch` constructs is
 * built read-only, except the relaunch plan store, which only `planRelaunch`
 * holds. The adapter constructors are wrapped (not replaced), so the real
 * adapters are built and only their options are recorded.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

interface BuiltAdapter {
  readonly name: string;
  readonly options: { readonly stateDir?: string; readonly readOnly?: boolean } | undefined;
}

const built = vi.hoisted(() => [] as unknown[]);

vi.mock('@fleet/work-execution', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();
  const wrapped: Record<string, unknown> = { ...original };
  for (const [name, value] of Object.entries(original)) {
    if (typeof value !== 'function' || !/(Adapter)$/.test(name)) continue;
    const Original = value as new (options?: unknown) => object;
    wrapped[name] = class extends Original {
      constructor(options?: unknown) {
        super(options);
        built.push({ name, options });
      }
    };
  }
  return wrapped;
});

import { sha256HexDigest } from '@fleet/work-execution';

import { composeReadOnlyRelaunch } from '../composition/relaunch.js';

const roots: string[] = [];

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function adapters(): BuiltAdapter[] {
  return built as BuiltAdapter[];
}

const unusedWorkspace = { listWorktrees: async () => ({ outcome: 'unknown' as const, reason: 'unused' }) };
const unusedRunnerForAttempt = { runnerForAttempt: () => ({ ok: false as const, reason: 'unused' }) };

describe('composeReadOnlyRelaunch (architecture)', () => {
  beforeEach(() => {
    built.length = 0;
  });

  it('builds every state adapter read-only except the relaunch plan store', () => {
    const stateDir = mkdtempSync(path.join(tmpdir(), 'fleet-v2-relaunch-ro-'));
    roots.push(stateDir);

    const composed = composeReadOnlyRelaunch({
      stateDir,
      workspace: unusedWorkspace,
      runnerForAttempt: unusedRunnerForAttempt,
      computeDigest: sha256HexDigest,
    });

    expect(composed.inventoryRelaunch).toBeDefined();
    expect(composed.planRelaunch).toBeDefined();

    const names = adapters().map((adapter) => adapter.name).sort();
    expect(names).toEqual(
      [
        'AttemptRepositoryAdapter',
        'ConductorDriverLeaseAdapter',
        'ConductorHaltAdapter',
        'LanePlanRepositoryAdapter',
        'LaneRunRepositoryAdapter',
        'RelaunchPlanRepositoryAdapter',
        'WorkOrderRepositoryAdapter',
      ].sort(),
    );

    for (const adapter of adapters()) {
      expect(adapter.options?.stateDir, adapter.name).toBe(stateDir);
      if (adapter.name === 'RelaunchPlanRepositoryAdapter') {
        expect(adapter.options?.readOnly, adapter.name).not.toBe(true);
      } else {
        expect(adapter.options?.readOnly, adapter.name).toBe(true);
      }
    }
  });

  it('also builds read-only without a state directory (in-memory, disposable)', () => {
    composeReadOnlyRelaunch({
      workspace: unusedWorkspace,
      runnerForAttempt: unusedRunnerForAttempt,
      computeDigest: sha256HexDigest,
    });
    for (const adapter of adapters()) {
      if (adapter.name === 'RelaunchPlanRepositoryAdapter') continue;
      expect(adapter.options?.readOnly, adapter.name).toBe(true);
    }
  });
});
