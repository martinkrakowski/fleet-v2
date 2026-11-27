/**
 * The runtime adversarial corpus: 20 deterministic hostile-input fixtures the
 * kernel (`snapshotPlainData`) and, from HIB2 on, the schema-decoding layer
 * must classify. Each entry builds its value fresh on every `build()` call, so
 * a consumed (or mutated) fixture never leaks into the next run.
 *
 * Placeholder types: `Codec`, `CodecEnv` and `DecodeResult` are the structural
 * contract `runAdversarialCorpus` needs today. HIB2 replaces them with the
 * real `codec.ts` definitions and re-points the exports in `index.ts`, with no
 * duplicate export left behind.
 */

export type DecodeResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: string; readonly path: string | null };

export type CodecEnv = { readonly isProxy: (value: unknown) => boolean };

export type Codec<T> = { readonly schemaId: string; decode(input: unknown): DecodeResult<T> };

export type AdversarialCorpusCategory =
  | 'proxy'
  | 'accessor'
  | 'cycle'
  | 'prototype-pollution'
  | 'key-shape'
  | 'array-shape'
  | 'bounds'
  | 'number'
  | 'non-plain'
  | 'unsupported-type';

export type AdversarialCorpusEntry = {
  readonly id: string;
  readonly category: AdversarialCorpusCategory;
  build(): unknown;
};

/**
 * Builds every fixture fresh, so a `Proxy`, revoked `Proxy`, cycle or sparse
 * array is a new value per call and per consumer.
 */
export const ADVERSARIAL_CORPUS: readonly AdversarialCorpusEntry[] = Object.freeze([
  {
    id: 'proxy',
    category: 'proxy',
    build() {
      return new Proxy({ a: 1 }, {});
    },
  },
  {
    id: 'revoked-proxy',
    category: 'proxy',
    build() {
      const { proxy, revoke } = Proxy.revocable({}, {});
      revoke();
      return proxy;
    },
  },
  {
    id: 'getter',
    category: 'accessor',
    build() {
      return Object.defineProperty({}, 'x', {
        enumerable: true,
        get() {
          throw new Error('getter invoked');
        },
      });
    },
  },
  {
    id: 'setter',
    category: 'accessor',
    build() {
      return Object.defineProperty({}, 'x', {
        enumerable: true,
        set(_v: unknown) {},
      });
    },
  },
  {
    id: 'cycle',
    category: 'cycle',
    build() {
      const obj: Record<string, unknown> = {};
      obj.self = obj;
      return obj;
    },
  },
  {
    id: 'proto-key',
    category: 'prototype-pollution',
    build() {
      return Object.defineProperty({}, '__proto__', {
        value: { polluted: true },
        enumerable: true,
        writable: true,
        configurable: true,
      });
    },
  },
  {
    id: 'constructor-key',
    category: 'prototype-pollution',
    build() {
      return { constructor: { prototype: { polluted: true } } };
    },
  },
  {
    id: 'symbol-key',
    category: 'key-shape',
    build() {
      return { [Symbol('adversarial')]: 1 };
    },
  },
  {
    id: 'sparse-array',
    category: 'array-shape',
    build() {
      const a: unknown[] = [];
      a[1] = 'x';
      return a;
    },
  },
  {
    id: 'array-like',
    category: 'array-shape',
    build() {
      return { 0: 'a', 1: 'b', length: 2 };
    },
  },
  {
    id: 'over-deep',
    category: 'bounds',
    build() {
      let cur: Record<string, unknown> = {};
      for (let i = 0; i < 16; i += 1) {
        cur = { child: cur };
      }
      return cur;
    },
  },
  {
    id: 'over-wide',
    category: 'bounds',
    build() {
      const obj: Record<string, unknown> = {};
      for (let i = 0; i <= 128; i += 1) {
        obj[`k${i}`] = i;
      }
      return obj;
    },
  },
  {
    id: 'over-long-string',
    category: 'bounds',
    build() {
      return 'a'.repeat(16_385);
    },
  },
  {
    id: 'huge-array-length',
    category: 'bounds',
    build() {
      return new Array(1_000_000);
    },
  },
  {
    id: 'nan',
    category: 'number',
    build() {
      return Number.NaN;
    },
  },
  {
    id: 'infinity',
    category: 'number',
    build() {
      return Number.POSITIVE_INFINITY;
    },
  },
  {
    id: 'negative-zero',
    category: 'number',
    build() {
      return -0;
    },
  },
  {
    id: 'non-plain-prototype',
    category: 'non-plain',
    build() {
      return Object.create({ inherited: 1 });
    },
  },
  {
    id: 'class-instance',
    category: 'non-plain',
    build() {
      class HostileClass {}
      return new HostileClass();
    },
  },
  {
    id: 'function-value',
    category: 'unsupported-type',
    build() {
      return () => 'hostile';
    },
  },
]) satisfies readonly AdversarialCorpusEntry[];

/** One corpus outcome: whether the capability refused the fixture. */
export type AdversarialCorpusOutcome = { readonly id: string; readonly refused: boolean };

/**
 * Runs every corpus entry through the supplied decode capability and records
 * whether it refused (`{ ok: false, reason, path }`).
 *
 * `codec` and `env` are trusted capabilities supplied by the caller; they are
 * validated structurally with own-descriptor reads only, so no accessor
 * property of either is ever invoked. The result of each `decode` call is
 * inspected the same way: `env.isProxy(result) === false` FIRST (before any
 * descriptor read, so no Proxy trap can run), then own data properties
 * `ok === false`, `typeof reason === 'string'` and `path === null ||
 * typeof path === 'string'`. Anything else — a throw from `build()`, `decode`
 * or `isProxy`, a non-object result, a bare `{ ok: false }` — is recorded as
 * `refused: false`, never rethrown.
 *
 * Cost: O(1) capability validation, then O(N) over the 20 entries; per entry
 * O(1) beyond `build()` and `decode` (one `isProxy` call, three descriptor
 * reads).
 */
export function runAdversarialCorpus(
  codec: Codec<unknown>,
  env: CodecEnv,
): readonly AdversarialCorpusOutcome[] {
  if (typeof env !== 'object' || env === null) {
    throw new TypeError('runAdversarialCorpus: env must be an object with own isProxy');
  }
  const isProxyDesc = Object.getOwnPropertyDescriptor(env, 'isProxy');
  if (isProxyDesc === undefined
    || isProxyDesc.get !== undefined
    || isProxyDesc.set !== undefined
    || typeof isProxyDesc.value !== 'function') {
    throw new TypeError('runAdversarialCorpus: env.isProxy must be an own function property');
  }
  const isProxyFn: (value: unknown) => boolean = isProxyDesc.value;

  if (typeof codec !== 'object' || codec === null) {
    throw new TypeError('runAdversarialCorpus: codec must be an object with own schemaId and decode');
  }
  const schemaIdDesc = Object.getOwnPropertyDescriptor(codec, 'schemaId');
  if (schemaIdDesc === undefined
    || schemaIdDesc.get !== undefined
    || schemaIdDesc.set !== undefined
    || typeof schemaIdDesc.value !== 'string'
    || schemaIdDesc.value.length === 0) {
    throw new TypeError('runAdversarialCorpus: codec.schemaId must be a non-empty own string');
  }
  const decodeDesc = Object.getOwnPropertyDescriptor(codec, 'decode');
  if (decodeDesc === undefined
    || decodeDesc.get !== undefined
    || decodeDesc.set !== undefined
    || typeof decodeDesc.value !== 'function') {
    throw new TypeError('runAdversarialCorpus: codec.decode must be an own function property');
  }
  const decodeFn: (this: Codec<unknown>, input: unknown) => unknown = decodeDesc.value;

  return ADVERSARIAL_CORPUS.map((entry): AdversarialCorpusOutcome => {
    try {
      const result = Reflect.apply(decodeFn, codec, [entry.build()]);
      if (typeof result !== 'object' || result === null) {
        return { id: entry.id, refused: false };
      }
      // The detector runs BEFORE any descriptor read, so a Proxy result is
      // classified without tripping a single trap.
      if (isProxyFn(result) !== false) {
        return { id: entry.id, refused: false };
      }
      const okDesc = Object.getOwnPropertyDescriptor(result, 'ok');
      const reasonDesc = Object.getOwnPropertyDescriptor(result, 'reason');
      const pathDesc = Object.getOwnPropertyDescriptor(result, 'path');
      const refused = okDesc !== undefined
        && okDesc.get === undefined
        && okDesc.set === undefined
        && okDesc.value === false
        && reasonDesc !== undefined
        && reasonDesc.get === undefined
        && reasonDesc.set === undefined
        && typeof reasonDesc.value === 'string'
        && pathDesc !== undefined
        && pathDesc.get === undefined
        && pathDesc.set === undefined
        && (pathDesc.value === null || typeof pathDesc.value === 'string');
      return { id: entry.id, refused };
    } catch {
      return { id: entry.id, refused: false };
    }
  });
}
