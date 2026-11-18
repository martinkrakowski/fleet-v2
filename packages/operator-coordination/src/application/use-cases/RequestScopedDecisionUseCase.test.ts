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
  // Every shadow expiry and TTL test measures against this injected clock,
  // never against the request's own nowIso. `null` omits the clock, for the
  // refusal test.
  clock: { readonly nowIso: () => string } | null = { nowIso: () => NOW_ISO },
): RequestScopedDecisionUseCase {
  return new RequestScopedDecisionUseCase({
    requestRepo: repo,
    ...(computeDigest === null ? {} : { computeDigest }),
    ...(clock === null ? {} : { shadowImportClock: clock }),
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

  it('ignores a request-supplied nowIso of 2099 and caps the grant against the injected clock', async () => {
    const repo = new InMemoryCoordinationRequestRepo();
    // 73 years past the injected clock: a requester-supplied nowIso of 2099
    // must not mint this grant. The TTL is measured against the clock.
    const expiresAtIso = '2099-01-20T00:00:00Z';
    const result = await useCaseWith(repo).execute(
      baseRequest({
        requestId: `shadow-import-${digestOf(OWNER, REPO, expiresAtIso)}`,
        shadowImportGrant: { repository: { ...VALID_GRANT.repository }, expiresAtIso },
        nowIso: '2099-01-01T00:00:00Z',
      }),
    );
    expect(result).toEqual({ outcome: 'rejected', reason: 'shadow-import-grant-ttl-exceeded' });
    expect((await repo.listRequests()).length).toBe(0);
  });

  it('records createdAtIso from the injected clock, ignoring a request-supplied nowIso', async () => {
    const repo = new InMemoryCoordinationRequestRepo();
    // The grant is inside the TTL from the clock, but the request claims a
    // 2099 now: the request-supplied nowIso is ignored for both the expiry
    // check and the recorded createdAtIso.
    const expiresAtIso = '2026-12-16T00:00:00Z';
    const result = await useCaseWith(repo).execute(
      baseRequest({
        requestId: `shadow-import-${digestOf(OWNER, REPO, expiresAtIso)}`,
        shadowImportGrant: { repository: { ...VALID_GRANT.repository }, expiresAtIso },
        nowIso: '2099-01-01T00:00:00Z',
      }),
    );
    expect(result.outcome).toBe('requested');
    if (result.outcome === 'requested') {
      expect(result.request.createdAtIso).toBe(NOW_ISO);
      expect(result.request.updatedAtIso).toBe(NOW_ISO);
    }
  });

  it('measures expiry against the injected clock, not the request-supplied nowIso', async () => {
    const repo = new InMemoryCoordinationRequestRepo();
    // The grant is in the future of the request's own nowIso but already
    // past the injected clock: it must be refused as expired.
    const expiresAtIso = '2026-12-16T00:00:00Z';
    const result = await useCaseWith(repo, digest, { nowIso: () => '2027-01-01T00:00:00Z' }).execute(
      baseRequest({
        requestId: `shadow-import-${digestOf(OWNER, REPO, expiresAtIso)}`,
        shadowImportGrant: { repository: { ...VALID_GRANT.repository }, expiresAtIso },
      }),
    );
    expect(result).toEqual({ outcome: 'rejected', reason: 'shadow-import-grant-expired' });
    expect((await repo.listRequests()).length).toBe(0);
  });

  it('refuses a shadow request when the trusted clock is not injected', async () => {
    const repo = new InMemoryCoordinationRequestRepo();
    const result = await useCaseWith(repo, digest, null).execute(baseRequest());
    expect(result).toEqual({ outcome: 'rejected', reason: 'shadow-import-clock-unavailable' });
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
  it('never runs a throwing own nowIso getter and records the trusted clock (main behaviour)', async () => {
    const repo = new InMemoryCoordinationRequestRepo();
    let calls = 0;
    const request: Record<string, unknown> = { ...baseRequest() };
    Object.defineProperty(request, 'nowIso', {
      get() {
        calls += 1;
        throw new Error('hostile nowIso getter ran');
      },
      enumerable: true,
    });
    const result = await useCaseWith(repo).execute(request as unknown);
    expect(result.outcome).toBe('requested');
    expect(calls).toBe(0);
    if (result.outcome === 'requested') {
      expect(result.request.createdAtIso).toBe(NOW_ISO);
    }
    expect((await repo.listRequests()).length).toBe(1);
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
    // The revoke moment is the injected trusted clock, never the
    // request-supplied nowIso.
    expect(stored?.updatedAtIso).toBe(NOW_ISO);
  });

  it('records the injected clock time, ignoring a request nowIso of 2099', async () => {
    const repo = new InMemoryCoordinationRequestRepo();
    await seedStandingGrant(repo);
    const result = await revoke(useCaseWith(repo), {
      grantId: 'grant-shadow',
      nowIso: '2099-01-01T00:00:00Z',
    });
    expect(result).toEqual({ outcome: 'revoked', grantId: 'grant-shadow' });
    expect((await repo.findRequestById('shadow-req-1'))?.updatedAtIso).toBe(NOW_ISO);
  });

  it('still revokes with a request nowIso of "not-a-date", stamping the injected clock', async () => {
    const repo = new InMemoryCoordinationRequestRepo();
    await seedStandingGrant(repo);
    const result = await revoke(useCaseWith(repo), { grantId: 'grant-shadow', nowIso: 'not-a-date' });
    expect(result).toEqual({ outcome: 'revoked', grantId: 'grant-shadow' });
    expect((await repo.findRequestById('shadow-req-1'))?.updatedAtIso).toBe(NOW_ISO);
  });

  it('refuses with shadow-import-clock-unavailable when the trusted clock is not injected', async () => {
    const repo = new InMemoryCoordinationRequestRepo();
    await seedStandingGrant(repo);
    expect(await revoke(useCaseWith(repo, digest, null), { grantId: 'grant-shadow' })).toEqual({
      outcome: 'refused',
      reason: 'shadow-import-clock-unavailable',
    });
    expect((await repo.findRequestById('shadow-req-1'))?.state).toBe('approved');
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

  it('ignores a throwing getter on nowIso — revoked from the clock, getter never run', async () => {
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
    expect(result).toEqual({ outcome: 'revoked', grantId: 'grant-shadow' });
    expect(calls).toBe(0);
    expect((await repo.findRequestById('shadow-req-1'))?.updatedAtIso).toBe(NOW_ISO);
  });

  it('ignores a present non-string nowIso (42) and stamps the injected clock', async () => {
    const repo = new InMemoryCoordinationRequestRepo();
    await seedStandingGrant(repo);
    expect(
      await revoke(useCaseWith(repo), { grantId: 'grant-shadow', nowIso: 42 as unknown as string }),
    ).toEqual({ outcome: 'revoked', grantId: 'grant-shadow' });
    expect((await repo.findRequestById('shadow-req-1'))?.updatedAtIso).toBe(NOW_ISO);
  });

  it('reads each own key once during the snapshot and never touches the request afterwards', async () => {
    const repo = new InMemoryCoordinationRequestRepo();
    await seedStandingGrant(repo);
    const descriptorCalls: Record<string, number> = {};
    const target: Record<string, unknown> = { grantId: 'grant-shadow' };
    const proxy = new Proxy(target, {
      getOwnPropertyDescriptor(t, prop) {
        const key = String(prop);
        descriptorCalls[key] = (descriptorCalls[key] ?? 0) + 1;
        return Reflect.getOwnPropertyDescriptor(t, prop);
      },
    });
    const result = await revoke(useCaseWith(repo), proxy as unknown as RevokeOwnerGrantRequest);
    expect(result).toEqual({ outcome: 'revoked', grantId: 'grant-shadow' });
    // Every own key of the request was read through its descriptor exactly
    // once — the single snapshot — and no read happened after it.
    expect(descriptorCalls).toEqual({ grantId: 1 });
    expect((await repo.findRequestById('shadow-req-1'))?.state).toBe('cancelled');
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

describe('RequestScopedDecisionUseCase ordinary decisions stay as on main (GR1a1 fix round)', () => {
  function ordinaryRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      requestId: 'req-ordinary-1',
      projectId: 'proj-alpha',
      kind: 'action-decision',
      actionScope: 'host:restart',
      expectedHeadSha: 'abc123',
      proposalDigest: 'sha256-proposal',
      policyRevision: 'pol-rev-1',
      nowIso: NOW_ISO,
      ...overrides,
    };
  }

  it('ignores an unknown body key exactly as main does (no new rejection)', async () => {
    const repo = new InMemoryCoordinationRequestRepo();
    const result = await useCaseWith(repo).execute(ordinaryRequest({ unknownBodyKey: 'whatever' }));
    expect(result.outcome).toBe('requested');
    if (result.outcome === 'requested') {
      expect(result.request.actionScope).toBe('host:restart');
    }
  });

  it('falls back to the clock for nowIso: null exactly as main does', async () => {
    const repo = new InMemoryCoordinationRequestRepo();
    const before = new Date().toISOString();
    const result = await useCaseWith(repo).execute(ordinaryRequest({ nowIso: null }));
    expect(result.outcome).toBe('requested');
    if (result.outcome === 'requested') {
      expect(result.request.createdAtIso >= before).toBe(true);
      expect(result.request.createdAtIso).not.toBe(NOW_ISO);
    }
  });

  it('falls back to the clock for nowIso: \'\' exactly as main does (host:restart)', async () => {
    const repo = new InMemoryCoordinationRequestRepo();
    const before = new Date().toISOString();
    const result = await useCaseWith(repo).execute(ordinaryRequest({ nowIso: '' }));
    expect(result.outcome).toBe('requested');
    if (result.outcome === 'requested') {
      expect(result.request.createdAtIso >= before).toBe(true);
      expect(result.request.createdAtIso).not.toBe(NOW_ISO);
    }
  });

  it('falls back to the clock for nowIso: 42 exactly as main does (host:restart)', async () => {
    const repo = new InMemoryCoordinationRequestRepo();
    const before = new Date().toISOString();
    const result = await useCaseWith(repo).execute(ordinaryRequest({ nowIso: 42 }));
    expect(result.outcome).toBe('requested');
    if (result.outcome === 'requested') {
      expect(result.request.createdAtIso >= before).toBe(true);
      expect(result.request.createdAtIso).not.toBe(NOW_ISO);
    }
  });

  it('handles a body with an own __proto__ key exactly as on main', async () => {
    const repo = new InMemoryCoordinationRequestRepo();
    // `JSON.parse` gives the body a real own `__proto__` key, exactly as an
    // HTTP body carrying one arrives; the spread copies it as data, without
    // invoking the inherited setter.
    const hostile = {
      ...ordinaryRequest({ unknownBodyKey: 'whatever' }),
      ...(JSON.parse('{"__proto__":{"polluted":true}}') as Record<string, unknown>),
    };
    const result = await useCaseWith(repo).execute(hostile);
    // Main accepted the body and ignored the unknown keys, so the fixed
    // snapshot must accept it too — and never mutate Object.prototype.
    expect(result.outcome).toBe('requested');
    if (result.outcome === 'requested') {
      expect(result.request.actionScope).toBe('host:restart');
    }
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('does not inherit decision fields from an own __proto__ key (GR1a2 fix round)', async () => {
    const repo = new InMemoryCoordinationRequestRepo();
    // `JSON.parse` gives the body a real own `__proto__` key, here carrying
    // decision fields. On main the body is accepted and its own fields decide;
    // nothing inside `__proto__` is inherited into the request — a snapshot
    // built on `{}` would set its prototype and let `nowIso` be inherited.
    const withoutClock: Record<string, unknown> = { ...ordinaryRequest() };
    delete withoutClock.nowIso;
    const hostile = {
      ...withoutClock,
      ...(JSON.parse(
        '{"__proto__":{"nowIso":"2099-01-01T00:00:00.000Z","state":"approved"}}',
      ) as Record<string, unknown>),
    };
    const before = new Date().toISOString();
    const result = await useCaseWith(repo).execute(hostile);
    // Handled exactly as on main: `nowIso` is absent from the body itself, so
    // the wall clock falls back in — the `__proto__`-carried value never does.
    expect(result.outcome).toBe('requested');
    if (result.outcome === 'requested') {
      expect(result.request.createdAtIso).not.toBe('2099-01-01T00:00:00.000Z');
      expect(result.request.createdAtIso >= before).toBe(true);
    }
    expect(({} as Record<string, unknown>).state).toBeUndefined();
  });

  it('maps a throwing getPrototypeOf trap to the invalid-request refusal', async () => {
    const repo = new InMemoryCoordinationRequestRepo();
    const proxy = new Proxy(ordinaryRequest(), {
      getPrototypeOf() {
        throw new Error('hostile getPrototypeOf trap');
      },
    });
    await expect(useCaseWith(repo).execute(proxy)).resolves.toEqual({
      outcome: 'rejected',
      reason: 'invalid-request',
    });
  });

  it('maps a throwing ownKeys trap to the invalid-request refusal', async () => {
    const repo = new InMemoryCoordinationRequestRepo();
    const proxy = new Proxy(ordinaryRequest(), {
      ownKeys() {
        throw new Error('hostile ownKeys trap');
      },
    });
    await expect(useCaseWith(repo).execute(proxy)).resolves.toEqual({
      outcome: 'rejected',
      reason: 'invalid-request',
    });
  });

  it('maps a throwing getOwnPropertyDescriptor trap to the invalid-request refusal', async () => {
    const repo = new InMemoryCoordinationRequestRepo();
    const proxy = new Proxy(ordinaryRequest(), {
      getOwnPropertyDescriptor() {
        throw new Error('hostile getOwnPropertyDescriptor trap');
      },
    });
    await expect(useCaseWith(repo).execute(proxy)).resolves.toEqual({
      outcome: 'rejected',
      reason: 'invalid-request',
    });
  });
});

describe('RequestScopedDecisionUseCase release grants (RR1)', () => {
  const HEAD = '1111111111111111111111111111111111111111';
  const ROOT = '/srv/fleet/releases';
  const NONCE = '0123456789abcdef0123456789abcdef';
  const NONCE_2 = 'fedcba9876543210fedcba9876543210';

  function releaseGrantPayload(grant: Record<string, unknown>): string {
    return JSON.stringify({
      scope: grant.actionScope,
      projectId: grant.projectId,
      expectedHeadSha: grant.expectedHeadSha,
      releaseRoot: grant.releaseRoot,
      nonce: grant.nonce,
    });
  }

  function releaseRequestId(grant: Record<string, unknown>): string {
    return `release-grant-${digest(releaseGrantPayload(grant))}`;
  }

  function releaseRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    const grant = {
      actionScope: 'release:install',
      projectId: 'proj-alpha',
      expectedHeadSha: HEAD,
      releaseRoot: ROOT,
      nonce: NONCE,
      ...overrides,
    };
    return {
      requestId: releaseRequestId(grant),
      projectId: grant.projectId,
      kind: 'action-decision',
      actionScope: grant.actionScope,
      expectedHeadSha: grant.expectedHeadSha,
      proposalDigest: 'sha256-proposal',
      policyRevision: 'pol-rev-1',
      releaseRoot: grant.releaseRoot,
      releaseNonce: grant.nonce,
      nowIso: NOW_ISO,
      ...overrides,
    };
  }

  it('accepts a valid digest-bound release request and records its root', async () => {
    const repo = new InMemoryCoordinationRequestRepo();
    const result = await useCaseWith(repo).execute(releaseRequest());
    expect(result.outcome).toBe('requested');
    if (result.outcome === 'requested') {
      expect(result.request.releaseRoot).toBe(ROOT);
      expect(result.request.releaseNonce).toBe(NONCE);
      expect(result.request.expectedHeadSha).toBe(HEAD);
    }
  });

  it('rejects a release scope without a releaseRoot with release-root-required', async () => {
    const repo = new InMemoryCoordinationRequestRepo();
    const request = releaseRequest();
    delete request.releaseRoot;
    const result = await useCaseWith(repo).execute(request);
    expect(result).toEqual({ outcome: 'rejected', reason: 'release-root-required' });
    expect((await repo.listRequests()).length).toBe(0);
  });

  it('rejects a release scope with an invalid releaseRoot (accessor included)', async () => {
    const repo = new InMemoryCoordinationRequestRepo();
    const invalid = await useCaseWith(repo).execute(releaseRequest({ releaseRoot: '/srv/../etc' }));
    expect(invalid).toEqual({
      outcome: 'rejected',
      reason: 'a decision request releaseRoot must be a bounded absolute path without ".." when given',
    });
    let calls = 0;
    const accessor = releaseRequest();
    Object.defineProperty(accessor, 'releaseRoot', {
      get() {
        calls += 1;
        return ROOT;
      },
      enumerable: true,
    });
    const accessorResult = await useCaseWith(repo).execute(accessor);
    expect(accessorResult).toEqual({
      outcome: 'rejected',
      reason: 'a decision request releaseRoot must be a bounded absolute path without ".." when given',
    });
    expect(calls).toBe(0);
    expect((await repo.listRequests()).length).toBe(0);
  });

  it(`rejects a non-release scope carrying releaseRoot with release-root-forbidden-for-scope (NEW, RR1)`, async () => {
    const repo = new InMemoryCoordinationRequestRepo();
    const request = releaseRequest({ actionScope: 'forge:merge-pr', attemptId: 'att-1' });
    request.requestId = 'req-ordinary-release-root';
    const result = await useCaseWith(repo).execute(request);
    expect(result).toEqual({ outcome: 'rejected', reason: 'release-root-forbidden-for-scope' });
    // An accessor carrying the root is refused the same way, and never runs.
    let calls = 0;
    const accessor = releaseRequest({ actionScope: 'forge:merge-pr', attemptId: 'att-1' });
    accessor.requestId = 'req-ordinary-accessor';
    Object.defineProperty(accessor, 'releaseRoot', {
      get() {
        calls += 1;
        return ROOT;
      },
      enumerable: true,
    });
    const accessorResult = await useCaseWith(repo).execute(accessor);
    expect(accessorResult).toEqual({ outcome: 'rejected', reason: 'release-root-forbidden-for-scope' });
    expect(calls).toBe(0);
    expect((await repo.listRequests()).length).toBe(0);
  });

  it('rejects a release scope without an expected head with release-expected-head-required', async () => {
    const repo = new InMemoryCoordinationRequestRepo();
    const result = await useCaseWith(repo).execute(releaseRequest({ expectedHeadSha: null }));
    expect(result).toEqual({ outcome: 'rejected', reason: 'release-expected-head-required' });
    expect((await repo.listRequests()).length).toBe(0);
  });

  it('rejects a release scope without computeDigest with release-grant-digest-unavailable', async () => {
    const repo = new InMemoryCoordinationRequestRepo();
    const result = await useCaseWith(repo, null).execute(releaseRequest());
    expect(result).toEqual({ outcome: 'rejected', reason: 'release-grant-digest-unavailable' });
    expect((await repo.listRequests()).length).toBe(0);
  });

  it('rejects a release request whose id does not carry the digest with release-grant-request-digest-mismatch', async () => {
    const repo = new InMemoryCoordinationRequestRepo();
    const result = await useCaseWith(repo).execute(releaseRequest({ requestId: 'release-grant-not-the-digest' }));
    expect(result).toEqual({ outcome: 'rejected', reason: 'release-grant-request-digest-mismatch' });
    expect((await repo.listRequests()).length).toBe(0);
  });

  it('is neither constant nor identity: accepted and refused release requests differ, and the digest moves with the root', async () => {
    const repo = new InMemoryCoordinationRequestRepo();
    expect((await useCaseWith(repo).execute(releaseRequest())).outcome).toBe('requested');
    const refused = await useCaseWith(repo).execute(releaseRequest({ requestId: 'hand-typed' }));
    expect(refused).toEqual({ outcome: 'rejected', reason: 'release-grant-request-digest-mismatch' });
    // A different root hashes to a different id: the same hand-typed id for
    // another root is refused too, never accepted as the first grant.
    const otherRootRequest = releaseRequest({ releaseRoot: '/srv/fleet/other' });
    otherRootRequest.requestId = releaseRequestId({
      actionScope: 'release:install',
      projectId: 'proj-alpha',
      expectedHeadSha: HEAD,
      releaseRoot: ROOT,
      nonce: NONCE,
    });
    const otherRoot = await useCaseWith(repo).execute(otherRootRequest);
    expect(otherRoot).toEqual({ outcome: 'rejected', reason: 'release-grant-request-digest-mismatch' });
  });

  it('accepts a second request for identical coordinates under a new nonce, with a new id', async () => {
    const repo = new InMemoryCoordinationRequestRepo();
    const first = releaseRequest();
    const second = releaseRequest({ nonce: NONCE_2, releaseNonce: NONCE_2 });
    expect(second.requestId).not.toBe(first.requestId);
    const a = await useCaseWith(repo).execute(first);
    const b = await useCaseWith(repo).execute(second);
    expect(a.outcome).toBe('requested');
    expect(b.outcome).toBe('requested');
    // The same nonce replays to the same id, which stays refused as already recorded.
    const replay = await useCaseWith(repo).execute(first);
    expect(replay.outcome).toBe('rejected');
  });

  it('rejects a release request with a missing or malformed nonce with release-grant-invalid-nonce', async () => {
    for (const bad of [undefined, '', 'short', NONCE.toUpperCase(), `${NONCE}0`]) {
      const repo = new InMemoryCoordinationRequestRepo();
      const request = releaseRequest();
      if (bad === undefined) {
        delete request.releaseNonce;
      } else {
        request.releaseNonce = bad;
      }
      const result = await useCaseWith(repo).execute(request);
      expect(result).toEqual({ outcome: 'rejected', reason: 'release-grant-invalid-nonce' });
    }
  });
});
