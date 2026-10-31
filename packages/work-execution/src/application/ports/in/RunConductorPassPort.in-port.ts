// @generated inbound contract scaffold — refined for lane K7-6.
/**
 * RunConductorPassPort: one driver pass of the conductor (plan §3.1). A pass
 * takes or renews the state directory's driver lease, reads the halt marker,
 * and for each non-terminal run takes or renews its run lease, applies a
 * recorded resume, then advances it until it waits, parks, ends or a step is
 * not built, at most eight steps. The CLI loops over passes with back-off; a
 * second method releases every lease the holder holds on shutdown.
 */

import type { AdvanceLaneRunResult } from './AdvanceLaneRunPort.in-port.js';

/** > twice the 2-minute longest poll; ≤ LANE_RUN_LEASE_MAX_MS. */
export const CONDUCTOR_LEASE_MS = 5 * 60 * 1000;

export const CONDUCTOR_MAX_STEPS_PER_RUN = 8;

export interface RunConductorPassRequest {
  /** The driver process's identity, minted once per process ('driver-' + ULID). */
  readonly holderId: string;
  readonly nowIso: string;
}

export type ConductorRunReport =
  | { readonly runId: string; readonly outcome: 'advanced'; readonly steps: readonly AdvanceLaneRunResult[] }
  | { readonly runId: string; readonly outcome: 'skipped'; readonly reason: 'lease-held' | 'lease-refused' }
  | { readonly runId: string; readonly outcome: 'resume-refused'; readonly reason: string };

export interface ConductorAttentionItem {
  readonly runId: string;
  /** KF-33b2: `out-of-scope-findings` reports a review that passed only through out-of-scope dispositions. */
  readonly kind: 'stop-grace-exceeded' | 'out-of-scope-findings';
}

export type RunConductorPassResult =
  | {
      readonly outcome: 'completed';
      readonly halted: boolean;
      /** True when any step entered, acted or repaired (the CLI resets its back-off). */
      readonly progressed: boolean;
      readonly runs: readonly ConductorRunReport[];
      readonly attention: readonly ConductorAttentionItem[];
    }
  | { readonly outcome: 'refused'; readonly reason: 'invalid-request' | 'driver-lease-held' | 'driver-lease-refused' };

export interface RunConductorPassPort {
  runPass(request: RunConductorPassRequest): Promise<RunConductorPassResult>;
  /** Release the driver lease and every run lease `holderId` holds; never throws for a lease it does not hold. */
  releaseLeases(request: RunConductorPassRequest): Promise<{ readonly released: number }>;
}
