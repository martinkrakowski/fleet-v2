import { describe, expect, it } from 'vitest';

import { resolvePinnedOwnerPublicKey, MAX_OWNER_KEY_ENV_LENGTH } from './owner-key.js';
import { canonicalDecisionBytes } from './DecisionSignature.adapter.js';
import { DecisionTransportAdapter } from './DecisionTransportAdapter.adapter.js';
import type { DecisionAnswerQuery } from '../../application/ports/out/DecisionTransportPort.out-port.js';
import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';

const PINNED = 'iVBORw0KGgoAAAANSUhEUg==';

function envWith(value: string | undefined): Record<string, string | undefined> {
  return value === undefined ? {} : { FLEET_OWNER_PUBLIC_KEY: value };
}

describe('resolvePinnedOwnerPublicKey', () => {
  it('a pinned key with no env variable resolves as pinned with no deprecation warning', () => {
    const resolved = resolvePinnedOwnerPublicKey(PINNED, envWith(undefined));
    expect(resolved).toEqual({ status: 'pinned', publicKey: PINNED });
  });

  it('an env variable equal to the pinned key resolves as pinned with a single-line deprecation warning that never carries the key value', () => {
    const resolved = resolvePinnedOwnerPublicKey(PINNED, envWith(PINNED));
    expect(resolved.status).toBe('pinned');
    if (resolved.status === 'pinned') {
      expect(resolved.deprecationWarning).toBeDefined();
      expect(resolved.deprecationWarning?.split('\n')).toHaveLength(1);
      expect(resolved.deprecationWarning).not.toContain(PINNED);
    }
  });

  it('the env value is trimmed before it is compared with the pinned key', () => {
    const resolved = resolvePinnedOwnerPublicKey(PINNED, envWith(`  ${PINNED}  `));
    expect(resolved.status).toBe('pinned');
    if (resolved.status === 'pinned') {
      expect(resolved.deprecationWarning).toBeDefined();
    }
  });

  it('an env variable that differs from the pinned key resolves as owner-key-env-mismatch', () => {
    const resolved = resolvePinnedOwnerPublicKey(PINNED, envWith('Zm9l'));
    expect(resolved).toEqual({ status: 'env-mismatch', code: 'owner-key-env-mismatch' });
  });

  it('a blank env variable is not an authority and resolves as pinned', () => {
    const resolved = resolvePinnedOwnerPublicKey(PINNED, envWith('   '));
    expect(resolved).toEqual({ status: 'pinned', publicKey: PINNED });
  });

  it('an env value longer than MAX_OWNER_KEY_ENV_LENGTH is hostile and resolves as owner-key-env-mismatch before any traversal', () => {
    const overLong = `${PINNED}${'A'.repeat(MAX_OWNER_KEY_ENV_LENGTH)}`;
    expect(overLong.length).toBeGreaterThan(MAX_OWNER_KEY_ENV_LENGTH);
    const resolved = resolvePinnedOwnerPublicKey(PINNED, envWith(overLong));
    expect(resolved).toEqual({ status: 'env-mismatch', code: 'owner-key-env-mismatch' });
  });

  it('a hostile env object (null, undefined, a number, an array) is absent and resolves as pinned', () => {
    for (const hostile of [null, undefined, 42, ['x']]) {
      expect(resolvePinnedOwnerPublicKey(PINNED, hostile)).toEqual({
        status: 'pinned',
        publicKey: PINNED,
      });
    }
  });

  it('an env value that is not a plain own string (a number where a string is due) resolves as owner-key-env-mismatch', () => {
    const env: Record<string, unknown> = { FLEET_OWNER_PUBLIC_KEY: 42 };
    expect(resolvePinnedOwnerPublicKey(PINNED, env)).toEqual({
      status: 'env-mismatch',
      code: 'owner-key-env-mismatch',
    });
  });

  it('an accessor env property never runs its getter and resolves as owner-key-env-mismatch with a getter-call count of 0', () => {
    let getterCalls = 0;
    const env: Record<string, unknown> = {};
    Object.defineProperty(env, 'FLEET_OWNER_PUBLIC_KEY', {
      enumerable: true,
      get() {
        getterCalls += 1;
        return PINNED;
      },
    });
    expect(resolvePinnedOwnerPublicKey(PINNED, env)).toEqual({
      status: 'env-mismatch',
      code: 'owner-key-env-mismatch',
    });
    expect(getterCalls).toBe(0);
  });

  it('a Proxy over a valid env object yields exactly the plain-data result and no get trap ever runs', () => {
    let getTrapCalls = 0;
    const plain = envWith(PINNED);
    const proxy = new Proxy(plain, {
      get(_target, property, receiver) {
        getTrapCalls += 1;
        return Reflect.get(_target, property, receiver);
      },
    });
    const resolved = resolvePinnedOwnerPublicKey(PINNED, proxy);
    expect(resolved.status).toBe('pinned');
    if (resolved.status === 'pinned') {
      expect(resolved.deprecationWarning).toBeDefined();
    }
    expect(getTrapCalls).toBe(0);
  });

  it('a revoked Proxy as the env object never throws and fails closed as owner-key-env-mismatch', () => {
    const target = envWith(PINNED);
    const { proxy, revoke } = Proxy.revocable(target, {});
    revoke();
    expect(() =>
      resolvePinnedOwnerPublicKey(PINNED, proxy),
    ).not.toThrow();
    expect(resolvePinnedOwnerPublicKey(PINNED, proxy)).toEqual({
      status: 'env-mismatch',
      code: 'owner-key-env-mismatch',
    });
  });

  it('an own prototype-polluting key produced by JSON.parse is read as an own data property and never trusted through the prototype chain', () => {
    const env: Record<string, unknown> = JSON.parse(
      '{"__proto__": {"FLEET_OWNER_PUBLIC_KEY": "evil"}}',
    ) as Record<string, unknown>;
    // The env object carries no own FLEET_OWNER_PUBLIC_KEY: the polluted
    // `__proto__` never becomes an authority.
    expect(resolvePinnedOwnerPublicKey(PINNED, env)).toEqual({
      status: 'pinned',
      publicKey: PINNED,
    });
  });

  it('a null pinned key resolves as owner-key-unpinned even when the env variable is set', () => {
    expect(resolvePinnedOwnerPublicKey(null, envWith(PINNED))).toEqual({
      status: 'unpinned',
      code: 'owner-key-unpinned',
    });
  });

  it('an undefined pinned key resolves as owner-key-unpinned', () => {
    expect(resolvePinnedOwnerPublicKey(undefined, envWith(undefined))).toEqual({
      status: 'unpinned',
      code: 'owner-key-unpinned',
    });
  });

  it('a wrong primitive pinned key (a number where a string is due) resolves as owner-key-unpinned', () => {
    expect(resolvePinnedOwnerPublicKey(42, envWith(PINNED))).toEqual({
      status: 'unpinned',
      code: 'owner-key-unpinned',
    });
  });

  it('an array pinned key resolves as owner-key-unpinned', () => {
    expect(resolvePinnedOwnerPublicKey([PINNED], envWith(PINNED))).toEqual({
      status: 'unpinned',
      code: 'owner-key-unpinned',
    });
  });

  it('an array-like object pinned key ({ length: 1, 0: ... }) resolves as owner-key-unpinned', () => {
    expect(resolvePinnedOwnerPublicKey({ length: 1, 0: PINNED }, envWith(PINNED))).toEqual({
      status: 'unpinned',
      code: 'owner-key-unpinned',
    });
  });

  it('an enormous sparse array pinned key of length 2**32 - 1 is refused before any traversal', () => {
    const huge: string[] = [];
    Object.defineProperty(huge, 'length', { value: 2 ** 32 - 1 });
    expect(resolvePinnedOwnerPublicKey(huge, envWith(undefined))).toEqual({
      status: 'unpinned',
      code: 'owner-key-unpinned',
    });
  });

  it('a blank pinned key resolves as owner-key-unpinned even when the env variable is set', () => {
    expect(resolvePinnedOwnerPublicKey('   ', envWith(PINNED))).toEqual({
      status: 'unpinned',
      code: 'owner-key-unpinned',
    });
  });

  it('the verdict is not a constant: an env mismatch and a pinned match give different typed results', () => {
    // A function returning a constant verdict fails this.
    expect(resolvePinnedOwnerPublicKey(PINNED, envWith(PINNED)).status).toBe('pinned');
    expect(resolvePinnedOwnerPublicKey(PINNED, envWith('Zm9l')).status).toBe('env-mismatch');
    expect(resolvePinnedOwnerPublicKey(undefined, envWith(undefined)).status).toBe('unpinned');
  });

  it('the result is not an identity echo of the input: the typed object is returned, not the pinned key or env value', () => {
    const resolved = resolvePinnedOwnerPublicKey(PINNED, envWith(PINNED));
    expect(resolved).not.toBe(PINNED);
    expect(resolved).not.toBe(envWith(PINNED));
    if (resolved.status === 'pinned') {
      expect(resolved.publicKey).toBe(PINNED);
      expect(resolved).not.toContain(PINNED as never);
    }
  });
});

describe('DecisionTransportAdapter owner-key refusal', () => {
  const query: DecisionAnswerQuery = {
    requestId: 'req-1',
    projectId: 'proj-1',
    actionScope: 'forge:merge-pr',
    expectedHeadSha: 'sha-commit-1',
  };

  function createOwnerKeyPair(): { publicKeyBase64: string; privateKey: KeyObject } {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const raw32 = publicKey.export({ format: 'der', type: 'spki' }).subarray(12);
    return { publicKeyBase64: raw32.toString('base64'), privateKey };
  }

  function signedApproval(publicKeyBase64: string, privateKey: KeyObject): {
    publicKeyBase64: string;
    signature: string;
  } {
    const signature = sign(
      null,
      canonicalDecisionBytes({ ...query, decisionRevision: 'rev-1', grantId: 'grant-1', state: 'approved' }),
      privateKey,
    ).toString('base64');
    return { publicKeyBase64, signature };
  }

  it('an owner-key-env-mismatch refusal turns a validly signed approval into awaiting-decision carrying the reason', async () => {
    const { publicKeyBase64, privateKey } = createOwnerKeyPair();
    const { signature } = signedApproval(publicKeyBase64, privateKey);
    const adapter = new DecisionTransportAdapter({
      ownerPublicKey: publicKeyBase64,
      ownerKeyRefusal: 'owner-key-env-mismatch',
      answers: {
        'req-1': { state: 'approved', decisionRevision: 'rev-1', grantId: 'grant-1', signature },
      },
    });
    expect(await adapter.readDecisionAnswer(query)).toEqual({
      state: 'awaiting-decision',
      decisionRevision: null,
      grantId: null,
      refusalReason: 'owner-key-env-mismatch',
    });
  });

  it('an owner-key-unpinned refusal turns a validly signed approval into awaiting-decision carrying the reason', async () => {
    const { publicKeyBase64, privateKey } = createOwnerKeyPair();
    const { signature } = signedApproval(publicKeyBase64, privateKey);
    const adapter = new DecisionTransportAdapter({
      ownerPublicKey: publicKeyBase64,
      ownerKeyRefusal: 'owner-key-unpinned',
      answers: {
        'req-1': { state: 'approved', decisionRevision: 'rev-1', grantId: 'grant-1', signature },
      },
    });
    expect(await adapter.readDecisionAnswer(query)).toEqual({
      state: 'awaiting-decision',
      decisionRevision: null,
      grantId: null,
      refusalReason: 'owner-key-unpinned',
    });
  });

  it('an owner-key refusal also covers an unsigned approval: awaiting-decision carrying the reason', async () => {
    const adapter = new DecisionTransportAdapter({
      ownerKeyRefusal: 'owner-key-env-mismatch',
      answers: {
        'req-1': { state: 'approved', decisionRevision: 'rev-1', grantId: 'grant-1' },
      },
    });
    expect(await adapter.readDecisionAnswer(query)).toEqual({
      state: 'awaiting-decision',
      decisionRevision: null,
      grantId: null,
      refusalReason: 'owner-key-env-mismatch',
    });
  });

  it('without an ownerKeyRefusal an unconfigured key keeps the unchanged awaiting shape with no refusalReason', async () => {
    const adapter = new DecisionTransportAdapter({
      answers: {
        'req-1': { state: 'approved', decisionRevision: 'rev-1', grantId: 'grant-1' },
      },
    });
    expect(await adapter.readDecisionAnswer(query)).toEqual({
      state: 'awaiting-decision',
      decisionRevision: null,
      grantId: null,
    });
  });

  it('a declined answer is unchanged when an owner-key refusal is set', async () => {
    const adapter = new DecisionTransportAdapter({
      ownerKeyRefusal: 'owner-key-unpinned',
      answers: { 'req-1': { state: 'declined', decisionRevision: 'rev-1', grantId: null } },
    });
    expect(await adapter.readDecisionAnswer(query)).toEqual({
      state: 'declined',
      decisionRevision: 'rev-1',
      grantId: null,
    });
  });
});
