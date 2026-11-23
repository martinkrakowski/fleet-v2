import { createHash } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import type { CoordinationRequestRecord } from '../../domain/coordination-records.js';
import { SHADOW_IMPORT_ACTION_SCOPE, RELAUNCH_APPLY_DIGEST_PREFIX, relaunchApplyDigestPayload, RELAUNCH_APPLY_ACTION_SCOPE, RELAUNCH_APPLY_GRANT_MAX_TTL_DAYS, RELAUNCH_APPLY_PROJECT_ID } from '../../domain/coordination-records.js';
import type { CoordinationRequestRepositoryPort } from '../ports/out/CoordinationRequestRepositoryPort.out-port.js';
import type { DecisionAnswer, DecisionTransportPort } from '../ports/out/DecisionTransportPort.out-port.js';
import { ResolveActionAuthorizationUseCase } from './ResolveActionAuthorizationUseCase.use-case.js';
import type { ResolveActionAuthorizationResult } from '../ports/in/ResolveActionAuthorizationPort.in-port.js';
import { createSignedDecisionFixture, explicitAnswerTransport } from './__tests__/signed-decision-fixture.js';

class InMemoryCoordinationRequestRepository implements CoordinationRequestRepositoryPort {
  private readonly records = new Map<string, CoordinationRequestRecord>();

  async saveRequest(record: CoordinationRequestRecord): Promise<void> {
    this.records.set(record.id, { ...record });
  }

  async findRequestById(id: string): Promise<CoordinationRequestRecord | null> {
    const found = this.records.get(id);
    return found ? { ...found } : null;
  }

  async findRequestByGrantId(grantId: string): Promise<CoordinationRequestRecord | null> {
    for (const record of this.records.values()) {
      if (record.grantId === grantId) {
        return { ...record };
      }
    }
    return null;
  }

  async listRequests(projectId?: string): Promise<readonly CoordinationRequestRecord[]> {
    const all = Array.from(this.records.values());
    if (projectId === undefined) {
      return all;
    }
    return all.filter((r) => r.projectId === projectId);
  }
}

describe('ResolveActionAuthorizationUseCase', () => {
  const headSha = '1111111111111111111111111111111111111111';

  function createMergeGrantRecord(overrides?: Partial<CoordinationRequestRecord>): CoordinationRequestRecord {
    return {
      id: 'req-1',
      projectId: 'proj-1',
      kind: 'action-decision',
      state: 'approved',
      actionScope: 'forge:merge-pr',
      expectedHeadSha: headSha,
      proposalDigest: 'digest-1',
      policyRevision: 'aaaaaaaaaaaa',
      decisionRevision: 'policy:merge@aaaaaaaaaaaa',
      grantId: 'grant-1',
      consumptions: [],
      acknowledgements: [],
      deliveryStatus: 'delivered',
      deliveryGapReason: null,
      revision: 1,
      createdAtIso: '2026-11-02T00:00:00.000Z',
      updatedAtIso: '2026-11-02T00:00:00.000Z',
      mergeGrant: {
        repository: { owner: 'repo-a-owner', repo: 'repo-a' },
        pullRequestNumber: 1,
      },
      ...overrides,
    };
  }

  function createStandardGrantRecord(overrides?: Partial<CoordinationRequestRecord>): CoordinationRequestRecord {
    return {
      id: 'req-2',
      projectId: 'proj-1',
      kind: 'action-decision',
      state: 'approved',
      actionScope: 'forge:merge-pr',
      expectedHeadSha: headSha,
      proposalDigest: 'digest-2',
      policyRevision: 'p1',
      decisionRevision: 'dec-1',
      grantId: 'grant-2',
      consumptions: [],
      acknowledgements: [],
      deliveryStatus: 'delivered',
      deliveryGapReason: null,
      revision: 1,
      createdAtIso: '2026-11-02T00:00:00.000Z',
      updatedAtIso: '2026-11-02T00:00:00.000Z',
      ...overrides,
    };
  }

  it('authorizes a merge grant when repository and pull request match', async () => {
    const requestRepo = new InMemoryCoordinationRequestRepository();
    const grant = createMergeGrantRecord();
    await requestRepo.saveRequest(grant);

    const useCase = new ResolveActionAuthorizationUseCase({ requestRepo });
    const result = await useCase.resolveActionAuthorization({
      projectId: 'proj-1',
      actionScope: 'forge:merge-pr',
      expectedHeadSha: headSha,
      authorizationGrantId: 'grant-1',
      repository: { owner: 'repo-a-owner', repo: 'repo-a' },
      pullRequestNumber: 1,
    });

    expect(result.outcome).toBe('authorized');
    if (result.outcome === 'authorized') {
      expect(result.grantId).toBe('grant-1');
      expect(result.requestId).toBe('req-1');
    }
  });

  it('refuses to authorize repo B PR 2 with a grant issued for repo A PR 1', async () => {
    const requestRepo = new InMemoryCoordinationRequestRepository();
    const grant = createMergeGrantRecord();
    await requestRepo.saveRequest(grant);

    const useCase = new ResolveActionAuthorizationUseCase({ requestRepo });
    const result = await useCase.resolveActionAuthorization({
      projectId: 'proj-1',
      actionScope: 'forge:merge-pr',
      expectedHeadSha: headSha,
      authorizationGrantId: 'grant-1',
      repository: { owner: 'repo-b-owner', repo: 'repo-b' },
      pullRequestNumber: 2,
    });

    expect(result.outcome).toBe('blocked');
    if (result.outcome === 'blocked') {
      expect(result.reason).toContain('grant grant-1 authorizes repo-a-owner/repo-a pull request 1');
    }
  });

  it('refuses a merge grant when repository or pull request is missing from request', async () => {
    const requestRepo = new InMemoryCoordinationRequestRepository();
    const grant = createMergeGrantRecord();
    await requestRepo.saveRequest(grant);

    const useCase = new ResolveActionAuthorizationUseCase({ requestRepo });
    const result = await useCase.resolveActionAuthorization({
      projectId: 'proj-1',
      actionScope: 'forge:merge-pr',
      expectedHeadSha: headSha,
      authorizationGrantId: 'grant-1',
    });

    expect(result.outcome).toBe('blocked');
  });

  it('authorizes a bound owner grant resolved by its id with its attempt', async () => {
    const requestRepo = new InMemoryCoordinationRequestRepository();
    const grant = createStandardGrantRecord({ grantRecordVersion: 2, grantAttemptId: 'att-2' });
    await requestRepo.saveRequest(grant);

    // KEY0c3: the transport is mandatory for owner-gated scopes, so the
    // owner grant is seeded with its own signed answer.
    const signer = createSignedDecisionFixture();
    await signer.writeApprovedAnswer(grant);
    const useCase = new ResolveActionAuthorizationUseCase({ requestRepo, ...signer.deps });
    const result = await useCase.resolveActionAuthorization({
      projectId: 'proj-1',
      actionScope: 'forge:merge-pr',
      expectedHeadSha: headSha,
      authorizationGrantId: 'grant-2',
      attemptId: 'att-2',
    });

    expect(result.outcome).toBe('authorized');
    if (result.outcome === 'authorized') {
      expect(result.grantId).toBe('grant-2');
    }
  });

  it('refuses an unbound owner grant resolved by its id without an attempt (CO24g)', async () => {
    const requestRepo = new InMemoryCoordinationRequestRepository();
    const grant = createStandardGrantRecord();
    await requestRepo.saveRequest(grant);

    // KEY0c3: with the mandatory transport and a valid signed answer, the
    // signature check passes and the attempt rule refuses on its own terms.
    const signer = createSignedDecisionFixture();
    await signer.writeApprovedAnswer(grant);
    const useCase = new ResolveActionAuthorizationUseCase({ requestRepo, ...signer.deps });
    const result = await useCase.resolveActionAuthorization({
      projectId: 'proj-1',
      actionScope: 'forge:merge-pr',
      expectedHeadSha: headSha,
      authorizationGrantId: 'grant-2',
    });

    expect(result).toEqual({ outcome: 'blocked', reason: 'attempt-required' });
  });

  it('matches merge coordinates when resolving recorded request by grant id', async () => {
    const requestRepo = new InMemoryCoordinationRequestRepository();
    const grant = createMergeGrantRecord();
    await requestRepo.saveRequest(grant);

    const useCase = new ResolveActionAuthorizationUseCase({ requestRepo });
    // A merge grant is skipped by the no-id resolve rule (its decision
    // revision is policy-prefixed), so it resolves only by its grant id.
    const resultMatch = await useCase.resolveActionAuthorization({
      projectId: 'proj-1',
      actionScope: 'forge:merge-pr',
      expectedHeadSha: headSha,
      authorizationGrantId: 'grant-1',
      repository: { owner: 'repo-a-owner', repo: 'repo-a' },
      pullRequestNumber: 1,
    });
    expect(resultMatch.outcome).toBe('authorized');

    const resultMismatch = await useCase.resolveActionAuthorization({
      projectId: 'proj-1',
      actionScope: 'forge:merge-pr',
      expectedHeadSha: headSha,
      authorizationGrantId: 'grant-1',
      repository: { owner: 'repo-b-owner', repo: 'repo-b' },
      pullRequestNumber: 2,
    });
    expect(resultMismatch.outcome).toBe('blocked');
  });

  it('blocks, without throwing, when the repository coordinates are not strings', async () => {
    const requestRepo = new InMemoryCoordinationRequestRepository();
    await requestRepo.saveRequest(createMergeGrantRecord());
    const useCase = new ResolveActionAuthorizationUseCase({ requestRepo });
    const result = await useCase.resolveActionAuthorization({
      projectId: 'proj-1',
      actionScope: 'forge:merge-pr',
      expectedHeadSha: headSha,
      authorizationGrantId: 'grant-1',
      repository: { owner: 123, repo: 'repo-a' } as unknown as { owner: string; repo: string },
      pullRequestNumber: 1,
    });
    expect(result.outcome).toBe('blocked');
  });
});

describe('ResolveActionAuthorizationUseCase shadow import resolve (GR1a2)', () => {
  const NOW_ISO = '2026-11-18T00:00:00Z';
  // 28 days after NOW_ISO: inside the 30-day TTL cap.
  const EXPIRES_AT_ISO = '2026-12-16T00:00:00Z';
  const OWNER = 'octo';
  const REPO = 'hello';
  const GRANT_ID = 'grant-shadow';

  // KEY0c3: the transport is wired per test; no describe-level signer is
  // shared, so answers never leak between tests.

  function digest(payload: string): string {
    return createHash('sha256').update(payload).digest('hex');
  }

  const REQUEST_ID = `shadow-import-${digest(
    JSON.stringify({ scope: SHADOW_IMPORT_ACTION_SCOPE, owner: OWNER, repo: REPO, expiresAtIso: EXPIRES_AT_ISO }),
  )}`;

  function createShadowGrantRecord(overrides?: Partial<CoordinationRequestRecord>): CoordinationRequestRecord {
    return {
      id: REQUEST_ID,
      projectId: 'proj-1',
      kind: 'action-decision',
      state: 'approved',
      actionScope: SHADOW_IMPORT_ACTION_SCOPE,
      expectedHeadSha: null,
      proposalDigest: 'sha256-proposal',
      policyRevision: 'pol-rev-1',
      decisionRevision: 'dec-rev-1',
      grantId: GRANT_ID,
      consumptions: [],
      acknowledgements: [],
      deliveryStatus: 'delivered',
      deliveryGapReason: null,
      revision: 1,
      createdAtIso: NOW_ISO,
      updatedAtIso: NOW_ISO,
      shadowImportGrant: { repository: { owner: OWNER, repo: REPO }, expiresAtIso: EXPIRES_AT_ISO },
      ...overrides,
    };
  }

  // KEY0c3: `shadowUseCase` wires the decision transport only when a test
  // passes one, so each test owns its own signed answers.
  function shadowUseCase(
    requestRepo: InMemoryCoordinationRequestRepository,
    overrides: {
      computeDigest?: ((payload: string) => string) | null;
      clock?: { readonly nowIso: () => string } | null;
      transport?: DecisionTransportPort;
    } = {},
  ): ResolveActionAuthorizationUseCase {
    // Defaults are the wired composition: the digest and the trusted clock.
    // `null` unwires either, for the fail-closed tests.
    return new ResolveActionAuthorizationUseCase({
      requestRepo,
      ...(overrides.transport !== undefined ? { decisionTransport: overrides.transport } : {}),
      ...(overrides.computeDigest === null ? {} : { computeDigest: overrides.computeDigest ?? digest }),
      ...(overrides.clock === null ? {} : { shadowImportClock: overrides.clock ?? { nowIso: () => NOW_ISO } }),
    });
  }

  function resolve(
    useCase: ResolveActionAuthorizationUseCase,
    overrides: Record<string, unknown> = {},
  ): Promise<ResolveActionAuthorizationResult> {
    return useCase.resolveActionAuthorization({
      projectId: 'proj-1',
      actionScope: SHADOW_IMPORT_ACTION_SCOPE,
      authorizationGrantId: GRANT_ID,
      repository: { owner: OWNER, repo: REPO },
      ...overrides,
    } as never);
  }

  it('authorizes a standing grant head-free and never binds an attempt', async () => {
    const requestRepo = new InMemoryCoordinationRequestRepository();
    const record = createShadowGrantRecord();
    await requestRepo.saveRequest(record);
    // KEY0c3: the transport is mandatory, so the authorized resolve is wired
    // with a signer whose approved answer is seeded for this record.
    const signer = createSignedDecisionFixture();
    await signer.writeApprovedAnswer(record);
    const result = await resolve(shadowUseCase(requestRepo, { transport: signer.deps.decisionTransport }));
    expect(result).toEqual({
      outcome: 'authorized',
      grantId: GRANT_ID,
      requestId: REQUEST_ID,
      expectedHeadSha: '',
      policyRevision: 'pol-rev-1',
    });
    // An authorized resolve consumes nothing and binds no attempt: the stored
    // record is exactly the one the fixture saved — same revision, no
    // `grantAttemptId` key at all, no consumptions.
    const stored = await requestRepo.findRequestById(REQUEST_ID);
    expect(stored).toEqual(record);
    expect(stored).not.toHaveProperty('grantAttemptId');
    expect(stored).toMatchObject({ revision: 1, consumptions: [] });
  });

  it('blocks with project-id-required on an empty projectId (never Not implemented)', async () => {
    const requestRepo = new InMemoryCoordinationRequestRepository();
    await requestRepo.saveRequest(createShadowGrantRecord());
    const result = await resolve(shadowUseCase(requestRepo), { projectId: '   ' });
    expect(result).toEqual({ outcome: 'blocked', reason: 'project-id-required' });
  });

  it('blocks with grant-missing when the grant id is absent or unknown', async () => {
    const requestRepo = new InMemoryCoordinationRequestRepository();
    await requestRepo.saveRequest(createShadowGrantRecord());
    const missingId = await resolve(shadowUseCase(requestRepo), { authorizationGrantId: undefined });
    expect(missingId).toEqual({ outcome: 'blocked', reason: 'grant-missing' });
    const unknown = await resolve(shadowUseCase(requestRepo), { authorizationGrantId: 'grant-unknown' });
    expect(unknown).toEqual({ outcome: 'blocked', reason: 'grant-missing' });
  });

  it('blocks with grant-wrong-repository on invalid repository coordinates', async () => {
    const requestRepo = new InMemoryCoordinationRequestRepository();
    await requestRepo.saveRequest(createShadowGrantRecord());
    const invalid = await resolve(shadowUseCase(requestRepo), { repository: 'no-segment' });
    expect(invalid).toEqual({ outcome: 'blocked', reason: 'grant-wrong-repository' });
    const mismatch = await resolve(shadowUseCase(requestRepo), {
      repository: { owner: 'other', repo: REPO },
    });
    expect(mismatch).toEqual({ outcome: 'blocked', reason: 'grant-wrong-repository' });
  });

  it('fails closed with clock-unavailable when the shadow clock is unwired', async () => {
    const requestRepo = new InMemoryCoordinationRequestRepository();
    await requestRepo.saveRequest(createShadowGrantRecord());
    const result = await resolve(
      new ResolveActionAuthorizationUseCase({ requestRepo, computeDigest: digest }),
    );
    expect(result).toEqual({ outcome: 'blocked', reason: 'clock-unavailable' });
  });

  it('blocks with invalid-now-iso when the clock reads an unparseable instant', async () => {
    const requestRepo = new InMemoryCoordinationRequestRepository();
    await requestRepo.saveRequest(createShadowGrantRecord());
    const result = await resolve(
      shadowUseCase(requestRepo, { clock: { nowIso: () => 'not-an-instant' } }),
    );
    expect(result).toEqual({ outcome: 'blocked', reason: 'invalid-now-iso' });
  });

  it('fails closed with digest-unavailable when the digest is unwired', async () => {
    const requestRepo = new InMemoryCoordinationRequestRepository();
    await requestRepo.saveRequest(createShadowGrantRecord());
    const result = await resolve(
      new ResolveActionAuthorizationUseCase({
        requestRepo,
        shadowImportClock: { nowIso: () => NOW_ISO },
      }),
    );
    expect(result).toEqual({ outcome: 'blocked', reason: 'digest-unavailable' });
  });

  it('blocks with grant-digest-mismatch when the stored coordinates no longer match the id', async () => {
    const requestRepo = new InMemoryCoordinationRequestRepository();
    // The grant's expiry moved after recording: the recomputed digest of the
    // stored coordinates no longer matches the request id it is bound by.
    await requestRepo.saveRequest(
      createShadowGrantRecord({
        shadowImportGrant: {
          repository: { owner: OWNER, repo: REPO },
          expiresAtIso: '2026-12-20T00:00:00Z',
        },
      }),
    );
    const result = await resolve(shadowUseCase(requestRepo));
    expect(result).toEqual({ outcome: 'blocked', reason: 'grant-digest-mismatch' });
  });

  it('blocks with grant-not-approved for an unanswered or declined request', async () => {
    const requestRepo = new InMemoryCoordinationRequestRepository();
    await requestRepo.saveRequest(
      createShadowGrantRecord({ state: 'awaiting-decision', decisionRevision: null }),
    );
    const unanswered = await resolve(shadowUseCase(requestRepo));
    expect(unanswered).toEqual({ outcome: 'blocked', reason: 'grant-not-approved' });
    await requestRepo.saveRequest(createShadowGrantRecord({ state: 'declined' }));
    const declined = await resolve(shadowUseCase(requestRepo));
    expect(declined).toEqual({ outcome: 'blocked', reason: 'grant-not-approved' });
  });

  it('blocks with grant-revoked for a cancelled grant', async () => {
    const requestRepo = new InMemoryCoordinationRequestRepository();
    await requestRepo.saveRequest(createShadowGrantRecord({ state: 'cancelled' }));
    const result = await resolve(shadowUseCase(requestRepo));
    expect(result).toEqual({ outcome: 'blocked', reason: 'grant-revoked' });
  });

  it('blocks with grant-wrong-scope when the recorded request is not a shadow import', async () => {
    const requestRepo = new InMemoryCoordinationRequestRepository();
    await requestRepo.saveRequest(
      createShadowGrantRecord({ actionScope: 'forge:merge-pr', expectedHeadSha: 'a'.repeat(40) }),
    );
    const result = await resolve(shadowUseCase(requestRepo));
    expect(result).toEqual({ outcome: 'blocked', reason: 'grant-wrong-scope' });
  });

  it('blocks with grant-wrong-project on a project mismatch', async () => {
    const requestRepo = new InMemoryCoordinationRequestRepository();
    await requestRepo.saveRequest(createShadowGrantRecord());
    const result = await resolve(shadowUseCase(requestRepo), { projectId: 'proj-other' });
    expect(result).toEqual({ outcome: 'blocked', reason: 'grant-wrong-project' });
  });

  it('blocks with grant-expired once the clock passes the expiry', async () => {
    const requestRepo = new InMemoryCoordinationRequestRepository();
    await requestRepo.saveRequest(createShadowGrantRecord());
    const afterExpiry = await resolve(
      shadowUseCase(requestRepo, { clock: { nowIso: () => '2026-12-16T00:00:00.001Z' } }),
    );
    expect(afterExpiry).toEqual({ outcome: 'blocked', reason: 'grant-expired' });
    // A backdated nowIso on the request cannot revive the expired grant: the
    // request field is ignored and the clock alone decides.
    const revived = await resolve(shadowUseCase(requestRepo, { clock: { nowIso: () => '2026-12-16T00:00:00.001Z' } }), {
      nowIso: '2026-11-18T00:00:00Z',
    });
    expect(revived).toEqual({ outcome: 'blocked', reason: 'grant-expired' });
  });

  it('keeps every non-shadow path on main behaviour', async () => {
    const requestRepo = new InMemoryCoordinationRequestRepository();
    await requestRepo.saveRequest({
      id: 'req-merge-1',
      projectId: 'proj-1',
      kind: 'action-decision',
      state: 'approved',
      actionScope: 'forge:merge-pr',
      expectedHeadSha: '1111111111111111111111111111111111111111',
      proposalDigest: 'digest-1',
      policyRevision: 'aaaaaaaaaaaa',
      decisionRevision: 'policy:merge@aaaaaaaaaaaa',
      grantId: 'grant-merge-1',
      consumptions: [],
      acknowledgements: [],
      deliveryStatus: 'delivered',
      deliveryGapReason: null,
      revision: 1,
      createdAtIso: '2026-11-02T00:00:00.000Z',
      updatedAtIso: '2026-11-02T00:00:00.000Z',
      mergeGrant: {
        repository: { owner: 'repo-a-owner', repo: 'repo-a' },
        pullRequestNumber: 1,
      },
    });
    const useCase = new ResolveActionAuthorizationUseCase({ requestRepo });
    const result = await useCase.resolveActionAuthorization({
      projectId: 'proj-1',
      actionScope: 'forge:merge-pr',
      expectedHeadSha: '1111111111111111111111111111111111111111',
      authorizationGrantId: 'grant-merge-1',
      repository: { owner: 'repo-a-owner', repo: 'repo-a' },
      pullRequestNumber: 1,
    });
    expect(result.outcome).toBe('authorized');
  });

  it('never resolves a non-shadow scope head-free (main throws for a missing head, GR1a2 fix round)', async () => {
    const requestRepo = new InMemoryCoordinationRequestRepository();
    await requestRepo.saveRequest(
      createShadowGrantRecord({
        actionScope: 'host:restart',
        expectedHeadSha: 'b'.repeat(40),
      }),
    );
    // A non-shadow scope invoked without an expected head keeps main's exact
    // behaviour: the head-free path is the shadow import scope's alone. If it
    // were made unconditional, this resolve would come back as a typed
    // blocked result (or authorize) instead of throwing.
    await expect(
      resolve(shadowUseCase(requestRepo), {
        actionScope: 'host:restart',
      }),
    ).rejects.toThrow('Not implemented: ResolveActionAuthorizationUseCase');
  });
});

describe('ResolveActionAuthorizationUseCase shadow resolve hostile input (GR1a2)', () => {
  const NOW_ISO = '2026-11-18T00:00:00Z';
  const EXPIRES_AT_ISO = '2026-12-16T00:00:00Z';
  const GRANT_ID = 'grant-shadow';

  // KEY0c3: the ephemeral signer whose transport the use case is wired with;
  // the approved answer for the standing grant is seeded in `beforeAll`.
  const hostileShadowSigner = createSignedDecisionFixture();

  beforeAll(async () => {
    await hostileShadowSigner.writeApprovedAnswer({
      id: REQUEST_ID,
      projectId: 'proj-1',
      actionScope: SHADOW_IMPORT_ACTION_SCOPE,
      expectedHeadSha: null,
      decisionRevision: 'dec-rev-1',
      grantId: GRANT_ID,
    });
  });

  function digest(payload: string): string {
    return createHash('sha256').update(payload).digest('hex');
  }
  const REQUEST_ID = `shadow-import-${digest(
    JSON.stringify({ scope: SHADOW_IMPORT_ACTION_SCOPE, owner: 'octo', repo: 'hello', expiresAtIso: EXPIRES_AT_ISO }),
  )}`;

  function seededRepo(): InMemoryCoordinationRequestRepository {
    const requestRepo = new InMemoryCoordinationRequestRepository();
    void requestRepo.saveRequest({
      id: REQUEST_ID,
      projectId: 'proj-1',
      kind: 'action-decision',
      state: 'approved',
      actionScope: SHADOW_IMPORT_ACTION_SCOPE,
      expectedHeadSha: null,
      proposalDigest: 'sha256-proposal',
      policyRevision: 'pol-rev-1',
      decisionRevision: 'dec-rev-1',
      grantId: GRANT_ID,
      consumptions: [],
      acknowledgements: [],
      deliveryStatus: 'delivered',
      deliveryGapReason: null,
      revision: 1,
      createdAtIso: NOW_ISO,
      updatedAtIso: NOW_ISO,
      shadowImportGrant: { repository: { owner: 'octo', repo: 'hello' }, expiresAtIso: EXPIRES_AT_ISO },
    });
    return requestRepo;
  }

  function useCase(requestRepo: InMemoryCoordinationRequestRepository): ResolveActionAuthorizationUseCase {
    return new ResolveActionAuthorizationUseCase({
      requestRepo,
      ...hostileShadowSigner.deps,
      computeDigest: digest,
      shadowImportClock: { nowIso: () => NOW_ISO },
    });
  }

  function resolveRaw(
    shadowUseCase: ResolveActionAuthorizationUseCase,
    input: unknown,
  ): Promise<ResolveActionAuthorizationResult> {
    return shadowUseCase.resolveActionAuthorization(input as never);
  }

  function validRequest(): Record<string, unknown> {
    return {
      projectId: 'proj-1',
      actionScope: SHADOW_IMPORT_ACTION_SCOPE,
      authorizationGrantId: GRANT_ID,
      repository: { owner: 'octo', repo: 'hello' },
    };
  }

  it('authorizes a Proxy over a valid request exactly like the plain data', async () => {
    const requestRepo = seededRepo();
    let gets = 0;
    const proxy = new Proxy(validRequest(), {
      get(target, key, receiver) {
        gets += 1;
        return Reflect.get(target, key, receiver);
      },
    });
    const result = await resolveRaw(useCase(requestRepo), proxy);
    // A plain-data proxy yields exactly the plain data's result, and the
    // `get` trap count is pinned: the resolve must read the request only
    // through its own snapshot, so no `get` trap runs at all.
    expect(gets).toBe(0);
    expect(result).toEqual({
      outcome: 'authorized',
      grantId: GRANT_ID,
      requestId: REQUEST_ID,
      expectedHeadSha: '',
      policyRevision: 'pol-rev-1',
    });
  });

  it('refuses an accessor on projectId as invalid-request before any field is read', async () => {
    const requestRepo = seededRepo();
    let calls = 0;
    const hostile = { ...validRequest() };
    Object.defineProperty(hostile, 'projectId', {
      get() {
        calls += 1;
        throw new Error('hostile getter ran');
      },
      enumerable: true,
    });
    const result = await resolveRaw(useCase(requestRepo), hostile);
    // BL02g fix round: the accessor is refused through its own descriptor via
    // the one shared helper before ANY field — projectId included — is read,
    // so the shadow path is never reached and the getter never ran.
    expect(result).toEqual({ outcome: 'blocked', reason: 'invalid-request' });
    expect(calls).toBe(0);
  });

  it('never runs an accessor on actionScope and refuses the request as invalid-request', async () => {
    const requestRepo = seededRepo();
    let calls = 0;
    const hostile = { ...validRequest() };
    Object.defineProperty(hostile, 'actionScope', {
      get() {
        calls += 1;
        throw new Error('hostile actionScope getter ran');
      },
      enumerable: true,
    });
    const result = await resolveRaw(useCase(requestRepo), hostile);
    // The routing field itself is snapshotted before it is read: the accessor
    // is visible through its own descriptor (which runs no getter), so the
    // request is refused without ever calling the getter.
    expect(result).toEqual({ outcome: 'blocked', reason: 'invalid-request' });
    expect(calls).toBe(0);
  });

  it('never runs an accessor on repository.owner and refuses the repository', async () => {
    const requestRepo = seededRepo();
    let calls = 0;
    const repository: Record<string, unknown> = { owner: 'octo', repo: 'hello' };
    Object.defineProperty(repository, 'owner', {
      get() {
        calls += 1;
        throw new Error('hostile repository.owner getter ran');
      },
      enumerable: true,
    });
    const hostile = { ...validRequest(), repository };
    const result = await resolveRaw(useCase(requestRepo), hostile);
    // The nested repository is snapshotted with own data descriptors before
    // resolveTargetRepository runs, so the accessor never fires and the
    // snapshot's undefined owner is a typed repository refusal.
    expect(result).toEqual({ outcome: 'blocked', reason: 'grant-wrong-repository' });
    expect(calls).toBe(0);
  });

  it('refuses an own __proto__ key on a shadow resolve request as invalid-request without polluting Object.prototype', async () => {
    const requestRepo = seededRepo();
    const hostile = JSON.parse(
      `{"projectId":"proj-1","actionScope":"${SHADOW_IMPORT_ACTION_SCOPE}","authorizationGrantId":"${GRANT_ID}","repository":{"owner":"octo","repo":"hello"},"__proto__":{"polluted":true}}`,
    ) as Record<string, unknown>;
    const result = await resolveRaw(useCase(requestRepo), hostile);
    expect(result).toEqual({ outcome: 'blocked', reason: 'invalid-request' });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('refuses a hostile Proxy request as invalid-request without throwing', async () => {
    const requestRepo = seededRepo();
    const proxy = new Proxy(validRequest(), {
      get() {
        throw new Error('hostile proxy');
      },
      getOwnPropertyDescriptor() {
        throw new Error('hostile proxy descriptor');
      },
    });
    const result = await resolveRaw(useCase(requestRepo), proxy);
    expect(result).toEqual({ outcome: 'blocked', reason: 'invalid-request' });
  });

  it('treats a wrong-primitive request field as missing rather than throwing', async () => {
    const requestRepo = seededRepo();
    const result = await resolveRaw(useCase(requestRepo), {
      ...validRequest(),
      projectId: 7,
    });
    expect(result).toEqual({ outcome: 'blocked', reason: 'project-id-required' });
  });

  // Fix round 1 (run-01M7TWG5VV9RJPWEPT9GQWKNEG): the exported boundary never
  // throws on a malformed non-object input — null, undefined, or a wrong
  // primitive where a request object is due are typed `invalid-request`
  // refusals, never exceptions.
  it('returns a typed invalid-request refusal for a null request instead of throwing', async () => {
    const requestRepo = seededRepo();
    const result = await resolveRaw(useCase(requestRepo), null);
    expect(result).toEqual({ outcome: 'blocked', reason: 'invalid-request' });
  });

  it('returns a typed invalid-request refusal for an undefined request instead of throwing', async () => {
    const requestRepo = seededRepo();
    const result = await resolveRaw(useCase(requestRepo), undefined);
    expect(result).toEqual({ outcome: 'blocked', reason: 'invalid-request' });
  });

  it('returns a typed invalid-request refusal for a primitive where a request object is due', async () => {
    const requestRepo = seededRepo();
    const result = await resolveRaw(useCase(requestRepo), 42);
    expect(result).toEqual({ outcome: 'blocked', reason: 'invalid-request' });
  });

  it('keeps main throw on missing required fields of a well-formed object (preserved behaviour)', async () => {
    const requestRepo = seededRepo();
    // The fix covers only malformed non-object inputs. A well-formed object
    // missing its required fields keeps main's exact throw (CO14b brief,
    // preserved behaviour).
    await expect(
      resolveRaw(useCase(requestRepo), { projectId: 'proj-1', actionScope: 'host:restart' }),
    ).rejects.toThrow('Not implemented: ResolveActionAuthorizationUseCase');
  });

  // Fix round 2 (run-01M7TWG5VV9RJPWEPT9GQWKNEG): the NON-shadow validation
  // reads the descriptor-safe snapshot values, never the original request, so
  // a throwing getter cannot escape as an exception and a Proxy `get` trap
  // never runs for the validation.
  function nonShadowRequest(): Record<string, unknown> {
    return {
      projectId: 'proj-1',
      actionScope: 'forge:merge-pr',
      expectedHeadSha: '1111111111111111111111111111111111111111',
      authorizationGrantId: 'grant-1',
      repository: { owner: 'repo-a-owner', repo: 'repo-a' },
      pullRequestNumber: 1,
    };
  }

  function nonShadowRepo(): InMemoryCoordinationRequestRepository {
    const requestRepo = new InMemoryCoordinationRequestRepository();
    requestRepo.saveRequest({
      id: 'req-1',
      projectId: 'proj-1',
      kind: 'action-decision',
      state: 'approved',
      actionScope: 'forge:merge-pr',
      expectedHeadSha: '1111111111111111111111111111111111111111',
      proposalDigest: 'digest-1',
      policyRevision: 'aaaaaaaaaaaa',
      decisionRevision: 'policy:merge@aaaaaaaaaaaa',
      grantId: 'grant-1',
      consumptions: [],
      acknowledgements: [],
      deliveryStatus: 'delivered',
      deliveryGapReason: null,
      revision: 1,
      createdAtIso: '2026-11-02T00:00:00.000Z',
      updatedAtIso: '2026-11-02T00:00:00.000Z',
      mergeGrant: {
        repository: { owner: 'repo-a-owner', repo: 'repo-a' },
        pullRequestNumber: 1,
      },
    });
    return requestRepo;
  }

  it('never runs a hostile projectId getter on a non-shadow request and refuses it as invalid-request', async () => {
    let calls = 0;
    const hostile = { ...nonShadowRequest() };
    Object.defineProperty(hostile, 'projectId', {
      get() {
        calls += 1;
        throw new Error('hostile projectId getter ran');
      },
      enumerable: true,
    });
    const result = await resolveRaw(useCase(nonShadowRepo()), hostile);
    // The accessor is refused through its own descriptor, which never runs
    // the getter, and the validation reads the descriptor value only.
    expect(result).toEqual({ outcome: 'blocked', reason: 'invalid-request' });
    expect(calls).toBe(0);
  });

  it('never runs a hostile expectedHeadSha getter on a non-shadow request and refuses it as invalid-request', async () => {
    let calls = 0;
    const hostile = { ...nonShadowRequest() };
    Object.defineProperty(hostile, 'expectedHeadSha', {
      get() {
        calls += 1;
        throw new Error('hostile expectedHeadSha getter ran');
      },
      enumerable: true,
    });
    const result = await resolveRaw(useCase(nonShadowRepo()), hostile);
    expect(result).toEqual({ outcome: 'blocked', reason: 'invalid-request' });
    expect(calls).toBe(0);
  });

  // BL02g fix round: a setter-only own accessor on a snapshotted field
  // snapshots to `undefined` exactly like an omitted field, so it must be
  // refused as invalid-request through its own descriptor (which never runs
  // the setter) instead of surviving to the missing-required-field throw.
  it('refuses a setter-only projectId accessor as invalid-request without running the setter', async () => {
    let calls = 0;
    const hostile = { ...nonShadowRequest() };
    Object.defineProperty(hostile, 'projectId', {
      set() {
        calls += 1;
        throw new Error('hostile projectId setter ran');
      },
      enumerable: true,
    });
    const result = await resolveRaw(useCase(nonShadowRepo()), hostile);
    expect(result).toEqual({ outcome: 'blocked', reason: 'invalid-request' });
    expect(calls).toBe(0);
  });

  it('refuses a setter-only actionScope accessor as invalid-request without running the setter', async () => {
    let calls = 0;
    const hostile = { ...nonShadowRequest() };
    Object.defineProperty(hostile, 'actionScope', {
      set() {
        calls += 1;
        throw new Error('hostile actionScope setter ran');
      },
      enumerable: true,
    });
    const result = await resolveRaw(useCase(nonShadowRepo()), hostile);
    expect(result).toEqual({ outcome: 'blocked', reason: 'invalid-request' });
    expect(calls).toBe(0);
  });

  // BL02g fix round: EVERY snapshotted field — required or optional — goes
  // through the one shared descriptor helper, so ANY own accessor (a getter
  // OR a setter) on ANY field the snapshot copies is refused as
  // invalid-request before any grant lookup runs. A set-only accessor
  // snapshots to `undefined` exactly like an omitted field, so without the
  // shared refusal a release retry carrying a setter-only `resumeActionId`
  // could skip its resumable grant and fall through to an unrelated approved
  // grant.
  const SNAPSHOTTED_FIELDS = [
    'projectId',
    'actionScope',
    'expectedHeadSha',
    'authorizationGrantId',
    'attemptId',
    'releaseRoot',
    'resumeActionId',
    'repository',
    'pullRequestNumber',
  ] as const;

  const ACCESSOR_KINDS = ['getter-only', 'setter-only', 'getter+setter'] as const;

  function requestWithAccessor(
    field: (typeof SNAPSHOTTED_FIELDS)[number],
    kind: (typeof ACCESSOR_KINDS)[number],
  ): Record<string, unknown> {
    const hostile = { ...nonShadowRequest() };
    Object.defineProperty(hostile, field, {
      ...(kind !== 'setter-only'
        ? {
            get() {
              throw new Error(`hostile ${field} getter ran`);
            },
          }
        : {}),
      ...(kind !== 'getter-only'
        ? {
            set() {
              throw new Error(`hostile ${field} setter ran`);
            },
          }
        : {}),
      enumerable: true,
    });
    return hostile;
  }

  function countingRepo(): { repo: CoordinationRequestRepositoryPort; grantLookups: () => number } {
    const base = nonShadowRepo();
    let grantLookups = 0;
    const repo: CoordinationRequestRepositoryPort = {
      saveRequest: (record) => base.saveRequest(record),
      findRequestById: (id) => base.findRequestById(id),
      findRequestByGrantId: (grantId) => {
        grantLookups += 1;
        return base.findRequestByGrantId(grantId);
      },
      listRequests: (projectId) => {
        grantLookups += 1;
        return base.listRequests(projectId);
      },
    };
    return { repo, grantLookups: () => grantLookups };
  }

  it.each(SNAPSHOTTED_FIELDS.flatMap((field) => ACCESSOR_KINDS.map((kind) => ({ field, kind }))))(
    'refuses an own $kind accessor on snapshotted $field as invalid-request without resolving any grant',
    async ({ field, kind }) => {
      const { repo, grantLookups } = countingRepo();
      const result = await resolveRaw(
        new ResolveActionAuthorizationUseCase({ requestRepo: repo }),
        requestWithAccessor(field, kind),
      );
      expect(result).toEqual({ outcome: 'blocked', reason: 'invalid-request' });
      expect(grantLookups()).toBe(0);
    },
  );

  // BL02g fix round: absence stays absence. A request whose optional fields
  // are simply not present (no own property at all) carries no accessor and
  // still resolves exactly as before.
  it('resolves a request whose optional fields are absent as own properties exactly as before', async () => {
    const request = {
      projectId: 'proj-1',
      actionScope: 'forge:merge-pr',
      expectedHeadSha: '1111111111111111111111111111111111111111',
      authorizationGrantId: 'grant-1',
      repository: { owner: 'repo-a-owner', repo: 'repo-a' },
      pullRequestNumber: 1,
    };
    const result = await resolveRaw(useCase(nonShadowRepo()), request);
    expect(result).toEqual({
      outcome: 'authorized',
      grantId: 'grant-1',
      requestId: 'req-1',
      expectedHeadSha: '1111111111111111111111111111111111111111',
      policyRevision: 'aaaaaaaaaaaa',
    });
  });

  it('refuses a setter-only expectedHeadSha accessor as invalid-request without running the setter', async () => {
    let calls = 0;
    const hostile = { ...nonShadowRequest() };
    Object.defineProperty(hostile, 'expectedHeadSha', {
      set() {
        calls += 1;
        throw new Error('hostile expectedHeadSha setter ran');
      },
      enumerable: true,
    });
    const result = await resolveRaw(useCase(nonShadowRepo()), hostile);
    expect(result).toEqual({ outcome: 'blocked', reason: 'invalid-request' });
    expect(calls).toBe(0);
  });

  it('authorizes a non-shadow Proxy over a valid request exactly like the plain data', async () => {
    let gets = 0;
    const proxy = new Proxy(nonShadowRequest(), {
      get(target, key, receiver) {
        gets += 1;
        return Reflect.get(target, key, receiver);
      },
    });
    const plain = await resolveRaw(useCase(nonShadowRepo()), nonShadowRequest());
    const result = await resolveRaw(useCase(nonShadowRepo()), proxy);
    // A plain-data proxy yields exactly the plain data's result, and the
    // validation reads the required fields through their own descriptors, so
    // no `get` trap fires for the validation itself.
    expect(result).toEqual(plain);
    expect(result.outcome).toBe('authorized');
    expect(gets).toBe(0);
  });

  it('refuses a hostile Proxy on the non-shadow path as invalid-request without throwing', async () => {
    const proxy = new Proxy(nonShadowRequest(), {
      get() {
        throw new Error('hostile proxy get');
      },
      getOwnPropertyDescriptor() {
        throw new Error('hostile proxy descriptor');
      },
    });
    const result = await resolveRaw(useCase(nonShadowRepo()), proxy);
    expect(result).toEqual({ outcome: 'blocked', reason: 'invalid-request' });
  });

  // BL02g fix round: a descriptor trap that throws only for `releaseRoot` —
  // an OPTIONAL field with no own property on the request — is never
  // consulted: the shared helper inspects only the keys the snapshot copied,
  // so absence (no own property at all) stays absent and the request resolves
  // exactly like the plain data. A throwing trap for a key the snapshot
  // copied is still the typed invalid-request refusal.
  it('resolves a Proxy whose descriptor trap throws only for the absent optional releaseRoot exactly like the plain data', async () => {
    const proxy = new Proxy(nonShadowRequest(), {
      getOwnPropertyDescriptor(target, prop) {
        if (prop === 'releaseRoot') {
          throw new Error('hostile proxy releaseRoot descriptor');
        }
        return Reflect.getOwnPropertyDescriptor(target, prop);
      },
    });
    const plain = await resolveRaw(useCase(nonShadowRepo()), nonShadowRequest());
    const result = await resolveRaw(useCase(nonShadowRepo()), proxy);
    expect(result).toEqual(plain);
    expect(result.outcome).toBe('authorized');
  });

  // BL02g fix round: the snapshot reads each snapshotted field's own
  // descriptor EXACTLY ONCE, so a descriptor trap that would throw only on a
  // LATER inspection (the old second read) is never consulted: the request
  // resolves exactly like its plain data.
  it('consults each snapshotted field descriptor exactly once, so a trap throwing only on a later actionScope inspection never fires', async () => {
    let actionScopeDescriptorCalls = 0;
    const proxy = new Proxy(nonShadowRequest(), {
      getOwnPropertyDescriptor(target, prop) {
        if (prop === 'actionScope') {
          actionScopeDescriptorCalls += 1;
          if (actionScopeDescriptorCalls > 1) {
            throw new Error('hostile proxy actionScope descriptor');
          }
        }
        return Reflect.getOwnPropertyDescriptor(target, prop);
      },
    });
    const plain = await resolveRaw(useCase(nonShadowRepo()), nonShadowRequest());
    const result = await resolveRaw(useCase(nonShadowRepo()), proxy);
    expect(result).toEqual(plain);
    expect(result.outcome).toBe('authorized');
    expect(actionScopeDescriptorCalls).toBe(1);
  });

  // BL02g fix round (TOCTOU): a Proxy can report an accessor descriptor on
  // the snapshot read and a data descriptor on a second inspection, so the
  // accessor refusal and the snapshotted value must both derive from the ONE
  // descriptor read per snapshotted field.
  it('refuses a Proxy reporting an accessor for resumeActionId on the first descriptor read only, consulting that field exactly once', async () => {
    let resumeDescriptorCalls = 0;
    const proxy = new Proxy({ ...nonShadowRequest(), resumeActionId: 'act-1' }, {
      getOwnPropertyDescriptor(target, prop) {
        if (prop === 'resumeActionId') {
          resumeDescriptorCalls += 1;
          if (resumeDescriptorCalls === 1) {
            return {
              get: () => 'act-1',
              set: undefined,
              enumerable: true,
              configurable: true,
            };
          }
        }
        return Reflect.getOwnPropertyDescriptor(target, prop);
      },
    });
    const result = await resolveRaw(useCase(nonShadowRepo()), proxy);
    expect(result).toEqual({ outcome: 'blocked', reason: 'invalid-request' });
    expect(resumeDescriptorCalls).toBe(1);
  });

  it('never invokes a throwing get trap on a non-shadow Proxy whose getOwnPropertyDescriptor forwards normally', async () => {
    let gets = 0;
    const proxy = new Proxy(nonShadowRequest(), {
      getOwnPropertyDescriptor(target, prop) {
        return Reflect.getOwnPropertyDescriptor(target, prop);
      },
      get() {
        gets += 1;
        throw new Error('hostile proxy get');
      },
    });
    const plain = await resolveRaw(useCase(nonShadowRepo()), nonShadowRequest());
    const result = await resolveRaw(useCase(nonShadowRepo()), proxy);
    expect(result).toEqual(plain);
    expect(result.outcome).toBe('authorized');
    expect(gets).toBe(0);
  });
});

describe('ResolveActionAuthorizationUseCase release grants (RR1)', () => {
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
    const grant = {
      actionScope: 'release:install',
      projectId: 'proj-1',
      expectedHeadSha: HEAD,
      releaseRoot: ROOT,
      nonce: NONCE,
    };
    return {
      id: releaseRequestId(grant),
      projectId: 'proj-1',
      kind: 'action-decision',
      state: 'approved',
      actionScope: 'release:install',
      expectedHeadSha: HEAD,
      proposalDigest: 'digest-1',
      policyRevision: 'p1',
      decisionRevision: 'dec-1',
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

  function resolveRelease(
    useCase: ResolveActionAuthorizationUseCase,
    overrides: Record<string, unknown> = {},
  ): Promise<ResolveActionAuthorizationResult> {
    return useCase.resolveActionAuthorization({
      projectId: 'proj-1',
      actionScope: 'release:install',
      expectedHeadSha: HEAD,
      releaseRoot: ROOT,
      ...overrides,
    } as never);
  }

  it('authorizes a digest-bound release record whose root matches', async () => {
    const requestRepo = new InMemoryCoordinationRequestRepository();
    const record = createReleaseRecord();
    await requestRepo.saveRequest(record);
    // KEY0c3: release grants are owner-gated, so the signature check needs
    // the transport and a seeded signed answer.
    const signer = createSignedDecisionFixture();
    await signer.writeApprovedAnswer(record);
    const result = await resolveRelease(
      new ResolveActionAuthorizationUseCase({ requestRepo, ...signer.deps, computeDigest: digest }),
    );
    expect(result).toMatchObject({ outcome: 'authorized', grantId: GRANT_ID, releaseRoot: ROOT });
  });

  it('blocks a matching root whose stored coordinates no longer hash to the id (tampered)', async () => {
    const requestRepo = new InMemoryCoordinationRequestRepository();
    // The stored root was moved after recording: the request names the same
    // (moved) root, so the root check passes, but the recomputed digest no
    // longer matches the request id the grant is bound by.
    await requestRepo.saveRequest(
      createReleaseRecord({ releaseRoot: '/srv/fleet/moved' }),
    );
    const result = await resolveRelease(
      new ResolveActionAuthorizationUseCase({ requestRepo, computeDigest: digest }),
      { releaseRoot: '/srv/fleet/moved' },
    );
    expect(result).toEqual({ outcome: 'blocked', reason: 'release-grant-digest-mismatch' });
  });

  it('blocks a record whose nonce was tampered with (the digest recompute no longer matches the id)', async () => {
    const requestRepo = new InMemoryCoordinationRequestRepository();
    await requestRepo.saveRequest(
      createReleaseRecord({ releaseNonce: 'fedcba9876543210fedcba9876543210' }),
    );
    const result = await resolveRelease(
      new ResolveActionAuthorizationUseCase({ requestRepo, computeDigest: digest }),
    );
    expect(result).toEqual({ outcome: 'blocked', reason: 'release-grant-digest-mismatch' });
  });

  it('fails closed on a release record with a missing or malformed nonce', async () => {
    for (const bad of [undefined, 'short', 'ABCDEF0123456789ABCDEF0123456789']) {
      const requestRepo = new InMemoryCoordinationRequestRepository();
      await requestRepo.saveRequest(createReleaseRecord({ releaseNonce: bad }));
      const result = await resolveRelease(
        new ResolveActionAuthorizationUseCase({ requestRepo, computeDigest: digest }),
      );
      expect(result).toEqual({ outcome: 'blocked', reason: 'release-grant-digest-mismatch' });
    }
  });

  it('blocks a pre-RR1 unprefixed release record (unsigned root) even when the root matches', async () => {
    const requestRepo = new InMemoryCoordinationRequestRepository();
    await requestRepo.saveRequest(createReleaseRecord({ id: 'req-unprefixed-1' }));
    const result = await resolveRelease(
      new ResolveActionAuthorizationUseCase({ requestRepo, computeDigest: digest }),
    );
    expect(result).toEqual({ outcome: 'blocked', reason: 'release-grant-digest-mismatch' });
  });

  it('fails closed with digest-unavailable when the digest is unwired on a release record', async () => {
    const requestRepo = new InMemoryCoordinationRequestRepository();
    await requestRepo.saveRequest(createReleaseRecord());
    const result = await resolveRelease(
      new ResolveActionAuthorizationUseCase({ requestRepo }),
    );
    expect(result).toEqual({ outcome: 'blocked', reason: 'digest-unavailable' });
  });

  it('still blocks a different root with release-grant-root-mismatch before the digest runs', async () => {
    const requestRepo = new InMemoryCoordinationRequestRepository();
    await requestRepo.saveRequest(createReleaseRecord());
    const result = await resolveRelease(
      new ResolveActionAuthorizationUseCase({ requestRepo, computeDigest: digest }),
      { releaseRoot: '/srv/fleet/other' },
    );
    expect(result).toEqual({ outcome: 'blocked', reason: 'release-grant-root-mismatch' });
  });

  // BL02g fix round: an own accessor on the non-required `releaseRoot` — a
  // getter or a setter — is refused as `invalid-request` through its own
  // descriptor, never run. A setter-only accessor snapshots to `undefined`
  // exactly like an omitted field, so without the descriptor check it would
  // silently agree with any recorded root; the refusal must fire before the
  // recorded request is located and must not read as a root mismatch.
  it('refuses a setter-only releaseRoot accessor on a release resolve as invalid-request, without running the setter', async () => {
    const requestRepo = new InMemoryCoordinationRequestRepository();
    await requestRepo.saveRequest(createReleaseRecord());
    let calls = 0;
    const hostile: Record<string, unknown> = {
      projectId: 'proj-1',
      actionScope: 'release:install',
      expectedHeadSha: HEAD,
    };
    Object.defineProperty(hostile, 'releaseRoot', {
      set() {
        calls += 1;
        throw new Error('hostile releaseRoot setter ran');
      },
      enumerable: true,
    });
    const result = await new ResolveActionAuthorizationUseCase({
      requestRepo,
      computeDigest: digest,
    }).resolveActionAuthorization(hostile as never);
    expect(result).toEqual({ outcome: 'blocked', reason: 'invalid-request' });
    expect(calls).toBe(0);
  });

  // RR1 fix round: `releaseRootsAgree` is pinned to exact string equality on
  // the normalized roots. A case-insensitive comparison or a `startsWith`
  // prefix comparison must fail these near-miss cases, not authorize them.
  it.each([
    { recorded: '/srv/rel', requested: '/srv/rel2' },
    { recorded: '/srv/rel2', requested: '/srv/rel' },
    { recorded: '/srv/Rel', requested: '/srv/rel' },
  ])('blocks a near-miss root $recorded vs $requested with release-grant-root-mismatch (no prefix or case folding)', async ({ recorded, requested }) => {
    const requestRepo = new InMemoryCoordinationRequestRepository();
    await requestRepo.saveRequest(createReleaseRecord({ releaseRoot: recorded }));
    const result = await resolveRelease(
      new ResolveActionAuthorizationUseCase({ requestRepo, computeDigest: digest }),
      { releaseRoot: requested },
    );
    expect(result).toEqual({ outcome: 'blocked', reason: 'release-grant-root-mismatch' });
  });
});

describe('ResolveActionAuthorizationUseCase signed re-verification (KEY0c2)', () => {
  const REQUEST = {
    projectId: 'project-atlas',
    actionScope: 'forge:merge',
    expectedHeadSha: 'abc123',
    authorizationGrantId: 'grant-9',
    attemptId: 'attempt-1',
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
      deliveryStatus: 'pending',
      deliveryGapReason: null,
      revision: 1,
      createdAtIso: '2026-11-18T00:00:00.000Z',
      updatedAtIso: '2026-11-18T00:00:00.000Z',
      grantRecordVersion: 2,
      grantAttemptId: 'attempt-1',
      ...overrides,
    };
  }

  function repositoryWith(...records: CoordinationRequestRecord[]): InMemoryCoordinationRequestRepository {
    const repo = new InMemoryCoordinationRequestRepository();
    for (const record of records) {
      void repo.saveRequest(record);
    }
    return repo;
  }

  function stubTransport(answers: Record<string, DecisionAnswer>): DecisionTransportPort {
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

  async function resolveWith(transport: DecisionTransportPort | undefined): Promise<ResolveActionAuthorizationResult> {
    const signer = createSignedDecisionFixture();
    const record = ownerRecord();
    await signer.writeApprovedAnswer(record);
    return new ResolveActionAuthorizationUseCase({
      requestRepo: repositoryWith(record),
      decisionTransport: transport ?? signer.deps.decisionTransport,
    }).execute(REQUEST);
  }

  it('authorizes with valid signed answer', async () => {
    const result = await resolveWith(undefined);
    expect(result.outcome).toBe('authorized');
    expect(result.outcome === 'authorized' && result.grantId).toBe('grant-9');
  });

  it('refuses hand-written approved record with no answer file', async () => {
    const signer = createSignedDecisionFixture();
    const result = await new ResolveActionAuthorizationUseCase({
      requestRepo: repositoryWith(ownerRecord()),
      decisionTransport: transportWith(signer.ownerPublicKey, {}),
    }).execute(REQUEST);
    expect(result).toEqual({ outcome: 'blocked', reason: 'decision-signature-invalid' });
  });

  it('refuses approved owner record when decisionTransport is absent', async () => {
    const result = await new ResolveActionAuthorizationUseCase({
      requestRepo: repositoryWith(ownerRecord()),
    }).execute(REQUEST);
    expect(result).toEqual({ outcome: 'blocked', reason: 'decision-signature-invalid' });
  });

  it('surfaces owner-key-unpinned and owner-key-env-mismatch', async () => {
    const signer = createSignedDecisionFixture();
    const answer = signer.signApprovedAnswer(ownerRecord());
    for (const refusal of ['owner-key-unpinned', 'owner-key-env-mismatch'] as const) {
      const result = await new ResolveActionAuthorizationUseCase({
        requestRepo: repositoryWith(ownerRecord()),
        decisionTransport: transportWith(signer.ownerPublicKey, { 'request-1': answer }, refusal),
      }).execute(REQUEST);
      expect(result).toEqual({ outcome: 'blocked', reason: refusal });
    }
  });

  it('refuses approved record when answer is signed by a different key', async () => {
    const signer = createSignedDecisionFixture();
    const other = createSignedDecisionFixture();
    const result = await new ResolveActionAuthorizationUseCase({
      requestRepo: repositoryWith(ownerRecord()),
      decisionTransport: transportWith(signer.ownerPublicKey, {
        'request-1': other.signApprovedAnswer(ownerRecord()),
      }),
    }).execute(REQUEST);
    expect(result).toEqual({ outcome: 'blocked', reason: 'decision-signature-invalid' });
  });

  it('refuses approved record when answer is for a different request', async () => {
    const signer = createSignedDecisionFixture();
    const result = await new ResolveActionAuthorizationUseCase({
      requestRepo: repositoryWith(ownerRecord()),
      decisionTransport: transportWith(signer.ownerPublicKey, {
        'request-1': signer.signApprovedAnswer(ownerRecord({ id: 'request-2' })),
      }),
    }).execute(REQUEST);
    expect(result).toEqual({ outcome: 'blocked', reason: 'decision-signature-invalid' });
  });

  it('refuses an approved grant with no bound attempt and an invalid answer without persisting a binding', async () => {
    const signer = createSignedDecisionFixture();
    const other = createSignedDecisionFixture();
    const unbound = ownerRecord({
      grantAttemptId: undefined,
      grantRecordVersion: undefined,
    } as Partial<CoordinationRequestRecord>);
    const repo = repositoryWith(unbound);
    const before = JSON.stringify((await repo.findRequestById('request-1')) ?? null);
    const result = await new ResolveActionAuthorizationUseCase({
      requestRepo: repo,
      decisionTransport: transportWith(signer.ownerPublicKey, {
        'request-1': other.signApprovedAnswer(unbound),
      }),
    }).execute({ ...REQUEST, attemptId: 'attempt-1' });
    expect(result).toEqual({ outcome: 'blocked', reason: 'decision-signature-invalid' });
    const after = JSON.stringify((await repo.findRequestById('request-1')) ?? null);
    expect(after).toBe(before);
  });

  it('refuses when answer grantId or decisionRevision mismatches stored record', async () => {
    const signer = createSignedDecisionFixture();
    for (const mismatched of [
      ownerRecord({ grantId: 'grant-8' }),
      ownerRecord({ decisionRevision: 'decision-4' }),
    ]) {
      const result = await new ResolveActionAuthorizationUseCase({
        requestRepo: repositoryWith(ownerRecord()),
        decisionTransport: transportWith(signer.ownerPublicKey, {
          'request-1': signer.signApprovedAnswer(mismatched),
        }),
      }).execute(REQUEST);
      expect(result).toEqual({ outcome: 'blocked', reason: 'decision-signature-invalid' });
    }
  });

  it('refuses when decisionTransport reports awaiting-decision or declined', async () => {
    for (const answer of [
      { state: 'awaiting-decision' as const, decisionRevision: null, grantId: null },
      { state: 'declined' as const, decisionRevision: 'decision-3', grantId: 'grant-9' },
    ]) {
      const result = await new ResolveActionAuthorizationUseCase({
        requestRepo: repositoryWith(ownerRecord()),
        decisionTransport: stubTransport({ 'request-1': answer }),
      }).execute(REQUEST);
      expect(result).toEqual({ outcome: 'blocked', reason: 'decision-signature-invalid' });
    }
  });

  it('keeps policy and merge grants unchanged without decisionTransport and exempts them with one', async () => {
    const mergeGrant = ownerRecord({
      actionScope: 'forge:merge-pr',
      decisionRevision: 'policy:merge@0123456789ab',
      mergeGrant: { repository: { owner: 'o', repo: 'r' }, pullRequestNumber: 1 },
      grantRecordVersion: undefined,
      grantAttemptId: undefined,
    });
    const signer = createSignedDecisionFixture();
    // No answer is seeded for the merge grant: the closed-kind exemption
    // keeps origin/main behaviour even with a transport injected.
    const result = await new ResolveActionAuthorizationUseCase({
      requestRepo: repositoryWith(mergeGrant),
      decisionTransport: transportWith(signer.ownerPublicKey, {}),
    }).execute({
      projectId: 'project-atlas',
      actionScope: 'forge:merge-pr',
      expectedHeadSha: 'abc123',
      authorizationGrantId: 'grant-9',
      repository: { owner: 'o', repo: 'r' },
      pullRequestNumber: 1,
    });
    expect(result.outcome).toBe('authorized');
    // KEY0c3: a non-signed scope keeps origin/main behaviour even when the
    // transport is omitted entirely.
    const withoutTransport = await new ResolveActionAuthorizationUseCase({
      requestRepo: repositoryWith(mergeGrant),
    }).execute({
      projectId: 'project-atlas',
      actionScope: 'forge:merge-pr',
      expectedHeadSha: 'abc123',
      authorizationGrantId: 'grant-9',
      repository: { owner: 'o', repo: 'r' },
      pullRequestNumber: 1,
    });
    expect(withoutTransport.outcome).toBe('authorized');
  });

  // KEY0c2 fix round 4: the resume path must not escape signature
  // re-verification. A non-approved record (cancelled, declined or
  // awaiting-decision) carrying a consumption whose action id matches the
  // named `resumeActionId` resolves only through the transport's signed
  // answer; with no answer file every such resume is blocked.
  function digestBoundReleaseRecord(
    overrides: Partial<CoordinationRequestRecord> = {},
  ): CoordinationRequestRecord {
    const coordinates = {
      scope: 'release:install',
      projectId: 'project-atlas',
      expectedHeadSha: 'abc123',
      releaseRoot: '/srv/fleet/releases',
      nonce: '0123456789abcdef0123456789abcdef',
    };
    return {
      id: `release-grant-${createHash('sha256').update(JSON.stringify(coordinates)).digest('hex')}`,
      projectId: 'project-atlas',
      kind: 'action-decision',
      state: 'approved',
      actionScope: 'release:install',
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
      releaseRoot: coordinates.releaseRoot,
      releaseNonce: coordinates.nonce,
      ...overrides,
    };
  }

  function resumeConsumption(actionId: string): CoordinationRequestRecord['consumptions'][number] {
    return {
      consumptionId: 'consumption-1',
      grantId: 'grant-9',
      requestId: 'request-1',
      actionId,
      attemptId: 'attempt-1',
      expectedHeadSha: 'abc123',
      consumedAtIso: '2026-11-18T00:30:00.000Z',
    };
  }

  const RESUME_REQUEST = {
    projectId: 'project-atlas',
    actionScope: 'release:install',
    expectedHeadSha: 'abc123',
    releaseRoot: '/srv/fleet/releases',
    authorizationGrantId: 'grant-9',
    resumeActionId: 'action-1',
  };

  // RR1: the digest-bound release record's id is re-verified on every
  // release resolve, so the digest must be wired in these tests too.
  const computeDigest = (payload: string): string =>
    createHash('sha256').update(payload).digest('hex');

  it.each(['cancelled', 'declined', 'awaiting-decision'] as const)(
    'refuses a %s release record resumed by its own consumption with no answer file',
    async (state) => {
      const signer = createSignedDecisionFixture();
      const record = digestBoundReleaseRecord({
        state,
        consumptions: [resumeConsumption('action-1')],
      });
      const result = await new ResolveActionAuthorizationUseCase({
        requestRepo: repositoryWith(record),
        decisionTransport: transportWith(signer.ownerPublicKey, {}),
        computeDigest,
      }).execute(RESUME_REQUEST);
      expect(result).toEqual({ outcome: 'blocked', reason: 'decision-signature-invalid' });
    },
  );

  it('resumes a valid signed approved-completed release record with a real consumption', async () => {
    const signer = createSignedDecisionFixture();
    const record = digestBoundReleaseRecord({
      state: 'completed',
      consumptions: [resumeConsumption('action-1')],
    });
    await signer.writeApprovedAnswer(record);
    const result = await new ResolveActionAuthorizationUseCase({
      requestRepo: repositoryWith(record),
      decisionTransport: signer.deps.decisionTransport,
      computeDigest,
    }).execute(RESUME_REQUEST);
    expect(result.outcome).toBe('authorized');
  });

  // #4g: a retry after a crash between the consumption and the release's
  // write must resolve through the resumable grant even when a second,
  // unrelated approved grant sits at the same coordinates, so the second
  // grant is never spent by the retry.
  function digestBoundReleaseRecordWithNonce(
    nonce: string,
    grantId: string,
    overrides: Partial<CoordinationRequestRecord> = {},
  ): CoordinationRequestRecord {
    const coordinates = {
      scope: 'release:install',
      projectId: 'project-atlas',
      expectedHeadSha: 'abc123',
      releaseRoot: '/srv/fleet/releases',
      nonce,
    };
    return digestBoundReleaseRecord({
      grantId,
      releaseNonce: nonce,
      id: `release-grant-${createHash('sha256').update(JSON.stringify(coordinates)).digest('hex')}`,
      ...overrides,
    });
  }

  const RETRY_REQUEST = {
    projectId: 'project-atlas',
    actionScope: 'release:install',
    expectedHeadSha: 'abc123',
    releaseRoot: '/srv/fleet/releases',
    resumeActionId: 'action-1',
  };

  it('prefers the matching resumable release grant over a second approved grant on retry', async () => {
    const signer = createSignedDecisionFixture();
    const resumable = digestBoundReleaseRecordWithNonce('0123456789abcdef0123456789abcdef', 'grant-9', {
      state: 'completed',
      consumptions: [resumeConsumption('action-1')],
    });
    await signer.writeApprovedAnswer(resumable);
    const second = digestBoundReleaseRecordWithNonce('fedcba9876543210fedcba9876543210', 'grant-10');
    const result = await new ResolveActionAuthorizationUseCase({
      requestRepo: repositoryWith(resumable, second),
      decisionTransport: signer.deps.decisionTransport,
      computeDigest,
    }).execute(RETRY_REQUEST);
    expect(result).toMatchObject({ outcome: 'authorized', grantId: 'grant-9', requestId: resumable.id });
  });

  it('still prefers a second approved grant when the retry names no resumable consumption', async () => {
    const signer = createSignedDecisionFixture();
    const consumed = digestBoundReleaseRecordWithNonce('0123456789abcdef0123456789abcdef', 'grant-9', {
      state: 'completed',
      consumptions: [resumeConsumption('action-1')],
    });
    const second = digestBoundReleaseRecordWithNonce('fedcba9876543210fedcba9876543210', 'grant-10');
    await signer.writeApprovedAnswer(second);
    const result = await new ResolveActionAuthorizationUseCase({
      requestRepo: repositoryWith(consumed, second),
      decisionTransport: signer.deps.decisionTransport,
      computeDigest,
    }).execute({ ...RETRY_REQUEST, resumeActionId: 'action-2' });
    expect(result).toMatchObject({ outcome: 'authorized', grantId: 'grant-10' });
  });

  it('blocks a release retry whose resume action id matches no recorded consumption', async () => {
    const signer = createSignedDecisionFixture();
    const consumed = digestBoundReleaseRecordWithNonce('0123456789abcdef0123456789abcdef', 'grant-9', {
      state: 'completed',
      consumptions: [resumeConsumption('other-action')],
    });
    await signer.writeApprovedAnswer(consumed);
    const result = await new ResolveActionAuthorizationUseCase({
      requestRepo: repositoryWith(consumed),
      decisionTransport: signer.deps.decisionTransport,
      computeDigest,
    }).execute(RETRY_REQUEST);
    expect(result).toEqual({
      outcome: 'blocked',
      reason: 'no recorded decision authorizes release:install for project-atlas',
    });
  });

  it('refuses a wrong-primitive resumeActionId (a number where a string is due) without authorizing', async () => {
    const signer = createSignedDecisionFixture();
    const consumed = digestBoundReleaseRecordWithNonce('0123456789abcdef0123456789abcdef', 'grant-9', {
      state: 'completed',
      consumptions: [resumeConsumption('action-1')],
    });
    const result = await new ResolveActionAuthorizationUseCase({
      requestRepo: repositoryWith(consumed),
      decisionTransport: signer.deps.decisionTransport,
      computeDigest,
    }).execute({ ...RETRY_REQUEST, resumeActionId: 7 });
    expect(result).toEqual({
      outcome: 'blocked',
      reason: 'no recorded decision authorizes release:install for project-atlas',
    });
  });

  it('refuses a getter-carrying actionScope on a release retry as invalid-request without running the getter', async () => {
    const signer = createSignedDecisionFixture();
    const consumed = digestBoundReleaseRecordWithNonce('0123456789abcdef0123456789abcdef', 'grant-9', {
      state: 'completed',
      consumptions: [resumeConsumption('action-1')],
    });
    let getterCalls = 0;
    const request = {
      ...RETRY_REQUEST,
      get actionScope(): string {
        getterCalls += 1;
        return 'release:install';
      },
    };
    const result = await new ResolveActionAuthorizationUseCase({
      requestRepo: repositoryWith(consumed),
      decisionTransport: signer.deps.decisionTransport,
      computeDigest,
    }).execute(request);
    expect(result).toEqual({ outcome: 'blocked', reason: 'invalid-request' });
    expect(getterCalls).toBe(0);
  });
});

describe('ResolveActionAuthorizationUseCase relaunch-apply resolve (AR3a)', () => {
  const CREATED_AT_ISO = '2026-11-01T00:00:00.000Z';
  const GRANT_ID = 'grant-relaunch-1';
  const PROPOSAL_DIGEST = 'a'.repeat(64);
  const SEVEN_DAYS_MS = RELAUNCH_APPLY_GRANT_MAX_TTL_DAYS * 86_400_000;

  function relaunchRecord(
    overrides: Partial<CoordinationRequestRecord> = {},
  ): CoordinationRequestRecord {
    const bound = {
      projectId: overrides.projectId ?? RELAUNCH_APPLY_PROJECT_ID,
      proposalDigest: overrides.proposalDigest ?? PROPOSAL_DIGEST,
      createdAtIso: overrides.createdAtIso ?? CREATED_AT_ISO,
    };
    return {
      id: `${RELAUNCH_APPLY_DIGEST_PREFIX}${createHash('sha256').update(relaunchApplyDigestPayload(bound)).digest('hex')}`,
      projectId: RELAUNCH_APPLY_PROJECT_ID,
      kind: 'action-decision',
      state: 'approved',
      actionScope: RELAUNCH_APPLY_ACTION_SCOPE,
      expectedHeadSha: null,
      proposalDigest: PROPOSAL_DIGEST,
      policyRevision: 'pol-relaunch-1',
      decisionRevision: 'dec-relaunch-1',
      grantId: GRANT_ID,
      consumptions: [],
      acknowledgements: [],
      deliveryStatus: 'delivered',
      deliveryGapReason: null,
      revision: 1,
      createdAtIso: CREATED_AT_ISO,
      updatedAtIso: CREATED_AT_ISO,
      ...overrides,
    };
  }

  function repositoryWith(...records: CoordinationRequestRecord[]): InMemoryCoordinationRequestRepository {
    const repo = new InMemoryCoordinationRequestRepository();
    for (const record of records) {
      void repo.saveRequest(record);
    }
    return repo;
  }

  function signedDeps(requestRepo: CoordinationRequestRepositoryPort, record: CoordinationRequestRecord): {
    requestRepo: CoordinationRequestRepositoryPort;
    decisionTransport: DecisionTransportPort;
  } {
    const signer = createSignedDecisionFixture();
    void signer.writeApprovedAnswer({
      id: record.id,
      projectId: record.projectId,
      actionScope: record.actionScope,
      expectedHeadSha: record.expectedHeadSha,
      decisionRevision: record.decisionRevision,
      grantId: record.grantId,
    });
    return { requestRepo, ...signer.deps };
  }

  function clockAt(nowIso: string): {
    shadowImportClock: { nowIso: () => string };
    computeDigest: (payload: string) => string;
  } {
    return {
      shadowImportClock: { nowIso: () => nowIso },
      computeDigest: (payload) => createHash('sha256').update(payload).digest('hex'),
    };
  }

  function relaunchRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      projectId: RELAUNCH_APPLY_PROJECT_ID,
      actionScope: RELAUNCH_APPLY_ACTION_SCOPE,
      expectedHeadSha: '',
      authorizationGrantId: GRANT_ID,
      proposalDigest: PROPOSAL_DIGEST,
      ...overrides,
    };
  }

  async function resolve(
    deps: ConstructorParameters<typeof ResolveActionAuthorizationUseCase>[0],
    input: unknown,
  ): Promise<ResolveActionAuthorizationResult> {
    return new ResolveActionAuthorizationUseCase(deps).resolveActionAuthorization(input as never);
  }

  it('authorizes a signed, approved, digest-bound relaunch-apply grant', async () => {
    const record = relaunchRecord();
    const result = await resolve(
      {
        ...signedDeps(repositoryWith(record), record),
        ...clockAt(CREATED_AT_ISO),
      },
      relaunchRequest(),
    );
    expect(result).toEqual({
      outcome: 'authorized',
      grantId: GRANT_ID,
      requestId: record.id,
      expectedHeadSha: '',
      policyRevision: 'pol-relaunch-1',
    });
  });

  it('refuses a relaunch grant whose createdAtIso is in the future of the trusted clock (grant-created-in-future)', async () => {
    const record = relaunchRecord({ createdAtIso: '2099-01-01T00:00:00.000Z' });
    const result = await resolve(
      { ...signedDeps(repositoryWith(record), record), ...clockAt(CREATED_AT_ISO) },
      relaunchRequest(),
    );
    expect(result).toEqual({ outcome: 'blocked', reason: 'grant-created-in-future' });
  });

  it('refuses a store-edited proposalDigest even when the request names the edited digest', async () => {
    const original = relaunchRecord();
    const edited = { ...original, proposalDigest: 'c'.repeat(64) };
    const result = await resolve(
      { ...signedDeps(repositoryWith(edited), edited), ...clockAt(CREATED_AT_ISO) },
      relaunchRequest({ proposalDigest: 'c'.repeat(64) }),
    );
    expect(result).toEqual({ outcome: 'blocked', reason: 'grant-request-digest-mismatch' });
  });

  it('refuses a store-edited createdAtIso that would reset the expiry', async () => {
    const original = relaunchRecord({ createdAtIso: '2026-10-01T00:00:00.000Z' });
    const edited = { ...original, createdAtIso: CREATED_AT_ISO };
    const result = await resolve(
      { ...signedDeps(repositoryWith(edited), edited), ...clockAt(CREATED_AT_ISO) },
      relaunchRequest(),
    );
    expect(result).toEqual({ outcome: 'blocked', reason: 'grant-request-digest-mismatch' });
  });

  it('refuses a calendar-invalid trusted-clock instant (2026-02-30)', async () => {
    const record = relaunchRecord();
    const result = await resolve(
      { ...signedDeps(repositoryWith(record), record), ...clockAt('2026-02-30T00:00:00.000Z') },
      relaunchRequest(),
    );
    expect(result).toEqual({ outcome: 'blocked', reason: 'invalid-now-iso' });
  });

  it('authorizes 1ms before the 7-day boundary and blocks with grant-expired at and after 7 days', async () => {
    const record = relaunchRecord();
    const createdAtMs = Date.parse(CREATED_AT_ISO);
    const before = new Date(createdAtMs + SEVEN_DAYS_MS - 1).toISOString();
    const at = new Date(createdAtMs + SEVEN_DAYS_MS).toISOString();
    const after = new Date(createdAtMs + SEVEN_DAYS_MS + 1).toISOString();
    for (const [nowIso, expected] of [
      [before, 'authorized'],
      [at, 'blocked'],
      [after, 'blocked'],
    ] as const) {
      const result = await resolve(
        { ...signedDeps(repositoryWith(record), record), ...clockAt(nowIso) },
        relaunchRequest(),
      );
      if (expected === 'authorized') {
        expect(result.outcome).toBe('authorized');
      } else {
        expect(result).toEqual({ outcome: 'blocked', reason: 'grant-expired' });
      }
    }
  });

  it('blocks relaunch-apply with grant-expired when the record carries an unparseable createdAtIso', async () => {
    const record = relaunchRecord({ createdAtIso: 'not-a-timestamp' });
    const result = await resolve(
      { ...signedDeps(repositoryWith(record), record), ...clockAt(CREATED_AT_ISO) },
      relaunchRequest(),
    );
    expect(result).toEqual({ outcome: 'blocked', reason: 'grant-expired' });
  });

  it('blocks relaunch-apply with grant-wrong-project when refreshed.projectId is not relaunch', async () => {
    const record = relaunchRecord({ projectId: 'project-other' });
    const result = await resolve(
      { ...signedDeps(repositoryWith(record), record), ...clockAt(CREATED_AT_ISO) },
      relaunchRequest(),
    );
    expect(result).toEqual({ outcome: 'blocked', reason: 'grant-wrong-project' });
  });

  it('blocks relaunch-apply with grant-wrong-project when the resolve names another project', async () => {
    const record = relaunchRecord();
    const result = await resolve(
      { ...signedDeps(repositoryWith(record), record), ...clockAt(CREATED_AT_ISO) },
      relaunchRequest({ projectId: 'project-other' }),
    );
    expect(result).toEqual({ outcome: 'blocked', reason: 'grant-wrong-project' });
  });

  it('blocks relaunch-apply with grant-wrong-project when projectId is missing or unfilled', async () => {
    const record = relaunchRecord();
    for (const projectId of ['', '   ', 7, null]) {
      const result = await resolve(
        { ...signedDeps(repositoryWith(record), record), ...clockAt(CREATED_AT_ISO) },
        relaunchRequest({ projectId }),
      );
      expect(result).toEqual({ outcome: 'blocked', reason: 'grant-wrong-project' });
    }
  });

  it('blocks relaunch-apply with grant-missing when grant record is absent', async () => {
    const record = relaunchRecord();
    const absent = await resolve(
      {
        ...signedDeps(repositoryWith(record), record),
        ...clockAt(CREATED_AT_ISO),
      },
      relaunchRequest({ authorizationGrantId: 'grant-never-recorded' }),
    );
    expect(absent).toEqual({ outcome: 'blocked', reason: 'grant-missing' });
  });

  it('blocks relaunch-apply with grant-missing when authorizationGrantId is missing', async () => {
    const record = relaunchRecord();
    const result = await resolve(
      { ...signedDeps(repositoryWith(record), record), ...clockAt(CREATED_AT_ISO) },
      relaunchRequest({ authorizationGrantId: undefined }),
    );
    expect(result).toEqual({ outcome: 'blocked', reason: 'grant-missing' });
  });

  it('blocks relaunch-apply with grant-revoked when record is cancelled', async () => {
    const record = relaunchRecord({ state: 'cancelled' });
    const result = await resolve(
      { ...signedDeps(repositoryWith(record), record), ...clockAt(CREATED_AT_ISO) },
      relaunchRequest(),
    );
    expect(result).toEqual({ outcome: 'blocked', reason: 'grant-revoked' });
  });

  it('blocks relaunch-apply with grant-not-approved when record is awaiting-decision or declined', async () => {
    // Awaiting-decision: the transport has no answer (the refresh reads back
    // awaiting), so the refreshed record stays awaiting and blocks.
    const awaiting = relaunchRecord({ state: 'awaiting-decision' });
    const signer = createSignedDecisionFixture();
    const awaitingResult = await resolve(
      {
        requestRepo: repositoryWith(awaiting),
        decisionTransport: explicitAnswerTransport(signer.ownerPublicKey, {}),
        ...clockAt(CREATED_AT_ISO),
      },
      relaunchRequest(),
    );
    expect(awaitingResult).toEqual({ outcome: 'blocked', reason: 'grant-not-approved' });
    const declined = relaunchRecord({ state: 'declined' });
    const declinedResult = await resolve(
      { ...signedDeps(repositoryWith(declined), declined), ...clockAt(CREATED_AT_ISO) },
      relaunchRequest(),
    );
    expect(declinedResult).toEqual({ outcome: 'blocked', reason: 'grant-not-approved' });
  });

  it('blocks relaunch-apply with grant-wrong-scope when scope or expectedHeadSha mismatches', async () => {
    for (const overrides of [
      { actionScope: 'merge:import-shadow' },
      { expectedHeadSha: '0123456789abcdef' },
    ]) {
      const record = relaunchRecord(overrides);
      const result = await resolve(
        { ...signedDeps(repositoryWith(record), record), ...clockAt(CREATED_AT_ISO) },
        relaunchRequest(),
      );
      expect(result).toEqual({ outcome: 'blocked', reason: 'grant-wrong-scope' });
    }
  });

  it('blocks relaunch-apply with grant-digest-mismatch when plan digest mismatches', async () => {
    const record = relaunchRecord();
    const result = await resolve(
      { ...signedDeps(repositoryWith(record), record), ...clockAt(CREATED_AT_ISO) },
      relaunchRequest({ proposalDigest: 'b'.repeat(64) }),
    );
    expect(result).toEqual({ outcome: 'blocked', reason: 'grant-digest-mismatch' });
  });

  it('blocks relaunch-apply with invalid-request when the proposal digest is malformed', async () => {
    const record = relaunchRecord();
    for (const proposalDigest of [undefined, '', 'A'.repeat(64), 'a'.repeat(63), 'a'.repeat(65), 7]) {
      const result = await resolve(
        { ...signedDeps(repositoryWith(record), record), ...clockAt(CREATED_AT_ISO) },
        relaunchRequest({ proposalDigest }),
      );
      expect(result).toEqual({ outcome: 'blocked', reason: 'invalid-request' });
    }
  });

  it('authorizes a relaunch-apply request with extra own keys past the fixed fields, proving the resolve never enumerates the body', async () => {
    const record = relaunchRecord();
    const padded: Record<string, unknown> = relaunchRequest();
    // Far past any fixed field count: the relaunch resolve reads only its four
    // named fields with descriptor lookups, so bulk keys are inert — they are
    // never enumerated, never copied, and can never make the resolve cost
    // proportional to their count.
    for (let i = 0; i < 4096; i += 1) {
      padded[`filler-${i}`] = i;
    }
    const result = await resolve(
      { ...signedDeps(repositoryWith(record), record), ...clockAt(CREATED_AT_ISO) },
      padded,
    );
    expect(result).toEqual({
      outcome: 'authorized',
      grantId: GRANT_ID,
      requestId: record.id,
      expectedHeadSha: '',
      policyRevision: 'pol-relaunch-1',
    });
  });

  it('refuses a relaunch projectId padded past the length bound as grant-wrong-project', async () => {
    const record = relaunchRecord();
    // Trims to exactly `relaunch`, so only the O(1) length bound — not the
    // project comparison — can refuse it.
    const result = await resolve(
      { ...signedDeps(repositoryWith(record), record), ...clockAt(CREATED_AT_ISO) },
      relaunchRequest({ projectId: `${RELAUNCH_APPLY_PROJECT_ID}${' '.repeat(4096)}` }),
    );
    expect(result).toEqual({ outcome: 'blocked', reason: 'grant-wrong-project' });
  });

  it('refuses a relaunch grant id padded past the length bound as grant-missing', async () => {
    const record = relaunchRecord();
    // Trims to the exact recorded grant id, so only the O(1) length bound —
    // not the grant lookup — can refuse it.
    const result = await resolve(
      { ...signedDeps(repositoryWith(record), record), ...clockAt(CREATED_AT_ISO) },
      relaunchRequest({ authorizationGrantId: `${GRANT_ID}${' '.repeat(4096)}` }),
    );
    expect(result).toEqual({ outcome: 'blocked', reason: 'grant-missing' });
  });

  it('blocks relaunch-apply with clock-unavailable when clock is absent', async () => {
    const record = relaunchRecord();
    const deps = signedDeps(repositoryWith(record), record);
    const result = await resolve(deps, relaunchRequest());
    expect(result).toEqual({ outcome: 'blocked', reason: 'clock-unavailable' });
  });

  it('blocks relaunch-apply with invalid-now-iso when clock returns invalid timestamp', async () => {
    const record = relaunchRecord();
    for (const nowIso of ['not-a-timestamp', '', '0', '2026', '1', 7 as unknown as string]) {
      const result = await resolve(
        { ...signedDeps(repositoryWith(record), record), ...clockAt(nowIso) },
        relaunchRequest(),
      );
      expect(result).toEqual({ outcome: 'blocked', reason: 'invalid-now-iso' });
    }
  });

  it('refuses an array-like plain relaunch request carrying length and an index as invalid-request', async () => {
    const record = relaunchRecord();
    for (const extra of [{ length: 1 }, { 0: 'x' }, { length: 1, 0: 'x' }]) {
      const result = await resolve(
        { ...signedDeps(repositoryWith(record), record), ...clockAt(CREATED_AT_ISO) },
        relaunchRequest(extra),
      );
      expect(result).toEqual({ outcome: 'blocked', reason: 'invalid-request' });
    }
  });

  it('blocks relaunch-apply with decision-signature-invalid when decisionTransport is absent or signature fails', async () => {
    const record = relaunchRecord();
    const withoutTransport = await resolve(
      { requestRepo: repositoryWith(record), ...clockAt(CREATED_AT_ISO) },
      relaunchRequest(),
    );
    expect(withoutTransport).toEqual({ outcome: 'blocked', reason: 'decision-signature-invalid' });
    // An answer signed by a different key also blocks.
    const signer = createSignedDecisionFixture();
    const other = createSignedDecisionFixture();
    await signer.writeApprovedAnswer({
      id: record.id,
      projectId: record.projectId,
      actionScope: record.actionScope,
      expectedHeadSha: record.expectedHeadSha,
      decisionRevision: record.decisionRevision,
      grantId: record.grantId,
    });
    const wrongKey = await resolve(
      {
        requestRepo: repositoryWith(record),
        decisionTransport: explicitAnswerTransport(other.ownerPublicKey, {
          [record.id]: signer.signApprovedAnswer(record),
        }),
        ...clockAt(CREATED_AT_ISO),
      },
      relaunchRequest(),
    );
    expect(wrongKey).toEqual({ outcome: 'blocked', reason: 'decision-signature-invalid' });
  });

  it('never echoes the grant id or the plan digest in a refusal reason', async () => {
    const record = relaunchRecord();
    const clock = clockAt(new Date(Date.parse(CREATED_AT_ISO) + SEVEN_DAYS_MS + 1).toISOString());
    const refusals = await Promise.all([
      resolve(
        { ...signedDeps(repositoryWith(record), record), ...clock },
        relaunchRequest(),
      ),
      resolve(
        { ...signedDeps(repositoryWith(record), record), ...clock },
        relaunchRequest({ proposalDigest: 'b'.repeat(64) }),
      ),
      resolve(
        { ...signedDeps(repositoryWith(record), record), ...clock },
        relaunchRequest({ projectId: 'project-other' }),
      ),
    ]);
    for (const result of refusals) {
      expect(result.outcome).toBe('blocked');
      if (result.outcome === 'blocked') {
        expect(result.reason).not.toContain(GRANT_ID);
        expect(result.reason).not.toContain(PROPOSAL_DIGEST);
      }
    }
  });

  it('refuses an accessor on projectId as invalid-request without running the getter', async () => {
    const record = relaunchRecord();
    let calls = 0;
    const hostile = relaunchRequest();
    Object.defineProperty(hostile, 'projectId', {
      get() {
        calls += 1;
        throw new Error('hostile getter ran');
      },
      enumerable: true,
    });
    const result = await resolve(
      { ...signedDeps(repositoryWith(record), record), ...clockAt(CREATED_AT_ISO) },
      hostile,
    );
    expect(result).toEqual({ outcome: 'blocked', reason: 'invalid-request' });
    expect(calls).toBe(0);
  });

  it('refuses an own __proto__ key on a relaunch-apply resolve as invalid-request without polluting Object.prototype', async () => {
    const record = relaunchRecord();
    const hostile = JSON.parse(
      `{"projectId":"${RELAUNCH_APPLY_PROJECT_ID}","actionScope":"${RELAUNCH_APPLY_ACTION_SCOPE}","authorizationGrantId":"${GRANT_ID}","proposalDigest":"${PROPOSAL_DIGEST}","__proto__":{"polluted":true}}`,
    ) as Record<string, unknown>;
    const result = await resolve(
      { ...signedDeps(repositoryWith(record), record), ...clockAt(CREATED_AT_ISO) },
      hostile,
    );
    expect(result).toEqual({ outcome: 'blocked', reason: 'invalid-request' });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('refuses own constructor and prototype keys on a relaunch-apply resolve as invalid-request', async () => {
    const record = relaunchRecord();
    for (const polluting of ['constructor', 'prototype']) {
      const hostile: Record<string, unknown> = relaunchRequest();
      Object.defineProperty(hostile, polluting, { value: 'hostile', enumerable: true });
      const result = await resolve(
        { ...signedDeps(repositoryWith(record), record), ...clockAt(CREATED_AT_ISO) },
        hostile,
      );
      expect(result).toEqual({ outcome: 'blocked', reason: 'invalid-request' });
    }
  });

  it('refuses a hostile Proxy relaunch-apply resolve as invalid-request without throwing', async () => {
    const record = relaunchRecord();
    const proxy = new Proxy(relaunchRequest(), {
      get() {
        throw new Error('hostile proxy');
      },
      getOwnPropertyDescriptor() {
        throw new Error('hostile proxy descriptor');
      },
    });
    const result = await resolve(
      { ...signedDeps(repositoryWith(record), record), ...clockAt(CREATED_AT_ISO) },
      proxy,
    );
    expect(result).toEqual({ outcome: 'blocked', reason: 'invalid-request' });
  });
});
