/**
 * CO13: the per-runner-endpoint dispatch stagger. A session start for one
 * runner endpoint is spaced at least `minIntervalMs` from the endpoint's last
 * start. Pure: the clock arrives as an argument; this module reads no clock,
 * no file, no network, no environment and never throws.
 */

import type { AttemptRunnerRecord } from './execution-records.js';

/** The default minimum interval between starts per runner endpoint, in ms. */
export const DEFAULT_DISPATCH_STAGGER_MS = 20_000;

/** The endpoint facts that identify one runner endpoint. */
export interface DispatchEndpointFacts {
  readonly kind: string | null;
  readonly hostName: string | null;
  readonly host: string | null;
  readonly remotePort: number | null;
}

/** The facts the decision needs: the clock, the durable seed and the interval. */
export interface DispatchStaggerFacts {
  readonly nowIso: string;
  readonly lastStartIso: string | null;
  readonly minIntervalMs: number;
}

export type DispatchStaggerDecision =
  | { readonly ok: true }
  | { readonly ok: false; readonly retryAfterMs: number };

/**
 * The stable key of one runner endpoint: `kind:host:port`. The host is the
 * trimmed `hostName` when non-empty, else the trimmed `host` when non-empty,
 * else `'local'`; the port is `remotePort` when a finite integer `>= 0`, else
 * `0`; a null endpoint gives `unknown:local:0`. Never a path, never a
 * credential, never free text.
 */
export function dispatchEndpointKey(endpoint: DispatchEndpointFacts | null): string {
  if (endpoint === null) {
    return 'unknown:local:0';
  }
  const kind = endpoint.kind ?? 'unknown';
  const hostName = endpoint.hostName?.trim() ?? '';
  const host = endpoint.host?.trim() ?? '';
  const hostPart = hostName !== '' ? hostName : host !== '' ? host : 'local';
  const port =
    typeof endpoint.remotePort === 'number' &&
    Number.isInteger(endpoint.remotePort) &&
    endpoint.remotePort >= 0
      ? endpoint.remotePort
      : 0;
  return `${kind}:${hostPart}:${port}`;
}

/** Map an attempt's runner block to endpoint facts; a null/undefined runner gives null. */
export function dispatchEndpointFactsOf(runner: AttemptRunnerRecord | null | undefined): DispatchEndpointFacts | null {
  if (runner === null || runner === undefined) {
    return null;
  }
  return {
    kind: runner.kind ?? null,
    hostName: runner.hostName ?? null,
    host: runner.host ?? null,
    remotePort: runner.remotePort ?? null,
  };
}

/**
 * Whether a session start may happen now for one endpoint. Pure and never
 * throws, in this order: a broken interval falls back to the default; a zero
 * interval, a missing last start, or unparseable times never block; a last
 * start in the future waits one full interval from now.
 */
export function decideDispatchStagger(facts: DispatchStaggerFacts): DispatchStaggerDecision {
  const interval =
    Number.isFinite(facts.minIntervalMs) && facts.minIntervalMs >= 0
      ? facts.minIntervalMs
      : DEFAULT_DISPATCH_STAGGER_MS;
  if (interval === 0) {
    return { ok: true };
  }
  if (facts.lastStartIso === null) {
    return { ok: true };
  }
  const lastMs = Date.parse(facts.lastStartIso);
  const nowMs = Date.parse(facts.nowIso);
  if (!Number.isFinite(lastMs) || !Number.isFinite(nowMs)) {
    return { ok: true };
  }
  const elapsed = nowMs - lastMs;
  if (elapsed >= interval) {
    return { ok: true };
  }
  if (elapsed < 0) {
    return { ok: false, retryAfterMs: interval };
  }
  return { ok: false, retryAfterMs: interval - elapsed };
}
