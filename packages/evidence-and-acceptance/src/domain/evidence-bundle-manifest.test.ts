/**
 * Mutation map for the orchestrator: for each test, the one-line mutation of
 * evidence-bundle-manifest.ts it must fail against. The implementer ran none of them.
 *
 * - pins the documented caps: set MAX_BUNDLE_ENTRIES to 2001.
 * - deterministic test hasher: none (it guards the test hasher, not production code).
 * - sorted manifest / canonical lines: drop the bytes term from the canonicalLines template.
 * - UTF-16 code-unit order: make comparePaths use a.path.localeCompare(b.path).
 * - every order of the same entries: delete `hashed.sort(comparePaths);`.
 * - UTF-8 byte lengths: change `bytes += 4` to `bytes += 2`.
 * - empty manifest: start canonicalLines with `let lines = ' ';`.
 * - __proto__/constructor paths: make `seen` a `{}` tested with `seen[path] !== undefined`.
 * - once per entry plus once: hash `entry.content` a second time in buildBundleManifest.
 * - exactly MAX_BUNDLE_ENTRIES: change `length > MAX_BUNDLE_ENTRIES` to `>=` in readEntries.
 * - null/primitive/array-like: replace `!safeIsArray(entries)` with `entries === null`.
 * - holes and getters: read `(entries as unknown[])[i]` instead of `ownData(entries, i)`.
 * - Proxy: delete the try/catch of safeIsArray, or read `list.length` in readLength.
 * - before walking: delete the `length > MAX_BUNDLE_ENTRIES` refusal in readEntries.
 * - invalid paths: delete the `segment === '..'` clause of isValidBundlePath.
 * - duplicate paths: make `seen.has(path)` test `path.toLowerCase()`.
 * - non-string content: delete the `typeof content !== 'string'` refusal.
 * - 1 MiB UTF-8: delete the final `bytes > MAX_BUNDLE_CONTENT_BYTES` check in measureUtf8.
 * - build hasher: drop the `SHA256_HEX.test(digest)` check from runSha256Hex.
 * - untouched, any order: look entries up by index, not through the `present` Map.
 * - changed: reduce the comparison to `actual.bytes !== expected.bytes`.
 * - missing: delete the `kind: 'missing'` push.
 * - extra: delete the `kind: 'extra'` push.
 * - renamed: delete either the missing or the extra push.
 * - digest-mismatch: delete the `recomputed !== parsed.bundleDigest` push.
 * - sorted problems: delete `.sort(compareProblems)`.
 * - unknown schemaVersion: compare with `Number(versionDescriptor.value) !== 1`.
 * - absent schemaVersion: add `versionDescriptor === undefined ||` to the unknown-version test.
 * - malformed manifests: delete the `!(previous < path)` ordering check in readManifest.
 * - malformed entries: change `parsed === null || !read.ok` to `parsed === null`.
 * - verify hasher-failed: make the runSha256Hex catch return `'a'.repeat(64)`.
 * - constant hasher: replace `actual.bytes !== expected.bytes ||` with `false ||`.
 * - frozen inputs / N + 1 calls: hash `actual.content` a second time in verify.
 */

import { describe, expect, it } from 'vitest';
import {
  BUNDLE_MANIFEST_SCHEMA_VERSION,
  MAX_BUNDLE_CONTENT_BYTES,
  MAX_BUNDLE_ENTRIES,
  MAX_BUNDLE_PATH_LENGTH,
  buildBundleManifest,
  verifyBundleManifest,
} from './evidence-bundle-manifest.js';
import type { BundleManifest, Sha256HexFn } from './evidence-bundle-manifest.js';

/**
 * Pure deterministic stand-in for SHA-256 (the domain imports no `node:` module): eight
 * 32-bit lanes mixed per UTF-16 unit and rendered as 64 lowercase hex characters. It is
 * not cryptographic; it only has to depend on the whole text and on its length.
 */
function testSha256Hex(text: string): string {
  let lanes = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ];
  for (let i = 0; i < text.length; i += 1) {
    const unit = text.charCodeAt(i);
    lanes = lanes.map((lane, index) => {
      let mixed = Math.imul(lane ^ (unit + index), 0x01000193 + 2 * index);
      mixed ^= mixed >>> 13;
      mixed = Math.imul(mixed, 0x5bd1e995);
      return (mixed ^ (mixed >>> 15)) >>> 0;
    });
  }
  return lanes
    .map((lane, index) => {
      const folded = Math.imul(lane ^ text.length, 0x9e3779b1 + 2 * index) >>> 0;
      return folded.toString(16).padStart(8, '0');
    })
    .join('');
}

const CONSTANT_DIGEST = 'a'.repeat(64);
const constantHasher: Sha256HexFn = () => CONSTANT_DIGEST;
const MANIFEST_INVALID = { ok: false, problems: [{ kind: 'manifest-invalid', path: null }] };

function entry(path: string, content: string): { path: string; content: string } {
  return { path, content };
}

function countingHasher(): { readonly hasher: Sha256HexFn; readonly calls: () => number } {
  let count = 0;
  return {
    hasher: (text) => {
      count += 1;
      return testSha256Hex(text);
    },
    calls: () => count,
  };
}

function mustBuild(entries: unknown, hasher: Sha256HexFn = testSha256Hex): BundleManifest {
  const result = buildBundleManifest(entries, hasher);
  if (!result.ok) {
    throw new Error(`build refused: ${result.reason}`);
  }
  return result.manifest;
}

function withEntry(
  manifest: BundleManifest,
  index: number,
  patch: Record<string, unknown>,
): unknown {
  return {
    ...manifest,
    entries: manifest.entries.map((e, i) => (i === index ? { ...e, ...patch } : { ...e })),
  };
}

function trap(): never {
  throw new Error('trap ran');
}

function throwingProxy<T extends object>(target: T): T {
  return new Proxy(target, {
    get: trap,
    getOwnPropertyDescriptor: trap,
    getPrototypeOf: trap,
    has: trap,
    ownKeys: trap,
  });
}

function revokedProxy(target: object): object {
  const { proxy, revoke } = Proxy.revocable(target, {});
  revoke();
  return proxy;
}

function holey(item: unknown): unknown[] {
  const list: unknown[] = [item];
  delete list[0];
  return list;
}

function withLength(list: unknown[], length: number): unknown[] {
  Object.defineProperty(list, 'length', { value: length });
  return list;
}

function withThrowingGetter<T extends object>(target: T, key: string, onRead: () => void): T {
  Object.defineProperty(target, key, {
    get() {
      onRead();
      throw new Error('getter ran');
    },
    enumerable: true,
    configurable: true,
  });
  return target;
}

function readCounter(): { readonly onRead: () => void; readonly reads: () => number } {
  let count = 0;
  return {
    onRead: () => {
      count += 1;
    },
    reads: () => count,
  };
}

describe('test hasher and constants', () => {
  it('pins the documented caps and schema version', () => {
    expect(BUNDLE_MANIFEST_SCHEMA_VERSION).toBe(1);
    expect(MAX_BUNDLE_ENTRIES).toBe(2000);
    expect(MAX_BUNDLE_PATH_LENGTH).toBe(200);
    expect(MAX_BUNDLE_CONTENT_BYTES).toBe(1048576);
  });

  it('uses a deterministic 64-hex test hasher that tells different texts apart', () => {
    expect(testSha256Hex('a')).toMatch(/^[0-9a-f]{64}$/);
    expect(testSha256Hex('a')).toBe(testSha256Hex('a'));
    expect(testSha256Hex('a')).not.toBe(testSha256Hex('b'));
    expect(testSha256Hex('ab')).not.toBe(testSha256Hex('ba'));
    expect(testSha256Hex('')).not.toBe(testSha256Hex('\u0000'));
  });
});

describe('buildBundleManifest', () => {
  it('builds a sorted manifest whose bundleDigest covers the canonical path, sha256 and bytes lines', () => {
    const sha = testSha256Hex;
    const manifest = mustBuild([entry('b', 'two'), entry('a', 'one')]);
    expect(manifest).toEqual({
      schemaVersion: 1,
      entries: [
        { path: 'a', sha256: sha('one'), bytes: 3 },
        { path: 'b', sha256: sha('two'), bytes: 3 },
      ],
      bundleDigest: sha(`a\n${sha('one')}\n3\nb\n${sha('two')}\n3\n`),
    });
    expect(manifest.schemaVersion).toBe(BUNDLE_MANIFEST_SCHEMA_VERSION);
  });

  it('orders paths by UTF-16 code unit, not by code point, locale or case folding', () => {
    const paths = ['b', 'a', 'aa', 'B', 'x\uffff', 'x\u{1f600}'];
    const manifest = mustBuild(paths.map((path) => entry(path, 'same')));
    const ordered = manifest.entries.map((e) => e.path);
    expect(ordered).toEqual(['B', 'a', 'aa', 'b', 'x\u{1f600}', 'x\uffff']);
  });

  it('yields the identical manifest for every order of the same entries', () => {
    const a = entry('a', 'one');
    const b = entry('b', 'two');
    const c = entry('c', 'three');
    const expected = mustBuild([a, b, c]);
    for (const order of [[c, b, a], [b, c, a], [a, c, b], [c, a, b], [b, a, c]]) {
      expect(mustBuild(order)).toEqual(expected);
    }
    expect(expected.entries.map((e) => e.path)).toEqual(['a', 'b', 'c']);
  });

  it('records UTF-8 byte lengths for accented, emoji, CRLF, empty and mixed content', () => {
    const manifest = mustBuild([
      entry('accent', '\u00e9'),
      entry('emoji', '\u{1f600}'),
      entry('crlf', '\r\n'),
      entry('empty', ''),
      entry('mixed', '\u00e9\u{1f600}\r\n'),
    ]);
    const bytes = Object.fromEntries(manifest.entries.map((e) => [e.path, e.bytes]));
    expect(bytes).toEqual({ accent: 2, crlf: 2, emoji: 4, empty: 0, mixed: 8 });
    expect(manifest.entries.find((e) => e.path === 'empty')?.sha256).toBe(testSha256Hex(''));
  });

  it('builds an empty manifest whose bundleDigest is the digest of the empty canonical text', () => {
    expect(mustBuild([])).toEqual({
      schemaVersion: 1,
      entries: [],
      bundleDigest: testSha256Hex(''),
    });
  });

  it('stores __proto__, constructor and prototype paths as ordinary entries and pollutes nothing', () => {
    const paths = ['__proto__', 'constructor', 'prototype', 'toString', 'hasOwnProperty'];
    const input = paths.map((path) => entry(path, `content of ${path}`));
    const manifest = mustBuild(input);
    expect(manifest.entries.map((e) => e.path)).toEqual([...paths].sort());
    expect(verifyBundleManifest(manifest, input, testSha256Hex)).toEqual({ ok: true });

    const parsed: unknown = JSON.parse(
      '[{"path":"p","content":"c","__proto__":{"polluted":true}}]',
    );
    expect(buildBundleManifest(parsed, testSha256Hex).ok).toBe(true);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.getPrototypeOf({})).toBe(Object.prototype);
  });

  it('calls sha256Hex exactly once per entry plus once for the bundleDigest', () => {
    const three = countingHasher();
    mustBuild([entry('a', '1'), entry('b', '2'), entry('c', '3')], three.hasher);
    expect(three.calls()).toBe(4);
    const none = countingHasher();
    mustBuild([], none.hasher);
    expect(none.calls()).toBe(1);
  });

  it('accepts exactly MAX_BUNDLE_ENTRIES entries, a 200-character path and a 1 MiB content', () => {
    const many = Array.from({ length: MAX_BUNDLE_ENTRIES }, (_, i) => entry(`f${i}`, String(i)));
    expect(mustBuild(many).entries).toHaveLength(MAX_BUNDLE_ENTRIES);

    const longPath = 'a'.repeat(MAX_BUNDLE_PATH_LENGTH);
    const ascii = 'a'.repeat(MAX_BUNDLE_CONTENT_BYTES);
    const accented = '\u00e9'.repeat(MAX_BUNDLE_CONTENT_BYTES / 2);
    expect(
      buildBundleManifest([entry(longPath, ascii), entry('accented', accented)], constantHasher),
    ).toEqual({
      ok: true,
      manifest: {
        schemaVersion: 1,
        entries: [
          { path: longPath, sha256: CONSTANT_DIGEST, bytes: MAX_BUNDLE_CONTENT_BYTES },
          { path: 'accented', sha256: CONSTANT_DIGEST, bytes: MAX_BUNDLE_CONTENT_BYTES },
        ],
        bundleDigest: CONSTANT_DIGEST,
      },
    });
  });

  it('refuses null, undefined, primitive, and array-like entries', () => {
    const values: unknown[] = [
      null,
      undefined,
      'abc',
      42,
      true,
      Symbol('entries'),
      () => [],
      {},
      { 0: entry('a', 'x'), length: 1 },
      new Set([entry('a', 'x')]),
      new Map(),
    ];
    for (const value of values) {
      expect(buildBundleManifest(value, testSha256Hex)).toEqual({
        ok: false,
        reason: 'invalid-entries',
      });
    }
  });

  it('refuses array holes and getters in entries without running the getter', () => {
    const counter = readCounter();
    const getterList: unknown[] = [];
    Object.defineProperty(getterList, '0', {
      get() {
        counter.onRead();
        return entry('a', 'x');
      },
      enumerable: true,
    });
    expect(buildBundleManifest(getterList, testSha256Hex)).toEqual({
      ok: false,
      reason: 'invalid-entries',
    });
    expect(buildBundleManifest(holey(entry('a', 'x')), testSha256Hex)).toEqual({
      ok: false,
      reason: 'invalid-entries',
    });
    const second: unknown[] = [entry('a', 'x'), entry('b', 'y')];
    delete second[1];
    expect(buildBundleManifest(second, testSha256Hex)).toEqual({
      ok: false,
      reason: 'invalid-entries',
    });
    const pathGetter = withThrowingGetter({ content: 'x' }, 'path', counter.onRead);
    expect(buildBundleManifest([pathGetter], testSha256Hex)).toEqual({
      ok: false,
      reason: 'invalid-path',
    });
    const contentGetter = withThrowingGetter({ path: 'a' }, 'content', counter.onRead);
    expect(buildBundleManifest([contentGetter], testSha256Hex)).toEqual({
      ok: false,
      reason: 'content-invalid',
    });
    expect(counter.reads()).toBe(0);
  });

  it('refuses a throwing Proxy, a revoked Proxy and a Proxy entry without throwing', () => {
    const cases: unknown[] = [
      throwingProxy([entry('a', 'x')]),
      revokedProxy([]),
      [throwingProxy({ path: 'a', content: 'x' })],
      [revokedProxy({})],
    ];
    for (const value of cases) {
      expect(() => buildBundleManifest(value, testSha256Hex)).not.toThrow();
      expect(buildBundleManifest(value, testSha256Hex)).toEqual({
        ok: false,
        reason: 'invalid-entries',
      });
    }
  });

  it('refuses entries exceeding MAX_BUNDLE_ENTRIES before walking', () => {
    const counter = readCounter();
    const over: unknown[] = [];
    withThrowingGetter(over, '0', counter.onRead);
    withLength(over, MAX_BUNDLE_ENTRIES + 1);
    const enormous = withLength([], 2 ** 32 - 1);
    for (const value of [over, enormous, withLength([], MAX_BUNDLE_ENTRIES + 1)]) {
      expect(buildBundleManifest(value, testSha256Hex)).toEqual({
        ok: false,
        reason: 'too-many-entries',
      });
    }
    expect(counter.reads()).toBe(0);
  });

  it('refuses invalid, absolute, traversal, control-char, NUL, and overlong paths', () => {
    const invalid: unknown[] = [
      '',
      'a'.repeat(MAX_BUNDLE_PATH_LENGTH + 1),
      '/a',
      '/',
      'a/',
      'a\\b',
      'a//b',
      '.',
      '..',
      './a',
      '../a',
      'a/./b',
      'a/../b',
      'a/.',
      'a/..',
      'a\u0000b',
      'a\nb',
      'a\rb',
      'a\tb',
      'a\u001fb',
      'a\u007fb',
      'a\ud800',
      1,
      null,
      undefined,
      {},
      ['a'],
    ];
    for (const path of invalid) {
      expect(buildBundleManifest([{ path, content: 'x' }], testSha256Hex)).toEqual({
        ok: false,
        reason: 'invalid-path',
      });
    }
    expect(buildBundleManifest([{ content: 'x' }], testSha256Hex)).toEqual({
      ok: false,
      reason: 'invalid-path',
    });
    const valid = ['a', 'a/b/c.txt', '..a', 'a..', '.hidden', 'a/.b', 'a b', '\u00fc/\u00e9'];
    for (const path of valid) {
      expect(buildBundleManifest([entry(path, 'x')], testSha256Hex).ok).toBe(true);
    }
  });

  it('refuses duplicate paths while treating case differences as distinct', () => {
    for (const entries of [
      [entry('a', 'x'), entry('a', 'y')],
      [entry('a', 'x'), entry('b', 'y'), entry('a', 'x')],
      [entry('__proto__', 'x'), entry('__proto__', 'y')],
    ]) {
      expect(buildBundleManifest(entries, testSha256Hex)).toEqual({
        ok: false,
        reason: 'duplicate-path',
      });
    }
    const distinct = mustBuild([
      entry('a', 'x'),
      entry('A', 'x'),
      entry('e\u0301', 'x'),
      entry('\u00e9', 'x'),
    ]);
    expect(distinct.entries.map((e) => e.path)).toEqual(['A', 'a', 'e\u0301', '\u00e9']);
  });

  it('refuses non-string or unreadable content', () => {
    const counter = readCounter();
    const invalid: unknown[] = [
      undefined,
      null,
      5,
      true,
      {},
      ['x'],
      '\ud800',
      'a\udc00b',
      'a\ud800b',
    ];
    for (const content of invalid) {
      expect(buildBundleManifest([{ path: 'a', content }], testSha256Hex)).toEqual({
        ok: false,
        reason: 'content-invalid',
      });
    }
    expect(buildBundleManifest([{ path: 'a' }], testSha256Hex)).toEqual({
      ok: false,
      reason: 'content-invalid',
    });
    const unreadable = withThrowingGetter({ path: 'a' }, 'content', counter.onRead);
    expect(buildBundleManifest([unreadable], testSha256Hex)).toEqual({
      ok: false,
      reason: 'content-invalid',
    });
    expect(counter.reads()).toBe(0);
    expect(buildBundleManifest([entry('a', '\u{1f600}')], testSha256Hex).ok).toBe(true);
  });

  it('refuses content exceeding 1 MiB UTF-8 bytes and never hashes it', () => {
    const over = [
      'a'.repeat(MAX_BUNDLE_CONTENT_BYTES + 1),
      '\u00e9'.repeat(MAX_BUNDLE_CONTENT_BYTES / 2 + 1),
      '\u{1f600}'.repeat(MAX_BUNDLE_CONTENT_BYTES / 4 + 1),
    ];
    for (const content of over) {
      const counter = countingHasher();
      expect(buildBundleManifest([entry('a', content)], counter.hasher)).toEqual({
        ok: false,
        reason: 'content-too-large',
      });
      expect(counter.calls()).toBe(0);
    }
  });

  it('refuses a throwing or non-64-lowercase-hex hasher in buildBundleManifest', () => {
    const bad: unknown[] = [
      () => {
        throw new Error('hasher failed');
      },
      () => 'A'.repeat(64),
      () => 'a'.repeat(63),
      () => 'a'.repeat(65),
      () => `${'a'.repeat(64)}\n`,
      () => 'g'.repeat(64),
      () => '',
      () => 42,
      () => undefined,
      () => null,
      undefined,
      'sha256',
    ];
    for (const hasher of bad) {
      expect(buildBundleManifest([entry('a', 'x')], hasher as Sha256HexFn)).toEqual({
        ok: false,
        reason: 'hasher-failed',
      });
      expect(buildBundleManifest([], hasher as Sha256HexFn)).toEqual({
        ok: false,
        reason: 'hasher-failed',
      });
    }
    let calls = 0;
    const failsOnDigest: Sha256HexFn = (text) => {
      calls += 1;
      return calls === 1 ? testSha256Hex(text) : 'not-a-digest';
    };
    expect(buildBundleManifest([entry('a', 'x')], failsOnDigest)).toEqual({
      ok: false,
      reason: 'hasher-failed',
    });
  });
});

describe('verifyBundleManifest', () => {
  const inputs = [entry('a', 'payload-a'), entry('b', 'payload-b')];
  const good = mustBuild(inputs);

  it('verifies an untouched bundle regardless of entry order, including an empty bundle', () => {
    const reversed = [...inputs].reverse();
    expect(verifyBundleManifest(good, inputs, testSha256Hex)).toEqual({ ok: true });
    expect(verifyBundleManifest(good, reversed, testSha256Hex)).toEqual({ ok: true });
    expect(verifyBundleManifest(mustBuild([]), [], testSha256Hex)).toEqual({ ok: true });
  });

  it('reports changed for modified content, tampered bytes, or tampered entry sha256', () => {
    const modified = [entry('a', 'payload-X'), inputs[1]];
    const sameLength = verifyBundleManifest(good, modified, testSha256Hex);
    expect(sameLength).toEqual({ ok: false, problems: [{ kind: 'changed', path: 'a' }] });

    const tamperedBytes = withEntry(good, 0, { bytes: 10 });
    expect(verifyBundleManifest(tamperedBytes, inputs, testSha256Hex)).toEqual({
      ok: false,
      problems: [
        { kind: 'digest-mismatch', path: null },
        { kind: 'changed', path: 'a' },
      ],
    });
    const tamperedSha = withEntry(good, 1, { sha256: '0'.repeat(64) });
    expect(verifyBundleManifest(tamperedSha, inputs, testSha256Hex)).toEqual({
      ok: false,
      problems: [
        { kind: 'digest-mismatch', path: null },
        { kind: 'changed', path: 'b' },
      ],
    });

    const leaked = JSON.stringify(sameLength);
    expect(leaked).not.toContain('payload');
    expect(leaked).not.toContain(testSha256Hex('payload-a'));
    expect(leaked).not.toContain(testSha256Hex('payload-X'));
  });

  it('reports missing when a manifest entry is absent from entries', () => {
    expect(verifyBundleManifest(good, [inputs[0]], testSha256Hex)).toEqual({
      ok: false,
      problems: [{ kind: 'missing', path: 'b' }],
    });
    expect(verifyBundleManifest(good, [], testSha256Hex)).toEqual({
      ok: false,
      problems: [
        { kind: 'missing', path: 'a' },
        { kind: 'missing', path: 'b' },
      ],
    });
  });

  it('reports extra when entries contains an unlisted path', () => {
    const withExtra = [...inputs, entry('c', 'payload-c')];
    expect(verifyBundleManifest(good, withExtra, testSha256Hex)).toEqual({
      ok: false,
      problems: [{ kind: 'extra', path: 'c' }],
    });
    expect(verifyBundleManifest(mustBuild([]), inputs, testSha256Hex)).toEqual({
      ok: false,
      problems: [
        { kind: 'extra', path: 'a' },
        { kind: 'extra', path: 'b' },
      ],
    });
  });

  it('reports missing and extra when an entry is renamed', () => {
    const renamed = [inputs[0], entry('c', 'payload-b')];
    expect(verifyBundleManifest(good, renamed, testSha256Hex)).toEqual({
      ok: false,
      problems: [
        { kind: 'missing', path: 'b' },
        { kind: 'extra', path: 'c' },
      ],
    });
  });

  it('reports digest-mismatch when bundleDigest is tampered', () => {
    const tampered = { ...good, bundleDigest: '0'.repeat(64) };
    expect(verifyBundleManifest(tampered, inputs, testSha256Hex)).toEqual({
      ok: false,
      problems: [{ kind: 'digest-mismatch', path: null }],
    });
    const dropped = { ...good, entries: good.entries.slice(1) };
    expect(verifyBundleManifest(dropped, inputs, testSha256Hex)).toEqual({
      ok: false,
      problems: [
        { kind: 'digest-mismatch', path: null },
        { kind: 'extra', path: 'a' },
      ],
    });
  });

  it('reports problems sorted by path, with the manifest-wide problem first', () => {
    const manifest = mustBuild([entry('a', '1'), entry('b', '2'), entry('c', '3')]);
    const tampered = { ...manifest, bundleDigest: '0'.repeat(64) };
    const bundle = [entry('d', '4'), entry('c', '3'), entry('a', '9'), entry('aa', '5')];
    expect(verifyBundleManifest(tampered, bundle, testSha256Hex)).toEqual({
      ok: false,
      problems: [
        { kind: 'digest-mismatch', path: null },
        { kind: 'changed', path: 'a' },
        { kind: 'extra', path: 'aa' },
        { kind: 'missing', path: 'b' },
        { kind: 'extra', path: 'd' },
      ],
    });
  });

  it('rejects unknown schemaVersion values without judging entries or digest', () => {
    const counter = readCounter();
    const versions: unknown[] = [2, 0, '1', 1.5, null, undefined, Number.NaN, true, [1], {}];
    for (const schemaVersion of versions) {
      const junk = { schemaVersion, entries: 'junk', bundleDigest: 'junk' };
      const expected = { ok: false, problems: [{ kind: 'unknown-schema-version', path: null }] };
      const versioned = { ...good, schemaVersion };
      expect(verifyBundleManifest(junk, null, testSha256Hex)).toEqual(expected);
      expect(verifyBundleManifest(versioned, inputs, testSha256Hex)).toEqual(expected);
    }
    const accessor = withThrowingGetter({ ...good }, 'schemaVersion', counter.onRead);
    expect(verifyBundleManifest(accessor, inputs, testSha256Hex)).toEqual({
      ok: false,
      problems: [{ kind: 'unknown-schema-version', path: null }],
    });
    expect(counter.reads()).toBe(0);
  });

  it('accepts a manifest with absent schemaVersion as version 1', () => {
    const absent = { entries: good.entries, bundleDigest: good.bundleDigest };
    expect(verifyBundleManifest(absent, inputs, testSha256Hex)).toEqual({ ok: true });
    expect(verifyBundleManifest(absent, [inputs[0]], testSha256Hex)).toEqual({
      ok: false,
      problems: [{ kind: 'missing', path: 'b' }],
    });
    expect(verifyBundleManifest({ ...good, schemaVersion: 1 }, inputs, testSha256Hex)).toEqual({
      ok: true,
    });
  });

  it('refuses malformed manifests, getters, holes, and prototype-polluting keys', () => {
    const counter = readCounter();
    const bad = 'A'.repeat(64);
    const [first] = good.entries;
    const manifests: unknown[] = [
      null,
      undefined,
      'manifest',
      7,
      [],
      [good],
      new Map(),
      {},
      throwingProxy({}),
      revokedProxy({}),
      { ...good, entries: null },
      { ...good, entries: { 0: first, length: 1 } },
      { ...good, entries: holey(first) },
      { ...good, entries: withLength([], MAX_BUNDLE_ENTRIES + 1) },
      { ...good, entries: [first, first] },
      { ...good, entries: [...good.entries].reverse() },
      { ...good, entries: [null] },
      { ...good, entries: [[]] },
      { ...good, entries: [Object.create({ path: 'a' })] },
      { ...good, bundleDigest: bad },
      { ...good, bundleDigest: 'a'.repeat(63) },
      { ...good, bundleDigest: 7 },
      { entries: good.entries },
      withThrowingGetter({ ...good }, 'entries', counter.onRead),
      withThrowingGetter({ ...good }, 'bundleDigest', counter.onRead),
      JSON.parse(`{"__proto__":{"entries":[],"bundleDigest":"${'0'.repeat(64)}"}}`),
    ];
    const patches: Record<string, unknown>[] = [
      { sha256: bad },
      { sha256: 'a'.repeat(63) },
      { sha256: 5 },
      { sha256: undefined },
      { bytes: -1 },
      { bytes: 1.5 },
      { bytes: Number.NaN },
      { bytes: Number.POSITIVE_INFINITY },
      { bytes: '9' },
      { bytes: undefined },
      { bytes: MAX_BUNDLE_CONTENT_BYTES + 1 },
      { bytes: 2 ** 53 },
      { path: '../x' },
      { path: '' },
      { path: 5 },
      { path: 'b/' },
    ];
    for (const patch of patches) {
      manifests.push(withEntry(good, 0, patch));
    }
    for (const manifest of manifests) {
      expect(() => verifyBundleManifest(manifest, inputs, testSha256Hex)).not.toThrow();
      expect(verifyBundleManifest(manifest, inputs, testSha256Hex)).toEqual(MANIFEST_INVALID);
    }
    expect(counter.reads()).toBe(0);
    expect(({} as Record<string, unknown>).entries).toBeUndefined();
  });

  it('refuses malformed entries as manifest-invalid without running a getter', () => {
    const counter = readCounter();
    const values: unknown[] = [
      null,
      undefined,
      'entries',
      7,
      { 0: inputs[0], length: 1 },
      holey(inputs[0]),
      throwingProxy([]),
      revokedProxy([]),
      withLength([], 2 ** 32 - 1),
      withLength([], MAX_BUNDLE_ENTRIES + 1),
      [inputs[0], inputs[0]],
      [entry('../a', 'x'), inputs[1]],
      [{ path: 'a', content: 5 }, inputs[1]],
      [{ path: 'a', content: '\ud800' }, inputs[1]],
      [entry('a', 'a'.repeat(MAX_BUNDLE_CONTENT_BYTES + 1)), inputs[1]],
      [withThrowingGetter({ content: 'payload-a' }, 'path', counter.onRead), inputs[1]],
    ];
    for (const value of values) {
      expect(() => verifyBundleManifest(good, value, testSha256Hex)).not.toThrow();
      expect(verifyBundleManifest(good, value, testSha256Hex)).toEqual(MANIFEST_INVALID);
    }
    expect(counter.reads()).toBe(0);
  });

  it('reports hasher-failed when sha256Hex throws or returns an invalid digest during verify', () => {
    const throwing: Sha256HexFn = () => {
      throw new Error('hasher failed');
    };
    const hasherFailed = { ok: false, problems: [{ kind: 'hasher-failed', path: null }] };
    expect(verifyBundleManifest(good, inputs, throwing)).toEqual(hasherFailed);
    expect(verifyBundleManifest(good, inputs, () => 'A'.repeat(64))).toEqual(hasherFailed);
    expect(verifyBundleManifest(good, inputs, () => 7 as unknown as string)).toEqual(hasherFailed);
    expect(verifyBundleManifest(good, inputs, undefined as unknown as Sha256HexFn)).toEqual(
      hasherFailed,
    );

    for (const failure of [
      () => {
        throw new Error('hasher failed');
      },
      () => 'short',
    ]) {
      let calls = 0;
      const failsAfterDigest: Sha256HexFn = (text) => {
        calls += 1;
        return calls === 1 ? testSha256Hex(text) : failure();
      };
      expect(verifyBundleManifest(good, inputs, failsAfterDigest)).toEqual({
        ok: false,
        problems: [
          { kind: 'hasher-failed', path: 'a' },
          { kind: 'hasher-failed', path: 'b' },
        ],
      });
    }
  });

  it('fails to verify changed content as ok when sha256Hex returns a constant', () => {
    // With a constant hasher every digest agrees, so only the byte length can tell content
    // apart. Same-length changed content under a constant hasher is an accepted residual:
    // it verifies as ok, because the verifier trusts the injected hasher to be a real SHA-256.
    const manifest = mustBuild([entry('a', 'one'), entry('b', 'twenty')], constantHasher);
    const changed = [entry('a', 'one'), entry('b', 'twenty-one')];
    expect(verifyBundleManifest(manifest, changed, constantHasher)).toEqual({
      ok: false,
      problems: [{ kind: 'changed', path: 'b' }],
    });
    const untouched = [entry('a', 'one'), entry('b', 'twenty')];
    expect(verifyBundleManifest(manifest, untouched, constantHasher)).toEqual({ ok: true });
  });

  it('never mutates frozen inputs and calls the hasher at most N + 1 times', () => {
    const list = [entry('a', 'payload-a'), entry('b', 'payload-b')];
    for (const item of list) {
      Object.freeze(item);
    }
    Object.freeze(list);
    const build = countingHasher();
    const manifest = mustBuild(list, build.hasher);
    expect(build.calls()).toBe(3);
    Object.freeze(manifest.entries);
    for (const item of manifest.entries) {
      Object.freeze(item);
    }
    Object.freeze(manifest);
    const before = JSON.stringify([list, manifest]);

    const verify = countingHasher();
    expect(verifyBundleManifest(manifest, list, verify.hasher)).toEqual({ ok: true });
    expect(verify.calls()).toBe(3);
    expect(verifyBundleManifest(manifest, list, testSha256Hex)).toEqual({ ok: true });
    expect(JSON.stringify([list, manifest])).toBe(before);
    expect(manifest.entries).not.toBe(list);
    expect(mustBuild(list)).toEqual(manifest);
  });
});
