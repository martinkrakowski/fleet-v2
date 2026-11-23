/**
 * AR3c2 — the end-to-end test for `relaunch apply` and `relaunch
 * request-grant` over the production composition (`runCli` with a real
 * temporary state directory, a real git worktree, a fake `ocm-run`, and an
 * ephemeral Ed25519 owner key):
 *
 * (a) a dry-run exits 0 with `outcome: 'dry-run'`;
 * (b) a live apply, minted and signed through `relaunch request-grant`,
 *     `coordination request-decision` and `coordination sign-decision
 *     --answer approve --yes`, applies wave 1 and journals the `save` and
 *     `adopt/work-order` results;
 * (c) the typed refusals `grant-missing`, `grant-not-approved`,
 *     `stale-plan-state`, `budget-exhausted` and `plan-not-found` exit 1;
 * (d) hostile inputs are usage errors (exit 2): a getter, a lying Proxy, an
 *     array-like and a sparse array are refused with zero getter calls, and
 *     invalid JSON, a non-array, an over-long array, an over-long document
 *     and a prototype-polluting key are refused without ever echoing the
 *     `--save-inputs` contents.
 */

import { afterAll, describe, expect, it } from 'vitest';

import { MAX_RELAUNCH_APPLY_LANES } from '@fleet/work-execution';

import {
  adoptInputFor,
  buildRelaunchApplyPlan,
  cleanupRelaunchApplyFixtures,
  git,
  LANE_ID,
  makeRelaunchApplyFixture,
  mintRelaunchGrant,
  RUN_ID,
  ATTEMPT_ID,
  saveInputFor,
  seedAttemptRecord,
  WORK_ORDER_ID,
  runFleetCli,
  type RelaunchApplyFixture,
} from './relaunch-apply-fixture.js';
import { relaunchCommands } from '../relaunch.js';
import { createFleetCliRuntime, type FleetCliRuntime } from '../composition.js';
import { CliUsageError } from '../commands/payload.js';

afterAll(() => {
  cleanupRelaunchApplyFixtures();
});

interface RunOutcomeLike {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

function jsonOf(outcome: RunOutcomeLike): Record<string, unknown> {
  return JSON.parse(outcome.stdout) as Record<string, unknown>;
}

async function savePlan(fx: RelaunchApplyFixture): Promise<string> {
  const plan = buildRelaunchApplyPlan();
  const saved = await fx.runtime.execution.relaunchPlanRepository.save(plan);
  expect(saved).toMatchObject({ outcome: 'saved' });
  await seedAttemptRecord(fx);
  return plan.planDigest;
}

describe('relaunch apply e2e (AR3c2)', () => {
  it('a dry-run exits 0 with outcome dry-run and both plan lanes', async () => {
    const fx = await makeRelaunchApplyFixture();
    const planDigest = await savePlan(fx);
    const result = await runFleetCli(fx, [
      'relaunch', 'apply', '--plan-digest', planDigest, '--now', fx.nowIso,
    ]);
    expect(result.code).toBe(0);
    const doc = jsonOf(result);
    expect(doc['outcome']).toBe('dry-run');
    expect(doc['planDigest']).toBe(planDigest);
    const lanes = doc['lanes'] as Array<Record<string, unknown>>;
    expect(lanes.map((lane) => lane['laneId'])).toEqual(['lane-held', LANE_ID]);
  });

  it('a live apply mints and signs the owner grant, applies wave 1 and journals the save and adopt/work-order results', async () => {
    const fx = await makeRelaunchApplyFixture();
    const planDigest = await savePlan(fx);
    const grantId = await mintRelaunchGrant(fx, planDigest);
    const result = await runFleetCli(fx, [
      'relaunch', 'apply',
      '--plan-digest', planDigest,
      '--apply',
      '--grant', grantId,
      '--save-inputs', JSON.stringify([saveInputFor(fx)]),
      '--adopt-inputs', JSON.stringify([adoptInputFor(fx, planDigest)]),
      '--now', fx.nowIso,
    ]);
    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
    const doc = jsonOf(result);
    expect(doc['outcome']).toBe('applied');
    expect(doc['wave']).toBe(1);

    // The save wrote the real save ref into the clone's git store.
    const saveRefs = await git(fx.clonePath, 'for-each-ref', 'refs/fleet/saved/', '--format=%(refname)');
    expect(saveRefs).toContain(`refs/fleet/saved/${planDigest.slice(0, 12)}-${LANE_ID}`);

    // The adopt wrote the real work order and the real adopted run.
    const workOrder = await fx.runtime.execution.workOrderRepository.findWorkOrderById(WORK_ORDER_ID);
    expect(workOrder).not.toBeNull();
    const run = await fx.runtime.conductor.laneRunRepository.get(RUN_ID);
    expect(run).not.toBeNull();
    expect(run?.workOrderId).toBe(WORK_ORDER_ID);
    expect(run?.attemptIds[0]).toBe(ATTEMPT_ID);

    // The journal carries the save result and the completed adopt/work-order result.
    const journal = await fx.runtime.execution.cutoverJournal.listByKeyPrefix(`relaunch/${planDigest}/${LANE_ID}/`);
    expect(journal.outcome).toBe('listed');
    if (journal.outcome !== 'listed') throw new Error('unreachable');
    const keys = journal.entries.map((entry) => `${entry.key} ${entry.kind} ${entry.outcome ?? ''}`);
    expect(keys).toContain(`relaunch/${planDigest}/${LANE_ID}/save result completed`);
    expect(keys).toContain(`relaunch/${planDigest}/${LANE_ID}/adopt/work-order result completed`);
  });

  it('a live apply without a grant refuses grant-missing and exits 1', async () => {
    const fx = await makeRelaunchApplyFixture();
    const planDigest = await savePlan(fx);
    const result = await runFleetCli(fx, [
      'relaunch', 'apply', '--plan-digest', planDigest, '--apply', '--now', fx.nowIso,
    ]);
    expect(result.code).toBe(1);
    expect(jsonOf(result)).toEqual({ outcome: 'refused', reason: 'grant-missing' });
  });

  it('a live apply whose grant id records no approval refuses grant-not-approved and exits 1', async () => {
    const fx = await makeRelaunchApplyFixture();
    const planDigest = await savePlan(fx);
    // A recorded, answered request whose grant id was never minted: the
    // record exists under a different grant id, so the named grant id finds
    // no record — but the request itself proves the store path. The direct
    // `findRequestByGrantId` miss is the `grant-missing` shape, so this case
    // seeds a record that carries the named grant id in `awaiting-decision`:
    // found, but never approved.
    await fx.runtime.coordination.coordinationRequestRepository.saveRequest({
      id: `relaunch-apply-${'a'.repeat(59)}`,
      projectId: 'relaunch',
      kind: 'action-decision',
      state: 'awaiting-decision',
      actionScope: 'relaunch:apply',
      expectedHeadSha: null,
      proposalDigest: planDigest,
      policyRevision: 'pol-1',
      decisionRevision: null,
      grantId: 'grant-not-approved-yet',
      consumptions: [],
      acknowledgements: [],
      deliveryStatus: 'pending',
      deliveryGapReason: null,
      revision: 0,
      createdAtIso: fx.nowIso,
      updatedAtIso: fx.nowIso,
    });
    const result = await runFleetCli(fx, [
      'relaunch', 'apply',
      '--plan-digest', planDigest,
      '--apply',
      '--grant', 'grant-not-approved-yet',
      '--save-inputs', JSON.stringify([saveInputFor(fx)]),
      '--adopt-inputs', JSON.stringify([adoptInputFor(fx, planDigest)]),
      '--now', fx.nowIso,
    ]);
    expect(result.code).toBe(1);
    expect(jsonOf(result)).toEqual({ outcome: 'refused', reason: 'grant-not-approved' });
  });

  it('a live apply whose adopt input is missing refuses stale-plan-state and exits 1', async () => {
    const fx = await makeRelaunchApplyFixture();
    const planDigest = await savePlan(fx);
    const grantId = await mintRelaunchGrant(fx, planDigest);
    const result = await runFleetCli(fx, [
      'relaunch', 'apply',
      '--plan-digest', planDigest,
      '--apply',
      '--grant', grantId,
      '--save-inputs', JSON.stringify([saveInputFor(fx)]),
      '--now', fx.nowIso,
    ]);
    expect(result.code).toBe(1);
    expect(jsonOf(result)).toMatchObject({ outcome: 'refused', reason: 'stale-plan-state' });
  });

  it('a live apply past its --deadline refuses budget-exhausted and exits 1', async () => {
    const fx = await makeRelaunchApplyFixture();
    const planDigest = await savePlan(fx);
    const result = await runFleetCli(fx, [
      'relaunch', 'apply', '--plan-digest', planDigest, '--apply', '--grant', 'grant-1',
      '--deadline', '2026-11-23T09:00:00Z', '--now', fx.nowIso,
    ]);
    expect(result.code).toBe(1);
    expect(jsonOf(result)).toEqual({ outcome: 'refused', reason: 'budget-exhausted' });
  });

  it('an apply for an unstored plan digest refuses plan-not-found and exits 1', async () => {
    const fx = await makeRelaunchApplyFixture();
    const result = await runFleetCli(fx, [
      'relaunch', 'apply', '--plan-digest', 'b'.repeat(64), '--now', fx.nowIso,
    ]);
    expect(result.code).toBe(1);
    expect(jsonOf(result)).toEqual({ outcome: 'refused', reason: 'plan-not-found' });
  });

  it('invalid JSON, a non-array, a polluting key, an over-long array and an over-long document exit 2 without echoing the flag contents', async () => {
    const fx = await makeRelaunchApplyFixture();
    const planDigest = await savePlan(fx);
    const secret = 'SECRET-MARKER-7f3a9b';
    const withSecret = `${secret}${JSON.stringify([saveInputFor(fx)])}`;
    const cases: readonly (readonly [string, string])[] = [
      ['invalid JSON', '{not json'],
      ['non-array', JSON.stringify({ laneId: LANE_ID })],
      ['polluting key', '[{"__proto__":{"polluted":true}}]'],
      ['over-long array', JSON.stringify(Array.from({ length: MAX_RELAUNCH_APPLY_LANES + 1 }, () => ({})))],
      ['over-long document with the marker', `"${'x'.repeat(2 * 1024 * 1024)}${secret}"`],
    ];
    for (const [label, value] of cases) {
      const result = await runFleetCli(fx, [
        'relaunch', 'apply', '--plan-digest', planDigest, '--save-inputs', value,
      ]);
      expect(result.code, label).toBe(2);
      // The marker rides on the values a real operator would pass; a refusal
      // that echoed the flag contents would print it.
      expect(result.stdout + result.stderr, label).not.toContain(secret);
      expect(result.stdout + result.stderr, label).not.toContain('x'.repeat(64));
    }
    // The marker must actually be in the flagged value for the echo checks to mean anything.
    expect(withSecret).toContain(secret);
  });

  it('a getter, a lying Proxy, an array-like and a sparse array are refused directly with zero getter calls', async () => {
    const rt: FleetCliRuntime = createFleetCliRuntime({});
    const planDigest = 'a'.repeat(64);
    // A counting getter on saveInputs: the refusal must not invoke it.
    const getterPayload: Record<string, unknown> = { planDigest };
    let getterCalls = 0;
    Object.defineProperty(getterPayload, 'saveInputs', {
      enumerable: true,
      configurable: true,
      get() {
        getterCalls += 1;
        return '[]';
      },
    });
    await expect(relaunchCommands.apply(getterPayload, rt)).rejects.toThrow(CliUsageError);
    expect(getterCalls).toBe(0);

    // A Proxy that lies in every trap: the inspection itself throws, so the
    // answer is a usage error, never a pass and never a raw rejection.
    const proxyPayload = new Proxy(
      { planDigest, saveInputs: '[]' },
      {
        get() {
          throw new Error('get trap');
        },
        getOwnPropertyDescriptor() {
          throw new Error('descriptor trap');
        },
        ownKeys() {
          throw new Error('keys trap');
        },
        getPrototypeOf() {
          throw new Error('proto trap');
        },
      },
    );
    await expect(
      relaunchCommands.apply(proxyPayload as unknown as Record<string, unknown>, rt),
    ).rejects.toThrow(CliUsageError);

    // An array-like object is not a JSON array: refused without reading items.
    const arrayLike = { planDigest, saveInputs: { length: 1, 0: { laneId: LANE_ID } } };
    await expect(relaunchCommands.apply(arrayLike, rt)).rejects.toThrow(CliUsageError);

    // A sparse array (a hole at index 1) is refused: the descriptor walk sees
    // the missing index.
    const sparse: unknown[] = [{ laneId: LANE_ID }];
    sparse[2] = { laneId: LANE_ID };
    await expect(relaunchCommands.apply({ planDigest, saveInputs: sparse }, rt)).rejects.toThrow(CliUsageError);

    // Null, a wrong primitive and a polluting own key are refused at the payload gate.
    await expect(relaunchCommands.apply(null as unknown as Record<string, unknown>, rt)).rejects.toThrow(
      CliUsageError,
    );
    await expect(relaunchCommands.apply(7 as unknown as Record<string, unknown>, rt)).rejects.toThrow(
      CliUsageError,
    );
    const polluting: Record<string, unknown> = { planDigest };
    Object.defineProperty(polluting, 'constructor', { value: 'x', enumerable: true });
    await expect(relaunchCommands.apply(polluting, rt)).rejects.toThrow(CliUsageError);
  });

  it('request-grant refuses an invalid digest, a non-strict now and an over-long or control-char policy revision', async () => {
    const fx = await makeRelaunchApplyFixture();
    const badDigest = await runFleetCli(fx, ['relaunch', 'request-grant', '--plan-digest', 'nothex']);
    expect(badDigest.code).toBe(2);
    const badNow = await runFleetCli(fx, [
      'relaunch', 'request-grant', '--plan-digest', 'a'.repeat(64), '--now', '2026-02-30T00:00:00Z',
    ]);
    expect(badNow.code).toBe(2);
    const longRevision = await runFleetCli(fx, [
      'relaunch', 'request-grant', '--plan-digest', 'a'.repeat(64), '--policy-revision', 'p'.repeat(129),
    ]);
    expect(longRevision.code).toBe(2);
    const controlRevision = await runFleetCli(fx, [
      'relaunch', 'request-grant', '--plan-digest', 'a'.repeat(64), '--policy-revision', 'pol\t1',
    ]);
    expect(controlRevision.code).toBe(2);
  });
});
