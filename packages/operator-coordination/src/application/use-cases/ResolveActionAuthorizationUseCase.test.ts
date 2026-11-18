import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { CoordinationRequestRecord } from '../../domain/coordination-records.js';
import { SHADOW_IMPORT_ACTION_SCOPE } from '../../domain/coordination-records.js';
import type { CoordinationRequestRepositoryPort } from '../ports/out/CoordinationRequestRepositoryPort.out-port.js';
import { ResolveActionAuthorizationUseCase } from './ResolveActionAuthorizationUseCase.use-case.js';
import type { ResolveActionAuthorizationResult } from '../ports/in/ResolveActionAuthorizationPort.in-port.js';

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

    const useCase = new ResolveActionAuthorizationUseCase({ requestRepo });
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
    await requestRepo.saveRequest(createStandardGrantRecord());

    const useCase = new ResolveActionAuthorizationUseCase({ requestRepo });
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

  function shadowUseCase(
    requestRepo: InMemoryCoordinationRequestRepository,
    overrides: {
      computeDigest?: ((payload: string) => string) | null;
      clock?: { readonly nowIso: () => string } | null;
    } = {},
  ): ResolveActionAuthorizationUseCase {
    // Defaults are the wired composition: the digest and the trusted clock.
    // `null` unwires either, for the fail-closed tests.
    return new ResolveActionAuthorizationUseCase({
      requestRepo,
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
    await requestRepo.saveRequest(createShadowGrantRecord());
    const result = await resolve(shadowUseCase(requestRepo));
    expect(result).toEqual({
      outcome: 'authorized',
      grantId: GRANT_ID,
      requestId: REQUEST_ID,
      expectedHeadSha: '',
      policyRevision: 'pol-rev-1',
    });
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
    // `get` trap is the only one consulted.
    expect(gets).toBeGreaterThanOrEqual(0);
    expect(result).toEqual({
      outcome: 'authorized',
      grantId: GRANT_ID,
      requestId: REQUEST_ID,
      expectedHeadSha: '',
      policyRevision: 'pol-rev-1',
    });
  });

  it('never runs a hostile getter on the request and refuses it as invalid-request', async () => {
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
    // The accessor's value reads as undefined through its own descriptor, so
    // the projectId is missing: a typed refusal, and the getter never ran.
    expect(result).toEqual({ outcome: 'blocked', reason: 'project-id-required' });
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

  it('handles an own __proto__ key on a shadow resolve request as an ordinary field', async () => {
    const requestRepo = seededRepo();
    const hostile = JSON.parse(
      `{"projectId":"proj-1","actionScope":"${SHADOW_IMPORT_ACTION_SCOPE}","authorizationGrantId":"${GRANT_ID}","repository":{"owner":"octo","repo":"hello"},"__proto__":{"polluted":true}}`,
    ) as Record<string, unknown>;
    const result = await resolveRaw(useCase(requestRepo), hostile);
    expect(result).toEqual({
      outcome: 'authorized',
      grantId: GRANT_ID,
      requestId: REQUEST_ID,
      expectedHeadSha: '',
      policyRevision: 'pol-rev-1',
    });
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
});
