/** The `questions` command group of the CLI driver; its entries moved verbatim from the command table. */

import type { AnswerOwnerQuestionRequest, ListOwnerQuestionsRequest } from '@fleet/operator-coordination';
import { optStr, num, enumOf, OWNER_QUESTION_STATES, TERMINAL_WAIT_STATES, ISO_WITH_ZONE, DEFAULT_WAIT_MAX_MS, DEFAULT_WAIT_INTERVAL_MS, questionIdPositional, readQuestionFile, parseDurationOption, sleep, CliUsageError } from './payload.js';
import type { CommandHandler } from './payload.js';

export const questionsCommands: Readonly<Record<string, CommandHandler>> = {
    ask: async (p, rt) => {
      const filePath = optStr(p, 'file');
      if (filePath === undefined) {
        throw new CliUsageError(
          "questions ask requires '--file <path>' pointing at one JSON question record",
        );
      }
      return rt.coordination.askOwnerQuestion.askOwnerQuestion(readQuestionFile(filePath));
    },
    list: async (p, rt) => {
      const state = optStr(p, 'state');
      const since = optStr(p, 'since');
      if (since !== undefined && (!ISO_WITH_ZONE.test(since) || Number.isNaN(Date.parse(since)))) {
        throw new CliUsageError(
          "questions list '--since' must be an ISO timestamp with an explicit zone (e.g. 2026-10-16T08:00:00Z or +02:00)",
        );
      }
      const request: ListOwnerQuestionsRequest = {
        ...(state !== undefined
          ? { state: enumOf(p, 'state', OWNER_QUESTION_STATES, 'questions list state') }
          : {}),
        ...(since !== undefined ? { since } : {}),
      };
      return rt.coordination.listOwnerQuestions.listOwnerQuestions(request);
    },
    show: async (p, rt) =>
      rt.coordination.readOwnerQuestion.readOwnerQuestion({
        questionId: questionIdPositional(p, 'show'),
      }),
    answer: async (p, rt) => {
      const questionId = questionIdPositional(p, 'answer');
      const revision = num(p, 'revision', Number.NaN);
      if (!Number.isInteger(revision) || revision < 1) {
        throw new CliUsageError(
          "questions answer requires '--revision <n>' naming the question revision you are answering",
        );
      }
      const accepts = p['accept'] === true;
      const rejects = p['reject'] === true;
      const optionId = optStr(p, 'option');
      const text = optStr(p, 'text');
      const reason = optStr(p, 'reason');
      const shapeCount = (accepts ? 1 : 0) + (rejects ? 1 : 0) + (optionId !== undefined ? 1 : 0);
      if (shapeCount !== 1) {
        throw new CliUsageError(
          "questions answer requires exactly one of '--accept', '--reject' or '--option <id>'",
        );
      }
      if (accepts && (reason !== undefined || text !== undefined)) {
        throw new CliUsageError("'--accept' records the recommendation and takes no '--reason' or '--text'");
      }
      if (rejects && (optionId !== undefined || text !== undefined)) {
        throw new CliUsageError("'--reject' takes an optional '--reason' only");
      }
      if (optionId === undefined && text !== undefined) {
        throw new CliUsageError("'--text' answers alongside '--option <id>'");
      }
      const request: AnswerOwnerQuestionRequest = {
        questionId,
        questionRevision: revision,
        shape: accepts ? 'accept' : rejects ? 'reject' : 'answer',
        answeredVia: 'cli',
        ...(optionId !== undefined ? { optionId } : {}),
        ...(text !== undefined ? { text } : {}),
        ...(reason !== undefined ? { reason } : {}),
      };
      return rt.coordination.answerOwnerQuestion.answerOwnerQuestion(request);
    },
    sync: async (_p, rt) => rt.coordination.syncOneWayOwnerQuestions.syncOneWayOwnerQuestions(),
    expire: async (_p, rt) => rt.coordination.expireOwnerQuestions.expireOwnerQuestions(),
    acknowledge: async (p, rt) => {
      const by = optStr(p, 'by');
      if (by === undefined) {
        throw new CliUsageError("questions acknowledge requires '--by <name>' naming who acted on the answer");
      }
      return rt.coordination.acknowledgeOwnerAnswer.acknowledgeOwnerAnswer({
        questionId: questionIdPositional(p, 'acknowledge'),
        by,
      });
    },
    wait: async (p, rt) => {
      const questionId = questionIdPositional(p, 'wait');
      const maxMs = parseDurationOption(p, 'max', DEFAULT_WAIT_MAX_MS);
      const intervalMs = parseDurationOption(p, 'interval', DEFAULT_WAIT_INTERVAL_MS);
      if (intervalMs <= 0) {
        throw new CliUsageError("'--interval' must be greater than zero");
      }
      const deadline = Date.now() + maxMs;
      for (;;) {
        // Every round syncs first: a one-way question is settled by the signed
        // owner decision its linked request carries, never by this poll.
        await rt.coordination.syncOneWayOwnerQuestions.syncOneWayOwnerQuestions();
        const read = await rt.coordination.readOwnerQuestion.readOwnerQuestion({ questionId });
        if (read.outcome === 'found' && TERMINAL_WAIT_STATES.includes(read.question.state)) {
          return { outcome: read.question.state, question: read.question };
        }
        if (Date.now() >= deadline) {
          return {
            outcome: 'timeout',
            ...(read.outcome === 'found' ? { question: read.question } : {}),
            reason:
              read.outcome === 'found'
                ? `the question is still ${read.question.state} after the waited time`
                : 'no owner question is recorded for that id',
          };
        }
        await sleep(Math.min(intervalMs, deadline - Date.now()));
      }
    },
};
