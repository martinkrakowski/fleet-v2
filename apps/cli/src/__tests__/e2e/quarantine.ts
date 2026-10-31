/**
 * E2e scenario quarantine (lane S6). A known-flaky e2e scenario can be marked
 * quarantined until a date: while the marker is active the scenario still runs
 * and reports, but its failure does not fail CI; once the date passes CI fails
 * loudly until the marker is removed or renewed.
 *
 * A marker names the last UTC day the quarantine is active (inclusive) and the
 * tracking issue:
 *
 *   { until: '2026-11-07', issue: '#12' }
 *
 * Wrap the scenario's `it` body with `quarantined(...)`:
 *
 *   it('scenario ...', quarantined(
 *     { until: '2026-11-07', issue: '#12' },
 *     TEST_TIMEOUT_MS - 15000,
 *     async () => {
 *       // The scenario body, unchanged.
 *     },
 *   ));
 *
 * While the quarantine is active the body runs exactly once: if it throws or
 * times out, the test still passes and the helper writes a `::warning` GitHub
 * annotation to stdout naming the issue, the marker date and the first line of
 * the error. When the marker expires the test fails immediately with a message
 * saying to remove or renew the marker — removing the wrapper ends the
 * quarantine. An invalid marker (a malformed or impossible `until`, an issue
 * that is not `#<digits>`, or an `until` more than
 * `E2E_QUARANTINE_MAX_DAYS` days after today) always fails the test.
 */

export interface E2eQuarantineMarker {
  readonly until: string;
  readonly issue: string;
}

/** The newest `until` allowed: the weekly review renews markers past this. */
export const E2E_QUARANTINE_MAX_DAYS = 14;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ISSUE_RE = /^#[1-9]\d*$/;
const DAY_MS = 24 * 60 * 60 * 1000;

export type QuarantineState =
  | { readonly kind: 'active' }
  | { readonly kind: 'expired'; readonly message: string }
  | { readonly kind: 'invalid'; readonly message: string };

/** The UTC calendar-day key (`YYYY-MM-DD`) containing the instant `ms`. */
function utcDayKey(ms: number): string {
  const date = new Date(ms);
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** Milliseconds of the UTC midnight that starts the day named by `key`. */
function utcMidnightMs(key: string): number {
  const [year, month, day] = key.split('-').map(Number);
  return Date.UTC(year, month - 1, day);
}

/** Whole UTC days from today's UTC midnight to the `until` UTC midnight. */
function daysFromToday(until: string, nowMs: number): number {
  return Math.round((utcMidnightMs(until) - utcMidnightMs(utcDayKey(nowMs))) / DAY_MS);
}

/** Why the marker is invalid, or null when it is well-formed. */
function invalidReason(marker: E2eQuarantineMarker, nowMs: number): string | null {
  const { until, issue } = marker;
  if (!DATE_RE.test(until)) {
    return `until "${until}" is not YYYY-MM-DD`;
  }
  const [year, month, day] = until.split('-').map(Number);
  const asDate = new Date(Date.UTC(year, month - 1, day));
  if (
    asDate.getUTCFullYear() !== year ||
    asDate.getUTCMonth() !== month - 1 ||
    asDate.getUTCDate() !== day
  ) {
    return `until "${until}" is not a real calendar date`;
  }
  if (!ISSUE_RE.test(issue)) {
    return `issue "${issue}" is not "#<digits>"`;
  }
  if (daysFromToday(until, nowMs) > E2E_QUARANTINE_MAX_DAYS) {
    return `until "${until}" is more than ${E2E_QUARANTINE_MAX_DAYS} days after today`;
  }
  return null;
}

/** The pure decision: active, expired (run no body, fail loudly) or invalid. */
export function quarantineState(marker: E2eQuarantineMarker, nowMs: number): QuarantineState {
  const why = invalidReason(marker, nowMs);
  if (why !== null) {
    return { kind: 'invalid', message: `invalid e2e quarantine marker: ${why}` };
  }
  if (daysFromToday(marker.until, nowMs) < 0) {
    return {
      kind: 'expired',
      message: `e2e quarantine expired on ${marker.until} (${marker.issue}): remove or renew the marker`,
    };
  }
  return { kind: 'active' };
}

/**
 * Wrap an e2e `it` body in a quarantine. Returns the function to pass to
 * `it(...)`. While the marker is active the body runs exactly once (no retry):
 * a pass passes, and a throw or a budget timeout resolves the test after
 * writing one `::warning` annotation line via `write`. An invalid or expired
 * marker throws before the body runs.
 */
export function quarantined(
  marker: E2eQuarantineMarker,
  budgetMs: number,
  body: () => Promise<void>,
  options?: { readonly now?: () => number; readonly write?: (line: string) => void },
): () => Promise<void> {
  const now = options?.now ?? Date.now;
  const writeLine = options?.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  return async () => {
    const state = quarantineState(marker, now());
    if (state.kind !== 'active') {
      throw new Error(state.message);
    }
    const bodyPromise = body();
    // If the budget wins the race, the body may still settle later; swallow a
    // late rejection so it never surfaces as an unhandled rejection.
    bodyPromise.catch(() => {});
    let timer: ReturnType<typeof setTimeout> | undefined;
    const budgetPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`the quarantined scenario did not settle within ${budgetMs} ms`)),
        budgetMs,
      );
    });
    try {
      await Promise.race([bodyPromise, budgetPromise]);
    } catch (error) {
      const firstLine = (error instanceof Error ? error.message : String(error)).split('\n')[0] ?? '';
      writeLine(
        `::warning title=e2e quarantine::${marker.issue} failed while quarantined until ${marker.until}: ` +
          firstLine.slice(0, 200),
      );
    } finally {
      clearTimeout(timer);
    }
  };
}
