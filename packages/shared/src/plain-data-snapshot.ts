/**
 * A pure runtime-input guard: deep-copies plain JSON-like data into frozen
 * objects and dense frozen arrays while refusing any Proxy and any own
 * accessor (`get`/`set`) without running a single Proxy trap or getter.
 *
 * Precondition of the zero-trap / zero-getter guarantee: the injected
 * `isProxy` must be a trusted, accurate, side-effect-free detector — in
 * production the `types.isProxy` predicate, passed in by infrastructure so
 * this module never imports a runtime-specific specifier. With an inaccurate
 * detector the function still never throws and still refuses accessors by
 * descriptor, but a missed Proxy's reflection traps may run.
 *
 * Like `plain-record.ts`, every bound comes from the exported limits, a
 * hostile Proxy trap or a throwing descriptor is a typed refusal (`hostile`),
 * and no input value or over-long key text is ever echoed into a refusal.
 */

export type IsProxy = (value: unknown) => boolean;

export interface PlainDataLimits {
  readonly maxDepth: number;
  readonly maxKeys: number;
  readonly maxArrayLength: number;
  readonly maxNodes: number;
  readonly maxStringLength: number;
}

// Frozen so a caller cannot mutate the shared defaults at runtime (e.g.
// `maxNodes = Infinity`) and silently bypass the resource bounds; the resolver
// below spreads this into a fresh, private copy per call.
export const DEFAULT_PLAIN_DATA_LIMITS: PlainDataLimits = Object.freeze({
  maxDepth: 16,
  maxKeys: 128,
  maxArrayLength: 1024,
  maxNodes: 4096,
  maxStringLength: 16_384,
});

export type PlainDataRefusalReason =
  | 'proxy'
  | 'accessor'
  | 'not-plain'
  | 'not-enumerable'
  | 'symbol-key'
  | 'sparse-array'
  | 'too-deep'
  | 'too-many-keys'
  | 'too-many-items'
  | 'too-many-nodes'
  | 'too-long'
  | 'cycle'
  | 'unsupported-type'
  | 'detector-threw'
  | 'hostile'
  | 'invalid-limits'
  | 'non-finite-number'
  | 'negative-zero';

export type PlainDataSnapshot =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly reason: PlainDataRefusalReason; readonly path: string | null };

const LIMIT_KEYS: readonly string[] = [
  'maxDepth',
  'maxKeys',
  'maxArrayLength',
  'maxNodes',
  'maxStringLength',
];

const CANONICAL_INDEX = /^(0|[1-9][0-9]*)$/;

const INVALID_LIMITS: PlainDataSnapshot = Object.freeze({
  ok: false,
  reason: 'invalid-limits',
  path: null,
});

interface SnapshotState {
  /** The path whose traversal was in flight, `null` before any object read. */
  inFlight: string | null;
}

interface NodeCount {
  nodes: number;
}

function refusal(reason: PlainDataRefusalReason, path: string | null): PlainDataSnapshot {
  return { ok: false, reason, path };
}

export function snapshotPlainData(
  value: unknown,
  isProxy: IsProxy,
  limits?: Partial<PlainDataLimits>,
): PlainDataSnapshot {
  const state: SnapshotState = { inFlight: null };
  try {
    if (typeof isProxy !== 'function') {
      return refusal('detector-threw', null);
    }
    let resolvedLimits = DEFAULT_PLAIN_DATA_LIMITS;
    if (limits !== undefined) {
      const normalized = normalizeLimits(limits, isProxy);
      if (!normalized.ok) {
        return INVALID_LIMITS;
      }
      resolvedLimits = normalized.limits;
    }
    const count: NodeCount = { nodes: 0 };
    return snap(value, isProxy, resolvedLimits, 0, null, new Set<object>(), state, count);
  } catch {
    return { ok: false, reason: 'hostile', path: state.inFlight };
  }
}

/**
 * Whether a candidate `limits` argument may be trusted enough to read bounds
 * from it. The FIRST operation on it is the injected detector: a hostile or
 * revoked Proxy as `limits` is `invalid-limits`, never `hostile`, because a
 * caller-supplied argument is malformed input, not a hostile runtime value.
 */
function normalizeLimits(
  limits: unknown,
  isProxy: IsProxy,
): { ok: true; limits: PlainDataLimits } | { ok: false } {
  let notProxy: boolean;
  try {
    notProxy = isProxy(limits) === false;
  } catch {
    return { ok: false };
  }
  if (!notProxy) {
    return { ok: false };
  }
  // Every reflection operation below (`Array.isArray`, the prototype read,
  // `Reflect.ownKeys`, the descriptor reads) can itself throw on a hostile
  // value — a revoked Proxy, for instance, may return `false` from the
  // detector yet throw on any other operation. Such a failure is malformed
  // input, so it must surface as `invalid-limits`, never escape to the outer
  // catch and become `hostile`.
  try {
    return normalizeTrustedLimits(limits);
  } catch {
    return { ok: false };
  }
}

function normalizeTrustedLimits(
  limits: unknown,
): { ok: true; limits: PlainDataLimits } | { ok: false } {
  if (typeof limits !== 'object' || limits === null || Array.isArray(limits)) {
    return { ok: false };
  }
  const prototype = Object.getPrototypeOf(limits);
  if (prototype !== Object.prototype && prototype !== null) {
    return { ok: false };
  }
  const resolved = { ...DEFAULT_PLAIN_DATA_LIMITS };
  for (const key of Reflect.ownKeys(limits)) {
    if (typeof key === 'symbol' || !LIMIT_KEYS.includes(key)) {
      return { ok: false };
    }
    const descriptor = Object.getOwnPropertyDescriptor(limits, key);
    if (descriptor === undefined
      || descriptor.get !== undefined
      || descriptor.set !== undefined
      || !descriptor.enumerable) {
      return { ok: false };
    }
    const raw: unknown = descriptor.value;
    if (typeof raw !== 'number' || !Number.isFinite(raw) || !Number.isInteger(raw) || raw < 0) {
      return { ok: false };
    }
    if (key === 'maxNodes' && raw < 1) {
      return { ok: false };
    }
    resolved[key as keyof PlainDataLimits] = raw;
  }
  return { ok: true, limits: resolved };
}

function snap(
  value: unknown,
  isProxy: IsProxy,
  limits: PlainDataLimits,
  depth: number,
  path: string | null,
  ancestors: Set<object>,
  state: SnapshotState,
  count: NodeCount,
): PlainDataSnapshot {
  count.nodes += 1;
  if (count.nodes > limits.maxNodes) {
    return refusal('too-many-nodes', path);
  }
  state.inFlight = path;
  if (value === null) {
    return { ok: true, value };
  }
  if (typeof value === 'boolean' || typeof value === 'number') {
    if (typeof value === 'number' && !Number.isFinite(value)) {
      return refusal('non-finite-number', path);
    }
    if (typeof value === 'number' && Object.is(value, -0)) {
      return refusal('negative-zero', path);
    }
    return { ok: true, value };
  }
  if (typeof value === 'string') {
    return value.length > limits.maxStringLength
      ? refusal('too-long', path)
      : { ok: true, value };
  }
  if (typeof value !== 'object') {
    // `function`, `bigint`, `symbol`, `undefined`
    return refusal('unsupported-type', path);
  }
  // The detector runs FIRST, before `Array.isArray`, the prototype read, the
  // own-keys read, or any other operation that could observe a trap.
  let notProxy: boolean;
  try {
    notProxy = isProxy(value) === false;
  } catch {
    return refusal('detector-threw', path);
  }
  if (!notProxy) {
    return refusal('proxy', path);
  }
  if (ancestors.has(value)) {
    return refusal('cycle', path);
  }
  const isArray = Array.isArray(value);
  const prototype = Object.getPrototypeOf(value);
  const plain = isArray
    ? prototype === Array.prototype
    : prototype === Object.prototype || prototype === null;
  if (!plain) {
    return refusal('not-plain', path);
  }
  if (depth + 1 > limits.maxDepth) {
    return refusal('too-deep', path);
  }
  ancestors.add(value);
  try {
    return isArray
      ? snapArray(value, isProxy, limits, depth, path, ancestors, state, count)
      : snapRecord(value, isProxy, limits, depth, path, ancestors, state, count);
  } finally {
    ancestors.delete(value);
  }
}

function snapRecord(
  value: object,
  isProxy: IsProxy,
  limits: PlainDataLimits,
  depth: number,
  path: string | null,
  ancestors: Set<object>,
  state: SnapshotState,
  count: NodeCount,
): PlainDataSnapshot {
  const keys = Reflect.ownKeys(value);
  if (keys.length > limits.maxKeys) {
    return refusal('too-many-keys', path);
  }
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    // `Reflect.ownKeys` yields only string and symbol keys, so a non-string
    // key is a symbol key.
    if (typeof key !== 'string') {
      return refusal('symbol-key', path);
    }
    // The key text itself is bounded, and an over-long key is never echoed.
    if (key.length > limits.maxStringLength) {
      return refusal('too-long', path);
    }
    const childPath = path === null ? key : `${path}.${key}`;
    state.inFlight = childPath;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined) {
      return refusal('hostile', path);
    }
    if (descriptor.get !== undefined || descriptor.set !== undefined) {
      return refusal('accessor', childPath);
    }
    if (!descriptor.enumerable) {
      return refusal('not-enumerable', childPath);
    }
    const child = snap(
      descriptor.value,
      isProxy,
      limits,
      depth + 1,
      childPath,
      ancestors,
      state,
      count,
    );
    if (!child.ok) {
      return child;
    }
    // `defineProperty` keeps a `'__proto__'` key an own data property instead
    // of mutating the fresh output's prototype.
    Object.defineProperty(out, key, {
      value: child.value,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }
  Object.freeze(out);
  return { ok: true, value: out };
}

function snapArray(
  value: object,
  isProxy: IsProxy,
  limits: PlainDataLimits,
  depth: number,
  path: string | null,
  ancestors: Set<object>,
  state: SnapshotState,
  count: NodeCount,
): PlainDataSnapshot {
  // Even `length` is read through its own data-property descriptor: no
  // accessor on the input (an index, `length`, anything) is ever read.
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
  if (lengthDescriptor === undefined
    || lengthDescriptor.get !== undefined
    || lengthDescriptor.set !== undefined
    || typeof lengthDescriptor.value !== 'number'
    || !Number.isInteger(lengthDescriptor.value)
    || lengthDescriptor.value < 0) {
    return refusal('hostile', path);
  }
  const length = lengthDescriptor.value;
  // The length bound is checked BEFORE the own-keys enumeration, so a very
  // large dense array is refused without ever allocating or walking its keys.
  if (length > limits.maxArrayLength) {
    return refusal('too-many-items', path);
  }
  const keys = Reflect.ownKeys(value);
  for (const key of keys) {
    // `Reflect.ownKeys` yields only string and symbol keys, so a non-string
    // key is a symbol key.
    if (typeof key !== 'string') {
      return refusal('symbol-key', path);
    }
    if (key.length > limits.maxStringLength) {
      return refusal('too-long', path);
    }
    // Only the canonical indices below `length` and `length` itself may be
    // own keys; any other key (an extra property, a padded index, an index at
    // or past `length`) is refused.
    if (key !== 'length' && !(CANONICAL_INDEX.test(key) && Number(key) < length)) {
      return refusal('not-plain', path);
    }
  }
  const out: unknown[] = new Array(length);
  for (let i = 0; i < length; i += 1) {
    const itemPath = path === null ? `[${i}]` : `${path}[${i}]`;
    state.inFlight = itemPath;
    const descriptor = Object.getOwnPropertyDescriptor(value, i);
    if (descriptor === undefined) {
      return refusal('sparse-array', itemPath);
    }
    if (descriptor.get !== undefined || descriptor.set !== undefined) {
      return refusal('accessor', itemPath);
    }
    if (!descriptor.enumerable) {
      return refusal('not-enumerable', itemPath);
    }
    const child = snap(
      descriptor.value,
      isProxy,
      limits,
      depth + 1,
      itemPath,
      ancestors,
      state,
      count,
    );
    if (!child.ok) {
      return child;
    }
    Object.defineProperty(out, i, {
      value: child.value,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }
  Object.freeze(out);
  return { ok: true, value: out };
}
