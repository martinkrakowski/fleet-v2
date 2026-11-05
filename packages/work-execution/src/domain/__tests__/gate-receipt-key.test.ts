import { describe, expect, it } from 'vitest';

import {
  buildGateReceiptKey,
  decideGateReceiptReuse,
  gateReceiptKeysEqual,
  readGateReceiptKeyRecord,
  type GateReceiptKeyInput,
} from '../gate-receipt-key.js';

/** A deterministic 64-lowercase-hex digest derived from a number. */
function hex(n: number): string {
  return n.toString(16).padStart(64, '0');
}

const TREE = 'a'.repeat(40);

function components(): GateReceiptKeyInput {
  return {
    predicateId: 'command 1: corepack yarn build',
    treeHash: TREE,
    predicateDefinitionDigest: hex(1),
    toolchainVersions: {
      node: '22.11.0',
      yarn: '4.12.0',
      hexagen: '0.14.0',
      turbo: '2.11.5',
    },
    declaredEnvironmentDigest: hex(2),
  };
}

/** A valid stored record (the gate's result would live beside the key). */
function stored(): Record<string, unknown> {
  return {
    predicateId: 'command 1: corepack yarn build',
    treeHash: TREE,
    predicateDefinitionDigest: hex(1),
    toolchainVersions: {
      node: '22.11.0',
      yarn: '4.12.0',
      hexagen: '0.14.0',
      turbo: '2.11.5',
    },
    declaredEnvironmentDigest: hex(2),
  };
}

describe('buildGateReceiptKey', () => {
  it('builds a key from readable components', () => {
    const input: GateReceiptKeyInput = {
      ...components(),
      predicateId: '  command 1: corepack yarn build  ',
    };
    const result = buildGateReceiptKey(input);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.key.schemaVersion).toBe(1);
    expect(result.key.predicateId).toBe('command 1: corepack yarn build');
    expect(result.key.treeHash).toBe(TREE);
    expect(result.key.predicateDefinitionDigest).toBe(hex(1));
    expect(result.key.toolchainVersions).toEqual({
      node: '22.11.0',
      yarn: '4.12.0',
      hexagen: '0.14.0',
      turbo: '2.11.5',
    });
    expect(result.key.declaredEnvironmentDigest).toBe(hex(2));
  });

  it('misses when a component is unreadable', () => {
    expect(buildGateReceiptKey({ ...components(), treeHash: null })).toEqual({
      ok: false,
      reason: 'tree-hash-unreadable',
    });

    const noTurbo = components();
    delete (noTurbo.toolchainVersions as Record<string, unknown>).turbo;
    expect(buildGateReceiptKey(noTurbo)).toEqual({
      ok: false,
      reason: 'toolchain-version-unreadable',
    });
  });

  it('never throws on a hostile input', () => {
    expect(() => buildGateReceiptKey(null as unknown as GateReceiptKeyInput)).not.toThrow();
    expect(buildGateReceiptKey(null as unknown as GateReceiptKeyInput).ok).toBe(false);

    const hostile = components() as unknown as Record<string, unknown>;
    Object.defineProperty(hostile, 'predicateId', {
      enumerable: true,
      get() {
        throw new Error('boom');
      },
    });
    let result: ReturnType<typeof buildGateReceiptKey> | undefined;
    expect(() => {
      result = buildGateReceiptKey(hostile as unknown as GateReceiptKeyInput);
    }).not.toThrow();
    expect(result?.ok).toBe(false);
  });

  it('reports the first unreadable field when a later field throws', () => {
    // A throwing descriptor on a LATER field must be reported as that field's
    // unreadable reason, not as `predicate-id-unreadable`. An accessor property
    // read through `Reflect.getOwnPropertyDescriptor(...).value` is simply
    // `undefined`, so a Proxy with a throwing trap exercises the real throw.
    const base = components() as unknown as Record<string, unknown>;
    const throwOn = (target: string): unknown =>
      new Proxy(base, {
        getOwnPropertyDescriptor(t, key) {
          if (key === target) {
            throw new Error('boom');
          }
          return Reflect.getOwnPropertyDescriptor(t, key);
        },
      });
    expect(buildGateReceiptKey(throwOn('declaredEnvironmentDigest') as unknown as GateReceiptKeyInput)).toEqual({
      ok: false,
      reason: 'declared-environment-digest-unreadable',
    });
    expect(buildGateReceiptKey(throwOn('toolchainVersions') as unknown as GateReceiptKeyInput)).toEqual({
      ok: false,
      reason: 'toolchain-version-unreadable',
    });
    expect(buildGateReceiptKey(throwOn('treeHash') as unknown as GateReceiptKeyInput)).toEqual({
      ok: false,
      reason: 'tree-hash-unreadable',
    });
  });

  it('reports the first unreadable field before a later throwing descriptor', () => {
    // An earlier unreadable field must win even when a LATER descriptor throws:
    // the fields are checked in table order, so the later throw is never seen.
    const base = components() as unknown as Record<string, unknown>;
    base.predicateId = 'bad\u0000id';
    const input = new Proxy(base, {
      getOwnPropertyDescriptor(t, key) {
        if (key === 'treeHash') {
          throw new Error('boom');
        }
        return Reflect.getOwnPropertyDescriptor(t, key);
      },
    });
    expect(buildGateReceiptKey(input as unknown as GateReceiptKeyInput)).toEqual({
      ok: false,
      reason: 'predicate-id-unreadable',
    });
  });

  it('reports a throwing toolchain descriptor as the toolchain reason', () => {
    // A throw while reading a toolchain version belongs to the toolchain
    // component, never to a later component such as the declared environment.
    const base = components() as unknown as Record<string, unknown>;
    const toolchain = base.toolchainVersions as Record<string, unknown>;
    base.toolchainVersions = new Proxy(toolchain, {
      getOwnPropertyDescriptor(t, key) {
        if (key === 'turbo') {
          throw new Error('boom');
        }
        return Reflect.getOwnPropertyDescriptor(t, key);
      },
    });
    expect(buildGateReceiptKey(base as unknown as GateReceiptKeyInput)).toEqual({
      ok: false,
      reason: 'toolchain-version-unreadable',
    });
  });
});

describe('readGateReceiptKeyRecord', () => {
  it('reads a stored record whose schema version is absent', () => {
    const key = buildGateReceiptKey(components());
    expect(key.ok).toBe(true);
    if (!key.ok) {
      return;
    }
    expect(readGateReceiptKeyRecord(stored())).toEqual({ ok: true, record: key.key });
  });

  it('refuses an unknown stored schema version', () => {
    const input = stored();
    input.schemaVersion = 2;
    expect(readGateReceiptKeyRecord(input)).toEqual({
      ok: false,
      reason: 'stored-key-version-unknown',
    });
  });

  it('refuses a stored record with an unreadable field', () => {
    const input = stored();
    input.treeHash = 'not-a-hash';
    expect(readGateReceiptKeyRecord(input)).toEqual({
      ok: false,
      reason: 'stored-key-unreadable',
    });
  });
});

describe('decideGateReceiptReuse', () => {
  const key = buildGateReceiptKey(components());

  it('reuses a receipt whose key is equal', () => {
    expect(key.ok).toBe(true);
    if (!key.ok) {
      return;
    }
    expect(decideGateReceiptReuse(key.key, stored())).toEqual({
      outcome: 'reuse',
      key: key.key,
    });
  });

  it('misses when the tree changed', () => {
    if (!key.ok) {
      return;
    }
    const input = stored();
    input.treeHash = 'b'.repeat(40);
    expect(decideGateReceiptReuse(key.key, input)).toEqual({
      outcome: 'miss',
      reason: 'key-changed',
      changedComponent: 'tree-hash',
    });
  });

  it('misses when the predicate script changed', () => {
    if (!key.ok) {
      return;
    }
    const input = stored();
    input.predicateDefinitionDigest = hex(3);
    expect(decideGateReceiptReuse(key.key, input)).toEqual({
      outcome: 'miss',
      reason: 'key-changed',
      changedComponent: 'predicate-definition-digest',
    });
  });

  it('misses when a toolchain version changed', () => {
    if (!key.ok) {
      return;
    }
    const input = stored();
    (input.toolchainVersions as Record<string, unknown>).turbo = '2.11.6';
    expect(decideGateReceiptReuse(key.key, input)).toEqual({
      outcome: 'miss',
      reason: 'key-changed',
      changedComponent: 'toolchain-version',
    });
  });

  it('misses when a declared environment variable changed', () => {
    if (!key.ok) {
      return;
    }
    const input = stored();
    input.declaredEnvironmentDigest = hex(4);
    expect(decideGateReceiptReuse(key.key, input)).toEqual({
      outcome: 'miss',
      reason: 'key-changed',
      changedComponent: 'declared-environment-digest',
    });
  });

  it('treats an unreadable component as a miss, never a hit', () => {
    if (!key.ok) {
      return;
    }
    const input = stored();
    delete (input.toolchainVersions as Record<string, unknown>).turbo;
    expect(decideGateReceiptReuse(key.key, input)).toEqual({
      outcome: 'miss',
      reason: 'stored-key-unreadable',
    });
  });

  it('misses when nothing is stored', () => {
    if (!key.ok) {
      return;
    }
    expect(decideGateReceiptReuse(key.key, null)).toEqual({
      outcome: 'miss',
      reason: 'no-stored-receipt',
    });
  });

  it('never throws on a hostile stored value', () => {
    if (!key.ok) {
      return;
    }
    const hostile = stored();
    Object.defineProperty(hostile, 'treeHash', {
      enumerable: true,
      get() {
        throw new Error('boom');
      },
    });
    let result: ReturnType<typeof decideGateReceiptReuse> | undefined;
    expect(() => {
      result = decideGateReceiptReuse(key.key, hostile);
    }).not.toThrow();
    expect(result?.outcome).toBe('miss');
  });
});

describe('gateReceiptKeysEqual and string reads (KS2 review fixes)', () => {
  function key() {
    const built = buildGateReceiptKey(components());
    if (!built.ok) throw new Error('fixture key must build');
    return built.key;
  }

  it('compares unequal, without throwing, for null, a non-object or missing toolchain versions', () => {
    const k = key();
    for (const bad of [null, undefined, 42, 'key', { ...k, toolchainVersions: null }]) {
      expect(() => gateReceiptKeysEqual(k, bad as never)).not.toThrow();
      expect(gateReceiptKeysEqual(k, bad as never)).toBe(false);
      expect(gateReceiptKeysEqual(bad as never, k)).toBe(false);
    }
  });

  it('compares unequal, without throwing, when an accessor throws', () => {
    const hostile = Object.defineProperty({ ...key() }, 'treeHash', {
      get() {
        throw new Error('hostile');
      },
    });
    expect(() => gateReceiptKeysEqual(key(), hostile)).not.toThrow();
    expect(gateReceiptKeysEqual(key(), hostile)).toBe(false);
  });

  it('still compares equal keys as equal', () => {
    expect(gateReceiptKeysEqual(key(), key())).toBe(true);
  });

  it('refuses a predicate id with a leading or trailing tab or newline', () => {
    for (const predicateId of ['\tcommand 1: corepack yarn build', 'command 1: corepack yarn build\n']) {
      expect(buildGateReceiptKey({ ...components(), predicateId }).ok).toBe(false);
    }
  });
});

describe('KS2 pre-merge review fixes', () => {
  function key() {
    const built = buildGateReceiptKey(components());
    if (!built.ok) throw new Error('fixture key must build');
    return built.key;
  }

  it('a supplied key with a throwing accessor is a miss, not a throw', () => {
    const hostile = Object.defineProperty({ ...key() }, 'predicateId', {
      enumerable: true,
      get() {
        throw new Error('hostile');
      },
    });
    expect(() => decideGateReceiptReuse(hostile, stored())).not.toThrow();
    expect(decideGateReceiptReuse(hostile, stored())).toEqual({ outcome: 'miss', reason: 'supplied-key-unreadable' });
  });

  it('a supplied key of another schema version is a miss, even with matching components', () => {
    const other = { ...key(), schemaVersion: 2 } as unknown as Parameters<typeof decideGateReceiptReuse>[0];
    expect(decideGateReceiptReuse(other, stored()).outcome).toBe('miss');
  });

  it('refuses a secret-shaped predicate id', () => {
    expect(buildGateReceiptKey({ ...components(), predicateId: 'ghp_' + 'x'.repeat(36) }).ok).toBe(false);
  });

  it('refuses a toolchain version that is not a version string', () => {
    const bad = { ...components(), toolchainVersions: { ...components().toolchainVersions, node: 'any text at all' } };
    expect(buildGateReceiptKey(bad).ok).toBe(false);
  });

  it('two malformed keys with the same missing fields are not equal', () => {
    const malformed = { schemaVersion: 1, predicateId: 'x' } as unknown as Parameters<typeof gateReceiptKeysEqual>[0];
    expect(gateReceiptKeysEqual(malformed, malformed)).toBe(false);
  });
});
