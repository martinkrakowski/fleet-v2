import type { CloudProviderPort } from '../ports/out/CloudProviderPort.out-port.js';

/**
 * Application-layer registry of `CloudProviderPort` implementations
 * (FC8E2). It lives under `use-cases` because it holds the port type.
 *
 * Both `id` and `provider` are untrusted input: the id is a fixed-length,
 * fixed-character-class string check (`O(1)`); the provider is inspected
 * through own property descriptors — no getter is ever invoked, and every
 * reflective read is wrapped in `try/catch` so a revoked or throwing `Proxy`
 * is a typed refusal instead of a throw. The method walk is `O(1)`: exactly
 * the three port method names checked across at most 8 prototype levels.
 */

export type CloudProviderRegisterResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'invalid-id' | 'invalid-provider' | 'duplicate-provider' };

export type CloudProviderGetResult =
  | { readonly ok: true; readonly provider: CloudProviderPort }
  | { readonly ok: false; readonly reason: 'invalid-id' | 'unknown-provider' };

/** The fixed id contract: 1–128 characters of `A-Z a-z 0-9 . _ -`. */
const PROVIDER_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

/** The port methods every provider must expose as data properties. */
const REQUIRED_METHODS = ['provision', 'drain', 'terminate'] as const;

/** Maximum prototype levels walked when looking for a port method. */
const MAX_PROTOTYPE_LEVELS = 8;

/**
 * True when `value` is a non-null, non-array object exposing every required
 * port method as a data property with `typeof value === 'function'`, found on
 * the own object or within `MAX_PROTOTYPE_LEVELS` prototype levels. No getter
 * is ever invoked; every reflection call is wrapped, so a revoked or throwing
 * `Proxy` returns false instead of throwing.
 */
function hasPortMethods(value: unknown): boolean {
  let isArrayResult: boolean;
  try {
    isArrayResult = Array.isArray(value);
  } catch {
    return false;
  }
  if (typeof value !== 'object' || value === null || isArrayResult) {
    return false;
  }
  let current: object | null = value as object;
  // Each required method may live on a different level of the chain (a class
  // subclass, for instance): the walk tracks which are found so far and
  // stops when all three are, within the fixed 8-level bound.
  const missing = new Set<string>(REQUIRED_METHODS);
  for (let level = 0; level <= MAX_PROTOTYPE_LEVELS && missing.size > 0; level += 1) {
    if (current === null) {
      return false;
    }
    for (const method of REQUIRED_METHODS) {
      if (missing.has(method) && hasFunctionDataProperty(current, method)) {
        missing.delete(method);
      }
    }
    try {
      current = Object.getPrototypeOf(current);
    } catch {
      return false;
    }
  }
  return missing.size === 0;
}

/** True when `object` has `key` as an own data property holding a function. */
function hasFunctionDataProperty(object: object, key: string): boolean {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    return descriptor !== undefined && descriptor.get === undefined && typeof descriptor.value === 'function';
  } catch {
    return false;
  }
}

/** True when `value` is a string matching the fixed provider id pattern. */
function isProviderId(value: unknown): value is string {
  return typeof value === 'string' && PROVIDER_ID_PATTERN.test(value);
}

/**
 * Registry mapping provider ids to `CloudProviderPort` implementations.
 * Registration validates both inputs without ever invoking a getter and
 * answers every failure with a typed reason.
 */
export class CloudProviderRegistry {
  private readonly providers = new Map<string, CloudProviderPort>();

  /**
   * Register `provider` under `id`. Refuses an invalid id, a hostile or
   * incomplete provider, and a duplicate id — each with its typed reason.
   */
  register(id: unknown, provider: unknown): CloudProviderRegisterResult {
    if (!isProviderId(id)) {
      return { ok: false, reason: 'invalid-id' };
    }
    if (!hasPortMethods(provider)) {
      return { ok: false, reason: 'invalid-provider' };
    }
    if (this.providers.has(id)) {
      return { ok: false, reason: 'duplicate-provider' };
    }
    this.providers.set(id, provider as CloudProviderPort);
    return { ok: true };
  }

  /**
   * Look up the provider registered under `id`: the exact registered instance,
   * `'unknown-provider'` when absent, or `'invalid-id'` for a malformed id —
   * never `undefined`.
   */
  get(id: unknown): CloudProviderGetResult {
    if (!isProviderId(id)) {
      return { ok: false, reason: 'invalid-id' };
    }
    const provider = this.providers.get(id);
    return provider === undefined ? { ok: false, reason: 'unknown-provider' } : { ok: true, provider };
  }
}
