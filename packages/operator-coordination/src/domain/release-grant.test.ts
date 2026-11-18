import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  MAX_RELEASE_ROOT_LENGTH,
  RELEASE_GRANT_DIGEST_PREFIX,
  parseReleaseGrantCoordinates,
  releaseGrantDigestPayload,
} from './coordination-records.js';

const SCOPE = 'release:install';
const PROJECT = 'proj-1';
const HEAD = '1111111111111111111111111111111111111111';
const ROOT = '/srv/fleet/releases';

function validGrant(): Record<string, unknown> {
  return { actionScope: SCOPE, projectId: PROJECT, expectedHeadSha: HEAD, releaseRoot: ROOT };
}

describe('parseReleaseGrantCoordinates (RR1 hostile inputs)', () => {
  it('refuses null with release-grant-not-object', () => {
    expect(parseReleaseGrantCoordinates(null)).toEqual({
      ok: false,
      code: 'release-grant-not-object',
    });
  });

  it('refuses undefined with release-grant-not-object', () => {
    expect(parseReleaseGrantCoordinates(undefined)).toEqual({
      ok: false,
      code: 'release-grant-not-object',
    });
  });

  it('refuses a wrong primitive (number where a grant object is due)', () => {
    expect(parseReleaseGrantCoordinates(42)).toEqual({
      ok: false,
      code: 'release-grant-not-object',
    });
  });

  it('refuses a wrong primitive for a string field (number projectId)', () => {
    expect(parseReleaseGrantCoordinates({ ...validGrant(), projectId: 42 })).toEqual({
      ok: false,
      code: 'release-grant-invalid-project',
    });
  });

  it('refuses a non-iterable object where a grant object is due ({ 0: "a" })', () => {
    expect(parseReleaseGrantCoordinates({ 0: 'a' })).toEqual({
      ok: false,
      code: 'release-grant-unexpected-key',
    });
  });

  it('refuses a sparse array (array hole) before any indexing', () => {
    expect(parseReleaseGrantCoordinates(new Array(1))).toEqual({
      ok: false,
      code: 'release-grant-not-object',
    });
  });

  it('refuses an array-like object { length: 1, 0: grant }', () => {
    expect(parseReleaseGrantCoordinates({ length: 1, 0: validGrant() })).toEqual({
      ok: false,
      code: 'release-grant-unexpected-key',
    });
  });

  it(`refuses an enormous-length sparse array in O(1) without traversal (cap ${MAX_RELEASE_ROOT_LENGTH})`, () => {
    const enormous: unknown[] = [];
    Object.defineProperty(enormous, 'length', { value: 2 ** 32 - 1 });
    const startedAt = Date.now();
    const result = parseReleaseGrantCoordinates(enormous);
    expect(result).toEqual({ ok: false, code: 'release-grant-not-object' });
    expect(Date.now() - startedAt).toBeLessThan(1000);
  });

  it('refuses a getter on the root without ever running it', () => {
    let calls = 0;
    const raw: Record<string, unknown> = {};
    for (const key of ['projectId', 'expectedHeadSha', 'releaseRoot']) {
      Object.defineProperty(raw, key, {
        get() {
          calls += 1;
          return validGrant()[key];
        },
        enumerable: true,
      });
    }
    raw.actionScope = SCOPE;
    const result = parseReleaseGrantCoordinates(raw);
    expect(result).toEqual({ ok: false, code: 'release-grant-accessor-forbidden' });
    expect(calls).toBe(0);
  });

  it('refuses a getter on an item (a nested value would be one) without ever running it', () => {
    let calls = 0;
    const raw = validGrant();
    Object.defineProperty(raw, 'releaseRoot', {
      get() {
        calls += 1;
        return ROOT;
      },
      enumerable: true,
    });
    const result = parseReleaseGrantCoordinates(raw);
    expect(result).toEqual({ ok: false, code: 'release-grant-accessor-forbidden' });
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
    const result = parseReleaseGrantCoordinates(proxy);
    expect(getCalls).toBe(0);
    const plain = parseReleaseGrantCoordinates(validGrant());
    if (result.ok) {
      expect(plain).toEqual(result);
    } else {
      expect(result).toEqual(plain);
    }
  });

  it('refuses a Proxy whose get trap counters reads (no trap ever runs)', () => {
    let getCalls = 0;
    const proxy = new Proxy(validGrant(), {
      get() {
        getCalls += 1;
        return undefined;
      },
    });
    // `Reflect.ownKeys` and `getOwnPropertyDescriptor` never consult a `get`
    // trap, so a proxy over plain data is read safely: no trap ran, and the
    // parse reads the target's own data exactly.
    expect(parseReleaseGrantCoordinates(proxy)).toEqual(parseReleaseGrantCoordinates(validGrant()));
    expect(getCalls).toBe(0);
  });

  for (const key of ['__proto__', 'constructor', 'prototype']) {
    it(`refuses an own ${key} key from JSON.parse as a forbidden key`, () => {
      const hostile = JSON.parse(
        `{"actionScope":"${SCOPE}","projectId":"${PROJECT}","expectedHeadSha":"${HEAD}","releaseRoot":"${ROOT}","${key}":{"polluted":true}}`,
      ) as Record<string, unknown>;
      expect(parseReleaseGrantCoordinates(hostile)).toEqual({
        ok: false,
        code: 'release-grant-forbidden-key',
      });
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    });
  }

  it('refuses an unknown extra key', () => {
    expect(parseReleaseGrantCoordinates({ ...validGrant(), extra: 1 })).toEqual({
      ok: false,
      code: 'release-grant-unexpected-key',
    });
  });

  it('refuses a non-release scope with release-grant-invalid-scope', () => {
    expect(parseReleaseGrantCoordinates({ ...validGrant(), actionScope: 'forge:merge-pr' })).toEqual({
      ok: false,
      code: 'release-grant-invalid-scope',
    });
    expect(parseReleaseGrantCoordinates({ ...validGrant(), actionScope: 'release:unknown' })).toEqual({
      ok: false,
      code: 'release-grant-invalid-scope',
    });
  });

  it('refuses an empty or control-character projectId with release-grant-invalid-project', () => {
    expect(parseReleaseGrantCoordinates({ ...validGrant(), projectId: '   ' })).toEqual({
      ok: false,
      code: 'release-grant-invalid-project',
    });
    expect(parseReleaseGrantCoordinates({ ...validGrant(), projectId: 'a\0b' })).toEqual({
      ok: false,
      code: 'release-grant-invalid-project',
    });
    expect(parseReleaseGrantCoordinates({ ...validGrant(), projectId: 'p'.repeat(257) })).toEqual({
      ok: false,
      code: 'release-grant-invalid-project',
    });
  });

  it('refuses an empty, oversized or control-character expectedHeadSha with release-grant-invalid-head', () => {
    expect(parseReleaseGrantCoordinates({ ...validGrant(), expectedHeadSha: '' })).toEqual({
      ok: false,
      code: 'release-grant-invalid-head',
    });
    expect(parseReleaseGrantCoordinates({ ...validGrant(), expectedHeadSha: 'a\0b' })).toEqual({
      ok: false,
      code: 'release-grant-invalid-head',
    });
    expect(parseReleaseGrantCoordinates({ ...validGrant(), expectedHeadSha: 'h'.repeat(257) })).toEqual({
      ok: false,
      code: 'release-grant-invalid-head',
    });
  });

  it('refuses an invalid releaseRoot with release-grant-invalid-root', () => {
    for (const badRoot of ['relative/path', '/srv/../etc', '/srv/x\0y', `/${'r'.repeat(MAX_RELEASE_ROOT_LENGTH + 1)}`, '', 7, null]) {
      expect(parseReleaseGrantCoordinates({ ...validGrant(), releaseRoot: badRoot })).toEqual({
        ok: false,
        code: 'release-grant-invalid-root',
      });
    }
  });

  it('is neither constant nor identity: different hostile inputs name different codes', () => {
    // A constant-verdict implementation would return the same code for every
    // input; these three each name a different refusal.
    const nullResult = parseReleaseGrantCoordinates(null);
    const wrongProject = parseReleaseGrantCoordinates({ ...validGrant(), projectId: 42 });
    const traversalRoot = parseReleaseGrantCoordinates({ ...validGrant(), releaseRoot: '/srv/../etc' });
    expect(nullResult.ok).toBe(false);
    expect(wrongProject.ok).toBe(false);
    expect(traversalRoot.ok).toBe(false);
    if (!nullResult.ok && !wrongProject.ok && !traversalRoot.ok) {
      expect(nullResult.code).not.toBe(wrongProject.code);
      expect(wrongProject.code).not.toBe(traversalRoot.code);
    }
    // An identity echo of the input would accept the accessor-carrying root
    // and the wrong scope; the parser refuses both.
    const accessorRoot = validGrant();
    Object.defineProperty(accessorRoot, 'releaseRoot', {
      get: () => ROOT,
      enumerable: true,
    });
    expect(parseReleaseGrantCoordinates(accessorRoot).ok).toBe(false);
    expect(parseReleaseGrantCoordinates({ ...validGrant(), actionScope: 'forge:merge-pr' }).ok).toBe(false);
  });

  it('accepts a valid grant with every field intact', () => {
    const parsed = parseReleaseGrantCoordinates(validGrant());
    expect(parsed).toEqual({
      ok: true,
      value: { actionScope: SCOPE, projectId: PROJECT, expectedHeadSha: HEAD, releaseRoot: ROOT },
    });
  });
});

describe('releaseGrantDigestPayload (RR1)', () => {
  function digestOf(grant: Record<string, unknown>): string {
    const parsed = parseReleaseGrantCoordinates(grant);
    if (!parsed.ok) {
      throw new Error('fixture must be valid');
    }
    return createHash('sha256')
      .update(
        JSON.stringify({
          scope: parsed.value.actionScope,
          projectId: parsed.value.projectId,
          expectedHeadSha: parsed.value.expectedHeadSha,
          releaseRoot: parsed.value.releaseRoot,
        }),
      )
      .digest('hex');
  }

  it('binds a valid grant to the sha256 of its canonical coordinates', () => {
    const result = releaseGrantDigestPayload(validGrant());
    expect(result).toEqual({ ok: true, value: JSON.stringify({
      scope: SCOPE,
      projectId: PROJECT,
      expectedHeadSha: HEAD,
      releaseRoot: ROOT,
    }) });
    expect(`${RELEASE_GRANT_DIGEST_PREFIX}${digestOf(validGrant())}`).toBe(
      `${RELEASE_GRANT_DIGEST_PREFIX}${createHash('sha256').update((result as { value: string }).value).digest('hex')}`,
    );
  });

  it('delegates every hostile input to the parser and never throws', () => {
    for (const hostile of [
      null,
      undefined,
      42,
      new Array(1),
      { length: 1, 0: validGrant() },
      { ...validGrant(), extra: 1 },
    ]) {
      expect(releaseGrantDigestPayload(hostile)).toEqual(parseReleaseGrantCoordinates(hostile));
    }
    let calls = 0;
    const getterRoot = validGrant();
    Object.defineProperty(getterRoot, 'releaseRoot', {
      get() {
        calls += 1;
        return ROOT;
      },
      enumerable: true,
    });
    expect(releaseGrantDigestPayload(getterRoot)).toEqual({
      ok: false,
      code: 'release-grant-accessor-forbidden',
    });
    expect(calls).toBe(0);
  });

  it('changes with the coordinates: two different roots carry different payloads', () => {
    const other = releaseGrantDigestPayload({ ...validGrant(), releaseRoot: '/srv/fleet/other' });
    const base = releaseGrantDigestPayload(validGrant());
    expect(base).not.toEqual(other);
  });
});
