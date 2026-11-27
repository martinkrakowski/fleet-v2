// Lane SH7b: the day-writer's inbound contract. For one UTC day the use case
// evaluates every shadow criterion the chain can currently compute (S1, S4',
// S5', S6', S7, S8, S9, S12), records each definite pass/fail verdict into the
// shadow-evidence ledger by compare-and-set, and reports every other
// criterion as unevaluated — never as a pass, never as a silent fail.
import type { CutoverShadowCriterion } from '../../../domain/cutover-records.js';
import type { ShadowDivergenceDetails } from '../../../domain/shadow-day-merge-set.js';

export interface RecordShadowDayRequest {
  readonly repository: { readonly owner: string; readonly repo: string };
  readonly legacyStateDir: string;
  /** The UTC day `YYYY-MM-DD`; omitted means yesterday (UTC calendar date of now minus one day). */
  readonly day?: string;
  readonly deadlineIso?: string;
  /**
   * OD7a2: scheduled mode (the rendered `fleet-v2-shadow-record-day` timer's
   * flag). When `true`, the use case fails closed before writing anything:
   * the standing grant must cover the whole day, the first in-day `job` tick
   * must fall within the first-tick grace window, the day must not be a
   * partial day, and S12 must be decidable. Omitted (manual mode) keeps the
   * historical behaviour exactly.
   */
  readonly scheduled?: boolean;
}

/**
 * OD7a3 note on manual mode: it no longer keeps the historical behaviour
 * exactly. Two S12 coverage failures — `'late-last-tick'` (the daemon
 * stopped before the day's close) and `'coverage-gap'` (a hole longer than
 * `SHADOW_MAX_TICK_GAP_MS`) — now refuse without writing to the ledger
 * (`{ outcome: 'refused', reason: ... }`), rather than recording a `fail`
 * verdict; scheduled mode instead stops as `skipped` on the same reasons.
 * Everything else in manual mode keeps the historical behaviour exactly.
 */

export type RecordShadowDayRefusalReason =
  | 'invalid-request'
  | 'too-early'
  | 'too-old'
  | 'day-out-of-order'
  | 'verdict-conflict'
  | 'release-conflict'
  | 'merges-conflict'
  | 'late-last-tick'
  | 'coverage-gap';

export type RecordShadowDayUnknownReason =
  | 'ledger-unreadable'
  | 'ledger-unknown-version'
  | 'ledger-busy'
  | 'deadline-exceeded'
  | 'daemon-events-unavailable'
  | 'daemon-events-corrupt'
  | 's12-unknown'
  | 'scheduled-evaluation-failed';

export interface RecordShadowDayUnevaluated {
  readonly criterion: CutoverShadowCriterion;
  readonly reason: string;
}

export type RecordShadowDayResult =
  | {
      readonly outcome: 'recorded' | 'unchanged';
      readonly day: string;
      readonly revision: number;
      readonly recorded: Partial<Record<CutoverShadowCriterion, 'pass' | 'fail'>>;
      readonly unevaluated: readonly RecordShadowDayUnevaluated[];
      /**
       * Present only when S5' was evaluated (absent when it is unevaluated
       * or `not-wired`): S5''s non-digested unresolved diagnostics — the
       * full deduped count of day-scoped carry decisions the resolver left
       * `unknown`, plus at most `SHADOW_CARRY_MAX_UNRESOLVED_IDS` bounded
       * ids for them. Never part of any verdict digest.
       */
      readonly premergeCarry?: {
        readonly unresolvedCount: number;
        readonly unresolvedIds: readonly string[];
      };
      /**
       * Present only when at least one evaluated criterion (S1, S4' or S6')
       * diverged: the criteria's non-digested divergence diagnostics — the
       * full per-criterion divergence count plus at most
       * `SHADOW_DIVERGENCE_DIAGNOSTICS_MAX` bounded, deterministically
       * sorted items each. Never a criterion with no divergences, never an
       * empty object, never part of any verdict digest.
       */
      readonly divergenceDiagnostics?: {
        readonly S1?: ShadowDivergenceDetails;
        readonly S4?: ShadowDivergenceDetails;
        readonly S6?: ShadowDivergenceDetails;
      };
    }
  | { readonly outcome: 'refused'; readonly reason: RecordShadowDayRefusalReason }
  | { readonly outcome: 'unknown'; readonly reason: RecordShadowDayUnknownReason }
  | {
      /**
       * OD7a2, scheduled mode only: a guard held, nothing was written, and the
       * operator should simply try again the next day. Exit 0 at the CLI.
       */
      readonly outcome: 'skipped';
      readonly reason:
        | 'partial-day'
        | 'too-few-ticks'
        | 'grant-unavailable'
        | 'grant-not-covering-day'
        | 'late-last-tick'
        | 'coverage-gap';
    };

export interface RecordShadowDayPort {
  execute(request: RecordShadowDayRequest): Promise<RecordShadowDayResult>;
}
