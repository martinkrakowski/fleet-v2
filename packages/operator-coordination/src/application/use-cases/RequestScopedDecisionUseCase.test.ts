import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { CoordinationRequestRecord } from '../../domain/coordination-records.js';
import { SHADOW_IMPORT_ACTION_SCOPE, SHADOW_IMPORT_GRANT_MAX_TTL_DAYS } from '../../domain/coordination-records.js';
import type { CoordinationRequestRepositoryPort } from '../ports/out/CoordinationRequestRepositoryPort.out-port.js';
import { CoordinationRequestRevisionConflictError } from '../ports/out/CoordinationRequestRepositoryPort.out-port.js';
import type {
  RevokeOwnerGrantRequest,
  RevokeOwnerGrantResult,
} from '../ports/in/RequestScopedDecisionPort.in-port.js';
import { RequestScopedDecisionUseCase } from './RequestScopedDecisionUseCase.use-case.js';

class InMemoryCoordinationRequestRepo implements CoordinationRequestRepositoryPort {
  readonly requests = new Map<string, CoordinationRequestRecord>();

  async saveRequest(record: CoordinationRequestRecord): Promise<void> {
    this.requests.set(record.id, record);
  }

  async findRequestById(requestId: string): Promise<CoordinationRequestRecord | null> {
    return this.requests.get(requestId) ?? null;
  }

  async findRequestByGrantId(grantId: string): Promise<CoordinationRequestRecord | null> {
    for (const request of this.requests.values()) {
      if (request.grantId === grantId) return request;
    }
    return null;
  }

  async listRequests(projectId?: string): Promise<readonly CoordinationRequestRecord[]> {
    const all = Array.from(this.requests.values());
    return projectId ? all.filter((r) => r.projectId === projectId) : all;
  }
}

class ConflictOnUpdateRepo extends InMemoryCoordinationRequestRepo {
  async saveRequest(record: CoordinationRequestRecord): Promise<void> {
    if (this.requests.has(record.id)) {
      throw new CoordinationRequestRevisionConflictError(record.id, record.revision, 'another writer moved it first');
    }
    await super.saveRequest(record);
  }
}

const NOW_ISO = '2026-11-18T00:00:00Z';
const OWNER = 'octo';
const REPO = 'hello';
// 28 days after NOW_ISO: inside the 30-day TTL cap.
const EXPIRES_AT_ISO = '2026-12-16T00:00:00Z';
const VALID_GRANT = { repository: { owner: OWNER, repo: REPO }, expiresAtIso: EXPIRES_AT_ISO };

function digest(payload: string): string {
  return createHash('sha256').update(payload).digest('hex');
}

function digestOf(owner: string, repo: string, expiresAtIso: string): string {
  return digest(
    JSON.stringify({ scope: SHADOW_IMPORT_ACTION_SCOPE, owner, repo, expiresAtIso }),
  );
}

const REQUEST_ID = `${'shadow-import-'}${digestOf(OWNER, REPO, EXPIRES_AT_ISO)}`;

function baseRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    requestId: REQUEST_ID,
    projectId: 'proj-alpha',
    kind: 'action-decision',
    actionScope: SHADOW_IMPORT_ACTION_SCOPE,
    expectedHeadSha: null,
    proposalDigest: 'sha256-proposal',
    policyRevision: 'pol-rev-1',
    nowIso: NOW_ISO,
    shadowImportGrant: { repository: { ...VALID_GRANT.repository }, expiresAtIso: EXPIRES_AT_ISO },
    ...overrides,
  };
}

function useCaseWith(
  repo: CoordinationRequestRepositoryPort,
  computeDigest: ((payload: string) => string) | null = digest,
): RequestScopedDecisionUseCase {
  return new RequestScopedDecisionUseCase({
    requestRepo: repo,
    ...(computeDigest === null ? {} : { computeDigest }),
  });
}

async function revoke(
  useCase: RequestScopedDecisionUseCase,
  request: RevokeOwnerGrantRequest,
): Promise<RevokeOwnerGrantResult> {
  return useCase.revokeOwnerGrant(request) as Promise<RevokeOwnerGrantResult>;
}

describe('RequestScopedDecisionUseCase shadow import grants (GR1a1)', () => {
  it('accepts a valid standing shadow import request and records its grant', async () => {
    const repo = new InMemoryCoordinationRequestRepo();
    const result = await useCaseWith(repo).execute(baseRequest());
    expect(result.outcome).toBe('requested');
    if (result.outcome === 'requested') {
      expect(result.request.actionScope).toBe(SHADOW_IMPORT_ACTION_SCOPE);
      expect(result.request.expectedHeadSha).toBeNull();
      expect(result.request.shadowImportGrant).toEqual(VALID_GRANT);
      expect(result.request.grantId).toBeNull();
      expect((await repo.findRequestById(REQUEST_ID))?.state).toBe('awaiting-decision');
    }
  });

  it('rejects missing or invalid shadowImportGrant', async () => {
    const repo = new InMemoryCoordinationRequestRepo();
    const missing = await useCaseWith(repo).execute(baseRequest({ shadowImportGrant: undefined }));
    expect(missing).toEqual({ outcome: 'rejected', reason: 'shadow-import-grant-not-object' });
    const malformed = await useCaseWith(repo).execute(
      baseRequest({ shadowImportGrant: { repository: { owner: 42, repo: REPO }, expiresAtIso: EXPIRES_AT_ISO } }),
    );
    expect(malformed).toEqual({ outcome: 'rejected', reason: 'shadow-import-grant-invalid-repository' });
    const pastTimestamp = await useCaseWith(repo).execute(
      baseRequest({
        requestId: `shadow-import-${digestOf(OWNER, REPO, '2026-11-18T00:00:00')}`,
        shadowImportGrant: { repository: { ...VALID_GRANT.repository }, expiresAtIso: '2026-11-18T00:00:00' },
      }),
    );
    expect(pastTimestamp).toEqual({ outcome: 'rejected', reason: 'shadow-import-grant-invalid-expiry' });
    expect((await repo.listRequests()).length).toBe(0);
  });

  it('rejects non-null expectedHeadSha on a merge:import-shadow request', async () => {
    const repo = new InMemoryCoordinationRequestRepo();
    const result = await useCaseWith(repo).execute(
      baseRequest({ expectedHeadSha: '1111111111111111111111111111111111111111' }),
    );
    expect(result).toEqual({ outcome: 'rejected', reason: 'shadow-import-expected-head-not-null' });
    expect((await repo.listRequests()).length).toBe(0);
  });

  it('rejects past or equal expiresAtIso', async () => {
    const repo = new InMemoryCoordinationRequestRepo();
    for (const expiresAtIso of ['2026-11-17T00:00:00Z', NOW_ISO]) {
      const result = await useCaseWith(repo).execute(
        baseRequest({
          requestId: `shadow-import-${digestOf(OWNER, REPO, expiresAtIso)}`,
          shadowImportGrant: { repository: { ...VALID_GRANT.repository }, expiresAtIso },
        }),
      );
      expect(result).toEqual({ outcome: 'rejected', reason: 'shadow-import-grant-expired' });
    }
    expect((await repo.listRequests()).length).toBe(0);
  });

  it(`rejects TTL exceeding ${SHADOW_IMPORT_GRANT_MAX_TTL_DAYS} days`, async () => {
    const repo = new InMemoryCoordinationRequestRepo();
    // 60 days after NOW_ISO: past the cap, still in the future.
    const expiresAtIso = '2027-01-17T00:00:00Z';
    const result = await useCaseWith(repo).execute(
      baseRequest({
        requestId: `shadow-import-${digestOf(OWNER, REPO, expiresAtIso)}`,
        shadowImportGrant: { repository: { ...VALID_GRANT.repository }, expiresAtIso },
      }),
    );
    expect(result).toEqual({ outcome: 'rejected', reason: 'shadow-import-grant-ttl-exceeded' });
    expect((await repo.listRequests()).length).toBe(0);
  });

  it('rejects when computeDigest is absent', async () => {
    const repo = new InMemoryCoordinationRequestRepo();
    const configured = useCaseWith(repo, null);
    const typed = await configured.execute(baseRequest());
    expect(typed).toEqual({ outcome: 'rejected', reason: 'shadow-import-digest-unavailable' });
    expect((await repo.listRequests()).length).toBe(0);
  });

  it('rejects mismatched requestId digest', async () => {
    const repo = new InMemoryCoordinationRequestRepo();
    const result = await useCaseWith(repo).execute(baseRequest({ requestId: 'shadow-import-not-the-digest' }));
    expect(result).toEqual({ outcome: 'rejected', reason: 'shadow-import-request-digest-mismatch' });
    expect((await repo.listRequests()).length).toBe(0);
  });

  it('propagates a typed parser refusal for a getter-carrying grant without running it', async () => {
    const repo = new InMemoryCoordinationRequestRepo();
    let calls = 0;
    const grant: Record<string, unknown> = {};
    Object.defineProperty(grant, 'expiresAtIso', {
      get() {
        calls += 1;
        return EXPIRES_AT_ISO;
      },
      enumerable: true,
    });
    grant.repository = { owner: OWNER, repo: REPO };
    const result = await useCaseWith(repo).execute(baseRequest({ shadowImportGrant: grant }));
    expect(result).toEqual({ outcome: 'rejected', reason: 'shadow-import-grant-accessor-forbidden' });
    expect(calls).toBe(0);
    expect((await repo.listRequests()).length).toBe(0);
  });
});

describe('RequestScopedDecisionUseCase.revokeOwnerGrant (GR1a1)', () => {
  async function seedStandingGrant(
    repo: CoordinationRequestRepositoryPort,
    overrides: Partial<CoordinationRequestRecord> = {},
  ): Promise<void> {
    await repo.saveRequest({
      id: 'shadow-req-1',
      projectId: 'proj-alpha',
      kind: 'action-decision',
      state: 'approved',
      actionScope: SHADOW_IMPORT_ACTION_SCOPE,
      expectedHeadSha: null,
      proposalDigest: 'sha256-proposal',
      policyRevision: 'pol-rev-1',
      decisionRevision: 'dec-rev-1',
      grantId: 'grant-shadow',
      consumptions: [],
      acknowledgements: [],
      deliveryStatus: 'delivered',
      deliveryGapReason: null,
      revision: 1,
      createdAtIso: NOW_ISO,
      updatedAtIso: NOW_ISO,
      shadowImportGrant: { ...VALID_GRANT },
      ...overrides,
    });
  }

  it('revokes a standing shadow import grant', async () => {
    const repo = new InMemoryCoordinationRequestRepo();
    await seedStandingGrant(repo);
    const result = await revoke(useCaseWith(repo), { grantId: 'grant-shadow', nowIso: '2026-11-19T00:00:00Z' });
    expect(result).toEqual({ outcome: 'revoked', grantId: 'grant-shadow' });
    const stored = await repo.findRequestById('shadow-req-1');
    expect(stored?.state).toBe('cancelled');
    expect(stored?.revision).toBe(2);
    expect(stored?.updatedAtIso).toBe('2026-11-19T00:00:00Z');
  });

  it('refuses a missing grant with grant-missing', async () => {
    const repo = new InMemoryCoordinationRequestRepo();
    expect(await revoke(useCaseWith(repo), { grantId: 'grant-shadow' })).toEqual({
      outcome: 'refused',
      reason: 'grant-missing',
    });
  });

  it('refuses a non-shadow scope with grant-wrong-scope', async () => {
    const repo = new InMemoryCoordinationRequestRepo();
    await seedStandingGrant(repo, {
      id: 'forge-req-1',
      grantId: 'grant-push',
      actionScope: 'forge:push-and-open-pr',
      expectedHeadSha: 'head-H',
      shadowImportGrant: undefined,
    });
    expect(await revoke(useCaseWith(repo), { grantId: 'grant-push' })).toEqual({
      outcome: 'refused',
      reason: 'grant-wrong-scope',
    });
    expect((await repo.findRequestById('forge-req-1'))?.state).toBe('approved');
  });

  it('refuses an already-revoked grant with grant-already-revoked', async () => {
    const repo = new InMemoryCoordinationRequestRepo();
    await seedStandingGrant(repo, { state: 'cancelled' });
    expect(await revoke(useCaseWith(repo), { grantId: 'grant-shadow' })).toEqual({
      outcome: 'refused',
      reason: 'grant-already-revoked',
    });
  });

  it('refuses another terminal grant with grant-not-revocable', async () => {
    for (const state of ['declined', 'expired', 'completed'] as const) {
      const repo = new InMemoryCoordinationRequestRepo();
      await seedStandingGrant(repo, { state });
      expect(await revoke(useCaseWith(repo), { grantId: 'grant-shadow' })).toEqual({
        outcome: 'refused',
        reason: 'grant-not-revocable',
      });
    }
  });

  it('refuses a revision race with revision-conflict', async () => {
    const repo = new ConflictOnUpdateRepo();
    await seedStandingGrant(repo);
    expect(await revoke(useCaseWith(repo), { grantId: 'grant-shadow' })).toEqual({
      outcome: 'refused',
      reason: 'revision-conflict',
    });
    expect((await repo.findRequestById('shadow-req-1'))?.state).toBe('approved');
  });

  it('refuses a throwing getter on grantId with a typed refusal, never running it', async () => {
    const repo = new InMemoryCoordinationRequestRepo();
    await seedStandingGrant(repo);
    let calls = 0;
    const request: Record<string, unknown> = {};
    Object.defineProperty(request, 'grantId', {
      get() {
        calls += 1;
        return 'grant-shadow';
      },
      enumerable: true,
    });
    const result = await revoke(useCaseWith(repo), request as unknown as RevokeOwnerGrantRequest);
    expect(result).toEqual({ outcome: 'refused', reason: 'grant-missing' });
    expect(calls).toBe(0);
    expect((await repo.findRequestById('shadow-req-1'))?.state).toBe('approved');
  });

  it('refuses a throwing getter on nowIso with a typed refusal, never running it', async () => {
    const repo = new InMemoryCoordinationRequestRepo();
    await seedStandingGrant(repo);
    let calls = 0;
    const request: Record<string, unknown> = { grantId: 'grant-shadow' };
    Object.defineProperty(request, 'nowIso', {
      get() {
        calls += 1;
        return '2026-11-19T00:00:00Z';
      },
      enumerable: true,
    });
    const result = await revoke(useCaseWith(repo), request as unknown as RevokeOwnerGrantRequest);
    expect(result).toEqual({ outcome: 'refused', reason: 'grant-missing' });
    expect(calls).toBe(0);
    expect((await repo.findRequestById('shadow-req-1'))?.state).toBe('approved');
  });

  it('is neither constant nor identity: revoked and refused outcomes differ by grant state', async () => {
    const standing = new InMemoryCoordinationRequestRepo();
    await seedStandingGrant(standing);
    const revoked = await revoke(useCaseWith(standing), { grantId: 'grant-shadow' });
    expect(revoked.outcome).toBe('revoked');
    const missing = new InMemoryCoordinationRequestRepo();
    const refused = await revoke(useCaseWith(missing), { grantId: 'grant-shadow' });
    expect(refused.outcome).toBe('refused');
  });
});
