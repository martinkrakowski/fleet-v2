/**
 * Pure daemon tick domain rules and version 1 records (daemon-tick plan §3.1,
 * §3.2, §3.4, §3.5, §4.1): deterministic job ordering, pause/forge-probe/wake
 * planning, CAS lease-skip mapping, per-call deadline budgeting, and pure
 * readers/builders for status.json, paused.json and daemon/leases/<scope>.json.
 * Never throws, never echoes unvalidated values, never reads a clock or mints ids.
 */

import { containsSecretShape } from '@fleet/shared';
import { isConductorHalted, isZonedIsoDateTime } from './conductor-halt.js';
import { readExactPlainRecord } from './plain-record-reads.js';
import type { ConductorHaltState } from './conductor-halt.js';
import { LANE_RUN_JOURNAL_REASON_CODE_PATTERN } from './lane-run-journal.js';
import { REQUEST_ID_PATTERN } from './lane-run-keys.js';
import { decideLeaseAcquire } from './lane-run-lease.js';
import type { LeaseAcquireRequest } from './lane-run-lease.js';
import type { LaneRunLeaseRecord } from './lane-run-records.js';

export const DAEMON_RECORD_VERSION = 1 as const;
export const DAEMON_DEFAULT_INTERVAL_SECONDS = 60;
export const DAEMON_DEFAULT_BUDGET_SECONDS = 45;
export const DAEMON_DEFAULT_SETTLE_SECONDS = 20;
export const DAEMON_CALL_MIN_REMAINING_MS = 2_000;
export const DAEMON_STARVED_CONSECUTIVE_TICKS = 10;
export const DAEMON_STALE_INTERVAL_MULTIPLIER = 3;
export const DAEMON_MAX_BUDGET_SECONDS = 3_600;

export const DAEMON_TICK_ID_PATTERN = /^tick-[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
/** 12 lowercase hex. Same shape as the unexported HEAD12_PATTERN in lane-run-keys.ts. */
export const DAEMON_REPO_DIGEST_PATTERN = /^[0-9a-f]{12}$/;
export const DAEMON_ENTRY_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export const DAEMON_SINGLETON_JOB_IDS = ['notifier', 'replan-digest'] as const;
export type DaemonSingletonJobId = (typeof DAEMON_SINGLETON_JOB_IDS)[number];

export const DAEMON_JOB_OUTCOMES = [
  'completed',
  'budget-exhausted',
  'skipped',
  'refused',
] as const;
export type DaemonJobOutcomeKind = (typeof DAEMON_JOB_OUTCOMES)[number];

/** Plan §3.2 DaemonJobOutcome. */
export type DaemonJobOutcome =
  | { readonly outcome: 'completed'; readonly progressed: boolean; readonly reasonCode?: string }
  | { readonly outcome: 'budget-exhausted'; readonly progressed: boolean }
  | { readonly outcome: 'skipped'; readonly reasonCode: string }
  | { readonly outcome: 'refused'; readonly reasonCode: string };

export type ParsedDaemonJobId =
  | {
      readonly kind: 'merge-pass';
      readonly jobId: string;
      readonly repoDigest: string;
      readonly leaseScope: string;
      readonly touchesForge: true;
    }
  | {
      readonly kind: 'notifier';
      readonly jobId: 'notifier';
      readonly leaseScope: 'notifier';
      readonly touchesForge: false;
    }
  | {
      readonly kind: 'replan-digest';
      readonly jobId: 'replan-digest';
      readonly leaseScope: 'replan-digest';
      readonly touchesForge: false;
    };

export interface DaemonPauseRecord {
  readonly version: typeof DAEMON_RECORD_VERSION;
  readonly paused: boolean;
  readonly changedAtIso: string;
}

export type DaemonPauseRead =
  | { readonly ok: true; readonly record: DaemonPauseRecord }
  | { readonly ok: false; readonly reason: 'unknown-version' | 'malformed'; readonly error: string };

/** Unreadable pause marker reads as paused (fail closed, plan §3.1). */
export type DaemonPauseState =
  | { readonly state: 'clear'; readonly record: DaemonPauseRecord | null }
  | { readonly state: 'paused'; readonly record: DaemonPauseRecord }
  | { readonly state: 'unreadable' };

export interface DaemonLeaseRecord {
  readonly version: typeof DAEMON_RECORD_VERSION;
  readonly scope: string;
  readonly holderId: string;
  readonly fence: number;
  readonly leaseUntilIso: string;
}

export type DaemonLeaseRead =
  | { readonly ok: true; readonly record: DaemonLeaseRecord }
  | { readonly ok: false; readonly reason: 'unknown-version' | 'malformed'; readonly error: string };

export interface DaemonJobStatusRecord {
  readonly jobId: string;
  readonly outcome: DaemonJobOutcomeKind;
  readonly reasonCode: string | null;
  readonly leaseFence: number | null;
  readonly durationMs: number;
  readonly nextNotBeforeIso: string | null;
  readonly consecutiveBudgetExhausted: number;
}

export interface DaemonRepositoryStatusRecord {
  readonly repoDigest: string;
  readonly lastServedAtIso: string | null;
  readonly queued: number;
  readonly ready: number;
  readonly parked: number;
  readonly headEntryId: string | null;
  readonly lastMergedHead12: string | null;
}

export interface DaemonStatusRecord {
  readonly version: typeof DAEMON_RECORD_VERSION;
  readonly tickId: string;
  readonly startedAtIso: string;
  readonly finishedAtIso: string;
  readonly exitCode: 0 | 1;
  readonly paused: boolean;
  readonly halted: boolean;
  readonly forgeReachable: boolean | null;
  readonly jobs: readonly DaemonJobStatusRecord[];
  readonly repositories: readonly DaemonRepositoryStatusRecord[];
  readonly notifierCursor: string | null;
}

export type DaemonStatusRead =
  | { readonly ok: true; readonly record: DaemonStatusRecord }
  | { readonly ok: false; readonly reason: 'unknown-version' | 'malformed'; readonly error: string };

export type DaemonPlannedJobEntry =
  | { readonly action: 'run'; readonly job: ParsedDaemonJobId }
  | {
      readonly action: 'skip';
      readonly job: ParsedDaemonJobId;
      readonly outcome: { readonly outcome: 'skipped'; readonly reasonCode: 'forge-unreachable' };
    };

export interface DaemonTickPlanInput {
  readonly candidates: readonly string[];
  readonly previousStatus: DaemonStatusRecord | null;
  readonly pause: DaemonPauseState;
  readonly halt: ConductorHaltState;
  readonly forgeReachable: boolean;
  readonly nowIso: string;
  readonly intervalSeconds?: number;
  readonly settleSeconds?: number;
  readonly jobFilter?: readonly string[];
}

export interface DaemonTickPlan {
  readonly paused: boolean;
  readonly halted: boolean;
  readonly forgeReachable: boolean | null;
  readonly settleDelayMs: number;
  readonly entries: readonly DaemonPlannedJobEntry[];
}

export type DaemonJobLeaseDecision =
  | { readonly action: 'acquired'; readonly lease: DaemonLeaseRecord }
  | {
      readonly action: 'skip';
      readonly outcome: { readonly outcome: 'skipped'; readonly reasonCode: 'lease-held' | 'lease-moved' };
    }
  | {
      readonly action: 'refuse';
      readonly outcome: { readonly outcome: 'refused'; readonly reasonCode: 'invalid-lease-request' };
    };

export interface DaemonCallBudgetInput {
  readonly nowIso: string;
  readonly deadlineIso: string;
  readonly normalTimeoutMs: number;
}

export type DaemonCallBudgetDecision =
  | { readonly allowed: true; readonly timeoutMs: number; readonly remainingMs: number }
  | {
      readonly allowed: false;
      readonly reason: 'budget-exhausted' | 'invalid-budget';
      readonly remainingMs: number;
    };

export interface BuildDaemonStatusInput {
  readonly tickId: string;
  readonly startedAtIso: string;
  readonly finishedAtIso: string;
  readonly paused: boolean;
  readonly halted: boolean;
  readonly forgeReachable: boolean | null;
  readonly jobs: readonly DaemonJobStatusRecord[];
  readonly repositories: readonly DaemonRepositoryStatusRecord[];
  readonly notifierCursor: string | null;
}

export type DaemonStatusHealthReason = 'stale' | 'job-refused' | 'starved' | 'invalid-clock';

export interface DaemonStatusHealth {
  readonly healthy: boolean;
  readonly exitCode: 0 | 1;
  readonly reasons: readonly DaemonStatusHealthReason[];
  readonly refusedJobIds: readonly string[];
  readonly starvedJobIds: readonly string[];
}

const CLOUD_SCOPE_PATTERN = /^[A-Za-z0-9_.-]{1,64}\/[A-Za-z0-9_.-]{1,100}$/;

const PAUSE_REQUIRED_KEYS: readonly string[] = ['paused', 'changedAtIso'];
const LEASE_REQUIRED_KEYS: readonly string[] = ['scope', 'holderId', 'fence', 'leaseUntilIso'];
const STATUS_REQUIRED_KEYS: readonly string[] = [
  'tickId', 'startedAtIso', 'finishedAtIso', 'exitCode', 'paused', 'halted',
  'forgeReachable', 'jobs', 'repositories', 'notifierCursor',
];
const STATUS_JOB_KEYS: readonly string[] = [
  'jobId', 'outcome', 'reasonCode', 'leaseFence', 'durationMs', 'nextNotBeforeIso',
  'consecutiveBudgetExhausted',
];
const STATUS_REPO_KEYS: readonly string[] = [
  'repoDigest', 'lastServedAtIso', 'queued', 'ready', 'parked', 'headEntryId', 'lastMergedHead12',
];

const PAUSE_MALFORMED = 'DaemonPause is malformed';
const PAUSE_VERSION = 'DaemonPause version is not supported';
const LEASE_MALFORMED = 'DaemonLease is malformed';
const LEASE_VERSION = 'DaemonLease version is not supported';
const STATUS_MALFORMED = 'DaemonStatus is malformed';
const STATUS_VERSION = 'DaemonStatus version is not supported';

type VersionedSnapshot =
  | { readonly ok: true; readonly snapshot: Record<string, unknown> }
  | { readonly ok: false; readonly reason: 'unknown-version' | 'malformed' };

/**
 * The shared top-of-record reader: a plain object whose own keys are enumerable
 * string data keys, exactly `requiredKeys` plus the optional `version`. Values
 * are read through their own property descriptors, so no getter ever runs.
 * The key set is checked before the version value, so `schemaVersion: 2` is
 * `malformed` rather than `unknown-version`.
 */
function readVersionedSnapshot(value: unknown, requiredKeys: readonly string[]): VersionedSnapshot {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, reason: 'malformed' };
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return { ok: false, reason: 'malformed' };
  }
  const allowed = new Set<string>([...requiredKeys, 'version']);
  const snapshot: Record<string, unknown> = {};
  let sawVersion = false;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowed.has(key)) {
      return { ok: false, reason: 'malformed' };
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      return { ok: false, reason: 'malformed' };
    }
    if (key === 'version') {
      sawVersion = true;
    }
    snapshot[key] = descriptor.value;
  }
  for (const key of requiredKeys) {
    if (!Object.hasOwn(snapshot, key)) {
      return { ok: false, reason: 'malformed' };
    }
  }
  if (sawVersion && snapshot.version !== DAEMON_RECORD_VERSION) {
    return { ok: false, reason: 'unknown-version' };
  }
  return { ok: true, snapshot };
}

/** A safe integer of at least `minimum`: the shared numeric field rule. */
function isSafeIntGte(value: unknown, minimum: number): boolean {
  return Number.isSafeInteger(value) && (value as number) >= minimum;
}

/** Normalized zoned ISO time, `null` for null, `undefined` when invalid. */
function normalizeNullableIso(value: unknown): string | null | undefined {
  if (value === null) {
    return null;
  }
  if (!isZonedIsoDateTime(value)) {
    return undefined;
  }
  return new Date(value as string).toISOString();
}

export function mergePassJobId(repoDigest: string): string | null {
  if (!DAEMON_REPO_DIGEST_PATTERN.test(repoDigest)) {
    return null;
  }
  return `merge-pass:${repoDigest}`;
}

const NOTIFIER_JOB: ParsedDaemonJobId = Object.freeze({
  kind: 'notifier',
  jobId: 'notifier',
  leaseScope: 'notifier',
  touchesForge: false,
});
const REPLAN_JOB: ParsedDaemonJobId = Object.freeze({
  kind: 'replan-digest',
  jobId: 'replan-digest',
  leaseScope: 'replan-digest',
  touchesForge: false,
});

/** `null` for anything that is not a daemon job id, including uppercase hex. */
export function parseDaemonJobId(jobId: unknown): ParsedDaemonJobId | null {
  if (jobId === 'notifier') {
    return NOTIFIER_JOB;
  }
  if (jobId === 'replan-digest') {
    return REPLAN_JOB;
  }
  if (typeof jobId !== 'string' || !jobId.startsWith('merge-pass:')) {
    return null;
  }
  const repoDigest = jobId.slice('merge-pass:'.length);
  if (!DAEMON_REPO_DIGEST_PATTERN.test(repoDigest)) {
    return null;
  }
  return Object.freeze({
    kind: 'merge-pass',
    jobId,
    repoDigest,
    leaseScope: `merge/${repoDigest}`,
    touchesForge: true,
  });
}

/**
 * True for `notifier`, `replan-digest`, `merge/<12 lowercase hex>`, or a cloud
 * `<org>/<repo>` scope whose segments are not `.` or `..` and which carries no
 * secret-shaped text. Never throws.
 */
export function isValidDaemonLeaseScope(scope: unknown): scope is string {
  try {
    if (scope === 'notifier' || scope === 'replan-digest') {
      return true;
    }
    if (typeof scope !== 'string') {
      return false;
    }
    if (scope.startsWith('merge/')) {
      return DAEMON_REPO_DIGEST_PATTERN.test(scope.slice('merge/'.length));
    }
    if (!CLOUD_SCOPE_PATTERN.test(scope)) {
      return false;
    }
    const separator = scope.indexOf('/');
    const org = scope.slice(0, separator);
    const repo = scope.slice(separator + 1);
    if (org === '.' || org === '..' || repo === '.' || repo === '..') {
      return false;
    }
    return !containsSecretShape(scope);
  } catch {
    return false;
  }
}

function byCodeUnit(a: string, b: string): number {
  if (a < b) {
    return -1;
  }
  if (a > b) {
    return 1;
  }
  return 0;
}

/** Digest → serve timestamp in ms, `null` when never served; later duplicates overwrite. */
function lastServedMap(previousStatus: DaemonStatusRecord | null): Map<string, number | null> {
  const map = new Map<string, number | null>();
  if (previousStatus === null) {
    return map;
  }
  for (const repository of previousStatus.repositories) {
    const iso = repository.lastServedAtIso;
    const parsed = iso === null ? Number.NaN : Date.parse(iso);
    map.set(repository.repoDigest, Number.isFinite(parsed) ? parsed : null);
  }
  return map;
}

/** Never-served first, then ascending serve time, ties by repoDigest code unit. */
function compareMergePassJobs(
  a: Extract<ParsedDaemonJobId, { kind: 'merge-pass' }>,
  b: Extract<ParsedDaemonJobId, { kind: 'merge-pass' }>,
  lastServed: Map<string, number | null>,
): number {
  const aMs = lastServed.get(a.repoDigest) ?? null;
  const bMs = lastServed.get(b.repoDigest) ?? null;
  if (aMs === null && bMs !== null) {
    return -1;
  }
  if (aMs !== null && bMs === null) {
    return 1;
  }
  if (aMs !== null && bMs !== null && aMs !== bMs) {
    return aMs - bMs;
  }
  return byCodeUnit(a.repoDigest, b.repoDigest);
}

/**
 * Deterministic tick order (plan §3.1): merge-pass jobs by `lastServedAtIso`
 * ascending from the previous status (never-served first, ties by digest),
 * then `notifier`, then `replan-digest`. Duplicates keep the first; unknown
 * ids drop; a given filter keeps only listed ids.
 */
export function orderDaemonJobs(
  candidates: readonly string[],
  previousStatus: DaemonStatusRecord | null,
  jobFilter?: readonly string[],
): readonly ParsedDaemonJobId[] {
  const filter = jobFilter === undefined ? null : new Set<string>(jobFilter);
  const seen = new Set<string>();
  const mergePass: Extract<ParsedDaemonJobId, { kind: 'merge-pass' }>[] = [];
  let notifier: ParsedDaemonJobId | null = null;
  let replanDigest: ParsedDaemonJobId | null = null;
  for (const candidate of candidates) {
    const parsed = parseDaemonJobId(candidate);
    if (parsed === null || seen.has(parsed.jobId)) {
      continue;
    }
    if (filter !== null && !filter.has(parsed.jobId)) {
      continue;
    }
    seen.add(parsed.jobId);
    if (parsed.kind === 'merge-pass') {
      mergePass.push(parsed);
    } else if (parsed.kind === 'notifier' && notifier === null) {
      notifier = parsed;
    } else if (parsed.kind === 'replan-digest' && replanDigest === null) {
      replanDigest = parsed;
    }
  }
  const lastServed = lastServedMap(previousStatus);
  const ordered: ParsedDaemonJobId[] = mergePass.sort((a, b) => compareMergePassJobs(a, b, lastServed));
  if (notifier !== null) {
    ordered.push(notifier);
  }
  if (replanDigest !== null) {
    ordered.push(replanDigest);
  }
  return Object.freeze(ordered);
}

/** True for `paused` and `unreadable`: fail closed (plan §3.1). */
export function isDaemonPaused(state: DaemonPauseState): boolean {
  return state.state === 'paused' || state.state === 'unreadable';
}

function planEntry(job: ParsedDaemonJobId, forgeReachable: boolean): DaemonPlannedJobEntry {
  if (job.touchesForge && !forgeReachable) {
    return Object.freeze({
      action: 'skip',
      job,
      outcome: Object.freeze({ outcome: 'skipped', reasonCode: 'forge-unreachable' }),
    });
  }
  return Object.freeze({ action: 'run', job });
}

/**
 * `settleSeconds * 1000` only for a wake: at least one runnable entry, a
 * previous status, valid inputs, and a gap strictly beyond three intervals.
 * Everything else settles immediately (0), never throws.
 */
function computeSettleDelayMs(
  entries: readonly DaemonPlannedJobEntry[],
  input: DaemonTickPlanInput,
): number {
  if (!entries.some((entry) => entry.action === 'run') || input.previousStatus === null) {
    return 0;
  }
  if (!isZonedIsoDateTime(input.nowIso)) {
    return 0;
  }
  const intervalSeconds = input.intervalSeconds ?? DAEMON_DEFAULT_INTERVAL_SECONDS;
  const settleSeconds = input.settleSeconds ?? DAEMON_DEFAULT_SETTLE_SECONDS;
  if (!isSafeIntGte(intervalSeconds, 1) || !isSafeIntGte(settleSeconds, 0)) {
    return 0;
  }
  const gapMs = Date.parse(input.nowIso) - Date.parse(input.previousStatus.finishedAtIso);
  if (!(gapMs > DAEMON_STALE_INTERVAL_MULTIPLIER * intervalSeconds * 1_000)) {
    return 0;
  }
  return settleSeconds * 1_000;
}

/** Pause, including an unreadable marker, plans no entries and exits 0; halt is recorded and left to the decider (plan §3.6: halt stops external actions, not jobs), so a halted tick still has its entries. */
export function planDaemonTick(input: DaemonTickPlanInput): DaemonTickPlan {
  const halted = isConductorHalted(input.halt);
  if (isDaemonPaused(input.pause)) {
    return Object.freeze({
      paused: true,
      halted,
      forgeReachable: null,
      settleDelayMs: 0,
      entries: Object.freeze([]),
    });
  }
  const ordered = orderDaemonJobs(input.candidates, input.previousStatus, input.jobFilter);
  const entries = Object.freeze(ordered.map((job) => planEntry(job, input.forgeReachable)));
  return Object.freeze({
    paused: false,
    halted,
    forgeReachable: input.forgeReachable,
    settleDelayMs: computeSettleDelayMs(entries, input),
    entries,
  });
}

/** The stored daemon lease decision: CAS rules stay in decideLeaseAcquire. */
export function decideDaemonJobLease(
  current: LaneRunLeaseRecord | null,
  request: LeaseAcquireRequest,
  scope: string,
): DaemonJobLeaseDecision {
  try {
    return decideDaemonJobLeaseInner(current, request, scope);
  } catch {
    return refuseLeaseRequest();
  }
}

function decideDaemonJobLeaseInner(
  current: LaneRunLeaseRecord | null,
  request: LeaseAcquireRequest,
  scope: string,
): DaemonJobLeaseDecision {
  if (!isValidDaemonLeaseScope(scope)) {
    return refuseLeaseRequest();
  }
  if (current !== null && !isTickHolderId(current.holderId)) {
    return refuseLeaseRequest();
  }
  if (!isTickHolderId(request.holderId)) {
    return refuseLeaseRequest();
  }
  const decision = decideLeaseAcquire(current, request);
  if (decision.ok) {
    return {
      action: 'acquired',
      lease: Object.freeze({ version: DAEMON_RECORD_VERSION, scope, ...decision.lease }),
    };
  }
  if (decision.reason === 'lease-held' || decision.reason === 'lease-moved') {
    return {
      action: 'skip',
      outcome: Object.freeze({ outcome: 'skipped', reasonCode: decision.reason }),
    };
  }
  return refuseLeaseRequest();
}

function isTickHolderId(value: unknown): value is string {
  return typeof value === 'string' && DAEMON_TICK_ID_PATTERN.test(value) && !containsSecretShape(value);
}

function refuseLeaseRequest(): DaemonJobLeaseDecision {
  return {
    action: 'refuse',
    outcome: Object.freeze({ outcome: 'refused', reasonCode: 'invalid-lease-request' }),
  };
}

/**
 * The tick deadline: `nowIso` plus `budgetSeconds`, or `null` when either
 * input is invalid (`budgetSeconds` in `1..3600`).
 */
export function computeTickDeadlineIso(
  nowIso: string,
  budgetSeconds: number = DAEMON_DEFAULT_BUDGET_SECONDS,
): string | null {
  if (!isZonedIsoDateTime(nowIso)) {
    return null;
  }
  if (!isSafeIntGte(budgetSeconds, 1) || budgetSeconds > DAEMON_MAX_BUDGET_SECONDS) {
    return null;
  }
  return new Date(Date.parse(nowIso) + budgetSeconds * 1_000).toISOString();
}

/** `min(normalTimeoutMs, remainingMs)`; under 2 s remaining the call is not started. */
export function computeCallBudget(input: DaemonCallBudgetInput): DaemonCallBudgetDecision {
  if (!isZonedIsoDateTime(input.nowIso) || !isZonedIsoDateTime(input.deadlineIso)) {
    return { allowed: false, reason: 'invalid-budget', remainingMs: 0 };
  }
  if (!isSafeIntGte(input.normalTimeoutMs, 1)) {
    return { allowed: false, reason: 'invalid-budget', remainingMs: 0 };
  }
  const remainingMs = Date.parse(input.deadlineIso) - Date.parse(input.nowIso);
  if (remainingMs < DAEMON_CALL_MIN_REMAINING_MS) {
    return { allowed: false, reason: 'budget-exhausted', remainingMs };
  }
  return { allowed: true, timeoutMs: Math.min(input.normalTimeoutMs, remainingMs), remainingMs };
}

/** Never throws, never echoes: the version 1 pause marker. */
export function readDaemonPauseRecord(input: unknown): DaemonPauseRead {
  try {
    const snapshot = readVersionedSnapshot(input, PAUSE_REQUIRED_KEYS);
    if (!snapshot.ok) {
      return pauseFailure(snapshot.reason);
    }
    if (typeof snapshot.snapshot.paused !== 'boolean') {
      return pauseFailure('malformed');
    }
    const changedAtIso = normalizeNullableIso(snapshot.snapshot.changedAtIso);
    if (typeof changedAtIso !== 'string') {
      return pauseFailure('malformed');
    }
    return {
      ok: true,
      record: Object.freeze({
        version: DAEMON_RECORD_VERSION,
        paused: snapshot.snapshot.paused,
        changedAtIso,
      }),
    };
  } catch {
    return pauseFailure('malformed');
  }
}

function pauseFailure(reason: 'unknown-version' | 'malformed'): DaemonPauseRead {
  return { ok: false, reason, error: reason === 'malformed' ? PAUSE_MALFORMED : PAUSE_VERSION };
}

/** The record when readable, `undefined` otherwise (the caller decides fail-closed). */
export function parseDaemonPauseStateRecord(raw: unknown): DaemonPauseRecord | undefined {
  const read = readDaemonPauseRecord(raw);
  return read.ok ? read.record : undefined;
}

/** Never throws, never echoes: the version 1 stored daemon lease. */
export function readDaemonLeaseRecord(input: unknown): DaemonLeaseRead {
  try {
    const snapshot = readVersionedSnapshot(input, LEASE_REQUIRED_KEYS);
    if (!snapshot.ok) {
      return leaseFailure(snapshot.reason);
    }
    const { scope, holderId, fence, leaseUntilIso } = snapshot.snapshot;
    if (typeof scope !== 'string' || !isValidDaemonLeaseScope(scope)) {
      return leaseFailure('malformed');
    }
    if (!isTickHolderId(holderId)) {
      return leaseFailure('malformed');
    }
    if (!isSafeIntGte(fence, 1)) {
      return leaseFailure('malformed');
    }
    const normalized = normalizeNullableIso(leaseUntilIso);
    if (typeof normalized !== 'string') {
      return leaseFailure('malformed');
    }
    return {
      ok: true,
      record: Object.freeze({
        version: DAEMON_RECORD_VERSION,
        scope,
        holderId,
        fence: fence as number,
        leaseUntilIso: normalized,
      }),
    };
  } catch {
    return leaseFailure('malformed');
  }
}

function leaseFailure(reason: 'unknown-version' | 'malformed'): DaemonLeaseRead {
  return { ok: false, reason, error: reason === 'malformed' ? LEASE_MALFORMED : LEASE_VERSION };
}

/** The record when readable, `undefined` otherwise. */
export function parseDaemonLeaseStateRecord(raw: unknown): DaemonLeaseRecord | undefined {
  const read = readDaemonLeaseRecord(raw);
  return read.ok ? read.record : undefined;
}

/** `1` when any job is refused, else `0`; an empty list exits `0`. */
export function tickExitCodeForJobs(jobs: readonly { outcome: DaemonJobOutcomeKind }[]): 0 | 1 {
  return jobs.some((job) => job.outcome === 'refused') ? 1 : 0;
}

/**
 * The running count of consecutive budget-exhausted outcomes: `budget-exhausted`
 * increments, `skipped` keeps, `completed` and `refused` reset.
 */
export function nextConsecutiveBudgetExhausted(
  previousCount: number,
  outcome: DaemonJobOutcomeKind,
): number {
  const base = isSafeIntGte(previousCount, 0) ? previousCount : 0;
  if (outcome === 'budget-exhausted') {
    return base + 1;
  }
  if (outcome === 'skipped') {
    return base;
  }
  return 0;
}

/**
 * The repository stamp: a pass that ran (any outcome but skip) stamps its own
 * time; a skipped pass keeps the normalized previous stamp, or `null`.
 */
export function resolveRepoLastServedAtIso(
  previousLastServedAtIso: string | null,
  passRanAtIso: string | null,
): string | null {
  if (passRanAtIso !== null && isZonedIsoDateTime(passRanAtIso)) {
    return new Date(passRanAtIso).toISOString();
  }
  return normalizeNullableIso(previousLastServedAtIso) ?? null;
}

/** A reason code: `null`, or a journal-shaped code carrying no secret-shaped text. */
function parseJobReasonCode(value: unknown, outcome: string): string | null | undefined {
  if (outcome === 'budget-exhausted') {
    return value === null ? null : undefined;
  }
  if (value === null) {
    return outcome === 'skipped' || outcome === 'refused' ? undefined : null;
  }
  if (typeof value !== 'string' || !LANE_RUN_JOURNAL_REASON_CODE_PATTERN.test(value)) {
    return undefined;
  }
  return containsSecretShape(value) ? undefined : value;
}

function parseStatusJob(raw: unknown): DaemonJobStatusRecord | null {
  const item = readExactPlainRecord(raw, STATUS_JOB_KEYS);
  if (item === null) {
    return null;
  }
  const jobId = item.jobId;
  if (typeof jobId !== 'string' || parseDaemonJobId(jobId) === null) {
    return null;
  }
  const outcome = item.outcome;
  if (typeof outcome !== 'string' || !(DAEMON_JOB_OUTCOMES as readonly string[]).includes(outcome)) {
    return null;
  }
  const reasonCode = parseJobReasonCode(item.reasonCode, outcome);
  if (reasonCode === undefined) {
    return null;
  }
  if (item.leaseFence !== null && !isSafeIntGte(item.leaseFence, 1)) {
    return null;
  }
  if (!isSafeIntGte(item.durationMs, 0) || !isSafeIntGte(item.consecutiveBudgetExhausted, 0)) {
    return null;
  }
  const nextNotBeforeIso = normalizeNullableIso(item.nextNotBeforeIso);
  if (nextNotBeforeIso === undefined) {
    return null;
  }
  return Object.freeze({
    jobId,
    outcome: outcome as DaemonJobOutcomeKind,
    reasonCode,
    leaseFence: item.leaseFence as number | null,
    durationMs: item.durationMs as number,
    nextNotBeforeIso,
    consecutiveBudgetExhausted: item.consecutiveBudgetExhausted as number,
  });
}

function parseStatusJobs(value: unknown): readonly DaemonJobStatusRecord[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const jobs: DaemonJobStatusRecord[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    const job = parseStatusJob(raw);
    if (job === null || seen.has(job.jobId)) {
      return null;
    }
    seen.add(job.jobId);
    jobs.push(job);
  }
  return jobs;
}

function parseStatusRepository(raw: unknown): DaemonRepositoryStatusRecord | null {
  const item = readExactPlainRecord(raw, STATUS_REPO_KEYS);
  if (item === null) {
    return null;
  }
  const repoDigest = item.repoDigest;
  if (typeof repoDigest !== 'string' || !DAEMON_REPO_DIGEST_PATTERN.test(repoDigest)) {
    return null;
  }
  const lastServedAtIso = normalizeNullableIso(item.lastServedAtIso);
  if (lastServedAtIso === undefined) {
    return null;
  }
  if (!isSafeIntGte(item.queued, 0) || !isSafeIntGte(item.ready, 0) || !isSafeIntGte(item.parked, 0)) {
    return null;
  }
  if (item.headEntryId !== null) {
    if (typeof item.headEntryId !== 'string' || !DAEMON_ENTRY_ID_PATTERN.test(item.headEntryId)) {
      return null;
    }
    if (containsSecretShape(item.headEntryId)) {
      return null;
    }
  }
  if (item.lastMergedHead12 !== null) {
    if (typeof item.lastMergedHead12 !== 'string' || !DAEMON_REPO_DIGEST_PATTERN.test(item.lastMergedHead12)) {
      return null;
    }
  }
  return Object.freeze({
    repoDigest,
    lastServedAtIso,
    queued: item.queued as number,
    ready: item.ready as number,
    parked: item.parked as number,
    headEntryId: item.headEntryId as string | null,
    lastMergedHead12: item.lastMergedHead12 as string | null,
  });
}

function parseStatusRepositories(value: unknown): readonly DaemonRepositoryStatusRecord[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const repositories: DaemonRepositoryStatusRecord[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    const repository = parseStatusRepository(raw);
    if (repository === null || seen.has(repository.repoDigest)) {
      return null;
    }
    seen.add(repository.repoDigest);
    repositories.push(repository);
  }
  return repositories;
}

function parseStatusSnapshot(snapshot: Record<string, unknown>): DaemonStatusRecord | null {
  const tickId = snapshot.tickId;
  if (typeof tickId !== 'string' || !DAEMON_TICK_ID_PATTERN.test(tickId)) {
    return null;
  }
  const startedAtIso = normalizeNullableIso(snapshot.startedAtIso);
  const finishedAtIso = normalizeNullableIso(snapshot.finishedAtIso);
  if (typeof startedAtIso !== 'string' || typeof finishedAtIso !== 'string') {
    return null;
  }
  if (Date.parse(finishedAtIso) < Date.parse(startedAtIso)) {
    return null;
  }
  if (snapshot.exitCode !== 0 && snapshot.exitCode !== 1) {
    return null;
  }
  if (typeof snapshot.paused !== 'boolean' || typeof snapshot.halted !== 'boolean') {
    return null;
  }
  if (typeof snapshot.forgeReachable !== 'boolean' && snapshot.forgeReachable !== null) {
    return null;
  }
  const notifierCursor = snapshot.notifierCursor;
  if (
    notifierCursor !== null &&
    (typeof notifierCursor !== 'string' || !REQUEST_ID_PATTERN.test(notifierCursor))
  ) {
    return null;
  }
  const jobs = parseStatusJobs(snapshot.jobs);
  const repositories = parseStatusRepositories(snapshot.repositories);
  if (jobs === null || repositories === null) {
    return null;
  }
  const exitCode = snapshot.exitCode as 0 | 1;
  if (exitCode === 0 && jobs.some((job) => job.outcome === 'refused')) {
    return null;
  }
  return Object.freeze({
    version: DAEMON_RECORD_VERSION,
    tickId,
    startedAtIso,
    finishedAtIso,
    exitCode,
    paused: snapshot.paused,
    halted: snapshot.halted,
    forgeReachable: snapshot.forgeReachable as boolean | null,
    jobs: Object.freeze(jobs),
    repositories: Object.freeze(repositories),
    notifierCursor: notifierCursor as string | null,
  });
}

function statusFailure(reason: 'unknown-version' | 'malformed'): DaemonStatusRead {
  return { ok: false, reason, error: reason === 'malformed' ? STATUS_MALFORMED : STATUS_VERSION };
}

/** Never throws, never echoes: the version 1 tick status record. */
export function readDaemonStatusRecord(input: unknown): DaemonStatusRead {
  try {
    const snapshot = readVersionedSnapshot(input, STATUS_REQUIRED_KEYS);
    if (!snapshot.ok) {
      return statusFailure(snapshot.reason);
    }
    const record = parseStatusSnapshot(snapshot.snapshot);
    if (record === null) {
      return statusFailure('malformed');
    }
    return { ok: true, record };
  } catch {
    return statusFailure('malformed');
  }
}

/** The record when readable, `undefined` otherwise. */
export function parseDaemonStatusStateRecord(raw: unknown): DaemonStatusRecord | undefined {
  const read = readDaemonStatusRecord(raw);
  return read.ok ? read.record : undefined;
}

/**
 * Builds a status snapshot — the exit code is stamped from the jobs, never
 * passed in — and returns it through the reader, so the builder cannot write a
 * record the reader would refuse.
 */
export function buildDaemonStatusRecord(input: BuildDaemonStatusInput): DaemonStatusRead {
  const snapshot = {
    version: DAEMON_RECORD_VERSION,
    ...input,
    exitCode: tickExitCodeForJobs(input.jobs),
  };
  return readDaemonStatusRecord(snapshot);
}

/** `daemon status` health: exit 0 only with no reason at all. */
export function evaluateDaemonStatusHealth(
  status: DaemonStatusRecord,
  nowIso: string,
  intervalSeconds: number = DAEMON_DEFAULT_INTERVAL_SECONDS,
): DaemonStatusHealth {
  const refusedJobIds = status.jobs
    .filter((job) => job.outcome === 'refused')
    .map((job) => job.jobId);
  const starvedJobIds = status.jobs
    .filter((job) => job.consecutiveBudgetExhausted >= DAEMON_STARVED_CONSECUTIVE_TICKS)
    .map((job) => job.jobId);
  const reasons = healthReasons(status, nowIso, intervalSeconds, refusedJobIds, starvedJobIds);
  const healthy = reasons.length === 0;
  return Object.freeze({
    healthy,
    exitCode: healthy ? 0 : 1,
    reasons: Object.freeze(reasons),
    refusedJobIds: Object.freeze(refusedJobIds),
    starvedJobIds: Object.freeze(starvedJobIds),
  });
}

function healthReasons(
  status: DaemonStatusRecord,
  nowIso: string,
  intervalSeconds: number,
  refusedJobIds: readonly string[],
  starvedJobIds: readonly string[],
): DaemonStatusHealthReason[] {
  if (!isZonedIsoDateTime(nowIso) || !isSafeIntGte(intervalSeconds, 1)) {
    return ['invalid-clock'];
  }
  const reasons: DaemonStatusHealthReason[] = [];
  const gapMs = Date.parse(nowIso) - Date.parse(status.finishedAtIso);
  if (gapMs > DAEMON_STALE_INTERVAL_MULTIPLIER * intervalSeconds * 1_000) {
    reasons.push('stale');
  }
  if (refusedJobIds.length > 0) {
    reasons.push('job-refused');
  }
  if (starvedJobIds.length > 0) {
    reasons.push('starved');
  }
  return reasons;
}
