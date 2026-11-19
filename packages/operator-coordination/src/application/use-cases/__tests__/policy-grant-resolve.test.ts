import { describe, expect, it } from 'vitest';

import type { CoordinationRequestRecord } from '../../../domain/coordination-records.js';
import { CoordinationRequestRepositoryAdapter } from '../../../infrastructure/adapters/CoordinationRequestRepositoryAdapter.adapter.js';
import type { ResolveActionAuthorizationRequest } from '../../ports/in/ResolveActionAuthorizationPort.in-port.js';
import { ResolveActionAuthorizationUseCase } from '../ResolveActionAuthorizationUseCase.use-case.js';
import { createSignedDecisionFixture } from './signed-decision-fixture.js';

const NOW_OLDER = '2026-10-27T00:00:00.000Z';
const NOW_NEWER = '2026-10-27T01:00:00.000Z';
const HEAD = 'a'.repeat(40);
const HEAD_B = 'b'.repeat(40);
const HEAD_HA = 'c'.repeat(40);

function requestRecord(overrides: Partial<CoordinationRequestRecord> = {}): CoordinationRequestRecord {
  return {
    id: 'request-example-a',
    projectId: 'project-example',
    kind: 'action-decision',
    state: 'approved',
    actionScope: 'forge:merge-pr',
    expectedHeadSha: HEAD,
    proposalDigest: 'digest-example-a',
    policyRevision: 'policy-revision-example',
    decisionRevision: 'decision-example-a',
    grantId: 'grant-example-a',
    consumptions: [],
    acknowledgements: [],
    deliveryStatus: 'pending',
    deliveryGapReason: null,
    revision: 1,
    createdAtIso: NOW_OLDER,
    updatedAtIso: NOW_OLDER,
    ...overrides,
  };
}

function policyGrantRecord(overrides: Partial<CoordinationRequestRecord> = {}): CoordinationRequestRecord {
  return requestRecord({
    decisionRevision: 'policy:autoMerge@309ab8c40bf2',
    policyGrant: {
      workOrderId: 'wo-example-a',
      attemptId: 'attempt-example-a',
      acceptanceReceiptId: 'receipt-example-a',
    },
    ...overrides,
  });
}

async function saveAll(
  repository: CoordinationRequestRepositoryAdapter,
  records: readonly CoordinationRequestRecord[],
): Promise<void> {
  for (const record of records) {
    await repository.saveRequest(record);
  }
}

function resolve(
  repository: CoordinationRequestRepositoryAdapter,
  request: ResolveActionAuthorizationRequest,
  signer?: ReturnType<typeof createSignedDecisionFixture>,
) {
  return new ResolveActionAuthorizationUseCase({
    requestRepo: repository,
    ...(signer ?? createSignedDecisionFixture()).deps,
  }).resolveActionAuthorization(
    request,
  );
}

describe('ResolveActionAuthorizationUseCase no-id fallback and policy grants', () => {
  // CO24g: owner grants resolve with their recorded attempt; the fallback picks
  // among approved record, and the attempt binds or matches after the pick.
  const ATTEMPT = 'attempt-example-a';

  it('refuses an unbound owner grant resolved without an attempt (CO24g)', async () => {
    const repository = new CoordinationRequestRepositoryAdapter();
    const owner = requestRecord();
    await saveAll(repository, [owner]);
    // KEY0c1a fix round: the seeded approved owner grant carries a signed
    // answer under the ephemeral test signer, self-checked, before the resolve.
    const signer = createSignedDecisionFixture();
    await signer.writeApprovedAnswer(owner);
    await signer.assertApprovedAnswerReadsBackApproved(owner);
    const result = await resolve(repository, {
      projectId: 'project-example',
      actionScope: 'forge:merge-pr',
      expectedHeadSha: HEAD,
    }, signer);
    expect(result).toEqual({ outcome: 'blocked', reason: 'attempt-required' });
  });

  it('does not shadow an owner grant with a newer policy grant', async () => {
    const repository = new CoordinationRequestRepositoryAdapter();
    const ownerB = requestRecord({
      id: 'request-owner-b',
      grantId: 'grant-owner-b',
      expectedHeadSha: HEAD_B,
      decisionRevision: 'decision-example-b',
      grantRecordVersion: 2,
      grantAttemptId: ATTEMPT,
      createdAtIso: NOW_OLDER,
      updatedAtIso: NOW_OLDER,
    });
    await saveAll(repository, [
      ownerB,
      policyGrantRecord({
        id: 'request-policy-a',
        grantId: 'grant-policy-a',
        expectedHeadSha: HEAD_HA,
        createdAtIso: NOW_NEWER,
        updatedAtIso: NOW_NEWER,
      }),
    ]);
    // KEY0c1a: the seeded approved owner grant carries a signed answer under
    // the ephemeral test signer, self-checked against the record's own ids.
    const signerB = createSignedDecisionFixture();
    await signerB.writeApprovedAnswer(ownerB);
    await signerB.assertApprovedAnswerReadsBackApproved(ownerB);

    const atB = await resolve(repository, {
      projectId: 'project-example',
      actionScope: 'forge:merge-pr',
      expectedHeadSha: HEAD_B,
      attemptId: ATTEMPT,
    }, signerB);
    expect(atB).toMatchObject({ outcome: 'authorized', grantId: 'grant-owner-b' });

    const atHa = await resolve(repository, {
      projectId: 'project-example',
      actionScope: 'forge:merge-pr',
      expectedHeadSha: HEAD_HA,
      attemptId: ATTEMPT,
    });
    expect(atHa).toEqual({
      outcome: 'blocked',
      reason: 'no recorded decision authorizes forge:merge-pr for project-example',
    });
  });

  it('does not shadow an owner grant with a cancelled policy grant', async () => {
    const repository = new CoordinationRequestRepositoryAdapter();
    const owner = requestRecord({
      id: 'request-owner',
      grantId: 'grant-owner',
      grantRecordVersion: 2,
      grantAttemptId: ATTEMPT,
      createdAtIso: NOW_OLDER,
      updatedAtIso: NOW_OLDER,
    });
    await saveAll(repository, [
      owner,
      policyGrantRecord({
        id: 'request-policy-cancelled',
        state: 'cancelled',
        grantId: 'grant-policy-cancelled',
        createdAtIso: NOW_NEWER,
        updatedAtIso: NOW_NEWER,
      }),
    ]);
    // KEY0c1a: the seeded approved owner grant carries a signed answer under
    // the ephemeral test signer, self-checked against the record's own ids.
    const signerOwner = createSignedDecisionFixture();
    await signerOwner.writeApprovedAnswer(owner);
    await signerOwner.assertApprovedAnswerReadsBackApproved(owner);

    const result = await resolve(repository, {
      projectId: 'project-example',
      actionScope: 'forge:merge-pr',
      expectedHeadSha: HEAD,
      attemptId: ATTEMPT,
    }, signerOwner);
    expect(result).toMatchObject({ outcome: 'authorized', grantId: 'grant-owner' });
  });

  it('resolves a policy grant only by its id', async () => {
    const repository = new CoordinationRequestRepositoryAdapter();
    await saveAll(repository, [
      policyGrantRecord({
        id: 'request-policy-only',
        grantId: 'grant-policy-only',
      }),
    ]);

    const noId = await resolve(repository, {
      projectId: 'project-example',
      actionScope: 'forge:merge-pr',
      expectedHeadSha: HEAD,
    });
    expect(noId).toEqual({
      outcome: 'blocked',
      reason: 'no recorded decision authorizes forge:merge-pr for project-example',
    });

    const byId = await resolve(repository, {
      projectId: 'project-example',
      actionScope: 'forge:merge-pr',
      expectedHeadSha: HEAD,
      authorizationGrantId: 'grant-policy-only',
    });
    expect(byId).toMatchObject({ outcome: 'authorized', grantId: 'grant-policy-only' });
  });

  it('requires the requested head for an unnamed resolve', async () => {
    const repository = new CoordinationRequestRepositoryAdapter();
    await saveAll(repository, [
      requestRecord({
        id: 'request-owner-h1',
        grantId: 'grant-owner-h1',
        expectedHeadSha: HEAD_B,
      }),
    ]);

    const result = await resolve(repository, {
      projectId: 'project-example',
      actionScope: 'forge:merge-pr',
      expectedHeadSha: HEAD_HA,
    });
    expect(result).toEqual({
      outcome: 'blocked',
      reason: 'no recorded decision authorizes forge:merge-pr for project-example',
    });
  });

  it('skips a malformed policy prefix even without policyGrant', async () => {
    const repository = new CoordinationRequestRepositoryAdapter();
    await saveAll(repository, [
      requestRecord({
        id: 'request-legacy',
        grantId: 'grant-legacy',
        decisionRevision: 'policy:legacy',
      }),
    ]);

    const result = await resolve(repository, {
      projectId: 'project-example',
      actionScope: 'forge:merge-pr',
      expectedHeadSha: HEAD,
    });
    expect(result).toEqual({
      outcome: 'blocked',
      reason: 'no recorded decision authorizes forge:merge-pr for project-example',
    });
  });

  it('keeps the newer owner grant preference at the same head', async () => {
    const repository = new CoordinationRequestRepositoryAdapter();
    const ownerOld = requestRecord({
      id: 'request-owner-old',
      grantId: 'grant-owner-old',
      grantRecordVersion: 2,
      grantAttemptId: ATTEMPT,
      createdAtIso: NOW_OLDER,
      updatedAtIso: NOW_OLDER,
    });
    const ownerNew = requestRecord({
      id: 'request-owner-new',
      grantId: 'grant-owner-new',
      grantRecordVersion: 2,
      grantAttemptId: ATTEMPT,
      createdAtIso: NOW_NEWER,
      updatedAtIso: NOW_NEWER,
    });
    await saveAll(repository, [ownerOld, ownerNew]);
    // KEY0c1a: both seeded approved owner grants carry signed answers under
    // the ephemeral test signer, self-checked against each record's own ids.
    const signerOld = createSignedDecisionFixture();
    await signerOld.writeApprovedAnswer(ownerOld);
    await signerOld.assertApprovedAnswerReadsBackApproved(ownerOld);
    const signerNew = createSignedDecisionFixture();
    await signerNew.writeApprovedAnswer(ownerNew);
    await signerNew.assertApprovedAnswerReadsBackApproved(ownerNew);

    const result = await resolve(repository, {
      projectId: 'project-example',
      actionScope: 'forge:merge-pr',
      expectedHeadSha: HEAD,
      attemptId: ATTEMPT,
    }, signerNew);
    expect(result).toMatchObject({ outcome: 'authorized', grantId: 'grant-owner-new' });
  });

  it('keeps the awaiting-decision block when no approved owner request applies', async () => {
    const repository = new CoordinationRequestRepositoryAdapter();
    await saveAll(repository, [
      requestRecord({
        id: 'request-awaiting',
        state: 'awaiting-decision',
        grantId: null,
      }),
    ]);

    const result = await resolve(repository, {
      projectId: 'project-example',
      actionScope: 'forge:merge-pr',
      expectedHeadSha: HEAD,
    });
    expect(result).toEqual({
      outcome: 'blocked',
      reason: 'recorded request request-awaiting is awaiting-decision, which does not authorize an action',
    });
  });
});
