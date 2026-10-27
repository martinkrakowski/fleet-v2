/**
 * Lane AM3a-2 unit tests for the policy-grant use cases: IssuePolicyForgeGrant
 * (one live grant per work order, across kinds, concurrent issuers, conflict
 * handling) and CancelPolicyGrants (A7 by revision). The clock and id source
 * are always injected; an in-memory CoordinationRequestRepositoryAdapter backs
 * every issue.
 */

import { describe, expect, it } from 'vitest';

import type { CoordinationRequestRecord } from '../../../domain/coordination-records.js';
import { policyGrantProposalDigest } from '../../../domain/policy-grants.js';
import type { PolicyGrantForgeKind } from '../../../domain/policy-grants.js';
import { CoordinationRequestRepositoryAdapter } from '../../../infrastructure/adapters/CoordinationRequestRepositoryAdapter.adapter.js';
import type { CancelPolicyGrantsRequest } from '../../ports/in/CancelPolicyGrantsPort.in-port.js';
import type {
  IssuePolicyForgeGrantRequest,
  PolicyGrantClock,
  PolicyGrantIdSource,
} from '../../ports/in/IssuePolicyForgeGrantPort.in-port.js';
import { CoordinationRequestRevisionConflictError } from '../../ports/out/CoordinationRequestRepositoryPort.out-port.js';
import type { CoordinationRequestRepositoryPort } from '../../ports/out/CoordinationRequestRepositoryPort.out-port.js';
import { CancelPolicyGrantsUseCase } from '../CancelPolicyGrantsUseCase.use-case.js';
import { IssuePolicyForgeGrantUseCase } from '../IssuePolicyForgeGrantUseCase.use-case.js';
import { RecordAuthorizationConsumptionUseCase } from '../RecordAuthorizationConsumptionUseCase.use-case.js';
import { ResolveActionAuthorizationUseCase } from '../ResolveActionAuthorizationUseCase.use-case.js';

const NOW_ISO = '2026-10-27T10:00:00.000Z';
const HA = 'a'.repeat(40);
const HB = 'b'.repeat(40);

/** A clock the composition root would inject; it counts its reads. */
function countingClock(): PolicyGrantClock & { calls: number } {
  const state = { calls: 0 };
  return {
    get calls() {
      return state.calls;
    },
    nowIso() {
      state.calls += 1;
      return new Date(new Date(NOW_ISO).getTime() + (state.calls - 1) * 1000).toISOString();
    },
  };
}

/** An id source the composition root would inject; it counts its mints. */
function countingIds(): PolicyGrantIdSource & { requestCalls: number; grantCalls: number } {
  const state = { requestCalls: 0, grantCalls: 0 };
  return {
    get requestCalls() {
      return state.requestCalls;
    },
    get grantCalls() {
      return state.grantCalls;
    },
    newRequestId() {
      state.requestCalls += 1;
      return `request-example-${state.requestCalls}`;
    },
    newGrantId() {
      state.grantCalls += 1;
      return `grant-example-${state.grantCalls}`;
    },
  };
}

/* ------------------------------------------------------------------ *
 * Record factories
 * ------------------------------------------------------------------ */

function issueRequest(
  overrides: Partial<IssuePolicyForgeGrantRequest> = {},
): IssuePolicyForgeGrantRequest {
  return {
    projectId: 'project-example',
    workOrderId: 'wo-example-a',
    attemptId: 'attempt-example-a',
    forgeKind: 'merge-pr',
    expectedHeadSha: HA,
    policyRevision: 'policy-revision-example',
    acceptanceReceiptId: 'receipt-example-a',
    source: 'autoMerge',
    settingRevision: '309ab8c40bf2',
    ...overrides,
  };
}

function cancelRequest(
  overrides: Partial<CancelPolicyGrantsRequest> = {},
): CancelPolicyGrantsRequest {
  return { source: 'autoMerge', currentRevision: '309ab8c40bf2', ...overrides };
}

function policyGrantRecord(
  overrides: Partial<CoordinationRequestRecord> = {},
): CoordinationRequestRecord {
  return {
    id: 'request-policy-a',
    projectId: 'project-example',
    kind: 'action-decision',
    state: 'approved',
    actionScope: 'forge:merge-pr',
    expectedHeadSha: HA,
    proposalDigest: 'digest-policy-a',
    policyRevision: 'policy-revision-example',
    decisionRevision: 'policy:autoMerge@309ab8c40bf2',
    grantId: 'grant-policy-a',
    consumptions: [],
    acknowledgements: [],
    deliveryStatus: 'delivered',
    deliveryGapReason: null,
    revision: 1,
    createdAtIso: '2026-10-27T09:59:00.000Z',
    updatedAtIso: '2026-10-27T09:59:00.000Z',
    policyGrant: {
      workOrderId: 'wo-example-a',
      attemptId: 'attempt-example-a',
      acceptanceReceiptId: 'receipt-example-a',
    },
    ...overrides,
  };
}

function ownerGrantRecord(
  overrides: Partial<CoordinationRequestRecord> = {},
): CoordinationRequestRecord {
  return {
    id: 'request-owner',
    projectId: 'project-example',
    kind: 'action-decision',
    state: 'approved',
    actionScope: 'forge:merge-pr',
    expectedHeadSha: HA,
    proposalDigest: 'digest-owner',
    policyRevision: 'policy-revision-example',
    decisionRevision: 'decision-example-owner',
    grantId: 'grant-owner',
    consumptions: [],
    acknowledgements: [],
    deliveryStatus: 'delivered',
    deliveryGapReason: null,
    revision: 1,
    createdAtIso: '2026-10-27T09:58:00.000Z',
    updatedAtIso: '2026-10-27T09:58:00.000Z',
    ...overrides,
  };
}

function consumedGrantRecord(
  overrides: Partial<CoordinationRequestRecord> = {},
): CoordinationRequestRecord {
  return policyGrantRecord({
    id: 'request-consumed',
    state: 'completed',
    grantId: 'grant-consumed',
    decisionRevision: 'policy:autoMerge@0692f17be6e5',
    consumptions: [
      {
        consumptionId: 'consumption-example-x',
        grantId: 'grant-consumed',
        requestId: 'request-consumed',
        actionId: 'action-example-x',
        attemptId: 'attempt-example-a',
        expectedHeadSha: HA,
        consumedAtIso: '2026-10-27T09:56:00.000Z',
      },
    ],
    ...overrides,
  });
}

/** The exact record the first issue must save (3.4 shape). */
function expectedMergeGrantRecord(): CoordinationRequestRecord {
  return {
    id: 'request-example-1',
    projectId: 'project-example',
    kind: 'action-decision',
    state: 'approved',
    actionScope: 'forge:merge-pr',
    expectedHeadSha: HA,
    proposalDigest: policyGrantProposalDigest('attempt-example-a', HA, 'receipt-example-a'),
    policyRevision: 'policy-revision-example',
    decisionRevision: 'policy:autoMerge@309ab8c40bf2',
    grantId: 'grant-example-1',
    consumptions: [],
    acknowledgements: [],
    deliveryStatus: 'delivered',
    deliveryGapReason: null,
    revision: 1,
    createdAtIso: NOW_ISO,
    updatedAtIso: NOW_ISO,
    policyGrant: {
      workOrderId: 'wo-example-a',
      attemptId: 'attempt-example-a',
      acceptanceReceiptId: 'receipt-example-a',
    },
  };
}

/* ------------------------------------------------------------------ *
 * Repository wrappers for concurrency tests
 * ------------------------------------------------------------------ */

/** Injects `extra` into the adapter on the second listRequests call (the sweep). */
class SecondListInjectsConcurrentGrant implements CoordinationRequestRepositoryPort {
  private listCalls = 0;

  constructor(
    private readonly inner: CoordinationRequestRepositoryAdapter,
    private readonly extra: CoordinationRequestRecord,
  ) {}

  async saveRequest(record: CoordinationRequestRecord): Promise<void> {
    return this.inner.saveRequest(record);
  }

  async findRequestById(requestId: string): Promise<CoordinationRequestRecord | null> {
    return this.inner.findRequestById(requestId);
  }

  async findRequestByGrantId(grantId: string): Promise<CoordinationRequestRecord | null> {
    return this.inner.findRequestByGrantId(grantId);
  }

  async listRequests(projectId?: string): Promise<readonly CoordinationRequestRecord[]> {
    this.listCalls += 1;
    if (this.listCalls === 2 && (await this.inner.findRequestById(this.extra.id)) === null) {
      await this.inner.saveRequest(this.extra);
    }
    return this.inner.listRequests(projectId);
  }
}

/** Consumes the record on the first cancel save, then throws a revision conflict. */
class ConsumeOnFirstCancelSave implements CoordinationRequestRepositoryPort {
  private cancelSaves = 0;

  constructor(private readonly inner: CoordinationRequestRepositoryAdapter) {}

  async saveRequest(record: CoordinationRequestRecord): Promise<void> {
    if (record.state === 'cancelled') {
      this.cancelSaves += 1;
      if (this.cancelSaves === 1) {
        const fresh = await this.inner.findRequestById(record.id);
        if (fresh !== null) {
          await this.inner.saveRequest({
            ...fresh,
            state: 'completed',
            consumptions: [
              {
                consumptionId: 'consumption-conflict',
                grantId: fresh.grantId ?? 'grant-conflict',
                requestId: fresh.id,
                actionId: 'action-conflict',
                attemptId: 'attempt-example-a',
                expectedHeadSha: fresh.expectedHeadSha ?? HA,
                consumedAtIso: '2026-10-27T10:00:00.500Z',
              },
            ],
            revision: fresh.revision + 1,
            updatedAtIso: '2026-10-27T10:00:00.500Z',
          });
        }
        throw new CoordinationRequestRevisionConflictError(
          record.id,
          record.revision,
          'another writer consumed the record first',
        );
      }
    }
    return this.inner.saveRequest(record);
  }

  async findRequestById(requestId: string): Promise<CoordinationRequestRecord | null> {
    return this.inner.findRequestById(requestId);
  }

  async findRequestByGrantId(grantId: string): Promise<CoordinationRequestRecord | null> {
    return this.inner.findRequestByGrantId(grantId);
  }

  async listRequests(projectId?: string): Promise<readonly CoordinationRequestRecord[]> {
    return this.inner.listRequests(projectId);
  }
}

/** Always throws a revision conflict on every cancel save; the record stays live. */
class ConflictTwiceOnCancel implements CoordinationRequestRepositoryPort {
  constructor(private readonly inner: CoordinationRequestRepositoryAdapter) {}

  async saveRequest(record: CoordinationRequestRecord): Promise<void> {
    if (record.state === 'cancelled') {
      throw new CoordinationRequestRevisionConflictError(
        record.id,
        record.revision,
        'the record keeps moving',
      );
    }
    return this.inner.saveRequest(record);
  }

  async findRequestById(requestId: string): Promise<CoordinationRequestRecord | null> {
    return this.inner.findRequestById(requestId);
  }

  async findRequestByGrantId(grantId: string): Promise<CoordinationRequestRecord | null> {
    return this.inner.findRequestByGrantId(grantId);
  }

  async listRequests(projectId?: string): Promise<readonly CoordinationRequestRecord[]> {
    return this.inner.listRequests(projectId);
  }
}

/* ------------------------------------------------------------------ *
 * Issue
 * ------------------------------------------------------------------ */

describe('IssuePolicyForgeGrantUseCase', () => {
  it('records a merge grant exactly as the plan shapes it and resolve and consumption use it', async () => {
    const repository = new CoordinationRequestRepositoryAdapter();
    const useCase = new IssuePolicyForgeGrantUseCase({
      requestRepo: repository,
      clock: countingClock(),
      ids: countingIds(),
    });
    const result = await useCase.issuePolicyForgeGrant(issueRequest());
    expect(result).toEqual({
      outcome: 'issued',
      requestId: 'request-example-1',
      grantId: 'grant-example-1',
      actionScope: 'forge:merge-pr',
      decisionRevision: 'policy:autoMerge@309ab8c40bf2',
      workOrderId: 'wo-example-a',
      attemptId: 'attempt-example-a',
      expectedHeadSha: HA,
      cancelledGrantIds: [],
    });
    expect(await repository.findRequestById('request-example-1')).toEqual(expectedMergeGrantRecord());

    const resolved = await new ResolveActionAuthorizationUseCase({
      requestRepo: repository,
    }).resolveActionAuthorization({
      projectId: 'project-example',
      actionScope: 'forge:merge-pr',
      expectedHeadSha: HA,
      authorizationGrantId: 'grant-example-1',
    });
    expect(resolved).toMatchObject({ outcome: 'authorized', grantId: 'grant-example-1' });

    const consumed = await new RecordAuthorizationConsumptionUseCase({
      requestRepo: repository,
    }).recordAuthorizationConsumption({
      consumptionId: 'consumption-example-1',
      grantId: 'grant-example-1',
      actionId: 'action-example-1',
      actionScope: 'forge:merge-pr',
      attemptId: 'attempt-example-a',
      expectedHeadSha: HA,
      nowIso: NOW_ISO,
    });
    expect(consumed.outcome).toBe('consumed');
  });

  it('keeps one live grant per work order', async () => {
    const repository = new CoordinationRequestRepositoryAdapter();
    const useCase = new IssuePolicyForgeGrantUseCase({
      requestRepo: repository,
      clock: countingClock(),
      ids: countingIds(),
    });
    const woB = policyGrantRecord({
      id: 'request-wob',
      grantId: 'grant-wob',
      policyGrant: {
        workOrderId: 'wo-example-b',
        attemptId: 'attempt-example-a',
        acceptanceReceiptId: 'receipt-example-a',
      },
    });
    const owner = ownerGrantRecord();
    const consumed = consumedGrantRecord();
    await repository.saveRequest(woB);
    await repository.saveRequest(owner);
    await repository.saveRequest(consumed);

    const first = await useCase.issuePolicyForgeGrant(issueRequest());
    expect(first.outcome).toBe('issued');
    if (first.outcome !== 'issued') return;

    const second = await useCase.issuePolicyForgeGrant(issueRequest({ expectedHeadSha: HB }));
    expect(second).toEqual({
      outcome: 'issued',
      requestId: 'request-example-2',
      grantId: 'grant-example-2',
      actionScope: 'forge:merge-pr',
      decisionRevision: 'policy:autoMerge@309ab8c40bf2',
      workOrderId: 'wo-example-a',
      attemptId: 'attempt-example-a',
      expectedHeadSha: HB,
      cancelledGrantIds: ['grant-example-1'],
    });

    const storedFirst = await repository.findRequestById('request-example-1');
    expect(storedFirst?.state).toBe('cancelled');
    expect(storedFirst?.revision).toBe(2);
    expect((await repository.findRequestById('request-example-2'))?.state).toBe('approved');

    const resolvedFirst = await new ResolveActionAuthorizationUseCase({
      requestRepo: repository,
    }).resolveActionAuthorization({
      projectId: 'project-example',
      actionScope: 'forge:merge-pr',
      expectedHeadSha: HA,
      authorizationGrantId: 'grant-example-1',
    });
    expect(resolvedFirst).toMatchObject({
      outcome: 'blocked',
      reason: expect.stringContaining('is cancelled'),
    });

    const consumedFirst = await new RecordAuthorizationConsumptionUseCase({
      requestRepo: repository,
    }).recordAuthorizationConsumption({
      consumptionId: 'consumption-late',
      grantId: 'grant-example-1',
      actionId: 'action-late',
      actionScope: 'forge:merge-pr',
      attemptId: 'attempt-example-a',
      expectedHeadSha: HA,
      nowIso: NOW_ISO,
    });
    expect(consumedFirst.outcome).toBe('refused');

    expect(await repository.findRequestById('request-wob')).toEqual(woB);
    expect(await repository.findRequestById('request-owner')).toEqual(owner);
    expect(await repository.findRequestById('request-consumed')).toEqual(consumed);
  });

  it('cancels an earlier push grant when a merge grant lands for the same work order', async () => {
    const repository = new CoordinationRequestRepositoryAdapter();
    const useCase = new IssuePolicyForgeGrantUseCase({
      requestRepo: repository,
      clock: countingClock(),
      ids: countingIds(),
    });
    const push = await useCase.issuePolicyForgeGrant(
      issueRequest({
        forgeKind: 'push-and-open-pr',
        source: 'conductor',
        settingRevision: '7844746b0277',
      }),
    );
    expect(push.outcome).toBe('issued');
    const merge = await useCase.issuePolicyForgeGrant(issueRequest());
    expect(merge.outcome).toBe('issued');
    if (merge.outcome !== 'issued') return;
    expect(merge.cancelledGrantIds).toEqual(['grant-example-1']);
    expect((await repository.findRequestById('request-example-1'))?.state).toBe('cancelled');
  });

  it('refuses pairing and malformed inputs without writing anything', async () => {
    const repository = new CoordinationRequestRepositoryAdapter();
    const useCase = new IssuePolicyForgeGrantUseCase({
      requestRepo: repository,
      clock: countingClock(),
      ids: countingIds(),
    });
    const cases: ReadonlyArray<readonly [Partial<IssuePolicyForgeGrantRequest>, string]> = [
      [
        { source: 'conductor' },
        'a policy grant for this forge kind must be authorised by its own setting',
      ],
      [
        { forgeKind: 'push-to-pr', source: 'autoMerge' },
        'a policy grant for this forge kind must be authorised by its own setting',
      ],
      [
        { forgeKind: 'force-push-XYZZY' as PolicyGrantForgeKind },
        'a policy grant forgeKind must be one of push-and-open-pr, push-to-pr, merge-pr',
      ],
      [
        { settingRevision: 'XYZZY' },
        'a policy grant settingRevision must be 12 lower-case hex characters',
      ],
      [
        { expectedHeadSha: 'abc123' },
        'a policy grant expectedHeadSha must be a full lower-case commit id',
      ],
      [
        { workOrderId: '   ' },
        'a policy grant requires a non-empty workOrderId of at most 256 characters',
      ],
      [
        { attemptId: 'x'.repeat(257) },
        'a policy grant requires a non-empty attemptId of at most 256 characters',
      ],
    ];
    for (const [override, reason] of cases) {
      const result = await useCase.issuePolicyForgeGrant(issueRequest(override));
      expect(result).toEqual({ outcome: 'refused', reason });
      expect(reason).not.toContain('XYZZY');
    }
    expect(await repository.listRequests()).toEqual([]);
  });

  it('refuses when a minted request id already exists', async () => {
    const repository = new CoordinationRequestRepositoryAdapter();
    await repository.saveRequest(
      policyGrantRecord({ id: 'request-example-1', grantId: 'grant-example-1' }),
    );
    const useCase = new IssuePolicyForgeGrantUseCase({
      requestRepo: repository,
      clock: countingClock(),
      ids: countingIds(),
    });
    const result = await useCase.issuePolicyForgeGrant(issueRequest());
    expect(result).toEqual({
      outcome: 'refused',
      reason: 'a minted policy grant id is already recorded',
    });
    expect(await repository.listRequests()).toHaveLength(1);
  });

  it('returns the fixed reason when the policy grant record cannot be built', async () => {
    const repository = new CoordinationRequestRepositoryAdapter();
    const useCase = new IssuePolicyForgeGrantUseCase({
      requestRepo: repository,
      clock: { nowIso: () => '' },
      ids: countingIds(),
    });
    const result = await useCase.issuePolicyForgeGrant(issueRequest());
    expect(result).toEqual({
      outcome: 'refused',
      reason: 'policy grant record could not be built',
    });
    expect(await repository.listRequests()).toEqual([]);
  });

  it('sweeps a concurrent grant that landed one second before the new grant', async () => {
    const repository = new CoordinationRequestRepositoryAdapter();
    const wrapper = new SecondListInjectsConcurrentGrant(
      repository,
      policyGrantRecord({
        id: 'request-concurrent-before',
        grantId: 'grant-concurrent-before',
        createdAtIso: '2026-10-27T09:59:59.000Z',
        updatedAtIso: '2026-10-27T09:59:59.000Z',
      }),
    );
    const useCase = new IssuePolicyForgeGrantUseCase({
      requestRepo: wrapper,
      clock: countingClock(),
      ids: countingIds(),
    });
    const result = await useCase.issuePolicyForgeGrant(issueRequest());
    expect(result.outcome).toBe('issued');
    if (result.outcome !== 'issued') return;
    expect(result.cancelledGrantIds).toEqual(['grant-concurrent-before']);
    expect((await repository.findRequestById('request-concurrent-before'))?.state).toBe('cancelled');
    expect((await repository.findRequestById('request-example-1'))?.state).toBe('approved');
  });

  it('returns superseded when two issuers race and leaves only the newest grant live', async () => {
    const repository = new CoordinationRequestRepositoryAdapter();
    const wrapper = new SecondListInjectsConcurrentGrant(
      repository,
      policyGrantRecord({
        id: 'request-concurrent-after',
        grantId: 'grant-concurrent-after',
        createdAtIso: '2026-10-27T10:00:02.000Z',
        updatedAtIso: '2026-10-27T10:00:02.000Z',
      }),
    );
    const useCase = new IssuePolicyForgeGrantUseCase({
      requestRepo: wrapper,
      clock: countingClock(),
      ids: countingIds(),
    });
    const result = await useCase.issuePolicyForgeGrant(issueRequest());
    expect(result).toEqual({
      outcome: 'superseded',
      requestId: 'request-example-1',
      grantId: 'grant-example-1',
      cancelledGrantIds: ['grant-example-1'],
    });
    expect((await repository.findRequestById('request-example-1'))?.state).toBe('cancelled');
    expect((await repository.findRequestById('request-concurrent-after'))?.state).toBe('approved');
  });

  it('skips an earlier grant another writer consumed during its cancel and still issues', async () => {
    const repository = new CoordinationRequestRepositoryAdapter();
    await repository.saveRequest(
      policyGrantRecord({ id: 'request-earlier', grantId: 'grant-earlier' }),
    );
    const wrapper = new ConsumeOnFirstCancelSave(repository);
    const useCase = new IssuePolicyForgeGrantUseCase({
      requestRepo: wrapper,
      clock: countingClock(),
      ids: countingIds(),
    });
    const result = await useCase.issuePolicyForgeGrant(issueRequest());
    expect(result.outcome).toBe('issued');
    const earlier = await repository.findRequestById('request-earlier');
    expect(earlier?.state).toBe('completed');
    expect(earlier?.consumptions).toHaveLength(1);
    expect((await repository.findRequestById('request-example-1'))?.state).toBe('approved');
  });

  it('refuses when a still-live earlier grant conflicts twice and saves nothing', async () => {
    const repository = new CoordinationRequestRepositoryAdapter();
    await repository.saveRequest(
      policyGrantRecord({ id: 'request-earlier', grantId: 'grant-earlier' }),
    );
    const wrapper = new ConflictTwiceOnCancel(repository);
    const useCase = new IssuePolicyForgeGrantUseCase({
      requestRepo: wrapper,
      clock: countingClock(),
      ids: countingIds(),
    });
    const result = await useCase.issuePolicyForgeGrant(issueRequest());
    expect(result).toEqual({
      outcome: 'refused',
      reason: 'an earlier policy grant moved while it was being cancelled; nothing was issued',
    });
    expect(await repository.listRequests()).toHaveLength(1);
    expect((await repository.findRequestById('request-earlier'))?.state).toBe('approved');
  });
});

/* ------------------------------------------------------------------ *
 * Cancel
 * ------------------------------------------------------------------ */

describe('CancelPolicyGrantsUseCase', () => {
  it('cancels exactly the old-revision merge grants and leaves consumed, current, other and owner grants untouched', async () => {
    const repository = new CoordinationRequestRepositoryAdapter();
    const oldLiveA = policyGrantRecord({
      id: 'request-old-a',
      grantId: 'grant-old-a',
      decisionRevision: 'policy:autoMerge@0692f17be6e5',
    });
    const oldLiveB = policyGrantRecord({
      id: 'request-old-b',
      grantId: 'grant-old-b',
      decisionRevision: 'policy:autoMerge@0692f17be6e5',
      createdAtIso: '2026-10-27T09:55:00.000Z',
      updatedAtIso: '2026-10-27T09:55:00.000Z',
    });
    const consumed = consumedGrantRecord();
    const current = policyGrantRecord({
      id: 'request-current',
      grantId: 'grant-current',
      decisionRevision: 'policy:autoMerge@309ab8c40bf2',
    });
    const conductor = policyGrantRecord({
      id: 'request-conductor',
      grantId: 'grant-conductor',
      actionScope: 'forge:push-and-open-pr',
      decisionRevision: 'policy:conductor@0692f17be6e5',
      policyGrant: {
        workOrderId: 'wo-example-c',
        attemptId: 'attempt-example-a',
        acceptanceReceiptId: 'receipt-example-a',
      },
    });
    const owner = ownerGrantRecord();
    const seeds = [oldLiveA, oldLiveB, consumed, current, conductor, owner];
    for (const record of seeds) {
      await repository.saveRequest(record);
    }

    const useCase = new CancelPolicyGrantsUseCase({
      requestRepo: repository,
      clock: countingClock(),
    });
    const result = await useCase.cancelPolicyGrants(cancelRequest());
    expect(result).toEqual({
      outcome: 'cancelled',
      cancelledGrantIds: ['grant-old-a', 'grant-old-b'],
      consumedLeft: 1,
    });
    expect((await repository.findRequestById('request-old-a'))?.state).toBe('cancelled');
    expect((await repository.findRequestById('request-old-b'))?.state).toBe('cancelled');
    expect(await repository.findRequestById('request-consumed')).toEqual(consumed);
    expect(await repository.findRequestById('request-current')).toEqual(current);
    expect(await repository.findRequestById('request-conductor')).toEqual(conductor);
    expect(await repository.findRequestById('request-owner')).toEqual(owner);

    const second = await useCase.cancelPolicyGrants(cancelRequest());
    expect(second.outcome).toBe('cancelled');
    if (second.outcome !== 'cancelled') return;
    expect(second.cancelledGrantIds).toEqual([]);
    expect(second.consumedLeft).toBe(1);
  });

  it('cancels everything outstanding when the setting is turned off and refuses later consumption', async () => {
    const repository = new CoordinationRequestRepositoryAdapter();
    await repository.saveRequest(policyGrantRecord({ id: 'request-only', grantId: 'grant-only' }));
    const useCase = new CancelPolicyGrantsUseCase({
      requestRepo: repository,
      clock: countingClock(),
    });
    const result = await useCase.cancelPolicyGrants(
      cancelRequest({ currentRevision: '0692f17be6e5' }),
    );
    expect(result).toEqual({
      outcome: 'cancelled',
      cancelledGrantIds: ['grant-only'],
      consumedLeft: 0,
    });
    const consumed = await new RecordAuthorizationConsumptionUseCase({
      requestRepo: repository,
    }).recordAuthorizationConsumption({
      consumptionId: 'consumption-after-off',
      grantId: 'grant-only',
      actionId: 'action-after-off',
      actionScope: 'forge:merge-pr',
      attemptId: 'attempt-example-a',
      expectedHeadSha: HA,
      nowIso: NOW_ISO,
    });
    expect(consumed.outcome).toBe('refused');
  });

  it('reports a second conflict on cancel as partial with unresolvedGrantIds', async () => {
    const repository = new CoordinationRequestRepositoryAdapter();
    await repository.saveRequest(
      policyGrantRecord({
        id: 'request-old',
        grantId: 'grant-old',
        decisionRevision: 'policy:autoMerge@0692f17be6e5',
      }),
    );
    const wrapper = new ConflictTwiceOnCancel(repository);
    const useCase = new CancelPolicyGrantsUseCase({
      requestRepo: wrapper,
      clock: countingClock(),
    });
    const result = await useCase.cancelPolicyGrants(cancelRequest());
    expect(result).toEqual({
      outcome: 'partial',
      cancelledGrantIds: [],
      unresolvedGrantIds: ['grant-old'],
      consumedLeft: 0,
    });
    expect((await repository.findRequestById('request-old'))?.state).toBe('approved');
  });
});

/* ------------------------------------------------------------------ *
 * Resolve without a grant id
 * ------------------------------------------------------------------ */

describe('ResolveActionAuthorizationUseCase no-id resolve', () => {
  it('never returns a policy grant when resolving without a grant id at its head', async () => {
    const repository = new CoordinationRequestRepositoryAdapter();
    await repository.saveRequest(policyGrantRecord());
    const resolved = await new ResolveActionAuthorizationUseCase({
      requestRepo: repository,
    }).resolveActionAuthorization({
      projectId: 'project-example',
      actionScope: 'forge:merge-pr',
      expectedHeadSha: HA,
    });
    expect(resolved).toMatchObject({
      outcome: 'blocked',
      reason: 'no recorded decision authorizes forge:merge-pr for project-example',
    });
  });

  it('returns the owner grant when an approved policy grant sits at the same head as a newer owner grant', async () => {
    const repository = new CoordinationRequestRepositoryAdapter();
    await repository.saveRequest(policyGrantRecord());
    await repository.saveRequest(
      ownerGrantRecord({
        createdAtIso: '2026-10-27T09:59:30.000Z',
        updatedAtIso: '2026-10-27T09:59:30.000Z',
      }),
    );
    const resolved = await new ResolveActionAuthorizationUseCase({
      requestRepo: repository,
    }).resolveActionAuthorization({
      projectId: 'project-example',
      actionScope: 'forge:merge-pr',
      expectedHeadSha: HA,
    });
    expect(resolved).toMatchObject({ outcome: 'authorized', grantId: 'grant-owner' });
  });
});

/* ------------------------------------------------------------------ *
 * Unconfigured and missing input
 * ------------------------------------------------------------------ */

describe('unconfigured and missing input', () => {
  it('rejects Not implemented without dependencies or with a missing request', async () => {
    await expect(new IssuePolicyForgeGrantUseCase().execute({})).rejects.toThrow(
      'Not implemented: IssuePolicyForgeGrantUseCase',
    );
    await expect(new CancelPolicyGrantsUseCase().execute({})).rejects.toThrow(
      'Not implemented: CancelPolicyGrantsUseCase',
    );
    const configuredIssue = new IssuePolicyForgeGrantUseCase({
      requestRepo: new CoordinationRequestRepositoryAdapter(),
      clock: countingClock(),
      ids: countingIds(),
    });
    const configuredCancel = new CancelPolicyGrantsUseCase({
      requestRepo: new CoordinationRequestRepositoryAdapter(),
      clock: countingClock(),
    });
    await expect(configuredIssue.execute(undefined)).rejects.toThrow(
      'Not implemented: IssuePolicyForgeGrantUseCase',
    );
    await expect(configuredCancel.execute(undefined)).rejects.toThrow(
      'Not implemented: CancelPolicyGrantsUseCase',
    );
  });
});
