import { types } from 'node:util';
import { describe, expect, it } from 'vitest';
import {
  ADVERSARIAL_CORPUS,
  runAdversarialCorpus,
} from '../adversarial-corpus.js';
import type {
  AdversarialCorpusCategory,
  Codec,
  CodecEnv,
  DecodeResult,
} from '../adversarial-corpus.js';
import { snapshotPlainData } from '../plain-data-snapshot.js';
import {
  ADVERSARIAL_CORPUS as indexCorpus,
  runAdversarialCorpus as indexRun,
} from '../index.js';

/** Wraps a plain decode function in the structural codec shape the runner validates. */
function codecOf(decode: (input: unknown) => unknown): Codec<unknown> {
  return {
    schemaId: 'corpus-test',
    decode(input) {
      return decode(input) as DecodeResult<unknown>;
    },
  };
}

/** A refusal result whose every field is an own data property: the canonical control. */
function refusalCodec(): Codec<unknown> {
  return codecOf(() => ({ ok: false, reason: 'x', path: null }));
}

function validEnv(): CodecEnv {
  return { isProxy: types.isProxy };
}

function expectAllRefused(outcomes: readonly { id: string; refused: boolean }[], refused: boolean) {
  expect(outcomes).toHaveLength(ADVERSARIAL_CORPUS.length);
  expect(outcomes.map((o) => o.id)).toEqual(ADVERSARIAL_CORPUS.map((e) => e.id));
  expect(outcomes.every((o) => o.refused === refused)).toBe(true);
}

/** A counting getter behind the given key: every read is observable, never silent. */
function accessorProperty(key: string, counter: { reads: number }): object {
  return Object.defineProperty({}, key, {
    enumerable: true,
    get() {
      counter.reads += 1;
      return false;
    },
  });
}

/** Kernel-refused fixture ids, in corpus order. */
const KERNEL_REFUSED_IDS = [
  'proxy',
  'revoked-proxy',
  'getter',
  'setter',
  'cycle',
  'symbol-key',
  'sparse-array',
  'over-deep',
  'over-wide',
  'over-long-string',
  'huge-array-length',
  'nan',
  'infinity',
  'negative-zero',
  'non-plain-prototype',
  'class-instance',
  'function-value',
] as const;

const CLOSED_CATEGORIES: readonly AdversarialCorpusCategory[] = [
  'proxy',
  'accessor',
  'cycle',
  'prototype-pollution',
  'key-shape',
  'array-shape',
  'bounds',
  'number',
  'non-plain',
  'unsupported-type',
];

describe('adversarial corpus', () => {
  it('runAdversarialCorpus throws TypeError without invoking getters for invalid env and succeeds for valid env and codec', () => {
    const codec = refusalCodec();

    const counter = { reads: 0 };
    const accessorEnv = accessorProperty('isProxy', counter) as unknown as CodecEnv;

    const invalidEnvs: readonly unknown[] = [
      null,
      undefined,
      42,
      'not-an-env',
      {},
      { isProxy: null },
      { isProxy: 42 },
      { isProxy: 'not-a-function' },
      accessorEnv,
    ];
    for (const env of invalidEnvs) {
      counter.reads = 0;
      expect(() => runAdversarialCorpus(codec, env as CodecEnv)).toThrow(TypeError);
      expect(counter.reads).toBe(0);
    }

    const outcomes = runAdversarialCorpus(codec, validEnv());
    expectAllRefused(outcomes, true);
  });

  it('runAdversarialCorpus throws TypeError without invoking getters for invalid codec, missing or non-string schemaId, or prototype decode, and succeeds for valid codec', () => {
    const env = validEnv();
    const refusal = () => ({ ok: false, reason: 'x', path: null });

    const decodeCounter = { reads: 0 };
    const accessorDecodeCodec = accessorProperty('decode', decodeCounter);
    (accessorDecodeCodec as { schemaId: string }).schemaId = 'corpus-test';

    const schemaIdCounter = { reads: 0 };
    const accessorSchemaIdCodec = accessorProperty('schemaId', schemaIdCounter);
    (accessorSchemaIdCodec as { decode: () => unknown }).decode = refusal;

    class PrototypeDecodeCodec {
      schemaId = 'corpus-test';

      decode(): { ok: false; reason: string; path: null } {
        return { ok: false, reason: 'x', path: null };
      }
    }

    const invalidCodecs: readonly unknown[] = [
      null,
      undefined,
      42,
      'not-a-codec',
      { schemaId: 'corpus-test' },
      { schemaId: 'corpus-test', decode: 42 },
      accessorDecodeCodec,
      new PrototypeDecodeCodec(),
      { decode: refusal },
      { schemaId: '', decode: refusal },
      { schemaId: 42, decode: refusal },
      accessorSchemaIdCodec,
    ];
    for (const invalid of invalidCodecs) {
      decodeCounter.reads = 0;
      schemaIdCounter.reads = 0;
      expect(() => runAdversarialCorpus(invalid as Codec<unknown>, env)).toThrow(TypeError);
      expect(decodeCounter.reads).toBe(0);
      expect(schemaIdCounter.reads).toBe(0);
    }

    const outcomes = runAdversarialCorpus(refusalCodec(), env);
    expectAllRefused(outcomes, true);
  });

  it('runAdversarialCorpus records refused: false when codec.decode throws and refused: true for a valid refusal codec', () => {
    const env = validEnv();

    const throwingCodec = codecOf(() => {
      throw new Error('decode threw');
    });
    expectAllRefused(runAdversarialCorpus(throwingCodec, env), false);

    expectAllRefused(runAdversarialCorpus(refusalCodec(), env), true);
  });

  it('runAdversarialCorpus records refused: false when env.isProxy throws on result and refused: true when env.isProxy returns false', () => {
    const codec = refusalCodec();

    const throwingEnv: CodecEnv = {
      isProxy: () => {
        throw new Error('detector threw');
      },
    };
    expectAllRefused(runAdversarialCorpus(codec, throwingEnv), false);

    expectAllRefused(runAdversarialCorpus(codec, validEnv()), true);
  });

  it('runAdversarialCorpus records refused: false when env.isProxy returns true for result without reading descriptors and refused: true for a non-Proxy refusal', () => {
    let trapCount = 0;
    const proxyRefusalCodec: Codec<unknown> = {
      schemaId: 'corpus-test',
      decode() {
        const baseHandler: ProxyHandler<object> = {};
        const handler = new Proxy(baseHandler, {
          get(handlerTarget, property) {
            trapCount += 1;
            return Reflect.get(handlerTarget, property);
          },
        });
        return new Proxy(
          { ok: false, reason: 'x', path: null },
          handler,
        ) as unknown as DecodeResult<unknown>;
      },
    };

    // Harness self-check: a descriptor read on one of these results trips the trap.
    const probe = proxyRefusalCodec.decode(null) as unknown as object;
    Object.getOwnPropertyDescriptor(probe, 'ok');
    expect(trapCount).toBeGreaterThan(0);
    trapCount = 0;

    const alwaysProxyEnv: CodecEnv = { isProxy: () => true };
    const outcomes = runAdversarialCorpus(proxyRefusalCodec, alwaysProxyEnv);
    expectAllRefused(outcomes, false);
    expect(trapCount).toBe(0);

    expectAllRefused(runAdversarialCorpus(refusalCodec(), validEnv()), true);
  });

  it('runAdversarialCorpus records refused: false for each single-field variation of { ok: false, reason, path } and refused: true for the valid control', () => {
    const env = validEnv();
    const counter = { reads: 0 };

    const variations: readonly (() => unknown)[] = [
      () => ({ ok: true, reason: 'x', path: null }),
      () => ({ ok: 'false', reason: 'x', path: null }),
      () => ({ ok: false, path: null }),
      () => ({ ok: false, reason: 123, path: null }),
      () => ({ ok: false, reason: 'x', path: 123 }),
      () => ({ ok: false, reason: 'x', path: undefined }),
      () => ({ ok: false }),
      () => accessorProperty('ok', counter),
      () => accessorProperty('reason', counter),
      () => accessorProperty('path', counter),
      () => null,
      () => 'bad',
    ];

    for (const make of variations) {
      counter.reads = 0;
      const outcomes = runAdversarialCorpus(codecOf(make), env);
      expectAllRefused(outcomes, false);
      expect(counter.reads).toBe(0);
    }

    expectAllRefused(runAdversarialCorpus(refusalCodec(), env), true);
  });

  it('runAdversarialCorpus with snapshotPlainData adapter marks the 17 kernel-refused entries true and proto-key, constructor-key, and array-like false', () => {
    const kernelCodec: Codec<unknown> = {
      schemaId: 'plain-data-snapshot',
      decode: (input) => snapshotPlainData(input, types.isProxy),
    };

    const accepted = new Set(['proto-key', 'constructor-key', 'array-like']);
    const expected = ADVERSARIAL_CORPUS.map((entry) => ({
      id: entry.id,
      refused: !accepted.has(entry.id),
    }));

    const outcomes = runAdversarialCorpus(kernelCodec, validEnv());
    expect(outcomes).toEqual(expected);
    expect(outcomes.filter((o) => o.refused)).toHaveLength(KERNEL_REFUSED_IDS.length);
  });

  it('snapshotPlainData refuses all 17 kernel-hostile corpus entries with exact reason and path, proving getter is not invoked', () => {
    const deepPath = Array.from({ length: 16 }, () => 'child').join('.');
    const expectedRefusals: Record<string, { ok: false; reason: string; path: string | null }> = {
      proxy: { ok: false, reason: 'proxy', path: null },
      'revoked-proxy': { ok: false, reason: 'proxy', path: null },
      getter: { ok: false, reason: 'accessor', path: 'x' },
      setter: { ok: false, reason: 'accessor', path: 'x' },
      cycle: { ok: false, reason: 'cycle', path: 'self' },
      'symbol-key': { ok: false, reason: 'symbol-key', path: null },
      'sparse-array': { ok: false, reason: 'sparse-array', path: '[0]' },
      'over-deep': { ok: false, reason: 'too-deep', path: deepPath },
      'over-wide': { ok: false, reason: 'too-many-keys', path: null },
      'over-long-string': { ok: false, reason: 'too-long', path: null },
      'huge-array-length': { ok: false, reason: 'too-many-items', path: null },
      nan: { ok: false, reason: 'non-finite-number', path: null },
      infinity: { ok: false, reason: 'non-finite-number', path: null },
      'negative-zero': { ok: false, reason: 'negative-zero', path: null },
      'non-plain-prototype': { ok: false, reason: 'not-plain', path: null },
      'class-instance': { ok: false, reason: 'not-plain', path: null },
      'function-value': { ok: false, reason: 'unsupported-type', path: null },
    };
    expect(Object.keys(expectedRefusals)).toHaveLength(KERNEL_REFUSED_IDS.length);

    const visited = new Set<string>();
    for (const entry of ADVERSARIAL_CORPUS) {
      const expected = expectedRefusals[entry.id];
      if (expected === undefined) {
        continue;
      }
      visited.add(entry.id);
      const snap = snapshotPlainData(entry.build(), types.isProxy);
      // `reason: 'accessor'` for `getter` proves its throwing getter never ran:
      // invoking it would surface as `hostile`, not `accessor`.
      expect(snap).toEqual(expected);
    }
    expect(visited.size).toBe(KERNEL_REFUSED_IDS.length);
  });

  it('snapshotPlainData accepts own data-property proto-key, constructor-key, and array-like as frozen records without polluting Object.prototype', () => {
    const byId = new Map(ADVERSARIAL_CORPUS.map((entry) => [entry.id, entry]));
    const protoKey = byId.get('proto-key');
    const constructorKey = byId.get('constructor-key');
    const arrayLike = byId.get('array-like');
    if (!protoKey || !constructorKey || !arrayLike) {
      throw new Error('corpus is missing an accepted entry');
    }

    const protoSnap = snapshotPlainData(protoKey.build(), types.isProxy);
    if (!protoSnap.ok) {
      throw new Error('proto-key expected to be accepted');
    }
    expect(Object.isFrozen(protoSnap.value)).toBe(true);
    const protoOut = protoSnap.value as Record<string, unknown>;
    expect(Object.getPrototypeOf(protoOut)).toBeNull();
    expect(Reflect.ownKeys(protoOut)).toEqual(['__proto__']);
    const protoDesc = Object.getOwnPropertyDescriptor(protoOut, '__proto__');
    expect(protoDesc).toBeDefined();
    expect(protoDesc?.get).toBeUndefined();
    expect(protoDesc?.set).toBeUndefined();
    expect(protoDesc?.enumerable).toBe(true);
    expect(protoDesc?.value).toEqual({ polluted: true });
    expect('polluted' in Object.prototype).toBe(false);

    const ctorSnap = snapshotPlainData(constructorKey.build(), types.isProxy);
    if (!ctorSnap.ok) {
      throw new Error('constructor-key expected to be accepted');
    }
    expect(Object.isFrozen(ctorSnap.value)).toBe(true);
    const ctorOut = ctorSnap.value as Record<string, unknown>;
    expect(Object.getPrototypeOf(ctorOut)).toBeNull();
    expect(Reflect.ownKeys(ctorOut)).toEqual(['constructor']);
    const ctorDesc = Object.getOwnPropertyDescriptor(ctorOut, 'constructor');
    expect(ctorDesc).toBeDefined();
    expect(ctorDesc?.get).toBeUndefined();
    expect(ctorDesc?.value).toEqual({ prototype: { polluted: true } });
    expect('polluted' in Object.prototype).toBe(false);

    const arraySnap = snapshotPlainData(arrayLike.build(), types.isProxy);
    if (!arraySnap.ok) {
      throw new Error('array-like expected to be accepted');
    }
    expect(Object.isFrozen(arraySnap.value)).toBe(true);
    const arrayOut = arraySnap.value as Record<string, unknown>;
    expect(Object.getPrototypeOf(arrayOut)).toBeNull();
    expect(Reflect.ownKeys(arrayOut)).toEqual(['0', '1', 'length']);
    expect(arrayOut[0]).toBe('a');
    expect(arrayOut[1]).toBe('b');
    expect(arrayOut.length).toBe(2);
    expect(Array.isArray(arrayOut)).toBe(false);
  });

  it('ADVERSARIAL_CORPUS has 20 unique ids, exact closed categories, and fresh object references per build excluding primitives and function-value', () => {
    expect(ADVERSARIAL_CORPUS).toHaveLength(20);
    const ids = ADVERSARIAL_CORPUS.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(20);

    const categories = new Set(ADVERSARIAL_CORPUS.map((entry) => entry.category));
    expect(categories.size).toBe(10);
    expect([...categories].sort()).toEqual([...CLOSED_CATEGORIES].sort());

    const primitiveIds = new Set([
      'nan',
      'infinity',
      'negative-zero',
      'over-long-string',
      'function-value',
    ]);
    for (const entry of ADVERSARIAL_CORPUS) {
      if (primitiveIds.has(entry.id)) {
        continue;
      }
      const first = entry.build();
      const second = entry.build();
      // A raw identity comparison, since vitest's `toBe` machinery itself
      // touches a revoked Proxy and would throw on it.
      expect(first !== second).toBe(true);
    }
  });

  it('index re-exports the exact ADVERSARIAL_CORPUS of length 20 and runAdversarialCorpus from adversarial-corpus', () => {
    expect(indexCorpus).toBe(ADVERSARIAL_CORPUS);
    expect(indexRun).toBe(runAdversarialCorpus);
    expect(indexCorpus).toHaveLength(20);
  });
});
