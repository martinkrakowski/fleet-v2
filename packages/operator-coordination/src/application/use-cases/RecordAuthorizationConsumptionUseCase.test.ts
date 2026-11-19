import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { CoordinationRequestRecord } from '../../domain/coordination-records.js';
import type { CoordinationRequestRepositoryPort } from '../ports/out/CoordinationRequestRepositoryPort.out-port.js';
import type { DecisionAnswer, DecisionTransportPort } from '../ports/out/DecisionTransportPort.out-port.js';
import type { RecordAuthorizationConsumptionResult } from '../ports/in/RecordAuthorizationConsumptionPort.in-port.js';
import { RecordAuthorizationConsumptionUseCase } from './RecordAuthorizationConsumptionUseCase.use-case.js';
import { createSignedDecisionFixture, explicitAnswerTransport } from './__tests__/signed-decision-fixture.js';

class InMemoryCoordinationRequestRepo implements CoordinationRequestRepositoryPort {
  private requests = new Map<string, CoordinationRequestRecord>();

  async saveRequest(record: CoordinationRequestRecord): Promise<void> {
    this.requests.set(record.id, record);
  }

  async findRequestById(requestId: string): Promise<CoordinationRequestRecord | null> {
    return this.requests.get(requestId) ?? null;
  }

  async findRequestByGrantId(grantId: string): Promise<CoordinationRequestRecord | null> {
    for (const req of this.requests.values()) {
      if (req.grantId === grantId) return req;
    }
    return null;
  }

  async listRequests(projectId?: string): Promise<readonly CoordinationRequestRecord[]> {
    const all = Array.from(this.requests.values());
    return projectId ? all.filter((r) => r.projectId === projectId) : all;
  }
}

function makeApprovedGrantRecord(overrides?: Partial<CoordinationRequestRecord>): CoordinationRequestRecord {
  return {
    id: 'req-001',
    projectId: 'proj-alpha',
    kind: 'action-decision',
    state: 'approved',
    actionScope: 'forge:push-and-open-pr',
    expectedHeadSha: '1111111111111111111111111111111111111111',
    proposalDigest: 'sha256-proposal',
    policyRevision: 'pol-rev-1',
    decisionRevision: 'dec-rev-1',
    grantId: 'grant-001',
    consumptions: [],
    acknowledgements: [],
    deliveryStatus: 'delivered',
    deliveryGapReason: null,
    revision: 1,
    createdAtIso: '2026-10-15T10:00:00Z',
    updatedAtIso: '2026-10-15T10:00:00Z',
    ...overrides,
  };
}

describe('RecordAuthorizationConsumptionUseCase (H7)', () => {
  it('refuses when recorded grant actionScope differs from supplied actionScope', async () => {
    const repo = new InMemoryCoordinationRequestRepo();
    await repo.saveRequest(makeApprovedGrantRecord({
      grantId: 'grant-push',
      actionScope: 'forge:push-and-open-pr',
      expectedHeadSha: 'head-H',
    }));

    const useCase = new RecordAuthorizationConsumptionUseCase({ requestRepo: repo });

    const result = await useCase.recordAuthorizationConsumption({
      consumptionId: 'c-1',
      grantId: 'grant-push',
      actionId: 'action-merge',
      actionScope: 'forge:merge-pr',
      attemptId: 'att-1',
      expectedHeadSha: 'head-H',
    });

    expect(result.outcome).toBe('refused');
    if (result.outcome === 'refused') {
      expect(result.reason).toContain('scope forge:push-and-open-pr, not forge:merge-pr');
    }
  });

  it('refuses when expected head commit differs', async () => {
    const repo = new InMemoryCoordinationRequestRepo();
    await repo.saveRequest(makeApprovedGrantRecord({
      grantId: 'grant-push',
      actionScope: 'forge:push-and-open-pr',
      expectedHeadSha: 'head-H',
    }));

    const useCase = new RecordAuthorizationConsumptionUseCase({ requestRepo: repo });

    const result = await useCase.recordAuthorizationConsumption({
      consumptionId: 'c-1',
      grantId: 'grant-push',
      actionId: 'action-push',
      actionScope: 'forge:push-and-open-pr',
      attemptId: 'att-1',
      expectedHeadSha: 'head-DIFFERENT',
    });

    expect(result.outcome).toBe('refused');
    if (result.outcome === 'refused') {
      expect(result.reason).toContain('head-H, not head-DIFFERENT');
    }
  });

  it('successfully consumes when actionScope and head commit match', async () => {
    const repo = new InMemoryCoordinationRequestRepo();
    const record = makeApprovedGrantRecord({
      grantId: 'grant-push',
      actionScope: 'forge:push-and-open-pr',
      expectedHeadSha: 'head-H',
    });
    await repo.saveRequest(record);

    // KEY0c3: the transport is mandatory for owner-gated scopes, so the
    // consumption is seeded with its signed answer.
    const signer = createSignedDecisionFixture();
    await signer.writeApprovedAnswer(record);
    const useCase = new RecordAuthorizationConsumptionUseCase({ requestRepo: repo, ...signer.deps });

    const result = await useCase.recordAuthorizationConsumption({
      consumptionId: 'c-1',
      grantId: 'grant-push',
      actionId: 'action-push',
      actionScope: 'forge:push-and-open-pr',
      attemptId: 'att-1',
      expectedHeadSha: 'head-H',
    });

    expect(result.outcome).toBe('consumed');
    if (result.outcome === 'consumed') {
      expect(result.consumption.actionId).toBe('action-push');
      expect(result.consumption.grantId).toBe('grant-push');
    }
  });

  it('successfully consumes non-forge scope host:restart when supplied scope matches exactly', async () => {
    const repo = new InMemoryCoordinationRequestRepo();
    const record = makeApprovedGrantRecord({
      grantId: 'grant-restart',
      actionScope: 'host:restart',
      expectedHeadSha: 'head-H',
    });
    await repo.saveRequest(record);

    // KEY0c3: owner-gated consumption requires the signed answer.
    const signer = createSignedDecisionFixture();
    await signer.writeApprovedAnswer(record);
    const useCase = new RecordAuthorizationConsumptionUseCase({ requestRepo: repo, ...signer.deps });

    const result = await useCase.recordAuthorizationConsumption({
      consumptionId: 'c-restart',
      grantId: 'grant-restart',
      actionId: 'action-restart',
      actionScope: 'host:restart',
      attemptId: 'att-1',
      expectedHeadSha: 'head-H',
    });

    expect(result.outcome).toBe('consumed');
    if (result.outcome === 'consumed') {
      expect(result.consumption.actionId).toBe('action-restart');
      expect(result.consumption.grantId).toBe('grant-restart');
    }
  });

  it('successfully consumes non-forge scope relay:fleet-master when supplied scope matches exactly', async () => {
    const repo = new InMemoryCoordinationRequestRepo();
    const record = makeApprovedGrantRecord({
      grantId: 'grant-relay',
      actionScope: 'relay:fleet-master',
      expectedHeadSha: 'head-H',
    });
    await repo.saveRequest(record);

    // KEY0c3: owner-gated consumption requires the signed answer.
    const signer = createSignedDecisionFixture();
    await signer.writeApprovedAnswer(record);
    const useCase = new RecordAuthorizationConsumptionUseCase({ requestRepo: repo, ...signer.deps });

    const result = await useCase.recordAuthorizationConsumption({
      consumptionId: 'c-relay',
      grantId: 'grant-relay',
      actionId: 'action-relay',
      actionScope: 'relay:fleet-master',
      attemptId: 'att-1',
      expectedHeadSha: 'head-H',
    });

    expect(result.outcome).toBe('consumed');
    if (result.outcome === 'consumed') {
      expect(result.consumption.actionId).toBe('action-relay');
      expect(result.consumption.grantId).toBe('grant-relay');
    }
  });

  it('refuses non-forge scope when supplied scope differs from recorded scope', async () => {
    const repo = new InMemoryCoordinationRequestRepo();
    await repo.saveRequest(makeApprovedGrantRecord({
      grantId: 'grant-restart',
      actionScope: 'host:restart',
      expectedHeadSha: 'head-H',
    }));

    const useCase = new RecordAuthorizationConsumptionUseCase({ requestRepo: repo });

    const result = await useCase.recordAuthorizationConsumption({
      consumptionId: 'c-restart',
      grantId: 'grant-restart',
      actionId: 'action-restart',
      actionScope: 'host:shutdown',
      attemptId: 'att-1',
      expectedHeadSha: 'head-H',
    });

    expect(result.outcome).toBe('refused');
    if (result.outcome === 'refused') {
      expect(result.reason).toContain('scope host:restart, not host:shutdown');
    }
  });
});

const POLICY_HEAD = 'a'.repeat(40);

describe('RecordAuthorizationConsumptionUseCase attempt binding (CO24d)', () => {
  function policyGrant(attemptId: string): CoordinationRequestRecord {
    return makeApprovedGrantRecord({
      grantId: 'grant-policy',
      actionScope: 'forge:merge-pr',
      expectedHeadSha: POLICY_HEAD,
      decisionRevision: 'policy:autoMerge@309ab8c40bf2',
      policyGrant: { workOrderId: 'wo-1', attemptId, acceptanceReceiptId: 'receipt-1' },
    });
  }

  it('refuses a consumption whose attempt differs from the policy grant attempt and records nothing', async () => {
    const repo = new InMemoryCoordinationRequestRepo();
    await repo.saveRequest(policyGrant('att-A'));
    const useCase = new RecordAuthorizationConsumptionUseCase({ requestRepo: repo });

    const result = await useCase.recordAuthorizationConsumption({
      consumptionId: 'c-1',
      grantId: 'grant-policy',
      actionId: 'action-push',
      actionScope: 'forge:merge-pr',
      attemptId: 'att-B',
      expectedHeadSha: POLICY_HEAD,
    });

    expect(result).toEqual({ outcome: 'refused', reason: 'grant-attempt-mismatch' });
    const stored = await repo.findRequestByGrantId('grant-policy');
    expect(stored?.consumptions).toHaveLength(0);
    expect(stored?.state).toBe('approved');
  });

  it('consumes a policy grant for its own attempt', async () => {
    const repo = new InMemoryCoordinationRequestRepo();
    await repo.saveRequest(policyGrant('att-A'));
    const useCase = new RecordAuthorizationConsumptionUseCase({ requestRepo: repo });

    const result = await useCase.recordAuthorizationConsumption({
      consumptionId: 'c-1',
      grantId: 'grant-policy',
      actionId: 'action-push',
      actionScope: 'forge:merge-pr',
      attemptId: 'att-A',
      expectedHeadSha: POLICY_HEAD,
    });

    expect(result.outcome).toBe('consumed');
  });
});

describe('RecordAuthorizationConsumptionUseCase standing shadow import grant (GR1a1)', () => {
  it('refuses shadow import scope without mutating the standing grant', async () => {
    const repo = new InMemoryCoordinationRequestRepo();
    await repo.saveRequest(
      makeApprovedGrantRecord({
        grantId: 'grant-shadow',
        actionScope: 'merge:import-shadow',
        expectedHeadSha: null,
        shadowImportGrant: {
          repository: { owner: 'octo', repo: 'hello' },
          expiresAtIso: '2026-12-16T00:00:00Z',
        },
      }),
    );
    const useCase = new RecordAuthorizationConsumptionUseCase({ requestRepo: repo });

    const result = await useCase.recordAuthorizationConsumption({
      consumptionId: 'c-1',
      grantId: 'grant-shadow',
      actionId: 'action-import',
      actionScope: 'merge:import-shadow',
      attemptId: 'att-1',
      expectedHeadSha: 'head-H',
    });

    expect(result).toEqual({ outcome: 'refused', reason: 'shadow-import-grant-not-consumable' });
    const stored = await repo.findRequestByGrantId('grant-shadow');
    expect(stored?.state).toBe('approved');
    expect(stored?.consumptions).toHaveLength(0);
    expect(stored?.revision).toBe(1);
  });

  it('refuses a consumption naming the shadow scope even when the recorded scope differs', async () => {
    const repo = new InMemoryCoordinationRequestRepo();
    await repo.saveRequest(
      makeApprovedGrantRecord({
        grantId: 'grant-push',
        actionScope: 'forge:push-and-open-pr',
        expectedHeadSha: 'head-H',
      }),
    );
    const useCase = new RecordAuthorizationConsumptionUseCase({ requestRepo: repo });

    const result = await useCase.recordAuthorizationConsumption({
      consumptionId: 'c-1',
      grantId: 'grant-push',
      actionId: 'action-import',
      actionScope: 'merge:import-shadow',
      attemptId: 'att-1',
      expectedHeadSha: 'head-H',
    });

    expect(result).toEqual({ outcome: 'refused', reason: 'shadow-import-grant-not-consumable' });
    const stored = await repo.findRequestByGrantId('grant-push');
    expect(stored?.state).toBe('approved');
    expect(stored?.consumptions).toHaveLength(0);
  });
});

describe('RecordAuthorizationConsumptionUseCase release grants (RR1)', () => {
  const HEAD = '1111111111111111111111111111111111111111';
  const ROOT = '/srv/fleet/releases';
  const GRANT_ID = 'grant-release';
  const NONCE = '0123456789abcdef0123456789abcdef';

  function digest(payload: string): string {
    return createHash('sha256').update(payload).digest('hex');
  }

  function releaseRequestId(grant: {
    actionScope: string;
    projectId: string;
    expectedHeadSha: string;
    releaseRoot: string;
    nonce: string;
  }): string {
    return `release-grant-${digest(
      JSON.stringify({
        scope: grant.actionScope,
        projectId: grant.projectId,
        expectedHeadSha: grant.expectedHeadSha,
        releaseRoot: grant.releaseRoot,
        nonce: grant.nonce,
      }),
    )}`;
  }

  function createReleaseRecord(overrides?: Partial<CoordinationRequestRecord>): CoordinationRequestRecord {
    return {
      id: releaseRequestId({
        actionScope: 'release:install',
        projectId: 'proj-1',
        expectedHeadSha: HEAD,
        releaseRoot: ROOT,
        nonce: NONCE,
      }),
      projectId: 'proj-1',
      kind: 'action-decision',
      state: 'approved',
      actionScope: 'release:install',
      expectedHeadSha: HEAD,
      proposalDigest: 'sha256-proposal',
      policyRevision: 'pol-rev-1',
      decisionRevision: 'dec-rev-1',
      grantId: GRANT_ID,
      consumptions: [],
      acknowledgements: [],
      deliveryStatus: 'delivered',
      deliveryGapReason: null,
      revision: 1,
      createdAtIso: '2026-11-02T00:00:00.000Z',
      updatedAtIso: '2026-11-02T00:00:00.000Z',
      releaseRoot: ROOT,
      releaseNonce: NONCE,
      ...overrides,
    };
  }

  function consumeRelease(
    useCase: RecordAuthorizationConsumptionUseCase,
    overrides: Record<string, unknown> = {},
  ): Promise<RecordAuthorizationConsumptionResult> {
    return useCase.recordAuthorizationConsumption({
      consumptionId: 'c-1',
      grantId: GRANT_ID,
      actionId: 'action-install-1',
      actionScope: 'release:install',
      attemptId: 'att-1',
      expectedHeadSha: HEAD,
      releaseRoot: ROOT,
      ...overrides,
    } as never);
  }

  it('consumes a digest-bound release record whose root matches', async () => {
    const requestRepo = new InMemoryCoordinationRequestRepo();
    const record = createReleaseRecord();
    await requestRepo.saveRequest(record);
    // KEY0c3: release grants are owner-gated, so the consumption needs the
    // transport and a seeded signed answer.
    const signer = createSignedDecisionFixture();
    await signer.writeApprovedAnswer(record);
    const result = await consumeRelease(
      new RecordAuthorizationConsumptionUseCase({ requestRepo, ...signer.deps, computeDigest: digest }),
    );
    expect(result.outcome).toBe('consumed');
    const stored = await requestRepo.findRequestById(
      releaseRequestId({
        actionScope: 'release:install',
        projectId: 'proj-1',
        expectedHeadSha: HEAD,
        releaseRoot: ROOT,
        nonce: NONCE,
      }),
    );
    expect(stored?.consumptions).toHaveLength(1);
    expect(stored?.consumptions[0]?.actionId).toBe('action-install-1');
  });

  it('refuses a matching root whose stored coordinates no longer hash to the id (tampered)', async () => {
    const requestRepo = new InMemoryCoordinationRequestRepo();
    // The stored root was moved after recording: the request names the same
    // (moved) root, so the root check passes, but the recomputed digest no
    // longer matches the request id the grant is bound by. The idempotent
    // replay return is never reached, so a moved root cannot be excused by an
    // already-recorded receipt.
    await requestRepo.saveRequest(createReleaseRecord({ releaseRoot: '/srv/fleet/moved' }));
    const result = await consumeRelease(
      new RecordAuthorizationConsumptionUseCase({ requestRepo, computeDigest: digest }),
      { releaseRoot: '/srv/fleet/moved' },
    );
    expect(result).toEqual({ outcome: 'refused', reason: 'release-grant-digest-mismatch' });
  });

  it('refuses a record whose nonce was tampered with (the digest recompute no longer matches the id)', async () => {
    const requestRepo = new InMemoryCoordinationRequestRepo();
    await requestRepo.saveRequest(
      createReleaseRecord({ releaseNonce: 'fedcba9876543210fedcba9876543210' }),
    );
    const result = await consumeRelease(
      new RecordAuthorizationConsumptionUseCase({ requestRepo, computeDigest: digest }),
    );
    expect(result).toEqual({ outcome: 'refused', reason: 'release-grant-digest-mismatch' });
  });

  it('fails closed on a release record with a missing or malformed nonce', async () => {
    for (const bad of [undefined, 'short']) {
      const requestRepo = new InMemoryCoordinationRequestRepo();
      await requestRepo.saveRequest(createReleaseRecord({ releaseNonce: bad }));
      const result = await consumeRelease(
        new RecordAuthorizationConsumptionUseCase({ requestRepo, computeDigest: digest }),
      );
      expect(result).toEqual({ outcome: 'refused', reason: 'release-grant-digest-mismatch' });
    }
  });

  it('refuses a pre-RR1 unprefixed release record (unsigned root) even when the root matches', async () => {
    const requestRepo = new InMemoryCoordinationRequestRepo();
    await requestRepo.saveRequest(createReleaseRecord({ id: 'req-unprefixed-1' }));
    const result = await consumeRelease(
      new RecordAuthorizationConsumptionUseCase({ requestRepo, computeDigest: digest }),
    );
    expect(result).toEqual({ outcome: 'refused', reason: 'release-grant-digest-mismatch' });
  });

  it('fails closed with digest-unavailable when the digest is unwired on a release record', async () => {
    const requestRepo = new InMemoryCoordinationRequestRepo();
    await requestRepo.saveRequest(createReleaseRecord());
    const result = await consumeRelease(
      new RecordAuthorizationConsumptionUseCase({ requestRepo }),
    );
    expect(result).toEqual({ outcome: 'refused', reason: 'digest-unavailable' });
  });

  it('still refuses a different root with release-grant-root-mismatch before the digest runs', async () => {
    const requestRepo = new InMemoryCoordinationRequestRepo();
    await requestRepo.saveRequest(createReleaseRecord());
    const result = await consumeRelease(
      new RecordAuthorizationConsumptionUseCase({ requestRepo, computeDigest: digest }),
      { releaseRoot: '/srv/fleet/other' },
    );
    expect(result).toEqual({ outcome: 'refused', reason: 'release-grant-root-mismatch' });
  });

  // RR1 fix round: `releaseRootsAgree` is pinned to exact string equality on
  // the normalized roots. A case-insensitive comparison or a `startsWith`
  // prefix comparison must fail these near-miss cases, not authorize them.
  it.each([
    { recorded: '/srv/rel', requested: '/srv/rel2' },
    { recorded: '/srv/rel2', requested: '/srv/rel' },
    { recorded: '/srv/Rel', requested: '/srv/rel' },
  ])('refuses a near-miss root $recorded vs $requested with release-grant-root-mismatch (no prefix or case folding)', async ({ recorded, requested }) => {
    const requestRepo = new InMemoryCoordinationRequestRepo();
    await requestRepo.saveRequest(createReleaseRecord({ releaseRoot: recorded }));
    const result = await consumeRelease(
      new RecordAuthorizationConsumptionUseCase({ requestRepo, computeDigest: digest }),
      { releaseRoot: requested },
    );
    expect(result).toEqual({ outcome: 'refused', reason: 'release-grant-root-mismatch' });
  });

  // RR1 fix round: the idempotent replay return sits after the digest
  // recompute, so a record whose stored coordinates were tampered with after
  // consumption is refused on replay instead of replaying the receipt.
  it('refuses a replay of an already-consumed release record whose stored root was tampered with after consumption', async () => {
    const requestRepo = new InMemoryCoordinationRequestRepo();
    // The grant was consumed legitimately; afterwards its stored root was
    // moved. The replay carries the same action and consumption ids and names
    // the moved root, so the root check passes, but the recomputed digest no
    // longer matches the id the grant is bound by.
    await requestRepo.saveRequest(
      createReleaseRecord({
        releaseRoot: '/srv/fleet/moved',
        state: 'completed',
        consumptions: [{
          consumptionId: 'c-1',
          grantId: GRANT_ID,
          requestId: 'req-earlier',
          actionId: 'action-install-1',
          attemptId: 'att-1',
          expectedHeadSha: HEAD,
          consumedAtIso: '2026-11-02T00:00:00.000Z',
        }],
      }),
    );
    const result = await consumeRelease(
      new RecordAuthorizationConsumptionUseCase({ requestRepo, computeDigest: digest }),
      { releaseRoot: '/srv/fleet/moved' },
    );
    expect(result).toEqual({ outcome: 'refused', reason: 'release-grant-digest-mismatch' });
  });

  it('refuses a replay of an already-consumed release record whose stored nonce was tampered with after consumption', async () => {
    const requestRepo = new InMemoryCoordinationRequestRepo();
    await requestRepo.saveRequest(
      createReleaseRecord({
        releaseNonce: 'fedcba9876543210fedcba9876543210',
        state: 'completed',
        consumptions: [{
          consumptionId: 'c-1',
          grantId: GRANT_ID,
          requestId: 'req-earlier',
          actionId: 'action-install-1',
          attemptId: 'att-1',
          expectedHeadSha: HEAD,
          consumedAtIso: '2026-11-02T00:00:00.000Z',
        }],
      }),
    );
    const result = await consumeRelease(
      new RecordAuthorizationConsumptionUseCase({ requestRepo, computeDigest: digest }),
    );
    expect(result).toEqual({ outcome: 'refused', reason: 'release-grant-digest-mismatch' });
  });
});

describe('RecordAuthorizationConsumptionUseCase signed re-verification (KEY0c2)', () => {
  const REQUEST = {
    consumptionId: 'consumption-1',
    grantId: 'grant-9',
    actionId: 'action-1',
    actionScope: 'forge:merge',
    attemptId: 'attempt-1',
    expectedHeadSha: 'abc123',
    nowIso: '2026-11-18T01:00:00.000Z',
  };

  function ownerRecord(overrides: Partial<CoordinationRequestRecord> = {}): CoordinationRequestRecord {
    return {
      id: 'request-1',
      projectId: 'project-atlas',
      kind: 'action-decision',
      state: 'approved',
      actionScope: 'forge:merge',
      expectedHeadSha: 'abc123',
      proposalDigest: 'digest-1',
      policyRevision: 'policy-7',
      decisionRevision: 'decision-3',
      grantId: 'grant-9',
      consumptions: [],
      acknowledgements: [],
      deliveryStatus: 'delivered',
      deliveryGapReason: null,
      revision: 1,
      createdAtIso: '2026-11-18T00:00:00.000Z',
      updatedAtIso: '2026-11-18T00:00:00.000Z',
      ...overrides,
    };
  }

  function repositoryWith(...records: CoordinationRequestRecord[]): InMemoryCoordinationRequestRepo {
    const repo = new InMemoryCoordinationRequestRepo();
    for (const record of records) {
      void repo.saveRequest(record);
    }
    return repo;
  }

  function refuseStub(
    answers: Record<
      string,
      { state: 'awaiting-decision' | 'declined'; decisionRevision: string | null; grantId: string | null }
    >,
  ): DecisionTransportPort {
    return {
      async readDecisionAnswer(query) {
        return (
          answers[query.requestId] ?? {
            state: 'awaiting-decision' as const,
            decisionRevision: null,
            grantId: null,
          }
        );
      },
    };
  }

  function transportWith(
    ownerPublicKey: string,
    answers: Record<string, DecisionAnswer>,
    ownerKeyRefusal?: 'owner-key-unpinned' | 'owner-key-env-mismatch',
  ): DecisionTransportPort {
    return explicitAnswerTransport(ownerPublicKey, answers, ownerKeyRefusal);
  }

  it('consumes with valid signed answer', async () => {
    const signer = createSignedDecisionFixture();
    const record = ownerRecord();
    await signer.writeApprovedAnswer(record);
    const result = await new RecordAuthorizationConsumptionUseCase({
      requestRepo: repositoryWith(record),
      decisionTransport: signer.deps.decisionTransport,
    }).recordAuthorizationConsumption(REQUEST);
    expect(result.outcome).toBe('consumed');
  });

  it('refuses hand-written approved record with no answer file', async () => {
    const signer = createSignedDecisionFixture();
    const result = await new RecordAuthorizationConsumptionUseCase({
      requestRepo: repositoryWith(ownerRecord()),
      decisionTransport: transportWith(signer.ownerPublicKey, {}),
    }).recordAuthorizationConsumption(REQUEST);
    expect(result).toEqual({ outcome: 'refused', reason: 'decision-signature-invalid' });
  });

  it('refuses approved owner record when decisionTransport is absent', async () => {
    const result = await new RecordAuthorizationConsumptionUseCase({
      requestRepo: repositoryWith(ownerRecord()),
    }).recordAuthorizationConsumption(REQUEST);
    expect(result).toEqual({ outcome: 'refused', reason: 'decision-signature-invalid' });
  });

  it('surfaces owner-key-unpinned and owner-key-env-mismatch', async () => {
    const signer = createSignedDecisionFixture();
    const answer = signer.signApprovedAnswer(ownerRecord());
    for (const refusal of ['owner-key-unpinned', 'owner-key-env-mismatch'] as const) {
      const result = await new RecordAuthorizationConsumptionUseCase({
        requestRepo: repositoryWith(ownerRecord()),
        decisionTransport: transportWith(signer.ownerPublicKey, { 'request-1': answer }, refusal),
      }).recordAuthorizationConsumption(REQUEST);
      expect(result).toEqual({ outcome: 'refused', reason: refusal });
    }
  });

  it('refuses approved record when answer is signed by a different key', async () => {
    const signer = createSignedDecisionFixture();
    const other = createSignedDecisionFixture();
    const result = await new RecordAuthorizationConsumptionUseCase({
      requestRepo: repositoryWith(ownerRecord()),
      decisionTransport: transportWith(signer.ownerPublicKey, {
        'request-1': other.signApprovedAnswer(ownerRecord()),
      }),
    }).recordAuthorizationConsumption(REQUEST);
    expect(result).toEqual({ outcome: 'refused', reason: 'decision-signature-invalid' });
  });

  it('refuses approved record when answer is for a different request', async () => {
    const signer = createSignedDecisionFixture();
    const result = await new RecordAuthorizationConsumptionUseCase({
      requestRepo: repositoryWith(ownerRecord()),
      decisionTransport: transportWith(signer.ownerPublicKey, {
        'request-1': signer.signApprovedAnswer(ownerRecord({ id: 'request-2' })),
      }),
    }).recordAuthorizationConsumption(REQUEST);
    expect(result).toEqual({ outcome: 'refused', reason: 'decision-signature-invalid' });
  });

  it('refuses when answer grantId or decisionRevision mismatches stored record', async () => {
    const signer = createSignedDecisionFixture();
    for (const mismatched of [
      ownerRecord({ grantId: 'grant-8' }),
      ownerRecord({ decisionRevision: 'decision-4' }),
    ]) {
      const result = await new RecordAuthorizationConsumptionUseCase({
        requestRepo: repositoryWith(ownerRecord()),
        decisionTransport: transportWith(signer.ownerPublicKey, {
          'request-1': signer.signApprovedAnswer(mismatched),
        }),
      }).recordAuthorizationConsumption(REQUEST);
      expect(result).toEqual({ outcome: 'refused', reason: 'decision-signature-invalid' });
    }
  });

  it('refuses when decisionTransport reports awaiting-decision or declined', async () => {
    for (const answer of [
      { state: 'awaiting-decision' as const, decisionRevision: null, grantId: null },
      { state: 'declined' as const, decisionRevision: 'decision-3', grantId: 'grant-9' },
    ]) {
      const result = await new RecordAuthorizationConsumptionUseCase({
        requestRepo: repositoryWith(ownerRecord()),
        decisionTransport: refuseStub({ 'request-1': answer }),
      }).recordAuthorizationConsumption(REQUEST);
      expect(result).toEqual({ outcome: 'refused', reason: 'decision-signature-invalid' });
    }
  });

  it('refuses forged policyGrant on release record before replay or exemption', async () => {
    const forged = ownerRecord({
      actionScope: 'release:install',
      policyGrant: { workOrderId: 'wo-1', attemptId: 'attempt-1', acceptanceReceiptId: 'r-1' },
      consumptions: [
        {
          consumptionId: 'consumption-1',
          grantId: 'grant-9',
          requestId: 'request-1',
          actionId: 'action-1',
          attemptId: 'attempt-1',
          expectedHeadSha: 'abc123',
          consumedAtIso: '2026-11-18T00:30:00.000Z',
        },
      ],
    });
    const signer = createSignedDecisionFixture();
    const result = await new RecordAuthorizationConsumptionUseCase({
      requestRepo: repositoryWith(forged),
      decisionTransport: transportWith(signer.ownerPublicKey, {}),
    }).recordAuthorizationConsumption({ ...REQUEST, actionScope: 'release:install' });
    expect(result).toEqual({ outcome: 'refused', reason: 'invalid-coordination-request' });
  });

  // KEY0c2 fix round 4 mutation gap: moving the idempotent replay return
  // before signature re-verification must be caught. A record that already
  // carries a consumption for exactly the replayed action id is still
  // refused on the replay when no signed answer backs it — the replay return
  // sits after verification.
  it('refuses a replayed consume of an unsigned record that already carries a consumption for the same actionId', async () => {
    const signer = createSignedDecisionFixture();
    const consumed = ownerRecord({
      consumptions: [
        {
          consumptionId: 'consumption-1',
          grantId: 'grant-9',
          requestId: 'request-1',
          actionId: 'action-1',
          attemptId: 'attempt-1',
          expectedHeadSha: 'abc123',
          consumedAtIso: '2026-11-18T00:30:00.000Z',
        },
      ],
    });
    const result = await new RecordAuthorizationConsumptionUseCase({
      requestRepo: repositoryWith(consumed),
      decisionTransport: transportWith(signer.ownerPublicKey, {}),
    }).recordAuthorizationConsumption(REQUEST);
    expect(result).toEqual({ outcome: 'refused', reason: 'decision-signature-invalid' });
  });

  it('keeps policy and merge grants unchanged with and without decisionTransport', async () => {
    const policyHead = 'a'.repeat(40);
    const policyGrant = ownerRecord({
      actionScope: 'forge:merge-pr',
      expectedHeadSha: policyHead,
      decisionRevision: 'policy:autoMerge@0123456789ab',
      policyGrant: { workOrderId: 'wo-1', attemptId: 'attempt-1', acceptanceReceiptId: 'r-1' },
    });
    const signer = createSignedDecisionFixture();
    const result = await new RecordAuthorizationConsumptionUseCase({
      requestRepo: repositoryWith(policyGrant),
      decisionTransport: transportWith(signer.ownerPublicKey, {}),
    }).recordAuthorizationConsumption({
      ...REQUEST,
      actionScope: 'forge:merge-pr',
      expectedHeadSha: policyHead,
    });
    expect(result.outcome).toBe('consumed');
    // KEY0c3: a non-signed scope keeps origin/main behaviour even when the
    // transport is omitted entirely.
    const withoutTransport = await new RecordAuthorizationConsumptionUseCase({
      requestRepo: repositoryWith(policyGrant),
    }).recordAuthorizationConsumption({
      ...REQUEST,
      actionScope: 'forge:merge-pr',
      expectedHeadSha: policyHead,
    });
    expect(withoutTransport.outcome).toBe('consumed');
  });
});
