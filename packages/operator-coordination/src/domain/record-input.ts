/**
 * The shared readers every operator-coordination aggregate uses on hostile
 * input; nothing here throws on a value and nothing runs a getter.
 */

/**
 * A plain object with exactly the given own enumerable string keys, values
 * read through their own property descriptors (so no getter ever runs).
 * Anything else — a non-object, a prototype outside Object.prototype/null, a
 * missing or extra or non-enumerable key, a symbol key — returns null.
 */
export function readPlainObject(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return null;
  }
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== keys.length) {
    return null;
  }
  const out: Record<string, unknown> = {};
  for (const key of ownKeys) {
    if (typeof key !== 'string' || !keys.includes(key)) {
      return null;
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable) {
      return null;
    }
    out[key] = descriptor.value;
  }
  return out;
}

/**
 * A plain object's own enumerable string keys with values read through their
 * own property descriptors (no getter ever runs). Unlike `readPlainObject`
 * the key set is not restricted: unknown keys are copied too and the caller
 * simply ignores them, so an unknown body key is never a rejection — the
 * ordinary-decision behaviour on main. A non-object, a prototype outside
 * Object.prototype/null, or a symbol own key returns null.
 */
export function readPlainObjectLoose(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return null;
  }
  // The snapshot is built on a null prototype: an own `__proto__` key on the
  // incoming body (as `JSON.parse('{"__proto__":{...}}')` produces) is copied
  // as an ordinary data property instead of mutating the snapshot's
  // prototype, so the snapshot reads exactly like main reads any other body.
  const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') {
      return null;
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable) {
      return null;
    }
    out[key] = descriptor.value;
  }
  return out;
}

/** A fresh plain array copied by index (no iterator, no species); a non-array is returned unchanged. */
export function plainArrayCopy(value: unknown): unknown {
  if (!Array.isArray(value)) {
    return value;
  }
  const copy: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, index);
    copy.push(descriptor === undefined ? undefined : descriptor.value);
  }
  return copy;
}

/**
 * A plain object whose own enumerable string keys are all in `allowed` and include every key in
 * `required`; values read through their own property descriptors. Anything else returns null.
 */
export function readPlainObjectWithOptional(
  value: unknown,
  required: readonly string[],
  allowed: readonly string[],
): Record<string, unknown> | null {
  // Every reflective read is wrapped: a revoked Proxy or a hostile trap can
  // make even `Array.isArray`, `Object.getPrototypeOf` or
  // `Object.getOwnPropertyDescriptor` throw, and every such throw is a typed
  // refusal (null), never an exception escaping the caller.
  let isArray: boolean;
  try {
    isArray = Array.isArray(value);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null || isArray) {
    return null;
  }
  let prototype: unknown;
  try {
    prototype = Object.getPrototypeOf(value);
  } catch {
    return null;
  }
  if (prototype !== Object.prototype && prototype !== null) {
    return null;
  }
  let ownKeys: PropertyKey[];
  try {
    ownKeys = Reflect.ownKeys(value);
  } catch {
    return null;
  }
  const out: Record<string, unknown> = {};
  for (const key of ownKeys) {
    if (typeof key !== 'string' || !allowed.includes(key)) {
      return null;
    }
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key);
    } catch {
      return null;
    }
    if (descriptor === undefined || !descriptor.enumerable) {
      return null;
    }
    out[key] = descriptor.value;
  }
  for (const key of required) {
    if (!(key in out)) {
      return null;
    }
  }
  return out;
}
