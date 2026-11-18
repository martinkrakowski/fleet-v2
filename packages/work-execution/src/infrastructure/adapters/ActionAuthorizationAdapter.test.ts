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
});
