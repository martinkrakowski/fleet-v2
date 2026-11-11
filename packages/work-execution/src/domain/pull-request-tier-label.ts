/**
 * The single conducted-open label on a pull request (CP1B): `tier:1` or
 * `tier:2`, derived only from the run's recorded tier. Both functions are
 * pure and O(1): they read no properties, run no getter or proxy trap, never
 * iterate, and never throw. Strict equality against the number literals `1`
 * and `2` is enough — strict `===` performs no coercion, so an object, Proxy,
 * function, symbol or bigint is rejected without touching it.
 */

export type PullRequestTierLabel = 'tier:1' | 'tier:2';

export type PullRequestTierLabelResult =
  | { readonly ok: true; readonly label: PullRequestTierLabel }
  | { readonly ok: false; readonly reason: 'invalid-tier' };

/**
 * Map the run's recorded tier to its PR label. Only the numbers `1` and `2`
 * map; every other value (including hostile objects, Proxies, arrays with
 * throwing element getters, and objects with lying `length` getters) refuses
 * with `invalid-tier` without reading any property and without throwing.
 */
export function pullRequestTierLabel(tier: unknown): PullRequestTierLabelResult {
  if (tier === 1) {
    return { ok: true, label: 'tier:1' };
  }
  if (tier === 2) {
    return { ok: true, label: 'tier:2' };
  }
  return { ok: false, reason: 'invalid-tier' };
}

/**
 * The request-boundary check: exactly `tier:1` or `tier:2`. The length check
 * is the cost bound — a huge string is refused after reading `.length` only,
 * never scanned. Non-strings (numbers, null, objects, Proxies) are refused
 * without invoking any trap.
 */
export function isPullRequestTierLabel(value: unknown): value is PullRequestTierLabel {
  if (typeof value !== 'string') {
    return false;
  }
  if (value.length !== 6) {
    return false;
  }
  return value === 'tier:1' || value === 'tier:2';
}
