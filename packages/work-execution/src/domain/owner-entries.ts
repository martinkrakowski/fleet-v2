/**
 * The owner-entry derivation, extracted from the work board (to-do plan
 * TD1a): the deduplicated owner-items list behind the board's
 * `ownerItems`. Pure — no clock, no store, no guessing from text.
 */

import {
  BOARD_GATING_OWNER_ITEM_KINDS,
  isPlainText,
} from './work-board-facts.js';
import type {
  BoardOwnerItemFact,
  BoardOwnerItemKind,
  BoardQuestionFact,
  LaneRef,
} from './work-board-facts.js';

/** One entry of the deduplicated owner-items list (plan §3.1 identity rule). */
export interface BoardOwnerEntry {
  readonly origin: 'owner-item' | 'question';
  readonly id: string;
  readonly projectId: string | null;          // null for a question
  readonly kind: BoardOwnerItemKind;
  readonly subject: string | null;            // an item's subject, a question's title
  readonly sinceIso: string;
  readonly gating: boolean;                   // a gating kind (a question is a decision)
  readonly gatesLanes: readonly string[];     // card keys where it is the Waiting reason; sorted
  readonly namesLanes: readonly string[];     // card keys named in blocks or refs; sorted
  readonly placement: 'lane-reason' | 'own-card';
  readonly questionIds: readonly string[];    // questions folded into this item; sorted
}

/** A lane card as the derivation may read it: its key and whether it is done. */
export interface OwnerEntryCard {
  readonly key: string;
  readonly done: boolean;
}

/** Resolves a lane reference to its card key (the board's `formatLaneRef(resolveLaneRef(...))`). */
export type OwnerLaneKeyResolver = (ref: LaneRef) => string;

interface EntryDraft {
  origin: 'owner-item' | 'question';
  id: string;
  projectId: string | null;
  kind: BoardOwnerItemKind;
  subject: string | null;
  sinceIso: string;
  gating: boolean;
  namesLanes: Set<string>;
  gatesLanes: Set<string>;
  questionIds: Set<string>;
}

function parseLaneBlockRef(text: string, projectId: string): LaneRef | null {
  const parts = text.split('/');
  if (parts.length === 2) {
    return { kind: 'plan', projectId, planId: parts[0], laneId: parts[1] };
  }
  if (parts.length === 3) {
    return { kind: 'plan', projectId: parts[0], planId: parts[1], laneId: parts[2] };
  }
  return null;
}

function isClosedQuestion(question: BoardQuestionFact): boolean {
  if (question.state !== 'answered' && question.state !== 'acknowledged') return false;
  const answer = question.answer;
  if (!answer) return false;
  if (answer.shape === 'accept') return true;
  if (answer.shape === 'answer' && (answer.hasOption || answer.hasText)) return true;
  return false;
}

function draftForItem(
  item: BoardOwnerItemFact,
  cardsByKey: Map<string, boolean>,
  resolveLaneKey: OwnerLaneKeyResolver,
): EntryDraft {
  const gating = (BOARD_GATING_OWNER_ITEM_KINDS as readonly BoardOwnerItemKind[]).includes(item.kind);
  const names = new Set<string>();
  const gates = new Set<string>();
  const addLane = (ref: LaneRef, fromBlock: boolean): void => {
    const key = resolveLaneKey(ref);
    if (!cardsByKey.has(key)) return;
    names.add(key);
    if (fromBlock && gating) gates.add(key);
  };

  for (const ref of item.refs) {
    if (ref.kind === 'lane') {
      addLane({ kind: 'plan', projectId: item.projectId, planId: ref.planId, laneId: ref.laneId }, false);
    } else if (ref.kind === 'work-order') {
      addLane({ kind: 'work-order', projectId: item.projectId, workOrderId: ref.id }, false);
    }
  }
  for (const block of item.blocks) {
    if (block.kind === 'lane') {
      const parsed = parseLaneBlockRef(block.ref, item.projectId);
      if (parsed) addLane(parsed, true);
    } else if (block.kind === 'work-order') {
      addLane({ kind: 'work-order', projectId: item.projectId, workOrderId: block.ref }, true);
    }
  }

  const questionIds = new Set<string>();
  for (const ref of item.refs) {
    if (ref.kind === 'question') questionIds.add(ref.id);
  }

  return {
    origin: 'owner-item',
    id: item.itemId,
    projectId: item.projectId,
    kind: item.kind,
    subject: item.subject,
    sinceIso: item.createdAtIso,
    gating,
    namesLanes: names,
    gatesLanes: gates,
    questionIds,
  };
}

function draftForQuestion(
  question: BoardQuestionFact,
  cardsByKey: Map<string, boolean>,
  resolveLaneKey: OwnerLaneKeyResolver,
): EntryDraft {
  const names = new Set<string>();
  const gates = new Set<string>();
  const addLane = (ref: LaneRef): void => {
    const key = resolveLaneKey(ref);
    if (!cardsByKey.has(key)) return;
    names.add(key);
    gates.add(key);
  };
  for (const block of question.blocks) {
    if (block.kind === 'lane') {
      const parts = block.ref.split('/');
      if (parts.length === 3) {
        addLane({ kind: 'plan', projectId: parts[0], planId: parts[1], laneId: parts[2] });
      }
    } else if (block.kind === 'work-order') {
      addLane({ kind: 'work-order', projectId: '', workOrderId: block.ref });
    }
  }
  return {
    origin: 'question',
    id: question.questionId,
    projectId: null,
    kind: 'decision',
    subject: isPlainText(question.title) ? question.title : 'Owner question',
    sinceIso: question.askedAtIso,
    gating: true,
    namesLanes: names,
    gatesLanes: gates,
    questionIds: new Set<string>(),
  };
}

function buildEntries(
  ownerItems: readonly BoardOwnerItemFact[],
  questions: readonly BoardQuestionFact[],
  cardsByKey: Map<string, boolean>,
  resolveLaneKey: OwnerLaneKeyResolver,
): EntryDraft[] {
  const referenced = new Set<string>();
  for (const item of ownerItems) {
    for (const ref of item.refs) {
      if (ref.kind === 'question') referenced.add(ref.id);
    }
  }

  const drafts: EntryDraft[] = [];
  const seen = new Set<string>();
  for (const item of ownerItems) {
    if (seen.has(item.itemId)) continue;
    seen.add(item.itemId);
    if (item.state !== 'open') continue;
    drafts.push(draftForItem(item, cardsByKey, resolveLaneKey));
  }
  for (const question of questions) {
    if (referenced.has(question.questionId)) continue;
    if (isClosedQuestion(question)) continue;
    drafts.push(draftForQuestion(question, cardsByKey, resolveLaneKey));
  }
  return drafts;
}

function finalizeEntry(draft: EntryDraft, cardsByKey: Map<string, boolean>): BoardOwnerEntry {
  const gatesLanes = [...draft.gatesLanes]
    .filter((key) => {
      const done = cardsByKey.get(key);
      return done !== undefined && done === false;
    })
    .sort((a, b) => a.localeCompare(b));
  const namesLanes = [...draft.namesLanes].sort((a, b) => a.localeCompare(b));
  const questionIds = [...draft.questionIds].sort((a, b) => a.localeCompare(b));
  return {
    origin: draft.origin,
    id: draft.id,
    projectId: draft.projectId,
    kind: draft.kind,
    subject: draft.subject,
    sinceIso: draft.sinceIso,
    gating: draft.gating,
    gatesLanes,
    namesLanes,
    placement: gatesLanes.length > 0 ? 'lane-reason' : 'own-card',
    questionIds,
  };
}

export function deriveOwnerEntries(
  ownerItems: readonly BoardOwnerItemFact[],
  questions: readonly BoardQuestionFact[],
  cards: readonly OwnerEntryCard[],
  resolveLaneKey: OwnerLaneKeyResolver,
): readonly BoardOwnerEntry[] {
  const cardsByKey = new Map(cards.map((c) => [c.key, c.done]));
  const drafts = buildEntries(ownerItems, questions, cardsByKey, resolveLaneKey);
  return drafts.map((d) => finalizeEntry(d, cardsByKey));
}
