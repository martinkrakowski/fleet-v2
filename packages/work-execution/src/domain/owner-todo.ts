/**
 * The owner's to-do list, derived from the board's owner entries (to-do plan
 * TD1b): a pure read model that narrows the board's questions and adds the
 * `closedBy` and command fields. Pure — no clock, no store, no writes; the
 * list writes nothing and is never stored as an owner item.
 */

import type { BoardOwnerEntry } from './owner-entries.js';
import { isPlainText, parseTimeMs } from './work-board-facts.js';
import type { BoardOwnerItemKind, BoardQuestionFact, SourceReading } from './work-board-facts.js';

export const OWNER_TODO_SCHEMA_VERSION = 1 as const;

export type OwnerTodoClosedBy = 'owner' | 'merge-observed' | 'recorded-choice' | 'answer';

export interface OwnerTodoCounts {
  readonly total: number;
  readonly gating: number;
  readonly yours: number;
  readonly clearsItself: number;
}

export interface OwnerTodoEntry {
  readonly origin: 'owner-item' | 'question';
  readonly id: string;
  readonly projectId: string | null;
  readonly kind: BoardOwnerItemKind; // a question row is 'decision'
  readonly subject: string | null; // plain text only; never a secret value
  readonly sinceIso: string;
  readonly ageDays: number;
  readonly gating: boolean;
  readonly gatesLanes: readonly string[];
  readonly namesLanes: readonly string[];
  readonly questionIds: readonly string[];
  readonly closedBy: OwnerTodoClosedBy;
  readonly commands: readonly string[];
}

export interface OwnerTodoList {
  readonly schemaVersion: 1;
  readonly readAtIso: string;
  readonly sources: readonly SourceReading[];
  readonly complete: boolean;
  readonly counts: OwnerTodoCounts;
  /** null until lane runs are read (WB11) */
  readonly parksWithoutItem: number | null;
  readonly entries: readonly OwnerTodoEntry[];
}

export interface OwnerTodoExtras {
  readonly sources: readonly SourceReading[];
  readonly complete: boolean;
  readonly parksWithoutItem: number | null;
  /** question states, to drop non-open questions */
  readonly questions: readonly BoardQuestionFact[];
}

function closedByFor(origin: OwnerTodoEntry['origin'], kind: BoardOwnerItemKind): OwnerTodoClosedBy {
  if (origin === 'question') return 'answer';
  if (kind === 'merge') return 'merge-observed';
  if (kind === 'decision') return 'recorded-choice';
  return 'owner';
}

function commandsFor(id: string, closedBy: OwnerTodoClosedBy): readonly string[] {
  if (closedBy !== 'owner' || id.startsWith('-')) return [];
  return ['fleet-v2 owner-items resolve ' + id + ' --done', 'fleet-v2 owner-items withdraw ' + id];
}

function ageDaysBetween(sinceIso: string, nowIso: string): number {
  const sinceMs = parseTimeMs(sinceIso);
  const nowMs = parseTimeMs(nowIso);
  if (sinceMs === null || nowMs === null) return 0;
  const days = Math.floor((nowMs - sinceMs) / 86_400_000);
  return Math.max(days, 0);
}

function compareEntries(a: OwnerTodoEntry, b: OwnerTodoEntry): number {
  if (a.gating !== b.gating) return a.gating ? -1 : 1;
  const bySince = a.sinceIso.localeCompare(b.sinceIso);
  if (bySince !== 0) return bySince;
  return a.id.localeCompare(b.id);
}

/** Derives the owner's to-do list from the board's owner entries. Pure. */
export function deriveOwnerTodo(
  entries: readonly BoardOwnerEntry[],
  extras: OwnerTodoExtras,
  nowIso: string,
): OwnerTodoList {
  const openQuestionIds = new Set(
    extras.questions.filter((q) => q.state === 'open').map((q) => q.questionId),
  );

  const rows: OwnerTodoEntry[] = [];
  for (const entry of entries) {
    if (entry.origin === 'question' && !openQuestionIds.has(entry.id)) continue;
    const closedBy = closedByFor(entry.origin, entry.kind);
    rows.push({
      origin: entry.origin,
      id: entry.id,
      projectId: entry.projectId,
      kind: entry.kind,
      subject: entry.subject !== null && isPlainText(entry.subject) ? entry.subject : null,
      sinceIso: entry.sinceIso,
      ageDays: ageDaysBetween(entry.sinceIso, nowIso),
      gating: entry.gating,
      gatesLanes: entry.gatesLanes,
      namesLanes: entry.namesLanes,
      questionIds: entry.questionIds,
      closedBy,
      commands: commandsFor(entry.id, closedBy),
    });
  }

  rows.sort(compareEntries);

  const counts: OwnerTodoCounts = {
    total: rows.length,
    gating: rows.filter((row) => row.gating).length,
    yours: rows.filter((row) => row.closedBy === 'owner').length,
    clearsItself: rows.filter((row) => row.closedBy !== 'owner').length,
  };

  return {
    schemaVersion: OWNER_TODO_SCHEMA_VERSION,
    readAtIso: nowIso,
    sources: extras.sources,
    complete: extras.complete,
    counts,
    parksWithoutItem: extras.parksWithoutItem,
    entries: rows,
  };
}
