import { builtinModules } from 'node:module';
import { readFileSync } from 'node:fs';
import { types } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import { snapshotPlainData } from '../plain-data-snapshot.js';
import type { IsProxy } from '../plain-data-snapshot.js';

/**
 * A Proxy whose handler is itself a Proxy that counts every trap lookup, so a
 * test can prove that no trap (not even the handler-method lookup) ran.
 */
function createTrapCountingProxy<T extends object>(target: T): {
  proxy: T;
  trapCount: () => number;
} {
  let count = 0;
  const baseHandler: ProxyHandler<T> = {};
  const handler = new Proxy(baseHandler, {
    get(handlerTarget, property) {
      count += 1;
      return Reflect.get(handlerTarget, property);
    },
  });
  return { proxy: new Proxy(target, handler), trapCount: () => count };
}

/** A revoked Proxy that throws on any real reflection but never on `isProxy`. */
function createRevokedProxy(): object {
  const { proxy, revoke } = Proxy.revocable({}, {});
  revoke();
  return proxy;
}

function accessorObject(onGet: () => void): object {
  return Object.defineProperty({}, 'x', {
    enumerable: true,
    get() {
      onGet();
      return 1;
    },
  });
}

describe('snapshotPlainData', () => {
  describe('harness self-check', () => {
    it('proves the counting proxy observes ownKeys, getPrototypeOf, and descriptor reads', () => {
      const ownKeys = createTrapCountingProxy({ a: 1 });
      Reflect.ownKeys(ownKeys.proxy);
      expect(ownKeys.trapCount()).toBeGreaterThan(0);

      const proto = createTrapCountingProxy({ a: 1 });
      Object.getPrototypeOf(proto.proxy);
      expect(proto.trapCount()).toBeGreaterThan(0);

      const array = createTrapCountingProxy([]);
      expect(Array.isArray(array.proxy)).toBe(true);
      Object.getOwnPropertyDescriptor(array.proxy, 'length');
      expect(array.trapCount()).toBeGreaterThan(0);
    });

    it('proves a lying detector lets snapshotPlainData touch a real Proxy', () => {
      const { proxy, trapCount } = createTrapCountingProxy({ a: 1 });
      const snap = snapshotPlainData(proxy, () => false);
      expect(snap).toEqual({ ok: true, value: { a: 1 } });
      expect(trapCount()).toBeGreaterThan(0);
    });
  });

  describe('proxy refusals with zero traps', () => {
    it('refuses a top-level object Proxy and a top-level array Proxy without any trap', () => {
      const objectProxy = createTrapCountingProxy({ a: 1 });
      expect(snapshotPlainData(objectProxy.proxy, types.isProxy)).toEqual({
        ok: false,
        reason: 'proxy',
        path: null,
      });
      expect(objectProxy.trapCount()).toBe(0);

      const arrayProxy = createTrapCountingProxy([1]);
      expect(snapshotPlainData(arrayProxy.proxy, types.isProxy)).toEqual({
        ok: false,
        reason: 'proxy',
        path: null,
      });
      expect(arrayProxy.trapCount()).toBe(0);
    });

    it('refuses a Proxy nested in an array and a Proxy nested in a record', () => {
      const nested = createTrapCountingProxy({ a: 1 });
      expect(snapshotPlainData([nested.proxy], types.isProxy)).toEqual({
        ok: false,
        reason: 'proxy',
        path: '[0]',
      });
      expect(nested.trapCount()).toBe(0);

      const inRecord = createTrapCountingProxy({ a: 1 });
      expect(snapshotPlainData({ a: inRecord.proxy }, types.isProxy)).toEqual({
        ok: false,
        reason: 'proxy',
        path: 'a',
      });
      expect(inRecord.trapCount()).toBe(0);
    });

    it('refuses a revoked Proxy as proxy without throwing', () => {
      expect(() => snapshotPlainData(createRevokedProxy(), types.isProxy)).not.toThrow();
      expect(snapshotPlainData(createRevokedProxy(), types.isProxy)).toEqual({
        ok: false,
        reason: 'proxy',
        path: null,
      });
    });
  });

  describe('accessor and non-enumerable refusals', () => {
    it('refuses an accessor at the root without running the getter', () => {
      let calls = 0;
      const input = accessorObject(() => {
        calls += 1;
      });
      expect(snapshotPlainData(input, types.isProxy)).toEqual({
        ok: false,
        reason: 'accessor',
        path: 'x',
      });
      expect(calls).toBe(0);
    });

    it('refuses an accessor nested in a record with its child path', () => {
      let calls = 0;
      const input = { a: accessorObject(() => calls++) };
      expect(snapshotPlainData(input, types.isProxy)).toEqual({
        ok: false,
        reason: 'accessor',
        path: 'a.x',
      });
      expect(calls).toBe(0);
    });

    it('refuses an accessor on an array index without running the getter', () => {
      let calls = 0;
      const input: unknown[] = [];
      Object.defineProperty(input, 0, {
        enumerable: true,
        get() {
          calls += 1;
          return 1;
        },
      });
      expect(snapshotPlainData(input, types.isProxy)).toEqual({
        ok: false,
        reason: 'accessor',
        path: '[0]',
      });
      expect(calls).toBe(0);
    });

    it('refuses an accessor on an array element object as [0].x with zero calls', () => {
      // The array and its element are plain, so no Proxy trap can run at all.
      let calls = 0;
      const input = [accessorObject(() => {
        calls += 1;
      })];
      expect(snapshotPlainData(input, types.isProxy)).toEqual({
        ok: false,
        reason: 'accessor',
        path: '[0].x',
      });
      expect(calls).toBe(0);
    });

    it('refuses a non-enumerable own property on an object and on an array', () => {
      const objectInput: Record<string, unknown> = {};
      Object.defineProperty(objectInput, 'x', { enumerable: false, value: 1 });
      expect(snapshotPlainData(objectInput, types.isProxy)).toEqual({
        ok: false,
        reason: 'not-enumerable',
        path: 'x',
      });
      expect(snapshotPlainData({ a: objectInput }, types.isProxy)).toEqual({
        ok: false,
        reason: 'not-enumerable',
        path: 'a.x',
      });

      const arrayInput: unknown[] = [];
      Object.defineProperty(arrayInput, 0, { value: 1 });
      expect(snapshotPlainData(arrayInput, types.isProxy)).toEqual({
        ok: false,
        reason: 'not-enumerable',
        path: '[0]',
      });
    });
  });

  describe('detector edge cases', () => {
    it('refuses a throwing detector as detector-threw with the in-flight path', () => {
      const throwing: IsProxy = () => {
        throw new Error('boom');
      };
      expect(snapshotPlainData({}, throwing)).toEqual({
        ok: false,
        reason: 'detector-threw',
        path: null,
      });
      // The detector throws again on the nested object, whose path is in flight.
      let calls = 0;
      const nestedThrowing: IsProxy = () => {
        calls += 1;
        if (calls > 1) {
          throw new Error('boom');
        }
        return false;
      };
      expect(snapshotPlainData({ a: {} }, nestedThrowing)).toEqual({
        ok: false,
        reason: 'detector-threw',
        path: 'a',
      });
    });

    it('refuses a non-function detector as detector-threw', () => {
      expect(snapshotPlainData({}, undefined as unknown as IsProxy)).toEqual({
        ok: false,
        reason: 'detector-threw',
        path: null,
      });
    });

    it('treats any non-false detector return as a proxy refusal', () => {
      for (const returned of [undefined, true, 1, 'yes']) {
        const notAccurate: IsProxy = () => returned as never;
        expect(snapshotPlainData({ a: 1 }, notAccurate)).toEqual({
          ok: false,
          reason: 'proxy',
          path: null,
        });
      }
    });

    it('a detector returning false on an accessor object still refuses by descriptor', () => {
      let calls = 0;
      const input = accessorObject(() => {
        calls += 1;
      });
      expect(snapshotPlainData(input, () => false)).toEqual({
        ok: false,
        reason: 'accessor',
        path: 'x',
      });
      expect(calls).toBe(0);
    });
  });

  describe('limits and hostile limits argument', () => {
    it('refuses a Proxy as limits as invalid-limits, never hostile', () => {
      const { proxy, trapCount } = createTrapCountingProxy({ maxDepth: 2 });
      expect(snapshotPlainData({ a: 1 }, types.isProxy, proxy)).toEqual({
        ok: false,
        reason: 'invalid-limits',
        path: null,
      });
      expect(trapCount()).toBe(0);
    });

    it('refuses a revoked Proxy as limits as invalid-limits, never hostile', () => {
      expect(() => snapshotPlainData({ a: 1 }, types.isProxy, createRevokedProxy())).not.toThrow();
      expect(snapshotPlainData({ a: 1 }, types.isProxy, createRevokedProxy())).toEqual({
        ok: false,
        reason: 'invalid-limits',
        path: null,
      });
    });

    it('refuses a getter on limits as invalid-limits without running the getter', () => {
      let calls = 0;
      const limits: Record<string, unknown> = {};
      Object.defineProperty(limits, 'maxDepth', {
        enumerable: true,
        get() {
          calls += 1;
          return 2;
        },
      });
      expect(snapshotPlainData({ a: 1 }, types.isProxy, limits)).toEqual({
        ok: false,
        reason: 'invalid-limits',
        path: null,
      });
      expect(calls).toBe(0);
    });

    it('refuses malformed limits as invalid-limits', () => {
      const cases: readonly unknown[] = [
        null,
        [16],
        'depth',
        { maxDepth: -1 },
        { maxKeys: Number.NaN },
        { maxArrayLength: 1.5 },
        { maxNodes: 0 },
        { maxNodes: Number.POSITIVE_INFINITY },
        { unknownKey: 1 },
        { [Symbol('s')]: 1 },
      ];
      for (const limits of cases) {
        const result = snapshotPlainData({ a: 1 }, types.isProxy, limits as never);
        expect(result).toEqual({
          ok: false,
          reason: 'invalid-limits',
          path: null,
        });
        expect(Object.isFrozen(result)).toBe(true);
      }
    });

    it('refuses input deeper than maxDepth as too-deep', () => {
      const input = { a: { b: { c: 1 } } };
      expect(snapshotPlainData(input, types.isProxy, { maxDepth: 2 })).toEqual({
        ok: false,
        reason: 'too-deep',
        path: 'a.b',
      });
    });

    it('refuses an object wider than maxKeys as too-many-keys', () => {
      expect(snapshotPlainData({ a: 1, b: 2, c: 3 }, types.isProxy, { maxKeys: 2 })).toEqual({
        ok: false,
        reason: 'too-many-keys',
        path: null,
      });
    });

    it('refuses an array longer than maxArrayLength as too-many-items', () => {
      expect(snapshotPlainData([1, 2, 3], types.isProxy, { maxArrayLength: 2 })).toEqual({
        ok: false,
        reason: 'too-many-items',
        path: null,
      });
    });

    it('refuses input with more nodes than maxNodes as too-many-nodes', () => {
      const input = { a: { b: { c: 1 } } };
      expect(snapshotPlainData(input, types.isProxy, { maxNodes: 3 })).toEqual({
        ok: false,
        reason: 'too-many-nodes',
        path: 'a.b.c',
      });
    });

    it('refuses a string longer than maxStringLength as too-long', () => {
      expect(snapshotPlainData('abcd', types.isProxy, { maxStringLength: 3 })).toEqual({
        ok: false,
        reason: 'too-long',
        path: null,
      });
    });

    it('refuses an over-long object key at the parent path without echoing the key', () => {
      const overLongKey = 'exactly-sixteen';
      const input = { [overLongKey]: 1 };
      const snap = snapshotPlainData(input, types.isProxy, { maxStringLength: 8 });
      expect(snap).toEqual({ ok: false, reason: 'too-long', path: null });
      expect(JSON.stringify(snap)).not.toContain(overLongKey);
    });

    it('refuses an over-long array extra key at the parent path without echoing the key', () => {
      const overLongKey = 'exactly-sixteen';
      const input: unknown[] = [1];
      Object.defineProperty(input, overLongKey, { enumerable: true, value: 1 });
      const snap = snapshotPlainData(input, types.isProxy, { maxStringLength: 8 });
      expect(snap).toEqual({ ok: false, reason: 'too-long', path: null });
      expect(JSON.stringify(snap)).not.toContain(overLongKey);
    });
  });

  describe('structure and type refusals', () => {
    it('refuses an object cycle and an array cycle', () => {
      const selfRef: Record<string, unknown> = {};
      selfRef.self = selfRef;
      expect(snapshotPlainData(selfRef, types.isProxy)).toEqual({
        ok: false,
        reason: 'cycle',
        path: 'self',
      });
      expect(snapshotPlainData({ a: selfRef }, types.isProxy)).toEqual({
        ok: false,
        reason: 'cycle',
        path: 'a.self',
      });

      const arraySelf: unknown[] = [1];
      arraySelf.push(arraySelf);
      expect(snapshotPlainData(arraySelf, types.isProxy)).toEqual({
        ok: false,
        reason: 'cycle',
        path: '[1]',
      });
    });

    it('refuses a sparse array at the hole index', () => {
      const sparse = new Array(2);
      sparse[0] = 'x';
      expect(snapshotPlainData(sparse, types.isProxy)).toEqual({
        ok: false,
        reason: 'sparse-array',
        path: '[1]',
      });
    });

    it('refuses an array extra non-index key as not-plain', () => {
      const input: unknown[] = [1];
      Object.defineProperty(input, 'extra', { enumerable: true, value: 1 });
      expect(snapshotPlainData(input, types.isProxy)).toEqual({
        ok: false,
        reason: 'not-plain',
        path: null,
      });

      const padded: unknown[] = [1];
      Object.defineProperty(padded, '01', { enumerable: true, value: 1 });
      expect(snapshotPlainData(padded, types.isProxy)).toEqual({
        ok: false,
        reason: 'not-plain',
        path: null,
      });
    });

    it('refuses an own symbol key at the parent path', () => {
      const symbolKey = Symbol('s');
      expect(snapshotPlainData({ [symbolKey]: 1 }, types.isProxy)).toEqual({
        ok: false,
        reason: 'symbol-key',
        path: null,
      });
      expect(snapshotPlainData({ a: { [symbolKey]: 1 } }, types.isProxy)).toEqual({
        ok: false,
        reason: 'symbol-key',
        path: 'a',
      });
    });

    it('refuses class instances, Maps, and Dates as not-plain', () => {
      class Example {}
      for (const input of [new Example(), new Map(), new Date()]) {
        expect(snapshotPlainData(input, types.isProxy)).toEqual({
          ok: false,
          reason: 'not-plain',
          path: null,
        });
      }
    });

    it('refuses functions, bigints, symbols, and undefined as unsupported-type', () => {
      const symbolValue = Symbol('v');
      for (const input of [() => {}, 1n, symbolValue, undefined]) {
        expect(snapshotPlainData(input, types.isProxy)).toEqual({
          ok: false,
          reason: 'unsupported-type',
          path: null,
        });
      }
      expect(snapshotPlainData({ a: undefined }, types.isProxy)).toEqual({
        ok: false,
        reason: 'unsupported-type',
        path: 'a',
      });
      expect(snapshotPlainData({ fn: () => {} }, types.isProxy)).toEqual({
        ok: false,
        reason: 'unsupported-type',
        path: 'fn',
      });
    });

    it('refuses non-finite numbers as non-finite-number, top-level and nested', () => {
      for (const input of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
        expect(snapshotPlainData(input, types.isProxy)).toEqual({
          ok: false,
          reason: 'non-finite-number',
          path: null,
        });
      }
      expect(snapshotPlainData({ a: Number.NaN }, types.isProxy)).toEqual({
        ok: false,
        reason: 'non-finite-number',
        path: 'a',
      });
      expect(snapshotPlainData({ list: [1, Number.POSITIVE_INFINITY] }, types.isProxy)).toEqual({
        ok: false,
        reason: 'non-finite-number',
        path: 'list[1]',
      });
    });

    it('refuses negative zero as negative-zero, top-level and nested', () => {
      expect(snapshotPlainData(-0, types.isProxy)).toEqual({
        ok: false,
        reason: 'negative-zero',
        path: null,
      });
      expect(snapshotPlainData({ a: -0 }, types.isProxy)).toEqual({
        ok: false,
        reason: 'negative-zero',
        path: 'a',
      });
      expect(snapshotPlainData({ list: [1, -0] }, types.isProxy)).toEqual({
        ok: false,
        reason: 'negative-zero',
        path: 'list[1]',
      });
    });

    it('refuses own __proto__ and constructor properties without pollution or prototype change', () => {
      const input: Record<string, unknown> = {
        constructor: { own: true },
        normal: 1,
      };
      Object.defineProperty(input, '__proto__', {
        value: { polluted: true },
        enumerable: true,
        configurable: true,
        writable: true,
      });
      const snap = snapshotPlainData(input, types.isProxy);
      expect(snap.ok).toBe(true);
      if (!snap.ok) {
        return;
      }
      const value = snap.value as Record<string, unknown>;
      const protoDescriptor = Object.getOwnPropertyDescriptor(value, '__proto__');
      expect(protoDescriptor).toBeDefined();
      expect(protoDescriptor?.value).toEqual({ polluted: true });
      const ctorDescriptor = Object.getOwnPropertyDescriptor(value, 'constructor');
      expect(ctorDescriptor).toBeDefined();
      expect(ctorDescriptor?.value).toEqual({ own: true });
      expect(Object.getPrototypeOf(value)).toBeNull();
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    });

    it('refuses a throwing reflection trap as hostile with the in-flight path', () => {
      const hostile = new Proxy({ x: 1 }, {
        getOwnPropertyDescriptor() {
          throw new Error('trap');
        },
      });
      // A trusted detector refuses this input as a Proxy; a lying detector
      // drives the reflection into the throwing trap instead.
      expect(snapshotPlainData(hostile, types.isProxy)).toEqual({
        ok: false,
        reason: 'proxy',
        path: null,
      });
      expect(snapshotPlainData(hostile, () => false)).toEqual({
        ok: false,
        reason: 'hostile',
        path: 'x',
      });
    });
  });

  it('snapshots nested plain data as fresh frozen deep-equal structures', () => {
    const nullProto = Object.create(null) as Record<string, unknown>;
    nullProto.deep = { list: [1, 'two', true, null] };
    const input = {
      top: 'v',
      nested: { count: 2, flags: [false, true] },
      bare: nullProto,
      arr: [{ x: [{}] }],
    };
    const snap = snapshotPlainData(input, types.isProxy);
    expect(snap.ok).toBe(true);
    if (!snap.ok) {
      return;
    }
    expect(snap.value).toEqual(input);
    expect(snap.value).not.toBe(input);

    let visited = 0;
    const walk = (node: unknown): void => {
      if (node !== null && typeof node === 'object') {
        expect(Object.isFrozen(node)).toBe(true);
        visited += 1;
        for (const child of Object.values(node as Record<string, unknown>)) {
          walk(child);
        }
      }
    };
    walk(snap.value);
    expect(visited).toBeGreaterThan(4);
  });

  it('returns a null-prototype object for a record', () => {
    const snap = snapshotPlainData({ a: { b: 1 } }, types.isProxy);
    expect(snap.ok).toBe(true);
    if (!snap.ok) {
      return;
    }
    const out = snap.value as Record<string, unknown>;
    expect(Object.getPrototypeOf(out)).toBeNull();
    const nested = out.a as Record<string, unknown>;
    expect(Object.getPrototypeOf(nested)).toBeNull();
    expect(Object.isFrozen(out)).toBe(true);
  });

  it('a key named hasOwnProperty is a harmless own data property', () => {
    const input: Record<string, unknown> = {
      hasOwnProperty: 1,
      toString: 's',
      valueOf: true,
    };
    const snap = snapshotPlainData(input, types.isProxy);
    expect(snap.ok).toBe(true);
    if (!snap.ok) {
      return;
    }
    const out = snap.value as Record<string, unknown>;
    expect(out.hasOwnProperty).toBe(1);
    expect(out.toString).toBe('s');
    expect(out.valueOf).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(out, 'toString')).toBe(true);
    expect(Object.keys(out)).toEqual(['hasOwnProperty', 'toString', 'valueOf']);
    expect(Object.getPrototypeOf(out)).toBeNull();
    expect('hasOwnProperty' in out).toBe(true);
    expect(out.isPrototypeOf).toBeUndefined();
  });

  it('refuses an oversized array before enumerating its keys', () => {
    const arr = new Array(5000);
    const spy = vi.spyOn(Reflect, 'ownKeys');
    try {
      const snap = snapshotPlainData(arr, types.isProxy, { maxArrayLength: 10 });
      expect(snap).toEqual({
        ok: false,
        reason: 'too-many-items',
        path: null,
      });
      expect(spy).not.toHaveBeenCalledWith(arr);
    } finally {
      spy.mockRestore();
    }
  });

  it('bounds the error path to 256 characters with no newlines', () => {
    const longKey = `k${'a'.repeat(2498)}\nn\r${'z'.repeat(2498)}`;
    const input = {
      [longKey]: accessorObject(() => {}),
    };
    expect(longKey.length).toBe(5000);
    const snap = snapshotPlainData(input, types.isProxy, { maxStringLength: 10_000 });
    expect(snap.ok).toBe(false);
    if (snap.ok) {
      return;
    }
    expect(snap.reason).toBe('accessor');
    expect(snap.path).not.toBeNull();
    expect(typeof snap.path).toBe('string');
    const path = snap.path as string;
    expect(path.length).toBeLessThanOrEqual(256);
    expect(/[\r\n]/.test(path)).toBe(false);
  });

  it('still refuses a Proxy first and fails closed without a detector', () => {
    const { proxy, trapCount } = createTrapCountingProxy({ a: 1 });
    const snap = snapshotPlainData(proxy, types.isProxy);
    expect(snap.ok).toBe(false);
    if (snap.ok) {
      return;
    }
    expect(snap.reason).toBe('proxy');
    expect(trapCount()).toBe(0);
    expect(
      snapshotPlainData({ a: 1 }, 'not a function' as unknown as IsProxy),
    ).toEqual({ ok: false, reason: 'detector-threw', path: null });
  });

  describe('no-runtime-specifier guard', () => {
    // Every form a runtime specifier can take: a static `import ... from`,
    // a side-effect `import` with single or double quotes, a dynamic
    // `import()`, a `require()`, and a re-`export ... from` — for both
    // `node:`-prefixed specifiers and bare Node builtin specifiers
    // (including subpath imports such as `fs/promises`).
    const BUILTINS = [
      ...new Set(
        builtinModules.map((module) => module.replace(/^node:/, '')),
      ),
    ];
    const escapeRegex = (name: string): string =>
      name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Each builtin matches as `<name>` or `node:<name>`, and the name must be
    // followed by a specifier boundary: a closing quote or `/` (for subpaths
    // such as `fs/promises`). This keeps package-name prefixes
    // (`path-to-regexp`), relative paths (`./fs`), and substrings
    // (`osmosis`) from matching.
    const BUILTIN_ALTERNATIVES = BUILTINS.flatMap((builtin) => [
      escapeRegex(builtin),
      `node:${escapeRegex(builtin)}`,
    ]).join('|');
    const BUILTIN_NAME = `(?:${BUILTIN_ALTERNATIVES})(?=['"/])`;
    const NODE_SPECIFIER_PATTERN = new RegExp(
      [
        `import\\s*[(\\s'"]*['"]${BUILTIN_NAME}`,
        `import\\s+[^'"]*\\s+from\\s*['"]${BUILTIN_NAME}`,
        `require\\s*\\(\\s*['"]${BUILTIN_NAME}`,
        `export\\s+[^'"]*\\s+from\\s*['"]${BUILTIN_NAME}`,
      ].join('|'),
      'g',
    );

    it('the pattern matches node: and bare builtin specifier forms', () => {
      const forms = [
        "import 'node:process';",
        'import "node:os";',
        "import { readFileSync } from 'node:fs';",
        "await import('node:fs');",
        "require('node:fs');",
        "export * from 'node:fs';",
        "import fs from 'fs';",
        "import { join } from 'path';",
        "import 'fs/promises';",
        "require('child_process');",
        "export * from 'crypto';",
      ];
      for (const form of forms) {
        expect(NODE_SPECIFIER_PATTERN.test(form)).toBe(true);
        NODE_SPECIFIER_PATTERN.lastIndex = 0;
      }
    });

    it('the pattern does not false-positive on relative or non-builtin strings', () => {
      const safe = [
        "import { snapshotPlainData } from '../plain-data-snapshot.js';",
        "import './helper';",
        "const note = 'the path module is not imported here';",
        "export * from './index.js';",
      ];
      for (const form of safe) {
        expect(NODE_SPECIFIER_PATTERN.test(form)).toBe(false);
        NODE_SPECIFIER_PATTERN.lastIndex = 0;
      }
    });

    it('the pattern does not match a doc comment merely mentioning a specifier', () => {
      expect(NODE_SPECIFIER_PATTERN.test('in production the node:util types.isProxy runs')).toBe(
        false,
      );
    });

    it('plain-data-snapshot.ts contains no runtime specifier at all', () => {
      const source = readFileSync(new URL('../plain-data-snapshot.ts', import.meta.url), 'utf8');
      const matches = source.match(NODE_SPECIFIER_PATTERN);
      expect(matches).toBeNull();
    });

    it('self-test: the guard catches bare, node:-prefixed, and subpath builtin specifiers', () => {
      const caught = [
        "import assert from 'assert';",
        "import 'fs/promises';",
        'require("node:child_process");',
      ];
      for (const form of caught) {
        expect(NODE_SPECIFIER_PATTERN.test(form)).toBe(true);
        NODE_SPECIFIER_PATTERN.lastIndex = 0;
      }
    });

    it('self-test: the guard ignores package-name prefixes, relative paths, and substrings', () => {
      const safe = [
        "import 'path-to-regexp';",
        "import x from './fs';",
        "import y from 'osmosis';",
      ];
      for (const form of safe) {
        expect(NODE_SPECIFIER_PATTERN.test(form)).toBe(false);
        NODE_SPECIFIER_PATTERN.lastIndex = 0;
      }
    });
  });
});
