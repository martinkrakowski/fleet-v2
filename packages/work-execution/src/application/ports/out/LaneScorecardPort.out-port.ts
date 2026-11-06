// @generated outbound contract scaffold — refined for lane CO19.
/**
 * LaneScorecardPort stores lane-performance rows under `<stateDir>/scorecard/`
 * as versioned JSONL whose first line is `{"schemaVersion":1}`. A row is ids,
 * codes, counts and durations only. An append is atomic under the store's
 * lock and refuses a duplicate run id; a read returns the rows in append order
 * and names every line it cannot parse by its line number, never skipping or
 * guessing one. An absent file is known absence; an unreadable one is
 * unreadable. No result carries a path, a file content or an error message.
 */

export const LANE_SCORECARD_SCHEMA_VERSION = 1 as const;

/** The only id shape a row may carry: no path separator, no whitespace, bounded. */
export const LANE_SCORECARD_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

export const LANE_SCORECARD_FINAL_STATES = ['merged', 'stopped'] as const;
export type LaneScorecardFinalState = (typeof LANE_SCORECARD_FINAL_STATES)[number];

export const LANE_SCORECARD_VERIFICATION_RESULTS = ['pass', 'fail', 'pending', 'unknown'] as const;
export type LaneScorecardVerificationResult = (typeof LANE_SCORECARD_VERIFICATION_RESULTS)[number];

/** The store's bounds: a file above 4 MiB or holding 20 000 rows is `too-large`. */
export const LANE_SCORECARD_MAX_FILE_BYTES = 4 * 1024 * 1024;
export const LANE_SCORECARD_MAX_ROWS = 20_000;

export interface LaneScorecardFindings {
  readonly blocker: number;
  readonly major: number;
  readonly minor: number;
  readonly nit: number;
}

export interface LaneScorecardRow {
  readonly runId: string;
  readonly workOrderId: string;
  readonly tier: 1 | 2;
  readonly finalState: LaneScorecardFinalState;
  readonly fixRounds: number;
  readonly attemptCount: number;
  readonly parkCount: number;
  readonly prNumber: number | null;
  readonly firstPassCompleted: boolean;
  readonly reviewFindings: LaneScorecardFindings;
  readonly verificationResult: LaneScorecardVerificationResult;
  /** Milliseconds between the first attempt's creation and the last one's end; null when it cannot be computed. */
  readonly durationMs: number | null;
}

export type LaneScorecardAppendRefusal =
  | 'duplicate-run' | 'unreadable-store' | 'unknown-schema-version' | 'lock-busy' | 'too-large';

export type LaneScorecardAppendResult =
  | { readonly outcome: 'appended' }
  | { readonly outcome: 'refused'; readonly reason: LaneScorecardAppendRefusal };

export interface LaneScorecardLineProblem {
  /** 1-based line number in the file (the header is line 1). */
  readonly lineNumber: number;
  readonly reason: 'malformed-line';
}

export type LaneScorecardReadResult =
  | {
      readonly outcome: 'read';
      readonly rows: readonly LaneScorecardRow[];
      readonly problems: readonly LaneScorecardLineProblem[];
    }
  | { readonly outcome: 'absent' }
  | { readonly outcome: 'unreadable'; readonly reason: 'io-error' | 'unknown-schema-version' | 'too-large' };

export interface LaneScorecardPort {
  /** Atomic under the store's lock; refuses a run id the store already holds. */
  append(row: LaneScorecardRow): Promise<LaneScorecardAppendResult>;
  /** Rows in append order; a line that cannot be parsed is a problem, never a row. */
  read(): Promise<LaneScorecardReadResult>;
}
