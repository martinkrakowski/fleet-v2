/**
 * Pure top-to-bottom decision table for the daemon merge pass (plan §3.3,
 * §3.5, §3.6). Cloud workers and a GitHub merge-queue adapter sit behind this
 * same function. No clock, hashing, id minting, environment, filesystem,
 * network or subprocess; it never throws and re-evaluates every fact each
 * tick, reaching `act merge-pr` only when every earlier row is false.
 */

import { isZonedIsoDateTime } from './conductor-halt.js';
import { LANE_RUN_JOURNAL_REASON_CODE_PATTERN } from './lane-run-journal.js';
import { LANE_RUN_MAX_RETRY } from './lane-run-keys.js';
import {
  effectiveVerifiedHeadOid,
  isMergeHex40,
  isMergeQueueEntryLive,
  isMergeSafeId,
  isPlainObject,
  MERGE_VETO_MODES,
  readMergeQueueEntryRecord,
  readMergeVetoRecord,
} from './merge-queue-records.js';
import type {
  MergeDropReason,
  MergeParkReason,
  MergeQueueEntryRecord,
  MergeQueueVetoRecord,
  MergeShadowReason,
  MergeVerifiedBy,
  MergeVetoMode,
} from './merge-queue-records.js';

export const MERGE_QUEUE_DEFAULT_REQUIRED_CONTEXTS: readonly string[] = ['gate', 'premerge'];

export const MERGE_QUEUE_DEFAULT_MAX_ATTEMPTS = LANE_RUN_MAX_RETRY;

export const MERGE_QUEUE_UPDATE_HOURLY_CAP = 3;

export const MERGE_QUEUE_UPDATE_GRACE_MINUTES = 5;
export const MERGE_QUEUE_GATE_GRACE_MINUTES = 5;
export const MERGE_QUEUE_PREMERGE_GRACE_MINUTES = 20;

export const MERGE_QUEUE_BACKOFF_BASE_MS = 30_000;
export const MERGE_QUEUE_BACKOFF_MAX_MS = 30 * 60 * 1000;

export const MERGE_QUEUE_DEFAULT_HOLD_CONFIDENCE = 0.8;

export const MERGE_STATE_STATUSES = ['CLEAN', 'BEHIND', 'BLOCKED', 'DIRTY', 'UNSTABLE', 'UNKNOWN'] as const;
export type MergeStateStatus = (typeof MERGE_STATE_STATUSES)[number];

export const MERGE_FORGE_ERROR_CODES = [
  'protection', 'permission', 'gh-error', 'network', 'http-5xx', 'rate-limit',
] as const;
export type MergeForgeErrorCode = (typeof MERGE_FORGE_ERROR_CODES)[number];

export const MERGE_CONTEXT_STATES = [
  'success', 'pending', 'failure', 'skipped', 'neutral', 'cancelled', 'timed-out',
  'action-required', 'missing',
] as const;
export type MergeContextState = (typeof MERGE_CONTEXT_STATES)[number];

export interface MergeContextFact {
  readonly state: MergeContextState;
  readonly creatorLogin?: string | null;
}

export type MergePrFact =
  | { readonly status: 'open'; readonly headOid: string; readonly mergeStateStatus: MergeStateStatus }
  | { readonly status: 'merged'; readonly headOid: string }
  | { readonly status: 'closed'; readonly headOid: string }
  | { readonly status: 'forge-error'; readonly code: MergeForgeErrorCode }
  | { readonly status: 'unknown' };

export type MergeThreadsFact =
  | { readonly status: 'known'; readonly count: number }
  | { readonly status: 'forge-error'; readonly code: MergeForgeErrorCode }
  | { readonly status: 'unknown' };

export type MergePremergeCarryFact =
  | { readonly status: 'eligible'; readonly receiptHeadOid: string }
  | { readonly status: 'ineligible' }
  | { readonly status: 'unknown' };

export type MergeDisjointnessFact = 'not-applicable' | 'clean' | 'overlap' | 'unknown';

export type MergeMacosVerificationFact =
  | { readonly status: 'none' }
  | { readonly status: 'passed'; readonly receiptHeadOid: string }
  | { readonly status: 'failed' }
  | { readonly status: 'unknown' };

export type MergeLastForgeOutcomeFact =
  | { readonly outcome: 'conflict' }
  | { readonly outcome: 'update-refused' }
  | { readonly outcome: 'forge-error'; readonly code: MergeForgeErrorCode };

export interface MergeStepFacts {
  readonly halted: boolean | 'unreadable';
  readonly paused: boolean | 'unreadable';
  readonly isQueueHead: boolean;
  readonly pr: MergePrFact;
  readonly reReadHeadOid?: string | 'unknown' | null;
  readonly headObservedAtIso: string;
  readonly contexts:
    | Record<string, MergeContextFact>
    | { readonly status: 'forge-error'; readonly code: MergeForgeErrorCode }
    | 'unknown';
  readonly unresolvedThreads: MergeThreadsFact;
  readonly updatesInLastHour: number | 'unknown';
  readonly pendingUpdateSinceIso?: string | null;
  readonly premergeCarry: MergePremergeCarryFact;
  readonly disjointness: MergeDisjointnessFact;
  readonly macosVerification: MergeMacosVerificationFact;
  readonly veto?: MergeQueueVetoRecord | null;
  readonly lastForgeOutcome?: MergeLastForgeOutcomeFact | null;
}

export interface MergeRepoPolicy {
  readonly policyRevision: string;
  readonly shadow?: boolean;
  readonly unattended?: boolean;
  readonly requiredContexts?: readonly string[];
  readonly premergePosterLogin?: string | null;
  readonly updateBranch: boolean;
  readonly updateGraceMinutes?: number;
  readonly macosProcedure?: string | null;
  readonly maxAttempts?: number;
  readonly checksGraceMinutes?: { readonly gate?: number; readonly premerge?: number };
  readonly veto: { readonly mode: MergeVetoMode; readonly holdConfidence?: number };
}

export type MergeStepAction = 'update-branch' | 'premerge-carry' | 'macos-verify' | 'veto' | 'merge-pr';

export type MergeStepExecutionMode = 'live' | 'shadow';

export type MergeStepWaitReason =
  | 'terminal' | 'halted' | 'paused' | 'backoff' | 'updating' | 'checks-pending'
  | 'threads-unknown' | 'not-queue-head' | 'already-merged' | 'pr-unknown'
  | 'checks-unknown' | 'updates-unknown' | 'premerge-carry-unknown' | 'disjointness-unknown'
  | 'merge-state-unknown' | 'merge-state-blocked' | 'macos-unknown' | 'head-reread-unknown'
  | 'unverified-head' | 'facts-inconsistent';

export type MergeStepDecision =
  | {
      readonly kind: 'act';
      readonly action: MergeStepAction;
      readonly execution: MergeStepExecutionMode;
      readonly shadowReason: MergeShadowReason | null;
      readonly expectedHeadOid: string;
      readonly receiptHeadOid: string | null;
      readonly procedure: string | null;
      readonly vetoShadow: 'would-hold' | null;
    }
  | {
      readonly kind: 'enter';
      readonly state: 'ready';
      readonly verifiedHeadOid: string;
      readonly verifiedBy: MergeVerifiedBy;
      readonly policyRevision: string;
    }
  | { readonly kind: 'wait'; readonly reason: MergeStepWaitReason }
  | {
      readonly kind: 'park';
      readonly reason: MergeParkReason;
      readonly detail: string | null;
      readonly backoff: boolean;
      readonly notBeforeIso: string | null;
      readonly nextAttempt: number;
    }
  | { readonly kind: 'drop'; readonly reason: MergeDropReason; readonly detail: string | null }
  | { readonly kind: 'supersede'; readonly liveHeadOid: string };

export type MergeVetoEvaluation = 'act-veto' | 'park-hold' | 'would-hold' | 'pass';

const FACTS_INCONSISTENT: MergeStepDecision = { kind: 'wait', reason: 'facts-inconsistent' };

interface NormalizedMergeRepoPolicy {
  readonly policyRevision: string;
  readonly shadow: boolean;
  readonly unattended: boolean;
  readonly requiredContexts: readonly string[];
  readonly premergePosterLogin: string | null;
  readonly updateBranch: boolean;
  readonly updateGraceMinutes: number;
  readonly macosProcedure: string | null;
  readonly maxAttempts: number;
  readonly gateGraceMinutes: number;
  readonly premergeGraceMinutes: number;
  readonly vetoMode: MergeVetoMode;
  readonly holdConfidence: number;
}

type Read<T> = { readonly ok: true; readonly value: T } | { readonly ok: false };

type StepOutcome =
  | { readonly status: 'done'; readonly decision: MergeStepDecision }
  | { readonly status: 'continue'; readonly deferCarry?: boolean }
  | { readonly status: 'inconsistent' };

const CONTINUE: StepOutcome = { status: 'continue' };
const INCONSISTENT: StepOutcome = { status: 'inconsistent' };

function done(decision: MergeStepDecision): StepOutcome {
  return { status: 'done', decision };
}

function outcomeDecision(outcome: StepOutcome): MergeStepDecision {
  return outcome.status === 'done' ? outcome.decision : FACTS_INCONSISTENT;
}

function waitDecision(reason: MergeStepWaitReason): MergeStepDecision {
  return { kind: 'wait', reason };
}

/** Exponential backoff, doubling from 30s and capped at 30 minutes; null on hostile input. */
export function computeMergeBackoffIso(nowIso: string, attempt: number): string | null {
  try {
    if (!isZonedIsoDateTime(nowIso) || !Number.isSafeInteger(attempt) || attempt < 0) {
      return null;
    }
    const exponent = Math.min(attempt, 10);
    const delayMs = Math.min(MERGE_QUEUE_BACKOFF_BASE_MS * 2 ** exponent, MERGE_QUEUE_BACKOFF_MAX_MS);
    return new Date(Date.parse(nowIso) + delayMs).toISOString();
  } catch {
    return null;
  }
}

/** Detail is either null or a reason-code token; an untrusted string never passes through. */
function sanitizeDetail(detail: string | null): string | null {
  if (detail === null) {
    return null;
  }
  return typeof detail === 'string' && LANE_RUN_JOURNAL_REASON_CODE_PATTERN.test(detail) ? detail : null;
}

function parkNoBackoff(entry: MergeQueueEntryRecord, reason: MergeParkReason, detail: string | null): MergeStepDecision {
  return {
    kind: 'park',
    reason,
    detail: sanitizeDetail(detail),
    backoff: false,
    notBeforeIso: null,
    nextAttempt: entry.attempt,
  };
}

/** Parks with backoff, or drops once the entry has spent its attempts. */
function parkOrDrop(
  entry: MergeQueueEntryRecord,
  policy: NormalizedMergeRepoPolicy,
  nowIso: string,
  parkReason: MergeParkReason,
  dropReason: MergeDropReason,
  detail: string | null,
): MergeStepDecision {
  if (entry.attempt >= policy.maxAttempts) {
    return { kind: 'drop', reason: dropReason, detail: sanitizeDetail(detail) };
  }
  const notBeforeIso = computeMergeBackoffIso(nowIso, entry.attempt);
  if (notBeforeIso === null) {
    return FACTS_INCONSISTENT;
  }
  return {
    kind: 'park',
    reason: parkReason,
    detail: sanitizeDetail(detail),
    backoff: true,
    notBeforeIso,
    nextAttempt: entry.attempt + 1,
  };
}

interface ActInput {
  readonly action: MergeStepAction;
  readonly expectedHeadOid: string;
  readonly receiptHeadOid?: string | null;
  readonly procedure?: string | null;
  readonly oneWayShadowReason: MergeShadowReason | null;
  readonly shadow: boolean;
  readonly vetoShadow?: 'would-hold' | null;
}

/** One-way acts flip to shadow with the repo; macos-verify and veto stay live. */
function actDecision(input: ActInput): MergeStepDecision {
  const useShadow = input.shadow && input.oneWayShadowReason !== null;
  return {
    kind: 'act',
    action: input.action,
    execution: useShadow ? 'shadow' : 'live',
    shadowReason: useShadow && input.oneWayShadowReason !== null ? input.oneWayShadowReason : null,
    expectedHeadOid: input.expectedHeadOid,
    receiptHeadOid: input.receiptHeadOid ?? null,
    procedure: input.procedure ?? null,
    vetoShadow: input.vetoShadow ?? null,
  };
}

function enterReady(verifiedHeadOid: string, verifiedBy: MergeVerifiedBy, policyRevision: string): MergeStepDecision {
  return { kind: 'enter', state: 'ready', verifiedHeadOid, verifiedBy, policyRevision };
}

function readFlag(raw: Record<string, unknown>, key: string): Read<boolean> {
  const value = raw[key];
  if (value === undefined) {
    return { ok: true, value: false };
  }
  return typeof value === 'boolean' ? { ok: true, value } : { ok: false };
}

function readSafeId(raw: Record<string, unknown>, key: string): Read<string | null> {
  const value = raw[key];
  if (value === undefined || value === null) {
    return { ok: true, value: null };
  }
  return typeof value === 'string' && isMergeSafeId(value) ? { ok: true, value } : { ok: false };
}

function readBoundedInt(
  raw: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
  fallback: number,
): Read<number> {
  const value = raw[key];
  if (value === undefined) {
    return { ok: true, value: fallback };
  }
  const ok = typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
  return ok ? { ok: true, value: value as number } : { ok: false };
}

function readGraceMinutes(raw: Record<string, unknown>, key: string, fallback: number): Read<number> {
  const map = raw.checksGraceMinutes;
  if (map === undefined) {
    return { ok: true, value: fallback };
  }
  if (!isPlainObject(map)) {
    return { ok: false };
  }
  const value = map[key];
  if (value === undefined) {
    return { ok: true, value: fallback };
  }
  const ok = typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 1440;
  return ok ? { ok: true, value: value as number } : { ok: false };
}

function readRequiredContexts(raw: Record<string, unknown>): Read<readonly string[]> {
  const value = raw.requiredContexts;
  if (value === undefined) {
    return { ok: true, value: MERGE_QUEUE_DEFAULT_REQUIRED_CONTEXTS };
  }
  if (!Array.isArray(value) || value.length < 1 || value.length > 32) {
    return { ok: false };
  }
  const names: string[] = [];
  for (const element of value) {
    if (typeof element !== 'string' || !isMergeSafeId(element)) {
      return { ok: false };
    }
    if (!names.includes(element)) {
      names.push(element);
    }
  }
  return { ok: true, value: names };
}

function readVetoPolicy(
  raw: Record<string, unknown>,
): Read<{ readonly mode: MergeVetoMode; readonly holdConfidence: number }> {
  const value = raw.veto;
  if (!isPlainObject(value) || !MERGE_VETO_MODES.includes(value.mode as MergeVetoMode)) {
    return { ok: false };
  }
  const confidence = value.holdConfidence;
  if (confidence === undefined) {
    return {
      ok: true,
      value: { mode: value.mode as MergeVetoMode, holdConfidence: MERGE_QUEUE_DEFAULT_HOLD_CONFIDENCE },
    };
  }
  const ok = typeof confidence === 'number' && Number.isFinite(confidence) && confidence >= 0 && confidence <= 1;
  return ok
    ? { ok: true, value: { mode: value.mode as MergeVetoMode, holdConfidence: confidence as number } }
    : { ok: false };
}

/** Fails closed: any unreadable field refuses the whole policy (the caller parks). */
function normalizeRepoPolicy(raw: unknown): NormalizedMergeRepoPolicy | null {
  try {
    if (!isPlainObject(raw)) {
      return null;
    }
    const revision = readSafeId(raw, 'policyRevision');
    if (!revision.ok || revision.value === null || typeof raw.updateBranch !== 'boolean') {
      return null;
    }
    const shadow = readFlag(raw, 'shadow');
    const unattended = readFlag(raw, 'unattended');
    const contexts = readRequiredContexts(raw);
    const poster = readSafeId(raw, 'premergePosterLogin');
    const updateGrace = readBoundedInt(raw, 'updateGraceMinutes', 0, 1440, MERGE_QUEUE_UPDATE_GRACE_MINUTES);
    const procedure = readSafeId(raw, 'macosProcedure');
    const maxAttempts = readBoundedInt(raw, 'maxAttempts', 1, 32, MERGE_QUEUE_DEFAULT_MAX_ATTEMPTS);
    const gateGrace = readGraceMinutes(raw, 'gate', MERGE_QUEUE_GATE_GRACE_MINUTES);
    const premergeGrace = readGraceMinutes(raw, 'premerge', MERGE_QUEUE_PREMERGE_GRACE_MINUTES);
    const vetoPolicy = readVetoPolicy(raw);
    return {
      policyRevision: revision.value,
      shadow: value(shadow),
      unattended: value(unattended),
      requiredContexts: value(contexts),
      premergePosterLogin: value(poster),
      updateBranch: raw.updateBranch as boolean,
      updateGraceMinutes: value(updateGrace),
      macosProcedure: value(procedure),
      maxAttempts: value(maxAttempts),
      gateGraceMinutes: value(gateGrace),
      premergeGraceMinutes: value(premergeGrace),
      vetoMode: value(vetoPolicy).mode,
      holdConfidence: value(vetoPolicy).holdConfidence,
    };
  } catch {
    return null;
  }
}

/** Unwraps a read; the thrown marker is caught by the policy reader and refuses the policy. */
function value<T>(read: Read<T>): T {
  if (!read.ok) {
    throw new Error('unreadable policy field');
  }
  return read.value;
}

function readLifecycleFlag(value: unknown): Read<boolean | 'unreadable'> {
  return typeof value === 'boolean' || value === 'unreadable' ? { ok: true, value } : { ok: false };
}

function isKnownStatus(value: unknown, statuses: readonly string[]): boolean {
  return typeof value === 'string' && statuses.includes(value);
}

/** Shape-only validation; row-level fields (contexts, veto, re-read head) validate in their rows. */
function validateFacts(raw: unknown): Read<MergeStepFacts> {
  try {
    if (!isPlainObject(raw)) {
      return { ok: false };
    }
    const halted = readLifecycleFlag(raw.halted);
    const paused = readLifecycleFlag(raw.paused);
    if (!halted.ok || !paused.ok) {
      return { ok: false };
    }
    if (
      typeof raw.isQueueHead !== 'boolean' ||
      !isZonedIsoDateTime(raw.headObservedAtIso) ||
      !isKnownStatus(raw.disjointness, ['not-applicable', 'clean', 'overlap', 'unknown'])
    ) {
      return { ok: false };
    }
    if (
      !isPlainObject(raw.pr) || !isPlainObject(raw.unresolvedThreads) ||
      !isPlainObject(raw.premergeCarry) || !isPlainObject(raw.macosVerification)
    ) {
      return { ok: false };
    }
    // Status tokens are not shape: an unknown token reaches its row, which
    // treats it as unknown and never acts.
    const updates = raw.updatesInLastHour;
    const updatesOk =
      updates === 'unknown' ||
      (typeof updates === 'number' && Number.isSafeInteger(updates) && updates >= 0 && updates <= 10000);
    if (!updatesOk) {
      return { ok: false };
    }
    return { ok: true, value: raw as unknown as MergeStepFacts };
  } catch {
    return { ok: false };
  }
}

/** A hold needs `hold-for-human` at or above the policy confidence; every other outcome passes. */
export function evaluateMergeVeto(
  veto: MergeQueueVetoRecord | null,
  vetoPolicy: { readonly mode: MergeVetoMode; readonly holdConfidence?: number },
): MergeVetoEvaluation {
  try {
    if (!isPlainObject(vetoPolicy) || vetoPolicy.mode === 'off' || !MERGE_VETO_MODES.includes(vetoPolicy.mode as MergeVetoMode)) {
      return 'pass';
    }
    const threshold = vetoPolicy.holdConfidence === undefined ? MERGE_QUEUE_DEFAULT_HOLD_CONFIDENCE : vetoPolicy.holdConfidence;
    if (typeof threshold !== 'number' || !Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
      return 'pass';
    }
    if (veto === null) {
      return 'act-veto';
    }
    const confidence = veto.confidence;
    const holds =
      veto.outcome === 'hold-for-human' &&
      confidence !== null &&
      typeof confidence === 'number' &&
      confidence >= threshold;
    if (!holds) {
      return 'pass';
    }
    return vetoPolicy.mode === 'live' ? 'park-hold' : 'would-hold';
  } catch {
    return 'pass';
  }
}

/** A moved PR or re-read head supersedes the entry before any other row runs. */
function detectSupersede(entry: MergeQueueEntryRecord, facts: MergeStepFacts): StepOutcome {
  const pr = facts.pr;
  if (pr.status === 'open' || pr.status === 'merged' || pr.status === 'closed') {
    if (!isMergeHex40(pr.headOid)) {
      return INCONSISTENT;
    }
    if (pr.headOid !== entry.headOid) {
      return done({ kind: 'supersede', liveHeadOid: pr.headOid });
    }
  }
  const reRead = facts.reReadHeadOid;
  if (reRead !== undefined && reRead !== null && reRead !== 'unknown') {
    if (!isMergeHex40(reRead)) {
      return INCONSISTENT;
    }
    if (reRead !== entry.headOid) {
      return done({ kind: 'supersede', liveHeadOid: reRead });
    }
  }
  return CONTINUE;
}

/** Halt wins over pause; a future not-before waits before the policy is even read. */
function decideGuards(entry: MergeQueueEntryRecord, facts: MergeStepFacts, nowIso: string): MergeStepDecision | null {
  if (facts.halted !== false) {
    return waitDecision('halted');
  }
  if (facts.paused !== false) {
    return waitDecision('paused');
  }
  const notBeforeIso = entry.notBeforeIso;
  if (notBeforeIso !== null && Date.parse(nowIso) < Date.parse(notBeforeIso)) {
    return waitDecision('backoff');
  }
  return null;
}

type ForgeSignal = { readonly kind: 'conflict' | 'update-refused' } | { readonly kind: 'forge-error'; readonly code: string };

function isForgeErrorCode(value: unknown): value is MergeForgeErrorCode {
  return typeof value === 'string' && MERGE_FORGE_ERROR_CODES.includes(value as MergeForgeErrorCode);
}

function readForgeSignal(raw: unknown): ForgeSignal | null {
  if (!isPlainObject(raw)) {
    return null;
  }
  if (raw.outcome === 'conflict' || raw.outcome === 'update-refused') {
    return { kind: raw.outcome };
  }
  if (raw.outcome === 'forge-error' && isForgeErrorCode(raw.code)) {
    return { kind: 'forge-error', code: raw.code };
  }
  return null;
}

function forgeDecision(
  entry: MergeQueueEntryRecord,
  policy: NormalizedMergeRepoPolicy,
  nowIso: string,
  signal: ForgeSignal,
): MergeStepDecision {
  if (signal.kind === 'conflict') {
    return { kind: 'drop', reason: 'conflict', detail: null };
  }
  if (signal.kind === 'update-refused') {
    return parkNoBackoff(entry, 'update-refused', null);
  }
  return parkOrDrop(
    entry, policy, nowIso, 'forge-error', 'forge-error-exhausted',
    signal.kind === 'forge-error' ? signal.code : null,
  );
}

/** One read-path forge-error fact, parked with backoff or dropped at the cap. */
function forgeErrorPark(
  entry: MergeQueueEntryRecord,
  policy: NormalizedMergeRepoPolicy,
  nowIso: string,
  code: unknown,
): MergeStepDecision {
  return isForgeErrorCode(code)
    ? parkOrDrop(entry, policy, nowIso, 'forge-error', 'forge-error-exhausted', code)
    : FACTS_INCONSISTENT;
}

/** The first read-path forge error: the PR read, then contexts, then threads. */
function readPathForgeStep(
  entry: MergeQueueEntryRecord,
  facts: MergeStepFacts,
  policy: NormalizedMergeRepoPolicy,
  nowIso: string,
): MergeStepDecision | null {
  const pr = facts.pr;
  if (pr.status === 'forge-error') {
    return forgeErrorPark(entry, policy, nowIso, pr.code);
  }
  const contexts = facts.contexts;
  const container = contexts !== 'unknown' && isPlainObject(contexts) ? (contexts as Record<string, unknown>) : null;
  if (container !== null && container.status === 'forge-error') {
    return forgeErrorPark(entry, policy, nowIso, container.code);
  }
  const threads = facts.unresolvedThreads;
  if (threads.status === 'forge-error') {
    return forgeErrorPark(entry, policy, nowIso, threads.code);
  }
  return null;
}

/** Rows 6 and 7: the recorded outcome first, then the first read-path forge error. */
function forgeOutcomeStep(
  entry: MergeQueueEntryRecord,
  facts: MergeStepFacts,
  policy: NormalizedMergeRepoPolicy,
  nowIso: string,
): MergeStepDecision | null {
  const recorded = facts.lastForgeOutcome;
  if (recorded !== undefined && recorded !== null) {
    const signal = readForgeSignal(recorded);
    return signal === null ? FACTS_INCONSISTENT : forgeDecision(entry, policy, nowIso, signal);
  }
  return readPathForgeStep(entry, facts, policy, nowIso);
}

/** Row 8: terminal PR facts stop before the update row. */
function prStatusStep(facts: MergeStepFacts): MergeStepDecision | null {
  const status = facts.pr.status;
  if (status === 'unknown') {
    return waitDecision('pr-unknown');
  }
  if (status === 'merged') {
    return waitDecision('already-merged');
  }
  if (status === 'closed') {
    return { kind: 'drop', reason: 'closed', detail: null };
  }
  return null;
}

function isPremergeGreen(fact: MergeContextFact, name: string, policy: NormalizedMergeRepoPolicy): boolean {
  if (name !== 'premerge') {
    return true;
  }
  const creator = fact.creatorLogin;
  return creator !== null && creator !== undefined && creator === policy.premergePosterLogin;
}

function contextGraceMinutes(name: string, policy: NormalizedMergeRepoPolicy): number {
  if (name === 'gate') {
    return policy.gateGraceMinutes;
  }
  return name === 'premerge' ? policy.premergeGraceMinutes : 0;
}

type ContextVerdict = 'green' | 'pending' | 'failed' | 'defer-carry';

function classifyContext(
  fact: MergeContextFact,
  name: string,
  entry: MergeQueueEntryRecord,
  policy: NormalizedMergeRepoPolicy,
  elapsedMs: number,
): ContextVerdict {
  if (fact.state === 'pending') {
    return 'pending';
  }
  if (fact.state === 'success') {
    return isPremergeGreen(fact, name, policy) ? 'green' : 'failed';
  }
  if (fact.state === 'missing') {
    if (name === 'premerge' && entry.tier === 2 && entry.enqueuedBy === 'update') {
      return 'defer-carry';
    }
    return elapsedMs < contextGraceMinutes(name, policy) * 60_000 ? 'pending' : 'failed';
  }
  return 'failed';
}

/** Reads the own enumerable descriptor so a hostile getter never runs. */
function readContextFact(container: Record<string, unknown>, name: string): Read<MergeContextFact> {
  const descriptor = Reflect.getOwnPropertyDescriptor(container, name);
  if (descriptor === undefined) {
    return { ok: true, value: { state: 'missing' } };
  }
  if (!descriptor.enumerable || !isPlainObject(descriptor.value)) {
    return { ok: false };
  }
  const value = descriptor.value as Record<string, unknown>;
  if (!isKnownStatus(value.state, MERGE_CONTEXT_STATES)) {
    return { ok: false };
  }
  const creator = value.creatorLogin;
  if (creator !== undefined && creator !== null && typeof creator !== 'string') {
    return { ok: false };
  }
  return { ok: true, value: { state: value.state as MergeContextState, creatorLogin: creator as string | null | undefined } };
}

interface ChecksOutcome {
  readonly decision: MergeStepDecision | null;
  readonly deferCarry: boolean;
}

/** Row 10: pending wins over failure and over the premerge carry deferral. */
function checksStep(
  entry: MergeQueueEntryRecord,
  facts: MergeStepFacts,
  policy: NormalizedMergeRepoPolicy,
  nowIso: string,
  nowMs: number,
): ChecksOutcome {
  const contexts = facts.contexts;
  if (contexts === 'unknown') {
    return { decision: waitDecision('checks-unknown'), deferCarry: false };
  }
  if (!isPlainObject(contexts)) {
    return { decision: FACTS_INCONSISTENT, deferCarry: false };
  }
  const elapsedMs = nowMs - Date.parse(facts.headObservedAtIso);
  let anyPending = false;
  let firstFailed: string | null = null;
  let deferCarry = false;
  for (const name of policy.requiredContexts) {
    const read = readContextFact(contexts, name);
    if (!read.ok) {
      return { decision: FACTS_INCONSISTENT, deferCarry: false };
    }
    const verdict = classifyContext(read.value, name, entry, policy, elapsedMs);
    if (verdict === 'pending') {
      anyPending = true;
    } else if (verdict === 'failed' && firstFailed === null) {
      firstFailed = name;
    } else if (verdict === 'defer-carry') {
      deferCarry = true;
    }
  }
  if (anyPending) {
    return { decision: waitDecision('checks-pending'), deferCarry: false };
  }
  if (firstFailed !== null) {
    return { decision: parkOrDrop(entry, policy, nowIso, 'checks', 'checks', firstFailed), deferCarry: false };
  }
  return { decision: null, deferCarry };
}

const VETO_UNREADABLE: unique symbol = Symbol('merge-veto-unreadable');

type ResolvedVeto = MergeQueueVetoRecord | null | typeof VETO_UNREADABLE;

/** Row 11: the fact overrides the stored record when it is present at all. */
function resolveVeto(entry: MergeQueueEntryRecord, facts: MergeStepFacts): ResolvedVeto {
  if (facts.veto === undefined) {
    return entry.veto;
  }
  const read = readMergeVetoRecord(facts.veto);
  return read.ok ? read.veto : VETO_UNREADABLE;
}

function threadsStep(entry: MergeQueueEntryRecord, facts: MergeStepFacts): MergeStepDecision | null {
  const threads = facts.unresolvedThreads;
  if (threads.status === 'unknown') {
    return waitDecision('threads-unknown');
  }
  if (threads.status !== 'known') {
    return FACTS_INCONSISTENT;
  }
  const count = threads.count;
  if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0 || count > 100000) {
    return FACTS_INCONSISTENT;
  }
  return count > 0 ? parkNoBackoff(entry, 'threads', null) : null;
}

function carryStep(
  entry: MergeQueueEntryRecord,
  facts: MergeStepFacts,
  policy: NormalizedMergeRepoPolicy,
): MergeStepDecision | null {
  const carry = facts.premergeCarry;
  if (carry.status === 'unknown') {
    return waitDecision('premerge-carry-unknown');
  }
  if (carry.status === 'ineligible') {
    return parkNoBackoff(entry, 'premerge', null);
  }
  if (carry.status === 'eligible') {
    if (!isMergeHex40(carry.receiptHeadOid)) {
      return FACTS_INCONSISTENT;
    }
    return actDecision({
      action: 'premerge-carry',
      expectedHeadOid: entry.headOid,
      receiptHeadOid: carry.receiptHeadOid,
      oneWayShadowReason: 'would-post-status',
      shadow: policy.shadow,
    });
  }
  return FACTS_INCONSISTENT;
}

function disjointnessStep(entry: MergeQueueEntryRecord, facts: MergeStepFacts): MergeStepDecision | null {
  if (facts.disjointness === 'overlap') {
    return parkNoBackoff(entry, 'disjointness', null);
  }
  return facts.disjointness === 'unknown' ? waitDecision('disjointness-unknown') : null;
}

function staysParked(entry: MergeQueueEntryRecord, policy: NormalizedMergeRepoPolicy, verdict: MergeVetoEvaluation): boolean {
  const procedureSatisfied = policy.macosProcedure === null || entry.verifiedBy === 'procedure';
  return procedureSatisfied && (verdict === 'park-hold' || (!policy.unattended && !policy.shadow));
}

/** Row 15: record readiness, re-enter a parked entry that no longer holds, or keep it parked. */
function readyRow(
  entry: MergeQueueEntryRecord,
  facts: MergeStepFacts,
  policy: NormalizedMergeRepoPolicy,
  verdict: MergeVetoEvaluation,
): MergeStepDecision | null {
  const pr = facts.pr;
  if (pr.status !== 'open') {
    return FACTS_INCONSISTENT;
  }
  if (pr.mergeStateStatus === 'UNKNOWN') {
    return waitDecision('merge-state-unknown');
  }
  if (pr.mergeStateStatus !== 'CLEAN') {
    return waitDecision('merge-state-blocked');
  }
  const recorded = entry.verifiedHeadOid === entry.headOid && entry.verifiedBy !== null && entry.policyRevision === policy.policyRevision;
  if (!recorded) {
    return enterReady(entry.headOid, 'contexts', policy.policyRevision);
  }
  if (entry.state === 'parked') {
    if (staysParked(entry, policy, verdict)) {
      // The reason it stays parked, not the stale reason it was parked for.
      return parkNoBackoff(entry, verdict === 'park-hold' ? 'veto-hold' : 'owner-merge', null);
    }
    return enterReady(entry.verifiedHeadOid as string, entry.verifiedBy as MergeVerifiedBy, entry.policyRevision as string);
  }
  return null;
}

/** Row 16: the recorded macOS procedure; only a head-matching pass continues toward the merge. */
function macosRow(
  entry: MergeQueueEntryRecord,
  facts: MergeStepFacts,
  policy: NormalizedMergeRepoPolicy,
  nowIso: string,
): MergeStepDecision | null {
  if (policy.macosProcedure === null) {
    return null;
  }
  const verification = facts.macosVerification;
  if (verification.status === 'passed') {
    if (!isMergeHex40(verification.receiptHeadOid)) {
      return FACTS_INCONSISTENT;
    }
    if (verification.receiptHeadOid !== entry.headOid) {
      return waitDecision('macos-unknown');
    }
    if (entry.verifiedBy !== 'procedure' || entry.verifiedHeadOid !== entry.headOid) {
      return enterReady(entry.headOid, 'procedure', policy.policyRevision);
    }
    return null;
  }
  if (verification.status === 'failed') {
    return parkOrDrop(entry, policy, nowIso, 'macos', 'macos', null);
  }
  if (!facts.isQueueHead) {
    return waitDecision('not-queue-head');
  }
  if (verification.status === 'unknown') {
    return waitDecision('macos-unknown');
  }
  if (verification.status === 'none') {
    return actDecision({
      action: 'macos-verify',
      expectedHeadOid: entry.headOid,
      procedure: policy.macosProcedure,
      oneWayShadowReason: null,
      shadow: policy.shadow,
    });
  }
  return FACTS_INCONSISTENT;
}

/** Row 17: the veto verdict, the owner gate and the final head re-read gate the merge. */
function finalRow(
  entry: MergeQueueEntryRecord,
  facts: MergeStepFacts,
  policy: NormalizedMergeRepoPolicy,
  verdict: MergeVetoEvaluation,
): MergeStepDecision {
  const verifiedHead = effectiveVerifiedHeadOid(entry, { requiresProcedure: policy.macosProcedure !== null });
  if (verifiedHead === null) {
    return waitDecision('unverified-head');
  }
  if (verdict === 'act-veto') {
    return actDecision({ action: 'veto', expectedHeadOid: verifiedHead, oneWayShadowReason: null, shadow: policy.shadow });
  }
  if (verdict === 'park-hold') {
    return parkNoBackoff(entry, 'veto-hold', null);
  }
  if (!policy.unattended && !policy.shadow) {
    return parkNoBackoff(entry, 'owner-merge', null);
  }
  const reRead = facts.reReadHeadOid;
  if (reRead === 'unknown' || reRead === null) {
    return waitDecision('head-reread-unknown');
  }
  const pr = facts.pr;
  if (pr.status !== 'open') {
    return FACTS_INCONSISTENT;
  }
  const liveHead = reRead === undefined ? pr.headOid : reRead;
  if (liveHead !== entry.headOid || liveHead !== verifiedHead) {
    return waitDecision('unverified-head');
  }
  return actDecision({
    action: 'merge-pr',
    expectedHeadOid: verifiedHead,
    oneWayShadowReason: 'would-merge',
    shadow: policy.shadow,
    vetoShadow: verdict === 'would-hold' ? 'would-hold' : null,
  });
}

/** Rows 15 through 17, in order; each row may stop the pass. */
function readyRowsStep(
  entry: MergeQueueEntryRecord,
  facts: MergeStepFacts,
  policy: NormalizedMergeRepoPolicy,
  nowIso: string,
  verdict: MergeVetoEvaluation,
): MergeStepDecision {
  const ready = readyRow(entry, facts, policy, verdict);
  if (ready !== null) {
    return ready;
  }
  const macos = macosRow(entry, facts, policy, nowIso);
  return macos !== null ? macos : finalRow(entry, facts, policy, verdict);
}

/** Rows 6 through 14 in order, then the ready rows. */
function decideRows(
  entry: MergeQueueEntryRecord,
  facts: MergeStepFacts,
  policy: NormalizedMergeRepoPolicy,
  nowIso: string,
): MergeStepDecision {
  const nowMs = Date.parse(nowIso);
  const forge = forgeOutcomeStep(entry, facts, policy, nowIso);
  if (forge !== null) {
    return forge;
  }
  const pr = prStatusStep(facts);
  if (pr !== null) {
    return pr;
  }
  const update = updateRowStep(entry, facts, policy, nowMs);
  if (update !== null) {
    return update;
  }
  const checks = checksStep(entry, facts, policy, nowIso, nowMs);
  if (checks.decision !== null) {
    return checks.decision;
  }
  const veto = resolveVeto(entry, facts);
  if (veto === VETO_UNREADABLE) {
    return FACTS_INCONSISTENT;
  }
  const verdict = evaluateMergeVeto(veto, { mode: policy.vetoMode, holdConfidence: policy.holdConfidence });
  const threads = threadsStep(entry, facts);
  if (threads !== null) {
    return threads;
  }
  if (checks.deferCarry) {
    const carry = carryStep(entry, facts, policy);
    if (carry !== null) {
      return carry;
    }
  }
  const disjoint = disjointnessStep(entry, facts);
  return disjoint !== null ? disjoint : readyRowsStep(entry, facts, policy, nowIso, verdict);
}

/**
 * Row 9: the update row on an open PR. `DIRTY` drops here; only `BEHIND`
 * with room under the hourly cap acts.
 */
function updateRowStep(
  entry: MergeQueueEntryRecord,
  facts: MergeStepFacts,
  policy: NormalizedMergeRepoPolicy,
  nowMs: number,
): MergeStepDecision | null {
  const pr = facts.pr;
  if (pr.status !== 'open') {
    return FACTS_INCONSISTENT;
  }
  if (!isKnownStatus(pr.mergeStateStatus, MERGE_STATE_STATUSES)) {
    return FACTS_INCONSISTENT;
  }
  const pendingSince = facts.pendingUpdateSinceIso;
  if (pendingSince !== undefined && pendingSince !== null) {
    if (!isZonedIsoDateTime(pendingSince)) {
      return FACTS_INCONSISTENT;
    }
    if (nowMs - Date.parse(pendingSince) < policy.updateGraceMinutes * 60_000) {
      return waitDecision('updating');
    }
  }
  if (pr.mergeStateStatus === 'DIRTY') {
    return { kind: 'drop', reason: 'conflict', detail: null };
  }
  if (pr.mergeStateStatus !== 'BEHIND') {
    return null;
  }
  if (!policy.updateBranch) {
    return parkNoBackoff(entry, 'update-refused', null);
  }
  if (facts.updatesInLastHour === 'unknown') {
    return waitDecision('updates-unknown');
  }
  if (facts.updatesInLastHour >= MERGE_QUEUE_UPDATE_HOURLY_CAP) {
    return parkNoBackoff(entry, 'update-churn', null);
  }
  return actDecision({
    action: 'update-branch',
    expectedHeadOid: entry.headOid,
    oneWayShadowReason: 'would-update-branch',
    shadow: policy.shadow,
  });
}

/**
 * The one decision the daemon merge pass takes for an entry this tick
 * (plan §3.3). Fails closed: every hostile input reads as `facts-inconsistent`
 * and unknown facts never merge. Always returns a decision, never throws.
 */
export function decideMergeStep(
  entry: unknown,
  facts: unknown,
  repoPolicy: MergeRepoPolicy | null,
  nowIso: string,
): MergeStepDecision {
  try {
    const read = readMergeQueueEntryRecord(entry);
    if (!read.ok || !isZonedIsoDateTime(nowIso)) {
      return FACTS_INCONSISTENT;
    }
    const validated = validateFacts(facts);
    if (!validated.ok) {
      return FACTS_INCONSISTENT;
    }
    const record = read.record;
    if (!isMergeQueueEntryLive(record)) {
      return waitDecision('terminal');
    }
    const superseded = detectSupersede(record, validated.value);
    if (superseded.status !== 'continue') {
      return outcomeDecision(superseded);
    }
    const guarded = decideGuards(record, validated.value, nowIso);
    if (guarded !== null) {
      return guarded;
    }
    const policy = normalizeRepoPolicy(repoPolicy);
    if (policy === null) {
      return parkNoBackoff(record, 'policy-unreadable', null);
    }
    return decideRows(record, validated.value, policy, nowIso);
  } catch {
    return FACTS_INCONSISTENT;
  }
}
