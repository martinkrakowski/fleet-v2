/**
 * WB12a: the lane history read model (part 1). One pure, read-only function
 * that turns a lane's recorded attempts and their review receipts into a
 * history: attempts in order (seat, stop reason, usage), and review rounds
 * grouped per head with finding counts (work-board plan §3.12). Nothing is
 * written, nothing is called, and no git, forge or runner is touched. The
 * inputs are `unknown` on purpose: the function validates them at runtime and
 * never throws. The receipt shapes are mirrored from
 * `AcceptanceReceiptReadPort` (application) without importing it: the domain
 * never depends on `application/`.
 */

import { parseStopReason } from './value-objects/StopReason.vo.js';
import type { StopReasonValue } from './value-objects/StopReason.vo.js';
import { ATTEMPT_STATES } from './value-objects/AttemptState.vo.js';
import type { AttemptStateValue } from './value-objects/AttemptState.vo.js';
import { SEAT_PLAN_ROLES } from './value-objects/SeatPlan.vo.js';
import { isPlainText, parseTimeMs } from './work-board-facts.js';

/** Version of the derived history shape; bumped when the output types change. */
export const LANE_HISTORY_SCHEMA_VERSION = 1 as const;
/** Maximum number of attempts (and receipt readings) a history may hold. */
export const LANE_HISTORY_MAX_ATTEMPTS = 500;
/** Maximum number of review rows accepted for one attempt reading. */
export const LANE_HISTORY_MAX_RECEIPTS_PER_ATTEMPT = 100;
/** Maximum length of a head commit string. */
export const LANE_HISTORY_MAX_HEAD_LENGTH = 64;

/** The review kinds of one review receipt, mirrored from the acceptance port. */
type ReceiptReviewKind = 'brief-check' | 'code-review' | 'pre-merge';
/** The result of one review receipt, mirrored from the acceptance port. */
type ReceiptResult = 'pending' | 'pass' | 'fail' | 'unknown' | 'not-applicable';

const RECEIPT_REVIEW_KINDS: readonly string[] = ['brief-check', 'code-review', 'pre-merge'];
const RECEIPT_RESULTS: readonly string[] = ['pending', 'pass', 'fail', 'unknown', 'not-applicable'];
const RECEIPT_OUTCOMES: readonly string[] = ['found', 'none', 'unavailable'];
const USAGE_MEASURED_SOURCES: readonly string[] = ['opencode-db', 'opencode-api'];
const SEAT_ROLE_VALUES: readonly string[] = SEAT_PLAN_ROLES;
const ATTEMPT_STATE_VALUES: readonly string[] = ATTEMPT_STATES;

const HEAD_COMMIT_PATTERN = new RegExp(`^[0-9a-f]{7,${LANE_HISTORY_MAX_HEAD_LENGTH}}$`);
const MAX_ATTEMPT_ID_LENGTH = 200;

export interface LaneHistory {
  readonly schemaVersion: typeof LANE_HISTORY_SCHEMA_VERSION;
  readonly attempts: readonly LaneHistoryAttempt[];
  readonly heads: readonly LaneHistoryHead[];
}

export interface LaneHistoryAttempt {
  readonly attemptId: string;
  readonly kind: 'initial' | 'fix';
  readonly fixNumber: number;
  readonly priorAttemptId: string | null;
  readonly state: AttemptStateValue;
  readonly createdAtIso: string;
  readonly stopReason: StopReasonValue;
  readonly seatRole: string | null;
  readonly model: string | null;
  readonly headCommit: string | null;
  readonly usage: LaneHistoryUsage;
}

export type LaneHistoryUsage =
  | { readonly status: 'not-measured' }
  | { readonly status: 'unavailable' }
  | {
      readonly status: 'measured';
      readonly costUsd: number | null;
      readonly steps: number | null;
      readonly tokensInput: number | null;
      readonly tokensOutput: number | null;
      readonly runnerMinutes: number | null;
    };

export interface LaneHistoryHead {
  readonly headCommit: string;
  readonly attemptIds: readonly string[];
  readonly reviewStatus: 'read' | 'none' | 'unknown';
  readonly rounds: readonly LaneHistoryReviewRound[];
}

/** Domain-local mirror of the port's `ReviewReceiptProjection`; `receiptId` is ignored and never output. */
interface ReviewReceiptRowMirror {
  readonly kind: ReceiptReviewKind;
  readonly result: ReceiptResult;
  readonly findings: { readonly blocker: number; readonly major: number; readonly minor: number; readonly nit: number };
  readonly completedAtIso: string;
}

export interface LaneHistoryReviewRound {
  readonly kind: ReceiptReviewKind;
  readonly result: ReceiptResult;
  readonly blocker: number;
  readonly major: number;
  readonly minor: number;
  readonly nit: number;
  readonly completedAtIso: string;
}

export type LaneHistoryResult =
  | { readonly ok: true; readonly history: LaneHistory }
  | { readonly ok: false; readonly reason: 'invalid-input' | 'too-large' | 'unreadable-input' };

/** One receipt reading: keyed by attempt, only `found` readings carry rounds. */
interface ParsedReading {
  readonly attemptId: string;
  readonly outcome: 'found' | 'none' | 'unavailable';
  readonly rounds: readonly LaneHistoryReviewRound[];
}

type AttemptsParseResult =
  | { readonly ok: true; readonly value: LaneHistoryAttempt[] }
  | { readonly ok: false; readonly reason: 'invalid-input' | 'too-large' };

type ReceiptsParseResult =
  | { readonly ok: true; readonly readings: ParsedReading[] }
  | { readonly ok: false; readonly reason: 'invalid-input' | 'too-large' };

/**
 * Derive the lane history from unknown attempt and receipt inputs. The whole
 * body is guarded: any throw (a poisoned getter, an unreadable store value) is
 * a typed `unreadable-input` refusal, never an exception.
 */
export function deriveLaneHistory(attempts: unknown, receipts: unknown): LaneHistoryResult {
  try {
    const parsedAttempts = parseAttempts(attempts);
    if (!parsedAttempts.ok) {
      return parsedAttempts;
    }
    const parsedReceipts = parseReceipts(receipts);
    if (!parsedReceipts.ok) {
      return parsedReceipts;
    }
    return { ok: true, history: buildHistory(parsedAttempts.value, parsedReceipts.readings) };
  } catch {
    return { ok: false, reason: 'unreadable-input' };
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isAttemptStateValue(value: unknown): value is AttemptStateValue {
  return typeof value === 'string' && ATTEMPT_STATE_VALUES.includes(value);
}

function isReceiptReviewKind(value: unknown): value is ReceiptReviewKind {
  return typeof value === 'string' && RECEIPT_REVIEW_KINDS.includes(value);
}

function isReceiptResult(value: unknown): value is ReceiptResult {
  return typeof value === 'string' && RECEIPT_RESULTS.includes(value);
}

function isReceiptOutcome(value: unknown): value is ParsedReading['outcome'] {
  return typeof value === 'string' && RECEIPT_OUTCOMES.includes(value);
}

function parseAttempts(input: unknown): AttemptsParseResult {
  if (!Array.isArray(input)) {
    return { ok: false, reason: 'invalid-input' };
  }
  if (input.length > LANE_HISTORY_MAX_ATTEMPTS) {
    return { ok: false, reason: 'too-large' };
  }
  const seenIds = new Set<string>();
  const attempts: LaneHistoryAttempt[] = [];
  for (let index = 0; index < input.length; index += 1) {
    if (Object.getOwnPropertyDescriptor(input, index) === undefined) {
      return { ok: false, reason: 'invalid-input' };
    }
    const parsed = parseAttempt(input[index]);
    if (parsed === null) {
      return { ok: false, reason: 'invalid-input' };
    }
    if (seenIds.has(parsed.attemptId)) {
      return { ok: false, reason: 'invalid-input' };
    }
    seenIds.add(parsed.attemptId);
    attempts.push(parsed);
  }
  attempts.sort(compareAttempts);
  return { ok: true, value: attempts };
}

function parseAttempt(raw: unknown): LaneHistoryAttempt | null {
  if (!isObject(raw)) {
    return null;
  }
  const id = raw.id;
  if (typeof id !== 'string' || id.length === 0 || id.length > MAX_ATTEMPT_ID_LENGTH) {
    return null;
  }
  const kind = raw.kind;
  if (kind !== 'initial' && kind !== 'fix') {
    return null;
  }
  const fixNumber = raw.fixNumber;
  if (!isNonNegativeSafeInteger(fixNumber)) {
    return null;
  }
  const state = raw.state;
  if (!isAttemptStateValue(state)) {
    return null;
  }
  const createdAtIsoRaw = raw.createdAtIso;
  if (typeof createdAtIsoRaw !== 'string') {
    return null;
  }
  const createdAtMs = parseTimeMs(createdAtIsoRaw);
  if (createdAtMs === null) {
    return null;
  }
  const createdAtIso = new Date(createdAtMs).toISOString();
  const priorRaw = raw.priorAttemptId;
  const priorAttemptId = priorRaw === undefined ? null : priorRaw;
  if (priorAttemptId !== null && typeof priorAttemptId !== 'string') {
    return null;
  }
  const head = readHeadCommit(raw);
  if (!head.valid) {
    return null;
  }
  const usage = readUsage(raw);
  if (usage === null) {
    return null;
  }
  return {
    attemptId: id,
    kind,
    fixNumber,
    priorAttemptId,
    state,
    createdAtIso,
    stopReason: parseStopReason(raw.stopReason),
    seatRole: readSeatRole(raw),
    model: readModel(raw),
    headCommit: head.value,
    usage,
  };
}

function readHeadCommit(
  raw: Record<string, unknown>,
): { readonly valid: true; readonly value: string | null } | { readonly valid: false } {
  const artifacts = raw.artifacts;
  if (artifacts === undefined || artifacts === null) {
    return { valid: true, value: null };
  }
  if (!isObject(artifacts)) {
    return { valid: false };
  }
  const head = artifacts.headCommit;
  if (head === undefined || head === null) {
    return { valid: true, value: null };
  }
  if (typeof head !== 'string' || !HEAD_COMMIT_PATTERN.test(head)) {
    return { valid: false };
  }
  return { valid: true, value: head };
}

function readSeatRole(raw: Record<string, unknown>): string | null {
  const selection = raw.seatSelection;
  if (selection === undefined || selection === null || !isObject(selection)) {
    return null;
  }
  const role = selection.role;
  return typeof role === 'string' && SEAT_ROLE_VALUES.includes(role) ? role : null;
}

function readModel(raw: Record<string, unknown>): string | null {
  const runner = raw.runner;
  const runnerModel = runner !== undefined && runner !== null && isObject(runner) ? runner.model : undefined;
  const selection = raw.seatSelection;
  const seatModel = selection !== undefined && selection !== null && isObject(selection) ? selection.model : undefined;
  const candidate = typeof runnerModel === 'string' ? runnerModel : typeof seatModel === 'string' ? seatModel : null;
  if (candidate === null) {
    return null;
  }
  return isPlainText(candidate) ? candidate : null;
}

function readUsage(raw: Record<string, unknown>): LaneHistoryUsage | null {
  const usage = raw.usage;
  if (usage === undefined || usage === null) {
    return { status: 'not-measured' };
  }
  if (!isObject(usage)) {
    return null;
  }
  const source = usage.source;
  if (source === 'unavailable') {
    return { status: 'unavailable' };
  }
  if (!USAGE_MEASURED_SOURCES.includes(source as string)) {
    return null;
  }
  const costUsd = readMeasuredNumber(usage.costUsd);
  const steps = readMeasuredNumber(usage.steps);
  const tokensInput = readMeasuredNumber(usage.tokensInput);
  const tokensOutput = readMeasuredNumber(usage.tokensOutput);
  const runnerMinutes = readMeasuredNumber(usage.runnerMinutes);
  if (
    costUsd === 'invalid' ||
    steps === 'invalid' ||
    tokensInput === 'invalid' ||
    tokensOutput === 'invalid' ||
    runnerMinutes === 'invalid'
  ) {
    return null;
  }
  return { status: 'measured', costUsd, steps, tokensInput, tokensOutput, runnerMinutes };
}

function readMeasuredNumber(value: unknown): number | null | 'invalid' {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return value;
  }
  return 'invalid';
}

function parseReceipts(input: unknown): ReceiptsParseResult {
  if (!Array.isArray(input)) {
    return { ok: false, reason: 'invalid-input' };
  }
  if (input.length > LANE_HISTORY_MAX_ATTEMPTS) {
    return { ok: false, reason: 'too-large' };
  }
  const seenAttemptIds = new Set<string>();
  const readings: ParsedReading[] = [];
  for (let index = 0; index < input.length; index += 1) {
    if (Object.getOwnPropertyDescriptor(input, index) === undefined) {
      return { ok: false, reason: 'invalid-input' };
    }
    const raw = input[index];
    if (!isObject(raw)) {
      return { ok: false, reason: 'invalid-input' };
    }
    const attemptId = raw.attemptId;
    if (typeof attemptId !== 'string') {
      return { ok: false, reason: 'invalid-input' };
    }
    if (seenAttemptIds.has(attemptId)) {
      return { ok: false, reason: 'invalid-input' };
    }
    seenAttemptIds.add(attemptId);
    const outcome = raw.outcome;
    if (!isReceiptOutcome(outcome)) {
      return { ok: false, reason: 'invalid-input' };
    }
    const review = raw.review;
    if (!Array.isArray(review)) {
      return { ok: false, reason: 'invalid-input' };
    }
    if (review.length > LANE_HISTORY_MAX_RECEIPTS_PER_ATTEMPT) {
      return { ok: false, reason: 'too-large' };
    }
    const rounds: LaneHistoryReviewRound[] = [];
    // Every row is validated whatever the outcome; only `found` readings contribute rounds.
    for (let row = 0; row < review.length; row += 1) {
      if (Object.getOwnPropertyDescriptor(review, row) === undefined) {
        return { ok: false, reason: 'invalid-input' };
      }
      const parsed = parseReviewRound(review[row]);
      if (parsed === null) {
        return { ok: false, reason: 'invalid-input' };
      }
      rounds.push(parsed);
    }
    readings.push({ attemptId, outcome, rounds: outcome === 'found' ? rounds : [] });
  }
  return { ok: true, readings };
}

function parseReviewRound(raw: unknown): LaneHistoryReviewRound | null {
  if (!isObject(raw)) {
    return null;
  }
  const kind = raw.kind;
  if (!isReceiptReviewKind(kind)) {
    return null;
  }
  const result = raw.result;
  if (!isReceiptResult(result)) {
    return null;
  }
  const findings = raw.findings;
  if (!isObject(findings)) {
    return null;
  }
  const blocker = findings.blocker;
  const major = findings.major;
  const minor = findings.minor;
  const nit = findings.nit;
  if (
    !isNonNegativeSafeInteger(blocker) ||
    !isNonNegativeSafeInteger(major) ||
    !isNonNegativeSafeInteger(minor) ||
    !isNonNegativeSafeInteger(nit)
  ) {
    return null;
  }
  const completedRaw = raw.completedAtIso;
  if (typeof completedRaw !== 'string') {
    return null;
  }
  const completedMs = parseTimeMs(completedRaw);
  if (completedMs === null) {
    return null;
  }
  const row: ReviewReceiptRowMirror = {
    kind,
    result,
    findings: { blocker, major, minor, nit },
    completedAtIso: new Date(completedMs).toISOString(),
  };
  return {
    kind: row.kind,
    result: row.result,
    blocker: row.findings.blocker,
    major: row.findings.major,
    minor: row.findings.minor,
    nit: row.findings.nit,
    completedAtIso: row.completedAtIso,
  };
}

function compareAttempts(a: LaneHistoryAttempt, b: LaneHistoryAttempt): number {
  if (a.createdAtIso < b.createdAtIso) {
    return -1;
  }
  if (a.createdAtIso > b.createdAtIso) {
    return 1;
  }
  if (a.attemptId < b.attemptId) {
    return -1;
  }
  if (a.attemptId > b.attemptId) {
    return 1;
  }
  return 0;
}

function compareRounds(a: LaneHistoryReviewRound, b: LaneHistoryReviewRound): number {
  if (a.completedAtIso < b.completedAtIso) {
    return -1;
  }
  if (a.completedAtIso > b.completedAtIso) {
    return 1;
  }
  if (a.kind < b.kind) {
    return -1;
  }
  if (a.kind > b.kind) {
    return 1;
  }
  return 0;
}

function buildHistory(attempts: readonly LaneHistoryAttempt[], readings: readonly ParsedReading[]): LaneHistory {
  const readingByAttempt = new Map<string, ParsedReading>();
  for (const reading of readings) {
    readingByAttempt.set(reading.attemptId, reading);
  }
  const headGroups = new Map<string, string[]>();
  const headOrder: string[] = [];
  for (const attempt of attempts) {
    const head = attempt.headCommit;
    if (head === null) {
      continue;
    }
    let group = headGroups.get(head);
    if (group === undefined) {
      group = [];
      headGroups.set(head, group);
      headOrder.push(head);
    }
    group.push(attempt.attemptId);
  }
  const heads: LaneHistoryHead[] = [];
  for (const head of headOrder) {
    const attemptIds = headGroups.get(head) as string[];
    let unknownStatus = false;
    const rounds: LaneHistoryReviewRound[] = [];
    for (const attemptId of attemptIds) {
      const reading = readingByAttempt.get(attemptId);
      if (reading === undefined || reading.outcome === 'unavailable') {
        unknownStatus = true;
      } else if (reading.outcome === 'found') {
        rounds.push(...reading.rounds);
      }
    }
    rounds.sort(compareRounds);
    const reviewStatus: LaneHistoryHead['reviewStatus'] = unknownStatus
      ? 'unknown'
      : rounds.length === 0
        ? 'none'
        : 'read';
    heads.push({ headCommit: head, attemptIds, reviewStatus, rounds });
  }
  return {
    schemaVersion: LANE_HISTORY_SCHEMA_VERSION,
    attempts,
    heads,
  };
}
