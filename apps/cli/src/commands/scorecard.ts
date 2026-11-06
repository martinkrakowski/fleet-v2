/** The `scorecard` command group of the CLI driver; its entries moved verbatim from the command table. */

import { CliUsageError, str } from './payload.js';
import type { CommandHandler } from './payload.js';

export const scorecardCommands: Readonly<Record<string, CommandHandler>> = {
  // `fleet-v2 scorecard append --runId <runId>` (CO19): appends one
  // lane-performance row for one terminal conducted run to the versioned
  // scorecard. The driver only guarantees the run id is present; the use case
  // owns every domain rule (terminal state, unreadable stores, duplicates).
  append: async (p, rt) => {
    const runId = str(p, 'runId');
    if (runId.trim() === '') {
      throw new CliUsageError('scorecard append requires --runId <runId>');
    }
    return await rt.execution.appendScorecard.appendScorecard({
      runId,
      nowIso: new Date().toISOString(),
    });
  },
};
