/**
 * FC8E2 tests for `CloudProviderRegistry`: registration succeeds only for a
 * valid id and a provider whose port methods are data properties found by
 * descriptor inspection (no getter is ever invoked), and every failure —
 * hostile or malformed id, hostile or incomplete provider, duplicate id,
 * unknown id — is the exact typed refusal.
 */

import { describe, expect, it } from 'vitest';

import type { CloudProviderPort } from '../../ports/out/CloudProviderPort.out-port.js';
import { CloudProviderRegistry } from '../cloud-provider-registry.js';

/** A revoked Proxy throws on every trap, including [[GetPrototypeOf]]. */
function revokedProxy(): unknown {
  const { proxy, revoke } = Proxy.revocable({}, {});
  revoke();
  return proxy;
}

/** Build a provider id of the given shape at runtime rather than as a literal. */
function longId(): string {
  return 'a'.repeat(129);
}

/** An id containing a character outside the fixed class, built at runtime. */
function idWithSlash(): string {
  return ['in', 'valid'].join('/');
}

/** A provider object with all three port methods as function data properties. */
function validProvider(): CloudProviderPort {
  return {
    async provision() {
      return { ok: false, reason: 'invalid-request' };
    },
    async drain() {
      return { ok: false, reason: 'invalid-request' };
    },
    async terminate() {
      return { ok: false, reason: 'invalid-request' };
    },
  };
}

/** A provider whose `drain` is a getter that throws if it ever runs. */
function providerWithThrowingDrainGetter(): unknown {
  return {
    provision: validProvider().provision,
    get drain(): never {
      throw new Error('getter must never run');
    },
    terminate: validProvider().terminate,
  };
}

/** A provider whose only method lives 9 prototype levels up (one too deep). */
function providerNineLevelsDeep(): unknown {
  let level: object = { terminate: validProvider().terminate };
  for (let index = 0; index < 8; index += 1) {
    level = Object.create(level) as object;
  }
  const bottom = Object.create(level) as object;
  (bottom as Record<string, unknown>).provision = validProvider().provision;
  (bottom as Record<string, unknown>).drain = validProvider().drain;
  return bottom;
}

/** A provider whose only method lives exactly 8 prototype levels up (allowed). */
function providerEightLevelsDeep(): CloudProviderPort {
  let level: object = { terminate: validProvider().terminate };
  for (let index = 0; index < 7; index += 1) {
    level = Object.create(level) as object;
  }
  const bottom = Object.create(level) as object;
  (bottom as Record<string, unknown>).provision = validProvider().provision;
  (bottom as Record<string, unknown>).drain = validProvider().drain;
  return bottom as CloudProviderPort;
}

describe('CloudProviderRegistry.register', () => {
  it('registers a valid id with a plain-object provider and an instance provider', () => {
    const registry = new CloudProviderRegistry();
    expect(registry.register('in-memory', validProvider())).toEqual({ ok: true });
    class Provider implements CloudProviderPort {
      async provision() {
        return { ok: false as const, reason: 'invalid-request' as const };
      }
      async drain() {
        return { ok: false as const, reason: 'invalid-request' as const };
      }
      async terminate() {
        return { ok: false as const, reason: 'invalid-request' as const };
      }
    }
    expect(registry.register('instance.provider', new Provider())).toEqual({ ok: true });
  });

  it('refuses invalid provider id on register with invalid-id', () => {
    const registry = new CloudProviderRegistry();
    const provider = validProvider();
    for (const id of [null, undefined, 3, true, {}, [], '', longId(), idWithSlash(), 'has space'.replace(' ', ' ')]) {
      expect(registry.register(id, provider)).toEqual({ ok: false, reason: 'invalid-id' });
    }
    expect(registry.register(undefined, provider)).toEqual({ ok: false, reason: 'invalid-id' });
  });

  it('refuses incomplete or hostile provider on register without invoking getters', () => {
    const registry = new CloudProviderRegistry();
    const valid = validProvider();
    const missingDrain = { provision: valid.provision, terminate: valid.terminate };
    const nonFunctionDrain = { provision: valid.provision, drain: 3, terminate: valid.terminate };
    const hosts: readonly unknown[] = [
      null,
      undefined,
      3,
      'provider',
      true,
      [],
      missingDrain,
      nonFunctionDrain,
      providerWithThrowingDrainGetter(),
      providerNineLevelsDeep(),
      revokedProxy(),
      // A Proxy whose descriptor traps throw must be a refusal, not a throw.
      new Proxy(validProvider(), {
        getOwnPropertyDescriptor() {
          throw new Error('descriptor trap must never be trusted');
        },
        getPrototypeOf() {
          throw new Error('prototype trap must never be trusted');
        },
      }),
    ];
    let index = 0;
    for (const host of hosts) {
      const id = `host-${index}`;
      index += 1;
      expect(registry.register(id, host)).toEqual({ ok: false, reason: 'invalid-provider' });
    }
  });

  it('refuses duplicate provider id with duplicate-provider', () => {
    const registry = new CloudProviderRegistry();
    const provider = validProvider();
    expect(registry.register('same', provider)).toEqual({ ok: true });
    expect(registry.register('same', validProvider())).toEqual({ ok: false, reason: 'duplicate-provider' });
  });
});

describe('CloudProviderRegistry.get', () => {
  it('returns the exact registered instance for a valid id', () => {
    const registry = new CloudProviderRegistry();
    const provider = validProvider();
    expect(registry.register('same', provider)).toEqual({ ok: true });
    const read = registry.get('same');
    expect(read).toEqual({ ok: true, provider });
    expect(read.ok === true && read.provider === provider).toBe(true);
  });

  it('refuses unknown provider id on get with unknown-provider', () => {
    const registry = new CloudProviderRegistry();
    expect(registry.get('nothing')).toEqual({ ok: false, reason: 'unknown-provider' });
  });

  it('refuses invalid provider id on get with invalid-id', () => {
    const registry = new CloudProviderRegistry();
    for (const id of [null, undefined, 3, '', longId(), idWithSlash(), revokedProxy()]) {
      expect(registry.get(id)).toEqual({ ok: false, reason: 'invalid-id' });
    }
  });
});

describe('CloudProviderRegistry depth boundary', () => {
  it('accepts a provider with a method eight prototype levels up and refuses nine', () => {
    const registry = new CloudProviderRegistry();
    expect(registry.register('eight', providerEightLevelsDeep())).toEqual({ ok: true });
    const deep = new CloudProviderRegistry();
    expect(deep.register('nine', providerNineLevelsDeep())).toEqual({ ok: false, reason: 'invalid-provider' });
    expect(deep.get('nine')).toEqual({ ok: false, reason: 'unknown-provider' });
  });
});
