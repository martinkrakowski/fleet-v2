/** The `forge` command group of the CLI driver; its entries moved verbatim from the command table. */

import { str, CliUsageError } from './payload.js';
import type { CommandHandler } from './payload.js';

export const forgeCommands: Readonly<Record<string, CommandHandler>> = {
    execute: async (p, rt) => {
      const kind = str(p, 'kind');
      if (kind !== 'push-and-open-pr' && kind !== 'merge-pr' && kind !== 'push-to-pr') {
        throw new CliUsageError(
          "forge kind must be 'push-and-open-pr' or 'merge-pr', or 'push-to-pr' for an existing pull request",
        );
      }
      const attemptId = str(p, 'attemptId');
      const attempt = await rt.execution.attemptRepository.findAttemptById(attemptId);
      return rt.execution.executeAuthorizedForgeAction.executeAuthorizedForgeAction({
        actionId: str(p, 'actionId') || `forge-${attemptId}`,
        attemptId,
        workOrderId: str(p, 'workOrderId') || attempt?.workOrderId || '',
        kind,
        expectedHeadSha: str(p, 'expectedHeadSha') || attempt?.artifacts?.headCommit || '',
        authorizationGrantId: str(p, 'authorizationGrantId'),
      });
    },
};
