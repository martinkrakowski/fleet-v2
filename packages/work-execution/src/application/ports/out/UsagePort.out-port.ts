// Outbound contract: read the usage/cost of an attempt's recorded opencode
// session. Refined for lane S3; the reference reader is opencode's own
// sqlite database on the recorded runner host (its HTTP API needs a password
// since opencode 2.1, the database needs none).
/**
 * UsagePort: given an attempt, read what its recorded opencode session cost.
 * The read happens on the attempt's recorded runner host, never through the
 * opencode HTTP API, and never touches message text — only numeric columns
 * and a role field of one session id. An attempt with no session id is
 * `unavailable` with reason `no session id`, without running anything.
 */

import type { AttemptRecord, AttemptUsageRecord } from '../../../domain/execution-records.js';

export interface ReadUsageRequest {
  readonly attempt: AttemptRecord;
}

export type ReadUsageResult =
  | { readonly outcome: 'read'; readonly usage: AttemptUsageRecord }
  | {
      readonly outcome: 'unavailable';
      readonly usage: AttemptUsageRecord;
    };

export interface UsagePort {
  readUsage(request: ReadUsageRequest): Promise<ReadUsageResult>;
}
