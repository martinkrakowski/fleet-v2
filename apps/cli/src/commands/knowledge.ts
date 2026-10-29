/** The `knowledge` command group of the CLI driver; its entries moved verbatim from the command table. */

import { KNOWLEDGE_DISPOSITIONS, KNOWLEDGE_REUSE_OUTCOMES } from '@fleet/brief-knowledge';
import type { RecordContextSelectionItem } from '@fleet/brief-knowledge';
import { str, optStr, strOrNull, optNum, strArr, nested, enumOf, nestedArr, firstPositional, CliUsageError } from './payload.js';
import type { CommandHandler } from './payload.js';

export const knowledgeCommands: Readonly<Record<string, CommandHandler>> = {
    'capture-notes': async (p, rt) =>
      rt.knowledge.captureCompletedAttemptNotes.captureCompletedAttemptNotes({
        projectId: str(p, 'projectId'),
        attemptId: str(p, 'attemptId'),
        workOrderId: str(p, 'workOrderId'),
        headCommitSha: str(p, 'headCommitSha'),
        notesMarkdown: strOrNull(p, 'notesMarkdown'),
        pathPrefixes: strArr(p, 'pathPrefixes'),
        nowIso: optStr(p, 'nowIso'),
      }),
    'check-claim': async (p, rt) =>
      rt.knowledge.checkKnowledgeClaim.checkKnowledgeClaim({
        checkId: str(p, 'checkId'),
        entryId: str(p, 'entryId'),
        checkerId: str(p, 'checkerId'),
        procedureName: str(p, 'procedureName'),
        targetPath: optStr(p, 'targetPath'),
        nowIso: optStr(p, 'nowIso'),
      }),
    decide: async (p, rt) =>
      rt.knowledge.decideKnowledgeDisposition.decideKnowledgeDisposition({
        entryId: str(p, 'entryId'),
        disposition: enumOf(p, 'disposition', KNOWLEDGE_DISPOSITIONS, 'knowledge disposition'),
        checkerId: str(p, 'checkerId'),
        reason: str(p, 'reason'),
        nowIso: optStr(p, 'nowIso'),
      }),
    publish: async (p, rt) =>
      rt.knowledge.publishAcceptedKeeper.publishAcceptedKeeper({
        entryId: str(p, 'entryId'),
        nowIso: optStr(p, 'nowIso'),
      }),
    'propose-context': async (p, rt) =>
      rt.knowledge.proposeBriefContext.proposeBriefContext({
        projectId: str(p, 'projectId'),
        laneId: str(p, 'laneId'),
        taskSummary: str(p, 'taskSummary'),
        pathPrefixes: strArr(p, 'pathPrefixes'),
        maxEntries: optNum(p, 'maxEntries'),
        maxTotalChars: optNum(p, 'maxTotalChars'),
      }),
    'select-context': async (p, rt) => {
      const selections = nestedArr<RecordContextSelectionItem>(p, 'selections') ?? [];
      for (const selection of selections) {
        if (
          !selection ||
          typeof selection !== 'object' ||
          typeof selection.decisionBecause !== 'string' ||
          selection.decisionBecause.trim() === ''
        ) {
          throw new CliUsageError(
            "knowledge select-context requires a non-empty 'decisionBecause' for each item",
          );
        }
      }
      return rt.knowledge.recordContextSelection.recordContextSelection({
        attemptId: str(p, 'attemptId'),
        selections,
        // The ranking contextRef the proposals carried (K4): when given, the
        // recorded selection also appends the best-effort ranking-selection
        // outcome the trial report joins. Absent or blank records nothing
        // beyond the selections themselves.
        rankingContextRef: optStr(p, 'rankingContextRef'),
        nowIso: optStr(p, 'nowIso'),
      });
    },
    candidates: async (p, rt) => {
      // `fleet-v2 knowledge candidates <attemptId>`: the disposition queue
      // for one attempt, most reusable first, never truncated.
      const attemptId = str(p, 'attemptId') || firstPositional(p);
      if (attemptId.trim() === '') {
        throw new CliUsageError('knowledge candidates requires an attempt id: fleet-v2 knowledge candidates <attemptId>');
      }
      // Scores arrive as a JSON object (via --json) or a JSON string (via
      // --scores '<json>'); parse the string form here so the use case
      // always sees the map shape it validates.
      let scores = nested<Record<string, number>>(p, 'scores');
      if (scores === undefined && typeof p['scores'] === 'string') {
        try {
          const parsed: unknown = JSON.parse(p['scores'] as string);
          if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
            scores = parsed as Record<string, number>;
          }
        } catch {
          // Fall through to the usage error below.
        }
        if (scores === undefined) {
          throw new CliUsageError("knowledge candidates --scores must be a JSON object of scores");
        }
      }
      const result = await rt.knowledge.listCandidateClaims.listCandidateClaims({
        attemptId,
        ...(scores !== undefined ? { scores } : {}),
      });
      if (result.outcome === 'rejected') {
        return { outcome: result.outcome, reason: result.reason, lines: [] };
      }
      return {
        outcome: result.outcome,
        attemptId,
        count: result.candidates.length,
        lines: result.candidates.map((candidate) => {
          const score = scores?.[candidate.id];
          const scoreText =
            typeof score === 'number' && Number.isFinite(score) ? String(score) : '-';
          return `${candidate.id}  score=${scoreText}  ${candidate.claimText}`;
        }),
      };
    },
    'record-reuse': async (p, rt) =>
      rt.knowledge.recordKnowledgeReuse.recordKnowledgeReuse({
        reuseId: str(p, 'reuseId'),
        entryId: str(p, 'entryId'),
        attemptId: str(p, 'attemptId'),
        outcome: enumOf(p, 'outcome', KNOWLEDGE_REUSE_OUTCOMES, 'knowledge reuse outcome'),
        evidenceRef: optStr(p, 'evidenceRef'),
        nowIso: optStr(p, 'nowIso'),
      }),
    supersede: async (p, rt) =>
      rt.knowledge.supersedeKnowledgeEntry.supersedeKnowledgeEntry({
        olderEntryId: str(p, 'olderEntryId'),
        newerEntryId: str(p, 'newerEntryId'),
        checkerId: str(p, 'checkerId'),
        reason: str(p, 'reason'),
        nowIso: optStr(p, 'nowIso'),
      }),
};
