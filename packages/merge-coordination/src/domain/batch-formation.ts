/**
 * Batch formation: which queued pull requests form the next merge batch, or
 * whether the train should wait, hold, or find nothing to do.
 *
 * Everything here is pure: no I/O, no clock (time arrives as `nowMs`), no
 * randomness, nothing throws and no input is mutated. Re-exporting the
 * admission policy keeps `domain/index.ts` down to one added line.
 *
 * A present premerge status other than `ready` leaves the pull request
 * queued. `pending` is `premerge-pending`; every other present or unreadable
 * value is `premerge-unknown` and is never treated as ready. An omitted
 * status stays eligible so existing callers keep their behavior. `skipped`
 * is attached only when that list is non-empty, and never on `hold`.
 */

export * from './admission-policy.js';

import {
  isPositiveInteger,
  isSha40,
  type BatchMemberRecord,
  type QueueEntryRecord,
} from './entities/index.js';
import {
  admissionClassCap,
  changesOverlap,
  classifyChange,
  validateBatchPolicy,
  type AdmissionClass,
  type BatchPolicy,
} from './admission-policy.js';

/** The only premerge states batch formation understands. Anything else is not ready. */
export type PremergeStatus = 'ready' | 'pending' | 'unknown' | 'failed';

/** A candidate left queued, with the reason it was not taken. */
export interface SkippedCandidate {
  readonly prNumber: number;
  readonly headSha: string;
  readonly reason: string;
}

/** One queued pull request, with the paths its change touches. */
export interface AdmissionCandidate {
  readonly entry: QueueEntryRecord;
  readonly changedPaths: readonly string[];
  readonly enqueuedAtMs: number;
  /** Omitted means a legacy caller: the candidate stays eligible. */
  readonly premergeStatus?: PremergeStatus;
}

/** Everything the formation decision may look at. Never mutated. */
export interface BatchFormationInput {
  readonly candidates: readonly AdmissionCandidate[];
  readonly policy: BatchPolicy;
  readonly nowMs: number;
  /** Batches already validating or ready to promote. */
  readonly inFlightBatches: number;
}

/**
 * The formation decision. File compatibility inside a batch is a scheduling
 * heuristic, never proof; the validation gate still decides what lands.
 * `none` with reason `walk-budget-exceeded` is the typed refusal when the
 * admission walk spends its total visit budget.
 */
export type BatchFormationDecision =
  | {
      readonly kind: 'form';
      readonly members: readonly BatchMemberRecord[];
      readonly classes: readonly AdmissionClass[];
      readonly reason: string;
      readonly skipped?: readonly SkippedCandidate[];
    }
  | {
      readonly kind: 'wait';
      readonly reason: string;
      readonly retryAfterMs: number;
      readonly skipped?: readonly SkippedCandidate[];
    }
  | { readonly kind: 'hold'; readonly reason: string }
  | { readonly kind: 'none'; readonly reason: string; readonly skipped?: readonly SkippedCandidate[] };

/**
 * Per-list walk bound. This function has no clock and no I/O, so a proxy or
 * sparse array that reports an enormous length is refused before the loop.
 */
const MAX_WALK = 100_000;

/**
 * Cost bound for one admission walk: one charge per candidate and one charge
 * per changedPaths element, taken before that element is read. MAX_WALK caps
 * each array alone, so 100_000 candidates sharing one 100_000-element path
 * list would otherwise copy that list once per candidate. 200_000 charges
 * cover one full candidate list and one full path list, and not a second full
 * copy. The next element is not read, and formBatch returns
 * `{ kind: 'none', reason: 'walk-budget-exceeded' }`.
 */
const MAX_TOTAL_WALK = 200_000;

const PREMERGE_PENDING = 'premerge-pending';
const PREMERGE_UNKNOWN = 'premerge-unknown';
const WALK_BUDGET_EXCEEDED = 'walk-budget-exceeded';

type ReadResult = { readonly ok: true; readonly value: unknown } | { readonly ok: false };

type CandidateOutcome =
  | { readonly kind: 'admit'; readonly candidate: AdmissionCandidate }
  | { readonly kind: 'silent' }
  | { readonly kind: 'skip'; readonly record: SkippedCandidate }
  | { readonly kind: 'budget' };

type PathsRead =
  | { readonly ok: true; readonly paths: readonly string[] }
  | { readonly ok: false; readonly reason: 'invalid' | 'budget' };

interface WalkBudget {
  readonly charge: () => boolean;
}

interface ParsedFormation {
  readonly candidates: readonly unknown[];
  readonly policy: BatchPolicy;
  readonly nowMs: number;
  readonly inFlightBatches: number;
}

type FormationParse =
  | { readonly ok: false; readonly decision: BatchFormationDecision }
  | { readonly ok: true; readonly value: ParsedFormation };

/** Read one property. A throwing getter is a failed read, never an escape. */
function readProperty(target: object, key: string): ReadResult {
  try {
    return { ok: true, value: (target as Record<string, unknown>)[key] };
  } catch {
    // Hostile getter: unreadable is not success.
    return { ok: false };
  }
}

function isArray(value: unknown): value is readonly unknown[] {
  try {
    return Array.isArray(value);
  } catch {
    // A revoked proxy throws from Array.isArray. That is not a list we can walk.
    return false;
  }
}

function isRecord(value: unknown): value is object {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  return !isArray(value);
}

function readWalkLength(value: readonly unknown[]): number | undefined {
  let length: unknown;
  try {
    length = value.length;
  } catch {
    // An unreadable length cannot be bounded, so the list is refused.
    return undefined;
  }
  if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0 || length > MAX_WALK) {
    return undefined;
  }
  return length;
}

/**
 * Copy a list by index. Array-likes are not arrays and are refused by the
 * caller. A throwing index becomes a hole so one bad slot does not abandon
 * the rest, and a lying length never starts the loop.
 */
function readList(value: unknown): readonly unknown[] | undefined {
  if (!isArray(value)) {
    return undefined;
  }
  const length = readWalkLength(value);
  if (length === undefined) {
    return undefined;
  }
  const items: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    try {
      items.push(value[index]);
    } catch {
      // One unreadable slot is a hole, not a reason to throw the walk away.
      items.push(undefined);
    }
  }
  return items;
}

function readFiniteNumber(target: object, key: string): number | undefined {
  const read = readProperty(target, key);
  if (!read.ok || typeof read.value !== 'number' || !Number.isFinite(read.value)) {
    return undefined;
  }
  return read.value;
}

function readPolicy(value: unknown): BatchPolicy | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const maxBatchSize = readFiniteNumber(value, 'maxBatchSize');
  const minBatchSize = readFiniteNumber(value, 'minBatchSize');
  const collectionWaitMs = readFiniteNumber(value, 'collectionWaitMs');
  const speculativeDepth = readFiniteNumber(value, 'speculativeDepth');
  if (
    maxBatchSize === undefined ||
    minBatchSize === undefined ||
    collectionWaitMs === undefined ||
    speculativeDepth === undefined
  ) {
    return undefined;
  }
  // Fresh object: later reads cannot re-enter a throwing getter, and no caller key is copied.
  // The same constraints as every other policy intake: integers, positive sizes,
  // a non-negative collection wait, and minBatchSize <= maxBatchSize.
  const validated = validateBatchPolicy({
    maxBatchSize,
    minBatchSize,
    collectionWaitMs,
    speculativeDepth,
  });
  if (!validated.ok) {
    return undefined;
  }
  return validated.value;
}

function createWalkBudget(limit: number): WalkBudget {
  let remaining = limit;
  return {
    charge: (): boolean => {
      if (remaining <= 0) {
        return false;
      }
      remaining -= 1;
      return true;
    },
  };
}

/**
 * Copy changedPaths, charging one visit per element before that element is
 * read. Spending the budget refuses the whole admission walk. A bad element
 * refuses only this candidate, as an unreadable path list already did.
 */
function readChangedPaths(candidate: object, budget: WalkBudget): PathsRead {
  const read = readProperty(candidate, 'changedPaths');
  if (!read.ok || !isArray(read.value)) {
    return { ok: false, reason: 'invalid' };
  }
  const length = readWalkLength(read.value);
  if (length === undefined) {
    return { ok: false, reason: 'invalid' };
  }
  const list = read.value;
  const paths: string[] = [];
  for (let index = 0; index < length; index += 1) {
    if (!budget.charge()) {
      return { ok: false, reason: 'budget' };
    }
    let item: unknown;
    try {
      item = list[index];
    } catch {
      // An unreadable element is a bad path list, not an escape.
      return { ok: false, reason: 'invalid' };
    }
    if (typeof item !== 'string') {
      return { ok: false, reason: 'invalid' };
    }
    paths.push(item);
  }
  return { ok: true, paths };
}

function readSkipIdentity(entry: object): { readonly prNumber: number; readonly headSha: string } | undefined {
  const prRead = readProperty(entry, 'prNumber');
  const shaRead = readProperty(entry, 'headSha');
  if (!prRead.ok || !shaRead.ok) {
    return undefined;
  }
  if (!isPositiveInteger(prRead.value) || typeof shaRead.value !== 'string') {
    return undefined;
  }
  return { prNumber: prRead.value, headSha: shaRead.value };
}

/** Record a skip only when both identity fields can be read; otherwise omit it. */
function skipOrOmit(entry: object, reason: string): CandidateOutcome {
  const identity = readSkipIdentity(entry);
  if (identity === undefined) {
    return { kind: 'silent' };
  }
  return {
    kind: 'skip',
    record: { prNumber: identity.prNumber, headSha: identity.headSha, reason },
  };
}

/**
 * Admit a safe copy, or skip. Blocked entries stay silent so an all-blocked
 * queue still returns exactly `{ kind: 'none', reason: 'no eligible entries' }`.
 * The copy is what later steps read, so a getter cannot throw on a second access
 * and the caller's object is never written.
 */
function considerCandidate(value: unknown, budget: WalkBudget): CandidateOutcome {
  if (!isRecord(value)) {
    return { kind: 'silent' };
  }
  const entryRead = readProperty(value, 'entry');
  if (!entryRead.ok || !isRecord(entryRead.value)) {
    return { kind: 'silent' };
  }
  const entry = entryRead.value;

  const eligibilityRead = readProperty(entry, 'eligibility');
  if (!eligibilityRead.ok || !isRecord(eligibilityRead.value)) {
    return skipOrOmit(entry, PREMERGE_UNKNOWN);
  }
  const kindRead = readProperty(eligibilityRead.value, 'kind');
  if (!kindRead.ok) {
    return skipOrOmit(entry, PREMERGE_UNKNOWN);
  }
  if (kindRead.value === 'blocked') {
    return { kind: 'silent' };
  }
  if (kindRead.value !== 'eligible') {
    return skipOrOmit(entry, PREMERGE_UNKNOWN);
  }

  const statusRead = readProperty(value, 'premergeStatus');
  if (!statusRead.ok) {
    return skipOrOmit(entry, PREMERGE_UNKNOWN);
  }
  const status = statusRead.value;
  if (status === 'pending') {
    return skipOrOmit(entry, PREMERGE_PENDING);
  }
  // Present and not ready: unknown, failed, null, a non-string, or any other value.
  if (status !== undefined && status !== 'ready') {
    return skipOrOmit(entry, PREMERGE_UNKNOWN);
  }

  const identity = readSkipIdentity(entry);
  if (identity === undefined) {
    return { kind: 'silent' };
  }
  if (!isSha40(identity.headSha)) {
    return { kind: 'skip', record: { prNumber: identity.prNumber, headSha: identity.headSha, reason: PREMERGE_UNKNOWN } };
  }
  const pathsRead = readChangedPaths(value, budget);
  if (!pathsRead.ok) {
    if (pathsRead.reason === 'budget') {
      return { kind: 'budget' };
    }
    return skipOrOmit(entry, PREMERGE_UNKNOWN);
  }
  const changedPaths = pathsRead.paths;
  const enqueuedAtMs = readFiniteNumber(value, 'enqueuedAtMs');
  if (enqueuedAtMs === undefined) {
    return skipOrOmit(entry, PREMERGE_UNKNOWN);
  }

  const idRead = readProperty(entry, 'id');
  const id = idRead.ok && typeof idRead.value === 'string' && idRead.value.length > 0 ? idRead.value : 'unreadable';
  const admitted: AdmissionCandidate = {
    entry: {
      id,
      schemaVersion: 1,
      prNumber: identity.prNumber,
      headSha: identity.headSha,
      eligibility: { kind: 'eligible' },
    },
    changedPaths,
    enqueuedAtMs,
    ...(status === 'ready' ? { premergeStatus: 'ready' as const } : {}),
  };
  return { kind: 'admit', candidate: admitted };
}

type PoolBuild =
  | {
      readonly ok: true;
      readonly pool: readonly AdmissionCandidate[];
      readonly skipped: readonly SkippedCandidate[];
    }
  | { readonly ok: false };

/** Dedupe by prNumber (earlier enqueue wins, then input order) and sort FIFO. */
function buildPool(candidates: readonly unknown[]): PoolBuild {
  const budget = createWalkBudget(MAX_TOTAL_WALK);
  const byPr = new Map<number, AdmissionCandidate>();
  const skipped: SkippedCandidate[] = [];
  for (const candidate of candidates) {
    if (!budget.charge()) {
      return { ok: false };
    }
    const outcome = considerCandidate(candidate, budget);
    if (outcome.kind === 'budget') {
      return { ok: false };
    }
    if (outcome.kind === 'silent') {
      continue;
    }
    if (outcome.kind === 'skip') {
      skipped.push(outcome.record);
      continue;
    }
    const admitted = outcome.candidate;
    const existing = byPr.get(admitted.entry.prNumber);
    if (existing === undefined || admitted.enqueuedAtMs < existing.enqueuedAtMs) {
      byPr.set(admitted.entry.prNumber, admitted);
    }
  }
  const pool = [...byPr.values()].sort((left, right) => {
    if (left.enqueuedAtMs !== right.enqueuedAtMs) {
      return left.enqueuedAtMs - right.enqueuedAtMs;
    }
    return left.entry.prNumber - right.entry.prNumber;
  });
  return { ok: true, pool, skipped };
}

function batchCap(policy: BatchPolicy, classes: readonly AdmissionClass[]): number {
  return Math.min(policy.maxBatchSize, ...classes.map((cls) => admissionClassCap(cls, policy.maxBatchSize)));
}

function attachSkipped(
  decision: Exclude<BatchFormationDecision, { readonly kind: 'hold' }>,
  skipped: readonly SkippedCandidate[],
): BatchFormationDecision {
  if (skipped.length === 0) {
    return decision;
  }
  switch (decision.kind) {
    case 'form':
      return { ...decision, skipped };
    case 'wait':
      return { ...decision, skipped };
    case 'none':
      return { ...decision, skipped };
    default: {
      const unreachable: never = decision;
      return unreachable;
    }
  }
}

function invalidInput(): FormationParse {
  return { ok: false, decision: { kind: 'none', reason: 'invalid batch formation input' } };
}

function parseFormation(input: BatchFormationInput): FormationParse {
  if (!isRecord(input)) {
    return invalidInput();
  }
  const candidatesRead = readProperty(input, 'candidates');
  const policyRead = readProperty(input, 'policy');
  const nowRead = readProperty(input, 'nowMs');
  const inFlightRead = readProperty(input, 'inFlightBatches');
  if (!candidatesRead.ok || !policyRead.ok || !nowRead.ok || !inFlightRead.ok) {
    return invalidInput();
  }
  const policy = readPolicy(policyRead.value);
  if (policy === undefined) {
    return invalidInput();
  }
  const candidates = readList(candidatesRead.value);
  if (candidates === undefined) {
    return { ok: false, decision: { kind: 'none', reason: 'invalid candidates list' } };
  }
  const nowMs = nowRead.value;
  const inFlightBatches = inFlightRead.value;
  if (
    typeof nowMs !== 'number' ||
    !Number.isFinite(nowMs) ||
    typeof inFlightBatches !== 'number' ||
    !Number.isFinite(inFlightBatches)
  ) {
    return invalidInput();
  }
  return { ok: true, value: { candidates, policy, nowMs, inFlightBatches } };
}

/**
 * Decide the next batch. Premerge skips are removed before the walk, so a
 * pull request waiting on its premerge check cannot wedge the queue. That
 * admission walk's cost bound is MAX_TOTAL_WALK; spending it returns
 * `walk-budget-exceeded` and does not read the next element. The walk over
 * what remains is strict first-in first-out: the first entry that cannot
 * join stops it, and no later entry may skip past it.
 */
function decideBatch(input: BatchFormationInput): BatchFormationDecision {
  const parsed = parseFormation(input);
  if (!parsed.ok) {
    return parsed.decision;
  }
  const { candidates, policy, nowMs, inFlightBatches } = parsed.value;
  if (inFlightBatches >= policy.speculativeDepth) {
    return {
      kind: 'hold',
      reason: `speculative depth of ${policy.speculativeDepth} is reached with ${inFlightBatches} batches in flight`,
    };
  }
  const built = buildPool(candidates);
  if (!built.ok) {
    return { kind: 'none', reason: WALK_BUDGET_EXCEEDED };
  }
  const { pool, skipped } = built;
  if (pool.length === 0) {
    return attachSkipped({ kind: 'none', reason: 'no eligible entries' }, skipped);
  }

  const head = pool[0];
  if (head === undefined) {
    return attachSkipped({ kind: 'none', reason: 'no eligible entries' }, skipped);
  }
  const classes: AdmissionClass[] = pool.map((candidate) => classifyChange(candidate.changedPaths));
  const headClass = classes[0];
  if (headClass === undefined) {
    return attachSkipped({ kind: 'none', reason: 'no eligible entries' }, skipped);
  }

  if (headClass === 'alone') {
    return attachSkipped(
      {
        kind: 'form',
        members: [{ prNumber: head.entry.prNumber, headSha: head.entry.headSha }],
        classes: [headClass],
        reason: 'head is admitted alone and never shares a batch',
      },
      skipped,
    );
  }

  const members: AdmissionCandidate[] = [head];
  const memberClasses: AdmissionClass[] = [headClass];
  let stoppedAtBlocker = false;
  for (let index = 1; index < pool.length; index += 1) {
    const candidate = pool[index];
    const cls = classes[index];
    if (candidate === undefined || cls === undefined) {
      stoppedAtBlocker = true;
      break;
    }
    const cannotJoin =
      cls === 'alone' ||
      members.some((member) => changesOverlap(member.changedPaths, candidate.changedPaths)) ||
      members.length + 1 > batchCap(policy, [...memberClasses, cls]);
    if (cannotJoin) {
      stoppedAtBlocker = true;
      break;
    }
    members.push(candidate);
    memberClasses.push(cls);
  }

  const cap = batchCap(policy, memberClasses);
  const headAge = nowMs - head.enqueuedAtMs;
  const form =
    members.length >= cap ||
    members.length >= policy.minBatchSize ||
    stoppedAtBlocker ||
    inFlightBatches === 0 ||
    headAge >= policy.collectionWaitMs;
  if (!form) {
    return attachSkipped(
      {
        kind: 'wait',
        reason: `batch is under the minimum of ${policy.minBatchSize} and still collecting`,
        retryAfterMs: Math.max(1, policy.collectionWaitMs - headAge),
      },
      skipped,
    );
  }

  return attachSkipped(
    {
      kind: 'form',
      members: members.map((member) => ({ prNumber: member.entry.prNumber, headSha: member.entry.headSha })),
      classes: [...memberClasses],
      reason: stoppedAtBlocker
        ? `formed ${members.length} entr${members.length === 1 ? 'y' : 'ies'} before the first entry that cannot join`
        : `formed ${members.length} entr${members.length === 1 ? 'y' : 'ies'} within the batch cap of ${cap}`,
    },
    skipped,
  );
}

/**
 * Decide the next batch. Hostile input returns a typed `none` decision.
 * Nothing thrown by a getter, a proxy, or a helper escapes this function.
 */
export function formBatch(input: BatchFormationInput): BatchFormationDecision {
  try {
    return decideBatch(input);
  } catch {
    // Any named error that still escapes a helper is this typed refusal.
    return { kind: 'none', reason: 'invalid batch formation input' };
  }
}
