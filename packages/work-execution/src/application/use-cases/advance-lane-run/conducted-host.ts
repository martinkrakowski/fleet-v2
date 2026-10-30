/**
 * A conducted attempt always carries its runner host (seam register); a missing
 * host is never read through the local executor.
 */
import type { AttemptRecord, AttemptRunnerRecord } from '../../../domain/execution-records.js';
import { runnerHasHostName } from '../../../domain/execution-records.js';

/**
 * The attempt's runner when it names an installation host, otherwise `null`
 * meaning "no host: do not read". A legacy hand-run record without a host name
 * (or with no runner at all) reads `null`, never the local executor.
 */
export function conductedRunnerOf(attempt: AttemptRecord): AttemptRunnerRecord | null {
  return runnerHasHostName(attempt.runner) ? (attempt.runner ?? null) : null;
}
