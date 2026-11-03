import { describe, expect, it } from 'vitest';

import type { LanePlanRecord } from '../../../domain/lane-plan-records.js';
import type { LanePlanRepositoryPort } from '../../ports/out/LanePlanRepositoryPort.out-port.js';
import type {
  OpenDecisionItemRequest,
  OpenDecisionItemResult,
  OwnerItemsWritePort,
  ResolvePlanDecisionRequest,
  ResolvePlanDecisionResult,
} from '../../ports/out/OwnerItemsWritePort.out-port.js';
import { SyncPlanDecisionsUseCase } from '../SyncPlanDecisionsUseCase.use-case.js';

function planRecord(overrides: Partial<LanePlanRecord> = {}): LanePlanRecord {
  return {
    version: 1,
    projectId: 'example-project',
    planId: 'plan-1',
    revision: 3,
    digest: 'd'.repeat(64),
    doc: 'docs/plans/plan-1.md',
    lanes: [
      { laneId: 'lane-1', decisions: ['d1', 'd2'] },
      { laneId: 'lane-2', decisions: ['d2'] },
    ],
    decisions: [
      { id: 'd1', question: 'Which database engine?', default: 'postgres', state: 'open' },
      { id: 'd2', question: 'Ship the flag now?', default: 'yes', state: 'open' },
    ],
    exclusiveOrder: [],
    importedAtIso: '2026-10-27T09:00:00.000Z',
    ...overrides,
  } as LanePlanRecord;
}

class FakePlans implements LanePlanRepositoryPort {
  constructor(private readonly record: LanePlanRecord | null, private readonly throws = false) {}

  async saveLanePlan(): Promise<void> {}

  async saveLanePlanIfAcyclic(): Promise<{ outcome: 'saved' }> {
    return { outcome: 'saved' };
  }

  async findLanePlan(): Promise<LanePlanRecord | null> {
    if (this.throws) {
      throw new Error('store unreadable on purpose');
    }
    return this.record;
  }

  async listLanePlans(): Promise<readonly LanePlanRecord[]> {
    return this.record === null ? [] : [this.record];
  }
}

interface OwnerItemCalls {
  opened: OpenDecisionItemRequest[];
  resolved: ResolvePlanDecisionRequest[];
}

class FakeOwnerItems implements OwnerItemsWritePort {
  readonly calls: OwnerItemCalls = { opened: [], resolved: [] };
  openAnswer: OpenDecisionItemResult = { outcome: 'opened' };
  resolveAnswer: ResolvePlanDecisionResult = { outcome: 'resolved' };
  refuseOnlyDecisionId: string | null = null;

  async openDecisionItem(request: OpenDecisionItemRequest): Promise<OpenDecisionItemResult> {
    this.calls.opened.push(request);
    if (request.decisionId === this.refuseOnlyDecisionId) {
      return { outcome: 'refused', code: 'refused', reason: 'subject refused' };
    }
    return this.openAnswer;
  }

  async resolvePlanDecision(request: ResolvePlanDecisionRequest): Promise<ResolvePlanDecisionResult> {
    this.calls.resolved.push(request);
    return this.resolveAnswer;
  }
}

function make(record: LanePlanRecord | null, throws = false): {
  plans: LanePlanRepositoryPort;
  ownerItems: FakeOwnerItems;
  useCase: SyncPlanDecisionsUseCase;
} {
  const ownerItems = new FakeOwnerItems();
  const useCase = new SyncPlanDecisionsUseCase({
    plans: new FakePlans(record, throws),
    ownerItems,
    nowIso: () => '2026-10-27T10:00:00.000Z',
  });
  return { plans: new FakePlans(record, throws), ownerItems, useCase };
}

describe('SyncPlanDecisionsUseCase', () => {
  it('opens one item per open decision with the plan-decision ref and one lane block per gating lane', async () => {
    const { useCase, ownerItems } = make(planRecord());
    const result = await useCase.execute({ projectId: 'example-project', planId: 'plan-1', previousDecisionIds: null });
    expect(result).toEqual({ outcome: 'synced', decisions: [
      { decisionId: 'd1', outcome: 'opened' },
      { decisionId: 'd2', outcome: 'opened' },
    ] });
    expect(ownerItems.calls.opened).toEqual([
      {
        projectId: 'example-project',
        planId: 'plan-1',
        decisionId: 'd1',
        subject: 'Which database engine?',
        blocks: [{ kind: 'lane', ref: 'plan-1/lane-1' }],
      },
      {
        projectId: 'example-project',
        planId: 'plan-1',
        decisionId: 'd2',
        subject: 'Ship the flag now?',
        blocks: [{ kind: 'lane', ref: 'plan-1/lane-1' }, { kind: 'lane', ref: 'plan-1/lane-2' }],
      },
    ]);
    expect(ownerItems.calls.resolved).toHaveLength(0);
  });

  it('a repeat sync answers exists and opens nothing new', async () => {
    const { useCase, ownerItems } = make(planRecord());
    ownerItems.openAnswer = { outcome: 'exists' };
    const result = await useCase.execute({ projectId: 'example-project', planId: 'plan-1', previousDecisionIds: null });
    expect(result).toEqual({ outcome: 'synced', decisions: [
      { decisionId: 'd1', outcome: 'exists' },
      { decisionId: 'd2', outcome: 'exists' },
    ] });
  });

  it('a decided decision resolves plan-decided at the record revision', async () => {
    const { useCase, ownerItems } = make(planRecord({
      decisions: [{ id: 'd1', question: 'Which database engine?', default: 'postgres', state: 'decided' }],
    }));
    const result = await useCase.execute({ projectId: 'example-project', planId: 'plan-1', previousDecisionIds: null });
    expect(result).toEqual({ outcome: 'synced', decisions: [{ decisionId: 'd1', outcome: 'resolved' }] });
    expect(ownerItems.calls.resolved).toEqual([
      {
        projectId: 'example-project',
        planId: 'plan-1',
        decisionId: 'd1',
        outcome: 'decided',
        planRevision: 3,
      },
    ]);
  });

  it('an id only in previousDecisionIds resolves decision-removed; null processes no removals', async () => {
    const { useCase, ownerItems } = make(planRecord());
    const removed = await useCase.execute({
      projectId: 'example-project',
      planId: 'plan-1',
      previousDecisionIds: ['d1', 'd2', 'd9'],
    });
    expect(removed).toEqual({ outcome: 'synced', decisions: [
      { decisionId: 'd1', outcome: 'opened' },
      { decisionId: 'd2', outcome: 'opened' },
      { decisionId: 'd9', outcome: 'resolved' },
    ] });
    expect(ownerItems.calls.resolved).toEqual([
      {
        projectId: 'example-project',
        planId: 'plan-1',
        decisionId: 'd9',
        outcome: 'removed',
        planRevision: 3,
      },
    ]);

    const none = await useCase.execute({ projectId: 'example-project', planId: 'plan-1', previousDecisionIds: null });
    expect(none.outcome).toBe('synced');
    expect(ownerItems.calls.resolved).toHaveLength(1);
  });

  it('an unreadable or missing plan store refuses plan-unread and writes nothing', async () => {
    const throwing = make(null, true);
    expect(await throwing.useCase.execute({ projectId: 'p', planId: 'plan-1', previousDecisionIds: null })).toEqual({
      outcome: 'refused',
      code: 'plan-unread',
      reason: 'the plan record could not be read',
      decisions: [],
    });
    expect(throwing.ownerItems.calls.opened).toHaveLength(0);

    const missing = make(null);
    expect(await missing.useCase.execute({ projectId: 'p', planId: 'plan-1', previousDecisionIds: null })).toEqual({
      outcome: 'refused',
      code: 'plan-unread',
      reason: 'the plan is not imported',
      decisions: [],
    });
    expect(missing.ownerItems.calls.opened).toHaveLength(0);
  });

  it('one refused delegate yields partial and names the decision, echoing no subject text', async () => {
    const { useCase, ownerItems } = make(planRecord());
    ownerItems.refuseOnlyDecisionId = 'd1';
    const result = await useCase.execute({ projectId: 'example-project', planId: 'plan-1', previousDecisionIds: null });
    expect(result.outcome).toBe('partial');
    if (result.outcome !== 'partial') return;
    expect(result.decisions).toEqual([
      { decisionId: 'd1', outcome: 'refused', code: 'refused' },
      { decisionId: 'd2', outcome: 'opened' },
    ]);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('Which database engine');
    expect(serialized).not.toContain('Ship the flag');
  });

  it('every decision refused is an overall refusal', async () => {
    const { useCase, ownerItems } = make(planRecord({
      decisions: [{ id: 'd1', question: 'Which database engine?', default: 'postgres', state: 'open' }],
    }));
    ownerItems.openAnswer = { outcome: 'refused', code: 'not-configured', reason: 'no owner-item recorder is bound' };
    const result = await useCase.execute({ projectId: 'example-project', planId: 'plan-1', previousDecisionIds: null });
    expect(result).toEqual({
      outcome: 'refused',
      code: 'all-refused',
      reason: 'every decision was refused',
      decisions: [{ decisionId: 'd1', outcome: 'refused', code: 'not-configured' }],
    });
  });
});
