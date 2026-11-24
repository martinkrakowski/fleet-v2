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
  classifyChange,
  normalizeChangedPath,
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

/**
 * Largest `maxBatchSize` a policy may name. Anything larger is refused in
 * `readPolicy` with the same typed refusal as every other unusable policy.
 * This caps how large a batch the join walk is allowed to grow.
 */
const MAX_BATCH_SIZE_LIMIT = 64;

/**
 * Eligible candidates the join walk considers after admission. Further
 * eligible entries stay queued and are not classified or joined.
 */
const MAX_ELIGIBLE_POOL = 512;

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
  // Same typed refusal as the constraints above. A batch this large makes the
  // join walk quadratic, so the policy is not usable.
  if (validated.value.maxBatchSize > MAX_BATCH_SIZE_LIMIT) {
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

/** Blocked stays silent. Eligible continues. Every other kind is not ready. */
function classifyEligibilityKind(entry: object): 'blocked' | 'eligible' | 'unknown' {
  const eligibilityRead = readProperty(entry, 'eligibility');
  if (!eligibilityRead.ok || !isRecord(eligibilityRead.value)) {
    return 'unknown';
  }
  const kindRead = readProperty(eligibilityRead.value, 'kind');
  if (!kindRead.ok) {
    return 'unknown';
  }
  if (kindRead.value === 'blocked') {
    return 'blocked';
  }
  if (kindRead.value === 'eligible') {
    return 'eligible';
  }
  return 'unknown';
}

function eligibilityOutcome(entry: object): CandidateOutcome | undefined {
  const kind = classifyEligibilityKind(entry);
  if (kind === 'eligible') {
    return undefined;
  }
  if (kind === 'blocked') {
    return { kind: 'silent' };
  }
  return skipOrOmit(entry, PREMERGE_UNKNOWN);
}

/** Omitted and ready may be admitted. Pending and every other present value may not. */
function classifyPremerge(status: unknown): 'omitted' | 'pending' | 'ready' | 'unknown' {
  if (status === 'pending') {
    return 'pending';
  }
  if (status === 'ready') {
    return 'ready';
  }
  if (status === undefined) {
    return 'omitted';
  }
  return 'unknown';
}

function premergeOutcome(candidate: object, entry: object): CandidateOutcome | 'omitted' | 'ready' {
  const statusRead = readProperty(candidate, 'premergeStatus');
  if (!statusRead.ok) {
    return skipOrOmit(entry, PREMERGE_UNKNOWN);
  }
  const premerge = classifyPremerge(statusRead.value);
  if (premerge === 'pending') {
    return skipOrOmit(entry, PREMERGE_PENDING);
  }
  if (premerge === 'unknown') {
    return skipOrOmit(entry, PREMERGE_UNKNOWN);
  }
  return premerge;
}

type ChangedPathsTaken = { readonly kind: 'paths'; readonly paths: readonly string[] } | CandidateOutcome;

/** Copy changedPaths, or the budget refusal when this candidate spends the walk. */
function takeChangedPaths(candidate: object, entry: object, budget: WalkBudget): ChangedPathsTaken {
  const pathsRead = readChangedPaths(candidate, budget);
  if (pathsRead.ok) {
    return { kind: 'paths', paths: pathsRead.paths };
  }
  if (pathsRead.reason === 'budget') {
    return { kind: 'budget' };
  }
  return skipOrOmit(entry, PREMERGE_UNKNOWN);
}

function admitCandidate(
  entry: object,
  identity: { readonly prNumber: number; readonly headSha: string },
  changedPaths: readonly string[],
  enqueuedAtMs: number,
  premerge: 'omitted' | 'ready',
): CandidateOutcome {
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
    ...(premerge === 'ready' ? { premergeStatus: 'ready' as const } : {}),
  };
  return { kind: 'admit', candidate: admitted };
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

  const eligibility = eligibilityOutcome(entry);
  if (eligibility !== undefined) {
    return eligibility;
  }

  const premerge = premergeOutcome(value, entry);
  if (typeof premerge !== 'string') {
    return premerge;
  }

  const identity = readSkipIdentity(entry);
  if (identity === undefined) {
    return { kind: 'silent' };
  }
  if (!isSha40(identity.headSha)) {
    return { kind: 'skip', record: { prNumber: identity.prNumber, headSha: identity.headSha, reason: PREMERGE_UNKNOWN } };
  }

  const pathsOutcome = takeChangedPaths(value, entry, budget);
  if (pathsOutcome.kind !== 'paths') {
    return pathsOutcome;
  }
  const enqueuedAtMs = readFiniteNumber(value, 'enqueuedAtMs');
  if (enqueuedAtMs === undefined) {
    return skipOrOmit(entry, PREMERGE_UNKNOWN);
  }
  return admitCandidate(entry, identity, pathsOutcome.paths, enqueuedAtMs, premerge);
}

type PoolBuild =
  | {
      readonly ok: true;
      readonly pool: readonly AdmissionCandidate[];
      readonly skipped: readonly SkippedCandidate[];
    }
  | { readonly ok: false; readonly skipped: readonly SkippedCandidate[] };

/** Dedupe by prNumber (earlier enqueue wins, then input order) and sort FIFO. */
function buildPool(candidates: readonly unknown[]): PoolBuild {
  const budget = createWalkBudget(MAX_TOTAL_WALK);
  const byPr = new Map<number, AdmissionCandidate>();
  const skipped: SkippedCandidate[] = [];
  for (const candidate of candidates) {
    if (!budget.charge()) {
      return { ok: false, skipped };
    }
    const outcome = considerCandidate(candidate, budget);
    if (outcome.kind === 'budget') {
      return { ok: false, skipped };
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

function addMemberPaths(seen: Set<string>, paths: readonly string[]): void {
  for (const path of paths) {
    seen.add(normalizeChangedPath(path));
  }
}

/** True when any normalized path is already in the batch. Same rule as changesOverlap. */
function overlapsMemberPaths(seen: Set<string>, paths: readonly string[]): boolean {
  for (const path of paths) {
    if (seen.has(normalizeChangedPath(path))) {
      return true;
    }
  }
  return false;
}

interface JoinedBatch {
  readonly members: readonly AdmissionCandidate[];
  readonly memberClasses: readonly AdmissionClass[];
  readonly stoppedAtBlocker: boolean;
}

/**
 * Strict FIFO join. Member PR numbers and normalized paths are Sets, so this
 * walk does not scan the growing member list.
 *
 * The caller classifies at most MAX_ELIGIBLE_POOL (512) eligible candidates,
 * and a batch holds at most MAX_BATCH_SIZE_LIMIT (64) members. Worst case is
 * O(MAX_ELIGIBLE_POOL * paths) to classify plus O(MAX_BATCH_SIZE_LIMIT * paths)
 * set updates. The walk stops at the first candidate that cannot join.
 */
function joinFifo(
  pool: readonly AdmissionCandidate[],
  classes: readonly AdmissionClass[],
  policy: BatchPolicy,
  head: AdmissionCandidate,
  headClass: AdmissionClass,
): JoinedBatch {
  const members: AdmissionCandidate[] = [head];
  const memberClasses: AdmissionClass[] = [headClass];
  const memberPrs = new Set<number>([head.entry.prNumber]);
  const memberPaths = new Set<string>();
  addMemberPaths(memberPaths, head.changedPaths);
  let joinCap = batchCap(policy, memberClasses);
  let stoppedAtBlocker = false;
  for (let index = 1; index < pool.length; index += 1) {
    const candidate = pool[index];
    const cls = classes[index];
    if (candidate === undefined || cls === undefined) {
      stoppedAtBlocker = true;
      break;
    }
    const nextCap = Math.min(joinCap, admissionClassCap(cls, policy.maxBatchSize));
    const cannotJoin =
      cls === 'alone' ||
      memberPrs.has(candidate.entry.prNumber) ||
      overlapsMemberPaths(memberPaths, candidate.changedPaths) ||
      members.length + 1 > nextCap;
    if (cannotJoin) {
      stoppedAtBlocker = true;
      break;
    }
    members.push(candidate);
    memberClasses.push(cls);
    memberPrs.add(candidate.entry.prNumber);
    addMemberPaths(memberPaths, candidate.changedPaths);
    joinCap = nextCap;
  }
  return { members, memberClasses, stoppedAtBlocker };
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
 * `walk-budget-exceeded` and does not read the next element. Skips already
 * recorded stay on that refusal. The walk over what remains is strict
 * first-in first-out, capped at MAX_ELIGIBLE_POOL: the first entry that
 * cannot join stops it, and no later entry may skip past it.
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
    return attachSkipped({ kind: 'none', reason: WALK_BUDGET_EXCEEDED }, built.skipped);
  }
  const { pool: admitted, skipped } = built;
  if (admitted.length === 0) {
    return attachSkipped({ kind: 'none', reason: 'no eligible entries' }, skipped);
  }
  const pool = admitted.slice(0, MAX_ELIGIBLE_POOL);

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

  const joined = joinFifo(pool, classes, policy, head, headClass);
  const { members, memberClasses, stoppedAtBlocker } = joined;

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
