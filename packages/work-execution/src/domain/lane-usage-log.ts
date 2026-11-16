/**
 * LaneUsageLogRow (OG14): the pure row format of the lane usage telemetry
 * log, aligned with `AttemptUsageRecord` (S3) and the telemetry plan's cost
 * attributes (§3.6). A row is ids, codes, counts and numbers only — never a
 * worktree path, a host, a session id, a token or prompt text. Every string
 * field is scanned against the shared secret-shape registry and refused on
 * control characters; every reader refuses instead of throwing.
 */

import { billingOf, containsSecretShape, type SeatBilling } from '@fleet/shared';

import type {
  AttemptKind,
  AttemptRecord,
  AttemptUsageRecord,
  RunnerKind,
} from './execution-records.js';
import { runnerMinutesOf } from './execution-records.js';
import { readExactPlainRecord, isCalendarDateTime } from './plain-record-reads.js';
import { ATTEMPT_OUTCOMES, type AttemptOutcomeValue } from './value-objects/AttemptOutcome.vo.js';
import { STOP_REASONS, type StopReasonValue } from './value-objects/StopReason.vo.js';
import { SEAT_PLAN_ROLES, type SeatPlanRole } from './value-objects/SeatPlan.vo.js';
import { isTelemetryModelId } from './run-telemetry-attributes.js';

/** The row schema version on disk; the file's header line names it. */
export const LANE_USAGE_LOG_SCHEMA_VERSION = 1 as const;

/** The store's bounds: 20 000 rows, 4 MiB. */
export const LANE_USAGE_LOG_MAX_ROWS = 20_000;
export const LANE_USAGE_LOG_MAX_FILE_BYTES = 4 * 1024 * 1024;

/** The cost bases the telemetry plan declares (§3.6). */
export const LANE_USAGE_LOG_COST_BASES = ['metered', 'plan-estimate', 'unknown'] as const;
export type LaneUsageLogCostBasis = (typeof LANE_USAGE_LOG_COST_BASES)[number];

export interface LaneUsageLogRow {
  readonly schemaVersion: 1;
  readonly attemptId: string;
  readonly workOrderId: string;
  readonly runId: string | null;
  /** Only ever the final segment of the worktree path — never a directory path. */
  readonly worktreeName: string | null;
  readonly kind: AttemptKind;
  readonly fixNumber: number;
  readonly outcome: AttemptOutcomeValue | null;
  readonly stopReason: StopReasonValue | null;
  readonly runnerKind: RunnerKind | null;
  readonly billing: SeatBilling;
  readonly seatRole: SeatPlanRole | null;
  readonly model: string | null;
  readonly agent: string | null;
  readonly source: AttemptUsageRecord['source'];
  readonly steps: number | null;
  readonly wallSeconds: number | null;
  readonly runnerMinutes: number | null;
  readonly tokensInput: number | null;
  readonly tokensOutput: number | null;
  readonly tokensReasoning: number | null;
  readonly tokensCacheRead: number | null;
  readonly tokensCacheWrite: number | null;
  readonly costUsd: number | null;
  readonly costBasis: LaneUsageLogCostBasis;
  readonly recordedAtIso: string;
  readonly reason: string | null;
}

/** Every row key, in the canonical order the store serializes. */
export const LANE_USAGE_LOG_ROW_KEYS = [
  'schemaVersion', 'attemptId', 'workOrderId', 'runId', 'worktreeName', 'kind', 'fixNumber',
  'outcome', 'stopReason', 'runnerKind', 'billing', 'seatRole', 'model', 'agent', 'source',
  'steps', 'wallSeconds', 'runnerMinutes', 'tokensInput', 'tokensOutput', 'tokensReasoning',
  'tokensCacheRead', 'tokensCacheWrite', 'costUsd', 'costBasis', 'recordedAtIso', 'reason',
] as const;

/** Control characters never pass: no line break, no NUL, nothing unprintable. */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

/** A row's text fields are bounded so one row stays small and the byte budget holds. */
const MAX_TEXT_LENGTH = 512;

/** The canonical instant shape every timestamp field must carry. */
const ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function isSafeText(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_TEXT_LENGTH &&
    !CONTROL_CHARACTERS.test(value) &&
    !containsSecretShape(value)
  );
}

function isOptionalSafeText(value: unknown): value is string | null {
  return value === null || isSafeText(value);
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isOptionalNonNegativeNumber(value: unknown): value is number | null {
  return value === null || isNonNegativeNumber(value);
}

function isCanonicalIso(value: unknown): value is string {
  return typeof value === 'string' && ISO_PATTERN.test(value) && isCalendarDateTime(value);
}

function isEnum<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value);
}

/**
 * The worktree name: only the final non-empty segment of `path`. The scan is
 * bounded: it walks backwards from the end of the string and stops once a
 * segment longer than `MAX_TEXT_LENGTH` is proven, so an input of any size
 * costs at most `MAX_TEXT_LENGTH + 1` examined characters — never a split of
 * the whole input. A parent directory, a `..` or `.` segment, a segment with
 * control characters or a secret shape never yields a name. Never throws.
 */
export function worktreeNameFromPath(path: unknown): string | null {
  try {
    if (typeof path !== 'string') {
      return null;
    }
    const isSeparator = (character: string): boolean => character === '/' || character === '\\';
    let end = path.length - 1;
    while (end >= 0 && isSeparator(path[end])) {
      end -= 1;
    }
    if (end < 0) {
      return null;
    }
    // Collect at most MAX_TEXT_LENGTH + 1 characters: one more than allowed,
    // so an over-long segment is refused without scanning further back.
    let last = '';
    let start = end;
    while (start >= 0 && !isSeparator(path[start]) && last.length <= MAX_TEXT_LENGTH) {
      last = `${path[start]}${last}`;
      start -= 1;
    }
    if (start >= 0 && !isSeparator(path[start])) {
      return null;
    }
    if (last === '.' || last === '..' || CONTROL_CHARACTERS.test(last) || containsSecretShape(last)) {
      return null;
    }
    return last;
  } catch {
    return null;
  }
}

/** The cost basis a billing and a cost imply (plan §3.6). */
function costBasisOf(billing: SeatBilling, costUsd: number | null): LaneUsageLogCostBasis {
  if (costUsd === null) {
    return 'unknown';
  }
  if (billing === 'metered') {
    return 'metered';
  }
  return billing === 'plan' ? 'plan-estimate' : 'unknown';
}

/**
 * The row for a collected attempt: pure, never throws. Every string is
 * checked for secret shapes and control characters; every measurement is
 * checked to be a finite non-negative number. `null` on any invalid input, a
 * `null` attempt, or a getter that throws. Hostile values inside `usage` are
 * redacted to `null` rather than carried.
 */
export function buildLaneUsageLogRow(input: {
  attempt: AttemptRecord;
  runId?: string | null;
  nowIso: string;
}): LaneUsageLogRow | null {
  try {
    if (typeof input !== 'object' || input === null || !isCanonicalIso(input.nowIso)) {
      return null;
    }
    const attempt = input.attempt;
    if (typeof attempt !== 'object' || attempt === null) {
      return null;
    }
    const { id, workOrderId, kind, fixNumber, worktreePath, outcome, stopReason } = attempt;
    if (!isSafeText(id) || !isSafeText(workOrderId)) {
      return null;
    }
    if (!isEnum(kind, ['initial', 'fix'] as const)) {
      return null;
    }
    if (!isNonNegativeNumber(fixNumber) || !Number.isSafeInteger(fixNumber)) {
      return null;
    }
    if (
      outcome !== null && !isEnum(outcome, ATTEMPT_OUTCOMES) ||
      stopReason !== undefined && stopReason !== null && !isEnum(stopReason, STOP_REASONS)
    ) {
      return null;
    }
    const runIdField = input.runId === undefined ? null : input.runId;
    if (runIdField !== null && !isSafeText(runIdField)) {
      return null;
    }
    const worktreeName = worktreeNameFromPath(worktreePath);
    if (worktreeName === null) {
      return null;
    }
    const runnerRecord = (attempt as { runner?: unknown }).runner;
    const runnerKind =
      isEnum((runnerRecord as { kind?: unknown } | null | undefined)?.kind, ['opencode', 'agy'] as const)
        ? (runnerRecord as { kind: RunnerKind }).kind
        : null;
    const billing = billingOf(runnerKind ?? (attempt as { seatSelection?: { tool?: unknown } | null }).seatSelection?.tool);
    const seatRoleValue = (attempt as { seatSelection?: { role?: unknown } | null }).seatSelection?.role;
    const seatRole = isEnum(seatRoleValue, SEAT_PLAN_ROLES) ? seatRoleValue : null;

    const usage = (attempt as { usage?: AttemptUsageRecord | null }).usage ?? null;
    if (usage !== null && (typeof usage !== 'object' || Array.isArray(usage))) {
      return null;
    }
    const usageRecord = usage as {
      source?: unknown;
      model?: unknown;
      agent?: unknown;
      reason?: unknown;
      steps?: unknown;
      wallSeconds?: unknown;
      runnerMinutes?: unknown;
      tokensInput?: unknown;
      tokensOutput?: unknown;
      tokensReasoning?: unknown;
      tokensCacheRead?: unknown;
      tokensCacheWrite?: unknown;
      costUsd?: unknown;
    } | null;
    const source = isEnum(usageRecord?.source, ['opencode-db', 'opencode-api', 'unavailable'] as const)
      ? usageRecord.source
      : 'unavailable';
    const model = isTelemetryModelId(usageRecord?.model) ? (usageRecord?.model as string) : null;
    const agent = isOptionalSafeText(usageRecord?.agent) ? (usageRecord?.agent as string | null) : null;
    // The usage record's `reason` is prompt/detail text — diagnostic stderr,
    // provider messages — and never belongs in a telemetry row, so the builder
    // always redacts it to `null` rather than copying it through.
    const reason = null;
    const wallSeconds = isOptionalNonNegativeNumber(usageRecord?.wallSeconds)
      ? (usageRecord?.wallSeconds as number | null)
      : null;
    const runnerMinutes =
      usageRecord?.runnerMinutes === undefined
        ? runnerMinutesOf(wallSeconds)
        : (isOptionalNonNegativeNumber(usageRecord.runnerMinutes)
          ? (usageRecord.runnerMinutes as number | null)
          : null);
    const costUsd = isOptionalNonNegativeNumber(usageRecord?.costUsd)
      ? (usageRecord?.costUsd as number | null)
      : null;

    return {
      schemaVersion: 1,
      attemptId: id,
      workOrderId,
      runId: runIdField,
      worktreeName,
      kind,
      fixNumber,
      outcome: outcome === null || outcome === undefined ? null : outcome,
      stopReason: stopReason === null || stopReason === undefined ? null : stopReason,
      runnerKind,
      billing,
      seatRole,
      model,
      agent,
      source,
      steps: isOptionalNonNegativeNumber(usageRecord?.steps) ? (usageRecord?.steps as number | null) : null,
      wallSeconds,
      runnerMinutes,
      tokensInput: isOptionalNonNegativeNumber(usageRecord?.tokensInput)
        ? (usageRecord?.tokensInput as number | null)
        : null,
      tokensOutput: isOptionalNonNegativeNumber(usageRecord?.tokensOutput)
        ? (usageRecord?.tokensOutput as number | null)
        : null,
      tokensReasoning: isOptionalNonNegativeNumber(usageRecord?.tokensReasoning)
        ? (usageRecord?.tokensReasoning as number | null)
        : null,
      tokensCacheRead: isOptionalNonNegativeNumber(usageRecord?.tokensCacheRead)
        ? (usageRecord?.tokensCacheRead as number | null)
        : null,
      tokensCacheWrite: isOptionalNonNegativeNumber(usageRecord?.tokensCacheWrite)
        ? (usageRecord?.tokensCacheWrite as number | null)
        : null,
      costUsd,
      costBasis: costBasisOf(billing, costUsd),
      recordedAtIso: input.nowIso,
      reason,
    };
  } catch {
    return null;
  }
}


/**
 * The row a stored line holds: read through `readExactPlainRecord`, so no
 * getter ever runs and a missing or extra key refuses. `null` on anything
 * that is not exactly a row, including an array, a wrong primitive, a
 * hostile object or a secret-shaped string. Never throws.
 */
export function parseLaneUsageLogRow(value: unknown): LaneUsageLogRow | null {
  try {
    const record = readExactPlainRecord(value, LANE_USAGE_LOG_ROW_KEYS);
    if (record === null) {
      return null;
    }
    const {
      schemaVersion, attemptId, workOrderId, runId, worktreeName, kind, fixNumber,
      outcome, stopReason, runnerKind, billing, seatRole, model, agent, source,
      steps, wallSeconds, runnerMinutes, tokensInput, tokensOutput, tokensReasoning,
      tokensCacheRead, tokensCacheWrite, costUsd, costBasis, recordedAtIso, reason,
    } = record;
    if (schemaVersion !== 1) {
      return null;
    }
    if (!isSafeText(attemptId) || !isSafeText(workOrderId) || !isOptionalSafeText(runId)) {
      return null;
    }
    if (
      worktreeName !== null &&
      (typeof worktreeName !== 'string' || worktreeName.length === 0 ||
        worktreeName.length > MAX_TEXT_LENGTH ||
        worktreeName === '.' || worktreeName === '..' ||
        /[\\/]/.test(worktreeName) || CONTROL_CHARACTERS.test(worktreeName) ||
        containsSecretShape(worktreeName))
    ) {
      return null;
    }
    if (
      !isEnum(kind, ['initial', 'fix'] as const) ||
      !isNonNegativeNumber(fixNumber) || !Number.isSafeInteger(fixNumber) ||
      outcome !== null && !isEnum(outcome, ATTEMPT_OUTCOMES) ||
      stopReason !== null && !isEnum(stopReason, STOP_REASONS) ||
      runnerKind !== null && !isEnum(runnerKind, ['opencode', 'agy'] as const) ||
      !isEnum(billing, ['metered', 'plan', 'unknown'] as const) ||
      seatRole !== null && !isEnum(seatRole, SEAT_PLAN_ROLES) ||
      model !== null && !isTelemetryModelId(model) ||
      !isOptionalSafeText(agent) ||
      !isEnum(source, ['opencode-db', 'opencode-api', 'unavailable'] as const) ||
      !isOptionalSafeText(reason) ||
      !isEnum(costBasis, LANE_USAGE_LOG_COST_BASES) ||
      !isCanonicalIso(recordedAtIso)
    ) {
      return null;
    }
    for (const numberValue of [
      steps, wallSeconds, runnerMinutes, tokensInput, tokensOutput,
      tokensReasoning, tokensCacheRead, tokensCacheWrite, costUsd,
    ]) {
      if (!isOptionalNonNegativeNumber(numberValue)) {
        return null;
      }
    }
    // The stored costBasis must be the one its billing and cost derive to
    // (plan §3.6): a row claiming `metered` with no cost, or `plan-estimate`
    // under metered billing, is inconsistent and refused.
    if (costBasis !== costBasisOf(billing as SeatBilling, costUsd as number | null)) {
      return null;
    }
    return {
      schemaVersion: 1,
      attemptId,
      workOrderId,
      runId,
      worktreeName,
      kind,
      fixNumber,
      outcome,
      stopReason,
      runnerKind,
      billing,
      seatRole,
      model,
      agent,
      source,
      steps,
      wallSeconds,
      runnerMinutes,
      tokensInput,
      tokensOutput,
      tokensReasoning,
      tokensCacheRead,
      tokensCacheWrite,
      costUsd,
      costBasis,
      recordedAtIso,
      reason,
    } as LaneUsageLogRow;
  } catch {
    return null;
  }
}

/** The store's header line: the schema version alone. */
export function serializeLaneUsageLogHeader(): string {
  return '{"schemaVersion":1}';
}

/**
 * The JSONL line for one row, or `null` when the value is not exactly a row.
 * The round-trip through `parseLaneUsageLogRow` is the guard: a hostile row
 * is never serialized.
 */
export function serializeLaneUsageLogRow(row: LaneUsageLogRow): string | null {
  const parsed = parseLaneUsageLogRow(row);
  if (parsed === null) {
    return null;
  }
  return JSON.stringify(parsed);
}

