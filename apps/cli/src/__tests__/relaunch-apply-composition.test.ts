/**
 * AR3c1 — the composition test for relaunch live apply: `ApplyRelaunchUseCase`
 * is wired in `createFleetCliRuntime` with all twelve ports, so a live
 * `apply: true` request over a stored plan passes `hasLivePorts` and the whole
 * preflight and reaches `ActionAuthorizationAdapter.authorizeRelaunchApply` —
 * the outcome is the adapter's grant refusal (grant-missing here), never
 * `stale-plan-state`. Fakes sit only at the I/O edge: a real durable state
 * directory, a real plan record saved through the real
 * `RelaunchPlanRepositoryAdapter`, and no subprocess is ever spawned.
 *
 * The second case proves the missing-port guard directly: an
 * `ApplyRelaunchUseCase` composed without a live port refuses
 * `stale-plan-state` before the grant is consulted.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { afterAll, describe, expect, it, vi } from 'vitest';

import {
  ApplyRelaunchUseCase,
  canonicalRelaunchPlanBodyJson,
  sha256HexDigest,
  type RelaunchPlanRecord,
} from '@fleet/work-execution';

import { createFleetCliRuntime, type FleetCliRuntime } from '../composition.js';

const roots: string[] = [];

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/**
 * A valid stored plan: one conducted lane holding a run and no plan steps, so
 * the live preflight has no save, adopt or redispatch work to reconcile and
 * its only remaining gate is the grant. The body is digested over its own
 * canonical form, exactly as `planRelaunch` stores it.
 */
const storedPlan = (): RelaunchPlanRecord => {
  const lane = {
    laneId: 'lane-1',
    hostName: 'host-a',
    projectId: null,
    population: 'conducted' as const,
    runnerState: 'running' as const,
    runId: 'run-1',
    attemptId: null,
    workOrderId: null,
    baseBranch: 'main',
    chainHead: true,
    dependsOnLaneIds: [],
    admissionWave: 0,
    dispatchEndpointKey: null,
    staggerOffsetMs: null,
    steps: [],
  };
  const body = {
    schemaVersion: 1 as const,
    hostFilter: null,
    maxActiveRuns: 3,
    dispatchStaggerMs: 250,
    conductor: { halted: true, driverLease: 'lapsed' as const, runCount: 2 },
    lanes: [{ ...lane, steps: [] as { step: string; idempotencyKey: string }[] }],
  };
  const planDigest = sha256HexDigest(
    canonicalRelaunchPlanBodyJson(body as unknown as Parameters<typeof canonicalRelaunchPlanBodyJson>[0]),
  );
  return {
    ...body,
    planDigest,
    requestDigest: 'a'.repeat(64),
    createdAtIso: '2026-11-23T09:00:00Z',
    lanes: [{ ...lane, steps: [] }],
  } as unknown as RelaunchPlanRecord;
};

const makeRuntime = (): FleetCliRuntime => {
  const stateDir = mkdtempSync(path.join(tmpdir(), 'fleet-cli-relaunch-apply-'));
  roots.push(stateDir);
  const runtime = createFleetCliRuntime({
    stateDir,
    daemonNow: () => '2026-11-23T10:00:00Z',
    runSubprocess: () => {
      throw new Error('no subprocess may run in this composition test');
    },
  });
  return runtime;
};

describe('relaunch apply composition (AR3c1)', () => {
  it('wires applyRelaunch with all twelve ports so a live apply reaches authorization rather than stale-plan-state', async () => {
    const runtime = makeRuntime();
    // The composed ports the use case is wired with are all present on the
    // runtime: the twelve-port wiring is observable here.
    expect(runtime.execution.applyRelaunch).toBeInstanceOf(ApplyRelaunchUseCase);
    expect(typeof runtime.execution.processTreeTermination?.terminateWorktreeProcesses).toBe('function');
    expect(typeof runtime.execution.runner?.inspectWorktreeRun).toBe('function');
    expect(typeof runtime.execution.runner?.abortWorktreeRun).toBe('function');
    expect(typeof runtime.execution.cutoverJournal.append).toBe('function');
    expect(typeof runtime.conductor.laneRunRepository.get).toBe('function');
    expect(typeof runtime.conductor.laneRunRepository.list).toBe('function');
    expect(typeof runtime.conductor.laneRunJournal.listForRun).toBe('function');
    expect(typeof runtime.execution.actionAuthorization.authorizeRelaunchApply).toBe('function');

    const plan = storedPlan();
    const saved = await runtime.execution.relaunchPlanRepository.save(plan);
    expect(saved).toMatchObject({ outcome: 'saved' });

    // Spying on the composed adapter instance: the use case holds the same
    // object, so the spy records the live call.
    const authorize = vi.spyOn(runtime.execution.actionAuthorization, 'authorizeRelaunchApply');

    const result = (await runtime.execution.applyRelaunch.applyRelaunch({
      planDigest: plan.planDigest,
      nowIso: '2026-11-23T10:00:00Z',
      apply: true,
      grantId: 'grant-1',
      saveInputs: [],
      adoptInputs: [],
    })) as { outcome: string; reason?: string };

    // Preflight passed and the grant was consulted; the composed adapter (no
    // owner grant configured) answers grant-missing — never stale-plan-state.
    expect(authorize).toHaveBeenCalledTimes(1);
    expect(result.outcome).toBe('refused');
    expect(result.reason).not.toBe('stale-plan-state');
    expect(['grant-missing', 'grant-not-approved', 'authorization-unavailable']).toContain(result.reason);
  });

  it('refuses stale-plan-state before the grant when a live port is missing (direct ApplyRelaunchUseCase check)', async () => {
    const plan = storedPlan();
    const authorizeRelaunchApply = vi.fn(
      async () => ({ outcome: 'authorized', grantId: 'grant-1' }) as unknown,
    );
    const deps = {
      planRepo: { findByDigest: async () => ({ outcome: 'found', plan }) },
      cutoverJournal: {
        listByKeyPrefix: async () => ({ outcome: 'listed', entries: [] }),
        append: async () => ({ outcome: 'appended', entry: {} }),
      },
      computeDigest: sha256HexDigest,
      authorization: { authorizeRelaunchApply },
      clock: () => '2026-11-23T10:00:00Z',
      // runner, processTreeTermination, saveLaneEdits, adoptLane, runRepo,
      // runJournal and mintEntryId are all missing: hasLivePorts must refuse.
    };
    const useCase = new ApplyRelaunchUseCase(deps as unknown as ConstructorParameters<typeof ApplyRelaunchUseCase>[0]);
    expect(
      await useCase.applyRelaunch({
        planDigest: plan.planDigest,
        nowIso: '2026-11-23T10:00:00Z',
        apply: true,
        grantId: 'grant-1',
      }),
    ).toEqual({ outcome: 'refused', reason: 'stale-plan-state' });
    expect(authorizeRelaunchApply).not.toHaveBeenCalled();
  });
});
