// @generated inbound contract scaffold — refined for lane OT2c-1.
/**
 * ExportRunTelemetryPort: the telemetry export (plan §3.3 "Application",
 * §3.8 "Backfill"). Selects conducted runs and hand-run attempts, maps them
 * to telemetry spans, samples whole traces, applies the cost and dry-run
 * policy, checks the salt fingerprint against the disposition store and
 * returns counts and fixed reason codes only — never a raw id, path, value or
 * free text. This port never throws: every invalid request, unreadable store
 * or failing read is a refused result (fail closed).
 */

import type { RunTelemetryMarkTarget } from '../out/RunTelemetryMarkPort.out-port.js';
import type { RunTelemetrySendDeadline } from '../out/RunTelemetryPort.out-port.js';
import type { TelemetrySpan } from '../../../domain/run-telemetry.js';
import type { TelemetryErrorKind, TelemetryRoute } from '../../../domain/run-telemetry-ids.js';
import type { TelemetryCounterKey } from '../../../domain/run-telemetry-dispositions.js';

/** What the export selects (plan §3.8): one run, one attempt, a work order's runs and hand-run attempts, a time window, or the marked targets. */
export type ExportRunTelemetrySelection =
  | { readonly kind: 'run'; readonly runId: string }
  | { readonly kind: 'attempt'; readonly attemptId: string }
  | { readonly kind: 'work-order'; readonly workOrderId: string }
  | { readonly kind: 'window'; readonly sinceIso: string; readonly untilIso: string | null }
  | { readonly kind: 'marks'; readonly targets: readonly RunTelemetryMarkTarget[] };

/**
 * The plain telemetry policy (plan §3.9): arrives as an input object because
 * `work-execution` does not depend on `@fleet/installation`. `projectAliases`
 * maps a project id to its alias; a project without an alias exports no
 * project attribute, and the raw project id never reaches a span.
 */
export interface ExportRunTelemetryPolicy {
  readonly route: TelemetryRoute;
  readonly sampleRatio: number;
  readonly sendCost: boolean;
  readonly includeDryRun: boolean;
  readonly projectAliases: Readonly<Record<string, string>>;
}

/** The export request. `deadline` and `retryRejected` are validated here and used by the send lane. */
export interface ExportRunTelemetryRequest {
  readonly selection: ExportRunTelemetrySelection;
  readonly policy: ExportRunTelemetryPolicy;
  readonly mode: 'send' | 'dry-run';
  readonly deadline: RunTelemetrySendDeadline;
  readonly retryRejected: boolean;
  readonly nowIso: string;
}

/** Numbers only: what was selected, mapped, dropped and kept. `exported`, `rejected`, `pending` and `refusedByStore` are filled by the send lane. */
export interface ExportRunTelemetryCounts {
  readonly runsSelected: number;
  readonly attemptsSelected: number;
  readonly spansMapped: number;
  /** Spans the mappers dropped as invalid, plus spans that failed the cost rebuild. */
  readonly rejectedInvalid: number;
  /** Spans of traces sampled out (whole traces only, plan §3.9 `sampleRatio`). */
  readonly sampledOut: number;
  /** Spans whose stored disposition is already final (skipped, plan §3.8). */
  readonly alreadyFinal: number;
  /** The spans this export would send. */
  readonly toSend: number;
  /** Receipts dropped because their `completedAtIso` is invalid (plan §3.3). */
  readonly receiptsDropped: number;
  /**
   * The send lane's outcome per span, recorded in the store: `exported` and
   * `rejected` are finals stored by this export; `pending` spans stay pending
   * in the store; `refusedByStore` spans had a disposition write the store
   * skipped, refused or kept (they keep their earlier stored state and are
   * sent or recorded next time). After a send lane the four never overlap and
   * add up to `toSend`.
   */
  readonly exported: number;
  readonly rejected: number;
  readonly pending: number;
  readonly refusedByStore: number;
}

/**
 * The result. `dry-run` returns the spans exactly as they would be sent and
 * writes nothing; `refused` carries a fixed reason code and, for a salt
 * mismatch, the `salt-mismatch` counter (the store refuses such a write, so
 * the count travels in the result, plan §3.5).
 */
export type ExportRunTelemetryResult =
  | { readonly outcome: 'nothing-selected'; readonly counts: ExportRunTelemetryCounts }
  | { readonly outcome: 'dry-run'; readonly counts: ExportRunTelemetryCounts; readonly spans: readonly TelemetrySpan[] }
  | { readonly outcome: 'exported'; readonly counts: ExportRunTelemetryCounts; readonly errorKind: TelemetryErrorKind | null }
  | {
      readonly outcome: 'refused';
      readonly reason: 'invalid-request' | 'salt-mismatch' | 'store-unreadable' | 'store-error' | 'read-error';
      readonly counts: ExportRunTelemetryCounts;
      readonly counters: Readonly<Partial<Record<TelemetryCounterKey, number>>>;
    };

export interface ExportRunTelemetryPort {
  /** Never throws: unknown input is a refused result, never an exception (plan §3.3). */
  execute(request: unknown): Promise<ExportRunTelemetryResult>;
}
