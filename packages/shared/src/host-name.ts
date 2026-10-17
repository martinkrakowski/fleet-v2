/**
 * The installation host-name rule, shared so the loader and the runtime
 * adapters validate names with one implementation (H3b): the host name a
 * composition root passes to a runner adapter is the loader-validated
 * host-map key, and the adapters refuse a name that would fail the loader.
 */

/** A host-map key: one identifier-shaped token, never an option or a path. */
const HOST_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Names a host-map key must never take, lowercased. */
const FORBIDDEN_HOST_NAMES: ReadonlySet<string> = new Set([
  "constructor",
  "prototype",
  "__proto__",
  "hasownproperty",
]);

/**
 * Whether `name` is a valid installation host-map key: at most 128
 * characters, identifier-shaped, without a `..` traversal, and never one of
 * the forbidden prototype-chain names. This is the exact rule the
 * installation loader applies to v2 `hosts` keys.
 */
export function isValidHostName(name: string): boolean {
  return (
    name.length <= 128 &&
    HOST_NAME_PATTERN.test(name) &&
    !name.includes("..") &&
    !FORBIDDEN_HOST_NAMES.has(name.toLowerCase())
  );
}
