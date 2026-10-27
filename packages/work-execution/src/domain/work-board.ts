/**
 * The pure work-board read model (plan §3.1, §3.3, §3.4, §3.7).
 * One card per lane in exactly one column; never throws, never performs
 * anything; time enters only through `nowIso`; nothing is guessed from
 * text. Each rule id below names one test in
 * `__tests__/work-board.test.ts`.
 */

import {
  BOARD_GATING_OWNER_ITEM_KINDS,
  BOARD_SOURCES,
  DEFAULT_BOARD_POLICY,
  formatLaneRef,
  parseTimeMs,
  WORK_BOARD_SCHEMA_VERSION,
} from './work-board-facts.js';
import type {
  BoardAttemptFact,
  BoardDeclarationFact,
  BoardFacts,
  BoardMergeFact,
  BoardOptions,
  BoardOwnerItemFact,
  BoardOwnerItemKind,
  BoardPlanFact,
  BoardPlannedLaneStatus,
  BoardPolicy,
  BoardPullRequestLinkFact,
  BoardQuestionFact,
  BoardRunFact,
  BoardSource,
  BoardWorkOrderFact,
  LaneRef,
  SourceReading,
} from './work-board-facts.js';
import { planTextError } from './lane-plan-sidecar.js';
import {
  boardStepText,
  laneBadges,
  lanePullRequests,
  laneReviewCounts,
  laneRound,
  laneSeat,
  laneStep,
} from './work-board-steps.js';
import type {
  BoardBadge,
  BoardLinkConflictLike,
  BoardPrStatus,
  BoardReviewCounts,
  BoardSeat,
  BoardStep,
} from './work-board-steps.js';

export const BOARD_COLUMNS = ['done', 'waiting', 'in-flight', 'queued'] as const;
export type BoardColumn = (typeof BOARD_COLUMNS)[number];
/** Where a lane sits: a column, or off the columns (never-started dropped or deferred lanes, plan §3.2). */
export type BoardPlacement = BoardColumn | 'dropped' | 'deferred';

/** `no-plan`: a work order with no planRef. `not-imported`: a plan lane the plans do not hold. */
export type BoardPlanStatus = BoardPlannedLaneStatus | 'not-imported' | 'no-plan';

export type BoardDoneFact =
  | { readonly via: 'merge-record'; readonly repository: string; readonly number: number; readonly headSha: string;
      readonly mergedAtIso: string; readonly firstSeenAtIso: string; readonly merger: 'fleet' | 'unknown' }
  | { readonly via: 'work-order'; readonly workOrderId: string; readonly recordedAtIso: string };

/** Why a Waiting lane waits: one open gating owner item, or an unreferenced open question. */
export interface BoardOwnerReason {
  readonly origin: 'owner-item' | 'question';
  readonly id: string;
  readonly kind: 'merge' | 'decision' | 'secret';
  readonly subject: string | null;
  readonly sinceIso: string;
}

export interface BoardLaneCard {
  readonly key: string;                       // formatLaneRef(ref)
  readonly ref: LaneRef;
  readonly label: string;                     // laneId, or the work order's laneId; plain text
  readonly projectId: string;
  readonly planId: string | null;
  readonly planStatus: BoardPlanStatus;
  readonly tier: 0 | 1 | 2 | null;
  readonly scope: string | null;
  readonly packages: readonly string[];
  readonly workOrderIds: readonly string[];   // sorted
  readonly started: boolean;
  readonly placement: BoardPlacement;
  readonly done: BoardDoneFact | null;        // non-null iff placement 'done'
  readonly waitingOn: readonly BoardOwnerReason[];  // non-empty iff placement 'waiting'; sinceIso, then id
  /** The not-read readings this card's placement depended on (rule R11). */
  readonly notRead: readonly SourceReading[];
  /** The in-flight step (S3); null off In flight. */
  readonly step: BoardStep | null;
  readonly stepText: string | null;
  readonly seat: BoardSeat | null;
  readonly round: number | null;
  readonly pullRequests: readonly BoardPrStatus[];
  readonly reviewCounts: BoardReviewCounts | null;
  readonly badges: readonly BoardBadge[];
}

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

export type BoardDoneEntry =
  | { readonly kind: 'lane'; readonly key: string }
  | { readonly kind: 'unlinked-merge'; readonly repository: string; readonly number: number; readonly projectId: string | null;
      readonly headSha: string; readonly mergedAtIso: string; readonly firstSeenAtIso: string; readonly merger: 'fleet' | 'unknown';
      readonly badges: readonly BoardBadge[] };

export type BoardWaitingEntry =
  | { readonly kind: 'lane'; readonly key: string }
  | { readonly kind: 'owner'; readonly origin: 'owner-item' | 'question'; readonly id: string };

export interface WorkBoard {
  readonly schemaVersion: typeof WORK_BOARD_SCHEMA_VERSION;
  readonly readAtIso: string;                 // nowIso, normalised
  readonly policy: BoardPolicy;
  readonly doneCutoffIso: string;
  readonly sources: readonly SourceReading[]; // rule R11
  readonly complete: boolean;                 // every reading in `sources` is 'read'
  readonly lanes: readonly BoardLaneCard[];   // every lane, every placement, Done hidden by the window included; by key
  readonly columns: {
    readonly done: { readonly entries: readonly BoardDoneEntry[]; readonly hiddenByWindow: number; readonly notRead: readonly SourceReading[] };
    readonly waiting: { readonly entries: readonly BoardWaitingEntry[]; readonly notRead: readonly SourceReading[] };
    readonly inFlight: { readonly keys: readonly string[]; readonly notRead: readonly SourceReading[] };
    readonly queued: { readonly keys: readonly string[]; readonly notRead: readonly SourceReading[] };
  };
  readonly ownerItems: readonly BoardOwnerEntry[];  // open entries only; sinceIso, then id
}

export type WorkBoardResult =
  | { readonly ok: true; readonly board: WorkBoard }
  | { readonly ok: false; readonly reason: 'invalid-now' | 'invalid-policy' | 'invalid-since' | 'unreadable-facts' };

export function deriveWorkBoard(
  facts: BoardFacts,
  nowIso: string,
  policy: BoardPolicy = DEFAULT_BOARD_POLICY,
  options: BoardOptions = {},
): WorkBoardResult {
  try {
    if (parseTimeMs(nowIso) === null) return { ok: false, reason: 'invalid-now' };
    if (!isValidPolicy(policy)) return { ok: false, reason: 'invalid-policy' };
    let sinceIso: string | null = options.sinceIso ?? null;
    if (sinceIso !== null) {
      if (parseTimeMs(sinceIso) === null) return { ok: false, reason: 'invalid-since' };
      sinceIso = new Date(sinceIso).toISOString();
    }
    const readAtIso = new Date(nowIso).toISOString();
    const board = computeBoard(facts, readAtIso, sinceIso, policy);
    return { ok: true, board };
  } catch {
    return { ok: false, reason: 'unreadable-facts' };
  }
}

function isValidPolicy(policy: BoardPolicy): boolean {
  return (
    Number.isInteger(policy.forgeStaleMinutes) && policy.forgeStaleMinutes >= 1 && policy.forgeStaleMinutes <= 1440 &&
    Number.isInteger(policy.declarationTtlMinutes) && policy.declarationTtlMinutes >= 1 && policy.declarationTtlMinutes <= 10080 &&
    Number.isInteger(policy.doneWindowDays) && policy.doneWindowDays >= 1 && policy.doneWindowDays <= 3650
  );
}

interface Card {
  key: string;
  ref: LaneRef;
  label: string;
  projectId: string;
  planId: string | null;
  planStatus: BoardPlanStatus;
  tier: 0 | 1 | 2 | null;
  scope: string | null;
  packages: readonly string[];
  workOrderIds: readonly string[];
  started: boolean;
  done: BoardDoneFact | null;
  waitingOn: BoardOwnerReason[];
  placement: BoardPlacement;
  notRead: SourceReading[];
  planOrder: number;
  links: BoardPullRequestLinkFact[];
  attempts: BoardAttemptFact[];
  runs: BoardRunFact[];
  declarations: BoardDeclarationFact[];
  pullRequests: BoardPrStatus[];
  step: BoardStep | null;
  stepText: string | null;
  seat: BoardSeat | null;
  round: number | null;
  reviewCounts: BoardReviewCounts | null;
  badges: BoardBadge[];
}

function stringAsc(a: string, b: string): number {
  return a.localeCompare(b);
}

function timeMsOrNegInf(iso: string): number {
  return parseTimeMs(iso) ?? Number.NEGATIVE_INFINITY;
}

function compareIsoDesc(a: string, b: string): number {
  const ta = timeMsOrNegInf(a);
  const tb = timeMsOrNegInf(b);
  if (ta === tb) return 0;
  return ta > tb ? 1 : -1;
}

function compareIsoAsc(a: string, b: string): number {
  const ta = timeMsOrNegInf(a);
  const tb = timeMsOrNegInf(b);
  if (ta === tb) return 0;
  return ta < tb ? -1 : 1;
}

function resolvePlanLaneRef(projectId: string, planId: string, id: string, plans: readonly BoardPlanFact[]): LaneRef {
  const plan = plans.find((p) => p.projectId === projectId && p.planId === planId);
  if (plan) {
    const lane = plan.lanes.find((l) => l.laneId === id || l.aliases.includes(id));
    if (lane) return { kind: 'plan', projectId, planId, laneId: lane.laneId };
  }
  return { kind: 'plan', projectId, planId, laneId: id };
}

function resolveWorkOrderLaneRef(wo: BoardWorkOrderFact, plans: readonly BoardPlanFact[]): LaneRef {
  if (wo.planRef) {
    return resolvePlanLaneRef(wo.planRef.projectId, wo.planRef.planId, wo.planRef.laneId, plans);
  }
  return { kind: 'work-order', projectId: wo.projectId, workOrderId: wo.id };
}

function resolveLaneRef(ref: LaneRef, facts: BoardFacts): LaneRef {
  if (ref.kind === 'plan') {
    return resolvePlanLaneRef(ref.projectId, ref.planId, ref.laneId, facts.plans);
  }
  const wo = facts.workOrders.find((w) => w.id === ref.workOrderId);
  if (wo) {
    return resolveWorkOrderLaneRef(wo, facts.plans);
  }
  return ref;
}

/**
 * The plain-text rule the board applies to its own display text: a work-order
 * lane id becomes a card label, and a question title becomes a subject, only
 * when it passes the plan sidecar's plain-text rule (`planTextError`).
 */
const BOARD_TEXT_MAX_BYTES = 1024;
/** The label of a plan-lane card whose lane id, matched to no imported lane, is not plain text. */
const UNNAMED_PLAN_LANE_LABEL = 'Unnamed plan lane';

function isPlainText(text: string): boolean {
  return planTextError('text', text, BOARD_TEXT_MAX_BYTES) === null;
}

function makeCard(ref: LaneRef, facts: BoardFacts): Card {
  const isPlan = ref.kind === 'plan';
  let label = '';
  if (isPlan) {
    label = isPlainText(ref.laneId) ? ref.laneId : UNNAMED_PLAN_LANE_LABEL;
  }
  let planStatus: BoardPlanStatus = isPlan ? 'not-imported' : 'no-plan';
  let tier: 0 | 1 | 2 | null = null;
  let scope: string | null = null;
  let packages: readonly string[] = [];
  let planOrder = Number.POSITIVE_INFINITY;

  if (isPlan) {
    const plan = facts.plans.find((p) => p.projectId === ref.projectId && p.planId === ref.planId);
    if (plan) {
      const lane = plan.lanes.find((l) => l.laneId === ref.laneId || l.aliases.includes(ref.laneId));
      if (lane) {
        planStatus = lane.status;
        tier = lane.tier;
        scope = lane.scope;
        packages = lane.packages;
        label = lane.laneId;
        planOrder = plan.lanes.indexOf(lane);
      }
    }
  } else {
    const wo = facts.workOrders.find((w) => w.id === ref.workOrderId);
    label = wo && isPlainText(wo.laneId) ? wo.laneId : ref.workOrderId;
  }

  return {
    key: formatLaneRef(ref),
    ref,
    label,
    projectId: ref.projectId,
    planId: isPlan ? ref.planId : null,
    planStatus,
    tier,
    scope,
    packages,
    workOrderIds: [],
    started: false,
    done: null,
    waitingOn: [],
    placement: 'queued',
    notRead: [],
    planOrder,
    links: [],
    attempts: [],
    runs: [],
    declarations: [],
    pullRequests: [],
    step: null,
    stepText: null,
    seat: null,
    round: null,
    reviewCounts: null,
    badges: [],
  };
}

function compareMerge(a: BoardMergeFact, b: BoardMergeFact): number {
  const byTime = compareIsoDesc(a.mergedAtIso, b.mergedAtIso);
  if (byTime !== 0) return byTime;
  return a.number - b.number;
}

function latestMergeForLinks(links: readonly BoardPullRequestLinkFact[], merges: readonly BoardMergeFact[]): BoardMergeFact | null {
  let best: BoardMergeFact | null = null;
  for (const link of links) {
    for (const merge of merges) {
      if (merge.repository !== link.repository || merge.number !== link.number) continue;
      if (best === null || compareMerge(merge, best) > 0) best = merge;
    }
  }
  return best;
}

function doneOf(links: readonly BoardPullRequestLinkFact[], woIds: readonly string[], facts: BoardFacts): BoardDoneFact | null {
  const merge = latestMergeForLinks(links, facts.merges);
  if (merge) {
    return {
      via: 'merge-record',
      repository: merge.repository,
      number: merge.number,
      headSha: merge.headSha,
      mergedAtIso: merge.mergedAtIso,
      firstSeenAtIso: merge.firstSeenAtIso,
      merger: merge.merger,
    };
  }
  let latestWo: BoardWorkOrderFact | null = null;
  for (const id of woIds) {
    const wo = facts.workOrders.find((w) => w.id === id);
    if (!wo || wo.state !== 'merged') continue;
    if (latestWo === null || compareIsoDesc(wo.updatedAtIso, latestWo.updatedAtIso) > 0) latestWo = wo;
  }
  if (latestWo) {
    return { via: 'work-order', workOrderId: latestWo.id, recordedAtIso: latestWo.updatedAtIso };
  }
  return null;
}

function buildCards(facts: BoardFacts): Card[] {
  const refs: LaneRef[] = [];
  const pushRef = (ref: LaneRef): void => {
    // Dedup by the card key's identity: `wo:<workOrderId>` has no project, so
    // two work-order refs for the same id from different projects are one card.
    const key = formatLaneRef(ref);
    if (!refs.some((r) => formatLaneRef(r) === key)) refs.push(ref);
  };

  for (const plan of facts.plans) {
    for (const lane of plan.lanes) {
      pushRef({ kind: 'plan', projectId: plan.projectId, planId: plan.planId, laneId: lane.laneId });
    }
  }

  const woRef = new Map<string, LaneRef>();
  for (const wo of facts.workOrders) {
    const ref = resolveWorkOrderLaneRef(wo, facts.plans);
    woRef.set(wo.id, ref);
    pushRef(ref);
  }

  for (const link of facts.links) pushRef(resolveLaneRef(link.lane, facts));
  for (const conflict of facts.linkConflicts) {
    pushRef(resolveLaneRef(conflict.linkedLane, facts));
    pushRef(resolveLaneRef(conflict.refusedLane, facts));
  }
  for (const declaration of facts.declarations) pushRef(resolveLaneRef(declaration.lane, facts));
  for (const run of facts.runs) {
    const ref = woRef.get(run.workOrderId);
    if (ref) pushRef(ref);
  }
  for (const attempt of facts.attempts) {
    const ref = woRef.get(attempt.workOrderId);
    if (ref) pushRef(ref);
  }

  const cards = refs.map((ref) => makeCard(ref, facts));

  const woIdsByKey = new Map<string, string[]>();
  const linksByKey = new Map<string, BoardPullRequestLinkFact[]>();
  const declarationsByKey = new Map<string, BoardDeclarationFact[]>();
  const runsByKey = new Map<string, BoardRunFact[]>();
  const attemptsByKey = new Map<string, BoardAttemptFact[]>();
  const addTo = <T>(map: Map<string, T[]>, key: string, value: T): void => {
    const list = map.get(key);
    if (list) list.push(value);
    else map.set(key, [value]);
  };

  for (const [woId, ref] of woRef) addTo(woIdsByKey, formatLaneRef(ref), woId);
  for (const link of facts.links) addTo(linksByKey, formatLaneRef(resolveLaneRef(link.lane, facts)), link);
  for (const declaration of facts.declarations) addTo(declarationsByKey, formatLaneRef(resolveLaneRef(declaration.lane, facts)), declaration);
  for (const run of facts.runs) {
    const ref = woRef.get(run.workOrderId);
    if (ref) addTo(runsByKey, formatLaneRef(ref), run);
  }
  for (const attempt of facts.attempts) {
    const ref = woRef.get(attempt.workOrderId);
    if (ref) addTo(attemptsByKey, formatLaneRef(ref), attempt);
  }

  for (const card of cards) {
    const woIds = woIdsByKey.get(card.key) ?? [];
    card.workOrderIds = woIds.slice().sort(stringAsc);
    const links = linksByKey.get(card.key) ?? [];
    const attempts = attemptsByKey.get(card.key) ?? [];
    const runs = runsByKey.get(card.key) ?? [];
    const declarations = declarationsByKey.get(card.key) ?? [];
    card.links = links;
    card.attempts = attempts;
    card.runs = runs;
    card.declarations = declarations;
    card.started = attempts.length > 0 || runs.length > 0 || declarations.length > 0 || links.length > 0;
    card.done = doneOf(links, woIds, facts);
  }

  return cards;
}

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

function draftForItem(item: BoardOwnerItemFact, cardByKey: Map<string, Card>, facts: BoardFacts): EntryDraft {
  const gating = (BOARD_GATING_OWNER_ITEM_KINDS as readonly BoardOwnerItemKind[]).includes(item.kind);
  const names = new Set<string>();
  const gates = new Set<string>();
  const addLane = (ref: LaneRef, fromBlock: boolean): void => {
    const key = formatLaneRef(resolveLaneRef(ref, facts));
    if (!cardByKey.has(key)) return;
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

function draftForQuestion(question: BoardQuestionFact, cardByKey: Map<string, Card>, facts: BoardFacts): EntryDraft {
  const names = new Set<string>();
  const gates = new Set<string>();
  const addLane = (ref: LaneRef): void => {
    const key = formatLaneRef(resolveLaneRef(ref, facts));
    if (!cardByKey.has(key)) return;
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

function buildEntries(facts: BoardFacts, cardByKey: Map<string, Card>): EntryDraft[] {
  const referenced = new Set<string>();
  for (const item of facts.ownerItems) {
    for (const ref of item.refs) {
      if (ref.kind === 'question') referenced.add(ref.id);
    }
  }

  const drafts: EntryDraft[] = [];
  const seen = new Set<string>();
  for (const item of facts.ownerItems) {
    if (seen.has(item.itemId)) continue;
    seen.add(item.itemId);
    if (item.state !== 'open') continue;
    drafts.push(draftForItem(item, cardByKey, facts));
  }
  for (const question of facts.questions) {
    if (referenced.has(question.questionId)) continue;
    if (isClosedQuestion(question)) continue;
    drafts.push(draftForQuestion(question, cardByKey, facts));
  }
  return drafts;
}

function finalizeEntry(draft: EntryDraft, cardByKey: Map<string, Card>): BoardOwnerEntry {
  const gatesLanes = [...draft.gatesLanes]
    .filter((key) => {
      const card = cardByKey.get(key);
      return card !== undefined && card.done === null;
    })
    .sort(stringAsc);
  const namesLanes = [...draft.namesLanes].sort(stringAsc);
  const questionIds = [...draft.questionIds].sort(stringAsc);
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

function reasonKindOf(entry: BoardOwnerEntry): 'merge' | 'decision' | 'secret' {
  if (entry.kind === 'merge' || entry.kind === 'secret') return entry.kind;
  return 'decision';
}

function collectReasons(entries: readonly BoardOwnerEntry[]): Map<string, BoardOwnerReason[]> {
  const byKey = new Map<string, BoardOwnerReason[]>();
  for (const entry of entries) {
    for (const key of entry.gatesLanes) {
      const reasons = byKey.get(key) ?? [];
      reasons.push({
        origin: entry.origin,
        id: entry.id,
        kind: reasonKindOf(entry),
        subject: entry.subject,
        sinceIso: entry.sinceIso,
      });
      byKey.set(key, reasons);
    }
  }
  for (const reasons of byKey.values()) {
    reasons.sort((a, b) => {
      const bySince = compareIsoAsc(a.sinceIso, b.sinceIso);
      if (bySince !== 0) return bySince;
      return a.id.localeCompare(b.id);
    });
  }
  return byKey;
}

function placementOf(card: Card, reasons: readonly BoardOwnerReason[]): BoardPlacement {
  if (card.done) return 'done';
  if (reasons.length > 0) return 'waiting';
  if (card.started) return 'in-flight';
  if (card.planStatus === 'dropped') return 'dropped';
  if (card.planStatus === 'deferred') return 'deferred';
  return 'queued';
}

const CARD_NOT_READ: Record<BoardPlacement, readonly BoardSource[]> = {
  done: [],
  waiting: ['work-orders', 'pr-links', 'merge-records'],
  'in-flight': ['work-orders', 'pr-links', 'merge-records', 'owner-items', 'questions'],
  queued: ['plans', 'work-orders', 'attempts', 'runs', 'declarations', 'pr-links', 'merge-records', 'owner-items', 'questions'],
  dropped: ['plans', 'work-orders', 'attempts', 'runs', 'declarations', 'pr-links', 'merge-records', 'owner-items', 'questions'],
  deferred: ['plans', 'work-orders', 'attempts', 'runs', 'declarations', 'pr-links', 'merge-records', 'owner-items', 'questions'],
};

const COLUMN_NOT_READ: {
  done: readonly BoardSource[];
  waiting: readonly BoardSource[];
  inFlight: readonly BoardSource[];
  queued: readonly BoardSource[];
} = {
  done: ['work-orders', 'pr-links', 'merge-records'],
  waiting: ['owner-items', 'questions'],
  inFlight: ['work-orders', 'attempts', 'runs', 'declarations', 'pr-links'],
  queued: ['plans'],
};

function notReadFor(sources: readonly BoardSource[], readings: readonly SourceReading[]): SourceReading[] {
  return readings.filter((r) => r.status === 'not-read' && sources.includes(r.source));
}

/** Rule S8: a card's not-read readings, extended with its linked PRs' forge readings and, In flight, review-evidence. */
function cardNotRead(card: Card, readings: readonly SourceReading[]): SourceReading[] {
  const bases = CARD_NOT_READ[card.placement];
  const repos = new Set(card.links.map((link) => link.repository));
  const inFlight = card.placement === 'in-flight';
  return readings.filter((reading) => {
    if (reading.status !== 'not-read') return false;
    if (bases.includes(reading.source)) return true;
    if (reading.source === 'forge-observation' && reading.repository !== null && repos.has(reading.repository)) return true;
    if (inFlight && reading.source === 'review-evidence') return true;
    return false;
  });
}

function gatherReadings(facts: BoardFacts, forgeRepos: readonly string[] = []): SourceReading[] {
  const readings: SourceReading[] = [];
  for (const source of BOARD_SOURCES) {
    if (source === 'forge-observation') {
      const forge = facts.sources.filter((r) => r.source === source);
      const byRepo = new Map<string, SourceReading>();
      for (const reading of forge) byRepo.set(reading.repository ?? '', reading);
      for (const repository of forgeRepos) {
        if (!byRepo.has(repository)) {
          byRepo.set(repository, { source, repository, readAtIso: null, status: 'not-read' });
        }
      }
      if (byRepo.size === 0) {
        readings.push({ source, repository: null, readAtIso: null, status: 'not-read' });
      } else {
        const sorted = [...byRepo.values()].sort((a, b) => (a.repository ?? '').localeCompare(b.repository ?? ''));
        readings.push(...sorted);
      }
    } else {
      const reading = facts.sources.find((r) => r.source === source);
      if (reading) readings.push(reading);
      else readings.push({ source, repository: null, readAtIso: null, status: 'not-read' });
    }
  }
  return readings;
}

function toLane(card: Card): BoardLaneCard {
  return {
    key: card.key,
    ref: card.ref,
    label: card.label,
    projectId: card.projectId,
    planId: card.planId,
    planStatus: card.planStatus,
    tier: card.tier,
    scope: card.scope,
    packages: card.packages,
    workOrderIds: card.workOrderIds,
    started: card.started,
    placement: card.placement,
    done: card.done,
    waitingOn: card.waitingOn,
    notRead: card.notRead,
    step: card.step,
    stepText: card.stepText,
    seat: card.seat,
    round: card.round,
    pullRequests: card.pullRequests,
    reviewCounts: card.reviewCounts,
    badges: card.badges,
  };
}

interface DoneRow {
  entry: BoardDoneEntry;
  time: number;
  sortKey: string;
}

function buildDoneColumn(
  cards: readonly Card[],
  facts: BoardFacts,
  cutoffMs: number,
  readings: readonly SourceReading[],
): { entries: BoardDoneEntry[]; hiddenByWindow: number; notRead: SourceReading[] } {
  const rows: DoneRow[] = [];
  let hiddenByWindow = 0;
  for (const card of cards) {
    if (card.placement !== 'done') continue;
    const done = card.done;
    if (!done) continue;
    const time = done.via === 'merge-record' ? done.mergedAtIso : done.recordedAtIso;
    const ms = parseTimeMs(time);
    if (ms !== null && ms < cutoffMs) {
      hiddenByWindow += 1;
    } else {
      rows.push({ entry: { kind: 'lane', key: card.key }, time: ms ?? Number.NEGATIVE_INFINITY, sortKey: card.key });
    }
  }

  const projectsByRepo = [...facts.projects].sort((a, b) => a.projectId.localeCompare(b.projectId));
  const linked = new Set<string>();
  for (const link of facts.links) linked.add(link.repository + '#' + String(link.number));
  for (const merge of facts.merges) {
    const key = merge.repository + '#' + String(merge.number);
    if (linked.has(key)) continue;
    const project = projectsByRepo.find((p) => p.repository === merge.repository);
    const integrityBadges: BoardBadge[] = facts.mergeIntegrity
      .filter((f) => f.repository === merge.repository && f.number === merge.number)
      .map((f): Extract<BoardBadge, { kind: 'merge-integrity' }> => ({ kind: 'merge-integrity', repository: f.repository, number: f.number, readAtIso: f.readAtIso }))
      .sort((a, b) => a.readAtIso.localeCompare(b.readAtIso));
    const entry: BoardDoneEntry = {
      kind: 'unlinked-merge',
      repository: merge.repository,
      number: merge.number,
      projectId: project ? project.projectId : null,
      headSha: merge.headSha,
      mergedAtIso: merge.mergedAtIso,
      firstSeenAtIso: merge.firstSeenAtIso,
      merger: merge.merger,
      badges: integrityBadges,
    };
    const ms = parseTimeMs(merge.mergedAtIso);
    if (ms !== null && ms < cutoffMs) {
      hiddenByWindow += 1;
    } else {
      rows.push({ entry, time: ms ?? Number.NEGATIVE_INFINITY, sortKey: key });
    }
  }

  rows.sort((a, b) => {
    if (a.time !== b.time) return a.time > b.time ? -1 : 1;
    return a.sortKey.localeCompare(b.sortKey);
  });

  return {
    entries: rows.map((r) => r.entry),
    hiddenByWindow,
    notRead: notReadFor(COLUMN_NOT_READ.done, readings),
  };
}

interface WaitingRow {
  kind: 'lane' | 'owner';
  key: string;
  origin: 'owner-item' | 'question';
  id: string;
  since: number;
  kindRank: number;
}

function buildWaitingColumn(
  cards: readonly Card[],
  entries: readonly BoardOwnerEntry[],
  readings: readonly SourceReading[],
): { entries: BoardWaitingEntry[]; notRead: SourceReading[] } {
  const rows: WaitingRow[] = [];
  for (const card of cards) {
    if (card.placement !== 'waiting') continue;
    const since = card.waitingOn.length > 0 ? timeMsOrNegInf(card.waitingOn[0].sinceIso) : Number.NEGATIVE_INFINITY;
    rows.push({ kind: 'lane', key: card.key, origin: 'owner-item', id: card.key, since, kindRank: 0 });
  }
  for (const entry of entries) {
    if (entry.placement !== 'own-card') continue;
    rows.push({ kind: 'owner', key: entry.id, origin: entry.origin, id: entry.id, since: timeMsOrNegInf(entry.sinceIso), kindRank: 1 });
  }
  rows.sort((a, b) => {
    if (a.since !== b.since) return a.since < b.since ? -1 : 1;
    if (a.kindRank !== b.kindRank) return a.kindRank - b.kindRank;
    return a.key.localeCompare(b.key);
  });
  const entriesOut: BoardWaitingEntry[] = rows.map((row) =>
    row.kind === 'lane' ? { kind: 'lane', key: row.key } : { kind: 'owner', origin: row.origin, id: row.id },
  );
  return { entries: entriesOut, notRead: notReadFor(COLUMN_NOT_READ.waiting, readings) };
}

function queuedKeys(cards: readonly Card[]): string[] {
  const queued = cards.filter((c) => c.placement === 'queued');
  queued.sort((a, b) => {
    const aPlan = a.planId !== null;
    const bPlan = b.planId !== null;
    if (aPlan !== bPlan) return aPlan ? -1 : 1;
    if (aPlan) {
      const byProject = a.projectId.localeCompare(b.projectId);
      if (byProject !== 0) return byProject;
      const byPlan = (a.planId as string).localeCompare(b.planId as string);
      if (byPlan !== 0) return byPlan;
      const byOrder = a.planOrder - b.planOrder;
      if (byOrder !== 0) return byOrder;
    }
    return a.key.localeCompare(b.key);
  });
  return queued.map((c) => c.key);
}

function entryOrderCompare(a: BoardOwnerEntry, b: BoardOwnerEntry): number {
  const bySince = compareIsoAsc(a.sinceIso, b.sinceIso);
  if (bySince !== 0) return bySince;
  return a.id.localeCompare(b.id);
}

function computeBoard(facts: BoardFacts, readAtIso: string, sinceIso: string | null, policy: BoardPolicy): WorkBoard {
  const cards = buildCards(facts);
  const cardByKey = new Map(cards.map((c) => [c.key, c]));

  const forgeRepos: string[] = [];
  {
    const seen = new Set<string>();
    for (const card of cards) {
      for (const link of card.links) {
        if (!seen.has(link.repository)) {
          seen.add(link.repository);
          forgeRepos.push(link.repository);
        }
      }
    }
  }
  const readings = gatherReadings(facts, forgeRepos);

  const drafts = buildEntries(facts, cardByKey);
  const entries = drafts.map((d) => finalizeEntry(d, cardByKey));
  const reasonsByKey = collectReasons(entries);

  const conflictLikes: BoardLinkConflictLike[] = facts.linkConflicts.map((conflict) => ({
    repository: conflict.repository,
    number: conflict.number,
    linkedLane: formatLaneRef(resolveLaneRef(conflict.linkedLane, facts)),
    refusedLane: formatLaneRef(resolveLaneRef(conflict.refusedLane, facts)),
    recordedAtIso: conflict.recordedAtIso,
  }));

  for (const card of cards) {
    card.waitingOn = reasonsByKey.get(card.key) ?? [];
    card.placement = placementOf(card, card.waitingOn);
  }

  for (const card of cards) {
    card.pullRequests = lanePullRequests(card.links, facts, readAtIso, policy);
    card.step = laneStep({
      placement: card.placement,
      dropped: card.planStatus === 'dropped',
      runs: card.runs,
      attempts: card.attempts,
      declarations: card.declarations,
      pullRequests: card.pullRequests,
      nowIso: readAtIso,
      policy,
    });
    card.stepText = card.step === null ? null : boardStepText(card.step);
    card.seat = laneSeat({
      placement: card.placement,
      step: card.step,
      runs: card.runs,
      attempts: card.attempts,
      declarations: card.declarations,
    });
    card.round = laneRound({ placement: card.placement, runs: card.runs, attempts: card.attempts });
    card.reviewCounts = laneReviewCounts(card.placement === 'in-flight', card.attempts, facts.reviewCounts, readings);
    card.badges = laneBadges({
      key: card.key,
      planStatus: card.planStatus,
      step: card.step,
      pullRequests: card.pullRequests,
      runs: card.runs,
      attempts: card.attempts,
      declarations: card.declarations,
      ownerEntries: entries,
      waitingOnIds: card.waitingOn.map((reason) => reason.id),
      linkConflicts: conflictLikes,
      mergeIntegrity: facts.mergeIntegrity,
      nowIso: readAtIso,
      policy,
    });
    card.notRead = cardNotRead(card, readings);
  }

  const lanes = cards.map(toLane).sort((a, b) => a.key.localeCompare(b.key));

  const cutoffMs = sinceIso === null ? parseTimeMs(readAtIso)! - policy.doneWindowDays * 86400000 : parseTimeMs(sinceIso)!;
  const doneCutoffIso = sinceIso ?? new Date(cutoffMs).toISOString();

  const done = buildDoneColumn(cards, facts, cutoffMs, readings);
  const waiting = buildWaitingColumn(cards, entries, readings);
  const inFlight = {
    keys: cards.filter((c) => c.placement === 'in-flight').map((c) => c.key).sort(stringAsc),
    notRead: notReadFor(COLUMN_NOT_READ.inFlight, readings),
  };
  const queued = {
    keys: queuedKeys(cards),
    notRead: notReadFor(COLUMN_NOT_READ.queued, readings),
  };

  entries.sort(entryOrderCompare);

  return {
    schemaVersion: WORK_BOARD_SCHEMA_VERSION,
    readAtIso,
    policy,
    doneCutoffIso,
    sources: readings,
    complete: readings.every((r) => r.status === 'read'),
    lanes,
    columns: {
      done,
      waiting,
      inFlight,
      queued,
    },
    ownerItems: entries,
  };
}
