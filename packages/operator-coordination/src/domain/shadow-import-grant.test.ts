import { describe, expect, it } from 'vitest';
import {
  MAX_EXPIRES_AT_ISO_LENGTH,
  SHADOW_IMPORT_ACTION_SCOPE,
  SHADOW_IMPORT_DIGEST_PREFIX,
  validateShadowImportGrantCheck,
  isShadowImportActionScope,
  parseShadowImportGrant,
  shadowImportDigestPayload,
} from './coordination-records.js';

const VALID_REPOSITORY = { owner: 'octo', repo: 'hello' } as const;
const VALID_EXPIRES_AT_ISO = '2026-12-16T00:00:00Z';

function validGrant(): Record<string, unknown> {
  return { repository: { ...VALID_REPOSITORY }, expiresAtIso: VALID_EXPIRES_AT_ISO };
}

describe('parseShadowImportGrant (GR1a1 hostile inputs)', () => {
  it('refuses null with shadow-import-grant-not-object', () => {
    expect(parseShadowImportGrant(null)).toEqual({
      ok: false,
      code: 'shadow-import-grant-not-object',
    });
  });

  it('refuses undefined with shadow-import-grant-not-object', () => {
    expect(parseShadowImportGrant(undefined)).toEqual({
      ok: false,
      code: 'shadow-import-grant-not-object',
    });
  });

  it('refuses a wrong primitive (number where a grant object is due)', () => {
    expect(parseShadowImportGrant(42)).toEqual({
      ok: false,
      code: 'shadow-import-grant-not-object',
    });
  });

  it('refuses a wrong primitive for repository.owner (number where a string is due)', () => {
    const raw = { repository: { owner: 42, repo: 'hello' }, expiresAtIso: VALID_EXPIRES_AT_ISO };
    expect(parseShadowImportGrant(raw)).toEqual({
      ok: false,
      code: 'shadow-import-grant-invalid-repository',
    });
  });

  it('refuses a non-iterable object where a grant object is due ({ 0: "a" })', () => {
    expect(parseShadowImportGrant({ 0: 'a' })).toEqual({
      ok: false,
      code: 'shadow-import-grant-unexpected-key',
    });
  });

  it('refuses a sparse array (array hole) before any indexing', () => {
    expect(parseShadowImportGrant(new Array(1))).toEqual({
      ok: false,
      code: 'shadow-import-grant-not-object',
    });
  });

  it('refuses an array-like object { length: 1, 0: grant }', () => {
    expect(parseShadowImportGrant({ length: 1, 0: validGrant() })).toEqual({
      ok: false,
      code: 'shadow-import-grant-unexpected-key',
    });
  });

  it('refuses an enormous-length sparse array in O(1) without traversal', () => {
    const enormous: unknown[] = [];
    Object.defineProperty(enormous, 'length', { value: 2 ** 32 - 1 });
    const startedAt = Date.now();
    const result = parseShadowImportGrant(enormous);
    expect(result).toEqual({ ok: false, code: 'shadow-import-grant-not-object' });
    expect(Date.now() - startedAt).toBeLessThan(1000);
  });

  it('refuses a getter on the root without ever running it', () => {
    let calls = 0;
    const raw: Record<string, unknown> = { expiresAtIso: VALID_EXPIRES_AT_ISO };
    Object.defineProperty(raw, 'repository', {
      get() {
        calls += 1;
        return { ...VALID_REPOSITORY };
      },
      enumerable: true,
    });
    const result = parseShadowImportGrant(raw);
    expect(result).toEqual({ ok: false, code: 'shadow-import-grant-accessor-forbidden' });
    expect(calls).toBe(0);
  });

  it('refuses a getter on an item (repository.owner) without ever running it', () => {
    let calls = 0;
    const repository: Record<string, unknown> = { repo: 'hello' };
    Object.defineProperty(repository, 'owner', {
      get() {
        calls += 1;
        return 'octo';
      },
      enumerable: true,
    });
    const result = parseShadowImportGrant({ repository, expiresAtIso: VALID_EXPIRES_AT_ISO });
    expect(result).toEqual({ ok: false, code: 'shadow-import-grant-accessor-forbidden' });
    expect(calls).toBe(0);
  });

  it('refuses a Proxy over a valid input without running any get trap, or matches the plain result', () => {
    let getCalls = 0;
    const proxy = new Proxy(validGrant(), {
      get(target, property, receiver) {
        getCalls += 1;
        return Reflect.get(target, property, receiver);
      },
    });
    const result = parseShadowImportGrant(proxy);
    expect(getCalls).toBe(0);
    const plain = parseShadowImportGrant(validGrant());
    if (result.ok) {
      expect(plain.ok).toBe(true);
      if (plain.ok) {
        expect(result.value).toEqual(plain.value);
      }
    } else {
      expect(plain).toEqual(result);
    }
  });

  it('refuses a revoked Proxy around a valid grant with shadow-import-grant-invalid-input', () => {
    const { proxy, revoke } = Proxy.revocable(validGrant(), {});
    const proxyTargets = [proxy, { repository: proxy, expiresAtIso: VALID_EXPIRES_AT_ISO }];
    for (const target of proxyTargets) {
      revoke();
      const result = parseShadowImportGrant(target);
      expect(result).toEqual({ ok: false, code: 'shadow-import-grant-invalid-input' });
    }
  });

  it('refuses a JSON.parse __proto__ own key with shadow-import-grant-forbidden-key', () => {
    const raw = JSON.parse(
      `{"repository":{"owner":"octo","repo":"hello"},"expiresAtIso":"${VALID_EXPIRES_AT_ISO}","__proto__":{}}`,
    ) as object;
    expect(parseShadowImportGrant(raw)).toEqual({
      ok: false,
      code: 'shadow-import-grant-forbidden-key',
    });
  });

  it('refuses a JSON.parse constructor own key with shadow-import-grant-forbidden-key', () => {
    const raw = JSON.parse(
      `{"constructor":{},"repository":{"owner":"octo","repo":"hello"},"expiresAtIso":"${VALID_EXPIRES_AT_ISO}"}`,
    ) as object;
    expect(parseShadowImportGrant(raw)).toEqual({
      ok: false,
      code: 'shadow-import-grant-forbidden-key',
    });
  });

  it('refuses a JSON.parse prototype own key with shadow-import-grant-forbidden-key', () => {
    const raw = JSON.parse(
      `{"repository":{"owner":"octo","repo":"hello"},"expiresAtIso":"${VALID_EXPIRES_AT_ISO}","prototype":{}}`,
    ) as object;
    expect(parseShadowImportGrant(raw)).toEqual({
      ok: false,
      code: 'shadow-import-grant-forbidden-key',
    });
  });

  it('refuses null expiresAtIso with shadow-import-grant-invalid-expiry', () => {
    const raw = { repository: { ...VALID_REPOSITORY }, expiresAtIso: null };
    expect(parseShadowImportGrant(raw)).toEqual({
      ok: false,
      code: 'shadow-import-grant-invalid-expiry',
    });
  });

  it('refuses an omitted expiresAtIso key with shadow-import-grant-unexpected-key', () => {
    const raw = { repository: { ...VALID_REPOSITORY } };
    expect(parseShadowImportGrant(raw)).toEqual({
      ok: false,
      code: 'shadow-import-grant-unexpected-key',
    });
  });

  it('refuses an own undefined expiresAtIso with shadow-import-grant-invalid-expiry', () => {
    const raw = { repository: { ...VALID_REPOSITORY }, expiresAtIso: undefined };
    expect(parseShadowImportGrant(raw)).toEqual({
      ok: false,
      code: 'shadow-import-grant-invalid-expiry',
    });
  });

  it('refuses a number expiresAtIso (epoch millis where ISO text is due)', () => {
    const raw = { repository: { ...VALID_REPOSITORY }, expiresAtIso: 1735689600000 };
    expect(parseShadowImportGrant(raw)).toEqual({
      ok: false,
      code: 'shadow-import-grant-invalid-expiry',
    });
  });

  it('refuses an over-long expiresAtIso beyond MAX_EXPIRES_AT_ISO_LENGTH', () => {
    const long = '2026-12-16T00:00:00.' + '0'.repeat(MAX_EXPIRES_AT_ISO_LENGTH);
    const raw = { repository: { ...VALID_REPOSITORY }, expiresAtIso: long };
    const result = parseShadowImportGrant(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('shadow-import-grant-invalid-expiry');
    }
  });

  it('refuses an expiresAtIso without an explicit timezone offset', () => {
    const raw = { repository: { ...VALID_REPOSITORY }, expiresAtIso: '2026-12-01T00:00:00' };
    expect(parseShadowImportGrant(raw)).toEqual({
      ok: false,
      code: 'shadow-import-grant-invalid-expiry',
    });
  });

  it('refuses an impossible calendar date (February 30) that Date.parse would normalize', () => {
    const raw = { repository: { ...VALID_REPOSITORY }, expiresAtIso: '2026-02-30T00:00:00Z' };
    expect(parseShadowImportGrant(raw)).toEqual({
      ok: false,
      code: 'shadow-import-grant-invalid-expiry',
    });
  });

  it('refuses month 13, which Date.parse would roll into the next year', () => {
    const raw = { repository: { ...VALID_REPOSITORY }, expiresAtIso: '2026-13-01T00:00:00Z' };
    expect(parseShadowImportGrant(raw)).toEqual({
      ok: false,
      code: 'shadow-import-grant-invalid-expiry',
    });
  });

  it('refuses an expiresAtIso that is a sparse-array hole carrier', () => {
    const holey: unknown[] = new Array(1);
    const raw = { repository: { ...VALID_REPOSITORY }, expiresAtIso: holey };
    expect(parseShadowImportGrant(raw)).toEqual({
      ok: false,
      code: 'shadow-import-grant-invalid-expiry',
    });
  });

  it('refuses a repository owner that is a "." or ".." segment', () => {
    for (const owner of ['.', '..']) {
      const raw = { repository: { owner, repo: 'hello' }, expiresAtIso: VALID_EXPIRES_AT_ISO };
      expect(parseShadowImportGrant(raw)).toEqual({
        ok: false,
        code: 'shadow-import-grant-invalid-repository',
      });
    }
  });

  it('refuses a repository owner with characters outside the segment pattern', () => {
    const raw = { repository: { owner: 'bad owner!', repo: 'hello' }, expiresAtIso: VALID_EXPIRES_AT_ISO };
    expect(parseShadowImportGrant(raw)).toEqual({
      ok: false,
      code: 'shadow-import-grant-invalid-repository',
    });
  });

  it('accepts a valid grant as a normalized frozen copy, not the raw input', () => {
    const raw = validGrant();
    const result = parseShadowImportGrant(raw);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ repository: { owner: 'octo', repo: 'hello' }, expiresAtIso: VALID_EXPIRES_AT_ISO });
      expect(result.value).not.toBe(raw);
      expect(Object.isFrozen(result.value)).toBe(true);
      expect(Object.isFrozen(result.value.repository)).toBe(true);
    }
  });

  it('is neither constant nor identity: valid and null get opposite verdicts', () => {
    expect(parseShadowImportGrant(validGrant()).ok).toBe(true);
    expect(parseShadowImportGrant(null).ok).toBe(false);
  });

  it('validateShadowImportGrantCheck delegates to the same bounded check', () => {
    expect(validateShadowImportGrantCheck(validGrant()).ok).toBe(true);
    expect(validateShadowImportGrantCheck(null)).toEqual({
      ok: false,
      code: 'shadow-import-grant-not-object',
    });
    expect(validateShadowImportGrantCheck(42)).toEqual({
      ok: false,
      code: 'shadow-import-grant-not-object',
    });
  });
});

describe('shadowImportDigestPayload (GR1a1)', () => {
  it('refuses null by delegation without throwing', () => {
    expect(shadowImportDigestPayload(null)).toEqual({
      ok: false,
      code: 'shadow-import-grant-not-object',
    });
  });

  it('refuses undefined and wrong primitives by delegation', () => {
    expect(shadowImportDigestPayload(undefined)).toEqual({
      ok: false,
      code: 'shadow-import-grant-not-object',
    });
    expect(shadowImportDigestPayload(42)).toEqual({
      ok: false,
      code: 'shadow-import-grant-not-object',
    });
  });

  it('refuses a getter-carrying grant without running the getter', () => {
    let calls = 0;
    const raw: Record<string, unknown> = { expiresAtIso: VALID_EXPIRES_AT_ISO };
    Object.defineProperty(raw, 'repository', {
      get() {
        calls += 1;
        return { ...VALID_REPOSITORY };
      },
      enumerable: true,
    });
    const result = shadowImportDigestPayload(raw);
    expect(result.ok).toBe(false);
    expect(calls).toBe(0);
  });

  it('refuses a Proxy over a valid input without running any get trap', () => {
    let getCalls = 0;
    const proxy = new Proxy(validGrant(), {
      get(target, property, receiver) {
        getCalls += 1;
        return Reflect.get(target, property, receiver);
      },
    });
    const result = shadowImportDigestPayload(proxy);
    expect(getCalls).toBe(0);
    expect(result.ok).toBe(true);
  });

  it('builds the canonical payload in key order scope, owner, repo, expiresAtIso', () => {
    const result = shadowImportDigestPayload(validGrant());
    expect(result).toEqual({
      ok: true,
      value: JSON.stringify({
        scope: SHADOW_IMPORT_ACTION_SCOPE,
        owner: 'octo',
        repo: 'hello',
        expiresAtIso: VALID_EXPIRES_AT_ISO,
      }),
    });
  });

  it('is neither constant nor identity: changing a field changes the payload', () => {
    const first = shadowImportDigestPayload(validGrant());
    const changed = shadowImportDigestPayload({
      repository: { owner: 'octo', repo: 'world' },
      expiresAtIso: VALID_EXPIRES_AT_ISO,
    });
    expect(first.ok).toBe(true);
    expect(changed.ok).toBe(true);
    if (first.ok && changed.ok) {
      expect(first.value).not.toBe(changed.value);
      expect(first.value).not.toBe(validGrant());
    }
  });

  it('carries the digest prefix expectation used by the request id binding', () => {
    expect(SHADOW_IMPORT_DIGEST_PREFIX).toBe('shadow-import-');
  });
});

describe('isShadowImportActionScope (GR1a1)', () => {
  it('is true only for the exact shadow import scope', () => {
    expect(isShadowImportActionScope('merge:import-shadow')).toBe(true);
    expect(isShadowImportActionScope('merge:import')).toBe(false);
    expect(isShadowImportActionScope('merge:import-shadowed')).toBe(false);
    expect(isShadowImportActionScope('')).toBe(false);
  });
});
