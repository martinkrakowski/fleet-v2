/** The `forge` command group of the CLI driver; its entries moved verbatim from the command table. */

import { str, CliUsageError } from './payload.js';
import type { CommandHandler, Payload } from './payload.js';

/**
 * The optional `pullRequestNumber`: absent stays absent; a present value must
 * be a positive safe integer (a number, or its plain decimal string from a
 * flag). Anything else is a usage error and no request is made.
 */
function strictPullRequestNumber(p: Payload): number | undefined {
  const value = p['pullRequestNumber'];
  if (value === undefined) {
    return undefined;
  }
  let parsed = Number.NaN;
  if (typeof value === 'number') {
    parsed = value;
  } else if (typeof value === 'string' && /^[1-9]\d*$/.test(value)) {
    parsed = Number(value);
  }
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new CliUsageError('forge pullRequestNumber must be a positive integer');
  }
  return parsed;
}

export const forgeCommands: Readonly<Record<string, CommandHandler>> = {
    execute: async (p, rt) => {
      const kind = str(p, 'kind');
      if (kind !== 'push-and-open-pr' && kind !== 'merge-pr' && kind !== 'push-to-pr') {
        throw new CliUsageError(
          "forge kind must be 'push-and-open-pr' or 'merge-pr', or 'push-to-pr' for an existing pull request",
        );
      }
      const pullRequestNumber = strictPullRequestNumber(p);
      const attemptId = str(p, 'attemptId');
      const attempt = await rt.execution.attemptRepository.findAttemptById(attemptId);
      return rt.execution.executeAuthorizedForgeAction.executeAuthorizedForgeAction({
        actionId: str(p, 'actionId') || `forge-${attemptId}`,
        attemptId,
        workOrderId: str(p, 'workOrderId') || attempt?.workOrderId || '',
        kind,
        expectedHeadSha: str(p, 'expectedHeadSha') || attempt?.artifacts?.headCommit || '',
        authorizationGrantId: str(p, 'authorizationGrantId'),
        // A merge names its pull request unless the attempt's journal already
        // holds the typed reference from the action that opened it (WB5b).
        ...(pullRequestNumber !== undefined ? { pullRequestNumber } : {}),
      });
    },
};
