import { describe, expect, it } from 'vitest';
import { inspect } from 'node:util';
import { containsSecretShape } from '@fleet/shared';

import {
  FORGE_CREDENTIAL_MAX_TTL_SECONDS,
  FORGE_CREDENTIAL_PERMISSIONS,
  FORGE_CREDENTIAL_MAX_STRING_LENGTH,
  ScopedForgeCredential,
  isExpired,
  validateForgeCredentialRequest,
  validateForgeRepository,
} from '../forge-credential.js';

/**
 * Secret-shaped values are assembled at runtime from inert pieces so this
 * file never contains a credential-shaped literal; the scanner still
 * recognises the shape, which is the point under test.
 */
const GITHUB_SECRET = 'ghp_' + 'a'.repeat(24);
const OPENAI_SECRET = 'sk-' + 'x'.repeat(24);

const EXPIRES_AT = '2026-11-25T12:00:00.000Z';
const BEFORE_EXPIRY = '2026-11-25T11:59:59.999Z';
const AT_EXPIRY = '2026-11-25T12:00:00.000Z';
const AFTER_EXPIRY = '2026-11-25T12:00:00.001Z';

/** Build a holed array dynamically: the lint rule forbids a sparse literal. */
function buildHoledArray(): unknown[] {
  const holed: unknown[] = ['x', 'y', 'z'];
  delete holed[0];
  return holed;
}

function validRequest(): Record<string, unknown> {
  return {
    repository: 'fleet-v2/work-execution',
    permission: 'push',
    ttlSeconds: 900,
    purposeRef: 'lane FC7A test run',
  };
}

function makeCredential(secret: string): ScopedForgeCredential {
  return new ScopedForgeCredential({
    repository: 'fleet-v2/work-execution',
    permission: 'push',
    expiresAtIso: EXPIRES_AT,
    secret,
  });
}

describe('ScopedForgeCredential redaction', () => {
  it('reveal() returns the secret the credential was constructed with', () => {
    const c = makeCredential(GITHUB_SECRET);
    expect(c.reveal()).toBe(GITHUB_SECRET);
  });

  it('the positive control: containsSecretShape flags the runtime secret, so the redaction assertions below are meaningful', () => {
    expect(containsSecretShape(GITHUB_SECRET)).toBe(true);
    expect(containsSecretShape(OPENAI_SECRET)).toBe(true);
  });

  it('JSON.stringify(c), String(c), template interpolation, inspect(c) and toJSON() contain neither the secret nor any secret shape', () => {
    for (const secret of [GITHUB_SECRET, OPENAI_SECRET]) {
      const c = makeCredential(secret);
      const renderings: Array<[string, string]> = [
        ['JSON.stringify', JSON.stringify(c)],
        ['String', String(c)],
        ['template', `${c}`],
        ['inspect', inspect(c)],
        ['toJSON', JSON.stringify(c.toJSON())],
      ];
      for (const [label, rendered] of renderings) {
        expect(rendered, `${label} must not contain the secret`).not.toContain(secret);
        expect(containsSecretShape(rendered), `${label} must not carry a secret shape`).toBe(false);
      }
    }
  });

  it('structuredClone(c) and structuredClone(c.toJSON()) contain neither the secret nor a secret shape', () => {
    for (const secret of [GITHUB_SECRET, OPENAI_SECRET]) {
      const c = makeCredential(secret);
      const cloneJson = JSON.stringify(structuredClone(c));
      const viewJson = JSON.stringify(structuredClone(c.toJSON()));
      expect(cloneJson).not.toContain(secret);
      expect(containsSecretShape(cloneJson)).toBe(false);
      expect(viewJson).not.toContain(secret);
      expect(containsSecretShape(viewJson)).toBe(false);
    }
  });

  it('Object.keys, Object.getOwnPropertyNames, spread and Object.entries expose only the three public fields, never the secret', () => {
    const c = makeCredential(GITHUB_SECRET);
    const expectedKeys = ['repository', 'permission', 'expiresAtIso'].sort();
    expect(Object.keys(c).sort()).toEqual(expectedKeys);
    expect(Object.getOwnPropertyNames(c).sort()).toEqual(expectedKeys);
    expect(Object.keys({ ...c }).sort()).toEqual(expectedKeys);
    for (const [, value] of Object.entries(c)) {
      expect(value).not.toBe(GITHUB_SECRET);
    }
    expect(JSON.stringify(Object.entries(c))).not.toContain(GITHUB_SECRET);
  });

  it('toJSON() returns exactly repository, permission and expiresAtIso (the public view shape)', () => {
    const c = makeCredential(GITHUB_SECRET);
    expect(c.toJSON()).toEqual({
      repository: 'fleet-v2/work-execution',
      permission: 'push',
      expiresAtIso: EXPIRES_AT,
    });
    expect(Object.keys(c.toJSON()).sort()).toEqual(['expiresAtIso', 'permission', 'repository']);
  });

  it('toString() and inspect() render the redacted form with [REDACTED] in place of the secret', () => {
    const c = makeCredential(GITHUB_SECRET);
    expect(String(c)).toBe(
      `ScopedForgeCredential(fleet-v2/work-execution, push, ${EXPIRES_AT}, [REDACTED])`,
    );
    expect(inspect(c)).toBe(String(c));
  });
});

describe('validateForgeRepository', () => {
  it('accepts a plain owner/name repository', () => {
    expect(validateForgeRepository('owner/name')).toBe(true);
    expect(validateForgeRepository('fleet-v2/work-execution')).toBe(true);
  });

  it('refuses non-strings, empty strings, and strings longer than 300 characters before scanning', () => {
    expect(validateForgeRepository(null)).toBe(false);
    expect(validateForgeRepository(undefined)).toBe(false);
    expect(validateForgeRepository(42)).toBe(false);
    expect(validateForgeRepository(['a/b'])).toBe(false);
    expect(validateForgeRepository('')).toBe(false);
    expect(validateForgeRepository('a'.repeat(FORGE_CREDENTIAL_MAX_STRING_LENGTH + 1) + '/b')).toBe(false);
  });

  it('refuses wildcards, URL schemes, extra slashes, dot segments, and segments with forbidden characters', () => {
    expect(validateForgeRepository('*')).toBe(false);
    expect(validateForgeRepository('owner/*')).toBe(false);
    expect(validateForgeRepository('https://x/y/z')).toBe(false);
    expect(validateForgeRepository('owner/name/')).toBe(false);
    expect(validateForgeRepository('owner/..')).toBe(false);
    expect(validateForgeRepository('../name')).toBe(false);
    expect(validateForgeRepository('owner/.')).toBe(false);
    expect(validateForgeRepository('owner/name/extra')).toBe(false);
    expect(validateForgeRepository('ow!ner/name')).toBe(false);
    expect(validateForgeRepository('owner na/name')).toBe(false);
    expect(validateForgeRepository('owner/namé')).toBe(false);
  });

  it('refuses a segment longer than 100 characters even though the whole string fits the 300 bound', () => {
    expect(validateForgeRepository('a'.repeat(101) + '/b')).toBe(false);
    expect(validateForgeRepository('a/' + 'b'.repeat(101))).toBe(false);
  });
});

describe('validateForgeCredentialRequest', () => {
  it('accepts a valid request and returns the typed fields', () => {
    const result = validateForgeCredentialRequest(validRequest());
    expect(result).toEqual({
      ok: true,
      request: {
        repository: 'fleet-v2/work-execution',
        permission: 'push',
        ttlSeconds: 900,
        purposeRef: 'lane FC7A test run',
      },
    });
  });

  it('accepts every allowed permission and returns it unchanged', () => {
    for (const permission of FORGE_CREDENTIAL_PERMISSIONS) {
      const result = validateForgeCredentialRequest({ ...validRequest(), permission });
      expect(result).toEqual({ ok: true, request: { ...validRequest(), permission } });
    }
  });

  it('refuses invalid repository forms with invalid-request', () => {
    for (const repository of [
      '*',
      'owner/*',
      ['a/b', 'c/d'],
      'https://x/y/z',
      'owner/name/',
      'owner/..',
      '../name',
      '',
      'a'.repeat(FORGE_CREDENTIAL_MAX_STRING_LENGTH + 1) + '/b',
      42,
    ]) {
      const result = validateForgeCredentialRequest({ ...validRequest(), repository });
      expect(result, `repository ${JSON.stringify(repository)} must be refused`).toEqual({
        ok: false,
        reason: 'invalid-request',
      });
    }
  });

  it('refuses permissions outside the allowed set, including combined strings and arrays, with invalid-request', () => {
    for (const permission of ['read ', 'push,merge', 'merge,push', 'Merge', 'admin', ['push'], 42, null]) {
      const result = validateForgeCredentialRequest({ ...validRequest(), permission });
      expect(result, `permission ${JSON.stringify(permission)} must be refused`).toEqual({
        ok: false,
        reason: 'invalid-request',
      });
    }
  });

  it('refuses non-integer, non-positive and non-finite TTLs with invalid-request', () => {
    for (const ttlSeconds of [0, -1, 1.5, NaN, Infinity, -Infinity, '900', null]) {
      const result = validateForgeCredentialRequest({ ...validRequest(), ttlSeconds });
      expect(result, `ttlSeconds ${String(ttlSeconds)} must be refused as invalid`).toEqual({
        ok: false,
        reason: 'invalid-request',
      });
    }
  });

  it(`refuses an integer TTL above ${FORGE_CREDENTIAL_MAX_TTL_SECONDS} with ttl-too-long, not invalid-request`, () => {
    expect(validateForgeCredentialRequest({ ...validRequest(), ttlSeconds: FORGE_CREDENTIAL_MAX_TTL_SECONDS + 1 })).toEqual({
      ok: false,
      reason: 'ttl-too-long',
    });
    expect(validateForgeCredentialRequest({ ...validRequest(), ttlSeconds: 999999 })).toEqual({
      ok: false,
      reason: 'ttl-too-long',
    });
  });

  it('accepts a TTL of exactly the 3600 bound', () => {
    const result = validateForgeCredentialRequest({ ...validRequest(), ttlSeconds: FORGE_CREDENTIAL_MAX_TTL_SECONDS });
    expect(result.ok).toBe(true);
  });

  it('refuses a non-string, empty, whitespace-only, or over-length purposeRef with invalid-request', () => {
    for (const purposeRef of [42, null, undefined, '', '   ', 'a'.repeat(FORGE_CREDENTIAL_MAX_STRING_LENGTH + 1)]) {
      const result = validateForgeCredentialRequest({ ...validRequest(), purposeRef });
      expect(result, `purposeRef ${JSON.stringify(purposeRef)} must be refused`).toEqual({
        ok: false,
        reason: 'invalid-request',
      });
    }
  });

  it('refuses hostile non-plain inputs: null, undefined, primitives, arrays, arrays with holes, and array-likes', () => {
    const hostile: unknown[] = [
      null,
      undefined,
      42,
      'a/b',
      true,
      42n,
      Symbol('x'),
      [],
      ['a/b'],
      // A holed array built dynamically: the lint rule forbids a sparse
      // literal, but the hole behaviour must still be tested.
      buildHoledArray(),
      { length: 4, repository: 'a/b', permission: 'push', purposeRef: 'p' },
      { length: 5, repository: 'a/b', permission: 'push', ttlSeconds: 10, purposeRef: 'p' },
      { length: '900719925474099999', repository: 'a/b', permission: 'push', ttlSeconds: 10, purposeRef: 'p' },
    ];
    for (const input of hostile) {
      const result = validateForgeCredentialRequest(input);
      expect(result, `hostile input case ${hostile.indexOf(input)} must be refused`).toEqual({
        ok: false,
        reason: 'invalid-request',
      });
    }
  });

  it('refuses an own length property of any type — including a coercible string length — without coercing it', () => {
    const numericLength = { ...validRequest(), length: 4 };
    const stringLength = { ...validRequest(), length: '900719925474099999' };
    for (const input of [numericLength, stringLength]) {
      const result = validateForgeCredentialRequest(input);
      expect(result).toEqual({ ok: false, reason: 'invalid-request' });
    }
  });

  it('never invokes a getter on any request property: a throwing getter stays unthrown and the request is refused', () => {
    let getterRuns = 0;
    const input: Record<string, unknown> = {};
    Object.defineProperty(input, 'repository', {
      enumerable: true,
      get() {
        getterRuns += 1;
        throw new Error('getter must never run');
      },
    });
    input.permission = 'push';
    input.ttlSeconds = 900;
    input.purposeRef = 'p';
    const result = validateForgeCredentialRequest(input);
    expect(result).toEqual({ ok: false, reason: 'invalid-request' });
    expect(getterRuns).toBe(0);
  });

  it('refuses extra, missing, symbol, and prototype-polluting keys', () => {
    const withExtra = { ...validRequest(), extra: 'x' };
    const withMissing = { repository: 'a/b', permission: 'push', ttlSeconds: 900 };
    const withSymbol: Record<string | symbol, unknown> = { ...validRequest() };
    withSymbol[Symbol('extra')] = 'x';
    const nullProtoWithProtoKey: Record<string, unknown> = Object.create(null);
    Object.defineProperty(nullProtoWithProtoKey, '__proto__', {
      enumerable: true,
      value: {},
      writable: true,
      configurable: true,
    });
    nullProtoWithProtoKey.permission = 'push';
    nullProtoWithProtoKey.ttlSeconds = 900;
    nullProtoWithProtoKey.purposeRef = 'p';
    const withConstructorKey = { ...validRequest(), constructor: Object };
    for (const input of [withExtra, withMissing, withSymbol, nullProtoWithProtoKey, withConstructorKey]) {
      const result = validateForgeCredentialRequest(input);
      expect(result, 'a key-set violation must be refused').toEqual({ ok: false, reason: 'invalid-request' });
    }
  });

  it('refuses a non-enumerable property among the four keys', () => {
    const input: Record<string, unknown> = { ...validRequest() };
    Object.defineProperty(input, 'permission', { enumerable: false, value: 'push' });
    expect(validateForgeCredentialRequest(input)).toEqual({ ok: false, reason: 'invalid-request' });
  });

  it('refuses a revoked Proxy and a Proxy whose getPrototypeOf or ownKeys trap throws, with invalid-request', () => {
    const { proxy, revoke } = Proxy.revocable({ ...validRequest() }, {});
    const throwingGetPrototypeOf = new Proxy({ ...validRequest() }, {
      getPrototypeOf(): never {
        throw new Error('getPrototypeOf trap');
      },
    });
    const throwingOwnKeys = new Proxy({ ...validRequest() }, {
      ownKeys(): never {
        throw new Error('ownKeys trap');
      },
    });
    try {
      expect(validateForgeCredentialRequest(throwingGetPrototypeOf)).toEqual({
        ok: false,
        reason: 'invalid-request',
      });
      expect(validateForgeCredentialRequest(throwingOwnKeys)).toEqual({
        ok: false,
        reason: 'invalid-request',
      });
    } finally {
      revoke();
    }
    expect(validateForgeCredentialRequest(proxy)).toEqual({ ok: false, reason: 'invalid-request' });
  });
});

describe('isExpired', () => {
  it('returns false before expiry, true at the exact expiresAtIso boundary, and true after expiry', () => {
    const credential = { expiresAtIso: EXPIRES_AT };
    expect(isExpired(credential, BEFORE_EXPIRY)).toBe(false);
    expect(isExpired(credential, AT_EXPIRY)).toBe(true);
    expect(isExpired(credential, AFTER_EXPIRY)).toBe(true);
  });

  it('returns true for a calendar-impossible date such as 2026-02-31T00:00:00Z even though Date.parse accepts it', () => {
    expect(isExpired({ expiresAtIso: '2026-02-31T00:00:00Z' }, '2026-01-01T00:00:00Z')).toBe(true);
  });

  it('returns true for a non-ISO string such as 2099 and for a timestamp with no offset', () => {
    expect(isExpired({ expiresAtIso: '2099' }, '2026-01-01T00:00:00Z')).toBe(true);
    expect(isExpired({ expiresAtIso: '2026-11-25T12:00:00' }, '2026-01-01T00:00:00Z')).toBe(true);
  });

  it('returns true for a malformed or over-length nowIso', () => {
    expect(isExpired({ expiresAtIso: EXPIRES_AT }, 'not-a-date')).toBe(true);
    expect(isExpired({ expiresAtIso: EXPIRES_AT }, 'x'.repeat(101))).toBe(true);
    expect(isExpired({ expiresAtIso: EXPIRES_AT }, '2026-02-31T00:00:00Z')).toBe(true);
  });

  it('returns true (fail-closed) for null, undefined, non-plain objects, and hostile expiresAtIso values', () => {
    for (const [caseIndex, credential] of [null, undefined, 42, '2026-11-25T12:00:00.000Z', [], new Date(0), Object.create(null)].entries()) {
      expect(isExpired(credential, BEFORE_EXPIRY), `hostile credential case ${caseIndex} must read expired`).toBe(true);
    }
    expect(isExpired({ expiresAtIso: null }, BEFORE_EXPIRY)).toBe(true);
    expect(isExpired({ expiresAtIso: 42 }, BEFORE_EXPIRY)).toBe(true);
    expect(isExpired({ expiresAtIso: 'x'.repeat(101) }, BEFORE_EXPIRY)).toBe(true);
    expect(isExpired({ expiresAtIso: EXPIRES_AT }, null)).toBe(true);
    expect(isExpired({ expiresAtIso: EXPIRES_AT }, undefined)).toBe(true);
  });

  it('returns true for a plain record carrying an own constructor, prototype, or __proto__ key', () => {
    const expires = { expiresAtIso: EXPIRES_AT };
    const withConstructor = { ...expires, constructor: Object };
    const withPrototype = { ...expires, prototype: Object.prototype };
    const nullProtoWithProtoKey: Record<string, unknown> = Object.create(null);
    Object.defineProperty(nullProtoWithProtoKey, '__proto__', {
      enumerable: true,
      value: {},
      writable: true,
      configurable: true,
    });
    nullProtoWithProtoKey.expiresAtIso = EXPIRES_AT;
    for (const credential of [withConstructor, withPrototype, nullProtoWithProtoKey]) {
      expect(isExpired(credential, BEFORE_EXPIRY), 'a polluted record must read expired').toBe(true);
    }
  });

  it('never invokes a throwing getter on expiresAtIso and returns true', () => {
    let getterRuns = 0;
    const credential: Record<string, unknown> = {};
    Object.defineProperty(credential, 'expiresAtIso', {
      enumerable: true,
      get() {
        getterRuns += 1;
        throw new Error('getter must never run');
      },
    });
    expect(isExpired(credential, BEFORE_EXPIRY)).toBe(true);
    expect(getterRuns).toBe(0);
  });

  it('reads the expiry of a real ScopedForgeCredential instance and honours the boundary', () => {
    const c = makeCredential(GITHUB_SECRET);
    expect(isExpired(c, BEFORE_EXPIRY)).toBe(false);
    expect(isExpired(c, AT_EXPIRY)).toBe(true);
    expect(isExpired(c, AFTER_EXPIRY)).toBe(true);
  });

  it('never invokes a hostile subclass getter over expiresAtIso of a ScopedForgeCredential and returns true', () => {
    let getterRuns = 0;
    class Hostile extends ScopedForgeCredential {
      constructor() {
        super({ repository: 'owner/name', permission: 'read', expiresAtIso: EXPIRES_AT, secret: GITHUB_SECRET });
        Object.defineProperty(this, 'expiresAtIso', {
          enumerable: true,
          configurable: true,
          get() {
            getterRuns += 1;
            return '2999-01-01T00:00:00Z';
          },
        });
      }
    }
    const hostile = new Hostile();
    expect(isExpired(hostile, BEFORE_EXPIRY)).toBe(true);
    expect(getterRuns).toBe(0);
  });

  it('returns true for a Proxy credential whose getPrototypeOf trap throws', () => {
    const proxy = new Proxy({ expiresAtIso: EXPIRES_AT }, {
      getPrototypeOf(): never {
        throw new Error('getPrototypeOf trap');
      },
    });
    expect(isExpired(proxy, BEFORE_EXPIRY)).toBe(true);
  });
});
