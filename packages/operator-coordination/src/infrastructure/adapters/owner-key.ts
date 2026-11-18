/**
 * Pure pinned-owner-public-key resolver (KEY0b).
 *
 * The owner public key is read ONLY from the pinned
 * `installation.owner.publicKey` (`OwnerSection` of `FleetInstallation`,
 * already validated and trust-checked by `loadInstallation`). The ambient
 * `FLEET_OWNER_PUBLIC_KEY` environment variable is never an authority: it is
 * read only to (a) refuse when it disagrees with the pinned key and (b) warn
 * once when it duplicates the pinned key.
 *
 * Cost bound: each exported function is O(n) in the single env string value
 * it may trim/compare, with n capped by `MAX_OWNER_KEY_ENV_LENGTH` (any
 * longer value is refused before any traversal beyond the length check), and
 * O(1) otherwise — one own-property-descriptor read on the env object.
 */

/** The longest `FLEET_OWNER_PUBLIC_KEY` value that is even considered. */
export const MAX_OWNER_KEY_ENV_LENGTH = 128;

export type ResolvedPinnedOwnerPublicKey =
  | {
      readonly status: 'pinned';
      readonly publicKey: string;
      /** A single-line deprecation notice (never a key value) when the env variable equals the pinned key. */
      readonly deprecationWarning?: string;
    }
  | { readonly status: 'env-mismatch'; readonly code: 'owner-key-env-mismatch' }
  | { readonly status: 'unpinned'; readonly code: 'owner-key-unpinned' };

/** What `readEnvOwnData` can report about one environment variable. */
type EnvOwnDataRead =
  | { readonly state: 'absent' }
  /** A value that is not a plain own string, or one whose getter must never run. */
  | { readonly state: 'hostile' }
  | { readonly state: 'value'; readonly value: string };

/**
 * Reads ONLY own data properties of a plain environment object. An accessor
 * property's getter is never invoked, a Proxy is never `get`-trapped, and
 * nothing here throws: hostile shapes are reported, never thrown.
 *
 * The helper's name matches the `check-turbo-env.mjs` reviewed-read scanner
 * pattern so `FLEET_OWNER_PUBLIC_KEY` stays a reviewed RUNTIME_ONLY read.
 */
function readEnvOwnData(env: unknown, name: 'FLEET_OWNER_PUBLIC_KEY'): EnvOwnDataRead {
  // Every reflective operation on `env` — including `Array.isArray`, which
  // consults the target of a Proxy and therefore throws on a revoked Proxy —
  // stays inside the `try`: nothing here ever throws.
  try {
    if (typeof env !== 'object' || env === null || Array.isArray(env)) {
      return { state: 'absent' };
    }
    const descriptor = Object.getOwnPropertyDescriptor(env, name);
    if (descriptor === undefined) {
      return { state: 'absent' };
    }
    if (descriptor.get !== undefined || descriptor.set !== undefined) {
      // An accessor's value is never read: the getter must never run.
      return { state: 'hostile' };
    }
    if (typeof descriptor.value !== 'string') {
      return { state: 'hostile' };
    }
    if (descriptor.value.length > MAX_OWNER_KEY_ENV_LENGTH) {
      // Refused before any traversal: no over-long value is even trimmed.
      return { state: 'hostile' };
    }
    return { state: 'value', value: descriptor.value };
  } catch {
    // A revoked Proxy (or any throwing reflective read) leaves the env
    // unreadable: fail closed.
    return { state: 'hostile' };
  }
}

/** A single-line deprecation notice that never carries a key value. */
function deprecationNotice(): string {
  return (
    'FLEET_OWNER_PUBLIC_KEY is deprecated: the owner public key is read from ' +
    "installation.owner.publicKey; unset the environment variable."
  );
}

/**
 * Resolves the authority for the owner public key. Never throws on any
 * hostile `pinnedKey` or `env`; every refusal is a typed result.
 */
export function resolvePinnedOwnerPublicKey(
  pinnedKey: unknown,
  env: unknown,
): ResolvedPinnedOwnerPublicKey {
  // A pinned key is only a non-empty plain string. Anything else — a number,
  // an array, a Proxy over a string, an accessor, an over-long value — is
  // "unpinned": the environment variable is never trusted as a fallback.
  const pinned =
    typeof pinnedKey === 'string' &&
    pinnedKey.length <= MAX_OWNER_KEY_ENV_LENGTH &&
    pinnedKey.trim().length > 0
      ? pinnedKey.trim()
      : undefined;
  if (pinned === undefined) {
    return { status: 'unpinned', code: 'owner-key-unpinned' };
  }
  const read = readEnvOwnData(env, 'FLEET_OWNER_PUBLIC_KEY');
  if (read.state === 'hostile') {
    // A hostile env value can never be shown to agree with the pinned key.
    return { status: 'env-mismatch', code: 'owner-key-env-mismatch' };
  }
  if (read.state === 'absent') {
    return { status: 'pinned', publicKey: pinned };
  }
  const envValue = read.value.trim();
  if (envValue.length === 0) {
    return { status: 'pinned', publicKey: pinned };
  }
  if (envValue !== pinned) {
    return { status: 'env-mismatch', code: 'owner-key-env-mismatch' };
  }
  return { status: 'pinned', publicKey: pinned, deprecationWarning: deprecationNotice() };
}
