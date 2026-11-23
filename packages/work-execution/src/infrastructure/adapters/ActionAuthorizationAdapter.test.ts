import { describe, expect, it } from 'vitest';

import { ActionAuthorizationAdapter } from './ActionAuthorizationAdapter.adapter.js';
import type {
  AuthorizeRelaunchApplyRequest,
  AuthorizeRelaunchApplyResult,
  AuthorizeShadowImportRequest,
  AuthorizeShadowImportResult,
} from '../../application/ports/out/ActionAuthorizationPort.out-port.js';

function shadowRequest(overrides: Partial<AuthorizeShadowImportRequest> = {}): AuthorizeShadowImportRequest {
  return {
    projectId: 'proj-1',
    grantId: 'grant-shadow-1',
    repository: { owner: 'octo', repo: 'hello' },
    nowIso: '2026-11-18T00:00:00Z',
    ...overrides,
  };
}

describe('ActionAuthorizationAdapter.authorizeShadowImport (GR1a2)', () => {
  it('answers unknown authorization-unavailable when the delegate is absent', async () => {
    const adapter = new ActionAuthorizationAdapter();
    const result = await adapter.authorizeShadowImport(shadowRequest());
    expect(result).toEqual({ outcome: 'unknown', reason: 'authorization-unavailable' });
  });

  it('answers unknown authorization-unavailable when the delegate lacks the method', async () => {
    const adapter = new ActionAuthorizationAdapter({});
    const result = await adapter.authorizeShadowImport(shadowRequest());
    expect(result).toEqual({ outcome: 'unknown', reason: 'authorization-unavailable' });
  });

  it('answers unknown authorization-unavailable when the delegate throws', async () => {
    const adapter = new ActionAuthorizationAdapter({
      authorizeShadowImport: async () => {
        throw new Error('delegate blew up');
      },
    });
    const result = await adapter.authorizeShadowImport(shadowRequest());
    expect(result).toEqual({ outcome: 'unknown', reason: 'authorization-unavailable' });
  });

  it('answers unknown authorization-unavailable for an unreadable delegate answer', async () => {
    const adapter = new ActionAuthorizationAdapter({
      authorizeShadowImport: async () => null as unknown as AuthorizeShadowImportResult,
    });
    const result = await adapter.authorizeShadowImport(shadowRequest());
    expect(result).toEqual({ outcome: 'unknown', reason: 'authorization-unavailable' });
  });

  it('passes an authorized answer through with its non-secret grant handle', async () => {
    const adapter = new ActionAuthorizationAdapter({
      authorizeShadowImport: async () => ({ outcome: 'authorized', grantId: 'grant-shadow-1' }),
    });
    const result = await adapter.authorizeShadowImport(shadowRequest());
    expect(result).toEqual({ outcome: 'authorized', grantId: 'grant-shadow-1' });
  });

  it('keeps a clean blocked reason from the delegate', async () => {
    const adapter = new ActionAuthorizationAdapter({
      authorizeShadowImport: async () => ({ outcome: 'blocked', reason: 'grant-expired' }),
    });
    const result = await adapter.authorizeShadowImport(shadowRequest());
    expect(result).toEqual({ outcome: 'blocked', reason: 'grant-expired' });
  });

  it('strips a secret-shaped or path-shaped reason from the delegate', async () => {
    const adapter = new ActionAuthorizationAdapter({
      authorizeShadowImport: async () => ({
        outcome: 'blocked',
        reason:
          'sk-' + '1234567890abcdef'.repeat(2) + ' at /var/fleet/state/grants.json',
      }),
    });
    const result = await adapter.authorizeShadowImport(shadowRequest());
    expect(result).toEqual({ outcome: 'blocked', reason: 'delegate-blocked' });
  });

  it('bounds a delegate that never settles: an expired deadline answers authorization-unavailable', async () => {
    const adapter = new ActionAuthorizationAdapter(
      {
        authorizeShadowImport: () => new Promise<AuthorizeShadowImportResult>(() => {}),
      },
      { shadowImportDelegateDeadlineMs: 20 },
    );
    const result = await adapter.authorizeShadowImport(shadowRequest());
    expect(result).toEqual({ outcome: 'unknown', reason: 'authorization-unavailable' });
  });

  it('refuses a null request as invalid-request without throwing', async () => {
    const adapter = new ActionAuthorizationAdapter({
      authorizeShadowImport: async () => ({ outcome: 'authorized', grantId: 'grant-shadow-1' }),
    });
    const result = await adapter.authorizeShadowImport(null as unknown as AuthorizeShadowImportRequest);
    expect(result).toEqual({ outcome: 'blocked', reason: 'invalid-request' });
  });

  it('refuses a hostile accessor field as invalid-request without running the getter', async () => {
    const adapter = new ActionAuthorizationAdapter({
      authorizeShadowImport: async () => ({ outcome: 'authorized', grantId: 'grant-shadow-1' }),
    });
    let calls = 0;
    const request: Record<string, unknown> = {
      projectId: 'proj-1',
      grantId: 'grant-shadow-1',
      repository: { owner: 'octo', repo: 'hello' },
      nowIso: '2026-11-18T00:00:00Z',
    };
    Object.defineProperty(request, 'projectId', {
      get() {
        calls += 1;
        throw new Error('hostile getter ran');
      },
      enumerable: true,
    });
    const result = await adapter.authorizeShadowImport(request as unknown as AuthorizeShadowImportRequest);
    expect(result).toEqual({ outcome: 'blocked', reason: 'invalid-request' });
    expect(calls).toBe(0);
  });

  it('refuses a hostile Proxy request as invalid-request without throwing', async () => {
    const adapter = new ActionAuthorizationAdapter({
      authorizeShadowImport: async () => ({ outcome: 'authorized', grantId: 'grant-shadow-1' }),
    });
    const target = { projectId: 'proj-1' };
    const proxy = new Proxy(target, {
      get() {
        throw new Error('hostile proxy');
      },
      getOwnPropertyDescriptor() {
        throw new Error('hostile proxy descriptor');
      },
    });
    const result = await adapter.authorizeShadowImport(proxy as unknown as AuthorizeShadowImportRequest);
    expect(result).toEqual({ outcome: 'blocked', reason: 'invalid-request' });
  });

  it('refuses an undefined request as invalid-request without throwing', async () => {
    const adapter = new ActionAuthorizationAdapter({
      authorizeShadowImport: async () => ({ outcome: 'authorized', grantId: 'grant-shadow-1' }),
    });
    const result = await adapter.authorizeShadowImport(undefined as unknown as AuthorizeShadowImportRequest);
    expect(result).toEqual({ outcome: 'blocked', reason: 'invalid-request' });
  });

  it('refuses a wrong-primitive request (a number where a record is due) as invalid-request', async () => {
    const adapter = new ActionAuthorizationAdapter({
      authorizeShadowImport: async () => ({ outcome: 'authorized', grantId: 'grant-shadow-1' }),
    });
    const result = await adapter.authorizeShadowImport(7 as unknown as AuthorizeShadowImportRequest);
    expect(result).toEqual({ outcome: 'blocked', reason: 'invalid-request' });
  });

  it('refuses an array request (non-record where a record is due) as invalid-request', async () => {
    const adapter = new ActionAuthorizationAdapter({
      authorizeShadowImport: async () => ({ outcome: 'authorized', grantId: 'grant-shadow-1' }),
    });
    const sparse = ['grant-shadow-1'];
    delete sparse[0];
    const result = await adapter.authorizeShadowImport(sparse as unknown as AuthorizeShadowImportRequest);
    expect(result).toEqual({ outcome: 'blocked', reason: 'invalid-request' });
  });

  it('refuses an array-like object request as invalid-request', async () => {
    const adapter = new ActionAuthorizationAdapter({
      authorizeShadowImport: async () => ({ outcome: 'authorized', grantId: 'grant-shadow-1' }),
    });
    const arrayLike = { length: 1, 0: 'grant-shadow-1' };
    const result = await adapter.authorizeShadowImport(
      arrayLike as unknown as AuthorizeShadowImportRequest,
    );
    expect(result).toEqual({ outcome: 'blocked', reason: 'invalid-request' });
  });

  it('refuses an enormous sparse array request before any traversal', async () => {
    const adapter = new ActionAuthorizationAdapter({
      authorizeShadowImport: async () => ({ outcome: 'authorized', grantId: 'grant-shadow-1' }),
    });
    const enormous: unknown[] = [];
    (enormous as { length: number }).length = 2 ** 32 - 1;
    const result = await adapter.authorizeShadowImport(enormous as unknown as AuthorizeShadowImportRequest);
    // The refusal happens on the array shape alone, before any element read.
    expect(result).toEqual({ outcome: 'blocked', reason: 'invalid-request' });
  });

  it('never mutates the prototype on a request with an own __proto__ key', async () => {
    const adapter = new ActionAuthorizationAdapter({
      authorizeShadowImport: async () => ({ outcome: 'authorized', grantId: 'grant-shadow-1' }),
    });
    const hostile = JSON.parse(
      '{"projectId":"proj-1","grantId":"grant-shadow-1","__proto__":{"polluted":true},"repository":{"owner":"octo","repo":"hello"},"nowIso":"2026-11-18T00:00:00Z"}',
    ) as Record<string, unknown>;
    const result = await adapter.authorizeShadowImport(hostile as unknown as AuthorizeShadowImportRequest);
    // The polluting key is an unknown field: ignored, never assigned to any
    // prototype, and the request's own fields still validate.
    expect(result).toEqual({ outcome: 'authorized', grantId: 'grant-shadow-1' });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('refuses an authorized answer naming a different grant as grant-id-mismatch', async () => {
    const adapter = new ActionAuthorizationAdapter({
      authorizeShadowImport: async () => ({ outcome: 'authorized', grantId: 'grant-B' }),
    });
    const result = await adapter.authorizeShadowImport(shadowRequest());
    expect(result).toEqual({ outcome: 'blocked', reason: 'grant-id-mismatch' });
  });

  it('never runs a hostile getter on the delegate answer (own data descriptors only)', async () => {
    const adapter = new ActionAuthorizationAdapter({
      authorizeShadowImport: async () => {
        const answer: Record<string, unknown> = { outcome: 'authorized' };
        Object.defineProperty(answer, 'grantId', {
          get() {
            throw new Error('hostile answer getter ran');
          },
          enumerable: true,
        });
        return answer as unknown as AuthorizeShadowImportResult;
      },
    });
    const result = await adapter.authorizeShadowImport(shadowRequest());
    expect(result).toEqual({ outcome: 'unknown', reason: 'authorization-unreadable' });
  });

  it('refuses a hostile Proxy delegate answer as authorization-unavailable without throwing', async () => {
    const adapter = new ActionAuthorizationAdapter({
      authorizeShadowImport: async () => {
        const target = { outcome: 'authorized' };
        return new Proxy(target, {
          get() {
            throw new Error('hostile answer proxy');
          },
          getOwnPropertyDescriptor() {
            throw new Error('hostile answer proxy descriptor');
          },
        }) as unknown as AuthorizeShadowImportResult;
      },
    });
    const result = await adapter.authorizeShadowImport(shadowRequest());
    expect(result).toEqual({ outcome: 'unknown', reason: 'authorization-unavailable' });
  });

  it('refuses a wrong-primitive delegate answer (a string where a record is due)', async () => {
    const adapter = new ActionAuthorizationAdapter({
      authorizeShadowImport: async () => 'authorized grant-shadow-1' as unknown as AuthorizeShadowImportResult,
    });
    const result = await adapter.authorizeShadowImport(shadowRequest());
    expect(result).toEqual({ outcome: 'unknown', reason: 'authorization-unavailable' });
  });

  it('ignores extra keys on a delegate answer whose named grant matches', async () => {
    const adapter = new ActionAuthorizationAdapter({
      authorizeShadowImport: async () => ({
        outcome: 'authorized',
        grantId: 'grant-shadow-1',
        extra: 'ignored',
        secretHint: 'sk-' + '1234567890abcdef'.repeat(2),
      }) as unknown as AuthorizeShadowImportResult,
    });
    const result = await adapter.authorizeShadowImport(shadowRequest());
    expect(result).toEqual({ outcome: 'authorized', grantId: 'grant-shadow-1' });
  });

  it('answers authorization-unavailable for a delegate answer that is a never-settling promise', async () => {
    const adapter = new ActionAuthorizationAdapter(
      {
        authorizeShadowImport: () => new Promise<AuthorizeShadowImportResult>(() => {}),
      },
      { shadowImportDelegateDeadlineMs: 20 },
    );
    const result = await adapter.authorizeShadowImport(shadowRequest());
    expect(result).toEqual({ outcome: 'unknown', reason: 'authorization-unavailable' });
  });
});

// #4g: the local grant map must prefer a resumable release grant (already
// consumed by exactly the resolve's action id) over an unrelated unconsumed
// grant, so a retry after a crash between the consumption and the release's
// write never spends a second approved grant.
import type {
  ResolveActionAuthorizationRequest,
  ResolveActionAuthorizationResult,
} from '../../application/ports/out/ActionAuthorizationPort.out-port.js';
import type { ActionAuthorizationGrantEntry } from './ActionAuthorizationAdapter.adapter.js';

describe('ActionAuthorizationAdapter local grant map (#4g)', () => {
  const HEAD_SHA = 'a'.repeat(40);
  const ROOT = '/srv/fleet/releases';

  function releaseEntry(overrides: Record<string, unknown> = {}): ActionAuthorizationGrantEntry {
    return {
      attemptId: 'att-1',
      expectedHeadSha: HEAD_SHA,
      kind: 'release-swap',
      releaseRoot: ROOT,
      consumedByActionId: null,
      ...overrides,
    } as ActionAuthorizationGrantEntry;
  }

  function resolveRequest(overrides: Partial<ResolveActionAuthorizationRequest> = {}): ResolveActionAuthorizationRequest {
    return {
      actionId: 'action-1',
      projectId: 'project-1',
      workOrderId: 'wo-1',
      attemptId: 'att-1',
      actionKind: 'release-swap',
      expectedHeadSha: HEAD_SHA,
      policyRevision: 'policy-7',
      releaseRoot: ROOT,
      ...overrides,
    };
  }

  function resolve(
    entries: Array<[string, ActionAuthorizationGrantEntry]>,
    request: ResolveActionAuthorizationRequest = resolveRequest(),
  ): Promise<ResolveActionAuthorizationResult> {
    return new ActionAuthorizationAdapter({ grants: new Map(entries) }).resolveActionAuthorization(request);
  }

  it('prefers matching resumable release grant over a second approved grant on retry', async () => {
    const grants: Array<[string, ActionAuthorizationGrantEntry]> = [
      ['grant-1', releaseEntry({ consumedByActionId: 'action-1' })],
      ['grant-2', releaseEntry()],
    ];
    const result = await resolve(grants);
    expect(result).toMatchObject({ outcome: 'granted', authorizationGrantId: 'grant-1' });
  });

  it('still resolves through the unconsumed grant when no grant is consumed by the resuming action', async () => {
    const grants: Array<[string, ActionAuthorizationGrantEntry]> = [
      ['grant-1', releaseEntry({ consumedByActionId: 'other-action' })],
      ['grant-2', releaseEntry()],
    ];
    const result = await resolve(grants);
    expect(result).toMatchObject({ outcome: 'granted', authorizationGrantId: 'grant-2' });
  });

  it('blocks a retry when the only structural match is consumed by another action', async () => {
    const grants: Array<[string, ActionAuthorizationGrantEntry]> = [
      ['grant-1', releaseEntry({ consumedByActionId: 'other-action' })],
    ];
    const result = await resolve(grants);
    expect(result).toEqual({ outcome: 'blocked', reason: 'no-matching-grant' });
  });

  it('blocks an invalid grant record in the map as invalid-grant-record', async () => {
    const grants: Array<[string, ActionAuthorizationGrantEntry]> = [
      ['grant-1', releaseEntry()],
      ['bad/id/path', releaseEntry({ expectedHeadSha: HEAD_SHA })],
    ];
    const result = await resolve(grants);
    expect(result).toEqual({ outcome: 'blocked', reason: 'invalid-grant-record' });
  });

  it('blocks an unknown-schema grant record as unknown-grant-schema-version', async () => {
    const grants: Array<[string, ActionAuthorizationGrantEntry]> = [
      ['grant-1', releaseEntry()],
      ['grant-2', { ...releaseEntry(), schemaVersion: 9 } as unknown as ActionAuthorizationGrantEntry],
    ];
    const result = await resolve(grants);
    expect(result).toEqual({ outcome: 'blocked', reason: 'unknown-grant-schema-version' });
  });

  it('refuses a null resolve request as invalid-request without throwing', async () => {
    const adapter = new ActionAuthorizationAdapter({ grants: new Map([['grant-1', releaseEntry()]]) });
    const result = await adapter.resolveActionAuthorization(null as unknown as ResolveActionAuthorizationRequest);
    expect(result).toEqual({ outcome: 'blocked', reason: 'invalid-request' });
  });

  it('refuses an undefined resolve request as invalid-request without throwing', async () => {
    const adapter = new ActionAuthorizationAdapter({ grants: new Map([['grant-1', releaseEntry()]]) });
    const result = await adapter.resolveActionAuthorization(undefined as unknown as ResolveActionAuthorizationRequest);
    expect(result).toEqual({ outcome: 'blocked', reason: 'invalid-request' });
  });

  it('refuses a wrong-primitive resolve request (a number where a record is due) as invalid-request', async () => {
    const adapter = new ActionAuthorizationAdapter({ grants: new Map([['grant-1', releaseEntry()]]) });
    const result = await adapter.resolveActionAuthorization(7 as unknown as ResolveActionAuthorizationRequest);
    expect(result).toEqual({ outcome: 'blocked', reason: 'invalid-request' });
  });

  it('refuses an array resolve request (non-record where a record is due) as invalid-request', async () => {
    const adapter = new ActionAuthorizationAdapter({ grants: new Map([['grant-1', releaseEntry()]]) });
    const result = await adapter.resolveActionAuthorization([] as unknown as ResolveActionAuthorizationRequest);
    expect(result).toEqual({ outcome: 'blocked', reason: 'invalid-request' });
  });

  it('refuses an enormous sparse array resolve request before any traversal', async () => {
    const adapter = new ActionAuthorizationAdapter({ grants: new Map([['grant-1', releaseEntry()]]) });
    const sparse: unknown[] = [];
    Object.defineProperty(sparse, 'length', { value: 2 ** 32 - 1 });
    const result = await adapter.resolveActionAuthorization(sparse as unknown as ResolveActionAuthorizationRequest);
    expect(result).toEqual({ outcome: 'blocked', reason: 'invalid-request' });
  });

  it('never runs a hostile getter on a resolve request field (own data descriptors only)', async () => {
    const adapter = new ActionAuthorizationAdapter({ grants: new Map([['grant-1', releaseEntry()]]) });
    let getterCalls = 0;
    const request = {
      ...resolveRequest(),
      get projectId(): string {
        getterCalls += 1;
        return 'project-1';
      },
    };
    const result = await adapter.resolveActionAuthorization(request as ResolveActionAuthorizationRequest);
    expect(result).toEqual({ outcome: 'blocked', reason: 'invalid-request' });
    expect(getterCalls).toBe(0);
  });

  it('never mutates the prototype on a resolve request with an own __proto__ key', async () => {
    const adapter = new ActionAuthorizationAdapter({ grants: new Map([['grant-1', releaseEntry()]]) });
    const raw: Record<string, unknown> = { ...resolveRequest() };
    Object.defineProperty(raw, '__proto__', { value: { polluted: true }, enumerable: true });
    const result = await adapter.resolveActionAuthorization(raw as unknown as ResolveActionAuthorizationRequest);
    // A hostile own `__proto__` key is inert data: the resolve yields exactly
    // the plain-data result and never writes through to Object.prototype.
    const clean = await adapter.resolveActionAuthorization(resolveRequest());
    expect(result).toEqual(clean);
    expect(Object.getPrototypeOf({})).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('a constant-verdict implementation would fail: an unrelated blocked map still resolves the resumable grant', async () => {
    const grants: Array<[string, ActionAuthorizationGrantEntry]> = [
      ['grant-1', releaseEntry({ consumedByActionId: 'action-1' })],
    ];
    const result = await resolve(grants);
    expect(result).toMatchObject({ outcome: 'granted', authorizationGrantId: 'grant-1' });
  });

  it('an identity echo of the input would fail: the granted result names the stored grant, not the request', async () => {
    const result = await resolve([['grant-1', releaseEntry({ consumedByActionId: 'action-1' })]]);
    expect('authorizationGrantId' in result).toBe(true);
    expect((result as { authorizationGrantId?: string }).authorizationGrantId).toBe('grant-1');
    expect(result).not.toEqual(resolveRequest());
  });
});

function relaunchRequest(overrides: Partial<AuthorizeRelaunchApplyRequest> = {}): AuthorizeRelaunchApplyRequest {
  return {
    planDigest: 'a'.repeat(64),
    grantId: 'grant-relaunch-1',
    nowIso: '2026-11-18T00:00:00Z',
    ...overrides,
  };
}

describe('ActionAuthorizationAdapter.authorizeRelaunchApply (AR3a)', () => {
  it('answers unknown authorization-unavailable when the delegate or method is absent', async () => {
    const withoutDelegate = await new ActionAuthorizationAdapter().authorizeRelaunchApply(
      relaunchRequest(),
    );
    expect(withoutDelegate).toEqual({ outcome: 'unknown', reason: 'authorization-unavailable' });
    const withoutMethod = await new ActionAuthorizationAdapter({}).authorizeRelaunchApply(
      relaunchRequest(),
    );
    expect(withoutMethod).toEqual({ outcome: 'unknown', reason: 'authorization-unavailable' });
  });

  it('answers unknown authorization-unavailable when the delegate throws', async () => {
    const adapter = new ActionAuthorizationAdapter({
      authorizeRelaunchApply: async () => {
        throw new Error('delegate blew up');
      },
    });
    const result = await adapter.authorizeRelaunchApply(relaunchRequest());
    expect(result).toEqual({ outcome: 'unknown', reason: 'authorization-unavailable' });
  });

  it('answers unknown authorization-unavailable when the delegate never settles', async () => {
    const adapter = new ActionAuthorizationAdapter(
      {
        authorizeRelaunchApply: () =>
          new Promise<AuthorizeRelaunchApplyResult>(() => {}),
      },
      { relaunchApplyDelegateDeadlineMs: 20 },
    );
    const result = await adapter.authorizeRelaunchApply(relaunchRequest());
    expect(result).toEqual({ outcome: 'unknown', reason: 'authorization-unavailable' });
  });

  it('passes an authorized answer through with its non-secret grant handle', async () => {
    const adapter = new ActionAuthorizationAdapter({
      authorizeRelaunchApply: async () => ({ outcome: 'authorized', grantId: 'grant-relaunch-1' }),
    });
    const result = await adapter.authorizeRelaunchApply(relaunchRequest());
    expect(result).toEqual({ outcome: 'authorized', grantId: 'grant-relaunch-1' });
  });

  it('keeps a clean blocked reason from the delegate', async () => {
    const adapter = new ActionAuthorizationAdapter({
      authorizeRelaunchApply: async () => ({ outcome: 'blocked', reason: 'grant-expired' }),
    });
    const result = await adapter.authorizeRelaunchApply(relaunchRequest());
    expect(result).toEqual({ outcome: 'blocked', reason: 'grant-expired' });
  });

  it('strips grant id, secret-shaped, or path-shaped text from delegate blocked reason', async () => {
    const adapter = new ActionAuthorizationAdapter({
      authorizeRelaunchApply: async () => ({
        outcome: 'blocked',
        reason:
          `grant-relaunch-1 rejected: sk-` +
          '1234567890abcdef'.repeat(2) +
          ' at /var/fleet/state/grants.json',
      }),
    });
    const result = await adapter.authorizeRelaunchApply(relaunchRequest());
    // The grant id, the secret shape and the path are all gone: the reason is
    // the fixed fallback, never an echo of the grant.
    expect(result).toEqual({ outcome: 'blocked', reason: 'delegate-blocked' });
  });

  it('scrubs a grant id echoed from a delegate unknown answer', async () => {
    const adapter = new ActionAuthorizationAdapter({
      authorizeRelaunchApply: async () => ({
        outcome: 'unknown',
        reason: 'cannot read grant-relaunch-1',
      }) as unknown as AuthorizeRelaunchApplyResult,
    });
    const result = await adapter.authorizeRelaunchApply(relaunchRequest());
    expect(result).toEqual({ outcome: 'unknown', reason: 'delegate-unknown' });
  });

  it('refuses an authorized answer naming a different grant as grant-id-mismatch', async () => {
    const adapter = new ActionAuthorizationAdapter({
      authorizeRelaunchApply: async () => ({ outcome: 'authorized', grantId: 'grant-B' }),
    });
    const result = await adapter.authorizeRelaunchApply(relaunchRequest());
    expect(result).toEqual({ outcome: 'blocked', reason: 'grant-id-mismatch' });
  });

  it('answers unknown for an unreadable, primitive, or getter-carrying delegate answer', async () => {
    const getterAnswer: Record<string, unknown> = { outcome: 'authorized' };
    Object.defineProperty(getterAnswer, 'grantId', {
      get() {
        throw new Error('hostile answer getter ran');
      },
      enumerable: true,
    });
    const delegates: unknown[] = [
      null,
      'authorized grant-relaunch-1',
      7,
      getterAnswer,
      new Proxy({ outcome: 'authorized' }, {
        get() {
          throw new Error('hostile answer proxy');
        },
        getOwnPropertyDescriptor() {
          throw new Error('hostile answer proxy descriptor');
        },
      }),
    ];
    for (const answer of delegates) {
      const adapter = new ActionAuthorizationAdapter({
        authorizeRelaunchApply: async () => answer as AuthorizeRelaunchApplyResult,
      });
      const result = await adapter.authorizeRelaunchApply(relaunchRequest());
      expect(
        result.outcome === 'unknown' &&
          (result.reason === 'authorization-unavailable' || result.reason === 'authorization-unreadable'),
      ).toBe(true);
    }
  });

  it('refuses a plan digest that is not 64 lowercase hex as invalid-request', async () => {
    const adapter = new ActionAuthorizationAdapter({
      authorizeRelaunchApply: async () => ({ outcome: 'authorized', grantId: 'grant-relaunch-1' }),
    });
    for (const planDigest of ['', 'A'.repeat(64), 'a'.repeat(63), 'a'.repeat(65), 7, undefined]) {
      const result = await adapter.authorizeRelaunchApply(
        relaunchRequest({ planDigest: planDigest as string }) as unknown as AuthorizeRelaunchApplyRequest,
      );
      expect(result).toEqual({ outcome: 'blocked', reason: 'invalid-request' });
    }
  });

  it('refuses a null request as invalid-request without throwing', async () => {
    const adapter = new ActionAuthorizationAdapter({
      authorizeRelaunchApply: async () => ({ outcome: 'authorized', grantId: 'grant-relaunch-1' }),
    });
    const result = await adapter.authorizeRelaunchApply(null as unknown as AuthorizeRelaunchApplyRequest);
    expect(result).toEqual({ outcome: 'blocked', reason: 'invalid-request' });
  });

  it('refuses an undefined request as invalid-request without throwing', async () => {
    const adapter = new ActionAuthorizationAdapter({
      authorizeRelaunchApply: async () => ({ outcome: 'authorized', grantId: 'grant-relaunch-1' }),
    });
    const result = await adapter.authorizeRelaunchApply(undefined as unknown as AuthorizeRelaunchApplyRequest);
    expect(result).toEqual({ outcome: 'blocked', reason: 'invalid-request' });
  });

  it('refuses a wrong-primitive request as invalid-request', async () => {
    const adapter = new ActionAuthorizationAdapter({
      authorizeRelaunchApply: async () => ({ outcome: 'authorized', grantId: 'grant-relaunch-1' }),
    });
    const result = await adapter.authorizeRelaunchApply(42 as unknown as AuthorizeRelaunchApplyRequest);
    expect(result).toEqual({ outcome: 'blocked', reason: 'invalid-request' });
  });

  it('refuses an array request with a hole, an array-like, and an enormous sparse array as invalid-request', async () => {
    const adapter = new ActionAuthorizationAdapter({
      authorizeRelaunchApply: async () => ({ outcome: 'authorized', grantId: 'grant-relaunch-1' }),
    });
    const holed = ['grant-relaunch-1'];
    delete holed[0];
    const arrayLike = { length: 1, 0: 'grant-relaunch-1' };
    const enormous: unknown[] = [];
    (enormous as { length: number }).length = 2 ** 32 - 1;
    for (const hostile of [holed, arrayLike, enormous]) {
      const result = await adapter.authorizeRelaunchApply(hostile as unknown as AuthorizeRelaunchApplyRequest);
      expect(result).toEqual({ outcome: 'blocked', reason: 'invalid-request' });
    }
  });

  it('refuses a hostile accessor field as invalid-request without running the getter', async () => {
    const adapter = new ActionAuthorizationAdapter({
      authorizeRelaunchApply: async () => ({ outcome: 'authorized', grantId: 'grant-relaunch-1' }),
    });
    let calls = 0;
    const request: Record<string, unknown> = { ...relaunchRequest() };
    Object.defineProperty(request, 'grantId', {
      get() {
        calls += 1;
        throw new Error('hostile getter ran');
      },
      enumerable: true,
    });
    const result = await adapter.authorizeRelaunchApply(request as unknown as AuthorizeRelaunchApplyRequest);
    expect(result).toEqual({ outcome: 'blocked', reason: 'invalid-request' });
    expect(calls).toBe(0);
  });

  it('refuses a hostile Proxy request as invalid-request without throwing', async () => {
    const adapter = new ActionAuthorizationAdapter({
      authorizeRelaunchApply: async () => ({ outcome: 'authorized', grantId: 'grant-relaunch-1' }),
    });
    const proxy = new Proxy({ ...relaunchRequest() }, {
      get() {
        throw new Error('hostile proxy');
      },
      getOwnPropertyDescriptor() {
        throw new Error('hostile proxy descriptor');
      },
    });
    const result = await adapter.authorizeRelaunchApply(proxy as unknown as AuthorizeRelaunchApplyRequest);
    expect(result).toEqual({ outcome: 'blocked', reason: 'invalid-request' });
  });

  it('ignores an own __proto__ key without mutating the prototype', async () => {
    const adapter = new ActionAuthorizationAdapter({
      authorizeRelaunchApply: async () => ({ outcome: 'authorized', grantId: 'grant-relaunch-1' }),
    });
    const hostile = JSON.parse(
      `{"planDigest":"${'a'.repeat(64)}","grantId":"grant-relaunch-1","nowIso":"2026-11-18T00:00:00Z","__proto__":{"polluted":true}}`,
    ) as Record<string, unknown>;
    const result = await adapter.authorizeRelaunchApply(hostile as unknown as AuthorizeRelaunchApplyRequest);
    expect(result).toEqual({ outcome: 'authorized', grantId: 'grant-relaunch-1' });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});
