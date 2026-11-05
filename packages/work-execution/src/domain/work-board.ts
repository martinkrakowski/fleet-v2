/**
 * The pure work-board read model (plan §3.1, §3.3, §3.4, §3.7).
 * One card per lane in exactly one column; never throws, never performs
 * anything; time enters only through `nowIso`; nothing is guessed from
 * text. Each rule id below names one test in
 * `__tests__/work-board.test.ts`.
 */

import {
  BOARD_SOURCES,
  DEFAULT_BOARD_POLICY,
  formatLaneRef,
  isPlainText,
  parseTimeMs,
  WORK_BOARD_SCHEMA_VERSION,
} from './work-board-facts.js';
import type {
  BoardAttemptFact,
  BoardDeclarationFact,
  BoardFacts,
  BoardMergeFact,
  BoardOptions,
  BoardPlanFact,
  BoardPlannedLaneFact,
  BoardPlannedLaneStatus,
  BoardPolicy,
  BoardPullRequestLinkFact,
  BoardRunFact,
  BoardSource,
  BoardWorkOrderFact,
  LaneRef,
  SourceReading,
} from './work-board-facts.js';
import { deriveOwnerEntries } from './owner-entries.js';
import type { BoardOwnerEntry } from './owner-entries.js';
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

/** Why a queued or waiting lane cannot start (work-board plan §3.6, plus `cycle-in-records`, WB2c). */
export type WaitReason =
  | 'after-not-done' | 'after-unresolved' | 'after-dropped'
  | 'package-occupied' | 'shared-file-held' | 'exclusive-order'
  | 'owner-decision' | 'project-lane-cap' | 'capacity' | 'seat' | 'brief'
  | 'cycle-in-records';

export type GuardState = 'blocked' | 'unknown' | 'clear';

export type BoardLaneColumn =
  | 'done' | 'in-flight' | 'queued' | 'waiting' | 'dropped' | 'deferred' | 'unresolved' | 'not-read';

/** The subject lane as the board sees it now (waits-for plan §3.1). */
export interface LaneGlance {
  readonly ref: LaneRef;
  readonly label: string;
  readonly column: BoardLaneColumn;
  readonly step?: string;
  readonly pr?: { readonly repository: string; readonly number: number; readonly state: 'open' | 'closed' | 'merged';
                  readonly asOfIso?: string; readonly stale: boolean };
  readonly declared?: { readonly atIso: string; readonly lapsed: boolean };
  readonly waitingOn?: { readonly itemId: string; readonly itemKind: 'merge' | 'decision' | 'secret'; readonly subject: string };
}

/** Exactly one subject per row (waits-for plan §3.1). */
export type WaitSubject =
  | { readonly kind: 'lane'; readonly lane: LaneGlance }
  | { readonly kind: 'package'; readonly name: string; readonly heldBy: LaneGlance | null }
  | { readonly kind: 'shared-file'; readonly path: string; readonly heldBy: LaneGlance }
  | { readonly kind: 'project-slots'; readonly projectId: string; readonly held: number; readonly cap: number }
  | { readonly kind: 'capacity'; readonly held: number; readonly budget: number }
  | { readonly kind: 'seat'; readonly role: string | null }
  | { readonly kind: 'brief'; readonly path: string; readonly sha256?: string; readonly readAtIso?: string; readonly lastFailedAtIso?: string }
  | { readonly kind: 'owner-item'; readonly itemId: string; readonly itemKind: 'merge' | 'decision' | 'secret';
      readonly subject: string; readonly sinceIso: string }
  | { readonly kind: 'plan-decision'; readonly projectId: string; readonly planId: string; readonly decisionId: string }
  | { readonly kind: 'plan'; readonly projectId: string; readonly planId: string }
  | { readonly kind: 'cycle'; readonly path: LaneRef[] };

/** What would change this row; its text is rendered once, in the domain. */
export type ClearedBy =
  | { readonly kind: 'done'; readonly subject: LaneRef }
  | { readonly kind: 'holder-ends'; readonly lane: LaneRef; readonly what: 'package' | 'shared-file' }
  | { readonly kind: 'owner'; readonly itemId: string }
  | { readonly kind: 'release'; readonly what: 'project-slot' | 'capacity' }
  | { readonly kind: 'record'; readonly what: 'seat-probe' | 'brief-read' | 'forge-sync' | 'plan-import' | 'declaration-renewal' }
  | { readonly kind: 'edit'; readonly what: 'after' | 'exclusive-order' }
  | { readonly kind: 'read'; readonly source: BoardSource }
  | { readonly kind: 'integrity'; readonly what: 'cycle' };

/** One row of `waitsOn` (waits-for plan §3.1). */
export interface WaitGuard {
  readonly reason: WaitReason;
  readonly state: GuardState;
  readonly subject: WaitSubject;
  readonly clearedBy: ClearedBy;
  readonly clearedByText: string;
  readonly sources: readonly SourceReading[];
  readonly unreadBeside: readonly BoardSource[];
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
  /** The wait guards, only for queued and waiting cards (WB2b); empty otherwise. */
  readonly waitsOn: readonly WaitGuard[];
  readonly waitCounts: { readonly blocked: number; readonly unknown: number; readonly clear: number };
  readonly firstBlocker: WaitGuard | null;
  readonly summary: string;
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
  waitsOn: WaitGuard[];
  waitCounts: { blocked: number; unknown: number; clear: number };
  firstBlocker: WaitGuard | null;
  summary: string;
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

/** The label of a plan-lane card whose lane id, matched to no imported lane, is not plain text. */
const UNNAMED_PLAN_LANE_LABEL = 'Unnamed plan lane';

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
    waitsOn: [],
    waitCounts: { blocked: 0, unknown: 0, clear: 0 },
    firstBlocker: null,
    summary: '',
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

// --- WB2b: the wait guards of the queued and waiting cards (work-board plan §3.6, §3.7; waits-for §3.1, §3.2). ---

const WAIT_REASON_ORDER: readonly WaitReason[] = [
  'after-not-done', 'after-unresolved', 'after-dropped',
  'package-occupied', 'shared-file-held', 'exclusive-order', 'owner-decision',
  'project-lane-cap', 'capacity', 'seat', 'brief', 'cycle-in-records',
];

function waitReasonRank(reason: WaitReason): number {
  const index = WAIT_REASON_ORDER.indexOf(reason);
  return index === -1 ? WAIT_REASON_ORDER.length : index;
}

function readingOf(readings: readonly SourceReading[], source: BoardSource, repository: string | null = null): SourceReading | null {
  return readings.find((r) => r.source === source && (r.repository ?? null) === repository) ?? null;
}

function unreadBesideOf(sources: readonly SourceReading[]): BoardSource[] {
  const names: BoardSource[] = [];
  for (const reading of sources) {
    if (reading.status === 'not-read' && !names.includes(reading.source)) names.push(reading.source);
  }
  return names;
}

function makeRow(
  reason: WaitReason,
  state: GuardState,
  subject: WaitSubject,
  clearedBy: ClearedBy,
  clearedByText: string,
  sources: readonly SourceReading[],
): WaitGuard {
  return { reason, state, subject, clearedBy, clearedByText, sources, unreadBeside: unreadBesideOf(sources) };
}

function latestDeclarationBadge(badges: readonly BoardBadge[]): Extract<BoardBadge, { kind: 'declaration' }> | null {
  let best: Extract<BoardBadge, { kind: 'declaration' }> | null = null;
  for (const badge of badges) {
    if (badge.kind !== 'declaration') continue;
    if (best === null || compareIsoDesc(badge.declaredAtIso, best.declaredAtIso) > 0) best = badge;
  }
  return best;
}

function glanceOf(card: Card): LaneGlance {
  const endedPr = card.pullRequests.find((pr): pr is BoardPrStatus & { state: 'open' | 'closed' | 'merged' } =>
    pr.state === 'open' || pr.state === 'closed' || pr.state === 'merged');
  const declaration = latestDeclarationBadge(card.badges);
  const waiting = card.waitingOn[0];
  return {
    ref: card.ref,
    label: card.label,
    column: card.placement,
    ...(card.stepText !== null ? { step: card.stepText } : {}),
    ...(endedPr === undefined ? {} : {
      pr: {
        repository: endedPr.repository,
        number: endedPr.number,
        state: endedPr.state,
        ...(endedPr.asOfIso === null ? {} : { asOfIso: endedPr.asOfIso }),
        stale: endedPr.stale,
      },
    }),
    ...(declaration === null ? {} : { declared: { atIso: declaration.declaredAtIso, lapsed: declaration.lapsed } }),
    ...(waiting === undefined ? {} : {
      waitingOn: { itemId: waiting.id, itemKind: waiting.kind, subject: waiting.subject ?? waiting.id },
    }),
  };
}

interface WaitsCardContext {
  readonly byKey: ReadonlyMap<string, Card>;
  readonly facts: BoardFacts;
  readonly readings: readonly SourceReading[];
}

function plannedLaneOf(card: Card, facts: BoardFacts): { readonly plan: BoardPlanFact; readonly lane: BoardPlannedLaneFact } | null {
  const ref = card.ref;
  if (card.planId === null || ref.kind !== 'plan') return null;
  const plan = facts.plans.find((p) => p.projectId === ref.projectId && p.planId === ref.planId);
  if (plan === undefined) return null;
  const lane = plan.lanes.find((l) => l.laneId === ref.laneId || l.aliases.includes(ref.laneId));
  if (lane === undefined) return null;
  return { plan, lane };
}

function plansSources(ctx: WaitsCardContext): SourceReading[] {
  const reading = readingOf(ctx.readings, 'plans');
  return reading === null ? [] : [reading];
}

function forgeUnreadSuffix(forgeReadings: readonly SourceReading[]): string {
  const unread = forgeReadings.find((r) => r.status !== 'read');
  if (unread === undefined) return '';
  return unread.readAtIso === null ? '; forge not read' : '; forge not read since ' + unread.readAtIso;
}

/** The clearedByText of a done-predecessor row; the forge suffix belongs on blocked rows only. */
function clearedTextForDone(glance: LaneGlance, forgeReadings: readonly SourceReading[]): string {
  const suffix = forgeUnreadSuffix(forgeReadings);
  if (suffix !== '') return glance.label + ' is done' + suffix;
  return glance.label + ' is done (merged, or recorded done without a PR)';
}

function mergeAndWorkOrderSources(ctx: WaitsCardContext, predecessorCard: Card | undefined): SourceReading[] {
  const sources: SourceReading[] = [];
  const merges = readingOf(ctx.readings, 'merge-records');
  const workOrders = readingOf(ctx.readings, 'work-orders');
  if (merges !== null) sources.push(merges);
  if (workOrders !== null) sources.push(workOrders);
  const repositories = new Set((predecessorCard?.links ?? []).map((link) => link.repository));
  for (const repository of repositories) {
    const forge = readingOf(ctx.readings, 'forge-observation', repository);
    if (forge !== null) sources.push(forge);
  }
  return sources;
}

/**
 * One row for one not-done predecessor (reason `after-not-done` or
 * `exclusive-order`): clear when it is done, unknown when a deciding store
 * was not read and nothing read blocks, blocked otherwise (§3.7).
 */
function notDoneRow(
  reason: 'after-not-done' | 'exclusive-order',
  glance: LaneGlance,
  predecessorRef: LaneRef,
  ctx: WaitsCardContext,
  predecessorCard: Card | undefined,
  withForge: boolean,
): WaitGuard {
  const sources = mergeAndWorkOrderSources(ctx, withForge ? predecessorCard : undefined);
  const merges = readingOf(ctx.readings, 'merge-records');
  const workOrders = readingOf(ctx.readings, 'work-orders');
  const forgeReadings = withForge
    ? sources.filter((r) => r.source === 'forge-observation')
    : [];
  if (predecessorCard !== undefined && predecessorCard.done !== null) {
    return makeRow(reason, 'clear', { kind: 'lane', lane: glance }, { kind: 'done', subject: predecessorRef },
      clearedTextForDone(glance, []), sources);
  }
  if (merges === null || merges.status !== 'read' || workOrders === null || workOrders.status !== 'read') {
    return makeRow(reason, 'unknown', { kind: 'lane', lane: glance }, { kind: 'done', subject: predecessorRef },
      'reading merge records and work orders would decide it', sources);
  }
  return makeRow(reason, 'blocked', { kind: 'lane', lane: glance }, { kind: 'done', subject: predecessorRef },
    clearedTextForDone(glance, forgeReadings), sources);
}

function afterDroppedRow(glance: LaneGlance, ctx: WaitsCardContext): WaitGuard {
  return makeRow('after-dropped', 'blocked', { kind: 'lane', lane: glance }, { kind: 'edit', what: 'after' },
    "edit this lane's after and re-import the plan", plansSources(ctx));
}

function afterRowsFor(lane: BoardPlannedLaneFact, ctx: WaitsCardContext): WaitGuard[] {
  const rows: WaitGuard[] = [];
  for (const entry of lane.after) {
    const predecessorPlan = ctx.facts.plans.find((p) => p.projectId === entry.projectId && p.planId === entry.planId);
    const predecessorLane = predecessorPlan?.lanes.find(
      (l) => l.laneId === entry.laneId || l.aliases.includes(entry.laneId),
    );
    if (predecessorPlan === undefined || predecessorLane === undefined) {
      rows.push(makeRow('after-unresolved', 'blocked',
        { kind: 'plan', projectId: entry.projectId, planId: entry.planId },
        { kind: 'record', what: 'plan-import' },
        'import plan ' + entry.planId + ' for project ' + entry.projectId,
        plansSources(ctx)));
      continue;
    }
    const predecessorRef: LaneRef = { kind: 'plan', projectId: entry.projectId, planId: entry.planId, laneId: predecessorLane.laneId };
    const predecessorCard = ctx.byKey.get(formatLaneRef(predecessorRef));
    const glance: LaneGlance = predecessorCard === undefined
      ? { ref: predecessorRef, label: predecessorLane.laneId, column: 'unresolved' }
      : glanceOf(predecessorCard);
    if (predecessorCard !== undefined && predecessorCard.done !== null) {
      rows.push(notDoneRow('after-not-done', glance, predecessorRef, ctx, predecessorCard, true));
      continue;
    }
    if (predecessorLane.status === 'dropped') {
      rows.push(afterDroppedRow(glance, ctx));
      continue;
    }
    rows.push(notDoneRow('after-not-done', glance, predecessorRef, ctx, predecessorCard, true));
  }
  return rows;
}

function exclusiveOrderRowsFor(plan: BoardPlanFact, lane: BoardPlannedLaneFact, ctx: WaitsCardContext): WaitGuard[] {
  const rows: WaitGuard[] = [];
  for (const entry of plan.exclusiveOrder) {
    const selfIndex = entry.lanes.findIndex((id) => id === lane.laneId || lane.aliases.includes(id));
    if (selfIndex <= 0) continue;
    for (const earlierId of entry.lanes.slice(0, selfIndex)) {
      const earlierLane = plan.lanes.find((l) => l.laneId === earlierId || l.aliases.includes(earlierId));
      if (earlierLane === undefined) continue;
      const earlierRef: LaneRef = { kind: 'plan', projectId: plan.projectId, planId: plan.planId, laneId: earlierLane.laneId };
      const earlierCard = ctx.byKey.get(formatLaneRef(earlierRef));
      const glance: LaneGlance = earlierCard === undefined
        ? { ref: earlierRef, label: earlierLane.laneId, column: 'unresolved' }
        : glanceOf(earlierCard);
      if (earlierCard !== undefined && earlierCard.done !== null) {
        rows.push(notDoneRow('exclusive-order', glance, earlierRef, ctx, earlierCard, false));
        continue;
      }
      if (earlierLane.status === 'dropped') {
        rows.push(afterDroppedRow(glance, ctx));
        continue;
      }
      rows.push(notDoneRow('exclusive-order', glance, earlierRef, ctx, earlierCard, false));
    }
  }
  return rows;
}

function ownerItemRowsFor(card: Card, ctx: WaitsCardContext): WaitGuard[] {
  const sources: SourceReading[] = [];
  for (const source of ['owner-items', 'questions'] as const) {
    const reading = readingOf(ctx.readings, source);
    if (reading !== null) sources.push(reading);
  }
  return card.waitingOn.map((reason) => {
    const subjectText = reason.subject ?? reason.id;
    let clearedByText: string;
    if (reason.kind === 'merge') {
      const item = ctx.facts.ownerItems.find((i) => i.itemId === reason.id);
      const prRef = item?.refs.find((ref) => ref.kind === 'pr');
      clearedByText = prRef !== undefined ? 'owner merges PR #' + String(prRef.number) : 'owner merges ' + subjectText;
    } else if (reason.kind === 'secret') {
      clearedByText = 'owner records the secret';
    } else {
      clearedByText = 'owner decides ' + subjectText;
    }
    return makeRow('owner-decision', 'blocked',
      { kind: 'owner-item', itemId: reason.id, itemKind: reason.kind, subject: subjectText, sinceIso: reason.sinceIso },
      { kind: 'owner', itemId: reason.id }, clearedByText, sources);
  });
}

function planDecisionRowsFor(plan: BoardPlanFact, lane: BoardPlannedLaneFact, ctx: WaitsCardContext): WaitGuard[] {
  const rows: WaitGuard[] = [];
  const sources = plansSources(ctx);
  for (const decisionId of lane.decisions) {
    const decision = plan.decisions.find((d) => d.id === decisionId);
    if (decision === undefined || decision.state !== 'open') continue;
    rows.push(makeRow('owner-decision', 'blocked',
      { kind: 'plan-decision', projectId: plan.projectId, planId: plan.planId, decisionId },
      { kind: 'record', what: 'plan-import' }, 'owner decides ' + decisionId, sources));
  }
  return rows;
}

function seatRow(): WaitGuard {
  return makeRow('seat', 'unknown', { kind: 'seat', role: null }, { kind: 'record', what: 'seat-probe' },
    'a seat probe is recorded (none exists yet; A-S or S1)', []);
}

/** The per-row name used by the summary line (waits-for plan §3.2). */
function nameOf(row: WaitGuard, facts: BoardFacts): string {
  const subject = row.subject;
  switch (row.reason) {
    case 'after-not-done':
    case 'exclusive-order': {
      if (subject.kind !== 'lane') return row.reason;
      let text = 'after ' + subject.lane.label + ' (' + subject.lane.column + ')';
      if (subject.lane.step !== undefined) text += ', ' + subject.lane.step;
      return text;
    }
    case 'after-unresolved':
      return subject.kind === 'plan'
        ? 'after ' + subject.projectId + '/' + subject.planId + ': predecessor plan not imported'
        : row.reason;
    case 'after-dropped':
      return subject.kind === 'lane' ? 'after ' + subject.lane.label + ': predecessor dropped' : row.reason;
    case 'owner-decision': {
      if (subject.kind === 'owner-item') {
        if (subject.itemKind === 'merge') {
          const item = facts.ownerItems.find((i) => i.itemId === subject.itemId);
          const prRef = item?.refs.find((ref) => ref.kind === 'pr');
          return prRef !== undefined ? 'merge PR #' + String(prRef.number) : 'merge ' + subject.subject;
        }
        if (subject.itemKind === 'secret') return 'secret ' + subject.subject;
        return 'decision ' + subject.subject;
      }
      return subject.kind === 'plan-decision' ? 'decision ' + subject.decisionId : row.reason;
    }
    case 'seat':
      return 'seat not checked';
    default:
      return row.reason;
  }
}

/** Names joined by "; "; three or more blocked rows name the first two and then "and n more". */
function nameList(rows: readonly WaitGuard[], facts: BoardFacts): string {
  const names = rows.map((row) => nameOf(row, facts));
  if (names.length >= 3) {
    return names[0] + '; ' + names[1] + ' and ' + String(names.length - 2) + ' more';
  }
  return names.join('; ');
}

function renderSummary(card: Card, rows: readonly WaitGuard[], facts: BoardFacts): string {
  const blocked = rows.filter((row) => row.state === 'blocked');
  const unknown = rows.filter((row) => row.state === 'unknown');
  const ownerRows = blocked.filter((row): row is WaitGuard & { subject: Extract<WaitSubject, { kind: 'owner-item' }> } =>
    row.reason === 'owner-decision' && row.subject.kind === 'owner-item');
  if (card.placement === 'waiting' && ownerRows.length > 0) {
    const parts = ownerRows.map((row) => nameOf(row, facts) + ' (since ' + row.subject.sinceIso + ')');
    let text = 'Waiting on you: ' + parts.join(', ') + '.';
    const ownerSet: ReadonlySet<WaitGuard> = new Set(ownerRows);
    const others = blocked.filter((row) => !ownerSet.has(row));
    if (others.length > 0) text += ' Also blocked by ' + String(others.length) + ': ' + nameList(others, facts) + '.';
    return text;
  }
  if (blocked.length > 0) {
    let text = 'Blocked by ' + String(blocked.length) + ': ' + nameList(blocked, facts) + '.';
    if (unknown.length > 0) {
      text += ' Unknown ' + String(unknown.length) + ': ' + unknown.map((row) => nameOf(row, facts)).join('; ') + '.';
    }
    return text;
  }
  if (unknown.length > 0) {
    return 'Nothing blocks it but unchecked guards: ' + unknown.map((row) => nameOf(row, facts)).join('; ') + '.';
  }
  return 'Nothing blocks it but unchecked guards.';
}

interface CardWaits {
  readonly rows: readonly WaitGuard[];
  readonly counts: { readonly blocked: number; readonly unknown: number; readonly clear: number };
  readonly firstBlocker: WaitGuard | null;
  readonly summary: string;
}

/**
 * The wait guards of one card (WB2b, part 1): the guards that need only the
 * card graph, the owner entries and the plan facts. Pure; never throws.
 */
function computeWaits(card: Card, ctx: WaitsCardContext): CardWaits {
  if (card.placement !== 'queued' && card.placement !== 'waiting') {
    return { rows: [], counts: { blocked: 0, unknown: 0, clear: 0 }, firstBlocker: null, summary: '' };
  }
  const planned = plannedLaneOf(card, ctx.facts);
  const itemRows = ownerItemRowsFor(card, ctx);
  const dependencyRows = planned === null ? [] : [
    ...afterRowsFor(planned.lane, ctx),
    ...exclusiveOrderRowsFor(planned.plan, planned.lane, ctx),
  ];
  const decisionRows = planned === null ? [] : planDecisionRowsFor(planned.plan, planned.lane, ctx);
  const byState = (state: GuardState): WaitGuard[] =>
    [...dependencyRows, ...decisionRows, seatRow()]
      .filter((row) => row.state === state)
      .sort((a, b) => waitReasonRank(a.reason) - waitReasonRank(b.reason));
  // Rule 1: on a Waiting lane the gating owner items come first, in item creation order.
  const rows = [...itemRows, ...byState('blocked'), ...byState('unknown'), ...byState('clear')];
  const counts = { blocked: 0, unknown: 0, clear: 0 };
  for (const row of rows) counts[row.state] += 1;
  const firstBlocker = rows[0] !== undefined && rows[0].state === 'blocked' ? rows[0] : null;
  return { rows, counts, firstBlocker, summary: renderSummary(card, rows, ctx.facts) };
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
    waitsOn: card.waitsOn,
    waitCounts: card.waitCounts,
    firstBlocker: card.firstBlocker,
    summary: card.summary,
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

  const entries: BoardOwnerEntry[] = [...deriveOwnerEntries(
    facts.ownerItems,
    facts.questions,
    cards.map((c) => ({ key: c.key, done: c.done !== null })),
    (ref) => formatLaneRef(resolveLaneRef(ref, facts)),
  )];
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
    card.pullRequests = lanePullRequests(card.links, facts, readAtIso, policy, readings);
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

  // WB2b: the wait guards need every card fully built (predecessor glances read placement and step).
  const cardsByKey = new Map(cards.map((card) => [card.key, card] as const));
  const waitsContext: WaitsCardContext = { byKey: cardsByKey, facts, readings };
  for (const card of cards) {
    const waits = computeWaits(card, waitsContext);
    card.waitsOn = [...waits.rows];
    card.waitCounts = waits.counts;
    card.firstBlocker = waits.firstBlocker;
    card.summary = waits.summary;
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
