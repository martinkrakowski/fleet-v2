/**
 * The pure zombie classifier (plan §3.9.2, §3.10.1–§3.10.6; unit K10 with KW1
 * folded in). Given one observation per (subject, kind) the gatherer read
 * through the ports, the open findings the store already holds and the
 * resolved reaper policy, it returns, per subject and kind, one finding and
 * what the reaper may do with it this pass: `report | repair | wait`.
 * It never throws and never performs anything, exactly like
 * `nextLaneRunAction`: no I/O, no clock — time enters only through `nowIso`.
 */

import { REAPER_SUBJECT_ID_PATTERN } from './lane-run-keys.js';
import type { ReaperFindingKind } from './lane-run-keys.js';

/**
 * A subject that is not an identifier but a credential-shaped string (a token
 * pasted where an id belongs). The broad printable-ASCII subject pattern cannot
 * tell them apart, so the classifier rejects these shapes explicitly: a secret
 * never reaches a finding.
 */
const SECRET_SHAPED_SUBJECT_PATTERN =
  /^(?:gh[pousr]_[A-Za-z0-9]+|github_pat_[A-Za-z0-9_]+|glpat-[A-Za-z0-9_-]+|sk-(?:ant-)?[A-Za-z0-9_-]+|xox[bpas]-[A-Za-z0-9-]+|AKIA[0-9A-Z]{16}|npm_[A-Za-z0-9]+)$/;

/** The stored finding record's schema version (D6, D-R8): the first version, 1. */
export const REAPER_FINDING_SCHEMA_VERSION = 1;

/** What the reaper may do with one finding this pass. */
export type ReaperFindingAction = 'report' | 'repair' | 'wait';

/** One finding about one subject: kind, subject, first and last sighting, sightings. */
export interface ReaperFinding {
  readonly schemaVersion: number;
  readonly kind: ReaperFindingKind;
  readonly subject: string;
  readonly action: ReaperFindingAction;
  readonly firstSightingIso: string;
  readonly lastSightingIso: string;
  readonly sightings: number;
}

/** A tri-state fact of §3.10.2. `unknown` is never true. */
export type ReaperFact = 'yes' | 'no' | 'unknown';

/** The `evidence` fact of §3.10.2. */
export type ReaperMergeEvidence = 'merged-pr' | 'ancestor-only' | 'unknown';

/** The eleven facts of §3.10.2's table. */
export interface MergedWorktreeFacts {
  readonly headOnDefault: ReaperFact;
  readonly evidence: ReaperMergeEvidence;
  readonly clean: ReaperFact;
  readonly unlocked: ReaperFact;
  readonly onBranch: ReaperFact;
  readonly notBusy: ReaperFact;
  readonly noLiveRecord: ReaperFact;
  readonly runnerIdle: ReaperFact;
  readonly noYoungIntent: ReaperFact;
  readonly quiet: ReaperFact;
  readonly notPrimary: ReaperFact;
}

/** One observation of one kind about one subject; every member carries the shared grace fact. */
export type ReaperObservation =
  | { readonly kind: 'orphan-session'; readonly subject: string; readonly youngActivity: boolean;
      readonly attemptsTerminalOrAbsent: boolean; readonly commitsNotOnRemote: boolean }
  | { readonly kind: 'dead-attempt'; readonly subject: string; readonly youngActivity: boolean;
      readonly recordSaysRunning: boolean; readonly sessionEndedOrMissing: boolean }
  | { readonly kind: 'driverless-run'; readonly subject: string; readonly youngActivity: boolean;
      readonly nonTerminalRun: boolean; readonly runLeaseLapsed: boolean; readonly driverLeaseHeld: boolean }
  | { readonly kind: 'leaked-slot'; readonly subject: string; readonly youngActivity: boolean;
      readonly attemptState: 'ended' | 'collected' | 'cancelled' | 'absent' | 'live' }
  | { readonly kind: 'stale-stop'; readonly subject: string; readonly youngActivity: boolean;
      readonly stopUnconfirmedParkedAtIso: string | null; readonly stopRetriesSpent: boolean }
  | { readonly kind: 'orphan-worktree'; readonly subject: string; readonly youngActivity: boolean;
      readonly noLiveRecord: boolean; readonly branchPrMerged: boolean }
  | { readonly kind: 'stale-attention'; readonly subject: string; readonly youngActivity: boolean;
      readonly attentionOpen: boolean; readonly questionUnanswered: boolean; readonly runTerminal: boolean }
  | { readonly kind: 'merged-worktree'; readonly subject: string; readonly youngActivity: boolean;
      readonly facts: MergedWorktreeFacts }
  | { readonly kind: 'disk-pressure'; readonly subject: string; readonly youngActivity: boolean;
      readonly freePercent: number | null };

/** The policy the classifier reads (`policy.conductor.reaper`, §3.9.2 and §3.10.4). Already resolved. */
export interface ReaperPolicy {
  /** `policy.conductor.reaper.graceMinutes` (D13). Default 5. */
  readonly graceMinutes?: number;
  /** `policy.conductor.reaper.staleStopMinutes`. Default 30. */
  readonly staleStopMinutes?: number;
  /** `policy.conductor.reaper.repairs` (D14): one flag per kind; absent or false = report-only. */
  readonly repairs?: Readonly<Partial<Record<ReaperFindingKind, boolean>>>;
  /** `policy.conductor.reaper.disk.minFreePercent` (§3.10.4). Default 15. */
  readonly minFreePercent?: number;
}

export interface ReaperFacts {
  /** One observation per (subject, kind). */
  readonly observations: readonly ReaperObservation[];
  /** The open findings the store holds: the sightings of the previous passes. */
  readonly openFindings: readonly ReaperFinding[];
}

/** The default `graceMinutes` (D13), read when the policy's value is missing, non-finite or negative. */
const DEFAULT_GRACE_MINUTES = 5;
/** The default `staleStopMinutes`, read when the policy's value is missing, non-finite or negative. */
const DEFAULT_STALE_STOP_MINUTES = 30;
/** The default `minFreePercent` (§3.10.4), read when the policy's value is missing, non-finite or negative. */
const DEFAULT_MIN_FREE_PERCENT = 15;

/** Milliseconds of one policy minute. */
const MINUTE_MS = 60_000;

/** `Date.parse` that never throws: an unparsable or non-string time reads as null (the gap is not elapsed). */
function msOf(iso: unknown): number | null {
  if (typeof iso !== 'string') {
    return null;
  }
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

/** A policy minute count: a missing, non-finite or negative value reads as the default. */
function minutesOf(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return fallback;
  }
  return value;
}

/** Whether a policy flag opts one kind's repair in (D14); a missing flag is off. */
function repairEnabled(repairs: ReaperPolicy['repairs'], kind: ReaperFindingKind): boolean {
  if (repairs === undefined || repairs === null || typeof repairs !== 'object') {
    return false;
  }
  return repairs[kind] === true;
}

/** Every `MergedWorktreeFacts` fact except `evidence` is strictly `'yes'`; `unknown` is never true. */
function everyMergedFactYes(facts: MergedWorktreeFacts): boolean {
  return facts.headOnDefault === 'yes' && facts.clean === 'yes' && facts.unlocked === 'yes' &&
    facts.onBranch === 'yes' && facts.notBusy === 'yes' && facts.noLiveRecord === 'yes' &&
    facts.runnerIdle === 'yes' && facts.noYoungIntent === 'yes' && facts.quiet === 'yes' &&
    facts.notPrimary === 'yes';
}

/** Whether a disk-pressure observation's `freePercent` reads as a finite number. */
function finiteFreePercent(freePercent: unknown): freePercent is number {
  return typeof freePercent === 'number' && Number.isFinite(freePercent);
}

/** The kind's own "seen when" and "repair only when" columns (§3.9.2, §3.10.1–§3.10.6). Total; never throws. */
function kindVerdict(
  observation: ReaperObservation,
  staleStopMinutes: number,
  minFreePercent: number,
  now: number | null,
  repairOn: boolean,
): { readonly seen: boolean; readonly repairEligible: boolean } {
  switch (observation.kind) {
    case 'orphan-session': {
      const seen = observation.attemptsTerminalOrAbsent === true;
      const repairEligible = repairOn && observation.commitsNotOnRemote === false;
      return { seen, repairEligible };
    }
    case 'dead-attempt': {
      const seen = observation.recordSaysRunning === true && observation.sessionEndedOrMissing === true;
      return { seen, repairEligible: repairOn };
    }
    case 'driverless-run': {
      const seen =
        observation.nonTerminalRun === true &&
        observation.runLeaseLapsed === true &&
        observation.driverLeaseHeld === false;
      return { seen, repairEligible: false };
    }
    case 'leaked-slot': {
      const state = observation.attemptState;
      const seen = state === 'ended' || state === 'collected' || state === 'cancelled' || state === 'absent';
      const repairEligible = repairOn && state !== 'absent';
      return { seen, repairEligible };
    }
    case 'stale-stop': {
      if (observation.stopRetriesSpent === true) {
        return { seen: true, repairEligible: repairOn };
      }
      const parkedAt = msOf(observation.stopUnconfirmedParkedAtIso);
      const seen = parkedAt !== null && now !== null && now - parkedAt >= staleStopMinutes * MINUTE_MS;
      return { seen, repairEligible: repairOn };
    }
    case 'orphan-worktree': {
      const seen = observation.noLiveRecord === true || observation.branchPrMerged === true;
      return { seen, repairEligible: false };
    }
    case 'stale-attention': {
      const seen =
        (observation.attentionOpen === true || observation.questionUnanswered === true) &&
        observation.runTerminal === true;
      const repairEligible = repairOn && observation.attentionOpen === true && observation.questionUnanswered !== true;
      return { seen, repairEligible };
    }
    case 'merged-worktree': {
      const facts = observation.facts;
      const seen = facts !== null && typeof facts === 'object' && facts.evidence !== 'unknown' && everyMergedFactYes(facts);
      const repairEligible = repairOn && seen && facts.evidence === 'merged-pr';
      return { seen, repairEligible };
    }
    case 'disk-pressure': {
      const seen = finiteFreePercent(observation.freePercent) && observation.freePercent < minFreePercent;
      return { seen, repairEligible: false };
    }
    default:
      return { seen: false, repairEligible: false };
  }
}

/**
 * The one classification of this pass (§3.9.2): per observation at most one
 * finding, in the observations' order. A finding exists only when the kind's
 * "seen when" column holds; its action is `wait` on young activity or until
 * the two-sightings-and-grace rule passes, then `repair` when the kind's
 * repair column holds, otherwise `report`. A subject that qualifies as
 * `merged-worktree` is reported under that kind only (KW1 precedence).
 * Never throws.
 */
export function classifyZombies(
  facts: ReaperFacts,
  nowIso: string,
  reaperPolicy: ReaperPolicy,
): readonly ReaperFinding[] {
  try {
    const observations =
      facts !== null && typeof facts === 'object' && Array.isArray(facts.observations) ? facts.observations : [];
    const openFindings =
      facts !== null && typeof facts === 'object' && Array.isArray(facts.openFindings) ? facts.openFindings : [];
    const policy = reaperPolicy === null || typeof reaperPolicy !== 'object' ? {} : reaperPolicy;
    const graceMinutes = minutesOf(policy.graceMinutes, DEFAULT_GRACE_MINUTES);
    const staleStopMinutes = minutesOf(policy.staleStopMinutes, DEFAULT_STALE_STOP_MINUTES);
    const minFreePercent = minutesOf(policy.minFreePercent, DEFAULT_MIN_FREE_PERCENT);
    const graceMs = graceMinutes * MINUTE_MS;
    const now = msOf(nowIso);
    const computed: ReaperFinding[] = [];
    const mergedSubjects = new Set<string>();

    for (const observation of observations) {
      if (observation === null || typeof observation !== 'object') {
        continue;
      }
      const kind = observation.kind;
      const subject = observation.subject;
      if (typeof subject !== 'string' || !REAPER_SUBJECT_ID_PATTERN.test(subject)
        || SECRET_SHAPED_SUBJECT_PATTERN.test(subject)) {
        continue;
      }
      const verdict = kindVerdict(observation, staleStopMinutes, minFreePercent, now, repairEnabled(policy.repairs, kind));
      if (!verdict.seen) {
        continue;
      }

      // Sighting bookkeeping: the prior open finding of the same (kind, subject).
      let prior: ReaperFinding | null = null;
      for (const open of openFindings) {
        if (open !== null && typeof open === 'object' && open.kind === kind && open.subject === subject) {
          prior = open;
          break;
        }
      }
      const firstSightingIso = prior === null ? nowIso : prior.firstSightingIso;
      const sightings = prior === null ? 1 : prior.sightings + 1;
      const previousSightingMs = prior === null ? null : msOf(prior.lastSightingIso);

      // Young activity (§3.9.2): the reaper never acts inside the grace.
      const young = observation.youngActivity === true;
      // Two sightings and the grace: a first sighting is always `wait`; a
      // finding acts only when seen on two passes at least G apart.
      const gapElapsed = previousSightingMs !== null && now !== null && now - previousSightingMs >= graceMs;
      const acts = prior !== null && sightings >= 2 && gapElapsed;
      const action: ReaperFindingAction = young || !acts
        ? 'wait'
        : verdict.repairEligible
          ? 'repair'
          : 'report';

      computed.push({
        schemaVersion: REAPER_FINDING_SCHEMA_VERSION,
        kind,
        subject,
        action,
        firstSightingIso,
        lastSightingIso: nowIso,
        sightings,
      });
      if (kind === 'merged-worktree') {
        mergedSubjects.add(subject);
      }
    }

    // Precedence (KW1, §3.10.2): a subject under `merged-worktree` is not
    // reported as `orphan-worktree` as well.
    if (mergedSubjects.size > 0) {
      return computed.filter((finding) => finding.kind !== 'orphan-worktree' || !mergedSubjects.has(finding.subject));
    }
    return computed;
  } catch {
    return [];
  }
}
