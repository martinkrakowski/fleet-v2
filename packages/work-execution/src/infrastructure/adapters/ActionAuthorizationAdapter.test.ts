import { describe, expect, it } from 'vitest';

import { ActionAuthorizationAdapter } from './ActionAuthorizationAdapter.adapter.js';
import type {
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
        reason: 'sk-1234567890abcdef1234567890abcdef at /var/fleet/state/grants.json',
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
        secretHint: 'sk-1234567890abcdef1234567890abcdef',
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
