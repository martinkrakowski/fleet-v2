/**
 * The in-flight step, PR status and badges of one lane (work-board plan §3.1,
 * §3.4, §3.5, §3.7): pure, never throws, time enters only as `nowIso`.
 */

import { resolveLaneRunBaseBranch } from './base-branch.js';
import type { BaseBranchValue } from './base-branch.js';
import { parseTimeMs } from './work-board-facts.js';
import { isPlainText } from './work-board.js';
import type {
  BoardAttemptFact,
  BoardDeclarationFact,
  BoardDeclarationStep,
  BoardFacts,
  BoardForgeObservationFact,
  BoardForgePullRequestFact,
  BoardMergeIntegrityFact,
  BoardOwnerItemKind,
  BoardPolicy,
  BoardPullRequestLinkFact,
  BoardReviewCountsFact,
  BoardRunFact,
  BoardCiState,
  SourceReading,
} from './work-board-facts.js';
import type { AttemptStateValue } from './value-objects/AttemptState.vo.js';
import type { LaneRunStateValue } from './value-objects/LaneRunState.vo.js';
import type { StopReasonValue } from './value-objects/StopReason.vo.js';

type LaneRunParkReason = NonNullable<BoardRunFact['parkReason']>;

/** The fixed text for a time that does not parse; never the raw input. */
const UNREADABLE_TIME = 'an unreadable time';
/** The fixed text for a seat model that is not plain text; null means "not recorded". */
const UNNAMED_SEAT = 'Unnamed seat';
/** The fixed text for a seat role that is not plain text; null means "not recorded". */
const UNKNOWN_ROLE = 'unknown role';

/** A displayed time: the input ISO instant re-rendered from its parsed milliseconds, never the input string. */
function renderTime(iso: string): string {
  const ms = parseTimeMs(iso);
  return ms === null ? UNREADABLE_TIME : new Date(ms).toISOString();
}

/** A displayed seat role: the plain-text rule, or the fixed text; null stays null ("not recorded"). */
function renderedSeatRole(role: string | null): string | null {
  if (role === null) return null;
  return isPlainText(role) ? role : UNKNOWN_ROLE;
}

/** A displayed seat model: the plain-text rule, or the fixed text; null stays null ("not recorded"). */
function renderedSeatModel(model: string | null): string | null {
  if (model === null) return null;
  return isPlainText(model) ? model : UNNAMED_SEAT;
}

export type BoardPrState = 'open' | 'closed' | 'merged' | 'not-observed' | 'not-read';

export interface BoardPrStatus {
  readonly repository: string;
  readonly number: number;
  readonly state: BoardPrState;
  /** 'merge-record': the final merge fact (no read time); 'forge-observation': a snapshot; 'none': not read. */
  readonly source: 'merge-record' | 'forge-observation' | 'none';
  readonly asOfIso: string | null;
  readonly ciState: BoardCiState | null;
  readonly title: string | null;
  /** Past forgeStaleMinutes since asOfIso (or asOfIso unparseable): "may have changed". Never for a merge record. */
  readonly stale: boolean;
}

export type BoardStep =
  | { readonly kind: 'run'; readonly runId: string; readonly state: LaneRunStateValue; readonly round: number;
      readonly parkReason: LaneRunParkReason | null; readonly baseBranch: BaseBranchValue }
  | { readonly kind: 'run-stopped'; readonly runId: string; readonly round: number; readonly baseBranch: BaseBranchValue }
  | { readonly kind: 'attempt-live'; readonly attemptId: string; readonly attemptKind: 'initial' | 'fix';
      readonly fixNumber: number; readonly state: AttemptStateValue }
  | { readonly kind: 'pr-closed-without-merge'; readonly pr: BoardPrStatus }
  | { readonly kind: 'between-steps'; readonly attemptId: string; readonly stopReason: StopReasonValue | null }
  | { readonly kind: 'pr-open'; readonly pr: BoardPrStatus }
  | { readonly kind: 'pr-merged-unrecorded'; readonly pr: BoardPrStatus }
  | { readonly kind: 'pr-merge-not-observed'; readonly pr: BoardPrStatus }
  | { readonly kind: 'declared'; readonly step: BoardDeclarationStep; readonly seatRole: string; readonly model: string;
      readonly declaredAtIso: string }
  | { readonly kind: 'declaration-lapsed'; readonly declaredAtIso: string }
  | { readonly kind: 'dropped-after-start'; readonly underlying: Exclude<BoardStep, { kind: 'dropped-after-start' }> };

export interface BoardSeat {
  readonly role: string | null;      // a SeatPlanRole, or a declaration's seat role
  readonly model: string | null;
  readonly source: 'run' | 'attempt' | 'declaration';
}

export const BOARD_BADGE_KINDS = [
  'attempt-running', 'run', 'owner-item-not-recorded', 'pr', 'owner-item', 'link-conflict',
  'merge-integrity', 'declaration', 'plan-lane-not-imported',
] as const;

export type BoardBadge =
  | { readonly kind: 'attempt-running'; readonly attemptId: string; readonly seatRole: string | null;
      readonly model: string | null; readonly state: AttemptStateValue }
  | { readonly kind: 'run'; readonly runId: string; readonly state: LaneRunStateValue; readonly round: number;
      readonly parkReason: LaneRunParkReason | null; readonly baseBranch: BaseBranchValue }
  | { readonly kind: 'owner-item-not-recorded'; readonly runId: string }
  | { readonly kind: 'pr'; readonly pr: BoardPrStatus }
  | { readonly kind: 'owner-item'; readonly origin: 'owner-item' | 'question'; readonly id: string;
      readonly itemKind: BoardOwnerItemKind; readonly gating: boolean }
  | { readonly kind: 'link-conflict'; readonly repository: string; readonly number: number;
      readonly linkedLane: string; readonly refusedLane: string; readonly recordedAtIso: string }
  | { readonly kind: 'merge-integrity'; readonly repository: string; readonly number: number; readonly readAtIso: string }
  | { readonly kind: 'declaration'; readonly step: BoardDeclarationStep; readonly declaredAtIso: string; readonly lapsed: boolean }
  | { readonly kind: 'plan-lane-not-imported' };

export interface BoardReviewCounts {
  readonly headSha: string;
  readonly blocker: number;
  readonly major: number;
  readonly minor: number;
  readonly nit: number;
  readonly readAtIso: string;
}

const LIVE_ATTEMPT_STATES: ReadonlySet<AttemptStateValue> = new Set([
  'intent-recorded',
  'dispatching',
  'running',
  'reconciling',
]);

function timeMsOrNegInf(iso: string): number {
  return parseTimeMs(iso) ?? Number.NEGATIVE_INFINITY;
}

function compareIsoDesc(a: string, b: string): number {
  const ta = timeMsOrNegInf(a);
  const tb = timeMsOrNegInf(b);
  if (ta === tb) return 0;
  return ta > tb ? 1 : -1;
}

function isStale(asOfIso: string, nowIso: string, policy: BoardPolicy): boolean {
  const asOfMs = parseTimeMs(asOfIso);
  if (asOfMs === null) return true;
  const nowMs = parseTimeMs(nowIso);
  if (nowMs === null) return true;
  return nowMs - asOfMs > policy.forgeStaleMinutes * 60000;
}

function latestRun(runs: readonly BoardRunFact[]): BoardRunFact | null {
  let best: BoardRunFact | null = null;
  for (const run of runs) {
    if (best === null) {
      best = run;
      continue;
    }
    const cmp = compareIsoDesc(run.updatedAtIso, best.updatedAtIso);
    if (cmp > 0 || (cmp === 0 && run.runId > best.runId)) best = run;
  }
  return best;
}

function latestAttempt(attempts: readonly BoardAttemptFact[]): BoardAttemptFact | null {
  let best: BoardAttemptFact | null = null;
  for (const attempt of attempts) {
    if (best === null) {
      best = attempt;
      continue;
    }
    const cmp = compareIsoDesc(attempt.createdAtIso, best.createdAtIso);
    if (cmp > 0 || (cmp === 0 && attempt.id > best.id)) best = attempt;
  }
  return best;
}

function latestDeclaration(declarations: readonly BoardDeclarationFact[]): BoardDeclarationFact | null {
  let best: BoardDeclarationFact | null = null;
  for (const declaration of declarations) {
    if (best === null) {
      best = declaration;
      continue;
    }
    if (compareIsoDesc(declaration.declaredAtIso, best.declaredAtIso) > 0) best = declaration;
  }
  return best;
}

function forgeStateToBoard(state: BoardForgePullRequestFact['state']): BoardPrState {
  if (state === 'open') return 'open';
  if (state === 'merged') return 'merged';
  return 'closed';
}

/** S1: a linked PR's status with its read time and staleness. */
export function pullRequestStatus(repository: string, number: number, facts: BoardFacts, nowIso: string, policy: BoardPolicy, readings: readonly SourceReading[] = facts.sources): BoardPrStatus {
  const merge = facts.merges.find((m) => m.repository === repository && m.number === number);
  if (merge) {
    return { repository, number, state: 'merged', source: 'merge-record', asOfIso: null, ciState: null, title: null, stale: false };
  }

  const reading = readings.find((r) => r.source === 'forge-observation' && r.repository === repository);
  if (!reading || reading.status !== 'read') {
    return { repository, number, state: 'not-read', source: 'none', asOfIso: null, ciState: null, title: null, stale: false };
  }

  let observation: BoardForgeObservationFact | null = null;
  for (const obs of facts.forgeObservations) {
    if (obs.repository !== repository || obs.outcome !== 'read') continue;
    if (observation === null || compareIsoDesc(obs.readAtIso, observation.readAtIso) > 0) observation = obs;
  }
  if (observation === null) {
    return { repository, number, state: 'not-read', source: 'none', asOfIso: null, ciState: null, title: null, stale: false };
  }

  const listed = observation.pullRequests.find((p) => p.number === number);
  if (listed === undefined) {
    return {
      repository,
      number,
      state: 'not-observed',
      source: 'forge-observation',
      asOfIso: observation.readAtIso,
      ciState: null,
      title: null,
      stale: isStale(observation.readAtIso, nowIso, policy),
    };
  }

  return {
    repository,
    number,
    state: forgeStateToBoard(listed.state),
    source: 'forge-observation',
    asOfIso: observation.readAtIso,
    ciState: listed.ciState,
    title: listed.title,
    stale: isStale(observation.readAtIso, nowIso, policy),
  };
}

/** S2: a declaration lapses after declarationTtlMinutes, or when its time does not parse. */
export function isDeclarationLapsed(declaredAtIso: string, nowIso: string, policy: BoardPolicy): boolean {
  const declaredMs = parseTimeMs(declaredAtIso);
  if (declaredMs === null) return true;
  const nowMs = parseTimeMs(nowIso);
  if (nowMs === null) return true;
  return nowMs - declaredMs > policy.declarationTtlMinutes * 60000;
}

function highestPr(pullRequests: readonly BoardPrStatus[], state: BoardPrState, extra?: (pr: BoardPrStatus) => boolean): BoardPrStatus | null {
  let best: BoardPrStatus | null = null;
  for (const pr of pullRequests) {
    if (pr.state !== state) continue;
    if (extra !== undefined && !extra(pr)) continue;
    if (best === null || pr.number > best.number) best = pr;
  }
  return best;
}

function highestUnobservedPr(pullRequests: readonly BoardPrStatus[]): BoardPrStatus | null {
  let best: BoardPrStatus | null = null;
  for (const pr of pullRequests) {
    if (pr.state !== 'not-observed' && pr.state !== 'not-read') continue;
    if (best === null || pr.number > best.number) best = pr;
  }
  return best;
}

type RawBoardStep = Exclude<BoardStep, { kind: 'dropped-after-start' }>;

function stepFromRun(run: BoardRunFact): RawBoardStep {
  const baseBranch = resolveLaneRunBaseBranch(run);
  if (run.state === 'stopped') {
    return { kind: 'run-stopped', runId: run.runId, round: run.round, baseBranch };
  }
  return { kind: 'run', runId: run.runId, state: run.state, round: run.round, parkReason: run.parkReason, baseBranch };
}

function stepFromEndedOrLive(attempt: BoardAttemptFact, pullRequests: readonly BoardPrStatus[]): RawBoardStep {
  if (LIVE_ATTEMPT_STATES.has(attempt.state)) {
    return {
      kind: 'attempt-live',
      attemptId: attempt.id,
      attemptKind: attempt.kind,
      fixNumber: attempt.fixNumber,
      state: attempt.state,
    };
  }
  const openPr = highestPr(pullRequests, 'open');
  if (openPr !== null) return { kind: 'pr-open', pr: openPr };
  const closedPr = highestPr(pullRequests, 'closed');
  if (closedPr !== null) return { kind: 'pr-closed-without-merge', pr: closedPr };
  return { kind: 'between-steps', attemptId: attempt.id, stopReason: attempt.stopReason };
}

function stepFromLinks(pullRequests: readonly BoardPrStatus[]): RawBoardStep | null {
  const openPr = highestPr(pullRequests, 'open');
  if (openPr !== null) return { kind: 'pr-open', pr: openPr };
  const mergedPr = highestPr(pullRequests, 'merged', (pr) => pr.source !== 'merge-record');
  if (mergedPr !== null) return { kind: 'pr-merged-unrecorded', pr: mergedPr };
  const closedPr = highestPr(pullRequests, 'closed');
  if (closedPr !== null) return { kind: 'pr-closed-without-merge', pr: closedPr };
  const unobservedPr = highestUnobservedPr(pullRequests);
  if (unobservedPr !== null) return { kind: 'pr-merge-not-observed', pr: unobservedPr };
  return null;
}

function stepFromDeclaration(declaration: BoardDeclarationFact, nowIso: string, policy: BoardPolicy): RawBoardStep {
  if (isDeclarationLapsed(declaration.declaredAtIso, nowIso, policy)) {
    return { kind: 'declaration-lapsed', declaredAtIso: declaration.declaredAtIso };
  }
  return {
    kind: 'declared',
    step: declaration.step,
    seatRole: renderedSeatRole(declaration.seatRole) ?? UNKNOWN_ROLE,
    model: renderedSeatModel(declaration.model) ?? UNNAMED_SEAT,
    declaredAtIso: declaration.declaredAtIso,
  };
}

export type BoardPlacementLike = 'done' | 'waiting' | 'in-flight' | 'queued' | 'dropped' | 'deferred';

export interface BoardLaneStepInput {
  readonly placement: BoardPlacementLike;
  readonly dropped: boolean;
  readonly runs: readonly BoardRunFact[];
  readonly attempts: readonly BoardAttemptFact[];
  readonly declarations: readonly BoardDeclarationFact[];
  readonly pullRequests: readonly BoardPrStatus[];
  readonly nowIso: string;
  readonly policy: BoardPolicy;
}

/** S3: the in-flight step of one lane, in the plan's order; null for every other placement. */
export function laneStep(input: BoardLaneStepInput): BoardStep | null {
  if (input.placement !== 'in-flight') return null;
  const run = latestRun(input.runs);
  let step: RawBoardStep | null;
  if (run !== null) {
    step = stepFromRun(run);
  } else if (input.attempts.length > 0) {
    step = stepFromEndedOrLive(latestAttempt(input.attempts) as BoardAttemptFact, input.pullRequests);
  } else if (input.pullRequests.length > 0) {
    step = stepFromLinks(input.pullRequests);
  } else {
    const declaration = latestDeclaration(input.declarations);
    step = declaration === null ? null : stepFromDeclaration(declaration, input.nowIso, input.policy);
  }
  if (step === null) return null;
  if (input.dropped) return { kind: 'dropped-after-start', underlying: step };
  return step;
}

function prStepText(pr: BoardPrStatus, verb: string, suffix: string): string {
  let text = 'PR #' + String(pr.number) + ' ' + verb + (pr.asOfIso === null ? '' : renderTime(pr.asOfIso));
  if (suffix !== '') text += suffix;
  if (pr.stale) text += '; may have changed';
  return text;
}

function ciSuffix(pr: BoardPrStatus): string {
  return pr.ciState === null ? '' : ', CI ' + pr.ciState;
}

/** S4: the one-line text of a step; plain text, ISO times. */
export function boardStepText(step: BoardStep): string {
  switch (step.kind) {
    case 'run': {
      if (step.state === 'parked') return 'parked: ' + (step.parkReason ?? 'unknown') + ' on ' + step.baseBranch;
      return step.state + ', round ' + String(step.round) + ' on ' + step.baseBranch;
    }
    case 'run-stopped':
      return 'run stopped, not merged on ' + step.baseBranch;
    case 'attempt-live':
      if (step.attemptKind === 'initial') return 'first pass ' + step.state;
      return 'fix round ' + String(step.fixNumber) + ' ' + step.state;
    case 'pr-closed-without-merge':
      return prStepText(step.pr, 'closed without merge as of ', '');
    case 'between-steps':
      return 'between steps';
    case 'pr-open':
      return prStepText(step.pr, 'open as of ', ciSuffix(step.pr));
    case 'pr-merged-unrecorded':
      return prStepText(step.pr, 'merged as of ', '; merge not yet recorded');
    case 'pr-merge-not-observed': {
      let text = 'linked PR #' + String(step.pr.number) + ': merge not yet observed';
      if (step.pr.stale) text += '; may have changed';
      return text;
    }
    case 'declared':
      return 'declared, not observed: ' + step.step + ' as of ' + renderTime(step.declaredAtIso);
    case 'declaration-lapsed':
      return 'state unknown (declaration lapsed)';
    case 'dropped-after-start':
      return 'dropped in plan; started work not merged (' + boardStepText(step.underlying) + ')';
  }
}

export interface BoardLaneSeatInput {
  readonly placement: BoardPlacementLike;
  readonly step: BoardStep | null;
  readonly runs: readonly BoardRunFact[];
  readonly attempts: readonly BoardAttemptFact[];
  readonly declarations: readonly BoardDeclarationFact[];
}

/** S5: the seat of a lane from its latest run, attempt or declaration; null when not in flight. */
export function laneSeat(input: BoardLaneSeatInput): BoardSeat | null {
  if (input.placement !== 'in-flight') return null;
  const step = input.step;
  const underlying = step !== null && step.kind === 'dropped-after-start' ? step.underlying : step;
  if (underlying !== null && (underlying.kind === 'run' || underlying.kind === 'run-stopped')) {
    const run = latestRun(input.runs);
    if (run !== null) return { role: renderedSeatRole(run.seatRole), model: renderedSeatModel(run.model), source: 'run' };
  }
  const attempt = latestAttempt(input.attempts);
  if (attempt !== null) return { role: renderedSeatRole(attempt.seatRole), model: renderedSeatModel(attempt.model), source: 'attempt' };
  const declaration = latestDeclaration(input.declarations);
  if (declaration !== null) return { role: renderedSeatRole(declaration.seatRole), model: renderedSeatModel(declaration.model), source: 'declaration' };
  return null;
}

/** S5: the round of a lane: the latest run's round, else the latest attempt's fix number. */
export function laneRound(input: {
  readonly placement: BoardPlacementLike;
  readonly runs: readonly BoardRunFact[];
  readonly attempts: readonly BoardAttemptFact[];
}): number | null {
  if (input.placement !== 'in-flight') return null;
  const run = latestRun(input.runs);
  if (run !== null) return run.round;
  const attempt = latestAttempt(input.attempts);
  if (attempt !== null) return attempt.fixNumber;
  return null;
}

/** S6: S1 for every linked PR of the lane, number descending. */
export function lanePullRequests(links: readonly BoardPullRequestLinkFact[], facts: BoardFacts, nowIso: string, policy: BoardPolicy, readings: readonly SourceReading[] = facts.sources): BoardPrStatus[] {
  const seen = new Set<string>();
  const out: BoardPrStatus[] = [];
  for (const link of links) {
    const key = link.repository + '#' + String(link.number);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(pullRequestStatus(link.repository, link.number, facts, nowIso, policy, readings));
  }
  out.sort((a, b) => {
    if (a.number !== b.number) return b.number - a.number;
    return a.repository.localeCompare(b.repository);
  });
  return out;
}

function latestAttemptWithHead(attempts: readonly BoardAttemptFact[]): BoardAttemptFact | null {
  let best: BoardAttemptFact | null = null;
  for (const attempt of attempts) {
    if (attempt.headCommit === null) continue;
    if (best === null) {
      best = attempt;
      continue;
    }
    const cmp = compareIsoDesc(attempt.createdAtIso, best.createdAtIso);
    if (cmp > 0 || (cmp === 0 && attempt.id > best.id)) best = attempt;
  }
  return best;
}

/** S6: the latest review counts at the latest attempt's head; null when review-evidence was not read. */
export function laneReviewCounts(
  inFlight: boolean,
  attempts: readonly BoardAttemptFact[],
  counts: readonly BoardReviewCountsFact[],
  readings: readonly SourceReading[],
): BoardReviewCounts | null {
  if (!inFlight) return null;
  const evidence = readings.find((r) => r.source === 'review-evidence');
  if (evidence === undefined || evidence.status !== 'read') return null;
  const attempt = latestAttemptWithHead(attempts);
  if (attempt === null) return null;
  const head = attempt.headCommit as string;
  let best: BoardReviewCountsFact | null = null;
  for (const count of counts) {
    if (count.headSha !== head) continue;
    if (best === null || compareIsoDesc(count.readAtIso, best.readAtIso) > 0) best = count;
  }
  if (best === null) return null;
  return {
    headSha: best.headSha,
    blocker: best.blocker,
    major: best.major,
    minor: best.minor,
    nit: best.nit,
    readAtIso: best.readAtIso,
  };
}

export interface BoardOwnerEntryLike {
  readonly origin: 'owner-item' | 'question';
  readonly id: string;
  readonly kind: BoardOwnerItemKind;
  readonly gating: boolean;
  readonly gatesLanes: readonly string[];
  readonly namesLanes: readonly string[];
}

export interface BoardLinkConflictLike {
  readonly repository: string;
  readonly number: number;
  readonly linkedLane: string;
  readonly refusedLane: string;
  readonly recordedAtIso: string;
}

export interface BoardLaneBadgeInput {
  readonly key: string;
  readonly planStatus: string;
  readonly step: BoardStep | null;
  readonly pullRequests: readonly BoardPrStatus[];
  readonly runs: readonly BoardRunFact[];
  readonly attempts: readonly BoardAttemptFact[];
  readonly declarations: readonly BoardDeclarationFact[];
  readonly ownerEntries: readonly BoardOwnerEntryLike[];
  readonly waitingOnIds: readonly string[];
  readonly linkConflicts: readonly BoardLinkConflictLike[];
  readonly mergeIntegrity: readonly BoardMergeIntegrityFact[];
  readonly nowIso: string;
  readonly policy: BoardPolicy;
}

function latestLiveAttempt(attempts: readonly BoardAttemptFact[]): BoardAttemptFact | null {
  let best: BoardAttemptFact | null = null;
  for (const attempt of attempts) {
    if (!LIVE_ATTEMPT_STATES.has(attempt.state)) continue;
    if (best === null) {
      best = attempt;
      continue;
    }
    const cmp = compareIsoDesc(attempt.createdAtIso, best.createdAtIso);
    if (cmp > 0 || (cmp === 0 && attempt.id > best.id)) best = attempt;
  }
  return best;
}

function stepUsesAttempt(step: BoardStep | null, attemptId: string): boolean {
  return step !== null && step.kind === 'attempt-live' && step.attemptId === attemptId;
}

function pushAttemptRunning(out: BoardBadge[], input: BoardLaneBadgeInput): void {
  const attempt = latestLiveAttempt(input.attempts);
  if (attempt === null) return;
  if (stepUsesAttempt(input.step, attempt.id)) return;
  out.push({
    kind: 'attempt-running',
    attemptId: attempt.id,
    seatRole: renderedSeatRole(attempt.seatRole),
    model: renderedSeatModel(attempt.model),
    state: attempt.state,
  });
}

function stepUsesRun(step: BoardStep | null, runId: string): boolean {
  return step !== null && (step.kind === 'run' || step.kind === 'run-stopped') && step.runId === runId;
}

function pushRun(out: BoardBadge[], input: BoardLaneBadgeInput): void {
  const run = latestRun(input.runs);
  if (run === null) return;
  if (stepUsesRun(input.step, run.runId)) return;
  out.push({
    kind: 'run',
    runId: run.runId,
    state: run.state,
    round: run.round,
    parkReason: run.parkReason,
    baseBranch: resolveLaneRunBaseBranch(run),
  });
}

function pushOwnerItemNotRecorded(out: BoardBadge[], input: BoardLaneBadgeInput): void {
  const run = latestRun(input.runs);
  if (run === null) return;
  if (run.state !== 'parked' || run.parkReason !== 'owner-merge') return;
  const hasMergeEntry = input.ownerEntries.some(
    (entry) => entry.kind === 'merge' && entry.namesLanes.includes(input.key),
  );
  if (hasMergeEntry) return;
  out.push({ kind: 'owner-item-not-recorded', runId: run.runId });
}

function stepUsesPr(step: BoardStep | null, pr: BoardPrStatus): boolean {
  if (step === null) return false;
  if (
    step.kind === 'pr-open' ||
    step.kind === 'pr-closed-without-merge' ||
    step.kind === 'pr-merged-unrecorded' ||
    step.kind === 'pr-merge-not-observed'
  ) {
    return step.pr.repository === pr.repository && step.pr.number === pr.number;
  }
  return false;
}

function pushPr(out: BoardBadge[], input: BoardLaneBadgeInput): void {
  for (const pr of input.pullRequests) {
    if (stepUsesPr(input.step, pr)) continue;
    if (pr.state === 'merged' && pr.source === 'merge-record') continue;
    out.push({ kind: 'pr', pr });
  }
}

function pushOwnerItem(out: BoardBadge[], input: BoardLaneBadgeInput): void {
  const items: Extract<BoardBadge, { kind: 'owner-item' }>[] = [];
  for (const entry of input.ownerEntries) {
    if (!entry.namesLanes.includes(input.key)) continue;
    if (input.waitingOnIds.includes(entry.id)) continue;
    const gating = entry.gating && entry.gatesLanes.includes(input.key);
    items.push({ kind: 'owner-item', origin: entry.origin, id: entry.id, itemKind: entry.kind, gating });
  }
  items.sort((a, b) => a.id.localeCompare(b.id));
  out.push(...items);
}

function pushLinkConflict(out: BoardBadge[], input: BoardLaneBadgeInput): void {
  const items: Extract<BoardBadge, { kind: 'link-conflict' }>[] = [];
  for (const conflict of input.linkConflicts) {
    if (conflict.linkedLane !== input.key && conflict.refusedLane !== input.key) continue;
    items.push({
      kind: 'link-conflict',
      repository: conflict.repository,
      number: conflict.number,
      linkedLane: conflict.linkedLane,
      refusedLane: conflict.refusedLane,
      recordedAtIso: conflict.recordedAtIso,
    });
  }
  items.sort((a, b) => {
    if (a.repository !== b.repository) return a.repository.localeCompare(b.repository);
    return a.number - b.number;
  });
  out.push(...items);
}

function pushMergeIntegrity(out: BoardBadge[], input: BoardLaneBadgeInput): void {
  const linked = new Set(input.pullRequests.map((pr) => pr.repository + '#' + String(pr.number)));
  const items: Extract<BoardBadge, { kind: 'merge-integrity' }>[] = [];
  for (const fact of input.mergeIntegrity) {
    if (!linked.has(fact.repository + '#' + String(fact.number))) continue;
    items.push({ kind: 'merge-integrity', repository: fact.repository, number: fact.number, readAtIso: fact.readAtIso });
  }
  items.sort((a, b) => {
    if (a.repository !== b.repository) return a.repository.localeCompare(b.repository);
    if (a.number !== b.number) return a.number - b.number;
    return a.readAtIso.localeCompare(b.readAtIso);
  });
  out.push(...items);
}

function pushDeclaration(out: BoardBadge[], input: BoardLaneBadgeInput): void {
  const declaration = latestDeclaration(input.declarations);
  if (declaration === null) return;
  if (
    input.step !== null &&
    (input.step.kind === 'declared' || input.step.kind === 'declaration-lapsed') &&
    input.step.declaredAtIso === declaration.declaredAtIso
  ) {
    return;
  }
  out.push({
    kind: 'declaration',
    step: declaration.step,
    declaredAtIso: declaration.declaredAtIso,
    lapsed: isDeclarationLapsed(declaration.declaredAtIso, input.nowIso, input.policy),
  });
}

function pushPlanLaneNotImported(out: BoardBadge[], input: BoardLaneBadgeInput): void {
  if (input.planStatus === 'not-imported') out.push({ kind: 'plan-lane-not-imported' });
}

/** S7: badges for every fact the card's column and step did not use, in BOARD_BADGE_KINDS order. */
export function laneBadges(raw: BoardLaneBadgeInput): BoardBadge[] {
  // S7: the fact a step uses is never repeated as a badge, so a dropped lane's
  // step is unwrapped to the step it wraps before any badge is chosen.
  const step = raw.step !== null && raw.step.kind === 'dropped-after-start' ? raw.step.underlying : raw.step;
  const input: BoardLaneBadgeInput = { ...raw, step };
  const out: BoardBadge[] = [];
  pushAttemptRunning(out, input);
  pushRun(out, input);
  pushOwnerItemNotRecorded(out, input);
  pushPr(out, input);
  pushOwnerItem(out, input);
  pushLinkConflict(out, input);
  pushMergeIntegrity(out, input);
  pushDeclaration(out, input);
  pushPlanLaneNotImported(out, input);
  return out;
}
