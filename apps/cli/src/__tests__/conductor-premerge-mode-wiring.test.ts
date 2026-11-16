import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { FleetInstallation } from '@fleet/installation';

const advanceDeps = vi.hoisted(() => [] as unknown[]);

vi.mock('@fleet/work-execution', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();
  const Original = original.AdvanceLaneRunUseCase as new (deps: unknown) => object;
  return {
    ...original,
    AdvanceLaneRunUseCase: class extends Original {
      constructor(deps: unknown) {
        super(deps);
        advanceDeps.push(deps);
      }
    },
  };
});

import { createFleetCliRuntime } from '../composition.js';
import { buildLiveConductorDriver } from '../conductor-wiring.js';

const HOSTS = {
  local: {
    transport: 'local' as const,
    worktreeRoot: '/tmp/fleet-pc4-worktrees',
    roles: ['orchestrator', 'lane-runner'] as ('orchestrator' | 'lane-runner')[],
    runner: {
      kind: 'opencode' as const,
      port: 46000,
      capabilities: {
        networkEgressRestricted: true,
        cpuAndMemoryLimited: true,
        processTreeTermination: true,
        filesystemScope: 'scoped-worktree' as const,
      },
      maxLanes: 2,
    },
  },
};

beforeEach(() => {
  advanceDeps.length = 0;
});

function liveAdvanceDeps(policy?: unknown): {
  deps: { premergeMode?: unknown };
  driver: ReturnType<typeof buildLiveConductorDriver>;
} {
  const installation = {
    schemaVersion: 2,
    hosts: HOSTS,
    forge: { mode: 'none' },
    ...(policy === undefined ? {} : { policy }),
  } as unknown as FleetInstallation;
  const runtime = createFleetCliRuntime({
    installation,
    loadInstallationForAutoMerge: () => ({ status: 'invalid' as const, file: 'fleet.example.yaml', errors: [] }),
  });
  const driver = buildLiveConductorDriver(runtime, { maxActiveRuns: 1 });
  expect(advanceDeps).toHaveLength(1);
  return { deps: advanceDeps[0] as { premergeMode?: unknown }, driver };
}

describe('live conductor premergeMode wiring (CO21)', () => {
  it('the live driver hands auto-attest to the advance use case when the installation sets it', () => {
    const { deps, driver } = liveAdvanceDeps({
      conductor: { enabled: true, premergeMode: 'auto-attest' },
    });
    expect(deps.premergeMode).toBe('auto-attest');
    expect(driver.policy.premergeMode).toBe('auto-attest');
  });

  it.each([[undefined], [{ conductor: { enabled: true } }], [{ conductor: { enabled: true, premergeMode: 'human-gate' } }]])(
    'the live driver hands human-gate when the installation does not set auto-attest (case %#)',
    (policy) => {
      const { deps } = liveAdvanceDeps(policy);
      expect(deps.premergeMode).toBe('human-gate');
    },
  );
});
