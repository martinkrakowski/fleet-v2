/**
 * SpendLedgerRow (CL1): the pure row format of the monthly-capped spend
 * ledger — one row per attempt's measured model usage, keyed by provider and
 * UTC month. The ledger is the single source of truth for spend and the only
 * input to a provider cap; the lane usage log stays telemetry and is never an
 * input to a cap. A row is ids, codes, counts and numbers only — never a
 * worktree path, a host, a session id, a token or prompt text. Every string
 * field is scanned against the shared secret-shape registry and refused on
 * control characters; every reader refuses instead of throwing.
 *
 * `plan-estimate` cost is never folded into spend: only `metered` rows count
 * toward `spentUsd`, and only `summariseSpendMonth` decides a cap, never a
 * row.
 */

import { billingOf, containsSecretShape, type SeatBilling } from '@fleet/shared';

import type { AttemptRecord, AttemptUsageRecord, RunnerKind } from './execution-records.js';
import { LANE_USAGE_LOG_COST_BASES, type LaneUsageLogCostBasis } from './lane-usage-log.js';
import { isCalendarDateTime, readBoundedDenseArray, readExactPlainRecord } from './plain-record-reads.js';
import { isTelemetryModelId } from './run-telemetry-attributes.js';
import { SEAT_PLAN_ROLES, type SeatPlanRole } from './value-objects/SeatPlan.vo.js';

/** The store's row budget: 20 000 rows, one month at a time. */
export const SPEND_LEDGER_MAX_ROWS = 20_000;

/** The summary's provider and seat bucket bounds. */
export const SPEND_LEDGER_MAX_PROVIDERS = 64;
export const SPEND_LEDGER_MAX_SEATS = 256;

/** Every row key, in the canonical order the store serializes. */
export const SPEND_LEDGER_ROW_KEYS = [
  'attemptId', 'workOrderId', 'runId', 'seatId', 'seatRole', 'provider', 'model',
  'month', 'tokensInput', 'tokensOutput', 'tokensReasoning', 'tokensCacheRead',
  'tokensCacheWrite', 'costUsd', 'costBasis', 'recordedAtIso',
] as const;

export interface SpendLedgerRow {
  readonly attemptId: string;
  readonly workOrderId: string;
  readonly runId: string | null;
  readonly seatId: string | null;
  readonly seatRole: SeatPlanRole | null;
  readonly provider: string;
  readonly model: string;
  /** The UTC month the spend is booked to: `YYYY-MM`, the month of `recordedAtIso`. */
  readonly month: string;
  readonly tokensInput: number | null;
  readonly tokensOutput: number | null;
  readonly tokensReasoning: number | null;
  readonly tokensCacheRead: number | null;
  readonly tokensCacheWrite: number | null;
  readonly costUsd: number | null;
  readonly costBasis: LaneUsageLogCostBasis;
  readonly recordedAtIso: string;
}

/** The canonical instant shape every timestamp field must carry. */
const ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** A UTC month key: `YYYY-MM`, month `01`..`12`. */
const MONTH_PATTERN = /^\d{4}-(?:0[1-9]|1[0-2])$/;

/**
 * Identifier fields (attempt, work order and run ids, the seat id, the
 * provider of a budget) are strict identifiers, never free text: no
 * whitespace, a closed character set, anchored, at most 128 characters.
 */
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function isIdentifier(value: unknown): value is string {
  return typeof value === 'string' && IDENTIFIER_PATTERN.test(value) && !containsSecretShape(value);
}

function isOptionalIdentifier(value: unknown): value is string | null {
  return value === null || isIdentifier(value);
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

/** True when the value is a `YYYY-MM` string with month `01`..`12`. */
function isValidMonth(value: unknown): value is string {
  return typeof value === 'string' && MONTH_PATTERN.test(value);
}

/**
 * The UTC `YYYY-MM` month of a canonical UTC ISO instant, or `null` for
 * anything else — a non-string, a non-canonical shape, an impossible calendar
 * date. Never throws. `2026-11-30T23:59:59.999Z` is `"2026-11"` and
 * `2026-12-01T00:00:00.000Z` is `"2026-12"`: the month splits at the UTC
 * boundary, never at the host's local zone.
 */
export function monthKeyOf(iso: unknown): string | null {
  try {
    if (!isCanonicalIso(iso)) {
      return null;
    }
    return (iso as string).slice(0, 7);
  } catch {
    return null;
  }
}

/**
 * The provider of a valid model id: the segment before the first `/`
 * (`"openrouter/z-ai/glm-5.3-flash"` -> `"openrouter"`). `"unknown"` for any
 * model with no `/`, an empty leading segment, a non-string, an over-long
 * string, control characters or a secret shape — a model id that fails
 * `isTelemetryModelId`. Never throws.
 */
export function providerOfModel(model: unknown): string {
  try {
    if (!isTelemetryModelId(model)) {
      return 'unknown';
    }
    const text = model as string;
    const slash = text.indexOf('/');
    if (slash <= 0) {
      return 'unknown';
    }
    return text.slice(0, slash);
  } catch {
    return 'unknown';
  }
}

/** The cost basis a billing and a cost imply (the lane usage log's rule). */
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
 * The row a stored line holds: read through `readExactPlainRecord`, so no
 * getter ever runs and a missing or extra key refuses. `{ ok: false,
 * reason: 'invalid-row' }` on anything that is not exactly a row — a
 * non-object, an array, a hostile object, a secret-shaped or
 * control-character string, an over-long identifier, a negative or
 * non-finite measurement, a month of `00` or `13`, or a `month` that is not
 * the month of `recordedAtIso`. Never throws.
 */
export type SpendLedgerRowResult =
  | { readonly ok: true; readonly row: SpendLedgerRow }
  | { readonly ok: false; readonly reason: 'invalid-row' };

export function readSpendLedgerRow(value: unknown): SpendLedgerRowResult {
  try {
    const record = readExactPlainRecord(value, SPEND_LEDGER_ROW_KEYS);
    if (record === null) {
      return { ok: false, reason: 'invalid-row' };
    }
    const {
      attemptId, workOrderId, runId, seatId, seatRole, provider, model,
      month, tokensInput, tokensOutput, tokensReasoning, tokensCacheRead,
      tokensCacheWrite, costUsd, costBasis, recordedAtIso,
    } = record;
    if (!isIdentifier(attemptId) || !isIdentifier(workOrderId) || !isOptionalIdentifier(runId)) {
      return { ok: false, reason: 'invalid-row' };
    }
    if (!isOptionalIdentifier(seatId) || !isIdentifier(provider) || !isTelemetryModelId(model)) {
      return { ok: false, reason: 'invalid-row' };
    }
    if (!isValidMonth(month) || !isCanonicalIso(recordedAtIso) || monthKeyOf(recordedAtIso) !== month) {
      return { ok: false, reason: 'invalid-row' };
    }
    if (seatRole !== null && !isEnum(seatRole, SEAT_PLAN_ROLES)) {
      return { ok: false, reason: 'invalid-row' };
    }
    if (!isEnum(costBasis, LANE_USAGE_LOG_COST_BASES)) {
      return { ok: false, reason: 'invalid-row' };
    }
    for (const numberValue of [
      tokensInput, tokensOutput, tokensReasoning, tokensCacheRead, tokensCacheWrite, costUsd,
    ]) {
      if (!isOptionalNonNegativeNumber(numberValue)) {
        return { ok: false, reason: 'invalid-row' };
      }
    }
    return {
      ok: true,
      row: {
        attemptId,
        workOrderId,
        runId,
        seatId,
        seatRole: seatRole as SeatPlanRole | null,
        provider,
        model: model as string,
        month: month as string,
        tokensInput: tokensInput as number | null,
        tokensOutput: tokensOutput as number | null,
        tokensReasoning: tokensReasoning as number | null,
        tokensCacheRead: tokensCacheRead as number | null,
        tokensCacheWrite: tokensCacheWrite as number | null,
        costUsd: costUsd as number | null,
        costBasis: costBasis as LaneUsageLogCostBasis,
        recordedAtIso,
      },
    };
  } catch {
    return { ok: false, reason: 'invalid-row' };
  }
}

/**
 * The spend row for a collected attempt: built from the same attempt facts
 * `buildLaneUsageLogRow` reads — the attempt and work-order ids, the run id,
 * the seat selection's seat id and role, the billing of the runner kind (else
 * the seat's tool), and the usage record's measurements. `null` when the
 * attempt is invalid or hostile, `nowIso` is not a canonical instant, or the
 * usage record is missing or carries no valid model. Hostile measurements
 * inside `usage` are redacted to `null` rather than carried. Pure: never
 * throws.
 */
export function buildSpendLedgerRow(input: {
  attempt: AttemptRecord;
  runId?: string | null;
  nowIso: string;
}): SpendLedgerRow | null {
  try {
    if (typeof input !== 'object' || input === null || !isCanonicalIso(input.nowIso)) {
      return null;
    }
    const attempt = input.attempt;
    if (typeof attempt !== 'object' || attempt === null) {
      return null;
    }
    const { id, workOrderId } = attempt;
    if (!isIdentifier(id) || !isIdentifier(workOrderId)) {
      return null;
    }
    const runIdField = input.runId === undefined ? null : input.runId;
    if (runIdField !== null && !isIdentifier(runIdField)) {
      return null;
    }
    const seatSelection = (
      attempt as { seatSelection?: { seatId?: unknown; role?: unknown; tool?: unknown } | null }
    ).seatSelection ?? null;
    const seatSelectionRecord =
      seatSelection !== null && typeof seatSelection === 'object' && !Array.isArray(seatSelection)
        ? (seatSelection as { seatId?: unknown; role?: unknown; tool?: unknown })
        : null;
    const seatId = isOptionalIdentifier(seatSelectionRecord?.seatId)
      ? (seatSelectionRecord?.seatId as string | null)
      : null;
    const seatRole = isEnum(seatSelectionRecord?.role, SEAT_PLAN_ROLES)
      ? (seatSelectionRecord?.role as SeatPlanRole)
      : null;
    const runnerRecord = (attempt as { runner?: { kind?: unknown } | null }).runner;
    const runnerKind = isEnum(runnerRecord?.kind, ['opencode', 'agy'] as const)
      ? (runnerRecord?.kind as RunnerKind)
      : null;
    const billing = billingOf(runnerKind ?? seatSelectionRecord?.tool);

    const usage = (attempt as { usage?: AttemptUsageRecord | null }).usage ?? null;
    if (usage === null || typeof usage !== 'object' || Array.isArray(usage)) {
      return null;
    }
    const model = isTelemetryModelId(usage.model) ? usage.model : null;
    if (model === null) {
      return null;
    }
    const costUsd = isOptionalNonNegativeNumber(usage.costUsd) ? usage.costUsd : null;
    const month = monthKeyOf(input.nowIso);
    if (month === null) {
      return null;
    }
    return {
      attemptId: id,
      workOrderId,
      runId: runIdField,
      seatId,
      seatRole,
      provider: providerOfModel(model),
      model,
      month,
      tokensInput: isOptionalNonNegativeNumber(usage.tokensInput) ? usage.tokensInput : null,
      tokensOutput: isOptionalNonNegativeNumber(usage.tokensOutput) ? usage.tokensOutput : null,
      tokensReasoning: isOptionalNonNegativeNumber(usage.tokensReasoning) ? usage.tokensReasoning : null,
      tokensCacheRead: isOptionalNonNegativeNumber(usage.tokensCacheRead) ? usage.tokensCacheRead : null,
      tokensCacheWrite: isOptionalNonNegativeNumber(usage.tokensCacheWrite) ? usage.tokensCacheWrite : null,
      costUsd,
      costBasis: costBasisOf(billing, costUsd),
      recordedAtIso: input.nowIso,
    };
  } catch {
    return null;
  }
}

/** Per-provider token totals; `null` when no month row carries the field. */
export interface SpendMonthTokens {
  readonly input: number | null;
  readonly output: number | null;
  readonly reasoning: number | null;
  readonly cacheRead: number | null;
  readonly cacheWrite: number | null;
}

/** One provider's aggregated month spend. */
export interface ProviderSpendEntry {
  readonly provider: string;
  readonly rowCount: number;
  readonly tokens: SpendMonthTokens;
  /**
   * Sum of `costUsd` over the provider's `metered` rows only; `null` when no
   * metered row is in the month. `plan-estimate` rows never contribute.
   */
  readonly spentUsd: number | null;
  /** Sum of `costUsd` over the provider's `plan-estimate` rows; never spend. */
  readonly planEstimateUsd: number | null;
}

/** One `(provider, seatId)` pair's aggregated month spend. */
export interface SeatSpendEntry {
  readonly provider: string;
  readonly seatId: string;
  readonly rowCount: number;
  readonly tokens: SpendMonthTokens;
  readonly spentUsd: number | null;
}

/** One month's aggregated spend across providers and seats. */
export interface SpendMonthSummary {
  readonly month: string;
  readonly rowCount: number;
  readonly providers: readonly ProviderSpendEntry[];
  readonly seats: readonly SeatSpendEntry[];
  /** True when more than `SPEND_LEDGER_MAX_PROVIDERS` providers were folded into `"other"`. */
  readonly providersTruncated: boolean;
  /** True when more than `SPEND_LEDGER_MAX_SEATS` seats were folded into `"other"`. */
  readonly seatsTruncated: boolean;
  /** Rows with `costUsd === null` or `costBasis === 'unknown'`; never spend. */
  readonly unknownCostRows: number;
}

export type SpendMonthSummaryFailureReason = 'invalid-month' | 'invalid-rows-array' | 'invalid-row';

export type SpendMonthSummaryResult =
  | { readonly ok: true; readonly summary: SpendMonthSummary }
  | { readonly ok: false; readonly reason: SpendMonthSummaryFailureReason };

/** One summable field's accumulator for a provider or seat group. */
interface SumAccumulator {
  seen: boolean;
  value: number;
  overflow: boolean;
}

function newAccumulator(): SumAccumulator {
  return { seen: false, value: 0, overflow: false };
}

/**
 * Checked accumulation: the sum is refused, not rounded, when the midpoint
 * leaves the finite range. `null` means "refuse", never a partial sum.
 */
function accumulate(acc: SumAccumulator, value: number | null): void {
  if (value === null) {
    return;
  }
  if (!isNonNegativeNumber(value)) {
    acc.overflow = true;
    return;
  }
  const next = acc.value + value;
  if (!Number.isFinite(next)) {
    acc.overflow = true;
    return;
  }
  acc.seen = true;
  acc.value = next;
}

function finish(acc: SumAccumulator): number | null {
  return acc.seen ? acc.value : null;
}

/** A provider's (or seat's) mutable working state, keyed in a `Map`. */
interface SpendGroup {
  provider: string;
  seatId: string | null;
  rowCount: number;
  tokensInput: SumAccumulator;
  tokensOutput: SumAccumulator;
  tokensReasoning: SumAccumulator;
  tokensCacheRead: SumAccumulator;
  tokensCacheWrite: SumAccumulator;
  spentUsd: SumAccumulator;
  planEstimateUsd: SumAccumulator;
}

function newSpendGroup(provider: string, seatId: string | null): SpendGroup {
  return {
    provider,
    seatId,
    rowCount: 0,
    tokensInput: newAccumulator(),
    tokensOutput: newAccumulator(),
    tokensReasoning: newAccumulator(),
    tokensCacheRead: newAccumulator(),
    tokensCacheWrite: newAccumulator(),
    spentUsd: newAccumulator(),
    planEstimateUsd: newAccumulator(),
  };
}

function finishGroup(group: SpendGroup): ProviderSpendEntry {
  return {
    provider: group.provider,
    rowCount: group.rowCount,
    tokens: {
      input: finish(group.tokensInput),
      output: finish(group.tokensOutput),
      reasoning: finish(group.tokensReasoning),
      cacheRead: finish(group.tokensCacheRead),
      cacheWrite: finish(group.tokensCacheWrite),
    },
    spentUsd: finish(group.spentUsd),
    planEstimateUsd: finish(group.planEstimateUsd),
  };
}

function finishSeatGroup(group: SpendGroup): SeatSpendEntry {
  return {
    provider: group.provider,
    seatId: group.seatId as string,
    rowCount: group.rowCount,
    tokens: {
      input: finish(group.tokensInput),
      output: finish(group.tokensOutput),
      reasoning: finish(group.tokensReasoning),
      cacheRead: finish(group.tokensCacheRead),
      cacheWrite: finish(group.tokensCacheWrite),
    },
    spentUsd: finish(group.spentUsd),
  };
}

/**
 * Group one month's `SpendLedgerRow` values into per-provider and
 * per-`(provider, seatId)` totals. Pure: no wall clock, no randomness, no
 * I/O, no `console.*`; the input array and its rows are neither mutated nor
 * retained.
 *
 * Cost bound: one `O(n)` pass over `rows` validates and accumulates (`n` is
 * bounded by `SPEND_LEDGER_MAX_ROWS = 20_000`, enforced in `O(1)` by
 * `readBoundedDenseArray` before any element is read), `O(providers + seats)`
 * memory for the groups. Every failure returns a typed result; the function
 * never throws and never returns a partial sum.
 */
export function summariseSpendMonth(rows: readonly unknown[], month: string): SpendMonthSummaryResult {
  try {
    if (!isValidMonth(month)) {
      return { ok: false, reason: 'invalid-month' };
    }
    const dense = readBoundedDenseArray(rows, SPEND_LEDGER_MAX_ROWS);
    if (dense === null) {
      return { ok: false, reason: 'invalid-rows-array' };
    }
    const providers = new Map<string, SpendGroup>();
    const seats = new Map<string, SpendGroup>();
    let providersTruncated = false;
    let seatsTruncated = false;
    let rowCount = 0;
    let unknownCostRows = 0;
    for (const item of dense.array) {
      const read = readSpendLedgerRow(item);
      if (!read.ok) {
        return { ok: false, reason: 'invalid-row' };
      }
      const row = read.row;
      if (row.month !== month) {
        continue;
      }
      rowCount += 1;
      let group = providers.get(row.provider);
      if (group === undefined) {
        if (providers.size >= SPEND_LEDGER_MAX_PROVIDERS) {
          // Fold further providers into the explicit `"other"` bucket rather
          // than growing the summary without bound.
          providersTruncated = true;
          group = providers.get('other') ?? newSpendGroup('other', null);
          providers.set('other', group);
        } else {
          group = newSpendGroup(row.provider, null);
          providers.set(row.provider, group);
        }
      }
      group.rowCount += 1;
      accumulate(group.tokensInput, row.tokensInput);
      accumulate(group.tokensOutput, row.tokensOutput);
      accumulate(group.tokensReasoning, row.tokensReasoning);
      accumulate(group.tokensCacheRead, row.tokensCacheRead);
      accumulate(group.tokensCacheWrite, row.tokensCacheWrite);
      if (row.costBasis === 'metered') {
        accumulate(group.spentUsd, row.costUsd);
      } else if (row.costBasis === 'plan-estimate') {
        accumulate(group.planEstimateUsd, row.costUsd);
      }
      if (row.costUsd === null || row.costBasis === 'unknown') {
        unknownCostRows += 1;
      }

      if (row.seatId !== null) {
        const seatKey = `${row.provider}\u0000${row.seatId}`;
        let seatGroup = seats.get(seatKey);
        if (seatGroup === undefined) {
          if (seats.size >= SPEND_LEDGER_MAX_SEATS) {
            seatsTruncated = true;
            seatGroup = seats.get('other') ?? newSpendGroup('other', 'other');
            seats.set('other', seatGroup);
          } else {
            seatGroup = newSpendGroup(row.provider, row.seatId);
            seats.set(seatKey, seatGroup);
          }
        }
        seatGroup.rowCount += 1;
        accumulate(seatGroup.tokensInput, row.tokensInput);
        accumulate(seatGroup.tokensOutput, row.tokensOutput);
        accumulate(seatGroup.tokensReasoning, row.tokensReasoning);
        accumulate(seatGroup.tokensCacheRead, row.tokensCacheRead);
        accumulate(seatGroup.tokensCacheWrite, row.tokensCacheWrite);
        if (row.costBasis === 'metered') {
          accumulate(seatGroup.spentUsd, row.costUsd);
        }
      }
    }
    for (const group of [...providers.values(), ...seats.values()]) {
      if (
        group.tokensInput.overflow || group.tokensOutput.overflow ||
        group.tokensReasoning.overflow || group.tokensCacheRead.overflow ||
        group.tokensCacheWrite.overflow || group.spentUsd.overflow ||
        group.planEstimateUsd.overflow
      ) {
        return { ok: false, reason: 'invalid-row' };
      }
    }
    const providerEntries = [...providers.values()]
      .map(finishGroup)
      .sort((a, b) => (a.provider < b.provider ? -1 : a.provider > b.provider ? 1 : 0));
    const seatEntries = [...seats.values()]
      .map(finishSeatGroup)
      .sort((a, b) => {
        if (a.provider !== b.provider) {
          return a.provider < b.provider ? -1 : 1;
        }
        return a.seatId < b.seatId ? -1 : a.seatId > b.seatId ? 1 : 0;
      });
    return {
      ok: true,
      summary: {
        month,
        rowCount,
        providers: providerEntries,
        seats: seatEntries,
        providersTruncated,
        seatsTruncated,
        unknownCostRows,
      },
    };
  } catch {
    return { ok: false, reason: 'invalid-rows-array' };
  }
}

/** A provider's monthly cap, read from an operator-declared budget record. */
export interface ProviderBudget {
  readonly provider: string;
  readonly monthlyUsd: number;
}

export type ProviderBudgetResult =
  | { readonly ok: true; readonly budget: ProviderBudget }
  | { readonly ok: false; readonly reason: 'invalid-budget' };

/**
 * The budget a stored record holds: read through `readExactPlainRecord`, so
 * no getter ever runs and a missing or extra key refuses. `{ ok: false,
 * reason: 'invalid-budget' }` on anything that is not exactly a budget — a
 * non-object, an array, a hostile object, an invalid or secret-shaped
 * `provider`, or a `monthlyUsd` that is not a finite positive number. Never
 * throws.
 */
export function readProviderBudget(value: unknown): ProviderBudgetResult {
  try {
    const record = readExactPlainRecord(value, ['provider', 'monthlyUsd']);
    if (record === null) {
      return { ok: false, reason: 'invalid-budget' };
    }
    const { provider, monthlyUsd } = record;
    if (!isIdentifier(provider)) {
      return { ok: false, reason: 'invalid-budget' };
    }
    if (typeof monthlyUsd !== 'number' || !Number.isFinite(monthlyUsd) || monthlyUsd <= 0) {
      return { ok: false, reason: 'invalid-budget' };
    }
    return { ok: true, budget: { provider, monthlyUsd } };
  } catch {
    return { ok: false, reason: 'invalid-budget' };
  }
}

export type ProviderBudgetDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: 'budget-exhausted' | 'budget-unknown' };

/**
 * The pure spend-cap verdict for one provider against one month's summary.
 *
 * This decision NEVER kills running work: it is a pure verdict for NEW first
 * passes only. Nothing here stops, cancels, or reaps a running attempt; a
 * caller that wants a cap enforced applies this verdict at its own dispatch
 * boundary, before a first pass starts.
 *
 * Allowed only while `spentUsd < monthlyUsd` (strictly below): a spend that
 * equals the cap is `budget-exhausted`. A summary that is not an `ok` result,
 * or a budget that fails `readProviderBudget`, is `budget-unknown`: the
 * decision never guesses on unreadable input. A provider with no rows in the
 * month has spent `0` and is allowed (a budget is a positive number). Never
 * throws.
 */
export function decideProviderBudget(input: {
  budget: unknown;
  summary: SpendMonthSummaryResult;
}): ProviderBudgetDecision {
  try {
    if (typeof input !== 'object' || input === null) {
      return { allowed: false, reason: 'budget-unknown' };
    }
    const budget = readProviderBudget(input.budget);
    if (!budget.ok) {
      return { allowed: false, reason: 'budget-unknown' };
    }
    const summary = input.summary;
    if (typeof summary !== 'object' || summary === null || !summary.ok) {
      return { allowed: false, reason: 'budget-unknown' };
    }
    const entry = summary.summary.providers.find((candidate) => candidate.provider === budget.budget.provider);
    const spent = entry === undefined || entry.spentUsd === null ? 0 : entry.spentUsd;
    return spent >= budget.budget.monthlyUsd
      ? { allowed: false, reason: 'budget-exhausted' }
      : { allowed: true };
  } catch {
    return { allowed: false, reason: 'budget-unknown' };
  }
}
