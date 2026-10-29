/** The `decisions` command group of the CLI driver; its entries moved verbatim from the command table. */

import { computeRankingTrialFigures, KNOWLEDGE_RANKING_CONSUMER } from '@fleet/brief-knowledge';
import { str, decisionsReportLine, CliUsageError } from './payload.js';
import type { CommandHandler } from './payload.js';

export const decisionsCommands: Readonly<Record<string, CommandHandler>> = {
    // `fleet-v2 decisions report --consumer knowledge-ranking` (K4): the
    // ten-proposal trial figures, one line per contextRef, computed by the
    // pure brief-knowledge function from the journal's own read. Nothing is
    // invented: a figure the receipts cannot carry prints as the
    // not-persisted sentinel the port declares.
    report: async (p, rt) => {
      const consumer = str(p, 'consumer');
      if (consumer.trim() === '') {
        throw new CliUsageError('decisions report requires --consumer <name>');
      }
      if (consumer !== KNOWLEDGE_RANKING_CONSUMER) {
        throw new CliUsageError(
          `decisions report supports only --consumer ${KNOWLEDGE_RANKING_CONSUMER}`,
        );
      }
      const snapshot = await rt.knowledge.decisionReceiptJournal.readJournal({ consumer });
      const figures = computeRankingTrialFigures(snapshot);
      // Fix round: the read skips malformed lines instead of failing, and
      // the report says so rather than reading as if nothing were missing.
      const lines = figures.map((figure) => decisionsReportLine(figure));
      if (snapshot.skippedLines > 0) {
        lines.push(`skipped malformed lines: ${snapshot.skippedLines}`);
      }
      return {
        outcome: 'reported',
        consumer,
        contextCount: figures.length,
        lines,
      };
    },
};
