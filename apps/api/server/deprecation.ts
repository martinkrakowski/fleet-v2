/**
 * Pure deprecation-signal mechanism for `/v1` routes.
 *
 * No `h3` import, no `node:*` I/O, no `console.*`: every exported function is
 * side-effect free and deterministic. Wiring this into a route handler or
 * middleware is a separate, deliberate step — nothing imports this module yet.
 *
 * Every refusal path returns a typed `{ ok: false, reason }` with a fixed
 * reason string that never echoes any input value. The full registry is
 * validated on every call, in `O(n)` over `n <= MAX_DEPRECATIONS` entries;
 * descriptor and prototype inspection is wrapped in `try/catch` so a throwing
 * `Proxy` cannot propagate an exception.
 */

export interface DeprecationEntry {
  readonly routeKey: string;
  readonly deprecatedAtIso: string;
  readonly sunsetAtIso: string | null;
  readonly successorPath: string | null;
}

export type DeprecationHeadersResult =
  | { readonly ok: true; readonly headers: Readonly<Record<string, string>> }
  | { readonly ok: false; readonly reason: string };

/** Upper bound on registry size; keeps every per-call validation `O(1)`-bounded per element. */
export const MAX_DEPRECATIONS = 500;

/** Empty default registry: under it, no `/v1` route emits deprecation headers. */
export const DEFAULT_DEPRECATIONS: readonly DeprecationEntry[] = Object.freeze([]);

const ROUTE_KEY_MAX_LENGTH = 256;
const TIMESTAMP_MAX_LENGTH = 64;
const SUCCESSOR_PATH_MAX_LENGTH = 512;

const REQUIRED_ENTRY_KEYS = ["routeKey", "deprecatedAtIso", "sunsetAtIso", "successorPath"] as const;

const ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;
const SUCCESSOR_PATH_RE = /^\/v1\/[A-Za-z0-9._~:/-]+$/;

const POLLUTING_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/**
 * True when `value` holds a control character no header may carry:
 * C0 (U+0000–U+001F), DEL (U+007F), C1 (U+0080–U+009F), U+2028 or U+2029.
 * Checked by code point, not a regular expression; `O(value.length)`.
 */
function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codePoint = value.codePointAt(index);
    if (
      codePoint !== undefined &&
      (codePoint <= 0x1f ||
        codePoint === 0x7f ||
        (codePoint >= 0x80 && codePoint <= 0x9f) ||
        codePoint === 0x2028 ||
        codePoint === 0x2029)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Strict ISO-8601 UTC timestamp parse (`YYYY-MM-DDTHH:MM:SS[.mmm]Z`).
 *
 * Beyond the shape and a finite `Date.parse`, the round-trip through
 * `toISOString()` rejects calendar rollovers (`2026-02-30T00:00:00Z`) and
 * non-ISO strings that `Date.parse` would loosely accept (`2026`, `March 7`).
 */
function parseStrictIsoUtcMs(value: string): number | null {
  if (!ISO_UTC_RE.test(value) || value.length > TIMESTAMP_MAX_LENGTH) {
    return null;
  }
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) {
    return null;
  }
  const iso = new Date(ms).toISOString();
  if (iso === value || iso.replace(/\.000Z$/, "Z") === value) {
    return ms;
  }
  return null;
}

function isDataProperty(
  descriptor: PropertyDescriptor | undefined,
): descriptor is PropertyDescriptor {
  return (
    descriptor !== undefined &&
    descriptor.get === undefined &&
    descriptor.set === undefined
  );
}

/**
 * True when `entry` is a non-null, non-array plain object (`Object.prototype`
 * or `null` prototype). `Array.isArray` and `Object.getPrototypeOf` can throw
 * for a hostile Proxy, so this function never catches: every throw propagates
 * to the caller, whose guard maps any throw to `hostile-input` — a throwing
 * `getPrototypeOf` trap must never be downgraded to the weaker
 * `invalid-entry`.
 */
function isPlainObject(entry: unknown): boolean {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    return false;
  }
  const proto = Object.getPrototypeOf(entry);
  return proto === Object.prototype || proto === null;
}

/** Validate one timestamp field; returns a refusal reason, or `null` with the parsed ms. */
function checkTimestampField(
  value: unknown,
): { ok: true; ms: number } | { ok: false; reason: string } {
  if (typeof value !== "string") {
    return { ok: false, reason: "invalid-entry" };
  }
  if (hasControlCharacter(value)) {
    return { ok: false, reason: "control-character" };
  }
  if (value.length > TIMESTAMP_MAX_LENGTH) {
    return { ok: false, reason: "invalid-timestamp" };
  }
  const ms = parseStrictIsoUtcMs(value);
  if (ms === null) {
    return { ok: false, reason: "invalid-timestamp" };
  }
  return { ok: true, ms };
}

function validateRegistry(
  registry: unknown,
): { ok: true; length: number } | { ok: false; reason: string } {
  // `Array.isArray` itself can throw on a revoked Proxy, so it is inside the
  // guarded region too: a Proxy that cannot be interrogated is hostile input,
  // never a propagated exception.
  let length: number;
  try {
    if (!Array.isArray(registry)) {
      return { ok: false, reason: "invalid-registry" };
    }
    const lengthDescriptor = Object.getOwnPropertyDescriptor(registry, "length");
    if (!isDataProperty(lengthDescriptor) || typeof lengthDescriptor.value !== "number") {
      return { ok: false, reason: "hostile-input" };
    }
    length = lengthDescriptor.value;
  } catch {
    return { ok: false, reason: "hostile-input" };
  }
  if (length > MAX_DEPRECATIONS) {
    return { ok: false, reason: "registry-too-large" };
  }

  const seenRouteKeys = new Set<string>();
  for (let index = 0; index < length; index += 1) {
    const entryResult = validateEntry(registry, index, seenRouteKeys);
    if (!entryResult.ok) {
      return entryResult;
    }
  }
  // The validated length is returned and reused by the caller: re-reading
  // `registry.length` through a Proxy could diverge from what was validated
  // (bypassing the 500-entry bound) or throw outside any guard.
  return { ok: true, length };
}

function validateEntry(
  registry: unknown[],
  index: number,
  seenRouteKeys: Set<string>,
): { ok: true } | { ok: false; reason: string } {
  let elementDescriptor: PropertyDescriptor | undefined;
  let element: unknown;
  try {
    elementDescriptor = Object.getOwnPropertyDescriptor(registry, index);
    if (elementDescriptor === undefined) {
      return { ok: false, reason: "sparse-registry" };
    }
    if (
      !isDataProperty(elementDescriptor) ||
      elementDescriptor.enumerable !== true
    ) {
      return { ok: false, reason: "hostile-input" };
    }
    element = elementDescriptor.value;
  } catch {
    return { ok: false, reason: "hostile-input" };
  }

  let elementIsPlainObject: boolean;
  try {
    elementIsPlainObject = isPlainObject(element);
  } catch {
    // Any throw here (including a non-TypeError from a Proxy's
    // `getPrototypeOf` or `has` trap) is hostile input, never `invalid-entry`.
    return { ok: false, reason: "hostile-input" };
  }
  if (!elementIsPlainObject) {
    return { ok: false, reason: "invalid-entry" };
  }

  let ownKeys: string[];
  try {
    ownKeys = Object.getOwnPropertyNames(element as object);
  } catch {
    return { ok: false, reason: "hostile-input" };
  }
  for (const key of ownKeys) {
    if (POLLUTING_KEYS.has(key)) {
      return { ok: false, reason: "polluting-key" };
    }
    if (!(REQUIRED_ENTRY_KEYS as readonly string[]).includes(key)) {
      return { ok: false, reason: "invalid-entry" };
    }
  }
  for (const key of REQUIRED_ENTRY_KEYS) {
    if (!ownKeys.includes(key)) {
      return { ok: false, reason: "invalid-entry" };
    }
  }

  let routeKey: unknown;
  let deprecatedAtIso: unknown;
  let sunsetAtIso: unknown;
  let successorPath: unknown;
  try {
    const routeKeyDescriptor = Object.getOwnPropertyDescriptor(element as object, "routeKey");
    const deprecatedDescriptor = Object.getOwnPropertyDescriptor(element as object, "deprecatedAtIso");
    const sunsetDescriptor = Object.getOwnPropertyDescriptor(element as object, "sunsetAtIso");
    const successorDescriptor = Object.getOwnPropertyDescriptor(element as object, "successorPath");
    for (const descriptor of [
      routeKeyDescriptor,
      deprecatedDescriptor,
      sunsetDescriptor,
      successorDescriptor,
    ]) {
      if (!isDataProperty(descriptor) || descriptor.enumerable !== true) {
        return { ok: false, reason: "hostile-input" };
      }
    }
    routeKey = routeKeyDescriptor!.value;
    deprecatedAtIso = deprecatedDescriptor!.value;
    sunsetAtIso = sunsetDescriptor!.value;
    successorPath = successorDescriptor!.value;
  } catch {
    return { ok: false, reason: "hostile-input" };
  }

  if (typeof routeKey === "string" && hasControlCharacter(routeKey)) {
    return { ok: false, reason: "control-character" };
  }
  if (typeof routeKey !== "string" || routeKey === "" || routeKey.length > ROUTE_KEY_MAX_LENGTH) {
    return { ok: false, reason: "invalid-entry" };
  }
  if (seenRouteKeys.has(routeKey)) {
    return { ok: false, reason: "duplicate-route-key" };
  }
  seenRouteKeys.add(routeKey);

  const deprecatedResult = checkTimestampField(deprecatedAtIso);
  if (!deprecatedResult.ok) {
    return deprecatedResult;
  }

  let sunsetAtMs: number | null = null;
  if (sunsetAtIso !== null) {
    if (typeof sunsetAtIso !== "string") {
      return { ok: false, reason: "invalid-entry" };
    }
    if (hasControlCharacter(sunsetAtIso)) {
      return { ok: false, reason: "control-character" };
    }
    if (sunsetAtIso.length > TIMESTAMP_MAX_LENGTH) {
      return { ok: false, reason: "invalid-timestamp" };
    }
    const sunsetResult = parseStrictIsoUtcMs(sunsetAtIso);
    if (sunsetResult === null) {
      return { ok: false, reason: "invalid-timestamp" };
    }
    sunsetAtMs = sunsetResult;
    if (sunsetAtMs < deprecatedResult.ms) {
      return { ok: false, reason: "sunset-before-deprecation" };
    }
  }

  if (successorPath !== null) {
    if (typeof successorPath !== "string") {
      return { ok: false, reason: "invalid-entry" };
    }
    if (hasControlCharacter(successorPath)) {
      return { ok: false, reason: "control-character" };
    }
    if (
      successorPath.length > SUCCESSOR_PATH_MAX_LENGTH ||
      successorPath.includes("..") ||
      !SUCCESSOR_PATH_RE.test(successorPath)
    ) {
      return { ok: false, reason: "invalid-successor-path" };
    }
  }

  return { ok: true };
}

function checkControlCharArgument(
  value: unknown,
): { ok: true } | { ok: false; reason: string } {
  if (typeof value === "string" && hasControlCharacter(value)) {
    return { ok: false, reason: "control-character" };
  }
  return { ok: true };
}

/**
 * Pure lookup: deprecation headers for `routeKey` at instant `nowIso`.
 *
 * Deterministic refusal precedence: argument control characters, then
 * `routeKey` shape, then `nowIso` shape/timestamp, then the whole registry
 * (so a malformed registry is refused even when the route is absent).
 */
export function deprecationHeadersFor(
  registry: unknown,
  routeKey: unknown,
  nowIso: unknown,
): DeprecationHeadersResult {
  const routeKeyControl = checkControlCharArgument(routeKey);
  if (!routeKeyControl.ok) {
    return { ok: false, reason: routeKeyControl.reason };
  }
  const nowControl = checkControlCharArgument(nowIso);
  if (!nowControl.ok) {
    return { ok: false, reason: nowControl.reason };
  }

  if (typeof routeKey !== "string" || routeKey === "" || routeKey.length > ROUTE_KEY_MAX_LENGTH) {
    return { ok: false, reason: "invalid-route-key" };
  }

  if (typeof nowIso !== "string" || nowIso.length > TIMESTAMP_MAX_LENGTH) {
    return { ok: false, reason: "invalid-timestamp" };
  }
  const nowMs = parseStrictIsoUtcMs(nowIso);
  if (nowMs === null) {
    return { ok: false, reason: "invalid-timestamp" };
  }

  const registryResult = validateRegistry(registry);
  if (!registryResult.ok) {
    return registryResult;
  }

  // Re-read through descriptors again, inside try/catch: the traps a
  // validation-time inspection bypassed are not trusted here either, and a
  // Proxy may throw — or supply values that were never validated — on these
  // later reads. Every re-read field is therefore re-checked with the same
  // field rules; any divergence from what validation saw is refused. The loop
  // bound is the validated length from `validateRegistry`, never a fresh
  // `registry.length` read through the Proxy (a divergent length could bypass
  // the 500-entry bound and a throwing `get` trap would escape unguarded);
  // the bounded re-read keeps lookup `O(n)`, `n <= MAX_DEPRECATIONS`.
  const list = registry as unknown[];
  const validatedLength = registryResult.length;
  let match: {
    readonly routeKey: string;
    readonly deprecatedAtIso: string;
    readonly sunsetAtIso: string | null;
    readonly successorPath: string | null;
  } | undefined;
  for (let index = 0; index < validatedLength; index += 1) {
    let routeKeyValue: unknown;
    let deprecatedValue: unknown;
    let sunsetValue: unknown;
    let successorValue: unknown;
    try {
      const elementDescriptor = Object.getOwnPropertyDescriptor(list, index);
      if (elementDescriptor === undefined || !isDataProperty(elementDescriptor)) {
        return { ok: false, reason: "hostile-input" };
      }
      const entry = elementDescriptor.value;
      if (typeof entry !== "object" || entry === null) {
        continue;
      }
      const target = entry as object;
      const routeKeyDescriptor = Object.getOwnPropertyDescriptor(target, "routeKey");
      if (routeKeyDescriptor === undefined || !isDataProperty(routeKeyDescriptor)) {
        return { ok: false, reason: "hostile-input" };
      }
      routeKeyValue = routeKeyDescriptor.value;
      if (typeof routeKeyValue !== "string" || routeKeyValue !== routeKey) {
        continue;
      }
      const deprecatedDescriptor = Object.getOwnPropertyDescriptor(target, "deprecatedAtIso");
      const sunsetDescriptor = Object.getOwnPropertyDescriptor(target, "sunsetAtIso");
      const successorDescriptor = Object.getOwnPropertyDescriptor(target, "successorPath");
      for (const descriptor of [deprecatedDescriptor, sunsetDescriptor, successorDescriptor]) {
        if (descriptor === undefined || !isDataProperty(descriptor)) {
          return { ok: false, reason: "hostile-input" };
        }
      }
      deprecatedValue = deprecatedDescriptor!.value;
      sunsetValue = sunsetDescriptor!.value;
      successorValue = successorDescriptor!.value;
    } catch {
      return { ok: false, reason: "hostile-input" };
    }

    if (typeof routeKeyValue === "string" && hasControlCharacter(routeKeyValue)) {
      return { ok: false, reason: "control-character" };
    }
    if (
      typeof routeKeyValue !== "string" ||
      routeKeyValue === "" ||
      routeKeyValue.length > ROUTE_KEY_MAX_LENGTH
    ) {
      return { ok: false, reason: "invalid-entry" };
    }

    const deprecatedResult = checkTimestampField(deprecatedValue);
    if (!deprecatedResult.ok) {
      return deprecatedResult;
    }

    let sunsetAtMs: number | null = null;
    if (sunsetValue !== null) {
      if (typeof sunsetValue !== "string") {
        return { ok: false, reason: "invalid-entry" };
      }
      if (hasControlCharacter(sunsetValue)) {
        return { ok: false, reason: "control-character" };
      }
      if (sunsetValue.length > TIMESTAMP_MAX_LENGTH) {
        return { ok: false, reason: "invalid-timestamp" };
      }
      const sunsetMs = parseStrictIsoUtcMs(sunsetValue);
      if (sunsetMs === null) {
        return { ok: false, reason: "invalid-timestamp" };
      }
      sunsetAtMs = sunsetMs;
      if (sunsetAtMs < deprecatedResult.ms) {
        return { ok: false, reason: "sunset-before-deprecation" };
      }
    }

    if (successorValue !== null) {
      if (typeof successorValue !== "string") {
        return { ok: false, reason: "invalid-entry" };
      }
      if (hasControlCharacter(successorValue)) {
        return { ok: false, reason: "control-character" };
      }
      if (
        successorValue.length > SUCCESSOR_PATH_MAX_LENGTH ||
        successorValue.includes("..") ||
        !SUCCESSOR_PATH_RE.test(successorValue)
      ) {
        return { ok: false, reason: "invalid-successor-path" };
      }
    }

    match = {
      routeKey: routeKeyValue,
      deprecatedAtIso: deprecatedValue as string,
      sunsetAtIso: sunsetValue as string | null,
      successorPath: successorValue as string | null,
    };
    break;
  }
  if (match === undefined) {
    return { ok: true, headers: {} };
  }

  const deprecatedAtMs = Date.parse(match.deprecatedAtIso);
  if (deprecatedAtMs > nowMs) {
    return { ok: true, headers: {} };
  }

  const headers: Record<string, string> = {
    Deprecation: `@${Math.floor(deprecatedAtMs / 1000)}`,
  };
  if (match.sunsetAtIso !== null) {
    headers.Sunset = new Date(Date.parse(match.sunsetAtIso)).toUTCString();
  }
  if (match.successorPath !== null) {
    headers.Link = `<${match.successorPath}>; rel="successor-version"`;
  }
  return { ok: true, headers };
}
