/**
 * Lane DT6b unit tests for the attempt-less merge-grant use case: one live
 * grant per pull request, concurrent issuers (superseded), strict cancellation
 * of an earlier grant, field-naming refusals without ids, unconfigured, and the
 * no-id resolve skip. The clock and id source are always injected; an
 * in-memory CoordinationRequestRepositoryAdapter backs every issue.
 */

import { describe, expect, it } from 'vitest';

import type { CoordinationRequestRecord } from '../../../domain/coordination-records.js';
import { isPolicyGrantRecord, mergeGrantProposalDigest } from '../../../domain/policy-grants.js';
import type { MergeGrantForgeKind } from '../../../domain/policy-grants.js';
import { CoordinationRequestRepositoryAdapter } from '../../../infrastructure/adapters/CoordinationRequestRepositoryAdapter.adapter.js';
import type {
  IssueMergeGrantRequest,
  PolicyGrantClock,
  PolicyGrantIdSource,
} from '../../ports/in/IssueMergeGrantPort.in-port.js';
import type { CoordinationRequestRepositoryPort } from '../../ports/out/CoordinationRequestRepositoryPort.out-port.js';
import { IssueMergeGrantUseCase } from '../IssueMergeGrantUseCase.use-case.js';
import { ResolveActionAuthorizationUseCase } from '../ResolveActionAuthorizationUseCase.use-case.js';

const NOW_ISO = '2026-11-02T10:00:00.000Z';
const HA = 'a'.repeat(40);
const HB = 'b'.repeat(40);
const REPO = { owner: 'acme', repo: 'widgets' };

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

function issueMergeRequest(
  overrides: Partial<IssueMergeGrantRequest> = {},
): IssueMergeGrantRequest {
  return {
    projectId: 'project-example',
    repository: REPO,
    pullRequestNumber: 12,
    expectedHeadSha: HA,
    forgeKind: 'merge-pr',
    settingRevision: '309ab8c40bf2',
    deadlineIso: '2026-11-02T10:00:10.000Z',
    ...overrides,
  };
}

function mergeGrantRecord(
  overrides: Partial<CoordinationRequestRecord> = {},
): CoordinationRequestRecord {
  return {
    id: 'request-merge-a',
    projectId: 'project-example',
    kind: 'action-decision',
    state: 'approved',
    actionScope: 'forge:merge-pr',
    expectedHeadSha: HA,
    proposalDigest: 'digest-merge-a',
    policyRevision: '309ab8c40bf2',
    decisionRevision: 'policy:merge@309ab8c40bf2',
    grantId: 'grant-merge-a',
    consumptions: [],
    acknowledgements: [],
    deliveryStatus: 'delivered',
    deliveryGapReason: null,
    revision: 1,
    createdAtIso: '2026-11-02T09:59:00.000Z',
    updatedAtIso: '2026-11-02T09:59:00.000Z',
    mergeGrant: { repository: REPO, pullRequestNumber: 12 },
    ...overrides,
  };
}

/** The exact record the first issue must save (DT6b shape). */
function expectedMergeGrantRecord(): CoordinationRequestRecord {
  return {
    id: 'request-example-1',
    projectId: 'project-example',
    kind: 'action-decision',
    state: 'approved',
    actionScope: 'forge:merge-pr',
    expectedHeadSha: HA,
    proposalDigest: mergeGrantProposalDigest(REPO, 12, HA),
    policyRevision: '309ab8c40bf2',
    decisionRevision: 'policy:merge@309ab8c40bf2',
    grantId: 'grant-example-1',
    consumptions: [],
    acknowledgements: [],
    deliveryStatus: 'delivered',
    deliveryGapReason: null,
    revision: 1,
    createdAtIso: NOW_ISO,
    updatedAtIso: NOW_ISO,
    mergeGrant: { repository: REPO, pullRequestNumber: 12 },
  };
}

/** Injects `extra` into the adapter on the second listRequests call (the sweep). */
class SecondListInjectsConcurrentMergeGrant implements CoordinationRequestRepositoryPort {
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

describe('IssueMergeGrantUseCase', () => {
  it('issues a record with mergeGrant, no policyGrant, actionScope forge:<kind> and decisionRevision policy:merge@<12hex>', async () => {
    const repository = new CoordinationRequestRepositoryAdapter();
    const useCase = new IssueMergeGrantUseCase({
      requestRepo: repository,
      clock: countingClock(),
      ids: countingIds(),
    });
    const result = await useCase.issueMergeGrant(issueMergeRequest());
    expect(result).toEqual({
      outcome: 'issued',
      requestId: 'request-example-1',
      grantId: 'grant-example-1',
      decisionRevision: 'policy:merge@309ab8c40bf2',
      cancelledGrantIds: [],
    });
    const saved = await repository.findRequestById('request-example-1');
    expect(saved).toEqual(expectedMergeGrantRecord());
    expect(Object.hasOwn(saved as CoordinationRequestRecord, 'policyGrant')).toBe(false);
  });

  it('cancels the earlier grant strictly when a second issue lands for the same pull request', async () => {
    const repository = new CoordinationRequestRepositoryAdapter();
    const useCase = new IssueMergeGrantUseCase({
      requestRepo: repository,
      clock: countingClock(),
      ids: countingIds(),
    });
    const first = await useCase.issueMergeGrant(issueMergeRequest());
    expect(first.outcome).toBe('issued');
    if (first.outcome !== 'issued') return;

    const second = await useCase.issueMergeGrant(issueMergeRequest({ expectedHeadSha: HB }));
    expect(second).toEqual({
      outcome: 'issued',
      requestId: 'request-example-2',
      grantId: 'grant-example-2',
      decisionRevision: 'policy:merge@309ab8c40bf2',
      cancelledGrantIds: ['grant-example-1'],
    });
    const storedFirst = await repository.findRequestById('request-example-1');
    expect(storedFirst?.state).toBe('cancelled');
    expect(storedFirst?.revision).toBe(2);
    expect((await repository.findRequestById('request-example-2'))?.state).toBe('approved');
  });

  it('reports superseded when a newer grant races the issue and leaves only the newest live', async () => {
    const repository = new CoordinationRequestRepositoryAdapter();
    const wrapper = new SecondListInjectsConcurrentMergeGrant(
      repository,
      mergeGrantRecord({
        id: 'request-concurrent-after',
        grantId: 'grant-concurrent-after',
        createdAtIso: '2026-11-02T10:00:02.000Z',
        updatedAtIso: '2026-11-02T10:00:02.000Z',
      }),
    );
    const useCase = new IssueMergeGrantUseCase({
      requestRepo: wrapper,
      clock: countingClock(),
      ids: countingIds(),
    });
    const result = await useCase.issueMergeGrant(issueMergeRequest());
    expect(result).toEqual({
      outcome: 'superseded',
      requestId: 'request-example-1',
      grantId: 'grant-example-1',
      cancelledGrantIds: ['grant-example-1'],
      unresolvedGrantIds: [],
    });
    expect((await repository.findRequestById('request-example-1'))?.state).toBe('cancelled');
    expect((await repository.findRequestById('request-concurrent-after'))?.state).toBe('approved');
  });

  it('refuses validation naming the field with no ids and writes nothing', async () => {
    const repository = new CoordinationRequestRepositoryAdapter();
    const useCase = new IssueMergeGrantUseCase({
      requestRepo: repository,
      clock: countingClock(),
      ids: countingIds(),
    });
    const cases: ReadonlyArray<readonly [Partial<IssueMergeGrantRequest>, string]> = [
      [{ projectId: '' }, 'a merge grant requires a non-empty projectId of at most 256 characters'],
      [
        { projectId: 'x'.repeat(257) },
        'a merge grant requires a non-empty projectId of at most 256 characters',
      ],
      [
        { settingRevision: 'XYZZY' },
        'a merge grant settingRevision must be 12 lower-case hex characters',
      ],
      [
        { expectedHeadSha: 'abc123' },
        'a merge grant expectedHeadSha must be a full lower-case commit id',
      ],
      [
        { forgeKind: 'force-push-XYZZY' as MergeGrantForgeKind },
        'a merge grant forgeKind must be one of merge-pr, update-branch, post-status',
      ],
      [{ pullRequestNumber: 0 }, 'a merge grant pullRequestNumber must be a positive safe integer'],
      [{ pullRequestNumber: -1 }, 'a merge grant pullRequestNumber must be a positive safe integer'],
      [{ pullRequestNumber: 1.5 }, 'a merge grant pullRequestNumber must be a positive safe integer'],
      [
        { repository: { owner: '', repo: 'widgets' } },
        'a merge grant repository owner must be a non-empty string of at most 256 characters',
      ],
      [
        { repository: { owner: 'acme', repo: '   ' } },
        'a merge grant repository repo must be a non-empty string of at most 256 characters',
      ],
    ];
    for (const [override, reason] of cases) {
      const result = await useCase.issueMergeGrant(issueMergeRequest(override));
      expect(result).toEqual({ outcome: 'refused', reason });
      expect(Object.hasOwn(result, 'requestId')).toBe(false);
      expect(Object.hasOwn(result, 'grantId')).toBe(false);
    }
    expect(await repository.listRequests()).toEqual([]);
  });

  it('rejects Not implemented without dependencies or with a missing request', async () => {
    await expect(new IssueMergeGrantUseCase().execute({})).rejects.toThrow(
      'Not implemented: IssueMergeGrantUseCase',
    );
    await expect(new IssueMergeGrantUseCase().execute(undefined)).rejects.toThrow(
      'Not implemented: IssueMergeGrantUseCase',
    );
    const configured = new IssueMergeGrantUseCase({
      requestRepo: new CoordinationRequestRepositoryAdapter(),
      clock: countingClock(),
      ids: countingIds(),
    });
    await expect(configured.execute(undefined)).rejects.toThrow(
      'Not implemented: IssueMergeGrantUseCase',
    );
  });

  it('is skipped by the no-id resolve rule through the policy-prefixed decision revision', async () => {
    const repository = new CoordinationRequestRepositoryAdapter();
    await repository.saveRequest(mergeGrantRecord());
    const record = await repository.findRequestById('request-merge-a');
    expect(isPolicyGrantRecord(record as CoordinationRequestRecord)).toBe(true);

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
});
